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
  // A GitHub repository and a local folder are drawn as different things, and the watched one is marked.
  const cards = all('.dt-target')
  expect(cards).toHaveLength(2)
  expect(cards[0]!.textContent).toContain(zh.workbenchKindRepository)
  expect(cards[0]!.textContent).toContain('acme/widgets')
  expect(cards[0]!.textContent).toContain(zh.workbenchWatched)
  expect(cards[1]!.textContent).toContain(zh.workbenchKindDirectory)
  expect(cards[1]!.textContent).toContain('D:\\notes')
  // The selected target is the one a request acts on unless another is picked.
  expect(cards[0]!.getAttribute('aria-pressed')).toBe('true')

  await click(cards[1]!)
  expect(cards[1]!.getAttribute('aria-pressed')).toBe('true')
  await type(field<HTMLTextAreaElement>(zh.workbenchRequestLabel), 'tidy the headings')
  await click(zh.workbenchSubmit)
  await settle()
  expect(server.requests.find(item => item.path === 'workbench/requests')).toMatchObject({ method: 'POST',
    body: expect.objectContaining({ text: 'tidy the headings', target: 'notes', actor: 'operator' }) })
  expect(text()).toContain(zh.workbenchRecent)
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
