// @vitest-environment jsdom
// The workbench console: a request typed here becomes a Trigger on the shared repository.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf } from './fixtures/panel-server.ts'

usePanel()

it('shows the targets as different kinds, and submits the one that is picked', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  // A GitHub repository and a local folder are drawn as chips, and the watched one is marked.
  const chips = all('.dt-wb-chip')
  expect(chips).toHaveLength(2)
  expect(chips[0]!.textContent).toContain('widgets')
  expect(chips[0]!.getAttribute('title')).toContain('acme/widgets')
  expect(chips[0]!.textContent).toContain(zh.workbenchWatched)
  expect(chips[1]!.getAttribute('title')).toContain('D:\\notes')
  // The selected target is the one a request acts on unless another is picked.
  expect(chips[0]!.getAttribute('aria-pressed')).toBe('true')

  await click(chips[1]!)
  expect(chips[1]!.getAttribute('aria-pressed')).toBe('true')
  await type(field<HTMLTextAreaElement>(zh.workbenchRequestLabel), 'tidy the headings')
  await click(zh.workbenchSubmit)
  await settle()
  expect(server.requests.find(item => item.path === 'workbench/requests')).toMatchObject({ method: 'POST',
    body: expect.objectContaining({ text: 'tidy the headings', target: 'notes', actor: 'operator' }) })
  expect(text()).toContain(zh.workbenchRecent)
})

it('shows the request pipeline chain with live 24-hour counts', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  const chain = all('.dt-wb-chain-step')
  expect(chain).toHaveLength(4)
  expect(chain.map(step => step.querySelector('.dt-wb-chain-label')?.textContent)).toEqual([
    zh.flowReceivedLabel, zh['term.trigger'], zh.flowJudgedLabel, zh.flowAcceptedLabel,
  ])
  // The default fixture received 12 events; the first stage shows that live count.
  expect(chain[0]!.querySelector('.dt-wb-chain-value')?.textContent).toBe('12')
})

it('shows recent requests as a lifecycle tree with expandable stages', async () => {
  server.lifecycle = [{ key: 'workbench:local', title: '检查项目问题', source: 'workbench', at: '2026-11-17T03:00:00Z',
    progress: 40, current: 'ticket', headline: 'ticket: fix-check', headlined: false,
    steps: [
      { stage: 'trigger', state: 'done', progress: 100, summary: 'workbench · operator · 检查项目问题', reasons: [] },
      { stage: 'assessment', state: 'done', progress: 100, summary: 'accept', reasons: [] },
      { stage: 'ticket', state: 'ongoing', progress: 50, summary: 'fix-check', reasons: [], ticketId: 't1' },
      { stage: 'assignment', state: 'idle', progress: 0, summary: 'Not dispatched', reasons: [] },
      { stage: 'reply', state: 'idle', progress: 0, summary: 'No reply recorded', reasons: [] },
    ] }]
  await mount()
  await click(tab(zh['tab.workbench']))
  expect(text()).toContain(zh.workbenchFlow)
  const roots = all('.dt-life-root')
  expect(roots).toHaveLength(1)
  expect(roots[0]!.textContent).toContain('检查项目问题')
  // Stage cards are hidden until the request is expanded.
  expect(all('.dt-life-stage')).toHaveLength(0)
  await click(roots[0]!)
  const stages = all('.dt-life-stage')
  expect(stages).toHaveLength(5)
  expect(stages[0]!.textContent).toContain(zh['lifecycle.trigger'])
  expect(stages[2]!.getAttribute('data-state')).toBe('ongoing')
})

it('shows the actual failure reason in the lifecycle tree so the request can be diagnosed', async () => {
  server.lifecycle = [{ key: 'workbench:local', title: '检查项目问题', source: 'workbench', at: '2026-11-17T03:00:00Z',
    progress: 20, current: 'assessment', headline: 'assessment: Assessment timed out', headlined: true,
    steps: [
      { stage: 'trigger', state: 'done', progress: 100, summary: 'workbench · operator', reasons: [] },
      { stage: 'assessment', state: 'error', progress: 0, summary: 'unavailable',
        reasons: [{ code: 'timeout', text: 'Assessment timed out' }] },
      { stage: 'ticket', state: 'idle', progress: 0, summary: 'No ticket opened', reasons: [] },
      { stage: 'assignment', state: 'idle', progress: 0, summary: 'Not dispatched', reasons: [] },
      { stage: 'reply', state: 'idle', progress: 0, summary: 'No reply recorded', reasons: [] },
    ] }]
  await mount()
  await click(tab(zh['tab.workbench']))
  const root = all('.dt-life-root')[0]!
  // The headline carries the real reason even while collapsed.
  expect(root.textContent).toContain('Assessment timed out')
  expect(root.querySelector('.dt-life-headline')?.getAttribute('data-error')).toBe('true')
  await click(root)
  const assess = all('.dt-life-stage')[1]!
  expect(assess.textContent).toContain('Assessment timed out')
  expect(assess.querySelector('.dt-life-reasons')?.textContent).toContain('Assessment timed out')
})

it('adds a repository target inline and removes it again', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  // The inline add field is the only text input with the add placeholder; use its class from the chip row.
  const addInput = document.querySelector<HTMLInputElement>('.dt-target-add-input input')!
  await type(addInput, 'acme/new-repo')
  await click(zh.targetsAdd)
  await settle()
  expect(server.targets.some(item => item.kind === 'repository' && item.repository === 'acme/new-repo')).toBe(true)
  expect(all('.dt-wb-chip')).toHaveLength(3)
  // Removing the new chip calls the delete route and drops it from the list.
  const newChip = all('.dt-wb-chip').find(chip => chip.getAttribute('title') === 'acme/new-repo')!
  const remover = newChip.parentElement!.querySelector<HTMLButtonElement>('.dt-wb-chip-remove')!
  await click(remover)
  expect(all('.dt-wb-chip')).toHaveLength(2)
})

it('reveals the optional scope above the actions and tracks aria-expanded', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  const toggle = document.querySelector<HTMLButtonElement>('.dt-wb-actions .dt-textlink')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(field<HTMLInputElement>(zh.workbenchScopeLabel)).not.toBeNull()
})

it('lets a machine-level problem take the panel over as the first-run guide, rather than showing an empty console', async () => {
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  at({ page: 'workbench' })
  await mount()
  // A problem that leaves the machine unable to run is carried by the guide, so a person is not asked to submit work
  // that could never execute. The workbench is behind it, not missing.
  expect(document.querySelector('.dt-wizard')).not.toBeNull()
  expect(text()).toContain(zh.wizardTitle)
})
