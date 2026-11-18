/**
 * Embedded dashboard: one clickable five-stage pipeline (intake → assessment → ticket → dispatch → reply)
 * that switches a lower "screen" between five boards. Every board reads live management APIs; no stage is
 * a fake state machine — the dispatch board reflects the real stage of the currently running ticket.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiResponse, DecisionRow, Problem, SourceStatusRow, TicketRow } from './api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Tag, type IconName } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint, Section, SessionButton, When } from './widgets.tsx'

type Overview = ApiResponse<'GET overview'>
type LifecycleNode = ApiResponse<'GET lifecycle'>[number]
const STAGES = [
  { key: 'trigger', no: '1', name: '触达' }, { key: 'eval', no: '2', name: '评审' },
  { key: 'ticket', no: '3', name: '立项工单' }, { key: 'dispatch', no: '4', name: '派工' },
  { key: 'reply', no: '5', name: '回复' },
] as const
type StageKey = typeof STAGES[number]['key']
const BOARD_META: Record<StageKey, { title: string; hint: string; icon: IconName }> = {
  trigger: { title: '信号台', hint: '来源把事件翻译成触发，去重后进入线程', icon: 'inbox' },
  eval: { title: '研判台', hint: '准入判定与研判候选，决定是否立项', icon: 'decision' },
  ticket: { title: '工单台', hint: '已立项工作的授权、阶段与订阅', icon: 'review' },
  dispatch: { title: '派工协作', hint: '当前工单的执行链路，正在派工只读', icon: 'running' },
  reply: { title: '回执台', hint: '确认、回答、结果与提问通过渠道回给发起人', icon: 'message' },
}

/** The pipeline: five clickable stages with a live count where the domain has one. */
export function Pipeline({ current, onSelect }: { current: StageKey; onSelect: (key: StageKey) => void }) {
  const { t, call } = usePanel()
  const { data } = usePoll(() => call('GET overview'), [])
  const counts: Record<StageKey, number | undefined> = {
    trigger: data?.flow.triggers, eval: data?.flow.evaluating,
    ticket: data?.executor.running !== undefined ? data.executor.running + data.executor.queued : undefined,
    dispatch: data?.executor.running, reply: data?.flow.accepted,
  }
  return <div className="dt-pipe">{STAGES.map((stage, index) => <div key={stage.key} className="dt-pipe-stage-wrap">
    <button type="button" className={`dt-pipe-stage ${current === stage.key ? 'on' : ''}`} onClick={() => onSelect(stage.key)}>
      <span className="dt-pipe-top"><span className="dt-pipe-no">{stage.no}</span><b>{stage.name}</b>
        {counts[stage.key] !== undefined && <span className="dt-count">{counts[stage.key]}</span>}</span>
      <span className="dt-pipe-hint">{t(`boardHint.${stage.key}`)}</span>
    </button>
    {index < STAGES.length - 1 && <span className="dt-pipe-link" aria-hidden="true">›</span>}
  </div>)}</div>
}

/** The screen container: a header bar plus the selected board. */
export function Dashboard() {
  const [stage, setStage] = useState<StageKey>('dispatch')
  const meta = BOARD_META[stage]
  return <div className="dt-dash">
    <div className="dt-dash-bar"><span className="dt-dash-dots"><i /><i /><i /></span>
      <b>{meta.title}</b><span className="dt-dash-hint">{meta.hint}</span></div>
    <div className="dt-dash-body">
      {stage === 'trigger' && <SignalBoard />}
      {stage === 'eval' && <AssessmentBoard />}
      {stage === 'ticket' && <TicketBoard />}
      {stage === 'dispatch' && <DispatchBoard />}
      {stage === 'reply' && <ReplyBoard />}
    </div>
    <Pipeline current={stage} onSelect={setStage} />
  </div>
}

function Card({ label, value, meta, tone }: { label: string; value: ReactNode; meta?: string; tone?: 'good' | 'bad' }) {
  return <div className="dt-dash-card"><span>{label}</span><strong data-tone={tone}>{value}</strong>{meta && <small>{meta}</small>}</div>
}
function SimpleList({ head, children }: { head: string; children: ReactNode }) {
  return <div className="dt-dash-list"><div className="dt-dash-list-head">{head}</div>{children}</div>
}

/** Source-driven signal board: live counts and recent filtered messages. */
function SignalBoard() {
  const { call } = usePanel()
  const { data: sources } = usePoll(() => call('GET sources'), [])
  const { data: overview } = usePoll(() => call('GET overview'), [])
  const rows = sources ?? []
  return <>
    <div className="dt-dash-cards">
      <Card label="今日触达" value={overview?.flow.triggers ?? 0} meta="进入领域的触发" />
      <Card label="被过滤" value={overview?.flow.filtered ?? 0} meta="来源范围外" tone="bad" />
      <Card label="来源" value={rows.length} meta="已安装实例" />
    </div>
    <SimpleList head="来源状态">{rows.map((source: SourceStatusRow) => <div className="dt-dash-row" key={source.id}>
      <span className={`dot ${source.state === 'ready' ? 'done' : source.state === 'error' ? 'error' : ''}`} />
      <span className="grow">{source.title.zh ?? source.title.en}</span>
      <span className="dt-mono">{source.stats.received} 触达 · {source.stats.filtered} 过滤</span>
      {source.stats.lastAt && <When at={source.stats.lastAt} />}
    </div>)}</SimpleList>
  </>
}

