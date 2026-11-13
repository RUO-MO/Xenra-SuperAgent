// @vitest-environment jsdom
// Home: the one page a person needs — what waits for them, what is wrong, and the folded machinery.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text } from './fixtures/panel.tsx'
import { server, droppedReply, problemOf, threadSummary } from './fixtures/panel-server.ts'

/** Home's one-line status, which says whether work is running rather than how many slots are free. */
const status = () => document.querySelector('.dt-home-status .dt-status-text')?.textContent
/**
 * Make the fake installation unconfigured, which is what a first run looks like: a GitHub Source with no repository and
 * no agent CLI, and a Policy whose GitHub list allows nobody. Any one of those puts the guide in front of the panel.
 */
function unconfigured() {
  const { settings } = server
  server.settings = {
    ...settings,
    policy: { ...settings.policy, sources: { ...settings.policy.sources, github: { allowed: [], admission: {} } } },
    sources: { ...settings.sources, github: { enabled: true, config: { ...settings.sources.github!.config, repository: '', cli: '' } } },
  }
}
usePanel()
it('answers what needs a person first: the pending Tickets, then the problems, with the machinery folded below', async () => {
  await mount()
  expect(tab(zh['tab.home']).getAttribute('aria-selected')).toBe('true')
  // Three tabs, because the panel answers three questions; the diagnostic views live under Settings.
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['首页', '工单', '设置'])
  expect(status()).toBe(zh.homeStatusPerson.replace('{count}', '2'))
  // Only the sections that have something to say: no last-day counts and no executor numbers until asked for.
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['系统问题2', '待处理工单2查看全部工单'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
})

it('folds the executor into one line that opens on demand, with the two diagnostic views beside it', async () => {
  await mount()
  // The machinery is a <details>, closed by default, so the page stays short.
  const details = document.querySelector<HTMLDetailsElement>('.dt-home-more')!
  expect(details.open).toBe(false)
  expect(details.querySelector('summary')?.textContent).toBe(zh.executor)
  // Opening it gives the executor numbers, each linking to the Tickets list it counts.
  details.open = true
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['执行中2 / 3', '排队0', '等待新触发1'])
  expect(all('.dt-advanced-links button').map(link => link.textContent)).toEqual([zh['tab.threads'], zh['tab.evals']])
  await click(all('.dt-stat button')[0]!)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(tab(zh['tab.tickets']).getAttribute('aria-selected')).toBe('true')
})

it('follows the executor line to the Tickets list it counts, and the advanced links to their views', async () => {
  await mount()
  document.querySelector<HTMLDetailsElement>('.dt-home-more')!.open = true
  // The idle count is its own filter, not the open list.
  await click(all('.dt-stat button')[2]!)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  // Both diagnostic views open from Home, and the navigation keeps showing the tab they were reached from.
  await click(tab(zh['tab.home']))
  document.querySelector<HTMLDetailsElement>('.dt-home-more')!.open = true
  await click(all('.dt-advanced-links button')[0]!)
  expect(server.requests.some(request => request.path === 'threads?filter=subscribed&limit=20')).toBe(true)
  expect(tab(zh['tab.home']).getAttribute('aria-selected')).toBe('true')
  await detail(zh['tab.evals'])
})

/** Open one of Home's two diagnostic views by its link. */
async function detail(name: string) {
  await click(tab(zh['tab.home']))
  document.querySelector<HTMLDetailsElement>('.dt-home-more')!.open = true
  await click(find(name, '.dt-advanced-links button'))
}

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('names the state in one line when nothing waits: running, paused, or still setting up', async () => {
  await mount()
  expect(status()).toBe(zh.homeStatusPerson.replace('{count}', '2'))
  server.person = []
  await remount()
  // Nothing waits, so the pending list says so instead of vanishing.
  expect(status()).toBe(zh.homeStatusReady)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['系统问题2', '待处理工单0'])
  expect(text()).toContain(zh.needsYouNone)
  server.settings = { ...server.settings, paused: true }
  await remount()
  expect(status()).toBe(zh.homeStatusPaused)
})

