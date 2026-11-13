// Telling a plain uninstall from a disable or an update, which decides whether the state directory is cleared on the way out.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installedDependency, selectedBundles, watchForRemoval } from '../src/infra/profile.ts'

/** A profile manifest on disk with the given bundle selection and dependencies. */
function profile(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'xenra-profile-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}
const manifest = (bundles: string[], installed: boolean) => ({
  dsh: { profile: { bundles } },
  dependencies: installed ? { 'xenra-superagent': 'git+https://github.com/RUO-MO/Xenra-SuperAgent.git' } : {},
})

/** A Context stub that exposes `ctx.on` and lets a test fire an event by name. */
function fakeContext(dir: string) {
  const listeners = new Map<string, ((payload: unknown) => void)[]>()
  const on = vi.fn((name: string, listener: (payload: unknown) => void) => {
    listeners.set(name, [...listeners.get(name) ?? [], listener])
    return () => {}
  })
  const emit = (name: string, payload: unknown) => { for (const listener of listeners.get(name) ?? []) listener(payload) }
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  return { ctx: { on } as unknown as Context, emit, restore: () => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  } }
}

/** Fires the events DSH emits for an uninstall of this bundle. */
const uninstallOf = (emit: (name: string, payload: unknown) => void, name = 'xenra-superagent') =>
  emit('plugin-manager/operation', { phase: 'started', stage: 'remove', target: name })

it('reads the bundle selection and the dependencies without writing anything', () => {
  const dir = profile(manifest(['dsh-base', 'xenra-superagent'], true))
  expect(selectedBundles(dir)).toEqual(['dsh-base', 'xenra-superagent'])
  expect(installedDependency('xenra-superagent', dir)).toBe(true)
})

it('clears the state directory on a plain uninstall, and only then', () => {
  // The profile has stopped selecting us but still depends on us: exactly the state left by DSH between dropping the
  // bundle and running `pnpm remove`, and the one moment the plugin can still act.
  const dir = profile(manifest(['dsh-base'], true))
  const { ctx, emit, restore } = fakeContext(dir)
  try {
    const isUninstall = watchForRemoval(ctx, 'xenra-superagent')
    uninstallOf(emit)
    expect(isUninstall()).toBe(true)
  } finally { restore() }
})

it('does not clear anything on a disable, a restart, or an unrelated operation', () => {
  const dir = profile(manifest(['dsh-base'], true))
  const { ctx, emit, restore } = fakeContext(dir)
  try {
    // A disable emits an "enable" operation for the same name; a restart emits no operation at all.
    const disabled = watchForRemoval(ctx, 'xenra-superagent')
    emit('plugin-manager/operation', { phase: 'started', stage: 'enable', target: 'xenra-superagent', enabled: false })
    expect(disabled()).toBe(false)

    // An operation on another bundle must not be mistaken for ours.
    const other = watchForRemoval(ctx, 'xenra-superagent')
    uninstallOf(emit, 'some-other-bundle')
    expect(other()).toBe(false)

    // No event at all: a plain restart, which must keep every ticket and the database.
    const restarted = watchForRemoval(ctx, 'xenra-superagent')
    expect(restarted()).toBe(false)
  } finally { restore() }
})

it('does not clear anything during an update, which removes and then reinstalls the bundle', () => {
  const dir = profile(manifest(['dsh-base'], true))
  const { ctx, emit, restore } = fakeContext(dir)
  try {
    const isUninstall = watchForRemoval(ctx, 'xenra-superagent')
    // DSH announces an update first, then its internal removeBundle emits the very same "remove" operation.
    emit('plugin-manager/update-state', { requestId: 'r1', step: 'checking' })
    uninstallOf(emit)
    expect(isUninstall()).toBe(false)
  } finally { restore() }
})

it('does not clear anything when the manifest is unreadable or still selects the bundle', () => {
  const unreadable = mkdtempSync(join(tmpdir(), 'xenra-profile-'))
  writeFileSync(join(unreadable, 'package.json'), 'not json at all')
  const a = fakeContext(unreadable)
  try {
    const watch = watchForRemoval(a.ctx, 'xenra-superagent')
    uninstallOf(a.emit)
    // An unreadable manifest is not evidence of an uninstall, so nothing is deleted on a guess.
    expect(watch()).toBe(false)
  } finally { a.restore() }

  const stillSelected = profile(manifest(['dsh-base', 'xenra-superagent'], true))
  const b = fakeContext(stillSelected)
  try {
    const watch = watchForRemoval(b.ctx, 'xenra-superagent')
    uninstallOf(b.emit)
    expect(watch()).toBe(false)
  } finally { b.restore() }

  const notInstalled = profile(manifest(['dsh-base'], false))
  const c = fakeContext(notInstalled)
  try {
    const watch = watchForRemoval(c.ctx, 'xenra-superagent')
    uninstallOf(c.emit)
    expect(watch()).toBe(false)
  } finally { c.restore() }
})

it('answers no outside a profile, so a checkout or a test never seeds a cleanup', () => {
  expect(selectedBundles('')).toBeUndefined()
  const dir = profile(manifest(['dsh-base'], true))
  const { ctx, emit } = fakeContext(dir)
  // An empty profile directory stands for "DSH_PROFILE_DIR is unset".
  delete process.env.DSH_PROFILE_DIR
  const watch = watchForRemoval(ctx, 'xenra-superagent')
  uninstallOf(emit)
  expect(watch()).toBe(false)
})
