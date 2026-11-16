/**
 * Whether a newer version of this plugin exists, shown for both ways it can be installed.
 *
 * A linked checkout and a GitHub install are judged differently — one by its own upstream branch, the other by the commit the
 * remote now has — so the panel says which kind this is and what the answer means, rather than showing one
 * "update available" that would be wrong for one of them.
 *
 * Nothing here upgrades: the check reports, and the instruction names the exact command, because replacing code under a
 * running harness is a decision a person makes.
 */
import { usePoll } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint, Section } from './widgets.tsx'

export function UpdateStatus() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET update'), [])
  if (error) return <Section title={t('updateTitle')}><Hint>{t('updateUnavailable')}</Hint></Section>
  if (!data) return <Section title={t('updateTitle')}><Hint>{t('loading')}</Hint></Section>

  const kind = data.kind
  const state = data.status
  const tone: 'quiet' | 'warning' | 'danger' = state === 'behind' || state === 'diverged' ? 'warning'
    : state === 'dirty' || state === 'unavailable' ? 'danger' : 'quiet'
  // The words come from the status, never from a bare version comparison: a linked checkout has no published version.
  const label = t(`update.${state}`, { behind: String(data.behind ?? 0), ahead: String(data.ahead ?? 0) })
  const showCommits = !!data.local && !!data.remote && (state === 'behind' || state === 'ahead' || state === 'diverged')
  return <Section title={t('updateTitle')} hint={t('updateKindHint')}>
    <div className="dt-update">
      <div className="dt-update-head">
        <Icon name={kind === 'git' ? 'pull' : 'folder'} size={16} />
        <span className="dt-update-kind">{t(kind === 'git' ? 'updateKindGit' : 'updateKindLinked')}</span>
        <Tag tone={tone}>{label}</Tag>
        <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />}
          onClick={() => { void reload() }}>{t('updateCheck')}</Button>
      </div>
      <div className="dt-update-detail dt-mono">{data.spec}</div>
      <div className="dt-update-detail dt-mono">{data.directory}</div>
      {showCommits && <div className="dt-update-detail">
        {t('updateCommits', { local: data.local ?? '', remote: data.remote ?? '' })}
        {data.branch && <span> · {data.branch}</span>}
      </div>}
      {data.problem && <p className="dt-hint dt-clamp">{data.problem}</p>}
      {data.instruction && <Hint>{data.instruction}</Hint>}
      {data.version && <Hint>{t('updateVersion', { version: data.version })}</Hint>}
    </div>
  </Section>
}
