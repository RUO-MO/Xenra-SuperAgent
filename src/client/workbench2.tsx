/**
 * Unified workbench: a todo board over the existing request console, with temporary processing pages.
 * It reuses the existing request console, lifecycle tree, prompt editor and policy editor so the
 * domain behaviour stays in one place; this module only adds the human-facing routing and the
 * "needs you" entry cards driven by the live overview and ticket APIs.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { ApiResponse, DecisionRow, Problem, TicketRow } from './api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import type { TodoKind, ConfigPage } from './route.ts'
import { Hint, Section, SessionButton } from './widgets.tsx'
import { EvalSettings } from './eval.tsx'
import { PromptsPage } from './prompts.tsx'
import { ModelField, SettingsProvider, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { SaveBar } from './draft.tsx'

type Overview = ApiResponse<'GET overview'>

/** The four kinds of work that can be waiting on a person, derived from live tickets and overview problems. */
function classify(overview: Overview | undefined) {
  const person = overview?.person ?? []
  const of = (action: string) => person.filter(ticket => ticket.stage === 'person' && ticket.action === action)
  const problems = overview?.problems ?? []
  return {
    answer: of('answer'),
    review: of('review'),
    blocked: [...of('blocked'), ...of('failed')],
    system: problems,
  }
}

/** A card that shows only the count, with a short label; opening it navigates to the processing page. */
function EntryCard({ kind, icon, label, count, danger }: { kind: TodoKind; icon: string; label: string; count: number; danger?: boolean }) {
  const { navigate } = usePanel()
  return <button type="button" className={`dt-todo-card dt-todo-${kind}`} data-todo={kind}
    onClick={() => navigate({ page: 'processing', id: kind })}>
    <span className="dt-todo-icon" aria-hidden="true">{icon}</span>
    <span className="dt-todo-main"><span className="dt-todo-label">{label}</span>
      <span className="dt-todo-num" data-danger={danger || undefined}>{count}</span></span>
    <Icon name="chevron-right" size={18} />
  </button>
}

/** Human-facing todo board above the request console. */
export function TodoBoard() {
  const { t, call } = usePanel()
  const { data } = usePoll(() => call('GET overview'), [])
  const groups = useMemo(() => classify(data), [data])
  return <Section title={t('todoTitle')} hint={t('todoHint')}>
    <div className="dt-todo-grid">
      <EntryCard kind="answer" icon="?" label={t('todo.answer')} count={groups.answer.length} />
      <EntryCard kind="review" icon="✓" label={t('todo.review')} count={groups.review.length} />
      <EntryCard kind="blocked" icon="!" label={t('todo.blocked')} count={groups.blocked.length} danger />
      <EntryCard kind="system" icon="⚙" label={t('todo.system')} count={groups.system.length} danger={groups.system.length > 0} />
    </div>
  </Section>
}
/** Reusable detail row for a ticket-based todo item. */
function TicketDetail({ ticket, children }: { ticket: TicketRow | undefined; children?: ReactNode }) {
  const { t } = usePanel()
  if (!ticket) return <Hint>{t('none')}</Hint>
  return <>
    <h3 className="dt-todo-detail-title">{ticket.id} · {ticket.title}</h3>
    {ticket.note && <p className={ticket.note.error ? 'dt-error' : 'dt-hint'}>{ticket.note.text}</p>}
    {children}
  </>
}

