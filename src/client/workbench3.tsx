/**
 * Workbench rebuilt to match .prototype/workbench/index.html: a todo board, a five-stage clickable pipeline that
 * switches an embedded screen between five boards, a config area with floating drawers and automation switches, and
 * temporary processing/config pages. Every status shown here is read from the management API; the prototype's demo
 * values (fixed stage labels, the four-scene dispatch demo, a fixed sent count) are deliberately not reproduced.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ApiResponse, DecisionRow, Problem, SourceStatusRow, SourceView } from './api.ts'
import { usePoll } from './api.ts'
import { Icon } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import type { TodoKind } from './route.ts'
import { ModelField, SettingsProvider, useBlockDraft, useSettings } from './settings-kit.tsx'
import { SessionButton } from './widgets.tsx'

type Overview = ApiResponse<'GET overview'>
type StageKey = 'trigger' | 'eval' | 'ticket' | 'dispatch' | 'reply'
type StageState = 'done' | 'ongoing' | 'error' | 'idle'
const STAGES: { no: string; name: string; board: StageKey }[] = [
  { no: '1', name: '触达', board: 'trigger' },
  { no: '2', name: '评审', board: 'eval' },
  { no: '3', name: '立项工单', board: 'ticket' },
  { no: '4', name: '派工', board: 'dispatch' },
  { no: '5', name: '回复', board: 'reply' },
]
const BOARD_META: Record<StageKey, { title: string; hint: string }> = {
  trigger: { title: '信号台', hint: '来源把外部事件翻译成触发，去重后写入线程并扇出' },
  eval: { title: '研判台', hint: '准入判定 + 主 Session 研判候选，决定是否立项' },
  ticket: { title: '工单台', hint: '已立项工作的授权、阶段与订阅' },
  dispatch: { title: '派工协作', hint: '当前工单与下一条，以及该工单真实的派工链路' },
  reply: { title: '回执台', hint: '确认、回答、结果与提问通过渠道回给发起人' },
}
const Dot = ({ state }: { state?: string }) => <span className={`dot ${state ?? ''}`} />
const glyph = (state: StageState) => state === 'done' ? 'done' : state === 'ongoing' ? 'ongoing' : state === 'error' ? 'error' : ''

/** One pipeline stage's real state: counts from `overview.flow`, failures from `overview.problems`, replies from the outbox. */
function stageStates(overview: Overview | undefined, tickets: ApiResponse<'GET tickets'> | undefined) {
  const flow = overview?.flow
  const problems = overview?.problems ?? []
  const replies = overview?.replies
  const rows = tickets?.items ?? []
  const evalProblems = problems.filter(problem => problem.kind === 'eval-unavailable' || problem.kind === 'eval-overdue')
  const modelProblem = problems.find(problem => problem.kind === 'model-error')
  const outgoing = problems.filter(problem => problem.kind === 'outgoing')
  const received = flow?.received ?? 0, filtered = flow?.filtered ?? 0
  const evaluating = flow?.evaluating ?? 0, judged = flow?.judged ?? 0
  const review = flow?.review ?? 0, proposed = flow?.proposed ?? 0
  const open = rows.length
  const working = rows.filter(ticket => ticket.stage === 'working').length
  const running = overview?.executor.running ?? 0, queued = overview?.executor.queued ?? 0
  const map: Record<StageKey, { state: StageState; text: string }> = {
    trigger: received > 0
      ? { state: 'done', text: `${received} 触达 · ${filtered} 过滤` }
      : { state: 'idle', text: '暂无触达' },
    eval: review > 0
      ? { state: 'ongoing', text: `待分流 ${review}` }
      : evaluating > 0
        ? { state: 'ongoing', text: `${evaluating} 研判中` }
        : evalProblems.length > 0 || modelProblem
          ? { state: 'error', text: `研判失败 ${evalProblems.length || 1}${modelProblem ? ` · ${modelProblem.code}` : ''}` }
          : judged > 0 ? { state: 'done', text: `已判定 ${judged}` } : { state: 'idle', text: '等待候选' },
    ticket: proposed > 0
      ? { state: 'ongoing', text: `待立项 ${proposed}` }
      : open > 0
        ? { state: 'done', text: `已立项 ${open}` }
        : evalProblems.length > 0 ? { state: 'error', text: '没有立项' } : { state: 'idle', text: '等待立项' },
    dispatch: running > 0 ? { state: 'ongoing', text: `执行中 ${running}` }
      : queued > 0 ? { state: 'ongoing', text: `排队 ${queued}` }
        : working > 0 ? { state: 'ongoing', text: `派工中 ${working}` }
          : rows.length > 0 ? { state: 'idle', text: `待派工 ${rows.length}` } : { state: 'idle', text: '暂无工单' },
    reply: (replies?.pending ?? 0) > 0 ? { state: 'ongoing', text: `待发送 ${replies?.pending}` }
      : outgoing.length > 0 || (replies?.dropped ?? 0) > 0
        ? { state: 'error', text: `投递失败 ${outgoing.length || replies?.dropped}` }
        : (replies?.sent ?? 0) > 0 ? { state: 'done', text: `已发送 ${replies?.sent}` } : { state: 'idle', text: '暂无回执' },
  }
  return map
}

