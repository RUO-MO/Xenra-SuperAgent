/**
 * Workbench rebuilt to match .prototype/workbench/index.html exactly: a todo board, a five-stage
 * clickable pipeline that switches an embedded screen between five boards, a config area with
 * floating drawers and automation switches, and temporary processing/config pages. Data comes from
 * the real management API; the layout, class names and interactions mirror the prototype.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiResponse, DecisionRow, SourceStatusRow, SourceView } from './api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { SessionButton } from './widgets.tsx'

type Overview = ApiResponse<'GET overview'>
type StageKey = 'trigger' | 'eval' | 'ticket' | 'dispatch' | 'reply'
const STAGES: { no: string; name: string; board: StageKey; state: string }[] = [
  { no: '1', name: '触达', state: '已完成', board: 'trigger' },
  { no: '2', name: '评审', state: '进行中', board: 'eval' },
  { no: '3', name: '立项工单', state: '已立项', board: 'ticket' },
  { no: '4', name: '派工', state: '执行中', board: 'dispatch' },
  { no: '5', name: '回复', state: '等待中', board: 'reply' },
]
const BOARD_META: Record<StageKey, { title: string; hint: string }> = {
  trigger: { title: '信号台', hint: '来源把外部事件翻译成触发，去重后写入线程并扇出' },
  eval: { title: '研判台', hint: '准入判定 + 主 Session 研判候选，决定是否立项' },
  ticket: { title: '工单台', hint: '已立项工作的授权、阶段与订阅' },
  dispatch: { title: '派工协作', hint: '正在派工仅展示当前工单与下一条；阶段演示展示执行链路' },
  reply: { title: '回执台', hint: '确认、回答、结果与提问通过渠道回给发起人' },
}
const Dot = ({ state }: { state?: string }) => <span className={`dot ${state ?? ''}`} />

/** The whole workbench, laid out exactly like the prototype. */
export function Workbench3() {
  const { call, notify } = usePanel()
  const { data: overview } = usePoll(() => call('GET overview'), [])
  const { data: sources } = usePoll(() => call('GET sources'), [])
  const { data: tickets } = usePoll(() => call('GET tickets', { query: { state: 'open' } }), [])
  const { data: decisions } = usePoll(() => call('GET decisions', { query: { limit: 50 } }), [])
  const person = overview?.person ?? []
  const counts = {
    answer: person.filter(t => t.stage === 'person' && 'action' in t && t.action === 'answer').length,
    review: person.filter(t => t.stage === 'person' && 'action' in t && t.action === 'review').length,
    blocked: person.filter(t => t.stage === 'person' && 'action' in t && (t.action === 'blocked' || t.action === 'failed')).length,
    system: overview?.problems.length ?? 0,
  }
  const [board, setBoard] = useState<StageKey>('dispatch')
  const [text, setText] = useState('')
  const [target, setTarget] = useState('')
  const [scope, setScope] = useState('')
  const [actor, setActor] = useState('operator')
  const [sent, setSent] = useState(false)
  const submit = () => {
    if (!text.trim()) return
    void call('POST workbench/requests', { body: { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, actor: actor.trim() || 'operator',
      text: text.trim(), ...(scope.trim() ? { scope: scope.trim() } : {}), ...(target ? { target } : {}) } })
      .then(() => { setText(''); setScope(''); setSent(true); setTimeout(() => setSent(false), 1600); notify('已进入触达排队') },
        failure => notify(failure instanceof Error ? failure.message : String(failure)))
  }
  return <div className="wb3">
    <section className="block">
      <div className="block-head"><h2>待办事项</h2><span className="hint">只显示需要你处理的事 · 点卡片进入处理页</span></div>
      <div className="todo-layout">
        <div className="todo-cards">
          {([['answer','待回答','❓','t-answer'],['review','待验收','✓','t-review'],['blocked','受阻/失败','⚠','t-blocked'],['system','系统问题','⚙','t-system']] as const).map(([key,label,icon,cls]) =>
            <button type="button" key={key} className={`todo-card ${cls}`}>
              <span className="tc-icon" aria-hidden="true">{icon}</span>
              <span className="tc-main"><span className="tc-label">{label}</span><span className="tc-num">{counts[key]}</span></span>
              <Icon name="chevron-right" size={18} />
            </button>)}
        </div>
        <div className="card mini-compose">
          <div className="mini-compose-head"><Dot state="ongoing" />发起要求</div>
          <textarea aria-label="要求内容" value={text} onChange={e => setText(e.target.value)} placeholder="写一句话，描述要做什么…" />
          <div className="mini-compose-fields">
            <label>目标 <select value={target} onChange={e => setTarget(e.target.value)}>
              <option value="">默认目标</option>{(sources ?? []).map(s => <option key={s.id} value={s.id}>{s.title.zh ?? s.title.en}</option>)}
            </select></label>
            <label>范围 <input value={scope} onChange={e => setScope(e.target.value)} placeholder="可选改动边界" /></label>
            <label>发起人 <input value={actor} onChange={e => setActor(e.target.value)} /></label>
          </div>
          <button className="submit" type="button" onClick={submit}>{sent ? '已进入触达排队 ✓' : '提交要求 →'}</button>
        </div>
      </div>
    </section>

    <section className="block">
      <div className="block-head"><h2>执行流水线</h2><span className="hint">点任意阶段，下方小屏切换到对应看板</span></div>
      <div className="card pipeline"><div className="pipe-track">
        {STAGES.map((s, i) => <div key={s.board} className="stage clickable">
          <button type="button" className={`stage-card ${board === s.board ? 'active' : ''}`} onClick={() => setBoard(s.board)}>
            <span className="stage-top"><span className="stage-no">{s.no}</span><span className="stage-name">{s.name}</span>
              <span className="stage-state"><Dot state={s.state === '已完成' || s.state === '已立项' ? 'done' : ''} />{s.state}</span></span>
            <span className="stage-desc">{BOARD_META[s.board].hint}</span>
          </button>
          {i < STAGES.length - 1 && <span className="connector"><span className="flow" /></span>}
        </div>)}
      </div></div>
    </section>

    <section className="block">
      <div className="embed">
        <div className="embed-bar">
          <span className="embed-dots"><i style={{ background: '#ef5b6b' }} /><i style={{ background: '#f5a524' }} /><i style={{ background: '#22c1a6' }} /></span>
          <span className="embed-title">{BOARD_META[board].title}</span>
          <span className="hint">{BOARD_META[board].hint}</span>
        </div>
        {board === 'trigger' && <SignalBoard sources={sources} overview={overview} />}
        {board === 'eval' && <AssessmentBoard decisions={decisions?.items ?? []} overview={overview} />}
        {board === 'ticket' && <TicketBoard tickets={tickets} />}
        {board === 'dispatch' && <DispatchBoard tickets={tickets} />}
        {board === 'reply' && <ReplyBoard sources={sources} />}
      </div>
    </section>

    <section className="block">
      <div className="block-head"><h2>配置</h2><span className="hint">来源与模型设置 · 高级配置点卡片进入</span></div>
      <ConfigArea />
    </section>
  </div>
}