/** The processing page for one todo kind; driven by live data and navigable between items. */
export function TodoProcessPage({ kind }: { kind: TodoKind }) {
  const { t, navigate, call } = usePanel()
  const [selected, setSelected] = useState(0)
  const { data, reload } = usePoll(() => call('GET overview'), [])
  const groups = useMemo(() => classify(data), [data])
  const tickets = kind === 'answer' ? groups.answer : kind === 'review' ? groups.review : kind === 'blocked' ? groups.blocked : []
  const item = tickets[Math.min(selected, Math.max(0, tickets.length - 1))]
  const retry = useAction((id: string) => call('POST tickets/:id/retry', { id }), { reload })
  return <div className="dt-todo-process">
    <div className="dt-todo-process-head">
      <button type="button" className="dt-btn dt-btn-outline dt-btn-sm" onClick={() => navigate({ page: 'workbench' })}>‹ {t('todoBack')}</button>
      <span className="dt-todo-crumb">{t(`processing.${kind}`)}</span>
      {item?.sessionId && <span className="dt-todo-session"><SessionButton sessionId={item.sessionId} label={t('todoOpenSession')} /></span>}
    </div>
    {kind === 'system'
      ? <SystemIssues problems={groups.system} />
      : <div className="dt-todo-columns">
        <div className="dt-todo-list">
          <div className="dt-todo-list-head">{t(`todo.${kind}`)} · {tickets.length}</div>
          {tickets.map((ticket, index) => <button type="button" key={ticket.id}
            className={`dt-todo-list-item ${index === selected ? 'on' : ''}`} onClick={() => setSelected(index)}>
            <span className={`dot ${ticket.note?.error ? 'error' : 'ongoing'}`} />{ticket.id} · {ticket.title.slice(0, 12)}
          </button>)}
        </div>
        <div className="dt-todo-detail">
          {item ? <TicketDetail ticket={item}>
            {kind === 'answer' && <AnswerGuide sessionId={item.sessionId} />}
            {kind === 'review' && <div className="dt-todo-form">
              <Hint>{t('todoReviewHint')}</Hint>
              {item.reply?.url && <a className="dt-inline-link" href={item.reply.url} target="_blank" rel="noopener noreferrer">{t('answerIn',
                { source: item.reply.source })}</a>}
            </div>}
            {kind === 'blocked' && <BlockedActions sessionId={item.sessionId} canRetry={item.actions.retry}
              retrying={retry.busy} onRetry={() => { void retry.run(item.id) }} />}
          </TicketDetail> : <Hint>{t('none')}</Hint>}
        </div>
      </div>}
  </div>
}
/** Answering a question happens inside the executor Session (the human's message becomes a Ticket Input there). */
function AnswerGuide({ sessionId }: { sessionId: string }) {
  const { t } = usePanel()
  return <div className="dt-todo-form">
    <Hint>{t('todoAnswerGuide')}</Hint>
    {sessionId ? <SessionButton sessionId={sessionId} label={t('todoAnswerInSession')} />
      : <Hint>{t('todoNoSession')}</Hint>}
  </div>
}
/** A blocked/failed ticket can be retried through the real endpoint; complex triage stays in its Session. */
function BlockedActions({ sessionId, canRetry, retrying, onRetry }: { sessionId: string; canRetry: boolean; retrying: boolean; onRetry: () => void }) {
  const { t } = usePanel()
  return <div className="dt-todo-form">
    <Hint>{t('todoBlockedHint')}</Hint>
    <div className="dt-todo-buttons">
      {sessionId && <SessionButton sessionId={sessionId} label={t('todoOpenSession')} />}
      {canRetry && <Button variant="primary" disabled={retrying} onClick={onRetry}>{t('retry')}</Button>}
    </div>
  </div>
}
function SystemIssues({ problems }: { problems: Problem[] }) {
  const { t } = usePanel()
  const groups = useMemo(() => {
    const out = new Map<SystemGroup, Problem[]>()
    for (const problem of problems) {
      const group = systemGroup(problem)
      out.set(group, [...(out.get(group) ?? []), problem])
    }
    return out
  }, [problems])
  return <div className="dt-todo-system">
    <div className="dt-todo-group"><h4>{t('todoSystemHealth')}</h4>
      <div className="dt-todo-health">{([...groups.keys()] as SystemGroup[]).map(group =>
        <Tag key={group} tone="danger">{t(`todoSystemGroup.${group}`)}</Tag>)}</div></div>
    {([...groups.entries()] as [SystemGroup, Problem[]][]).map(([group, items]) => <div className="dt-todo-group" key={group}>
      <h4>{t(`todoSystemGroup.${group}`)}</h4>
      {items.map((problem, index) => <p className="dt-todo-issue" key={index}>{problem.kind}</p>)}
    </div>)}
  </div>
}
type SystemGroup = 'runtime-error' | 'outgoing' | 'eval' | 'config'
function systemGroup(problem: Problem): SystemGroup {
  switch (problem.kind) {
    case 'source-error': case 'setup': case 'runtime-error': case 'no-source': case 'no-allowed': case 'executor-paused': return 'runtime-error'
    case 'outgoing': return 'outgoing'
    case 'eval-overdue': case 'eval-unavailable': return 'eval'
    default: return 'config'
  }
}

