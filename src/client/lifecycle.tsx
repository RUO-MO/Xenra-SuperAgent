/**
 * Workbench request lifecycle: recent requests as a connected card tree that answers "why", not just "where".
 *
 * Each root is one submitted request; its five children are trigger → assessment → ticket → assignment → reply. Every stage
 * shows the ACTUAL stored diagnostic: a plain-language summary, structured reason chips, and the rule/evidence details
 * behind an assessment. Errors are highlighted and the reason is always visible, even on the collapsed root.
 */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Dot, Icon, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint, Section, When } from './widgets.tsx'

type Node = ApiResponse<'GET lifecycle'>[number]
type Step = Node['steps'][number]

const STAGE_ICON = { trigger: 'hash', assessment: 'decision', ticket: 'review', assignment: 'running', reply: 'message' } as const

/** One stage card: status dot, summary, reason chips, evidence and a link into the full detail view. */
function StageCard({ step, t, open }: { step: Step; t: (key: string) => string; open: (step: Step) => void }) {
  const canOpen = !!(step.triggerId || step.decisionId || step.ticketId)
  return <div className="dt-life-stage" data-state={step.state}>
    <div className="dt-life-stage-head">
      <Dot state={step.state} />
      <Icon name={STAGE_ICON[step.stage]} size={14} />
      <span className="dt-life-stage-name">{t(`lifecycle.${step.stage}`)}</span>
    </div>
    <div className="dt-life-stage-summary">{step.summary}</div>
    {step.reasons.length > 0 && <div className="dt-life-reasons">{step.reasons.map((reason, index) =>
      <Tag key={index} tone={step.state === 'error' ? 'danger' : 'neutral'} title={reason.code}>{reason.text}</Tag>)}</div>}
    {step.evidence && (step.evidence.rules.length > 0 || step.evidence.intentEvidence) && <div className="dt-life-evidence">
      {step.evidence.rules.map(rule => <div key={rule.id} className="dt-life-rule">
        <span className={rule.matched ? 'dt-life-rule-match' : 'dt-life-rule-miss'}>{rule.matched ? '✓' : '✗'}</span>
        <span>{rule.name}</span><span className="dt-hint"> · {rule.reason}</span>
      </div>)}
      {step.evidence.direction && <div className="dt-hint">目标依据：{step.evidence.direction.evidence}</div>}
      {step.evidence.intentEvidence && <div className="dt-hint">意图证据：{step.evidence.intentEvidence}</div>}
      {step.evidence.proposal && <div className="dt-hint">提案：{step.evidence.proposal.title ?? ''}</div>}
    </div>}
    <div className="dt-life-stage-foot">
      {step.at && <When at={step.at} />}
      {canOpen && <button type="button" className="dt-textlink" onClick={() => open(step)}>{t('lifecycleOpen')}</button>}
    </div>
  </div>
}

/** One request tree: the root card (with a headline diagnostic) connected to its stage cards. */
function LifeTree({ node }: { node: Node }) {
  const { t, navigate } = usePanel()
  const [expanded, setExpanded] = useState(false)
  const open = (step: Step) => {
    if (step.ticketId) navigate({ page: 'tickets', id: step.ticketId })
    else if (step.triggerId) navigate({ page: 'threads', id: node.key, query: { trigger: step.triggerId } })
    else if (step.decisionId) navigate({ page: 'settings', query: { group: 'eval', view: 'evals' } })
  }
  return <div className="dt-life-tree" data-error={node.headlined || undefined}>
    <button type="button" className="dt-life-root" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className="dt-life-root-head"><Icon name="message" size={15} /><span>{node.title}</span>
        {node.headlined && <Tag tone="danger">{t('lifecycleNeedAttention')}</Tag>}</span>
      <span className="dt-life-headline" data-error={node.headlined || undefined}>{node.headline}</span>
      <span className="dt-life-root-meta"><span className="dt-mono">{node.source}</span><When at={node.at} /></span>
    </button>
    {expanded && <ol className="dt-life-children">{node.steps.map((step, index) => <li key={step.stage} className="dt-life-child">
      <span className="dt-life-connector" aria-hidden="true" />
      <span className="dt-life-index">{index + 1}</span>
      <StageCard step={step} t={t as unknown as (key: string) => string} open={open} />
    </li>)}</ol>}
  </div>
}

/** The workbench's request-flow section; polls the host lifecycle view. */
export function WorkbenchFlow() {
  const { t, call } = usePanel()
  const { data } = usePoll(() => call('GET lifecycle'), [])
  return <Section title={t('workbenchFlow')} hint={t('workbenchFlowHint')}>
    {data && data.length === 0 && <Hint>{t('lifecycleNone')}</Hint>}
    {data && data.length > 0 && <div className="dt-life-list">{data.map(node => <LifeTree key={node.key} node={node} />)}</div>}
  </Section>
}