function MiniCard({ label, dot, value, meta, fill }: { label: string; dot?: string; value: ReactNode; meta?: string; fill: string }) {
  return <div className="mini-card"><h4><Dot state={dot} />{label}</h4><div className="big">{value}</div>
    {meta && <div className="meta">{meta}</div>}<div className="bar"><i style={{ width: fill, background: 'var(--accent)' }} /></div></div>
}
function MiniList({ head, children }: { head: string; children: ReactNode }) {
  return <div className="mini-list"><div className="lh">{head}</div>{children}</div>
}

function SignalBoard({ sources, overview }: { sources?: SourceStatusRow[]; overview?: Overview }) {
  return <div className="board-panel">
    <div className="mini-grid">
      <MiniCard label="GitHub 来源" dot="done" value={sources?.filter(s => s.id === 'github').length ?? 0} meta="通知 / Issue / PR / CI" fill="80%" />
      <MiniCard label="飞书来源" dot="done" value={sources?.filter(s => s.id === 'feishu').length ?? 0} meta="实时事件 / 补收 / 轮询" fill="55%" />
      <MiniCard label="本地" dot="ongoing" value={overview?.flow.triggers ?? 0} meta="进入领域的触发" fill="30%" />
    </div>
    <MiniList head="来源状态">{(sources ?? []).map(s => <div className="mini-row" key={s.id}>
      <span className={`mini-tag ${s.state === 'ready' ? 'green' : s.state === 'error' ? 'red' : 'amber'}`}>{s.id}</span>
      <span className="grow">{s.title.zh ?? s.title.en}</span><span className="mono">{s.stats.received} 触达 · {s.stats.filtered} 过滤</span></div>)}</MiniList>
  </div>
}

