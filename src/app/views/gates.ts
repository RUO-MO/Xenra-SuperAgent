/** Read models for the two manual gates: admitted Triggers waiting for review, and accepts waiting for ticket approval. */
import type { Store } from '../store.ts'
import type { Decision } from '../../core/index.ts'
import { preview } from './text.ts'
import { threadKey, type Thread } from '../../core/model.ts'
import { threadTitle } from './records.ts'

export interface ReviewGateItem {
  id: string
  source: string
  actor: string
  human: boolean
  addressed?: string
  strength: 'explicit' | 'inferred'
  text: string
  thread: string
  threadTitle: string
  at: string
}
export interface TicketGateItem {
  decisionId: string
  thread: string
  threadTitle: string
  title: string
  scope: string
  strength: string
  reason: string
  at: string
  triggers: number
}
export interface GateView {
  review: { items: ReviewGateItem[]; dropped: number }
  ticket: { items: TicketGateItem[]; rejected: number }
}

/** Build the real gate queues from persisted dispositions and Decisions; nothing here is demo data. */
export function gatesView(store: Store): GateView {
  const threads = new Map<string, Thread>()
  for (const thread of store.threads.list()) threads.set(thread.key, thread)
  const review: ReviewGateItem[] = []
  for (const trigger of store.triggers.list(500)) {
    const disposition = store.triggers.disposition(trigger.id)
    if (disposition?.review?.state !== 'pending') continue
    const ref = trigger.threads[0]
    const key = ref ? threadKey(ref) : ''
    const thread = key ? threads.get(key) : undefined
    review.push({ id: trigger.id, source: trigger.source, actor: trigger.actor.id, human: trigger.human,
      ...trigger.addressed ? { addressed: trigger.addressed } : {}, strength: trigger.human ? 'explicit' : 'inferred',
      text: preview(trigger.text, 160), thread: key, threadTitle: thread ? threadTitle(store, thread) : key,
      at: disposition.review.at })
  }
  const ticket: TicketGateItem[] = []
  for (const decision of store.decisions.proposals()) {
    const proposal = decision.proposal
    if (!proposal || proposal.state !== 'pending') continue
    const thread = threads.get(decision.threadKey)
    ticket.push({ decisionId: decision.id, thread: decision.threadKey,
      threadTitle: thread ? threadTitle(store, thread) : decision.threadKey, title: proposal.title, scope: proposal.scope,
      strength: decision.strength, reason: proposal.reason[0]?.code ?? 'accept', at: proposal.at, triggers: proposal.triggerIds.length })
  }
  const dropped = Number((store.db.prepare("SELECT COUNT(*) AS n FROM disposition WHERE value ->> '$.filtered.code' = 'manualDrop'").get() as { n?: number } | undefined)?.n ?? 0)
  const rejected = countRejected(store)
  return { review: { items: review, dropped }, ticket: { items: ticket, rejected } }
}

function countRejected(store: Store): number {
  let count = 0
  for (const decision of recentDecisions(store)) if (decision.proposal?.state === 'rejected') count++
  return count
}

function recentDecisions(store: Store): Decision[] {
  // A narrow read: Decisions carrying a proposal, regardless of its state.
  return (store.db.prepare("SELECT value FROM decision WHERE value ->> '$.proposal' IS NOT NULL ORDER BY rowid DESC LIMIT 500")
    .all() as { value: string }[]).map(row => JSON.parse(row.value) as Decision)
}
