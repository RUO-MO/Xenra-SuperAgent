// @vitest-environment jsdom
// The Deployment settings and the Plugin Manager page.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.ts'

usePanel()
it('saves this machine\'s settings in the Deployment settings through DSH\'s configuration form, without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  // Deployment is a machine-level group: a deployment problem links to it, and a stored route reopens it.
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  // The state directory is the one editable path on this page, so it is an input rather than displayed text.
  expect(field<HTMLInputElement>(zh.deploymentStateDir).value).toBe('/srv/xenra-superagent')
  // Accounts are on the Source settings; the Plugin Manager page, where those are not at hand, shows them here.
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(text()).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('saves a new state directory as a path, refuses a relative one, and says the plugin remounts', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  // A path the Host would refuse never reaches the configuration form.
  await type(field<HTMLInputElement>(zh.deploymentStateDir), 'relative/state')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentStateDirInvalid)
  expect(mutations).toEqual([])
  // A new absolute directory is saved as the string, not as a number, and the page warns that it remounts.
  await type(field<HTMLInputElement>(zh.deploymentStateDir), '/srv/xenra-superagent-2')
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['stateDir'], value: '/srv/xenra-superagent-2' }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.deploymentStateDirRestart)
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await remount()
  expect(text()).toContain(zh.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain('这个 DSH 版本不提供配置表单')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // The Plugin Manager page saves another field of the same entry meanwhile.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the Deployment page with the derived accounts in the Plugin Manager, and no summary', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  // Remount from scratch on each render to match Plugin Manager page navigation.
  const render = async (view: 'page' | 'summary') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<PluginConfig t={translator(zh)} view={view} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  await render('summary')
  expect(container.textContent).toBe('')
  server.form = fakeForm().form
  await render('page')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', '账号在 xenra-superagent 面板的来源设置里修改。']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render('page')
  expect(text()).toContain(zh.hostNotRunning)
})

it('offers the machine\'s own git upgrade only when the workers\' git is too old, and shows the command before running it', async () => {
  // A git new enough says nothing at all: the repair only appears when there is something to repair.
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).not.toContain(zh.gitUpgradeOffer)
  // An old git names the version actually running, and the command this machine would run.
  server.git = { version: '2.30.0', outdated: true, minimum: '2.32', plan: { command: 'brew upgrade git', by: 'brew' } }
  await remount()
  expect(text()).toContain(zh.gitTooOldNow.replace('{version}', '2.30.0').replace('{minimum}', '2.32'))
  // Nothing runs on its own: the offer opens a dialog with the command and what it changes.
  expect(server.requests.some(request => request.path === 'git/upgrade')).toBe(false)
  await click(zh.gitUpgradeOffer)
  expect(text()).toContain('brew upgrade git')
  expect(text()).toContain(zh.gitUpgradeRisk.replace('{by}', 'brew'))
  expect(text()).toContain(zh.gitUpgradeManual)
  expect(server.requests.some(request => request.path === 'git/upgrade')).toBe(false)
  // Confirming runs it once, and a git that moved reports the new version.
  server.git = { ...server.git, version: '2.44.0', outdated: false }
  await click(zh.gitUpgradeConfirm)
  expect(server.requests.filter(request => request.path === 'git/upgrade')).toHaveLength(1)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.gitUpgraded.replace('{version}', '2.44.0'))
  await settle()
  // The repair is gone once the git is new enough.
  expect(text()).not.toContain(zh.gitUpgradeOffer)
})

it('reports a git that stayed old, and one whose upgrade command failed, without claiming success', async () => {
  server.git = { version: '2.30.0', outdated: true, minimum: '2.32', plan: { command: 'winget upgrade --id Git.Git --exact',
    by: 'winget' } }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.gitUpgradeOffer)
  // A command that succeeded but left an older git first on PATH is not a success, and says why in the version's terms.
  server.gitUpgrade = () => ({ ok: true, output: 'installed', version: '2.31.0', outdated: true })
  await click(zh.gitUpgradeConfirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.gitStillOld.replace('{version}', '2.31.0'))
  // A failing command keeps its output on screen instead of a bare toast.
  server.gitUpgrade = () => ({ ok: false, output: 'winget: access denied', version: '2.30.0', outdated: true })
  await click(zh.gitUpgradeConfirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.gitUpgradeFailed)
  expect(text()).toContain('winget: access denied')
  // A machine with no package manager still names what is needed; it offers no command it cannot run.
  server.git = { version: '2.30.0', outdated: true, minimum: '2.32' }
  await remount()
  expect(text()).toContain(zh.gitNoPlan.replace('{minimum}', '2.32'))
  expect(text()).not.toContain(zh.gitUpgradeOffer)
})

it('tells a xenra-superagent that is starting from a browser that cannot write on the Deployment page', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While xenra-superagent restarts, DSH stops serving its entry; the values come back editable once it is served again.
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ status: 'ready', writable: false }) })
  expect(text()).toContain(zh.deploymentReadOnly)
})

it('reads the state every second after a setup check, until xenra-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})
