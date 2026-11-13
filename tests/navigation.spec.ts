// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession } from '../src/navigation.ts'
import { initialLocation, parseRoute, remember, setupPage } from '../src/client/route.ts'
const id = 'orchestrator-test' as SessionId
function fixture(ready = false) {
  const pending = Promise.withResolvers<void>()
  const state = { phase: ready ? 'ready' : 'pending', byId: ready ? { [id]: {} } : {} as Record<string, object> }
  const refresh = vi.fn(async () => { await pending.promise })
  // Navigation reads only catalog readiness and membership, not summary fields.
  const sessions = { list: { getSnapshot: () => state }, refresh } as unknown as Pick<ISessions, 'list' | 'refresh'>
  return { sessions, pending, state, refresh }
}
it('waits for initial catalog hydration before opening the linked master', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  expect(open).not.toHaveBeenCalled()
  state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
it('opens known Sessions without another network refresh', async () => {
  const { sessions, refresh } = fixture(true); const open = vi.fn()
  await expect(openKnownSession(sessions, id, open, new AbortController().signal)).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id); expect(refresh).not.toHaveBeenCalled()
})
it('reports unavailable targets without calling the throwing Session selector', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  state.phase = 'ready'; pending.resolve()
  await expect(navigation).rejects.toMatchObject({ code: 'not-listed' })
  expect(open).not.toHaveBeenCalled()
})
it('does not navigate after the panel unmounts or a newer request supersedes it', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn(); const controller = new AbortController()
  const navigation = openKnownSession(sessions, id, open, controller.signal)
  controller.abort(); state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(false); expect(open).not.toHaveBeenCalled()
})
it('reopens the page this tab showed last, and Home for a route that no longer exists', () => {
  remember({ route: { page: 'evals', query: { filter: 'stop' } }, stack: [{ page: 'home' }] })
  expect(initialLocation()).toEqual({ route: { page: 'evals', query: { filter: 'stop' } }, stack: [{ page: 'home' }] })
  // A route saved under a name this panel no longer has falls back to Home.
  sessionStorage.setItem('xenra-superagent/route', JSON.stringify({ route: { page: 'policy' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'home' }, stack: [] })
  // The six-tab panel's names still open the view they meant: Overview became Home, Execution became Tickets, and the
  // Trigger tab became the Threads view.
  sessionStorage.setItem('xenra-superagent/route', JSON.stringify({ route: { page: 'overview' }, stack: [] }))
  expect(initialLocation().route).toEqual({ page: 'home' })
  sessionStorage.setItem('xenra-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' },
    stack: [{ page: 'policy' }, { page: 'trigger', query: {} }] }))
  // An empty query carries nothing, so the stored route reads back without one.
  expect(initialLocation()).toEqual({ route: { page: 'threads', id: 'github:1' }, stack: [{ page: 'threads', query: {} }],
    group: undefined })
  sessionStorage.setItem('xenra-superagent/route', '{')
  expect(initialLocation().route).toEqual({ page: 'home' })
})
it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'threads', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'threads', query: {} })
  expect(parseRoute({ page: 'threads', id: 'github:1', query: { trigger: 'e1', filter: 'recent' } }))
    .toEqual({ page: 'threads', id: 'github:1', query: { trigger: 'e1' } })
  expect(parseRoute({ page: 'evals', query: { filter: 'stop', window: '7d' } })).toEqual({ page: 'evals', query: { filter: 'stop' } })
  expect(parseRoute({ page: 'tickets', id: 5, query: { filter: 'idle' } })).toEqual({ page: 'tickets', query: { filter: 'idle' } })
  expect(parseRoute({ page: 'settings', query: { group: 'policy', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'source', source: 'feishu' } })
  expect([parseRoute('home'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('opens the settings that fix each setup problem: the Deployment group, or the card of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place)).toEqual({ page: 'settings', query: { group: 'source', source: place } })
})
