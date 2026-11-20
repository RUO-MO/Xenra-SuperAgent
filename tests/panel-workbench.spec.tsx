// @vitest-environment jsdom
// The rebuilt workbench: todo board, five-stage pipeline, embedded boards, and the request console.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, tab, click, type, text } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()

it('shows four todo entry cards above the workbench', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  const cards = all('.todo-card')
  expect(cards).toHaveLength(4)
  expect(cards.map(card => card.querySelector('.tc-label')?.textContent)).toEqual([
    '待回答', '待验收', '受阻/失败', '系统问题',
  ])
  // Each card shows only a count as its main figure.
  for (const card of cards) expect(card.querySelector('.tc-num')?.textContent).toMatch(/^\d+$/)
})

it('opens the processing page when a todo card is clicked', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  await click(all('.todo-card')[0]!)
  expect(text()).toContain(zh.todoBack)
  expect(text()).toContain(zh['processing.answer'])
})

it('names the reason a system problem carries instead of showing only its kind', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  await click(all('.todo-card')[3]!)
  expect(text()).toContain('研判失败（超时）')
})

it('shows a clickable five-stage pipeline and switches the embedded board', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  const stages = all('.stage-card')
  expect(stages).toHaveLength(5)
  expect(stages.map(stage => stage.querySelector('.stage-name')?.textContent)).toEqual([
    '触达', '评审', '立项工单', '派工', '回复',
  ])
  expect(document.querySelector('.embed-title')?.textContent).toBe('派工协作')
  // The Eval stage states the real failure it read, not the prototype's fixed "进行中".
  expect(stages[1]!.querySelector('.stage-state')?.textContent).toContain('研判失败')
  await click(stages[0]!)
  expect(document.querySelector('.embed-title')?.textContent).toBe('信号台')
  await click(all('.stage-card')[4]!)
  expect(document.querySelector('.embed-title')?.textContent).toBe('回执台')
})

it('submits a request from the small compose card and clears it', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  const area = document.querySelector<HTMLTextAreaElement>('.mini-compose textarea')!
  await type(area, 'tidy the headings')
  await click(document.querySelector<HTMLButtonElement>('.mini-compose .submit')!)
  await settle()
  expect(server.requests.find(item => item.path === 'workbench/requests')).toMatchObject({ method: 'POST',
    body: expect.objectContaining({ text: 'tidy the headings', actor: 'operator' }) })
  expect(area.value).toBe('')
  expect(text()).toContain('已进入触达排队')
})

it('keeps the draft and says why when a request is not accepted', async () => {
  server.workbenchAccepted = false
  await mount()
  await click(tab(zh['tab.workbench']))
  const area = document.querySelector<HTMLTextAreaElement>('.mini-compose textarea')!
  await type(area, 'tidy the headings')
  await click(document.querySelector<HTMLButtonElement>('.mini-compose .submit')!)
  await settle()
  expect(area.value).toBe('tidy the headings')
  expect(text()).toContain('未进入触达排队')
})

it('labels the running ticket as current and the queued one as next, not merely the newest', async () => {
  server.tickets.open = [
    ticketSummary({ id: 't-new', title: '等待回答' }, { stage: 'person', action: 'answer' }),
    ticketSummary({ id: 't1', title: '运行中' }, { stage: 'working' }),
    ticketSummary({ id: 't-queued', title: '排队中' }, { stage: 'working', action: 'queued' }),
  ]
  await mount()
  await click(tab(zh['tab.workbench']))
  expect(document.querySelector('.tk-card.on .tk-id')?.textContent).toBe('t1')
  expect(document.querySelector('.tk-card.tk-next .tk-id')?.textContent).toBe('t-queued')
})

it('renders the real dispatch lane from the ticket assignments, without the prototype demo phases', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  // Dispatch is the default board; its nodes come from the open ticket's assignments, not from demo scenes.
  expect(all('.assign-node')).toHaveLength(1)
  expect(all('.assign-node .assign-name').map(node => node.textContent)).toEqual(['派工 a1'])
  expect(text()).toContain('执行链路')
  expect(all('.phase-btn')).toHaveLength(0)
  expect(all('.subagents')).toHaveLength(0)
})

it('shows the config drawers and automation switches', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  expect(all('.config-entries .entry-card')).toHaveLength(2)
  expect(all('.config-grid .drawer').length).toBeGreaterThanOrEqual(3)
  expect(all('.auto-btn')).toHaveLength(2)
  expect(text()).toContain('开启自动后有可能产生必要的 token 消耗')
})