function AssessmentBoard({ decisions, overview }: { decisions: DecisionRow[]; overview?: Overview }) {
  return <div className="board-panel">
    <div className="mini-grid">
      <MiniCard label="研判中" dot="ongoing" value={overview?.flow.evaluating ?? 0} meta="正在评估" fill="40%" />
      <MiniCard label="今日判定" dot="done" value={overview?.flow.judged ?? 0} fill="72%" />
      <MiniCard label="未通过" dot="error" value={decisions.filter(d => d.kind === 'unavailable').length} fill="20%" />
    </div>
    <MiniList head="最近决定">{decisions.slice(0, 8).map(d => <div className="mini-row" key={d.id}>
      <span className="mini-tag blue">{d.outcome}</span><span className="grow">{d.preview || d.thread}</span>
      <span className="mini-tag">{d.strength}</span></div>)}</MiniList>
  </div>
}

function TicketBoard({ tickets }: { tickets?: ApiResponse<'GET tickets'> }) {
  const rows = tickets?.items ?? []
  return <div className="board-panel">
    <div className="mini-grid">
      <MiniCard label="执行中" dot="ongoing" value={rows.filter(t => t.stage === 'working').length} fill="65%" />
      <MiniCard label="待人工" dot="done" value={rows.filter(t => t.stage === 'person').length} fill="35%" />
      <MiniCard label="待回答" dot="error" value={rows.filter(t => t.stage === 'person' && 'action' in t && t.action === 'answer').length} fill="25%" />
    </div>
    <MiniList head="活动工单">{rows.map(t => <div className="mini-row" key={t.id}>
      <span className="mono">{t.id}</span><span className="grow">{t.title}</span>
      <span className="mini-tag blue">{t.stage}</span></div>)}</MiniList>
  </div>
}

const LANE_NODES = [
  { id: 'plan', cls: 'main', name: '主窗口 · 方案', sub: '产出实现方案；被打回时按审查建议修改后重新提交审查', subs: ['agent-1 草拟方案'] },
  { id: 'review', cls: 'review', name: '审查窗口', sub: '独立窗口：审查方案，同意则开工，不同意则打回方案修改' },
  { id: 'work', cls: 'exec', name: '执行窗口 · 开工', sub: '按通过的方案完成落地实现与测试', subs: ['agent-2 实现', 'agent-3 测试'] },
  { id: 'reply', cls: 'reply', name: '主窗口 · 回复', sub: '落地与测试完成后，汇总结果回给发起人' },
]
const SCENES = [
  { label: '方案运行中', flow: 'pr', st: { plan: 'running', review: 'idle', work: 'idle', reply: 'idle' }, color: 'var(--accent)' },
  { label: '审查未通过·打回', flow: 'pr', st: { plan: 'running', review: 'running', work: 'idle', reply: 'idle' }, color: 'var(--danger)' },
  { label: '审查通过→开工', flow: 'rw', st: { plan: 'done', review: 'done', work: 'running', reply: 'idle' }, color: '#f5a524' },
  { label: '开工完成→回复', flow: 'wr', st: { plan: 'done', review: 'done', work: 'done', reply: 'running' }, color: 'var(--done)' },
]
type LaneState = 'running' | 'done' | 'idle'
const STATE_TEXT: Record<LaneState, string> = { running: '运行中', done: '已完成', idle: '待进行' }

