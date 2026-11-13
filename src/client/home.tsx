/**
 * Home: the one page a person needs. It answers, in order, what needs them now, whether the agent is working normally, and —
 * only when something is wrong — how to fix it. Counts and diagnostics that describe the machinery rather than a decision a
 * person has to make are folded into a line at the bottom, so the page stays short.
 */
import type { ReactNode } from 'react'
import { usePoll, type Problem, type StateView } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LoadState, Section, SetupMessage } from './widgets.tsx'

/** One thing that needs a person, with the shortest path to dealing with it. */
function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      settingsRoute(problem.place === 'deployment' ? 'deployment' : 'source', problem.place === 'deployment' ? {} : { source: problem.place }),
      t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), <Hint>{t('problemNoSourceHint')}</Hint>, settingsRoute('source'), undefined,
      go(t('actionOpenSources'), settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), <Hint>{t('problemNoAllowedHint')}</Hint>, settingsRoute('eval'), undefined,
      go(t('actionAddAllowed'), settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'tickets', query: {} }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), settingsRoute('source', { source: problem.source.id }), t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'threads',
      id: problem.thread.key, query: {} })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'threads', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), settingsRoute('source', { source: problem.outgoing.channel.source }))
  }
}

/** One line describing whether work is running, in words rather than in a count of slots. */
function statusLine(state: StateView | undefined, person: number): { tone: 'done' | 'ongoing' | 'warning' | 'error' | 'idle'; text: string } {
  if (!state) return { tone: 'idle', text: '' }
  if (state.setup.problem) return { tone: 'warning', text: 'waiting-setup' }
  if (state.paused) return { tone: 'warning', text: 'paused' }
  return person ? { tone: 'ongoing', text: 'person' } : { tone: 'done', text: 'ready' }
}

export function HomePage() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  const { state } = usePanelData()
  if (!data) return <LoadState error={error} loading />
  const status = statusLine(state, data.person.length)
  const needsYou = data.person.length > 0
  const problems = data.problems.length
  const summary = status.text === 'waiting-setup' ? t('homeStatusSetup')
    : status.text === 'paused' ? t('homeStatusPaused')
    : status.text === 'person' ? t('homeStatusPerson', { count: data.person.length })
    : t('homeStatusReady')
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (label: string, route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{label}</button>
  return <>
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-home-status" data-state={status.tone}>
      <span className="dt-status-text" data-state={status.tone}>{summary}</span>
    </div>
    {problems > 0 && <Section title={t('problems')} count={problems}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('pendingTickets')} count={data.person.length}
      action={data.person.length ? more(t('seeAllTickets'), { page: 'tickets', query: {} }) : undefined}>
      {needsYou ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {/* The machinery, in one line: an operator opens it only when they want the numbers. */}
    <details className="dt-home-more">
      <summary>{t('executor')}</summary>
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`, { page: 'tickets', query: { filter: 'open' } })}
        {stat(t('queuedLabel'), data.executor.queued, { page: 'tickets', query: { filter: 'open' } })}
        {stat(t('idleLabel'), data.executor.idle, { page: 'tickets', query: { filter: 'idle' } })}
      </div>}
      <div className="dt-advanced-links">
        <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'threads', query: {} })}>{t('tab.threads')}</button>
        <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'evals', query: {} })}>{t('tab.evals')}</button>
      </div>
    </details>
  </>
}