export function problemText(problem: Problem): string {
  switch (problem.kind) {
    case 'setup': return `安装未完成：${problem.detail}`
    case 'no-source': return '没有启用的来源，任何消息都进不来'
    case 'no-allowed': return '允许名单为空，没人能发起工作'
    case 'source-error': return `${problem.source.title.zh ?? problem.source.title.en} 异常：${problem.source.health.detail}`
    case 'executor-paused': return '执行器已暂停，新工单不会派工'
    case 'runtime-error': return `${problem.name}：${problem.detail}`
    case 'eval-overdue': return `研判超时：${problem.thread.title}`
    case 'eval-unavailable': return `研判失败（${reasonLabel(problem.reason)}）：${problem.thread.title}`
    case 'model-error': return `模型不可用（${problem.code}）：${problem.message}`
    case 'outgoing': return `回执发送失败（${problem.outgoing.channel.source}，尝试 ${problem.outgoing.attempts} 次）：${problem.outgoing.error}`
  }
}
function reasonLabel(reasons: readonly { code: string }[]): string {
  const first = reasons[0]?.code ?? 'timeout'
  const known: Record<string, string> = { timeout: '超时', policyChanged: '策略变更', noAdmissible: '无准入', AUTH: '登录态失效', RATE_LIMIT: '限流', manualDrop: '人工丢弃' }
  return known[first] ?? first
}

/** The whole workbench, laid out exactly like the prototype. */
export function Workbench3() {
  const { call, notify, navigate } = usePanel()
  const { state } = usePanelData()
  const { data: overview } = usePoll(() => call('GET overview'), [])
  const { data: sources } = usePoll(() => call('GET sources'), [])
  const { data: targets } = usePoll(() => call('GET targets'), [])
  const { data: tickets } = usePoll(() => call('GET tickets', { query: { state: 'open' } }), [])
  const { data: gates, reload: reloadGates } = usePoll(() => call('GET gates'), [])
  const { data: decisions } = usePoll(() => call('GET decisions', { query: { limit: 50 } }), [])
  const person = overview?.person ?? []
  const counts = {
    answer: person.filter(t => t.stage === 'person' && 'action' in t && t.action === 'answer').length,
    review: person.filter(t => t.stage === 'person' && 'action' in t && t.action === 'review').length,
    blocked: person.filter(t => t.stage === 'person' && 'action' in t && (t.action === 'blocked' || t.action === 'failed')).length,
    system: overview?.problems.length ?? 0,
  }
  const stages = stageStates(overview, tickets)
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
            <button type="button" key={key} className={`todo-card ${cls}`}
              onClick={() => navigate({ page: 'processing', id: key as TodoKind })}>
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
              <option value="">默认目标</option>{(targets?.items ?? []).map(item =>
                <option key={item.id} value={item.id}>{item.name || (item.kind === 'repository' ? item.repository : item.root)}</option>)}
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
              <span className={`stage-state state-${stages[s.board].state}`}><Dot state={glyph(stages[s.board].state)} />{stages[s.board].text}</span></span>
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
        {board === 'eval' && <AssessmentBoard decisions={decisions?.items ?? []} overview={overview} gates={gates} refreshed={reloadGates} reviewSessionId={state?.masterId} />}
        {board === 'ticket' && <TicketBoard tickets={tickets} overview={overview} gates={gates} refreshed={reloadGates} proposalSessionId={state?.proposalId} />}
        {board === 'dispatch' && <DispatchBoard tickets={tickets} />}
        {board === 'reply' && <ReplyBoard overview={overview} />}
      </div>
    </section>

    <section className="block">
      <div className="block-head"><h2>配置</h2><span className="hint">来源、工作区与模型设置 · 高级配置点卡片进入</span></div>
      <SettingsProvider><ConfigArea /></SettingsProvider>
    </section>
  </div>
}

