/** Tools for the proposal Session: list items waiting at the ticket gate, then approve or reject them as a person asked. */
import type { Engine } from '../../core/index.ts'
import type { GateView } from '../views/gates.ts'
import { z } from 'zod'
import { tool, type Tool } from './tool.ts'

export interface ProposalToolsHost {
  /** Engine operations that create or reject the ticket behind a pending proposal. */
  readonly engine: Pick<Engine, 'approveProposal' | 'rejectProposal'>
  /** The same real gate view the workbench reads, so the Session and the panel never disagree. */
  gates(): GateView
  /** Schedules an Engine pass after a proposal creates a ticket. */
  requestPass(): void
}

/**
 * Builds the proposal Session's two tools. It deliberately gets no write, shell, source or settings tool: its only job is
 * the second human gate, and the execution Session owns the work that follows an approved proposal.
 */
export function proposalTools(host: ProposalToolsHost): Tool[] {
  return [
    tool({
      name: 'proposal_list',
      description: 'List the proposals waiting at the ticket gate: the title, scope, thread, strength, reason and trigger count of each. Use it before answering which proposals are pending.',
      schema: z.object({}).strict(),
      execute: async () => {
        const gate = host.gates().ticket
        return { pending: gate.items.length, rejected: gate.rejected, items: gate.items }
      },
    }),
    tool({
      name: 'proposal_decide',
      description: 'Approve or reject pending proposals in one call, by decision id from proposal_list. Approving creates the ticket and schedules dispatch; rejecting creates no ticket and starts no worker. Only do this on an explicit human instruction.',
      schema: z.object({
        action: z.enum(['approve', 'reject']),
        decision_ids: z.array(z.string().min(1)).min(1).max(200),
      }).strict(),
      execute: async ({ action, decision_ids }) => {
        let changed = 0
        const failed: { decision_id: string; reason: string }[] = []
        for (const id of decision_ids) {
          try {
            if (action === 'approve') host.engine.approveProposal(id)
            else host.engine.rejectProposal(id)
            changed++
          } catch (error) {
            failed.push({ decision_id: id, reason: error instanceof Error ? error.message : String(error) })
          }
        }
        if (changed) host.requestPass()
        return { action, changed, failed, pending: host.gates().ticket.items.length }
      },
    }),
  ]
}
