/**
 * Whether a newer version of this plugin exists, shown for both ways it can be installed, with a staged reload progress.
 *
 * A linked checkout and a GitHub install are judged differently — one by its own upstream branch, the other by the commit the
 * remote now has — so the panel says which kind this is and what the answer means, rather than showing one
 * "update available" that would be wrong for one of them.
 *
 * Reloading starts in the background and returns a request id; the actual stages (checking → removing/reloading → installing
 * → done) are polled from the host, which writes them to a file that survives the fiber replacement a reinstall causes.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, StateDot, Tag, type DotState } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { T } from './text.ts'
import { ConfirmButton, Hint, Section } from './widgets.tsx'

type Progress = NonNullable<ApiResponse<'GET update/progress'>>
type Stage = Progress['stage']

const STAGE_LABEL: Record<Stage, string> = {
  checking: 'updateStage.checking', reloading: 'updateStage.reloading', removing: 'updateStage.removing',
  installing: 'updateStage.installing', done: 'updateStage.done', failed: 'updateStage.failed',
}
/** A stage is finished once a later step in the run's plan has been reached (or the run ended). */
function stageState(stage: Stage, current: Stage, done: boolean): DotState {
  if (current === 'failed') return stage === current ? 'error' : 'idle'
  if (done) return 'done'
  if (stage === current) return 'ongoing'
  return 'idle'
}

/** The staged progress strip: one labelled dot per planned step, plus the live message. */
type StageTranslator = (key: string) => string
function ReloadProgressView({ progress, t }: { progress: Progress; t: StageTranslator }) {
  const done = progress.stage === 'done' || progress.stage === 'failed'
  const steps = progress.steps.includes(progress.stage) || done ? progress.steps : [...progress.steps, progress.stage]
  const currentIndex = steps.indexOf(progress.stage)
  return <div className="dt-reload-progress" role="status" aria-live="polite">
    <ol className="dt-reload-steps">
      {steps.map((stage, index) => {
        const state = stageState(stage, progress.stage, done && progress.stage === 'done')
        const reached = done ? true : index <= currentIndex
        return <li key={stage} className="dt-reload-step" data-state={state} data-reached={reached || undefined}>
          <StateDot state={state} />
          <span>{t(STAGE_LABEL[stage])}</span>
        </li>
      })}
    </ol>
    <p className="dt-reload-message">{progress.message}{progress.restartRequired ? ` · ${t('updateRestartRequired')}` : ''}</p>
    {progress.detail && <p className="dt-update-detail dt-mono">{progress.detail}</p>}
  </div>
}

export function UpdateStatus() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET update'), [])
  const [requestId, setRequestId] = useState<string>()
  // Poll only while a reload we started is running; stop once it reaches a terminal stage.
  const { data: progress } = usePoll(() => requestId ? call('GET update/progress') : Promise.resolve(undefined), [requestId], 800)
  useEffect(() => {
    if (progress && progress.requestId === requestId && (progress.stage === 'done' || progress.stage === 'failed')) {
      setRequestId(undefined)
      void reload()
    }
  }, [progress, requestId, reload])
  const start = useCallback(async () => {
    const started = await call('POST update/reload')
    setRequestId(started.requestId)
  }, [call])

  if (error) return <Section title={t('updateTitle')}><Hint>{t('updateUnavailable')}</Hint></Section>

  const kind = data?.kind
  const state = data?.status ?? 'unavailable'
  const tone: 'quiet' | 'warning' | 'danger' = state === 'behind' || state === 'diverged' ? 'warning'
    : state === 'dirty' || state === 'unavailable' ? 'danger' : 'quiet'
  const label = t(`update.${state}` as Parameters<T>[0], { behind: String(data?.behind ?? 0), ahead: String(data?.ahead ?? 0) })
  const showCommits = !!data?.local && !!data?.remote && (state === 'behind' || state === 'ahead' || state === 'diverged')
  const activeProgress = requestId && progress && progress.requestId === requestId
    && progress.stage !== 'done' && progress.stage !== 'failed' ? progress : undefined
  const busy = !!activeProgress
  return <Section title={t('updateTitle')} hint={t('updateKindHint')}>
    <div className="dt-update">
      <div className="dt-update-head">
        <Icon name={kind === 'git' ? 'pull' : 'folder'} size={16} />
        <span className="dt-update-kind">{t(kind === 'git' ? 'updateKindGit' : 'updateKindLinked')}</span>
        <Tag tone={tone}>{label}</Tag>
        <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />}
          disabled={busy} onClick={() => { void reload() }}>{t('updateCheck')}</Button>
        {(state === 'behind' || state === 'diverged' || kind === 'linked' || state === 'ahead') &&
          <ConfirmButton variant="outline" icon="pull" label={t('updateReload')} title={t('updateReload')}
            message={t(kind === 'git' ? 'updateReloadGitConfirm' : 'updateReloadLinkedConfirm')}
            onConfirm={() => start().catch(failure => notify(failure instanceof Error ? failure.message : String(failure)))} />}
      </div>
      {activeProgress && <ReloadProgressView progress={activeProgress} t={t as unknown as StageTranslator} />}
      {data && <>
        <div className="dt-update-detail dt-mono">{data.spec}</div>
        <div className="dt-update-detail dt-mono">{data.directory}</div>
        {showCommits && <div className="dt-update-detail">
          {t('updateCommits', { local: data.local ?? '', remote: data.remote ?? '' })}
          {data.branch && <span> · {data.branch}</span>}
        </div>}
        {data.problem && <p className="dt-hint dt-clamp">{data.problem}</p>}
        {data.instruction && <Hint>{data.instruction}</Hint>}
        {data.version && <Hint>{t('updateVersion', { version: data.version })}</Hint>}
      </>}
    </div>
  </Section>
}