/** Config-page entry shown above the settings drawers. */
export function ConfigEntries() {
  const { t, navigate } = usePanel()
  return <div className="dt-config-entries">
    <button type="button" className="dt-config-entry" onClick={() => navigate({ page: 'config', id: 'models' })}>
      <span className="dt-config-entry-icon">◈</span>
      <span className="dt-config-entry-main"><strong>{t('config.models')}</strong><small>{t('todoEntryModels')}</small></span>
      <Icon name="chevron-right" size={18} />
    </button>
    <button type="button" className="dt-config-entry" onClick={() => navigate({ page: 'config', id: 'prompts' })}>
      <span className="dt-config-entry-icon">✎</span>
      <span className="dt-config-entry-main"><strong>{t('config.prompts')}</strong><small>{t('todoEntryPrompts')}</small></span>
      <Icon name="chevron-right" size={18} />
    </button>
    <button type="button" className="dt-config-entry" onClick={() => navigate({ page: 'config', id: 'auth' })}>
      <span className="dt-config-entry-icon">⚿</span>
      <span className="dt-config-entry-main"><strong>{t('config.auth')}</strong><small>{t('todoEntryAuth')}</small></span>
      <Icon name="chevron-right" size={18} />
    </button>
    <button type="button" className="dt-config-entry" onClick={() => navigate({ page: 'config', id: 'review-gate' })}>
      <span className="dt-config-entry-icon">◑</span>
      <span className="dt-config-entry-main"><strong>{t('config.review-gate')}</strong><small>{t('todoEntryReviewGate')}</small></span>
      <Icon name="chevron-right" size={18} />
    </button>
    <button type="button" className="dt-config-entry" onClick={() => navigate({ page: 'config', id: 'ticket-gate' })}>
      <span className="dt-config-entry-icon">◐</span>
      <span className="dt-config-entry-main"><strong>{t('config.ticket-gate')}</strong><small>{t('todoEntryTicketGate')}</small></span>
      <Icon name="chevron-right" size={18} />
    </button>
  </div>
}