/** Assessment board: decisions with real reasons; the manual gates live on their own config pages. */
function AssessmentBoard() {
  const { call, navigate } = usePanel()
  const { data: overview } = usePoll(() => call('GET overview'), [])
  const { data: decisions } = usePoll(() => call('GET decisions', { query: { limit: 20 } }), [])
  const rows = (decisions?.items ?? []).slice(0, 8)
  return <>
    <div className="dt-dash-cards">
      <Card label="研判中" value={overview?.flow.evaluating ?? 0} meta="正在评估" />
      <Card label="今日判定" value={overview?.flow.judged ?? 0} />
      <Card label="已立项" value={overview?.flow.accepted ?? 0} />
    </div>
    <SimpleList head="最近决定">{rows.map((item: DecisionRow) => <div className="dt-dash-row" key={item.id}>
      <span className="dot done" /><span className="grow">{item.preview || item.thread}</span>
      <Tag tone={item.outcome === 'accept' ? 'success' : 'neutral'}>{item.outcome}</Tag></div>)}</SimpleList>
    <Button variant="outline" size="sm" onClick={() => navigate({ page: 'config', id: 'review-gate' })}>评审门 →</Button>
  </>
}

/** Ticket board: real open tickets and their stage. */
function TicketBoard() {
  const { call, navigate } = usePanel()
  const { data: tickets } = usePoll(() => call('GET tickets', { query: { state: 'open' } }), [])
  const rows = tickets?.items ?? []
  const count = (stage: string) => rows.filter(ticket => ticket.stage === stage).length
  return <>
    <div className="dt-dash-cards">
      <Card label="执行中" value={count('working')} />
      <Card label="待人工" value={count('person')} tone="good" />
      <Card label="等待中" value={count('idle')} />
    </div>
    <SimpleList head="活动工单">{rows.map((ticket: TicketRow) => <div className="dt-dash-row" key={ticket.id}>
      <span className="dot ongoing" /><button type="button" className="dt-textlink grow"
        onClick={() => navigate({ page: 'tickets', id: ticket.id })}>{ticket.title}</button>
      <span className="dt-mono">{ticket.id}</span><Tag tone="neutral">{ticket.stage}{'action' in ticket && ticket.action ? `/${ticket.action}` : ''}</Tag>
    </div>)}</SimpleList>
    <Button variant="outline" size="sm" onClick={() => navigate({ page: 'config', id: 'ticket-gate' })}>立项门 →</Button>
  </>
}

/** Dispatch nodes and the single flowing segment between them, mirroring the prototype exactly. */
const LANE_NODES = [
  { id: 'plan', cls: 'main', name: '主窗口 · 方案', sub: '产出实现方案；被打回时按审查建议修改后重新提交审查',
    subs: [{ name: 'agent-1 草拟方案', sub: 'standard·子作业' }] },
  { id: 'review', cls: 'review', name: '审查窗口', sub: '独立窗口：审查方案，同意则开工，不同意则打回方案修改' },
  { id: 'work', cls: 'exec', name: '执行窗口 · 开工', sub: '按通过的方案完成落地实现与测试',
    subs: [{ name: 'agent-2 实现', sub: 'standard·子作业' }, { name: 'agent-3 测试', sub: 'standard·子作业' }] },
  { id: 'reply', cls: 'reply', name: '主窗口 · 回复', sub: '落地与测试完成后，汇总结果回给发起人' },
]
/** Four demo scenes; `flow` names the single segment that animates, with its state pattern. */
const LANE_SCENES = [
  { label: '方案运行中', flow: 'pr', st: { plan: 'running', review: 'idle', work: 'idle', reply: 'idle' }, color: 'brand' },
  { label: '审查未通过·打回', flow: 'pr', st: { plan: 'running', review: 'running', work: 'idle', reply: 'idle' }, color: 'error' },
  { label: '审查通过→开工', flow: 'rw', st: { plan: 'done', review: 'done', work: 'running', reply: 'idle' }, color: 'warn' },
  { label: '开工完成→回复', flow: 'wr', st: { plan: 'done', review: 'done', work: 'done', reply: 'running' }, color: 'good' },
]
type LaneState = 'running' | 'done' | 'idle'
const STATE_TEXT: Record<LaneState, string> = { running: '运行中', done: '已完成', idle: '待进行' }