function MiniCard({ label, dot, value, meta, fill }: { label: string; dot?: string; value: ReactNode; meta?: string; fill: number }) {
  return <div className="mini-card"><h4><Dot state={dot} />{label}</h4><div className="big">{value}</div>
    {meta && <div className="meta">{meta}</div>}<div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, fill))}%`, background: 'var(--accent)' }} /></div></div>
}
function MiniList({ head, children }: { head: string; children: ReactNode }) {
  return <div className="mini-list"><div className="lh">{head}</div>{children}</div>
}
const share = (value: number, total: number) => total > 0 ? Math.round(value / total * 100) : 0

function SignalBoard({ sources, overview }: { sources?: SourceStatusRow[]; overview?: Overview }) {
  const received = overview?.flow.received ?? 0
  const source = (id: string) => sources?.find(item => item.id === id)
  const github = source('github'), feishu = source('feishu')
  return <div className="board-panel">
    <div className="mini-grid">
      <MiniCard label="GitHub 来源" dot={github?.state === 'ready' ? 'done' : github?.state === 'error' ? 'error' : undefined}
        value={github?.stats.received ?? 0} meta={`${github?.stats.filtered ?? 0} 已过滤 · 24 小时`} fill={share(github?.stats.received ?? 0, received)} />
      <MiniCard label="飞书来源" dot={feishu?.state === 'ready' ? 'done' : feishu?.state === 'error' ? 'error' : undefined}
        value={feishu?.stats.received ?? 0} meta={`${feishu?.stats.filtered ?? 0} 已过滤 · 24 小时`} fill={share(feishu?.stats.received ?? 0, received)} />
      <MiniCard label="本地" dot="ongoing" value={overview?.flow.triggers ?? 0} meta="进入领域的触发 · 24 小时" fill={share(overview?.flow.triggers ?? 0, received || 1)} />
    </div>
    <MiniList head="来源状态">{(sources ?? []).map(s => <div className="mini-row" key={s.id}>
      <span className={`mini-tag ${s.state === 'ready' ? 'green' : s.state === 'error' ? 'red' : 'amber'}`}>{s.id}</span>
      <span className="grow">{s.title.zh ?? s.title.en}</span><span className="mono">{s.stats.received} 触达 · {s.stats.filtered} 过滤</span></div>)}
      {(sources?.length ?? 0) === 0 && <div className="mini-row"><span className="grow">没有已安装的来源</span></div>}
    </MiniList>
  </div>
}

function AssessmentBoard({ decisions, overview, gates, refreshed, reviewSessionId }: { decisions: DecisionRow[]; overview?: Overview; gates?: ApiResponse<'GET gates'>; refreshed: () => Promise<void>; reviewSessionId?: string }) {
  const unavailable = decisions.filter(d => d.kind === 'unavailable')
  const modelError = overview?.problems.find(problem => problem.kind === 'model-error')
  return <div className="board-panel">
    <ReviewGate gate={gates} evaluating={overview?.flow.evaluating ?? 0} judging={overview?.flow.judged ?? 0} refreshed={refreshed} sessionId={reviewSessionId} />
    <div className="mini-grid">
      <MiniCard label="待分流" dot="ongoing" value={gates?.review.items.length ?? 0} meta="人工决定是否进入研判" fill={share(gates?.review.items.length ?? 0, Math.max(1, (gates?.review.items.length ?? 0) + (overview?.flow.evaluating ?? 0)))} />
      <MiniCard label="研判中" dot="ongoing" value={overview?.flow.evaluating ?? 0} meta="正在评估" fill={share(overview?.flow.evaluating ?? 0, Math.max(1, overview?.flow.judged ?? 0))} />
      <MiniCard label="已判定" dot="done" value={overview?.flow.judged ?? 0} meta="24 小时" fill={100} />
      <MiniCard label="失败" dot="error" value={unavailable.length} meta={modelError ? `${modelError.code} · ${modelError.message.slice(0, 24)}` : '超时或模型不可用'} fill={share(unavailable.length, Math.max(1, decisions.length))} />
    </div>
    <MiniList head="最近决定">{decisions.slice(0, 8).map(d => <div className="mini-row" key={d.id}>
      <span className={`mini-tag ${d.kind === 'unavailable' ? 'red' : d.outcome === 'accept' || d.outcome === 'reopen' ? 'green' : 'blue'}`}>{d.outcome}</span>
      <span className="grow">{d.preview || d.thread}</span>
      <span className="mono">{d.reason.map(reason => reason.code).join(', ')}</span></div>)}
      {decisions.length === 0 && <div className="mini-row"><span className="grow">还没有判定记录</span></div>}
    </MiniList>
  </div>
}

/** The first gate: admitted Triggers wait here until a person lets them into Eval or drops them without model spend. */
function ReviewGate({ gate, evaluating, judging, refreshed, sessionId }: { gate?: ApiResponse<'GET gates'>; evaluating: number; judging: number; refreshed: () => Promise<void>; sessionId?: string }) {
  const { call, notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const items = gate?.review.items ?? []
  const act = async (action: 'approve' | 'drop', ids: string[]) => {
    if (!ids.length || busy) return
    setBusy(true)
    try {
      const result = await call('POST gates/review', { body: { action, triggerIds: ids } })
      await refreshed()
      notify(result.failed.length ? `已处理 ${result.changed} 条，${result.failed.length} 条状态已变化` : action === 'approve' ? `已放行 ${result.changed} 条` : `已丢弃 ${result.changed} 条`)
    } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <div className="gate-box">
    <div className="gate-head"><div><strong>进入评审前的选择门</strong>
      <div className="meta">先判断这条触达值不值得送进研判。丢弃在这里完成，不消耗研判 token。</div></div>
      <span className="gate-count">待分流 <b>{items.length}</b> 条</span>
      {sessionId && <SessionButton sessionId={sessionId} label="打开评审会话" variant="outline" />}</div>
    <div className="gate-list">
      {items.map(item => <div className="gate-row" key={item.id}>
        <span className="gtag">{item.source}</span>
        <span className={`mini-tag ${item.human ? 'blue' : 'amber'}`}>{item.human ? '明确' : '推断'}</span>
        <span className="gtext" title={item.text}>{item.text} <span className="why">· {item.actor}{item.addressed ? ` · ${item.addressed}` : ''}</span></span>
        <span className="gacts"><button type="button" className="gbtn yes" disabled={busy} onClick={() => void act('approve', [item.id])}>进入评审</button>
          <button type="button" className="gbtn no" disabled={busy} onClick={() => void act('drop', [item.id])}>丢弃</button></span>
      </div>)}
      {items.length === 0 && <div className="mini-row"><span className="grow">没有待分流的触达。新触达会先停在这里。</span></div>}
    </div>
    <div className="gate-foot">
      <button type="button" className="gbtn yes" disabled={busy || !items.length} onClick={() => void act('approve', items.map(item => item.id))}>全部进入评审</button>
      <button type="button" className="gbtn no" disabled={busy || !items.length} onClick={() => void act('drop', items.map(item => item.id))}>全部丢弃（垃圾）</button>
      <span className="meta">评审中/排队 {evaluating} · 已判定 {judging} · 已丢弃 {gate?.review.dropped ?? 0}</span>
    </div>
  </div>
}

function TicketBoard({ tickets, overview, gates, refreshed, proposalSessionId }: { tickets?: ApiResponse<'GET tickets'>; overview?: Overview; gates?: ApiResponse<'GET gates'>; refreshed: () => Promise<void>; proposalSessionId?: string }) {
  const rows = tickets?.items ?? []
  return <div className="board-panel">
    <TicketGate gate={gates} refreshed={refreshed} sessionId={proposalSessionId} />
    <div className="mini-grid">
      <MiniCard label="待立项" dot="ongoing" value={gates?.ticket.items.length ?? 0} meta="评审通过，等待人工决定" fill={share(gates?.ticket.items.length ?? 0, Math.max(1, rows.length))} />
      <MiniCard label="执行中" dot="ongoing" value={rows.filter(t => t.stage === 'working').length} meta={`执行器运行 ${overview?.executor.running ?? 0} · 排队 ${overview?.executor.queued ?? 0}`} fill={share(rows.filter(t => t.stage === 'working').length, Math.max(1, rows.length))} />
      <MiniCard label="待人工" dot="done" value={rows.filter(t => t.stage === 'person').length} fill={share(rows.filter(t => t.stage === 'person').length, Math.max(1, rows.length))} />
      <MiniCard label="空转" dot="idle" value={rows.filter(t => t.stage === 'idle').length} fill={share(rows.filter(t => t.stage === 'idle').length, Math.max(1, rows.length))} />
    </div>
    <MiniList head="活动工单">{rows.map(t => <div className="mini-row" key={t.id}>
      <span className="mono">{t.id}</span><span className="grow">{t.title}</span>
      <span className="mini-tag blue">{t.stage}{'action' in t && t.action ? `/${t.action}` : ''}</span></div>)}
      {rows.length === 0 && <div className="mini-row"><span className="grow">没有进行中的工单</span></div>}
    </MiniList>
  </div>
}

/** The second gate: an accept that passed Eval waits here until a person approves ticket creation or rejects it. */
function TicketGate({ gate, refreshed, sessionId }: { gate?: ApiResponse<'GET gates'>; refreshed: () => Promise<void>; sessionId?: string }) {
  const { call, notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const items = gate?.ticket.items ?? []
  const act = async (action: 'approve' | 'reject', ids: string[]) => {
    if (!ids.length || busy) return
    setBusy(true)
    try {
      const result = await call('POST gates/ticket', { body: { action, decisionIds: ids } })
      await refreshed()
      notify(result.failed.length ? `已处理 ${result.changed} 条，${result.failed.length} 条状态已变化` : action === 'approve' ? `已立项 ${result.changed} 条` : `已驳回 ${result.changed} 条`)
    } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <div className="gate-box">
    <div className="gate-head"><div><strong>立项前的选择门</strong>
      <div className="meta">评审通过的候选在这里决定要不要真的立项。重复、越界或价值不高的挡在门外。</div></div>
      <span className="gate-count">待立项 <b>{items.length}</b> 条</span>
      {sessionId && <SessionButton sessionId={sessionId} label="打开立项会话" variant="outline" />}</div>
    <div className="gate-list">
      {items.map(item => <div className="gate-row" key={item.decisionId}>
        <span className="gtag">{item.strength === 'explicit' ? '明确' : '推断'}</span>
        <span className="gtext" title={`${item.title} · ${item.scope}`}><b>{item.title}</b> <span className="why">· {item.threadTitle} · {item.triggers} 条触达 · {item.reason}</span></span>
        <span className="gacts"><button type="button" className="gbtn yes" disabled={busy} onClick={() => void act('approve', [item.decisionId])}>立项</button>
          <button type="button" className="gbtn no" disabled={busy} onClick={() => void act('reject', [item.decisionId])}>驳回</button></span>
      </div>)}
      {items.length === 0 && <div className="mini-row"><span className="grow">没有待立项的候选。评审通过的候选会先停在这里。</span></div>}
    </div>
    <div className="gate-foot">
      <button type="button" className="gbtn yes" disabled={busy || !items.length} onClick={() => void act('approve', items.map(item => item.decisionId))}>全部立项</button>
      <button type="button" className="gbtn no" disabled={busy || !items.length} onClick={() => void act('reject', items.map(item => item.decisionId))}>全部驳回</button>
      <span className="meta">待立项 {items.length} · 已驳回 {gate?.ticket.rejected ?? 0}</span>
    </div>
  </div>
}

const ASSIGN_STATE: Record<string, string> = { pending: '待开始', running: '运行中', ended: '已结束' }
const REPORT_STATE: Record<string, string> = { progress: '进行中', waiting: '等待输入', ready: '可交付', blocked: '受阻', failed: '失败', dropped: '已放弃' }

function DispatchBoard({ tickets }: { tickets?: ApiResponse<'GET tickets'> }) {
  const { call, navigate } = usePanel()
  const rows = tickets?.items ?? []
  const current = rows[0], next = rows[1]
  const { data: detail, error } = usePoll(() => current ? call('GET tickets/:id', { id: current.id }) : Promise.resolve(undefined), [current?.id])
  const assignments = detail?.assignments ?? []
  return <div className="board-panel" style={{ padding: 0 }}>
    <div className="ticket-strip">
      <span className="ticket-strip-head"><Dot state="ongoing" />正在派工</span>
      <div className="ticket-strip-cards">
        {current ? <button type="button" className="tk-card on" onClick={() => navigate({ page: 'tickets', id: current.id })}>
          <span className="tk-id">{current.id}</span>
          <span className="tk-main"><span className="tk-title">{current.title}</span></span><span className="mini-tag blue">当前执行</span></button>
          : <div className="tk-card empty">没有进行中的工单</div>}
        {next && <button type="button" className="tk-card tk-next" onClick={() => navigate({ page: 'tickets', id: next.id })}>
          <span className="tk-id">{next.id}</span>
          <span className="tk-main"><span className="tk-title">{next.title}</span></span><span className="mini-tag">下一条</span></button>}
      </div>
    </div>
    <div className="assign-wrap">
      <div className="assign-head">
        <span><Dot state={detail?.stage === 'working' ? 'ongoing' : detail?.stage === 'person' ? 'error' : 'done'} />执行链路</span>
        <span className="mono">{detail ? `${detail.stage}${'action' in detail && detail.action ? `/${detail.action}` : ''} · 输入 ${detail.inputs.length} · 订阅 ${detail.threads.length}` : ''}</span>
        {detail?.sessionId && <SessionButton sessionId={detail.sessionId} label="打开执行会话" />}
      </div>
      {error && <p className="dt-error" role="alert">{error.message}</p>}
      {!current ? <div className="assign-empty">提交要求并立项后，这里会展示它真实的派工链路。</div>
        : assignments.length === 0
          ? <div className="assign-empty">这张工单还没有派工记录。</div>
          : <div className="assign-lane">
            {assignments.map((assignment, index) => <div className={`assign-node is-${assignment.state}`} key={assignment.id}>
              <div className="assign-top"><span className="assign-no">{index + 1}</span><span className="assign-name">派工 {assignment.id.slice(-6)}</span>
                <span className={`mini-tag ${assignment.state === 'running' ? 'blue' : assignment.state === 'ended' ? 'green' : ''}`}>{ASSIGN_STATE[assignment.state] ?? assignment.state}</span></div>
              <div className="assign-meta">
                <span>开始 {assignment.startedAt?.slice(5, 16).replace('T', ' ') ?? '未开始'}</span>
                {assignment.endedAt && <span>结束 {assignment.endedAt.slice(5, 16).replace('T', ' ')}</span>}
                {assignment.endedReason && <span>原因 {assignment.endedReason}</span>}
              </div>
              {assignment.report ? <div className="assign-report">
                <span className={`mini-tag ${assignment.report.state === 'failed' || assignment.report.state === 'blocked' ? 'red' : assignment.report.state === 'ready' ? 'green' : 'amber'}`}>
                  {REPORT_STATE[assignment.report.state] ?? assignment.report.state}</span>
                <span className="grow">{assignment.report.summary || '（无摘要）'}</span></div>
                : <div className="assign-report empty">尚无回报</div>}
            </div>)}
          </div>}
      {detail && <div className="assign-foot">目录 {detail.directory || '未设置'} · 派工 {detail.assignments.length} 次 · 更新于 {detail.updatedAt.slice(0, 16).replace('T', ' ')}</div>}
    </div>
  </div>
}

function ReplyBoard({ overview }: { overview?: Overview }) {
  const replies = overview?.replies
  const recent = replies?.recent ?? []
  return <div className="board-panel">
    <div className="mini-grid">
      <MiniCard label="已发送" dot="done" value={replies?.sent ?? 0} meta="累计成功回执" fill={share(replies?.sent ?? 0, Math.max(1, (replies?.sent ?? 0) + (replies?.pending ?? 0)))} />
      <MiniCard label="等待中" dot="ongoing" value={replies?.pending ?? 0} meta="outbox 待投递" fill={share(replies?.pending ?? 0, Math.max(1, (replies?.sent ?? 0) + (replies?.pending ?? 0)))} />
      <MiniCard label="已丢弃" dot="error" value={replies?.dropped ?? 0} meta="24 小时" fill={share(replies?.dropped ?? 0, Math.max(1, (replies?.sent ?? 0) + (replies?.dropped ?? 0)))} />
    </div>
    <MiniList head="回执流水">{recent.map(item => <div className="mini-row" key={item.id}>
      <span className={`mini-tag ${item.status === 'sent' ? 'green' : item.status === 'dropped' ? 'red' : 'amber'}`}>{item.status === 'sent' ? '已发送' : item.status === 'dropped' ? '丢弃' : '等待'}</span>
      <span className="mono">{item.source}</span><span className="grow">{item.text}</span>
      {item.dropped && <span className="mono">{item.dropped}</span>}</div>)}
      {recent.length === 0 && <div className="mini-row"><span className="grow">还没有回执记录</span></div>}
    </MiniList>
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

/** One source drawer: real fields from the source kind, saved through its settings block. */
function SourceDrawer({ source, open, onToggle }: { source: SourceView; open: boolean; onToggle: () => void }) {
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const title = source.title.zh ?? source.title.en
  const fields = (source.fields ?? []).filter(field => !field.advanced)
  return <div className={`cfg drawer tone-${source.id === 'github' ? 'blue' : 'green'} ${open ? 'open' : ''}`}>
    <button type="button" className="drawer-head" aria-expanded={open} onClick={onToggle}>
      <span className="cfg-icon">{source.id === 'github' ? '◈' : '✈'}</span><span className="drawer-title">{title}</span><span className="drawer-chevron">▾</span>
    </button>
    <div className="cfg-body">
      <form onSubmit={event => { void draft.submit(event) }}>
        <label>启用 <input type="checkbox" checked={draft.value.enabled} onChange={event => draft.edit({ ...draft.value, enabled: event.target.checked })} /></label>
        {fields.map(field => <label key={field.key}>{field.label.zh ?? field.label.en}
          <SourceInput field={field} value={draft.value.config[field.key]} onChange={next => draft.edit({ ...draft.value, config: { ...draft.value.config, [field.key]: next } })} />
        </label>)}
        {fields.length === 0 && <div className="meta" style={{ fontSize: 11 }}>这个来源没有可编辑的基础字段。</div>}
        <button type="submit" className="path-browse" disabled={draft.busy}>{draft.busy ? '保存中…' : '保存来源'}</button>
      </form>
    </div>
  </div>
}
type SourceField = NonNullable<SourceView['fields']>[number]
function SourceInput({ field, value, onChange }: { field: SourceField; value: unknown; onChange: (next: unknown) => void }) {
  if (field.type === 'switch') return <input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked)} />
  if (field.type === 'select') return <select value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
    {field.options.map(option => <option key={option.value} value={option.value}>{option.label.zh ?? option.label.en}</option>)}
  </select>
  if (field.type === 'number') return <input type="number" min={field.min} max={field.max} value={String(value ?? '')}
    onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />
  if (field.type === 'rows' || field.type === 'fact') return <span className="mono" style={{ fontSize: 11 }}>在设置页编辑</span>
  return <input type="text" value={String(value ?? '')} placeholder={field.placeholder?.zh ?? field.placeholder?.en ?? ''}
    onChange={event => onChange(event.target.value)} />
}

/** Config area: real source drawers, workspace targets, model settings for both roles, and the two automation switches. */
function ConfigArea() {
  const { call, notify, navigate } = usePanel()
  const { settings, reload } = useSettings()
  const { blocks } = settings
  const [open, setOpen] = useState<string | null>(null)
  const [master, setMaster] = useState<ApiResponse<'GET master/model'>>()
  const evalDraft = useBlockDraft('eval', blocks.eval.value, blocks.eval.revision)
  const executorDraft = useBlockDraft('executor', blocks.executor.value, blocks.executor.revision)
  const evalAuto = blocks.eval.value.autoReview, ticketAuto = blocks.eval.value.autoTicket
  useEffect(() => { call('GET master/model').then(setMaster, () => setMaster(undefined)) }, [call, blocks.eval.revision])
  const setAuto = async (patch: { autoReview?: boolean; autoTicket?: boolean }) => {
    try {
      await call('PUT settings/:block', { block: 'eval', body: { value: { ...blocks.eval.value, ...patch }, revision: blocks.eval.revision } })
      await reload(); notify('已保存')
    } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
  }
  const applyModel = async () => {
    try {
      const applied = await call('POST master/model')
      setMaster(previous => previous ? { ...previous, current: applied.current } : previous)
      notify('已把配置模型应用到主 Session')
    } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
  }
  const restoreMaster = async () => {
    try {
      const result = await call('POST master/restore')
      setMaster(previous => previous ? { ...previous, current: result.current, archived: result.archived } : previous)
      notify(result.restored ? '已恢复主 Session，可以重新研判' : '主 Session 未归档')
    } catch (failure) { notify(failure instanceof Error ? failure.message : String(failure)) }
  }
  const route = (model: typeof blocks.eval.value.model) => model
    ? `${model.provider} / ${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}` : '继承默认'
  return <>
    <div className="config-entries">
      <button type="button" className="entry-card" onClick={() => navigate({ page: 'config', id: 'prompts' })}><span className="entry-icon">✎</span>
        <span className="entry-main"><strong>提示词配置</strong><small>团队行为用文字描述，按角色编辑评审/执行提示词</small></span><Icon name="chevron-right" size={18} /></button>
      <button type="button" className="entry-card" onClick={() => navigate({ page: 'config', id: 'auth' })}><span className="entry-icon">⚿</span>
        <span className="entry-main"><strong>规则与允许名单</strong><small>谁能发起工作 · 研判规则 · 准入表 · 接单模式</small></span><Icon name="chevron-right" size={18} /></button>
    </div>
    <div className="card config-grid">
      {settings.sources.filter(source => source.id !== 'workbench').map(source =>
        <SourceDrawer key={source.id} source={source} open={open === source.id} onToggle={() => setOpen(open === source.id ? null : source.id)} />)}
      <WorkspaceDrawer open={open === 'workspace'} onToggle={() => setOpen(open === 'workspace' ? null : 'workspace')} />
      <div className={`cfg cfg-model drawer tone-model ${open === 'model' ? 'open' : ''}`}>
        <button type="button" className="drawer-head" aria-expanded={open === 'model'} onClick={() => setOpen(open === 'model' ? null : 'model')}>
          <span className="cfg-icon">✦</span><span className="drawer-title">模型配置</span><span className="drawer-chevron">▾</span>
        </button>
        <div className="cfg-body">
          <div className="model-roles">
            <form className="model-role" onSubmit={event => { void evalDraft.submit(event) }}>
              <div className="model-role-head">评审模型</div>
              <ModelField id="wb3-eval-model" value={evalDraft.value.model} onChange={model => evalDraft.edit({ ...evalDraft.value, model })} />
              <div className="model-route">主 Session 当前：{master?.current ? route(master.current) : '继承默认'}</div>
              <div className="model-route">配置值：{route(blocks.eval.value.model)}</div>
              {master?.archived && <p className="dt-error" role="alert">主 Session 已被归档，DSH 不会为它调用模型。</p>}
              <div className="model-actions">
                <button type="submit" className="path-browse" disabled={evalDraft.busy}>保存评审模型</button>
                <button type="button" className="path-browse" onClick={() => void applyModel()}>应用到主 Session</button>
                {master?.archived && <button type="button" className="path-browse" onClick={() => void restoreMaster()}>恢复主 Session</button>}
              </div>
            </form>
            <form className="model-role" onSubmit={event => { void executorDraft.submit(event) }}>
              <div className="model-role-head">执行模型</div>
              <ModelField id="wb3-executor-model" value={executorDraft.value.model} onChange={model => executorDraft.edit({ ...executorDraft.value, model })} />
              <div className="model-route">新开的执行会话使用该模型</div>
              <div className="model-actions"><button type="submit" className="path-browse" disabled={executorDraft.busy}>保存执行模型</button></div>
            </form>
          </div>
        </div>
      </div>
    </div>
    <div className="card auto-card" style={{ marginTop: 14 }}>
      <div className="auto-info"><h3>⚡ 自动化开关</h3>
        <p>让评审与立项在无需人工逐条确认的情况下自动推进。</p>
        <p className="auto-warn"><span>⚠</span>开启自动后有可能产生必要的 token 消耗（自动评审/自动立项会调用模型研判候选）。</p></div>
      <div className="auto-actions">
        <button type="button" className={`auto-btn ${evalAuto ? 'on' : ''}`} onClick={() => void setAuto({ autoReview: !evalAuto })}>
          <span className="auto-btn-title">{evalAuto ? '关闭自动评审' : '开启自动评审'}</span><span className="auto-btn-state">{evalAuto ? '当前：已开启' : '当前：关闭 · 触达先到待分流'}</span></button>
        <button type="button" className={`auto-btn ${ticketAuto ? 'on' : ''}`} onClick={() => void setAuto({ autoTicket: !ticketAuto })}>
          <span className="auto-btn-title">{ticketAuto ? '关闭自动立项' : '开启自动立项'}</span><span className="auto-btn-state">{ticketAuto ? '当前：已开启' : '当前：关闭 · 通过后先到待立项'}</span></button>
      </div>
    </div>
  </>
}