it('offers each Ticket that needs a person its actions on Home: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === '打开 Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === '停止').at(-1)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(status()).toBe(zh.homeStatusPaused)
  expect(text()).toContain(zh.problemPaused)
  // The Assessments view is reached from Settings, and repeats the pause with a way back to the Tickets list.
  await click(tab(zh['tab.settings']))
  await click(find(zh['tab.evals'], '.dt-settings-link'))
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(tab(zh['tab.tickets']).getAttribute('aria-selected')).toBe('true')
  // Resuming is Home's problem action: it stops new Evals, Assignments and replies, so it asks first.
  await click(tab(zh['tab.home']))
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
  expect(server.settings.paused).toBe(false)
})

it('offers the step that fixes a settings problem as a button on Home', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  // Nobody may ask, so the first-run guide opens; skipping it leaves Home showing what is wrong.
  expect(text()).toContain(zh.wizardTitle)
  await click(zh.wizardSkip)
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  // Nobody may ask, so the settings that fix it are the Policy list under the Eval group.
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  // Turning a Source on is the Source group's business now, health rows and cards together.
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await click(tab(zh['tab.home']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})

it('counts the messages not sent in the last day on the Source that dropped them, and shows no count when there are none', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  // No Feishu reply was dropped, so the Source shows no such section at all.
  expect(text()).not.toContain(zh.sourceDroppedTitle)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  await click(tab(zh['tab.settings']))
  // The drops belong where they happened: inside each Source's own card. m0 is older than a day.
  const dropped = (source: string) => all('.dt-card').find(element =>
    element.querySelector('.dt-card-title')?.textContent === source)!
  const open = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
    .find(item => item.textContent?.includes(zh.sourceDroppedTitle))!
  expect(dropped('飞书').textContent).toContain(`${zh.sourceDroppedTitle} 1`)
  expect(dropped('GitHub').textContent).toContain(`${zh.sourceDroppedTitle} 1`)
  await click(open(dropped('飞书')))
  // Newest first, within the last day only, each with why it was not sent.
  expect([...dropped('飞书').querySelectorAll('.dt-disclosure-body .dt-row')].map(row => [row.querySelector('.dt-row-title')?.textContent,
    row.querySelector('.dt-tag')?.textContent])).toEqual([['Reply m2', zh['reason.channelGone']]])
})

it('names a failing part of xenra-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after Home loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows Home in English', async () => {
  await mount(en)
  expect(status()).toBe(en.homeStatusPerson.replace('{count}', '2'))
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Home', 'Tickets', 'Settings'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.problems}2`, `${en.pendingTickets}2${en.seeAllTickets}`])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  document.querySelector<HTMLDetailsElement>('.dt-home-more')!.open = true
  expect(document.querySelector('.dt-home-more > summary')?.textContent).toBe(en.executor)
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.executingLabel, en.queuedLabel, en.idleLabel])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of xenra-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('puts a machine-level problem in the guide, because it blocks every step the guide asks about', async () => {
  unconfigured()
  // A git too old to read the worker's configuration is the case a person hit: the guide opened, they answered every step,
  // and nothing ran, because the problem was on the machine and only Home mentioned it.
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await mount()
  expect(document.querySelector('.dt-wizard-heading')?.textContent).toBe(zh.wizardTitle)
  expect(text()).toContain(zh['setup.gitTooOld'].split('{')[0]!)
  // It comes with the two ways out: check again, or open this machine's settings.
  expect(document.querySelector('.dt-wizard-blocker')?.textContent).toContain(zh.setupCheck)
  await click(zh.wizardOpenDeployment)
  expect(document.querySelector('.dt-wizard')).toBeNull()
  // Deployment has no navigation entry of its own, so the title is what says the page arrived.
  expect(document.querySelector('.dt-settings-title')?.textContent).toBe(zh['settingsGroup.deployment'])
})

