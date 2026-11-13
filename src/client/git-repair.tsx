/**
 * The git repair dialog.
 *
 * A worker environment needs git 2.32 or later, and when it does not have one the overview says so. Saying only that leaves
 * a person to work out what they run and how to change it, so this offers the machine's own upgrade command. It does not
 * decide for them: the dialog names the command, says what running it changes and that it is the operator's own system being
 * changed, and offers "do it myself" beside it for anyone who would rather use their own terminal.
 */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'

export function GitRepair() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET git'), [], 30_000)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string>()
  if (error) return <p className="dt-error" role="alert">{error.message}</p>
  if (!data) return <p className="dt-hint">{t('loading')}</p>
  // A git the workers can use needs no repair, so this reports nothing at all rather than adding a row to say so.
  if (!data.outdated) return null
  const run = async () => {
    setBusy(true); setOutput(undefined)
    try {
      const result = await call('POST git/upgrade')
      setOutput(result.output)
      // A command that succeeded can still leave an old git on PATH; the version is what decides, not the exit status.
      notify(result.ok && !result.outdated ? t('gitUpgraded', { version: result.version ?? '' })
        : result.ok ? t('gitStillOld', { version: result.version ?? '' }) : t('gitUpgradeFailed'))
      await reload()
    } catch (failure) {
      setOutput(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  return <div className="dt-git-repair">
    <p className="dt-error" role="status">{t('gitTooOldNow', { version: data.version ?? t('gitUnknown'), minimum: data.minimum })}</p>
    {!data.plan ? <Hint>{t('gitNoPlan', { minimum: data.minimum })}</Hint> : <>
      {!open ? <div className="dt-row-buttons">
        <Button variant="outline" onClick={() => setOpen(true)}>{t('gitUpgradeOffer')}</Button>
      </div> : <div className="dt-git-plan">
        {/* What running it changes, before it runs: the command, the mechanism, and that it is this machine's git. */}
        <Hint>{t('gitUpgradeRisk', { by: data.plan.by })}</Hint>
        <pre className="dt-pre dt-mono">{data.plan.command}</pre>
        <div className="dt-row-buttons">
          <Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void run() }}>{busy ? t('gitUpgrading') : t('gitUpgradeConfirm')}</Button>
        </div>
        <Hint>{t('gitUpgradeManual')}</Hint>
      </div>}
    </>}
    {output && <pre className="dt-pre dt-mono dt-clamp">{output}</pre>}
  </div>
}
