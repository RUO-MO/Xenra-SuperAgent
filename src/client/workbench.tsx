/**
 * Workbench: the console where a person writes a request for the configured project.
 *
 * This is an entry, not a work target. The request acts on the deployment's repository — the same one GitHub Issues and
 * Feishu messages act on — and the server turns it into an ordinary Trigger, so authorization, assessment and the reply
 * channel stay exactly as they are for every other source.
 */
import { useState, type FormEvent } from 'react'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { Hint, LoadState, PageHead, Section } from './widgets.tsx'

/** A stable client-generated id makes a double submit the same request, which the server deduplicates. */
function requestId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function WorkbenchPage() {
  const { t, call, notify, navigate } = usePanel()
  const { state, error, reload } = usePanelData()
  const [text, setText] = useState('')
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ id: string; text: string; triggerId: string; at: string }[]>([])
  const [failure, setFailure] = useState<string>()

  const repository = state?.setup.accounts?.repository
  const configured = !!state && !state.setup.problem && !!repository

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() || busy) return
    const id = requestId()
    setBusy(true); setFailure(undefined)
    void call('POST workbench/requests', { body: { id, actor: 'operator', text: text.trim(),
      ...(scope.trim() ? { scope: scope.trim() } : {}) } })
      .then(result => {
        setSent(previous => [{ id, text: text.trim(), triggerId: result.triggerId, at: new Date().toISOString() }, ...previous].slice(0, 8))
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
        <div className="dt-workbench-target">
          <Icon name="pull" size={16} />
          <span className="dt-mono dt-workbench-repo">{repository || t('empty')}</span>
          {configured && <Tag tone="neutral">{t('workbenchSharedTarget')}</Tag>}
        </div>
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
            <div className="dt-row-meta"><Tag tone="neutral">{t('workbenchFromConsole')}</Tag><span className="dt-mono">{item.triggerId}</span></div>
          </div>
        </li>)}</ul>
        <Hint>{t('workbenchRecentHint')}</Hint>
      </Section>}
    </>}
  </div>
}
