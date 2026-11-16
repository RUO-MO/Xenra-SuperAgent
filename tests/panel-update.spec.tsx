// @vitest-environment jsdom
// The update check says which kind of install this is, because the two are judged by different things.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, at, click, text, all } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const deployment = { page: 'settings', query: { group: 'deployment' } }

it('reports a linked install by its own upstream branch rather than a published version', async () => {
  server.update = { kind: 'linked', spec: 'link:D:/dsh-plugins/Xenra-SuperAgent',
    directory: 'D:/dsh-plugins/Xenra-SuperAgent', version: '0.2.0', status: 'behind', behind: 1, ahead: 0,
    local: 'abc1234', remote: 'def5678', branch: 'origin/main',
    instruction: 'Pull 1 commit(s) from origin/main, then rebuild: pnpm install && pnpm build.' }
  at(deployment)
  await mount()
  expect(text()).toContain(zh.updateKindLinked)
  expect(text()).toContain(zh['update.behind'].replace('{behind}', '1'))
  // The two paths that identify this copy, so the operator knows which checkout the answer is about.
  expect(text()).toContain('link:D:/dsh-plugins/Xenra-SuperAgent')
  expect(text()).toContain('Pull 1 commit(s)')
})

it('reports a GitHub install as a GitHub install, and a dirty checkout as needing a commit first', async () => {
  server.update = { kind: 'git', spec: 'git+https://github.com/RUO-MO/Xenra-SuperAgent.git',
    directory: '/srv/profile/node_modules/xenra-superagent', version: '0.2.0', status: 'up-to-date',
    local: 'abc1234', remote: 'abc1234', branch: 'origin/main', instruction: 'Nothing to pull.' }
  at(deployment)
  await mount()
  expect(text()).toContain(zh.updateKindGit)
  expect(text()).toContain(zh['update.up-to-date'])

  server.update = { ...server.update, status: 'dirty',
    instruction: 'Commit or stash the changes in /srv/profile/node_modules/xenra-superagent, then pull.' }
  await remount()
  at(deployment)
  await remount()
  // Uncommitted work outranks "behind": pulling over it is the failure the check exists to prevent.
  expect(text()).toContain(zh['update.dirty'])
  expect(text()).toContain('Commit or stash')
})

it('says it cannot tell rather than guessing when there is no upstream', async () => {
  server.update = { kind: 'linked', spec: 'link:D:/notes/xsa', directory: 'D:/notes/xsa', version: '0.2.0',
    status: 'unavailable', local: 'abc1234', instruction: '',
    problem: 'This checkout has no upstream branch, so nothing published can be newer than it.' }
  at(deployment)
  await mount()
  expect(text()).toContain(zh['update.unavailable'])
  expect(text()).toContain('no upstream branch')
  // A check that cannot tell offers no instruction to follow.
  expect(all('button').some(button => button.textContent === zh.updateCheck)).toBe(true)
})