/** One floating source drawer: real fields from the source kind, saved through its settings block. */
function SourceDrawer({ source }: { source: ReturnType<typeof useSettings>['settings']['sources'][number] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const title = source.title.zh ?? source.title.en
  return <div className={`dt-src-drawer ${open ? 'open' : ''}`}>
    <button type="button" className="dt-src-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={`dt-src-icon dt-src-${source.id}`}>{source.id === 'github' ? '◈' : source.id === 'feishu' ? '✈' : '▣'}</span>
      <b>{title}</b><span className="dt-src-chevron">▾</span>
    </button>
    {open && <form className="dt-src-body" onSubmit={event => { void draft.submit(event) }}>
      <div className="dt-switch-row"><div className="dt-field-head">{t('sourceEnabledShort')}</div>
        <input type="checkbox" checked={draft.value.enabled} onChange={event => draft.edit({ ...draft.value, enabled: event.target.checked })} /></div>
      {(source.fields ?? []).filter(field => !field.advanced).map(field => <SourceField key={field.key} field={field}
        value={draft.value.config[field.key]} saved={source.value.config[field.key]} fact={source.facts?.[field.key]}
        labels={source.labels ?? {}} onChange={next => draft.edit({ ...draft.value, config: { ...draft.value.config, [field.key]: next } })} />)}
      <Button variant="primary" size="sm" type="submit" disabled={draft.busy}>{t('save')}</Button>
    </form>}
  </div>
}
/** Floating drawers for all installed Sources, shown on the workbench. */
export function SourceDrawers() {
  const sources = useSettings().settings.sources
  return <div className="dt-src-grid">{sources.map(source => <SourceDrawer key={source.id} source={source} />)}</div>
}

/** Automation switches on the workbench: both map to the real eval accept mode. */
export function AutomationCard() {
  const { t, call, notify } = usePanel()
  const { data: settings, reload } = usePoll(() => call('GET settings'), [])
  const mode = settings?.blocks.eval.value.mode ?? 'off'
  const evalAuto = mode !== 'off'
  const ticketAuto = mode === 'auto'
  const setMode = useAction(async (next: 'off' | 'observe' | 'auto') => {
    const block = settings!.blocks.eval
    await call('PUT settings/:block', { block: 'eval', body: { value: { ...block.value, mode: next }, revision: block.revision } })
    notify(t('saved'))
  }, { reload })
  const toggle = (which: 'eval' | 'ticket') => {
    if (which === 'eval') void setMode.run(evalAuto ? 'off' : 'observe')
    else void setMode.run(ticketAuto ? 'observe' : 'auto')
  }
  return <div className="dt-auto-card">
    <div className="dt-auto-info"><h3>{t('autoTitle')}</h3>
      <p>{t('autoIntro')}</p>
      <p className="dt-auto-warn">{t('autoWarn')}</p></div>
    <div className="dt-auto-actions">
      <button type="button" className={`dt-auto-btn ${evalAuto ? 'on' : ''}`} onClick={() => toggle('eval')}>
        <b>{evalAuto ? t('autoEvalOff') : t('autoEvalOn')}</b><small>{evalAuto ? t('autoOn') : t('autoOff')}</small></button>
      <button type="button" className={`dt-auto-btn ${ticketAuto ? 'on' : ''}`} onClick={() => toggle('ticket')}>
        <b>{ticketAuto ? t('autoTicketOff') : t('autoTicketOn')}</b><small>{ticketAuto ? t('autoOn') : t('autoOff')}</small></button>
    </div>
  </div>
}

/**
 * Assessment gate. When auto-assessment is off, an inferred candidate that was only recorded as
 * "would accept" can be reassessed from here; when on, the gate is idle and simply reports so.
 * All actions use real endpoints: reassess a Trigger, or dismiss an unavailable Decision.
 */
function ReviewGatePage() {
  const { t, call } = usePanel()
  const { data: settings, reload: reloadSettings } = usePoll(() => call('GET settings'), [])
  const mode = settings?.blocks.eval.value.mode ?? 'off'
  const auto = mode !== 'off'
  const { data: decisions, reload } = usePoll(() => call('GET decisions', { query: { kind: 'ignore', limit: 50 } }), [])
  const candidates = (decisions?.items ?? []).filter(item => item.outcome === 'wouldAccept' || item.kind === 'unavailable')
  const requeue = useAction((id: string) => call('POST triggers/:id/requeue', { id }), { reload })
  const dismiss = useAction((id: string) => call('POST decisions/:id/dismiss', { id }), { reload })
  const toggle = useAction(async () => {
    const block = settings!.blocks.eval
    await call('PUT settings/:block', { block: 'eval', body: { value: { ...block.value, mode: auto ? 'off' : 'observe' }, revision: block.revision } })
    await reloadSettings()
  })
  return <div className="dt-form">
    <div className="dt-banner">{t('gateAutoEvalHint')}</div>
    <div className="dt-row-meta"><span className={auto ? 'dt-todo-ok' : 'dt-hint'}>{auto ? t('gateAutoOn') : t('gateAutoOff')}</span></div>
    {!auto && <Button variant="outline" disabled={toggle.busy} onClick={() => { void toggle.run() }}>{t('gateToggleAuto')}</Button>}
    {auto && <Hint>{t('gateAutoOn')}</Hint>}
    <div className="dt-list">{candidates.map(item => <GateDecisionRow key={item.id} item={item}
      requeue={() => { void requeue.run(item.triggerIds[0] ?? '') }} dismiss={() => { void dismiss.run(item.id) }} />)}</div>
    {candidates.length === 0 && <Hint>{t('none')}</Hint>}
  </div>
}
function GateDecisionRow({ item, requeue, dismiss }: { item: DecisionRow; requeue: () => void; dismiss: () => void }) {
  const { t } = usePanel()
  return <div className="dt-row"><div className="dt-row-main">
    <div className="dt-row-title">{item.preview || item.thread}</div>
    <div className="dt-row-meta"><span>{item.kind}</span><span>{item.reason.map(reason => reason.code).join(', ')}</span></div>
  </div><div className="dt-row-actions">
    {item.triggerIds[0] && <Button variant="outline" size="sm" onClick={requeue}>{t('gateRequeue')}</Button>}
    {item.kind === 'unavailable' && <Button variant="ghost" size="sm" onClick={dismiss}>{t('gateDismiss')}</Button>}
  </div></div>
}
/**
 * Ticket gate. `eval.mode` decides whether a matched rule opens a ticket automatically (auto) or
 * is only recorded (observe/off). This page reports that state, lets a person switch it, and lists
 * open tickets with their real retry/stop actions. There is no separate manual "approve ticket"
 * endpoint because ticket creation is an Engine decision, not a UI step.
 */
function TicketGatePage() {
  const { t, call } = usePanel()
  const { data: settings, reload: reloadSettings } = usePoll(() => call('GET settings'), [])
  const mode = settings?.blocks.eval.value.mode ?? 'off'
  const auto = mode === 'auto'
  const { data: tickets, reload } = usePoll(() => call('GET tickets', { query: { state: 'open' } }), [])
  const retry = useAction((id: string) => call('POST tickets/:id/retry', { id }), { reload })
  const stop = useAction((id: string) => call('POST tickets/:id/stop', { id }), { reload })
  const toggle = useAction(async () => {
    const block = settings!.blocks.eval
    await call('PUT settings/:block', { block: 'eval', body: { value: { ...block.value, mode: auto ? 'observe' : 'auto' }, revision: block.revision } })
    await reloadSettings()
  })
  return <div className="dt-form">
    <div className="dt-banner">{t('gateAutoTicketHint')}</div>
    <div className="dt-row-meta"><span className={auto ? 'dt-todo-ok' : 'dt-hint'}>{auto ? t('gateAutoOn') : t('gateAutoOff')}</span></div>
    <Button variant="outline" disabled={toggle.busy} onClick={() => { void toggle.run() }}>{t('gateToggleAuto')}</Button>
    <div className="dt-list">{(tickets?.items ?? []).map(ticket => <div className="dt-row" key={ticket.id}>
      <div className="dt-row-main"><div className="dt-row-title">{ticket.id} · {ticket.title}</div>
        <div className="dt-row-meta"><span>{ticket.stage}</span></div></div>
      <div className="dt-row-actions">
        {ticket.actions.retry && <Button variant="outline" size="sm" onClick={() => { void retry.run(ticket.id) }}>{t('gateRetry')}</Button>}
        {ticket.actions.stop && <Button variant="ghost" size="sm" onClick={() => { void stop.run(ticket.id) }}>{t('gateStop')}</Button>}
      </div>
    </div>)}</div>
    {(tickets?.items.length ?? 0) === 0 && <Hint>{t('none')}</Hint>}
  </div>
}

/** Real model configuration for the assessor and executor roles, backed by the eval/executor settings blocks. */
function ModelsPage() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const evalDraft = useBlockDraft('eval', blocks.eval.value, blocks.eval.revision)
  const executorDraft = useBlockDraft('executor', blocks.executor.value, blocks.executor.revision,
    value => ({ ...value, maxWorkers: value.maxWorkers, blockedCommands: value.blockedCommands }))
  return <div className="dt-form">
    <Hint>{t('modelsHint')}</Hint>
    <form className="dt-form dt-block" onSubmit={event => { void evalDraft.submit(event) }}>
      <h2 className="dt-block-title">{t('modelsAssessor')}</h2>
      <ModelField id="dt-workbench-eval-model" value={evalDraft.value.model} onChange={model => evalDraft.edit({ ...evalDraft.value, model })} />
      <SaveBar {...evalDraft} onDiscard={evalDraft.discard} />
    </form>
    <form className="dt-form dt-block" onSubmit={event => { void executorDraft.submit(event) }}>
      <h2 className="dt-block-title">{t('modelsExecutor')}</h2>
      <ModelField id="dt-workbench-executor-model" value={executorDraft.value.model} onChange={model => executorDraft.edit({ ...executorDraft.value, model })} />
      <SaveBar {...executorDraft} onDiscard={executorDraft.discard} />
    </form>
  </div>
}

