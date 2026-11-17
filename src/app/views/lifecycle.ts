/**
 * Lifecycle views: one recent request (a Thread) as a root, with the stages it has walked through as children —
 * trigger → assessment → ticket → assignment → reply. Each stage carries a state, a time and the ids needed to open the
 * existing thread/decision/ticket views for drill-down. The panel draws these as a connected card tree.
 */
import { ticketStage, type Thread, type Ticket } from '../../core/index.ts'
import { dayAgo, threadTitle } from './records.ts'
import type { ViewHost } from './records.ts'

export const LIFECYCLE_STAGES = ['trigger', 'assessment', 'ticket', 'assignment', 'reply'] as const
export type LifecycleStage = typeof LIFECYCLE_STAGES[number]

export interface LifecycleStep {
  readonly stage: LifecycleStage
  /** done / ongoing / idle / error — the same dot vocabulary the panel uses elsewhere. */
  readonly state: 'done' | 'ongoing' | 'idle' | 'error'
  /** How far this stage is: 0 when not reached, 100 when complete, in between while running. */
  readonly progress: number
  readonly at?: string
  /** Ids/labels the panel uses to open the matching detail view for this stage. */
  readonly triggerId?: string
  readonly decisionId?: string
  readonly ticketId?: string
  readonly detail?: string
}

export interface LifecycleNode {
  readonly key: string
  readonly title: string
  readonly source: string
  readonly at: string
  readonly steps: LifecycleStep[]
  readonly progress: number
  /** The stage currently in progress, or the last completed one when nothing is running. */
  readonly current: LifecycleStage
}

/** Build one stage step from a state and its timing. */
function step(stage: LifecycleStage, state: LifecycleStep['state'], at?: string, extra: Partial<LifecycleStep> = {}): LifecycleStep {
  const progress = state === 'done' ? 100 : state === 'ongoing' ? 50 : 0
  return { stage, state, progress, ...at === undefined ? {} : { at }, ...extra }
}

function settledTicket(ticket: Ticket): boolean { return !!ticket.ended }

/** Build a request's lifecycle from the records already stored for its Thread. */
export function lifecycleOf(host: ViewHost, thread: Thread): LifecycleNode {
  const { store } = host
  const triggers = store.read.threadTriggers(thread.key, 200)
  const decisions = store.decisions.byThread(thread.key)
  const tickets = thread.subscriptions.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [ticket] : [] })
  const first = triggers[0]
  const last = triggers.at(-1)
  const latestDecision = decisions.at(-1)
  const open = tickets.filter(ticket => !settledTicket(ticket))
  const working = open.find(ticket => ticketStage(ticket).stage === 'working')
  const waiting = open.find(ticket => ticketStage(ticket).stage === 'person')
  const latestTicket = working ?? waiting ?? tickets.at(-1)
  const assignment = latestTicket?.assignments.at(-1)
  const report = assignment?.report
  // A reply was sent for the request when the decision carried an acknowledgement receipt.
  const replied = !!latestDecision && store.replyStatus(`ack:${latestDecision.id}`) !== undefined

  const assignmentState: LifecycleStep['state'] = !assignment ? 'idle'
    : assignment.state === 'running' || assignment.state === 'pending' ? 'ongoing'
      : report?.state === 'failed' || report?.state === 'blocked' ? 'error' : 'done'

  const steps: LifecycleStep[] = [
    step('trigger', triggers.length ? 'done' : 'idle', first?.at,
      { triggerId: first?.id, detail: last?.text }),
    step('assessment', thread.evaluating ? 'ongoing' : latestDecision
      ? latestDecision.kind === 'unavailable' ? 'error' : 'done' : 'idle',
      latestDecision?.at ?? thread.evaluating?.startedAt,
      { decisionId: latestDecision?.id,
        detail: latestDecision ? (latestDecision.kind === 'accept' ? 'accepted' : latestDecision.kind) : undefined }),
    step('ticket', tickets.length ? 'done' : 'idle', latestTicket?.createdAt,
      { ticketId: latestTicket?.id, detail: latestTicket?.title }),
    step('assignment', assignmentState, assignment?.startedAt ?? assignment?.createdAt,
      { ticketId: latestTicket?.id, detail: report?.summary }),
    step('reply', replied ? 'done' : 'idle', latestDecision?.at),
  ]
  const done = steps.filter(item => item.state === 'done').length
  const currentStep = steps.find(item => item.state === 'ongoing' || item.state === 'error')
    ?? [...steps].reverse().find(item => item.state === 'done') ?? steps[0]!
  return { key: thread.key, title: threadTitle(store, thread), source: thread.ref.source,
    at: thread.lastAt ?? thread.createdAt, steps, progress: Math.round(done / steps.length * 100), current: currentStep.stage }
}

/** Recent requests as lifecycle trees, newest first. */
export function lifecycleList(host: ViewHost, limit = 12) {
  const threads = host.store.threads.list().filter(thread => (thread.lastAt ?? thread.createdAt) >= dayAgo())
    .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt)).slice(0, limit)
  return threads.map(thread => lifecycleOf(host, thread))
}
export type LifecycleListView = ReturnType<typeof lifecycleList>
