// A workbench request must become an ordinary Trigger, never a Ticket opened directly.
import { expect, it, vi } from 'vitest'
import { registerHttp } from '../src/app/http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { workbenchTrigger, workbenchKind, SOURCE } from '../src/sources/workbench.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>) {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, getOrigin: () => 'http://127.0.0.1:3082',
    register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
      async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

/** A store whose only settings fact is the target list the workbench route reads. */
const store = (targets: { items: unknown[]; selected: string } = { items: [], selected: '' }) => ({
  tickets: { get: () => undefined }, blockRevision: () => 0,
  settings: () => ({ executor: { targets } }),
})
const host = (receive: (trigger: unknown) => string, configured = true) => ({
  configured: () => configured,
  deployment: { repository: 'acme/widgets' },
  engine: { receive },
  requestPass: vi.fn(),
  machine: { stateDir: '/tmp/state', promptMaxChars: { get: () => 100000 } },
  store: store(),
})

it('builds a Trigger whose thread is the target, not the entry channel', () => {
  const trigger = workbenchTrigger({ id: 'r1', actor: 'alice', text: 'fix the button', at: '2026-11-16T02:00:00Z',
    scope: 'src/client/' }, 'acme/widgets')
  expect(trigger.source).toBe(SOURCE)
  expect(trigger.threads).toEqual([{ source: SOURCE, id: 'acme/widgets' }])
  expect(trigger.actor).toEqual({ source: SOURCE, id: 'alice' })
  expect(trigger.human).toBe(true)
  expect(trigger.addressed).toBe('direct')
  expect(trigger.meta).toEqual({ target: 'acme/widgets', scope: 'src/client/' })
  // The id is derived from the caller's id, so a double submit is a no-op.
  expect(trigger.id).toBe(workbenchTrigger({ id: 'r1', actor: 'alice', text: 'different', at: 'x' }, 'acme/widgets').id)
})

it('rejects a request with no target through the source scope', () => {
  expect(workbenchKind.scope!({ meta: {} }, workbenchKind.schema.parse({})).listened).toBe(false)
  expect(workbenchKind.scope!({ meta: { target: 'acme/widgets' } }, workbenchKind.schema.parse({})).listened).toBe(true)
})

it('turns a console request into a Trigger and asks for an assessment pass, without opening a Ticket', async () => {
  const received: unknown[] = []
  const pass = vi.fn()
  const call = serve({ ...host(trigger => { received.push(trigger); return 'stored' }), requestPass: pass })
  const result = await call('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: 'fix the button', scope: 'src/client/' })
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ accepted: true })
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({ source: SOURCE, threads: [{ source: SOURCE, id: 'acme/widgets' }],
    addressed: 'direct', text: 'fix the button', meta: { target: 'acme/widgets', scope: 'src/client/' } })
  expect(pass).toHaveBeenCalledTimes(1)
})

it('reports a duplicate without asking for another pass', async () => {
  const pass = vi.fn()
  const call = serve({ ...host(() => 'duplicate'), requestPass: pass })
  const result = await call('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: 'fix the button' })
  expect(result.body).toMatchObject({ accepted: false, reason: 'duplicate' })
  expect(pass).not.toHaveBeenCalled()
})

it('refuses a request while setup is incomplete, and validates the body', async () => {
  const unconfigured = serve(host(() => 'stored', false))
  expect(await unconfigured('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: 'x' })).toMatchObject({ status: 400 })
  const call = serve(host(() => 'stored'))
  expect(await call('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: '' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: 'x', unexpected: true })).toMatchObject({ status: 400 })
})

it('acts on the target the person picked, and refuses one that is not registered', async () => {
  const received: { meta: Record<string, unknown>; threads: { id: string }[] }[] = []
  const targets = { items: [
    { id: 'widgets', kind: 'repository', name: 'widgets', repository: 'acme/widgets', root: '' },
    { id: 'notes', kind: 'directory', name: '我的笔记', root: 'D:\\notes' },
  ], selected: 'widgets' }
  const call = serve({ ...host(trigger => { received.push(trigger as never); return 'stored' }), store: store(targets) })

  const picked = await call('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: 'tidy the headings', target: 'notes' })
  expect(picked.body).toMatchObject({ accepted: true, target: { id: 'notes', kind: 'directory' } })
  expect(received[0]).toMatchObject({ threads: [{ source: 'workbench', id: 'notes' }], meta: { target: 'notes' } })

  // A target that is not registered never silently falls back to something else.
  expect(await call('POST', 'workbench/requests', { id: 'r2', actor: 'alice', text: 'x', target: 'gone' }))
    .toMatchObject({ status: 400 })
})

it('falls back to the selected target, and to the watched repository when nothing is registered', async () => {
  const received: { threads: { id: string }[] }[] = []
  const selected = { items: [
    { id: 'widgets', kind: 'repository', name: 'widgets', repository: 'acme/widgets', root: '' },
    { id: 'notes', kind: 'directory', name: '笔记', root: 'D:\\notes' },
  ], selected: 'notes' }
  const pick = serve({ ...host(trigger => { received.push(trigger as never); return 'stored' }), store: store(selected) })
  await pick('POST', 'workbench/requests', { id: 'r1', actor: 'alice', text: 'x' })
  expect(received[0]!.threads).toEqual([{ source: 'workbench', id: 'notes' }])

  const empty = serve({ ...host(trigger => { received.push(trigger as never); return 'stored' }), store: store() })
  await empty('POST', 'workbench/requests', { id: 'r2', actor: 'alice', text: 'x' })
  // A fresh installation has no targets; the request still acts on the repository that is actually watched.
  expect(received[1]!.threads).toEqual([{ source: 'workbench', id: 'acme/widgets' }])
})

it('lists targets with the watched repository marked, and drops the default when its target is removed', async () => {
  const targets = { items: [
    { id: 'widgets', kind: 'repository', name: 'widgets', repository: 'acme/widgets', root: '' },
    { id: 'notes', kind: 'directory', name: '笔记', root: 'D:\\notes' },
  ], selected: 'notes' }
  let current = targets
  const call = serve({ ...host(() => 'stored'), store: { tickets: { get: () => undefined }, blockRevision: () => 0,
    settings: () => ({ executor: { targets: current } }),
    saveSettings: (next: { executor: { targets: typeof targets } }) => { current = next.executor.targets } } })
  expect((await call('GET', 'targets')).body).toMatchObject({ selected: 'notes', watched: 'acme/widgets' })
  const removed = await call('DELETE', 'targets/notes')
  expect(removed.body).toMatchObject({ selected: '', items: [{ id: 'widgets' }] })
  expect(current.items.map(item => item.id)).toEqual(['widgets'])
  // Deleting something that is not there is a 404 rather than a silent success.
  expect(await call('DELETE', 'targets/notes')).toMatchObject({ status: 404 })
})
