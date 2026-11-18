/**
 * Workbench: one focused place to ask for work.
 *
 * The whole page answers a single question — "what should the agent do, and where?" Targets are a compact chip row that can
 * be added and switched in place, so the console never sends a person into Settings just to name a repository or folder.
 * A repository target becomes a pull request; a local folder is edited in place; only one repository is watched and that
 * stays a separate deployment fact. Everything below the request is collapsed into a short "this session" list.
 */
import { useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { Hint, PageHead, Section } from './widgets.tsx'
import { WorkbenchFlow } from './lifecycle.tsx'

type TargetView = ApiResponse<'GET targets'>

/** A stable client-generated id makes a double submit the same request, which the server deduplicates. */
function requestId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** One target chip: repository and folder are different shapes, and the watched/default facts are small tags. */
function TargetChip({ target, watched, selected, onSelect, onRemove }: {
  target: TargetView['items'][number]; watched: boolean; selected: boolean; onSelect: () => void; onRemove: () => void
}) {
  const { t } = usePanel()
  const repository = target.kind === 'repository'
  const label = target.name || (repository ? target.repository : target.root)
  const detail = repository ? target.repository : target.root
  return <span className="dt-wb-chip-wrap">
    <button type="button" className="dt-wb-chip" data-selected={selected || undefined} aria-pressed={selected} onClick={onSelect}
      title={detail}>
      <Icon name={repository ? 'pull' : 'folder'} size={15} />
      <span className="dt-wb-chip-name">{label}</span>
      {watched && <Tag tone="quiet">{t('workbenchWatched')}</Tag>}
    </button>
    <button type="button" className="dt-wb-chip-remove" aria-label={`${t('targetsRemove')}: ${label}`} title={t('targetsRemove')}
      onClick={onRemove}><Icon name="close" size={12} /></button>
  </span>
}

/** The inline "add a target" control: one value field and a kind toggle, no separate form section. */
function AddTarget({ onAdded }: { onAdded: (view: TargetView) => void }) {
  const { t, call, notify } = usePanel()
  const [kind, setKind] = useState<'repository' | 'directory'>('repository')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    const text = value.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const result = kind === 'repository'
        ? await call('POST targets', { body: { kind, repository: text } })
        : await call('POST targets', { body: { kind, root: text } })
      onAdded({ ...result, watched: '' })
      setValue('')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }
  return <span className="dt-target-add">
    <button type="button" className={kind === 'repository' ? 'dt-kind-pill-active' : 'dt-kind-pill'}
      onClick={() => setKind('repository')} title={t('workbenchKindRepository')} aria-label={t('workbenchKindRepository')}
      aria-pressed={kind === 'repository'}><Icon name="pull" size={14} /></button>
    <button type="button" className={kind === 'directory' ? 'dt-kind-pill-active' : 'dt-kind-pill'}
      onClick={() => setKind('directory')} title={t('workbenchKindDirectory')} aria-label={t('workbenchKindDirectory')}
      aria-pressed={kind === 'directory'}><Icon name="folder" size={14} /></button>
    <Input className="dt-mono dt-target-add-input" value={value} disabled={busy}
      placeholder={kind === 'repository' ? 'owner/name' : t('targetsRootPlaceholder')}
      onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add() } }} />
    <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} disabled={busy || !value.trim()}
      onClick={() => { void add() }}>{t('targetsAdd')}</Button>
  </span>
}

/** The chain a request walks through, as live counts from the last 24 hours: received → trigger → assessed → admitted. */
function PipelineFlow() {
  const { t, call } = usePanel()
  const { data } = usePoll(() => call('GET overview'), [])
  if (!data) return null
  const flow = data.flow
  const stages = [
    { label: t('flowReceivedLabel'), value: flow.received },
    { label: t('term.trigger'), value: flow.triggers },
    { label: t('flowJudgedLabel'), value: flow.judged },
    { label: t('flowAcceptedLabel'), value: flow.accepted },
  ]
  return <div className="dt-wb-flow">
    <div className="dt-wb-flow-head"><span>{t('lastDay')}</span><span className="dt-hint">{t('term.ticket')}</span></div>
    <ol className="dt-wb-chain">
      {stages.map((stage, index) => <li key={stage.label} className="dt-wb-chain-step">
        {index > 0 && <span className="dt-wb-chain-link" aria-hidden="true">›</span>}
        <span className="dt-wb-chain-node">
          <span className="dt-wb-chain-value">{stage.value}</span>
          <span className="dt-wb-chain-label">{stage.label}</span>
        </span>
      </li>)}
    </ol>
    {(flow.evaluating > 0 || flow.filtered > 0 || flow.dropped > 0) && <div className="dt-wb-flow-notes">
      {flow.evaluating > 0 && <span className="dt-wb-flow-live"><Icon name="running" size={13} />{flow.evaluating} {t('threadFilter.evaluating')}</span>}
      {flow.filtered > 0 && <span>{flow.filtered} {t('flowFilteredLabel')}</span>}
      {flow.dropped > 0 && <span>{flow.dropped} {t('flowDroppedLabel')}</span>}
    </div>}
  </div>
}

