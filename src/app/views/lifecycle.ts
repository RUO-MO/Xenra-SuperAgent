/**
 * Lifecycle views: one recent request (a Thread) as a root, with the stages it walked through as children —
 * trigger → assessment → ticket → assignment → reply. Every stage carries the ACTUAL stored diagnostic (reason codes,
 * rule matches, delivery error, worker report), so the panel can answer "why" and not just show a status dot.
 */
import { reasonText, ticketStage, type Decision, type Reason, type Thread, type Ticket } from '../../core/index.ts'
import { dayAgo, decisionView, snapshot, threadTitle } from './records.ts'
import type { ViewHost } from './records.ts'

export const LIFECYCLE_STAGES = ['trigger', 'assessment', 'ticket', 'assignment', 'reply'] as const
export type LifecycleStage = typeof LIFECYCLE_STAGES[number]

export interface LifecycleStep {
  readonly stage: LifecycleStage
  /** done / ongoing / idle / error — the same dot vocabulary the panel uses elsewhere. */
  readonly state: 'done' | 'ongoing' | 'idle' | 'error'
  readonly progress: number
  readonly at?: string
  /** A human-readable line: what happened, in plain words (never an empty status code). */
  readonly summary: string
  /** Structured reason codes that explain this stage, with their interpolated text. */
  readonly reasons: { code: string; text: string }[]
  /** Rule matches / evidence for an assessment, in the words already used by decisionView. */
  readonly evidence?: Pick<ReturnType<typeof decisionView>, 'rules' | 'direction' | 'intentEvidence' | 'proposal'>
  /** Ids the panel uses to open the detail view for this stage. */
  readonly triggerId?: string
  readonly decisionId?: string
  readonly ticketId?: string
}

export interface LifecycleNode {
  readonly key: string
  readonly title: string
  readonly source: string
  readonly at: string
  readonly steps: LifecycleStep[]
  readonly progress: number
  readonly current: LifecycleStage
  /** The single most useful diagnostic line, shown even when the tree is collapsed. */
  readonly headline: string
  readonly headlined: boolean
}

const reasonLines = (reasons: readonly Reason[] | undefined) => (reasons ?? []).map(reason => ({ code: reason.code, text: reasonText(reason) }))
function step(stage: LifecycleStage, state: LifecycleStep['state'], summary: string, at?: string, extra: Partial<LifecycleStep> = {}): LifecycleStep {
  const progress = state === 'done' ? 100 : state === 'ongoing' ? 50 : 0
  return { stage, state, progress, summary, reasons: [], ...at === undefined ? {} : { at }, ...extra }
}
function settledTicket(ticket: Ticket): boolean { return !!ticket.ended }

