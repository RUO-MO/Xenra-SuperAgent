/**
 * Watches DSH's own plugin-management operations so an uninstall can be told apart from a disable or an update.
 *
 * Everything here is read-only with respect to DSH: the plugin subscribes to events DSH already emits and reads the profile
 * manifest DSH already writes. No DSH file, module, or setting is written, moved, patched, or replaced.
 *
 * Why this is needed: a disable and an uninstall both stop the plugin, both leave the profile still naming the package as a
 * dependency, and both drop its name from the selected `bundles` list. The profile manifest alone cannot separate them, and
 * clearing the state directory on a disable would destroy a working installation's tickets and database.
 *
 * What does separate them is the operation DSH announces at the start of each management action, through the
 * `plugin-manager/operation` event it already emits:
 *   - an uninstall reports `stage: "remove"` for this bundle's name;
 *   - a disable reports `stage: "enable"`;
 *   - an update first announces `plugin-manager/update-state`, then internally performs a remove followed by an install.
 * The event arrives while the plugin is still running, so it can record the intent in memory before DSH stops it.
 *
 * A cleanup is therefore allowed only when all three hold: an uninstall event was seen, no update was in progress, and at
 * stop time the profile no longer selects this bundle. Requiring all three means no single ambiguous signal can destroy data.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The shape of the `plugin-manager/operation` event this plugin cares about; other fields are ignored. */
export interface PluginOperation {
  phase?: string
  stage?: string
  target?: string
}

/** The profile directory DSH runs in, or undefined outside a profile (a bare checkout, a test). */
export function profileDirectory(): string | undefined {
  const dir = process.env.DSH_PROFILE_DIR?.trim()
  return dir ? dir : undefined
}

/** The bundle names the profile selects, or undefined when the manifest cannot be read. */
export function selectedBundles(dir = profileDirectory()): string[] | undefined {
  if (!dir) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as
      { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : []
  } catch { return undefined }
}

/** Whether the profile still names `name` as an installed dependency. */
export function installedDependency(name: string, dir = profileDirectory()): boolean {
  if (!dir) return false
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
    return typeof manifest.dependencies?.[name] === 'string'
  } catch { return false }
}

/**
 * Installs the operation watcher.
 * @returns a function that says whether this stop is a plain uninstall of `name` and its state directory may be cleared.
 */
export function watchForRemoval(ctx: Context, name: string): () => boolean {
  let removing = false
  let updating = false
  // `ctx.on` is disposal-managed, so the listeners cannot outlive this plugin instance and fire into a later one. The event
  // names are emitted by DSH's plugin manager at runtime but are not part of its public `Events` type, hence the narrow cast.
  const on = ctx.on as unknown as (name: string, listener: (payload: never) => void) => () => void
  on('plugin-manager/update-state', ((event: { step?: string }) => {
    // An update announces its steps before its internal remove; a plain uninstall never emits this event.
    if (event.step !== undefined) updating = true
  }) as (payload: never) => void)
  on('plugin-manager/operation', ((operation: PluginOperation) => {
    if (operation.phase !== 'started' || operation.target !== name || updating) return
    if (operation.stage === 'remove') removing = true
  }) as (payload: never) => void)
  return () => {
    if (!removing || updating) return false
    const selected = selectedBundles()
    // An unreadable manifest or one that still selects us is not proof of an uninstall; delete nothing on a guess.
    return selected !== undefined && !selected.includes(name) && installedDependency(name)
  }
}
