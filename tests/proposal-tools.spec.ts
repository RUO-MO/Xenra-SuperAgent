import { describe, expect, it, vi } from 'vitest'
// Import cards first to break the tool→resources→executor→assessment→tool cycle before proposalTools loads.
import '../src/app/cards.ts'
import { proposalTools, type ProposalToolsHost } from '../src/app/tools/proposal.ts'
import type { GateView } from '../src/app/views/gates.ts'

const gate: GateView = {
  review: { items: [], dropped: 0 },
  ticket: {
    rejected: 2,
    items: [{
      decisionId: 'dec-1', thread: 'github:1', threadTitle: '#1 Fix README', title: 'Fix README', scope: 'Fix the install steps',
      strength: 'explicit', reason: 'accept', at: '2026-11-19T00:00:00Z', triggers: 1,
    }],
  },
}

function host(overrides: Partial<ProposalToolsHost> = {}): ProposalToolsHost {
  return {
    engine: { approveProposal: vi.fn(() => ({}) as never), rejectProposal: vi.fn(() => ({}) as never) },
    gates: () => gate,
    requestPass: vi.fn(),
    ...overrides,
  }
}

const signal = new AbortController().signal

describe('proposal Session tools', () => {
  it('lists the real pending proposal and its rejected count', async () => {
    const tools = proposalTools(host())
    const list = tools.find(tool => tool.name === 'proposal_list')!
    await expect(list.execute({}, signal)).resolves.toMatchObject({ pending: 1, rejected: 2,
      items: [expect.objectContaining({ decisionId: 'dec-1', title: 'Fix README', triggers: 1 })] })
  })

  it('approves or rejects by decision id, answers failed ids, and schedules a pass only when something changed', async () => {
    const engine = {
      approveProposal: vi.fn((id: string) => { if (id === 'dec-2') throw new Error('already decided'); return {} as never }),
      rejectProposal: vi.fn(() => ({}) as never),
    }
    const requestPass = vi.fn()
    const tools = proposalTools(host({ engine, requestPass }))
    const decide = tools.find(tool => tool.name === 'proposal_decide')!
    await expect(decide.execute({ action: 'approve', decision_ids: ['dec-1', 'dec-2'] }, signal)).resolves.toMatchObject({
      action: 'approve', changed: 1, failed: [{ decision_id: 'dec-2', reason: 'already decided' }], pending: 1 })
    expect(engine.approveProposal).toHaveBeenCalledTimes(2)
    expect(requestPass).toHaveBeenCalledTimes(1)
  })
})
