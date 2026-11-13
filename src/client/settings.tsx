/** Settings tab shell routing between the everyday groups and the diagnostic views folded in beside them. */
import type { StateView } from './api.ts'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalStatus, EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type AdvancedView, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'
import { TriggerStatus } from './trigger.tsx'

/** The groups a person sets up and changes. */
const EVERYDAY: readonly SettingsGroup[] = ['source', 'eval', 'execution', 'prompts']
/** Views an operator opens to see why something happened; they belong beside the settings, not in the top navigation. */
const ADVANCED: readonly { view: AdvancedView; key: 'tab.threads' | 'tab.evals' }[] = [{ view: 'threads', key: 'tab.threads' },
  { view: 'evals', key: 'tab.evals' }]

export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string; view?: AdvancedView }; state: StateView
  deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    // An advanced view takes over the body; the settings navigation stays so a person can step back into configuration.
    if (query.view === 'threads') return <TriggerStatus filter="subscribed" />
    if (query.view === 'evals') return <EvalStatus filter="work" window={undefined} paused={state.paused} />
    switch (group) {
      // Each Source's health sits in its own card's head, above the fields that change it.
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  const link = (active: boolean, label: string, onClick: () => void, extra?: object) => <button key={label} type="button"
    className="dt-settings-link" aria-current={active ? 'page' : undefined} onClick={onClick} {...extra}>{label}</button>
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {EVERYDAY.map(value => link(value === group && !query.view, t(`settingsGroup.${value}`),
        () => navigate(settingsRoute(value), true)))}
      <span className="dt-nav-group">{t('tabAdvanced')}</span>
      {ADVANCED.map(item => link(query.view === item.view, t(item.key),
        () => navigate(settingsRoute(group, { view: item.view }), true)))}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{query.view ? t(`tab.${query.view}`) : t(`settingsGroup.${group}`)}</h2>
      {content}
    </div>
  </div>
}