/** Wrapper for a config page, with a back button. */
export function ConfigPageFrame({ page }: { page: ConfigPage }) {
  const { t, navigate } = usePanel()
  const [role, setRole] = useState<'orchestrator' | 'worker'>('orchestrator')
  return <div className="dt-config-page">
    <div className="dt-todo-process-head">
      <button type="button" className="dt-btn dt-btn-outline dt-btn-sm" onClick={() => navigate({ page: 'workbench' })}>‹ {t('todoBack')}</button>
      <span className="dt-todo-crumb">{t(`config.${page}`)}</span>
    </div>
    {page === 'prompts' && <div className="dt-role-tabs">
      <button type="button" className={role === 'orchestrator' ? 'on' : ''} onClick={() => setRole('orchestrator')}>{t('promptRoleAssessor')}</button>
      <button type="button" className={role === 'worker' ? 'on' : ''} onClick={() => setRole('worker')}>{t('promptRoleWorker')}</button>
    </div>}
    <SettingsProvider>
      {page === 'models' ? <ModelsPage />
        : page === 'prompts' ? <PromptsPage role={role} />
          : page === 'auth' ? <EvalSettings />
            : page === 'review-gate' ? <ReviewGatePage /> : <TicketGatePage />}
    </SettingsProvider>
  </div>
}
