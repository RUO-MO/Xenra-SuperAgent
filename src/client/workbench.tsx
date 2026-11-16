/**
 * Workbench: the console where a person writes a request.
 *
 * This is an entry, not a work target. A person picks which registered target the request acts on — a GitHub repository or a
 * local folder — and the server turns the text into an ordinary Trigger. Authorization, assessment and the reply channel
 * therefore stay exactly as they are for every other source.
 *
 * The two kinds are shown as different things, never as one list of strings: a repository target is a place work becomes a
 * pull request, and a folder target is a place work lands as files. Confusing them is how a request ends up somewhere the
 * person did not mean.
 */
import { useState, type FormEvent } from 'react'
import { usePoll } from './api.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { Hint, LoadState, PageHead, Section } from './widgets.tsx'

/** A stable client-generated id makes a double submit the same request, which the server deduplicates. */
function requestId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** One registered target: a repository or a local folder, drawn so the two are never mistaken for each other. */
function TargetChoice({ target, watched, selected, onSelect }: {
  target: { id: string; kind: 'repository' | 'directory'; name: string; repository?: string; root: string }
  watched: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { t } = usePanel()
  const repository = target.kind === 'repository'
  return <button type="button" className="dt-target" data-selected={selected || undefined} onClick={onSelect}
    aria-pressed={selected}>
    <span className="dt-target-head">
      <Icon name={repository ? 'pull' : 'folder'} size={16} />
      <span className="dt-target-name">{target.name || target.repository || target.root}</span>
      <Tag tone={repository ? 'neutral' : 'outline'}>{t(repository ? 'workbenchKindRepository' : 'workbenchKindDirectory')}</Tag>
      {watched && <Tag tone="quiet">{t('workbenchWatched')}</Tag>}
    </span>
    <span className="dt-target-detail dt-mono">{repository ? target.repository : target.root}</span>
  </button>
}

export function WorkbenchPage() {
  const { t, call, notify, navigate } = usePanel()
  const { state, error, reload } = usePanelData()
  const [text, setText] = useState('')
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ id: string; text: string; triggerId: string; target: string; at: string }[]>([])
  const [failure, setFailure] = useState<string>()
  // The target the person picked; undefined follows the selected target the server reports.
  const [picked, setPicked] = useState<string>()

  const { data: targets } = usePoll(() => call('GET targets'), [])
  const watched = targets?.watched ?? ''
  const chosen = picked ?? targets?.selected ?? ''
  const active = targets?.items.find(item => item.id === chosen)

  const repository = state?.setup.accounts?.repository
  const configured = !!state && !state.setup.problem && !!repository

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() || busy) return
    const id = requestId()
    setBusy(true); setFailure(undefined)
    void call('POST workbench/requests', { body: { id, actor: 'operator', text: text.trim(),
      ...(scope.trim() ? { scope: scope.trim() } : {}), ...(active ? { target: active.id } : {}) } })
      .then(result => {
        setSent(previous => [{ id, text: text.trim(), triggerId: result.triggerId, target: result.target.id,
          at: new Date().toISOString() }, ...previous].slice(0, 8))
        setText(''); setScope('')
        notify(t(result.accepted ? 'workbenchSubmitted' : 'workbenchNotAdmitted'))
        void reload()
      })
      .catch((problem: unknown) => setFailure(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => setBusy(false))
  }

  return <div className="dt-form">
    <PageHead title={t('tab.workbench')} />
    <LoadState error={error} loading={!state} />
    {state && <>
      {!configured && <Hint>{t('workbenchSetupRequired')}</Hint>}
      <Section title={t('workbenchTarget')} hint={t('workbenchTargetHint')}>
        {targets && targets.items.length > 0
          ? <div className="dt-targets">{targets.items.map(target => <TargetChoice key={target.id} target={target}
            watched={target.kind === 'repository' && target.repository === watched}
            selected={target.id === chosen} onSelect={() => setPicked(target.id)} />)}</div>
          // Before anything is registered the request still works: it acts on the watched repository.
          : <div className="dt-workbench-target">
            <Icon name="pull" size={16} />
            <span className="dt-mono dt-workbench-repo">{repository || t('empty')}</span>
            {configured && <Tag tone="quiet">{t('workbenchSharedTarget')}</Tag>}
          </div>}
        <Hint>{t('workbenchWatchedHint')}</Hint>
      </Section>

      <Section title={t('workbenchRequest')} hint={t('workbenchRequestHint')}>
        <form onSubmit={submit} className="dt-workbench-form">
          <label className="dt-field">
            <span className="dt-field-head">{t('workbenchRequestLabel')}</span>
            <textarea className="dt-input dt-workbench-text" value={text} disabled={!configured || busy} rows={5}
              aria-label={t('workbenchRequestLabel')} placeholder={t('workbenchRequestPlaceholder')}
              onChange={event => setText(event.target.value)} />
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{t('workbenchScopeLabel')}</span>
            <Input value={scope} disabled={!configured || busy} spellCheck={false} aria-label={t('workbenchScopeLabel')}
              placeholder={t('workbenchScopePlaceholder')} onChange={event => setScope(event.target.value)} />
            <small className="dt-hint">{t('workbenchScopeHint')}</small>
          </label>
          {failure && <p className="dt-error" role="alert">{failure}</p>}
          <div className="dt-row-buttons">
            <Button variant="primary" type="submit" disabled={!configured || busy || !text.trim()}>{t('workbenchSubmit')}</Button>
            <Button variant="ghost" onClick={() => navigate({ page: 'tickets', query: {} })}>{t('workbenchViewTickets')}</Button>
          </div>
        </form>
      </Section>

      {sent.length > 0 && <Section title={t('workbenchRecent')}>
        <ul className="dt-list">{sent.map(item => <li key={item.id} className="dt-row">
          <div className="dt-row-main">
            <div className="dt-row-title dt-line">{item.text}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{t('workbenchFromConsole')}</Tag>
              <span className="dt-mono">{item.target}</span><span className="dt-mono">{item.triggerId}</span></div>
          </div>
        </li>)}</ul>
        <Hint>{t('workbenchRecentHint')}</Hint>
      </Section>}
    </>}
  </div>
}
