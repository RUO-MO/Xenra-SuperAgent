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
