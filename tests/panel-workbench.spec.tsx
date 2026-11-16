// @vitest-environment jsdom
// The workbench console: a request typed here becomes a Trigger on the shared repository.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf } from './fixtures/panel-server.ts'

usePanel()

it('opens the workbench tab, shows the shared repository, and submits a request', async () => {
  await mount()
  await click(tab(zh['tab.workbench']))
  // The console acts on the same repository that GitHub and Feishu requests act on.
  expect(text()).toContain('acme/widgets')
  expect(text()).toContain(zh.workbenchSharedTarget)
  await type(field<HTMLTextAreaElement>(zh.workbenchRequestLabel), 'fix the save button style')
  await type(field<HTMLInputElement>(zh.workbenchScopeLabel), 'src/client/')
  await click(zh.workbenchSubmit)
  await settle()
  const request = server.requests.find(item => item.path === 'workbench/requests')
  expect(request).toMatchObject({ method: 'POST', body: expect.objectContaining({
    text: 'fix the save button style', scope: 'src/client/', actor: 'operator' }) })
  expect((request?.body as { id: string }).id).toBeTruthy()
  expect(text()).toContain(zh.workbenchRecent)
  expect(text()).toContain('fix the save button style')
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