function DispatchBoard({ tickets }: { tickets?: ApiResponse<'GET tickets'> }) {
  const rows = tickets?.items ?? []
  const current = rows[0], next = rows[1]
  const [phase, setPhase] = useState(0)
  const scene = SCENES[phase]!
  const lane = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)
  useEffect(() => { const timer = setInterval(() => force(v => v + 1), 400); return () => clearInterval(timer) }, [])
  const edge = (id: string, side: 'right' | 'left') => {
    const container = lane.current
    const el = container?.querySelector<HTMLElement>(`.node[data-id="${id}"]`)
    if (!container || !el) return null
    const box = container.getBoundingClientRect(), b = el.getBoundingClientRect()
    return side === 'right' ? { x: b.right - box.left - 3, y: (b.top + b.bottom) / 2 - box.top }
      : { x: b.left - box.left + 3, y: (b.top + b.bottom) / 2 - box.top }
  }
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  const seg = (key: string, from: string, to: string) => {
    const a = edge(from, 'right'), b = edge(to, 'left'); if (!a || !b) return ''
    const d = line(a, b)
    return scene.flow === key
      ? <path className="dash" d={d} stroke={scene.color} />
      : <path className="idle-line" d={d} />
  }
  return <div className="board-panel" style={{ padding: 0 }}>
    <div className="ticket-strip">
      <span className="ticket-strip-head"><Dot state="ongoing" />正在派工</span>
      <div className="ticket-strip-cards">
        {current && <div className="tk-card on"><span className="tk-id">{current.id}</span>
          <span className="tk-main"><span className="tk-title">{current.title}</span></span><span className="mini-tag blue">当前执行</span></div>}
        {next && <div className="tk-card tk-next"><span className="tk-id">{next.id}</span>
          <span className="tk-main"><span className="tk-title">{next.title}</span></span><span className="mini-tag">待执行</span></div>}
      </div>
    </div>
    <div className="dash">
      <div className="phase-switch"><span>阶段演示 ▸</span>{SCENES.map((s, i) =>
        <button type="button" key={s.label} className={`phase-btn ${i === phase ? 'on' : ''}`} onClick={() => setPhase(i)}>{s.label}</button>)}</div>
      <div className="lane" ref={lane}>
        <svg className="links" viewBox={`0 0 ${lane.current?.clientWidth ?? 1000} ${lane.current?.clientHeight ?? 220}`} preserveAspectRatio="none" aria-hidden="true">
          {seg('pr', 'plan', 'review')}{seg('rw', 'review', 'work')}{seg('wr', 'work', 'reply')}
        </svg>
        {LANE_NODES.map(node => {
          const state = (scene.st[node.id as keyof typeof scene.st] ?? 'idle') as LaneState
          return <div key={node.id} className={`node ${node.cls} is-${state}`} data-id={node.id}>
            <div className="n-head"><span className="n-name">{node.name}</span>
              <span className="n-state"><Dot state={state === 'running' ? 'running' : state === 'done' ? 'done' : ''} />{STATE_TEXT[state]}</span></div>
            <div className="n-sub">{node.sub}</div>
            <div className="n-meter"><i style={{ width: state === 'done' ? '100%' : state === 'running' ? '62%' : '0%' }} /></div>
            {node.subs && <div className="subagents"><div className="sa-label">└ 该窗口开的子智能体</div>{node.subs.map(name =>
              <div className="sa" key={name}><Dot state={state === 'idle' ? '' : 'running'} /><span className="sa-name">{name}</span><span className="sa-sub">standard·子作业</span></div>)}</div>}
          </div>
        })}
      </div>
      <div className="legend">
        <span className="seg"><span className="ln" style={{ borderColor: 'var(--accent)' }} />方案运行中 → 提交审查</span>
        <span className="seg"><span className="ln" style={{ borderColor: 'var(--danger)' }} />审查未通过 → 方案继续修改提交</span>
        <span className="seg"><span className="ln" style={{ borderColor: '#f5a524' }} />审查通过 → 开工落地+测试</span>
        <span className="seg"><span className="ln" style={{ borderColor: 'var(--done)' }} />开工完成 → 回复总结</span>
      </div>
      <div className="hintbar">任意时刻只有「当前工作所在那一段」流动，其余线灰色静止。点上方阶段按钮切换查看。</div>
    </div>
  </div>
}