/** Build a request's lifecycle with the real reasons stored for each stage. */
export function lifecycleOf(host: ViewHost, thread: Thread): LifecycleNode {
  const { store } = host
  const triggers = store.read.threadTriggers(thread.key, 200)
  const decisions = store.decisions.byThread(thread.key)
  const tickets = thread.subscriptions.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [ticket] : [] })
  const first = triggers[0]
  const last = triggers.at(-1)
  const disposition = first ? store.triggers.disposition(first.id) : undefined
  const latestDecision = decisions.at(-1)
  const open = tickets.filter(ticket => !settledTicket(ticket))
  const working = open.find(ticket => ticketStage(ticket).stage === 'working')
  const waiting = open.find(ticket => ticketStage(ticket).stage === 'person')
  const latestTicket = working ?? waiting ?? tickets.at(-1)
  const assignment = latestTicket?.assignments.at(-1)
  const report = assignment?.report
  const view = snapshot(host)
  const decision = latestDecision ? decisionView(view, latestDecision) : undefined
  const replied = !!latestDecision && store.replyStatus(`ack:${latestDecision.id}`) !== undefined

  // Trigger: who/what/when, and why it was filtered if it never reached assessment.
  const filtered = disposition?.filtered
  const triggerStep = step('trigger', filtered ? 'error' : triggers.length ? 'done' : 'idle',
    filtered ? `Filtered: ${reasonText(filtered)}` : first
      ? `${first.source} · ${first.actor.id || 'system'} · ${first.text.slice(0, 80)}` : 'No trigger recorded',
    first?.at, { triggerId: first?.id, reasons: reasonLines(filtered ? [filtered] : undefined) })

  // Assessment: the decision's own reasons plus rule matches and direction evidence.
  const evalState: LifecycleStep['state'] = thread.evaluating ? 'ongoing' : latestDecision
    ? latestDecision.kind === 'unavailable' ? 'error' : 'done' : 'idle'
  const assessmentStep = step('assessment', evalState,
    thread.evaluating ? `Assessing since ${thread.evaluating.startedAt} · ${thread.evaluating.triggerIds.length} trigger(s)`
      : latestDecision ? `${latestDecision.kind} · ${reasonText(latestDecision.reason)}` : 'Not assessed yet',
    latestDecision?.at ?? thread.evaluating?.startedAt,
    { decisionId: latestDecision?.id, reasons: reasonLines(latestDecision?.reason),
      ...decision ? { evidence: decision } : {} })

  // Ticket: which ticket this became and on what authority (strength + matched rules).
  const ticketStep = step('ticket', tickets.length ? 'done' : 'idle',
    latestTicket ? `${latestTicket.title} · ${latestTicket.mandate.strength}${latestTicket.mandate.basis.rules?.length ? ` · ${latestTicket.mandate.basis.rules.join(', ')}` : ''}`
      : 'No ticket opened', latestTicket?.createdAt,
    { ticketId: latestTicket?.id, reasons: [], })

  // Assignment: the worker's last report and any delivery error.
  const failed = report?.state === 'failed' || report?.state === 'blocked' || !!latestTicket?.delivery?.error
  const assignmentStep = step('assignment', !assignment ? 'idle'
    : assignment.state === 'running' || assignment.state === 'pending' ? 'ongoing'
      : failed ? 'error' : 'done',
    !assignment ? 'Not dispatched' : report?.summary ?? latestTicket?.delivery?.error ?? `Assignment ${assignment.state}${assignment.endedReason ? ` (${assignment.endedReason})` : ''}`,
    assignment?.startedAt ?? assignment?.createdAt,
    { ticketId: latestTicket?.id, reasons: assignment?.endedReason ? [{ code: 'ended', text: assignment.endedReason }]
      : reasonLines(failed && latestTicket?.delivery?.error ? [{ code: 'delivery', values: { error: latestTicket.delivery!.error } }] : undefined) })

  // Reply: whether a reply was sent; the overview's outgoing problem explains failures.
  const dropped = store.read.failingReplies().find(item => item.ticketId === latestTicket?.id || item.id.startsWith(`ack:${latestDecision?.id ?? ''}`))
  const replyStep = step('reply', dropped ? 'error' : replied ? 'done' : 'idle',
    dropped ? `Reply failed (${dropped.status}): ${dropped.error ?? ''}`.trim()
      : replied ? 'Reply sent' : 'No reply recorded',
    latestDecision?.at,
    { reasons: reasonLines(dropped?.dropped ? [{ code: dropped.dropped.reason }] : undefined) })

  const steps = [triggerStep, assessmentStep, ticketStep, assignmentStep, replyStep]
  const done = steps.filter(item => item.state === 'done').length
  const currentStep = steps.find(item => item.state === 'ongoing' || item.state === 'error')
    ?? [...steps].reverse().find(item => item.state === 'done') ?? steps[0]!
  const error = steps.find(item => item.state === 'error')
  return { key: thread.key, title: threadTitle(store, thread), source: thread.ref.source,
    at: thread.lastAt ?? thread.createdAt, steps, progress: Math.round(done / steps.length * 100),
    current: currentStep.stage,
    headline: error ? `${error.stage}: ${error.summary}` : currentStep.summary,
    headlined: !!error }
}

/** Recent requests as lifecycle trees, newest first. */
export function lifecycleList(host: ViewHost, limit = 12) {
  const threads = host.store.threads.list().filter(thread => (thread.lastAt ?? thread.createdAt) >= dayAgo())
    .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt)).slice(0, limit)
  return threads.map(thread => lifecycleOf(host, thread))
}
export type LifecycleListView = ReturnType<typeof lifecycleList>
