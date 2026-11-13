/**
 * Typed panel routes, route parser, and sessionStorage location history.
 *
 * Three top-level tabs answer the three questions a person actually has: what needs me now (`home`), what is being worked
 * on (`tickets`), and how it is set up (`settings`). The finer-grained views an operator reaches while debugging — Threads
 * and Triggers, Evals and decisions — keep their own routes but live under `advanced`, so the default navigation stays the
 * size of the job rather than the size of the implementation.
 */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

/** The tabs a person navigates by. `advanced` is one tab holding the diagnostic views. */
export const TABS = ['home', 'tickets', 'settings'] as const
export type Tab = typeof TABS[number]
export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
/** The diagnostic views, reachable from Settings and never shown as a top-level tab of their own. */
export const ADVANCED_VIEWS = ['threads', 'evals'] as const
export type AdvancedView = typeof ADVANCED_VIEWS[number]
export type Route = { page: 'home'; id?: undefined; query?: undefined }
  | { page: 'tickets'; id?: undefined; query: { filter?: TicketFilter } }
  | { page: 'tickets'; id: string; query?: undefined }
  | { page: 'threads'; id?: undefined; query: { filter?: ThreadFilter } }
  | { page: 'threads'; id: string; query?: { trigger?: string } }
  | { page: 'evals'; id?: undefined; query: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string; view?: AdvancedView } }
export const HOME: Route = { page: 'home' }
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string; view?: AdvancedView } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
/** The label of a route in a breadcrumb or a back button. */
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'threads' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized query filters or removed tabs and renaming the old ones. */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'home': return { page }
    // A stored route from the six-tab panel keeps working: its overview becomes Home, its execution tab Tickets, and its
    // thread and eval tabs the advanced views under Settings.
    case 'overview': return { page: 'home' }
    case 'source': return settingsRoute('source')
    case 'tickets': case 'execution': return record ? { page: 'tickets', id: record, query: undefined }
      : { page: 'tickets', query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) ?? {} }
    case 'threads': case 'trigger': return record ? { page: 'threads', id: record, query: compact({ trigger: text('trigger') }) }
      : { page: 'threads', query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) ?? {} }
    case 'evals': case 'eval': return { page: 'evals', query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) ?? {} }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version'), view: pick(ADVANCED_VIEWS, query?.view) }) } }
    default: return undefined
  }
}

const ROUTE_KEY = 'xenra-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
export function initialLocation(): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