it('leaves the guide for a Feishu problem alone, since only that Source is paused', async () => {
  unconfigured()
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuUserIdentity') }
  await mount()
  // Feishu being misconfigured does not stop GitHub work, so it is reported on its own card rather than holding the guide.
  expect(document.querySelector('.dt-wizard-blocker')).toBeNull()
  expect(all('.dt-wizard-step[data-current] .dt-wizard-title').map(title => title.textContent)).toEqual(['监听仓库与账号'])
})

it('replaces the panel with the first-run guide while an installation is unconfigured, walking the four steps to a saved setup',
  async () => {
  unconfigured()
  await mount()
  // Nothing is configured yet, so the three tabs are hidden and the guide is the whole body.
  expect(all('[role="tab"]')).toEqual([])
  expect(document.querySelector('.dt-wizard-heading')?.textContent).toBe(zh.wizardTitle)
  expect(text()).toContain(zh.wizardIntro)
  // The steps are listed in order, with only the current one open. The repository and the account are one step, because the
  // GitHub Source validates them together; the Feishu step sits next and may be skipped.
  expect(all('.dt-wizard-step .dt-wizard-title').map(title => title.textContent))
    .toEqual(['监听仓库与账号', '接飞书（可跳过）', '谁可以派活', '在哪里干活'])
  expect(all('.dt-wizard-step[data-current] .dt-wizard-title').map(title => title.textContent)).toEqual(['监听仓库与账号'])
  expect(all('.dt-wizard-step[data-done]')).toHaveLength(0)
  // Step 1: the repository and the account the agent acts as, saved in one write. The next button refuses until both are
  // given, so the person is not sent into a round trip that can only fail.
  const stepInputs = () => all('.dt-wizard-step[data-current] input').map(input => input as HTMLInputElement)
  const nextButton = () => all('.dt-wizard-step[data-current] button')
    .find(button => button.textContent === zh.next) as HTMLButtonElement
  expect(nextButton().disabled).toBe(true)
  await type(stepInputs()[0]!, 'acme/widgets')
  expect(nextButton().disabled).toBe(true)
  await type(stepInputs()[1]!, 'agent-bot')
  await click(zh.next)
  expect(server.requests.filter(request => request.path === 'settings/source:github')).toHaveLength(1)
  expect(server.requests.find(request => request.path === 'settings/source:github')).toMatchObject({ method: 'PUT',
    body: { revision: 0, value: { enabled: true, config: expect.objectContaining({ repository: 'acme/widgets', cli: 'agent-bot' }) } } })
  expect(server.settings.sources.github!.config.repository).toBe('acme/widgets')
  expect(server.settings.sources.github!.config.cli).toBe('agent-bot')
  // Step 2: the Feishu bot's CLI, which fills that Source's card. It saves the Source it belongs to.
  expect(all('.dt-wizard-step[data-done] .dt-wizard-title').map(title => title.textContent))
    .toEqual(['监听仓库与账号'])
  await type(document.querySelector<HTMLInputElement>('.dt-wizard-step[data-current] input')!, 'lark-bot')
  await click(zh.next)
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT',
    body: { value: { enabled: true, config: expect.objectContaining({ cli: 'lark-bot' }) } } })
  expect(server.settings.sources.feishu!.config.cli).toBe('lark-bot')
  // Step 3: who may ask, written into the Policy's GitHub list, with the repository it will act on shown for orientation.
  expect(document.querySelector('.dt-wizard-step[data-current]')?.textContent).toContain('acme/widgets')
  await type(document.querySelector<HTMLInputElement>('.dt-wizard-step[data-current] input')!, 'alice')
  await click(zh.next)
  expect(server.requests.find(request => request.path === 'settings/policy')).toMatchObject({ method: 'PUT', body: { revision: 3 } })
  expect(server.settings.policy.sources.github!.allowed).toEqual([{ id: 'alice' }])
  // Step 4: where work happens, saved as the Executor's directory; finishing closes the guide.
  await type(document.querySelector<HTMLInputElement>('.dt-wizard-step[data-current] input')!, '/srv/work')
  await click(zh.finish)
  expect(server.requests.find(request => request.path === 'settings/executor')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: expect.objectContaining({ directory: '/srv/work' }) } })
  expect(server.settings.executor.directory).toBe('/srv/work')
  // The guide is gone, and the panel it was standing in for is back on Home.
  expect(document.querySelector('.dt-wizard')).toBeNull()
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['首页', '工单', '设置'])
  expect(tab(zh['tab.home']).getAttribute('aria-selected')).toBe('true')
  expect(status()).toBe(zh.homeStatusPerson.replace('{count}', '2'))
})

