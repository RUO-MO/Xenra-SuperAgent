/**
 * The first-run guide. A new installation has nothing configured, and the settings pages assume an operator who already knows
 * which Source holds which field. This walks the decisions an installation actually needs — what to watch and which account
 * acts (one step, because the Source validates them together), who may ask, and where work happens.
 *
 * It is only a front end: every step writes the same settings block the Settings page writes, through the same API, so a
 * person can leave the guide and finish on the settings pages without losing what they saved here. A refusal is shown beside
 * the field that caused it rather than as a toast, because the guide is the only thing on screen and a toast would vanish
 * before a person could read it.
 */
import { useState, type ReactNode } from 'react'
import { usePoll, type SourceView } from './api.ts'
import { Button, Input } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { CheckSetupButton, Hint, LabelValue, SetupMessage } from './widgets.tsx'

/** The decisions, in the order they build on each other. `feishu` is offered after the GitHub pair but may be skipped. */
export const WIZARD_STEPS = ['github', 'feishu', 'people', 'workspace'] as const
export type WizardStep = typeof WIZARD_STEPS[number]

/** How many GitHub accounts may ask the agent for work, which is where a new installation usually stops. */
export function allowedCount(policy: unknown): number {
  const sources = (policy as { sources?: Record<string, { allowed?: unknown[] }> } | undefined)?.sources
  return sources?.github?.allowed?.length ?? 0
}

/**
 * Health codes that leave the installation unable to run at all, which the guide therefore carries.
 *
 * These are the machine problems no amount of answering the guide's questions can work around: with a git too old to read
 * the worker's configuration, or a state directory another program owns, the agent cannot act. A problem outside this set —
 * a Source that is merely paused, a reply that keeps failing — is reported where it happens and does not take the panel over.
 */
const BLOCKING: ReadonlySet<string> = new Set(['gitTooOld', 'foreignFile', 'environmentFailed'])

/**
 * Whether the installation still needs the guide.
 *
 * It opens when the decisions it asks about are unanswered, and it carries a machine problem that makes the installation
 * unable to run — a person answering four questions on a machine that cannot execute them is answering for nothing.
 * Once the decisions are answered and the machine can run, the guide stays away even if something else is wrong: that
 * problem belongs on Home and on its own settings page, where fixing it does not hide the panel.
 */
export function needsGuide(state: { setup: { problem: { place: string; code: string } | null }
  settings?: { blocks: { policy: { value: unknown } } } } | undefined, github: SourceView | undefined): boolean {
  if (!state) return false
  const { problem } = state.setup
  // A Feishu problem pauses only that Source, and is reported on its card; it must never take the panel over.
  if (problem && problem.place === 'feishu') return false
  if (!github) return false
  const unanswered = (github.value.config.repository as string | undefined)?.trim() === ''
    || (github.value.config.cli as string | undefined)?.trim() === ''
    // The block carries its value beside its revision; the allow list is inside that value.
    || (state.settings ? allowedCount(state.settings.blocks.policy.value) === 0 : false)
  return unanswered || (problem !== null && BLOCKING.has(problem.code))
}

/**
 * Whether the Feishu Source still wants configuring: it exists, it is on, and its card has no bot CLI yet.
 *
 * This never brings the guide back on its own. The guide is for an installation that cannot work at all, and a missing
 * Feishu bot does not stop GitHub work; the Feishu card says the same thing on its own page. The step is offered inside
 * a guide that is already running for another reason, and may be skipped there.
 */
export function feishuWanted(feishu: SourceView | undefined): boolean {
  if (!feishu || !feishu.installed) return false
  return String((feishu.value.config.cli as string | undefined) ?? '').trim() === ''
}

