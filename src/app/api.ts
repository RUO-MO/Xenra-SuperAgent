/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { RoleModel } from '../policy.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { LifecycleListView } from './views/lifecycle.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { GateView } from './views/gates.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { Target, TargetKind } from '../workspace/targets.ts'
import type { UpdateState } from './update-check.ts'
import type { ReloadProgress } from './reload-progress.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET lifecycle': { response: LifecycleListView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  /** Real queues of the two manual gates: Triggers waiting for review, and accepts waiting for ticket approval. */
  'GET gates': { response: GateView }
  /** Approve or drop Triggers held at the review gate, in one batch; dropping spends no assessment tokens. */
  'POST gates/review': { body: { action: 'approve' | 'drop'; triggerIds: string[] }; response: { changed: number; failed: string[] } }
  /** Approve (create tickets) or reject accepts held at the ticket gate, in one batch. */
  'POST gates/ticket': { body: { action: 'approve' | 'reject'; decisionIds: string[] }; response: { changed: number; failed: string[] } }
  'GET settings': { response: SettingsView }
  /** The configured assessment model and the route the main Session will use next. */
  'GET master/model': { response: { sessionId: string; configured: RoleModel | null; current?: ModelSelection; archived: boolean } }
  /** Re-select the configured assessment model on the running main Session. */
  'POST master/model': { response: { applied: true; current: ModelSelection } }
  /** Restore the main Session from DSH's archive set, which otherwise blocks every model step. */
  'POST master/restore': { response: { restored: boolean; archived: boolean; current?: ModelSelection } }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  /** The git worker sessions run, and the upgrade this machine offers; the panel shows the command before running it. */
  'GET git': { response: { version?: string; outdated: boolean; minimum: string
    plan?: { command: string; by: string } } }
  'POST git/upgrade': { response: { ok: boolean; output: string; version?: string; outdated: boolean } }
  /** Submitting a request from the workbench console. The server turns it into a Trigger; it never opens a Ticket itself. */
  'POST workbench/requests': { body: { id: string; actor: string; text: string; scope?: string; target?: string };
    response: { accepted: boolean; reason?: string; triggerId: string; target: { id: string; kind: TargetKind } } }
  /** Whether a newer version exists, asked differently for a linked checkout and a GitHub install. */
  'GET update': { response: UpdateState | undefined }
  /** Start a manual reload; the work continues in the background and stages are followed through GET update/progress. */
  'POST update/reload': { response: { requestId: string; kind: string } }
  /** The latest reload's staged progress (survives the fiber replacement a reinstall causes). */
  'GET update/progress': { response: ReloadProgress | undefined }
  /** The places a request may act on, and the one repository the agent watches. */
  'GET targets': { response: { items: Target[]; selected: string; watched: string } }
  'POST targets': { body: { kind: TargetKind; name?: string; repository?: string; root?: string }; response: { items: Target[]; selected: string } }
  'PUT targets/selected': { body: { id: string }; response: { items: Target[]; selected: string } }
  'DELETE targets/:id': { response: { items: Target[]; selected: string } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
