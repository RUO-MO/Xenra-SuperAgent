/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { GitRepair } from './git-repair.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { setupText, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'

export type DeploymentForm = ConfigPageForm | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
/** The one editable path: the state directory decides where the database, locks and shims live. */
const STATE_DIR = 'stateDir'
/** Every editable machine key, the directory first. */
const MACHINE_FIELDS = ['stateDir', ...MACHINE_LIMITS] as const
type MachineKey = typeof MACHINE_FIELDS[number]
type Limits = Record<MachineKey, string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_FIELDS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits
/** An absolute POSIX path or a Windows drive path, the form the Host accepts for `stateDir`. */
const absolutePath = (value: string): boolean => /^(?:\/|[A-Za-z]:[\\/])/.test(value)

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      // The state directory is a path, so a value that is not absolute is refused before it reaches the Host.
      const directory = value[STATE_DIR].trim()
      if (directory && !absolutePath(directory)) throw new Error(t('deploymentStateDirInvalid'))
      // A limit is a number the Host parses; the state directory is the path itself, and an emptied one drops back to the
      // Host's default rather than to an empty string.
      const ops: Op[] = []
      for (const key of MACHINE_FIELDS) {
        const next = value[key].trim(), previous = (base[key] ?? '').trim()
        if (next === previous) continue
        if (!next) { ops.push({ op: 'unset', path: [key] }); continue }
        ops.push(key === STATE_DIR ? { op: 'set', path: [key], value: next } : { op: 'set', path: [key], value: Number(next) })
      }
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      // A new state directory remounts the plugin, so the page will stop being served for a moment; say so instead of
      // letting the reader take the reconnecting panel for a failure.
      notify(directory && directory !== (base[STATE_DIR] ?? '').trim() ? t('deploymentStateDirRestart') : t('saved'))
      return { revision: revision + 1, restarting: directory !== (base[STATE_DIR] ?? '').trim() }
    } })
  const accounts = setup.accounts
  // `unavailable` indicates `xenra-superagent` is still starting or the namespace is not served to this client.
  const readOnlyHint = !form ? t('deploymentNoForms')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Hint>{t('deploymentIntro')}</Hint>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      <Section title={t('deploymentMachine')}>
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        {/* The git the workers run, with the repair this machine offers, sits with the other machine-level facts. */}
        <GitRepair />
        <Field label={t('deploymentStateDir')} hint={t('deploymentStateDirHint')}>
          <Input type="text" value={draft.value[STATE_DIR]} disabled={!editable} spellCheck={false}
            placeholder={t('deploymentStateDirPlaceholder')}
            onChange={event => draft.edit({ ...draft.value, [STATE_DIR]: event.target.value })} />
        </Field>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}