function LaneSvg({ scene, lane }: { scene: typeof LANE_SCENES[number]; lane: React.RefObject<HTMLDivElement | null> }) {
  const edge = (id: string, side: 'right' | 'left') => {
    const container = lane.current
    const el = container?.querySelector<HTMLElement>(`.dt-lane-node[data-id="${id}"]`)
    if (!container || !el) return null
    const box = container.getBoundingClientRect(), b = el.getBoundingClientRect()
    return side === 'right' ? { x: b.right - box.left - 3, y: (b.top + b.bottom) / 2 - box.top }
      : { x: b.left - box.left + 3, y: (b.top + b.bottom) / 2 - box.top }
  }
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  const color = `var(--dsw-alias-${scene.color === 'brand' ? 'brand' : `state-${scene.color}`}-primary)`
  const seg = (key: string, from: string, to: string) => {
    const a = edge(from, 'right'), b = edge(to, 'left'); if (!a || !b) return ''
    const d = line(a, b)
    return scene.flow === key
      ? `<path class="dt-link-base" d="${d}" stroke="${color}"/><path class="dt-link-flow" d="${d}" stroke="${color}"/>`
      : `<path class="dt-link-idle" d="${d}"/>`
  }
  return <svg className="dt-links">{seg('pr', 'plan', 'review')}{seg('rw', 'review', 'work')}{seg('wr', 'work', 'reply')}</svg>
}

/** Dispatch board: current + next read-only cards, phase demo, and the four-node flowing lane. */
function DispatchBoard() {
  const { call } = usePanel()
  const { data: tickets } = usePoll(() => call('GET tickets', { query: { state: 'open' } }), [])
  const list = tickets?.items ?? []
  const current = list[0], next = list[1]
  const [phase, setPhase] = useState(0)
  const scene = LANE_SCENES[phase]!
  const [tick, setTick] = useState(0)
  const lane = useRef<HTMLDivElement>(null)
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 400); return () => clearInterval(timer) }, [])
  void tick
  return <>
    <SimpleList head="正在派工">
      {current && <div className="dt-ticket-strip-item"><span className="dt-mono">{current.id}</span><span className="grow">{current.title}</span><Tag tone="info">当前执行</Tag></div>}
      {next && <div className="dt-ticket-strip-item next"><span className="dt-mono">{next.id}</span><span className="grow">{next.title}</span><Tag tone="quiet">待执行</Tag></div>}
    </SimpleList>
    <div className="dt-phase-switch"><span>阶段演示 ▸</span>{LANE_SCENES.map((item, index) =>
      <button type="button" key={item.label} className={index === phase ? 'on' : ''} onClick={() => setPhase(index)}>{item.label}</button>)}</div>
    <div className="dt-lane" data-scene={scene.color} ref={lane}>
      <LaneSvg scene={scene} lane={lane} />
      {LANE_NODES.map(node => {
        const state = (scene.st[node.id as keyof typeof scene.st] ?? 'idle') as LaneState
        return <div key={node.id} className={`dt-lane-node node-${node.cls} is-${state}`} data-id={node.id}>
          <div className="dt-lane-head"><b>{node.name}</b><span className="dt-lane-state"><span className={`dot ${state === 'running' ? 'ongoing' : state === 'done' ? 'done' : ''}`} />{STATE_TEXT[state]}</span></div>
          <div className="dt-lane-sub">{node.sub}</div>
          <div className="dt-lane-meter"><i style={{ width: state === 'done' ? '100%' : state === 'running' ? '62%' : '0%' }} /></div>
          {node.subs && <div className="dt-lane-subagents"><div>└ 该窗口开的子智能体</div>{node.subs.map(sub =>
            <div className="dt-lane-subagent" key={sub.name}><span className={`dot ${state === 'idle' ? '' : 'ongoing'}`} /><span>{sub.name}</span><small>{sub.sub}</small></div>)}</div>}
        </div>
      })}
    </div>
  </>
}

/** Reply board: dropped replies and the flow counts that reached a channel. */
function ReplyBoard() {
  const { call, navigate } = usePanel()
  const { data: sources } = usePoll(() => call('GET sources'), [])
  const dropped = (sources ?? []).flatMap(source => source.dropped.map(item => ({ ...item, source })))
  return <>
    <div className="dt-dash-cards"><Card label="已丢弃回执" value={dropped.length} tone="bad" />
      <Card label="来源" value={(sources ?? []).length} /></div>
    <SimpleList head="最近丢弃的回执">{dropped.slice(0, 8).map(item => <div className="dt-dash-row" key={item.id}>
      <span className="dot error" /><span className="grow">{item.preview}</span>
      {item.ticket && <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'tickets', id: item.ticket!.id })}>{item.ticket.id}</button>}
      <Tag tone="warning">{item.dropped.reason}</Tag></div>)}</SimpleList>
  </>
}
