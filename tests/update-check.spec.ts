// Checking for updates, which must ask a different question for a linked checkout than for a GitHub install.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { checkoutState, kindOf, repositoryOf, sourceOf, updateState } from '../src/app/update-check.ts'

/** A git repository with one commit, so HEAD and a branch exist. */
function repositoryAt(path: string, version = '0.2.0'): string {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'xenra-superagent', version }))
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  return path
}

/** A profile whose dependency names `spec` and whose node_modules entry resolves to `installed`. */
function profileWith(spec: string, installed: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'xenra-profile-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'xenra-superagent': spec } }))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  // A directory link, made the portable way: Windows needs `junction` because creating a symlink may require elevation.
  symlinkSync(installed, join(dir, 'node_modules', 'xenra-superagent'), 'junction')
  return dir
}

it('classifies an install spec, so the right question is asked', () => {
  expect(kindOf('link:D:/dsh-plugins/Xenra-SuperAgent')).toBe('linked')
  expect(kindOf('file:../Xenra-SuperAgent')).toBe('linked')
  expect(kindOf('git+https://github.com/RUO-MO/Xenra-SuperAgent.git')).toBe('git')
  expect(kindOf('github:RUO-MO/Xenra-SuperAgent')).toBe('git')
  expect(kindOf('RUO-MO/Xenra-SuperAgent')).toBe('git')
  expect(kindOf('1.2.3')).toBe('unknown')
  expect(kindOf('')).toBe('unknown')
})

it('names the repository a git spec points at', () => {
  expect(repositoryOf('git+https://github.com/RUO-MO/Xenra-SuperAgent.git')).toBe('RUO-MO/Xenra-SuperAgent')
  expect(repositoryOf('github:RUO-MO/Xenra-SuperAgent')).toBe('RUO-MO/Xenra-SuperAgent')
  expect(repositoryOf('git+https://github.com/acme/widgets.git#v1')).toBe('acme/widgets')
  expect(repositoryOf('link:D:/x')).toBeUndefined()
})

it('reads the declared spec, the resolved directory and the running version', () => {
  const checkout = repositoryAt(join(mkdtempSync(join(tmpdir(), 'xenra-src-')), 'pkg'), '0.3.0')
  const profile = profileWith('link:' + checkout.replaceAll('\\', '/'), checkout)
  const source = sourceOf(profile, 'xenra-superagent')!
  expect(source).toMatchObject({ kind: 'linked', version: '0.3.0' })
  expect(source.spec).toContain('link:')
  expect(source.directory.toLowerCase()).toContain('pkg')
})

it('reports a linked checkout by its own upstream rather than by a published version', async () => {
  const checkout = repositoryAt(join(mkdtempSync(join(tmpdir(), 'xenra-src-')), 'pkg'))
  const profile = profileWith('link:' + checkout.replaceAll('\\', '/'), checkout)
  const state = (await updateState(profile, 'xenra-superagent'))!
  // A checkout with no upstream branch has nothing published to be behind, and says so instead of guessing.
  expect(state.status).toBe('unavailable')
  expect(state.problem).toContain('upstream')
  expect(state.local).toBeTruthy()
})

it('says how far behind the upstream branch a checkout is, and refuses to call a dirty tree updateable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xenra-src-'))
  const upstream = repositoryAt(join(root, 'upstream'))
  const clone = join(root, 'clone')
  execFileSync('git', ['clone', '-q', upstream, clone], { stdio: 'pipe' })
  const git = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')

  const installed = { kind: 'linked' as const, spec: 'link:' + clone, directory: clone, version: '0.2.0' }
  // In step with its upstream: nothing to pull.
  expect((await checkoutState(clone, installed)).status).toBe('up-to-date')

  // The upstream gains a commit; the clone is one behind after a fetch.
  writeFileSync(join(upstream, 'NOTES.md'), 'later\n')
  execFileSync('git', ['-C', upstream, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', upstream, 'commit', '-q', '-m', 'later'], { stdio: 'pipe' })
  execFileSync('git', ['-C', clone, 'fetch', '-q'], { stdio: 'pipe' })
  const behind = await checkoutState(clone, installed)
  expect(behind).toMatchObject({ status: 'behind', behind: 1 })
  expect(behind.instruction).toContain('Pull 1 commit')

  // Uncommitted work comes first: pulling over it is the failure this check exists to prevent.
  writeFileSync(join(clone, 'WIP.md'), 'unfinished\n')
  const dirty = await checkoutState(clone, installed)
  expect(dirty.status).toBe('dirty')
  expect(dirty.instruction).toContain('Commit or stash')
  // Git operations on a loaded machine take longer than the default allowance; the assertions themselves are quick.
}, 30_000)

it('answers nothing for a profile that does not have this plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xenra-profile-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }))
  expect(sourceOf(dir, 'xenra-superagent')).toBeUndefined()
  expect(sourceOf(undefined, 'xenra-superagent')).toBeUndefined()
})