it('lets the Feishu step be skipped, since GitHub work does not need a bot', async () => {
  unconfigured()
  await mount()
  const inputs = () => all('.dt-wizard-step[data-current] input').map(input => input as HTMLInputElement)
  await type(inputs()[0]!, 'acme/widgets')
  await type(inputs()[1]!, 'agent-bot')
  await click(zh.next)
  // The Feishu step is open, and its own skip moves on without writing that Source at all.
  expect(all('.dt-wizard-step[data-current] .dt-wizard-title').map(title => title.textContent)).toEqual(['接飞书（可跳过）'])
  const before = server.requests.filter(request => request.path === 'settings/source:feishu').length
  await click(zh.wizardFeishuSkip)
  expect(server.requests.filter(request => request.path === 'settings/source:feishu')).toHaveLength(before)
  expect(all('.dt-wizard-step[data-current] .dt-wizard-title').map(title => title.textContent)).toEqual(['谁可以派活'])
  // The guide is still running: skipping Feishu is not leaving the guide.
  expect(document.querySelector('.dt-wizard')).not.toBeNull()
})

it('tells the guide when the installation has no Feishu Source at all', async () => {
  unconfigured()
  // The Feishu row is off in this profile, so the Source exists without a card to fill.
  server.uninstalled = ['feishu']
  await mount()
  const inputs = () => all('.dt-wizard-step[data-current] input').map(input => input as HTMLInputElement)
  await type(inputs()[0]!, 'acme/widgets')
  await type(inputs()[1]!, 'agent-bot')
  await click(zh.next)
  expect(text()).toContain(zh.wizardFeishuAbsent)
  // With nothing to fill, the step offers no field and no save: only skipping or going back makes sense.
  expect(inputs()).toHaveLength(0)
  await click(zh.wizardFeishuSkip)
  expect(all('.dt-wizard-step[data-current] .dt-wizard-title').map(title => title.textContent)).toEqual(['谁可以派活'])
})

it('goes back a step in the guide without saving, and can be skipped or leave for the settings pages', async () => {
  unconfigured()
  await mount()
  // Reach the second step, then come back: what was typed is kept and nothing is saved by moving.
  const inputs = () => all('.dt-wizard-step[data-current] input').map(input => input as HTMLInputElement)
  await type(inputs()[0]!, 'acme/widgets')
  await type(inputs()[1]!, 'agent-bot')
  await click(zh.next)
  // The second step is Feishu, whose card already holds the bot CLI the fixture saved.
  expect(inputs()[0]?.value).toBe('lark-bot')
  await click(zh.back)
  const saves = server.requests.filter(request => request.method === 'PUT').length
  expect(inputs().map(input => input.value)).toEqual(['acme/widgets', 'agent-bot'])
  // Going back to the first step saves nothing: it only reopened what was already typed.
  expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(saves)
  // Skipping leaves the guide for the panel, which works: Home is back and lists what waits, while the settings that
  // would finish the setup stay one tab away.
  await click(zh.wizardSkip)
  expect(document.querySelector('.dt-wizard')).toBeNull()
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['首页', '工单', '设置'])
  expect(status()).toBe(zh.homeStatusPerson.replace('{count}', '2'))
  // Nothing was saved to get out of the way, so the installation is still unconfigured.
  expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(saves)
  // Opening the settings directly also leaves the guide, at the Source group it configures. A remount starts a new page,
  // which finds the installation still unconfigured and opens the guide again.
  await remount()
  await click(zh.wizardOpenSettings)
  expect(document.querySelector('.dt-wizard')).toBeNull()
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
})