/** The saved values a step starts from, so an interrupted guide resumes where it stopped. */
const repositoryOf = (source: SourceView | undefined): string => String((source?.value.config.repository as string | undefined) ?? '')
const cliOf = (source: SourceView | undefined): string => String((source?.value.config.cli as string | undefined) ?? '')
/** A repository name as the GitHub Source accepts it: two path segments, one slash. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function Step({ index, current, title, children }: { index: number; current: number; title: string; children: ReactNode }) {
  return <li className="dt-wizard-step" data-current={index === current || undefined} data-done={index < current || undefined}>
    <div className="dt-wizard-head"><span className="dt-wizard-number">{index + 1}</span><span className="dt-wizard-title">{title}</span></div>
    {children}
  </li>
}

export function SetupGuide({ onDone }: { onDone: () => void }) {
  const { t, call, navigate, notify } = usePanel()
  const { reload, setup } = usePanelData()
  const { data: settings, error: readError, reload: reloadSettings } = usePoll(() => call('GET settings'), [])
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  // The refusal of the last save, shown under the step that produced it.
  const [refusal, setRefusal] = useState<string>()
  const [repository, setRepository] = useState('')
  const [cli, setCli] = useState('')
  const [botCli, setBotCli] = useState('')
  const [account, setAccount] = useState('')
  const [directory, setDirectory] = useState('')
  // Seed each field once from what is saved, so an interrupted guide resumes without overwriting what a person typed.
  const [seeded, setSeeded] = useState(false)
  if (settings && !seeded) {
    const github = settings.sources.find(source => source.id === 'github')
    const feishu = settings.sources.find(source => source.id === 'feishu')
    setRepository(repositoryOf(github))
    setCli(cliOf(github))
    setBotCli(String((feishu?.value.config.cli as string | undefined) ?? ''))
    setDirectory(String(settings.blocks.executor.value.directory ?? ''))
    setSeeded(true)
  }
  if (readError) return <p className="dt-error" role="alert">{readError.message}</p>
  if (!settings) return <p className="dt-hint">{t('loading')}</p>
  const github = settings.sources.find(source => source.id === 'github')
  const feishu = settings.sources.find(source => source.id === 'feishu')
  const policy = settings.blocks.policy.value
  const executor = settings.blocks.executor.value
  const sourceValue = (patch: Record<string, unknown>) => ({ enabled: true,
    config: { ...(github?.value.config ?? {}), ...patch } })
  const feishuValue = (patch: Record<string, unknown>) => ({ enabled: true,
    config: { ...(feishu?.value.config ?? {}), ...patch } })
  /** The Policy's GitHub part, with the account added to the list of people who may ask. */
  const policyWith = (id: string): unknown => {
    const parts = policy.sources as Record<string, { allowed?: { id: string }[] }>
    const part = parts.github ?? { allowed: [] }
    const allowed = part.allowed ?? []
    if (allowed.some(entry => entry.id === id)) return policy
    return { ...policy, sources: { ...parts, github: { ...part, allowed: [...allowed, { id }] } } }
  }
  /**
   * Save one block and, when it takes, move on. The refusal replaces the step's own message, so the person reads it where
   * they were rather than in a toast that outlives nothing.
   * @param block - the settings block the step writes.
   * @param value - the whole block value.
   * @param revision - the revision the form was read at.
   * @param next - the step to open, or `WIZARD_STEPS.length` to finish.
   */
  const commit = async (block: string, value: unknown, revision: number, next: number) => {
    setBusy(true); setRefusal(undefined)
    try {
      const result = await call('PUT settings/:block', { block, body: { value, revision } })
      // A block save that restarts the plugin answers with `restarting`; the panel reconnects on its own.
      if (result.restarting) notify(t('savedRestarting'))
      await reload(); await reloadSettings()
      if (next >= WIZARD_STEPS.length) onDone()
      else setStep(next)
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  /** A step's back link, which also drops the message of the step being left. */
  const back = (next: number) => { setRefusal(undefined); setStep(next) }
  const refusalLine = refusal && <p className="dt-error" role="alert">{refusal}</p>
  // The first step needs both values, because the Source checks them as one unit: a save with either missing fails, and
  // the check runs the CLI against GitHub. Saying so up front is cheaper than a refusal after a round trip.
  const githubReady = REPOSITORY.test(repository.trim()) && cli.trim() !== ''
  // The machine's own problem, if any: the guide shows it rather than letting a person answer every step for nothing.
  const machineProblem = setup?.problem ?? undefined
  return <div className="dt-wizard">
    <div className="dt-wizard-intro">
      <h2 className="dt-wizard-heading">{t('wizardTitle')}</h2>
      <p className="dt-hint">{t('wizardIntro')}</p>
    </div>
    {/* A problem with this machine blocks every step below it, so it comes first, with the way to fix or check it. */}
    {machineProblem && <div className="dt-wizard-blocker">
      <p className="dt-error" role="alert"><SetupMessage problem={machineProblem} lead /></p>
      <div className="dt-row-buttons">
        <CheckSetupButton />
        <button type="button" className="dt-textlink"
          onClick={() => { onDone(); navigate(settingsRoute('deployment')) }}>{t('wizardOpenDeployment')}</button>
      </div>
    </div>}
    <ol className="dt-wizard-steps">
      <Step index={0} current={step} title={t('wizardStep.github')}>
        {step === 0 && <>
          <Hint>{t('wizardGithubHint')}</Hint>
          <Field label={t('wizardRepositoryLabel')}>
            <Input value={repository} placeholder={t('wizardRepositoryPlaceholder')} spellCheck={false}
              onChange={event => setRepository(event.target.value)} />
          </Field>
          <Field label={t('wizardAccountLabel')} hint={t('wizardAccountHint')}>
            <Input value={cli} placeholder={t('wizardAccountPlaceholder')} spellCheck={false}
              onChange={event => setCli(event.target.value)} />
          </Field>
          {refusalLine}
          <div className="dt-row-buttons">
            <Button variant="primary" disabled={busy || !githubReady} onClick={() => { void commit('source:github',
              sourceValue({ repository: repository.trim(), cli: cli.trim() }), github?.revision ?? 0, 1) }}>{t('next')}</Button>
          </div>
        </>}
      </Step>
      <Step index={1} current={step} title={t('wizardStep.feishu')}>
        {step === 1 && <>
          <Hint>{t('wizardFeishuHint')}</Hint>
          {/* The row is on by default, so this step only fills its card. A profile that leaves the row off has no card, and
              skipping leaves Feishu idle rather than broken. */}
          {!feishu || !feishu.installed
            ? <Hint>{t('wizardFeishuAbsent')}</Hint>
            : <Field label={t('wizardFeishuLabel')} hint={t('wizardFeishuLabelHint')}>
              <Input value={botCli} placeholder={t('wizardFeishuPlaceholder')} spellCheck={false}
                onChange={event => setBotCli(event.target.value)} />
            </Field>}
          {refusalLine}
          <div className="dt-row-buttons">
            <Button variant="ghost" onClick={() => back(0)}>{t('back')}</Button>
            <Button variant="primary" disabled={busy || !botCli.trim() || !feishu?.installed}
              onClick={() => { void commit('source:feishu', feishuValue({ cli: botCli.trim() }), feishu?.revision ?? 0, 2) }}>
              {t('next')}</Button>
            {/* Skipping is a real choice here, not a dismissal of the guide: GitHub work does not need a bot. */}
            <button type="button" className="dt-textlink" onClick={() => back(2)}>{t('wizardFeishuSkip')}</button>
          </div>
        </>}
      </Step>
      <Step index={2} current={step} title={t('wizardStep.people')}>
        {step === 2 && <>
          <Hint>{t('wizardPeopleHint')}</Hint>
          <LabelValue label={t('wizardRepositoryLabel')} value={repositoryOf(github) || repository} />
          <Field label={t('wizardPeopleLabel')}>
            <Input value={account} placeholder={t('wizardPeoplePlaceholder')} spellCheck={false}
              onChange={event => setAccount(event.target.value)} />
          </Field>
          {refusalLine}
          <div className="dt-row-buttons">
            <Button variant="ghost" onClick={() => back(1)}>{t('back')}</Button>
            <Button variant="primary" disabled={busy || !account.trim()} onClick={() => { void commit('policy',
              policyWith(account.trim()), settings.blocks.policy.revision, 3) }}>{t('next')}</Button>
          </div>
        </>}
      </Step>
      <Step index={3} current={step} title={t('wizardStep.workspace')}>
        {step === 3 && <>
          <Hint>{t('wizardWorkspaceHint')}</Hint>
          <Field label={t('wizardWorkspaceLabel')}>
            <Input value={directory} placeholder={t('wizardWorkspacePlaceholder')} spellCheck={false}
              onChange={event => setDirectory(event.target.value)} />
          </Field>
          {refusalLine}
          <div className="dt-row-buttons">
            <Button variant="ghost" onClick={() => back(2)}>{t('back')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void commit('executor',
              { ...executor, directory: directory.trim() }, settings.blocks.executor.revision, WIZARD_STEPS.length) }}>{t('finish')}</Button>
          </div>
        </>}
      </Step>
    </ol>
    <div className="dt-wizard-skip">
      <button type="button" className="dt-textlink" onClick={onDone}>{t('wizardSkip')}</button>
      {/* Leaving for the settings pages dismisses the guide too: it covers the whole body, so navigating underneath it
          would change the route without changing what the person sees. */}
      <button type="button" className="dt-textlink" onClick={() => { onDone(); navigate(settingsRoute('source')) }}>{t('wizardOpenSettings')}</button>
    </div>
    <p className="dt-hint" aria-live="polite">{t(`wizardStep.${WIZARD_STEPS[step]!}`)}</p>
  </div>
}

/** A labelled field inside a step; the settings page's own `Field` is not reachable from here without its provider. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="dt-wizard-field">
    <span className="dt-field-head">{label}</span>
    {children}
    {hint && <small className="dt-hint">{hint}</small>}
  </label>
}
