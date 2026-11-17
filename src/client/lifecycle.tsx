/**
 * Workbench request lifecycle: recent requests as a connected card tree. Each root is one submitted request; its five
 * children are the stages it walked through (trigger → assessment → ticket → assignment → reply), each with a status dot,
 * a progress bar, and a link into the detail view that already exists for that stage.
 */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Dot, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint, Section, When } from './widgets.tsx'

type Node = ApiResponse<'GET lifecycle'>[number]
type Step = Node['steps'][number]

const STAGE_ICON = { trigger: 'hash', assessment: 'decision', ticket: 'review', assignment: 'running', reply: 'message' } as const

/** One stage card: status dot, name, progress, time and the detail link. */
type StageTranslator = (key: string) => string
function StageCard({ step, t, open }: { step: Step; t: StageTranslator; open: (step: Step) => void }) {
  const canOpen = !!(step.triggerId || step.decisionId || step.ticketId)
  return <div className="dt-life-stage" data-state={step.state}>
    <div className="dt-life-stage-head">
      <Dot state={step.state} />
      <Icon name={STAGE_ICON[step.stage]} size={14} />
      <span className="dt-life-stage-name">{t(`lifecycle.${step.stage}`)}</span>
      <span className="dt-life-stage-pct">{step.progress}%</span>
    </div>
    <div className="dt-life-bar"><span data-state={step.state} style={{ width: `${step.progress}%` }} /></div>
    {step.detail && <div className="dt-life-stage-detail dt-clamp">{step.detail}</div>}
    <div className="dt-life-stage-foot">
      {step.at && <When at={step.at} />}
      {canOpen && <button type="button" className="dt-textlink" onClick={() => open(step)}>{t('lifecycleOpen')}</button>}
    </div>
  </div>
}

/** One request tree: the root card connected to its stage cards. */
function LifeTree({ node }: { node: Node }) {
  const { t, navigate } = usePanel()
  const [expanded, setExpanded] = useState(false)
  const open = (step: Step) => {
    if (step.ticketId) navigate({ page: 'tickets', id: step.ticketId })
    else if (step.triggerId) navigate({ page: 'threads', id: node.key, query: { trigger: step.triggerId } })
    else if (step.decisionId) navigate({ page: 'evals', query: {} })
  }
  return <div className="dt-life-tree">
    <button type="button" className="dt-life-root" data-current={node.current === 'trigger' || undefined}
      aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className="dt-life-root-head"><Icon name="message" size={15} /><span>{node.title}</span>
        {node.steps.some(step => step.state === 'ongoing') && <span className="dt-life-now">{t('legend.ongoing')}</span>}</span>
      <span className="dt-life-root-meta"><span className="dt-mono">{node.source}</span><When at={node.at} /><span className="dt-life-root-pct">{node.progress}%</span></span>
      <span className="dt-life-bar"><span style={{ width: `${node.progress}%` }} /></span>
    </button>
    {expanded && <ol className="dt-life-children">{node.steps.map((step, index) => <li key={step.stage} className="dt-life-child">
      <span className="dt-life-connector" aria-hidden="true" />
      <span className="dt-life-index">{index + 1}</span>
      <StageCard step={step} t={t as unknown as StageTranslator} open={open} />
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
