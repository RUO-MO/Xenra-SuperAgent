// @vitest-environment jsdom
// The rebuilt workbench: todo board, five-stage pipeline, embedded boards, and the request console.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, tab, click, type, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

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

it('shows a clickable five-stage pipeline and switches the embedded board', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  const stages = all('.stage-card')
  expect(stages).toHaveLength(5)
  expect(stages.map(stage => stage.querySelector('.stage-name')?.textContent)).toEqual([
    '触达', '评审', '立项工单', '派工', '回复',
  ])
  expect(document.querySelector('.embed-title')?.textContent).toBe('派工协作')
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

it('renders the dispatch lane with the four nodes, subagents and phase switch', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  // Dispatch is the default board.
  expect(all('.node').map(node => node.querySelector('.n-name')?.textContent)).toEqual([
    '主窗口 · 方案', '审查窗口', '执行窗口 · 开工', '主窗口 · 回复',
  ])
  expect(all('.subagents').length).toBeGreaterThan(0)
  const phases = all('.phase-btn')
  expect(phases.length).toBe(4)
  await click(phases[1]!)
  expect(phases[1]!.classList.contains('on')).toBe(true)
})

it('shows the config drawers and automation switches', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  expect(all('.config-entries .entry-card')).toHaveLength(2)
  expect(all('.config-grid .drawer').length).toBeGreaterThanOrEqual(3)
  expect(all('.auto-btn')).toHaveLength(2)
  expect(text()).toContain('开启自动后有可能产生必要的 token 消耗')
})
