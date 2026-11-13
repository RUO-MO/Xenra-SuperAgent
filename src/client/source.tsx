/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
import { useEffect, useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { DisclosureRow, Dot, Icon, InfoTip, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, SetupMessage, When } from './widgets.tsx'

function SourceCard({ source, status }: { source: SourceView; status: SourceStatusRow | undefined }) {
  const { t, call, navigate } = usePanel()
  const { running, setup } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // A Source's card opens by default: its fields are the reason to visit this page, and folding them behind a click would
  // hide the work of configuring a Source. Folding is for someone who has finished with it and wants the list shorter.
  const [open, setOpen] = useState(true)
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts xenra-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const advanced = source.fields.filter(spec => spec.advanced)
  // The card's head is its status line: the same dot, state word and per-part notes the status list used to show, so a
  // Source's condition sits directly above the fields that change it instead of in a separate list.
  const mark = sourceMark(t, status?.state ?? (source.installed ? 'starting' : 'off'))
  const notes = status && status.enabled && !problem && !setup?.problem
    ? status.health.filter(item => item.state === 'error' || item.state === 'paused') : []
  const stats = status?.stats
  return <form id={`dt-source-${source.id}`} className="dt-card dt-source" data-state={mark.dot} data-open={open || undefined}
    onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <Dot state={mark.dot} label={mark.label} />
        <div className="dt-row-main">
          <div className="dt-row-title">
            <button type="button" className="dt-source-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
              <span className="dt-card-title">{localized(t, source.title)}</span>
            </button>
            {description && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
          <div className="dt-row-meta">
            <span className="dt-status-text" data-state={mark.dot}>{mark.label}</span>
            {stats && stats.received > 0 && <LabelValue label={t('sourceReceivedLabel')} value={stats.received} />}
            {stats && stats.filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={stats.filtered} />}
            {stats?.lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(stats.lastAt, t('lang'))} />}
          </div>
        </div>
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: localized(t, source.title) })} />}
      </div>
      {/* The notes stay visible while the card is folded: they are why a person would open it. */}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
        {/* A paused part that is waiting for a person names the card that unblocks it, so the note leads somewhere instead
            of only stating what is missing. Anything else waits on something outside this page. */}
        {NEEDS_SETUP.has(item.code ?? '') && <> <button type="button" className="dt-textlink"
          onClick={() => { setOpen(true); navigate(settingsRoute('source', { source: source.id })) }}>{t('sourceOpenSettings')}</button></>}
      </p>)}
      {open && <>
        {problem && <div className="dt-row-buttons">
          <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
        </div>}
        {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
        {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
        {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')}
          open={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}>
          <div className="dt-disclosure-body">{advanced.map(field)}</div>
        </DisclosureRow>}
        {status && <SourceEvidence source={status} />}
      </>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

/** The Source group: one card per Source, its status line in the card's own head and its fields below it. */
export function SourceSettings({ focus }: { focus?: string }) {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { sources } = useSettings().settings
  const { data: statuses, error } = usePoll(() => call('GET sources'), [])
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  // A deployment-level problem halts every Source, so it shows once at the top rather than on each card.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!statuses} />
    {sources.map(source => <SourceCard key={source.id} source={source}
      status={statuses?.find(status => status.id === source.id)} />)}
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'tickets', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'threads', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
/**
 * Health codes whose state is unblocked by a field on the Source's own card. Their note carries a link to that card,
 * because "the bot's lark-cli is not set" without a way to set it is a dead end; a code such as `setupPending` or
 * `pollFailures` waits on something outside the page and gets no link.
 */
const NEEDS_SETUP: ReadonlySet<string> = new Set(['feishuCliUnset', 'feishuBotMissing'])

/** What a Source filtered out, and which of its replies were dropped: evidence, folded away inside the card it belongs to. */
function SourceEvidence({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const [filteredOpen, setFilteredOpen] = useState(false)
  return <>
    {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
      onToggle={() => setFilteredOpen(!filteredOpen)}>
      <div className="dt-disclosure-body">
        <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
          className="dt-row-main">
          <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
            || t('empty')}</div>
          <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
        </div></li>)}</ul>
      </div>
    </DisclosureRow>}
    {source.dropped.length > 0 && <DroppedReplies items={source.dropped} />}
  </>
}