export function WorkbenchPage() {
  const { t, call, notify } = usePanel()
  const { state, error, reload } = usePanelData()
  const [text, setText] = useState('')
  const [scope, setScope] = useState('')
  const [showScope, setShowScope] = useState(false)
  const [actor, setActor] = useState('operator')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ id: string; text: string; triggerId: string; target: string; at: string }[]>([])
  const [failure, setFailure] = useState<string>()
  const [picked, setPicked] = useState<string>()

  const { data: targets, reload: reloadTargets } = usePoll(() => call('GET targets'), [])
  const watched = targets?.watched ?? ''
  const chosen = picked ?? targets?.selected ?? ''
  const active = targets?.items.find(item => item.id === chosen)

  const repository = state?.setup.accounts?.repository
  const configured = !!state && !state.setup.problem && !!repository

  const select = async (id: string) => {
    setPicked(id)
    try { await call('PUT targets/selected', { body: { id } }) } catch { /* local choice still applies for this session */ }
  }
  const remove = async (id: string) => {
    try { await call('DELETE targets/:id', { id }); if (picked === id) setPicked(undefined); await reloadTargets() }
    catch (error) { notify(error instanceof Error ? error.message : String(error)) }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() || busy) return
    const id = requestId()
    setBusy(true); setFailure(undefined)
    void call('POST workbench/requests', { body: { id, actor: actor.trim() || 'operator', text: text.trim(),
      ...(scope.trim() ? { scope: scope.trim() } : {}), ...(active ? { target: active.id } : {}) } })
      .then(result => {
        setSent(previous => [{ id, text: text.trim(), triggerId: result.triggerId, target: result.target.id,
          at: new Date().toISOString() }, ...previous].slice(0, 8))
        setText(''); setScope('')
        notify(t(result.accepted ? 'todoComposeQueued' : 'workbenchNotAdmitted'))
        void reload()
      })
      .catch((problem: unknown) => setFailure(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => setBusy(false))
  }

  return <div className="dt-form dt-workbench">
    <PageHead title={t('tab.workbench')} />
    <LoadHead error={error} loading={!state} />
    {state && <>
      {!configured && <Hint>{t('workbenchSetupRequired')}</Hint>}

      {/* Targets as a single chip row; adding or switching stays on this page. */}
      <div className="dt-wb-targets">
        <div className="dt-wb-label"><span>{t('workbenchTarget')}</span><span className="dt-hint">{t('workbenchTargetHint')}</span></div>
        <div className="dt-chips">
          {targets?.items.map(target => <TargetChip key={target.id} target={target}
            watched={target.kind === 'repository' && target.repository === watched}
            selected={target.id === chosen} onSelect={() => { void select(target.id) }}
            onRemove={() => { void remove(target.id) }} />)}
          {(!targets || targets.items.length === 0) && configured && <span className="dt-chip-empty">
            <Icon name="pull" size={15} /><span className="dt-mono">{repository}</span><Tag tone="quiet">{t('workbenchSharedTarget')}</Tag>
          </span>}
          <AddTarget onAdded={view => { setPicked(view.selected); void reloadTargets() }} />
        </div>
      </div>

      {/* The chain a submitted request walks through, with live counts from the last 24 hours. */}
      <PipelineFlow />

      {/* Recent requests as an expandable lifecycle tree. */}
      <WorkbenchFlow />

      {/* One request box; scope is an optional disclosure, not a second always-visible field. */}
      <form onSubmit={submit} className="dt-wb-compose">
        <textarea className="dt-wb-input" value={text} disabled={!configured || busy} rows={6}
          aria-label={t('workbenchRequestLabel')} placeholder={t('workbenchRequestPlaceholder')}
          onChange={event => setText(event.target.value)} />
        {failure && <p className="dt-error" role="alert">{failure}</p>}
        {/* The optional scope sits above the actions, so revealing it keeps focus order ahead of Submit. */}
        {showScope && <Input id="dt-wb-scope" className="dt-mono" value={scope} disabled={!configured || busy}
          aria-label={t('workbenchScopeLabel')} placeholder={t('workbenchScopePlaceholder')}
          onChange={event => setScope(event.target.value)} />}
        <Input id="dt-wb-actor" className="dt-mono" value={actor} disabled={!configured || busy}
          aria-label={t('workbenchActorLabel')} onChange={event => setActor(event.target.value)} />
        <div className="dt-wb-actions">
          <button type="button" className="dt-textlink" aria-expanded={showScope} aria-controls="dt-wb-scope"
            onClick={() => setShowScope(!showScope)}>{t('workbenchScopeLabel')}</button>
          <span className="dt-wb-space" />
          <Button variant="primary" type="submit" disabled={!configured || busy || !text.trim()}>{t('workbenchSubmit')}</Button>
        </div>
      </form>

      {sent.length > 0 && <Section title={t('workbenchRecent')} hint={t('workbenchRecentHint')}>
        <ul className="dt-list">{sent.map(item => <li key={item.id} className="dt-row">
          <div className="dt-row-main"><div className="dt-row-title dt-line">{item.text}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{t('workbenchFromConsole')}</Tag><span className="dt-mono">{item.target}</span></div>
          </div></li>)}</ul>
      </Section>}
    </>}
  </div>
}

/** A compact error/loading line that does not take over the page. */
function LoadHead({ error, loading }: { error?: Error; loading: boolean }) {
  const { t } = usePanel()
  if (error) return <p className="dt-error" role="alert">{error.message}</p>
  return loading ? <Hint>{t('loading')}</Hint> : null
}
