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

const host = (receive: (trigger: unknown) => string, configured = true) => ({
  configured: () => configured,
  deployment: { repository: 'acme/widgets' },
  engine: { receive },
  requestPass: vi.fn(),
  machine: { stateDir: '/tmp/state', promptMaxChars: { get: () => 100000 } },
  store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
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