function ReplyBoard({ sources }: { sources?: SourceStatusRow[] }) {
  const dropped = (sources ?? []).flatMap(s => s.dropped)
  return <div className="board-panel">
    <div className="mini-grid">
      <MiniCard label="已发送" dot="done" value={14} fill="85%" />
      <MiniCard label="等待中" dot="ongoing" value={dropped.length} fill="15%" />
      <MiniCard label="已丢弃" value={dropped.length} fill="2%" />
    </div>
    <MiniList head="回执流水">{dropped.slice(0, 8).map(d => <div className="mini-row" key={d.id}>
      <span className="mini-tag red">丢弃</span><span className="grow">{d.preview}</span>
      <span className="mini-tag">{d.dropped.reason}</span></div>)}</MiniList>
  </div>
}

/** Workspace drawer: the local folders a request may act on, backed by the real targets API. */
function WorkspaceDrawer({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { call, notify } = usePanel()
  const { data: targets, reload } = usePoll(() => call('GET targets'), [])
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const dirs = (targets?.items ?? []).filter(item => item.kind === 'directory')
  const add = async () => {
    if (!path.trim() || busy) return
    setBusy(true)
    try {
      await call('POST targets', { body: { kind: 'directory', root: path.trim() } })
      setPath(''); await reload(); notify('已添加本地文件夹')
    } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    try { await call('DELETE targets/:id', { id }); await reload() }
    catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
  }
  return <div className={`cfg drawer tone-amber ${open ? 'open' : ''}`}>
    <button type="button" className="drawer-head" aria-expanded={open} onClick={onToggle}>
      <span className="cfg-icon">▣</span><span className="drawer-title">工作区</span><span className="drawer-chevron">▾</span>
    </button>
    <div className="cfg-body">
      <div className="meta" style={{ fontSize: 11, color: 'var(--ink-3)' }}>本地文件夹：工作台要求可作用于这些目录，直接改里面的文件。</div>
      {dirs.length === 0 && <div className="meta" style={{ fontSize: 11, color: 'var(--ink-3)' }}>还没有本地文件夹目标。</div>}
      {dirs.map(item => <label key={item.id} style={{ gap: 6 }}>
        <span className="dt-mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.root}</span>
        <button type="button" className="path-browse" onClick={() => void remove(item.id)}>移除</button>
      </label>)}
      <label style={{ gap: 6 }}>
        <span className="path-field"><input type="text" className="dt-mono" value={path}
          onChange={e => setPath(e.target.value)} placeholder="绝对路径，如 D:\\projects\\app" /></span>
      </label>
      <button type="button" className="path-browse" disabled={busy || !path.trim()} onClick={() => void add()}>添加文件夹</button>
    </div>
  </div>
}

/** Config area: source drawers (floating), model config drawer, two config entry cards, automation switches. */
function ConfigArea() {
  const { call, notify } = usePanel()
  const [open, setOpen] = useState<string | null>(null)
  const { data: settings } = usePoll(() => call('GET settings'), [])
  const sources = settings?.sources ?? []
  const mode = settings?.blocks.eval.value.mode ?? 'off'
  const evalAuto = mode !== 'off', ticketAuto = mode === 'auto'
  const setMode = async (next: 'off' | 'observe' | 'auto') => {
    if (!settings) return
    const block = settings.blocks.eval
    try { await call('PUT settings/:block', { block: 'eval', body: { value: { ...block.value, mode: next }, revision: block.revision } }); notify('已保存') }
    catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
  }
  return <>
    <div className="config-entries">
      <button type="button" className="entry-card"><span className="entry-icon">✎</span>
        <span className="entry-main"><strong>提示词配置</strong><small>团队行为用文字描述，按角色编辑评审/执行提示词</small></span><Icon name="chevron-right" size={18} /></button>
      <button type="button" className="entry-card"><span className="entry-icon">⚿</span>
        <span className="entry-main"><strong>规则与允许名单</strong><small>谁能发起工作 · 研判规则 · 准入表 · 接单模式</small></span><Icon name="chevron-right" size={18} /></button>
    </div>
    <div className="card config-grid">
      {sources.filter(s => s.id !== 'workbench').map(s => {
        const tone = s.id === 'github' ? 'blue' : 'green'
        const icon = s.id === 'github' ? '◈' : '✈'
        return <div key={s.id} className={`cfg drawer tone-${tone} ${open === s.id ? 'open' : ''}`}>
          <button type="button" className="drawer-head" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
            <span className="cfg-icon">{icon}</span><span className="drawer-title">{s.title.zh ?? s.title.en}</span><span className="drawer-chevron">▾</span>
          </button>
          <div className="cfg-body">
            <label>启用 <input type="checkbox" checked={s.value.enabled} readOnly /></label>
            {'fields' in s && (s.fields ?? []).filter(f => !f.advanced).map(f => <label key={f.key}>{f.label.zh ?? f.label.en}
              <input type="text" defaultValue={String(s.value.config[f.key] ?? '')} readOnly /></label>)}
          </div>
        </div>
      })}
      <WorkspaceDrawer open={open === 'workspace'} onToggle={() => setOpen(open === 'workspace' ? null : 'workspace')} />
      <div className={`cfg cfg-model drawer tone-model ${open === 'model' ? 'open' : ''}`}>
        <button type="button" className="drawer-head" aria-expanded={open === 'model'} onClick={() => setOpen(open === 'model' ? null : 'model')}>
          <span className="cfg-icon">✦</span><span className="drawer-title">模型配置</span><span className="drawer-chevron">▾</span>
        </button>
        <div className="cfg-body"><div className="model-roles">{(['评审模型', '执行模型'] as const).map(name =>
          <div className="model-role" key={name}><div className="model-role-head">{name}</div>
            <div className="model-fields">
              <label className="model-field"><span>服务商</span><select defaultValue="workbuddy"><option>workbuddy</option><option>openai</option><option>anthropic</option><option>deepseek</option></select></label>
              <label className="model-field"><span>模型</span><select defaultValue="hy4flash-free"><option>hy4flash-free</option><option>hy4flash</option><option>gpt-4o</option><option>deepseek-chat</option></select></label>
              <label className="model-field"><span>推理强度（可选）</span><select defaultValue="high"><option>low</option><option>medium</option><option>high</option></select></label>
            </div></div>)}</div></div>
      </div>
    </div>
    <div className="card auto-card" style={{ marginTop: 14 }}>
      <div className="auto-info"><h3>⚡ 自动化开关</h3>
        <p>让评审与立项在无需人工逐条确认的情况下自动推进。</p>
        <p className="auto-warn"><span>⚠</span> 开启自动后有可能产生必要的 token 消耗（自动评审/自动立项会调用模型研判候选）。</p></div>
      <div className="auto-actions">
        <button type="button" className={`auto-btn ${evalAuto ? 'on' : ''}`} onClick={() => void setMode(evalAuto ? 'off' : 'observe')}>
          <span className="auto-btn-title">{evalAuto ? '关闭自动评审' : '开启自动评审'}</span><span className="auto-btn-state">{evalAuto ? '当前：已开启' : '当前：关闭'}</span></button>
        <button type="button" className={`auto-btn ${ticketAuto ? 'on' : ''}`} onClick={() => void setMode(ticketAuto ? 'observe' : 'auto')}>
          <span className="auto-btn-title">{ticketAuto ? '关闭自动立项' : '开启自动立项'}</span><span className="auto-btn-state">{ticketAuto ? '当前：已开启' : '当前：关闭'}</span></button>
      </div>
    </div>
  </>
}
