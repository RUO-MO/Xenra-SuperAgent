/**
 * Manual, operator-triggered hot reload of this plugin.
 *
 * A person sees “new version available” in the panel and presses reload. What that means depends on how the plugin was
 * installed, and answering the wrong question is worse than not reloading:
 *
 * - A **linked/local folder** install is the operator's own checkout. Rebuilding changes files in place; DSH's HMR service
 *   compares loaded modules with disk and replaces the changed ones, including a linked package's real directory. The
 *   reconcile must run inside `hmr.runExclusive()`, whose transaction cannot be nested.
 * - A **git** install is a package under the profile. Reloading it means a DSH Plugin Manager remove + install, which stops
 *   this plugin, evicts its modules and starts it again from the reinstalled code. `watchForRemoval` already distinguishes
 *   this update from a real uninstall, so the state directory is kept.
 *
 * The operation is deliberately explicit: it never fetches or upgrades on its own, and it reports what it did so the panel
 * can tell the operator whether a full process restart is still required.
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { repositoryOf, sourceOf, type InstallKind } from './update-check.ts'
import { advanceProgress, failProgress, finishProgress, startProgress } from './reload-progress.ts'

const run = promisify(execFile)
export const BUNDLE = 'xenra-superagent'

export interface ReloadResult {
  /** What the panel should tell the operator after the call, in its own words. */
  message: string
  /** How this installation was reloaded. */
  kind: InstallKind
  /** True when the change cannot take effect without restarting the whole DSH process. */
  restartRequired: boolean
  /** Warnings from HMR's profile reconciliation, when any. */
  warnings?: string[]
}

interface HmrLike {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  reconcileProfile(requiredIds?: readonly string[]): Promise<{ warnings: string[]; pending: unknown[]; restartReason?: 'module-comparison' | 'package-moved' }>
}
interface PmLike {
  listBundles(): Promise<Array<{ name: string; installed: string; enabled?: boolean }>>
  removeBundle(name: string): Promise<{ application: string; error?: unknown }>
  installBundle(spec: string, options?: { enabled?: boolean; expected?: { name: string; version: string }; saveExact?: boolean; requestId?: string }): Promise<{ application: string; error?: unknown }>
  updateBundle(name: string, version: string, options?: { spec?: string; requestId?: string }): Promise<{ step: string; result: { application: string; error?: unknown }; to: string }>
}

/**
 * The active profile directory, preferring DSH's own profileContext service. The env var exists in agent subprocesses but
 * not reliably in the host process, so the service is the authoritative source inside a running plugin.
 */
export function profileDirOf(ctx?: Pick<Context, 'get'>): string | undefined {
  if (ctx) {
    const profile = (ctx as Context & { get(name: 'profileContext'): { dir?: string; path?: string } | undefined })
      .get('profileContext' as never) as { dir?: string; path?: string } | undefined
    if (profile?.dir) return profile.dir
    if (profile?.path) return profile.path
  }
  const env = process.env.DSH_PROFILE_DIR?.trim()
  return env || undefined
}

/** Reads the spec as declared in the active profile. */
function specOf(profileDir: string | undefined): string {
  if (!profileDir) return ''
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
    const value = manifest.dependencies?.[BUNDLE]
    return typeof value === 'string' ? value.trim() : ''
  } catch { return '' }
}

/**
 * Resolves the newest commit on a git install's remote branch, without mutating the working tree.
 * Returns the 40-char commit and its semver tag when the remote publishes one, or undefined when nothing can be resolved.
 */
async function latestRemote(directory: string, spec: string): Promise<{ commit: string; version?: string } | undefined> {
  const repository = repositoryOf(spec)
  if (!repository) return undefined
  const fetch = await run('git', ['-C', directory, 'ls-remote', `https://github.com/${repository}.git`, 'HEAD', 'refs/tags/v*'],
    { timeout: 30_000, windowsHide: true }).catch(() => undefined)
  if (!fetch) return undefined
  const lines = fetch.stdout.split(/\r?\n/).filter(Boolean)
  const head = lines.find(line => line.endsWith('\tHEAD'))?.split(/\s+/)[0]
  if (!head || !/^[0-9a-f]{40}$/i.test(head)) return undefined
  // Prefer a semantic version tag that points at HEAD; updateBundle refuses non-version targets.
  const version = lines.find(line => line.startsWith(head) && line.includes('\trefs/tags/v'))
    ?.split('/').pop()?.replace(/^\^/, '').replace(/^v/, '')
  return { commit: head, version }
}

/** Pins a GitHub spec to an exact commit, the form DSH's git update requires. */
function pinnedSpec(spec: string, commit: string): string {
  const repository = repositoryOf(spec)
  if (!repository) return spec
  return `git+https://github.com/${repository}.git#${commit}`
}

/** Installs from the declared spec again, restoring the previous package if the reinstall fails. */
async function reinstall(pm: PmLike, spec: string, stage: (name: 'removing' | 'installing', message: string) => void): Promise<ReloadResult> {
  stage('removing', 'Removing the installed bundle')
  const removed = await pm.removeBundle(BUNDLE)
  if (removed.application === 'failed' || removed.application === 'cancelled') {
    return { kind: 'git', restartRequired: false, message: `Could not remove the installed bundle: ${JSON.stringify(removed.error ?? removed.application)}` }
  }
  stage('installing', 'Installing the bundle')
  const installed = await pm.installBundle(spec, { enabled: true, saveExact: false })
  if (installed.application === 'failed' || installed.application === 'cancelled') {
    await pm.installBundle(spec, { enabled: true }).catch(() => undefined)
    return { kind: 'git', restartRequired: false, message: `Could not reinstall the bundle: ${JSON.stringify(installed.error ?? installed.application)}` }
  }
  return { kind: 'git', restartRequired: installed.application === 'restart-required',
    message: `Reinstalled ${BUNDLE} from ${spec}.` }
}

/**
 * Performs the reload, reporting each stage into the progress file so the panel can follow it.
 * @throws when DSH exposes no service able to reload the installation.
 */
async function runReload(ctx: Context, stateDir: string, requestId: string): Promise<ReloadResult> {
  const profileDir = profileDirOf(ctx)
  const source = sourceOf(profileDir, BUNDLE)
  const spec = specOf(profileDir)
  const kind: InstallKind = source?.kind ?? 'unknown'
  const hmr = ctx.get('hmr') as HmrLike | undefined
  const pm = ctx.get('pluginManager') as PmLike | undefined
  const stage = (name: Parameters<typeof advanceProgress>[2], message: string, detail?: string) =>
    advanceProgress(stateDir, requestId, name, { message, ...detail === undefined ? {} : { detail } })
  const done = (result: ReloadResult) => finishProgress(stateDir, requestId,
    { message: result.message, restartRequired: result.restartRequired })

  stage('checking', 'Checking the installation', spec || undefined)

  // A local checkout: replace the loaded modules in place. Nothing is removed or reinstalled.
  if (kind === 'linked') {
    if (hmr === undefined) throw new Error('HMR is unavailable in this DSH process; restart DSH to load the rebuilt files')
    stage('reloading', 'Reloading modules from disk')
    const result = await hmr.runExclusive(() => hmr.reconcileProfile([BUNDLE]))
    const restartRequired = !!result.restartReason || result.pending.length > 0
    const outcome: ReloadResult = { kind, restartRequired, warnings: result.warnings,
      message: restartRequired
        ? `The checkout changed, but HMR could not replace every loaded module (${result.restartReason ?? 'pending'}); restart DSH to finish.`
        : 'Reloaded the local checkout from disk.' }
    done(outcome)
    return outcome
  }

  // A git install: prefer DSH's atomic update when the remote publishes a newer version; otherwise reinstall the declared spec.
  if (kind === 'git') {
    if (pm === undefined) throw new Error('The plugin manager is unavailable; reload it from the DSH plugin manager')
    const remote = source ? await latestRemote(source.directory, spec || source.spec) : undefined
    const bundles = await pm.listBundles()
    const current = bundles.find(bundle => bundle.name === BUNDLE)
    if (remote?.version && current && !/^[0-9a-f]{40}$/i.test(current.installed) && remote.version !== current.installed) {
      stage('removing', 'Removing the installed bundle')
      const update = await pm.updateBundle(BUNDLE, remote.version, { spec: pinnedSpec(spec || source!.spec, remote.commit), requestId })
      if (update.result.application === 'failed' || update.result.application === 'cancelled') {
        const message = `Update to ${update.to} failed at ${update.step}: ${JSON.stringify(update.result.error ?? update.result.application)}`
        failProgress(stateDir, requestId, message)
        return { kind, restartRequired: false, message }
      }
      const outcome: ReloadResult = { kind, restartRequired: update.result.application === 'restart-required', message: `Updated ${BUNDLE} to ${update.to}.` }
      done(outcome)
      return outcome
    }
    // A branch install without a newer tag is reloaded by reinstalling the same spec.
    const outcome = await reinstall(pm, spec || source?.spec || '', stage)
    done(outcome)
    return outcome
  }

  const message = 'This installation is neither a local checkout nor a git bundle; there is nothing DSH can reload automatically'
  failProgress(stateDir, requestId, message)
  throw new Error(message)
}

/**
 * Start a reload and return immediately with a request id. The work continues in the background and writes its stages to the
 * progress file, which survives the fiber replacement that a reinstall causes. The panel polls `GET update/progress`.
 */
export function reloadSelf(ctx: Context, stateDir: string): { requestId: string; kind: InstallKind } {
  const profileDir = profileDirOf(ctx)
  const source = sourceOf(profileDir, BUNDLE)
  const kind: InstallKind = source?.kind ?? 'unknown'
  const requestId = `xenra-reload-${Date.now()}`
  startProgress(stateDir, requestId, kind)
  // Do not await: returning quickly lets the HTTP response flush and the panel begin polling before the fiber is replaced.
  void runReload(ctx, stateDir, requestId).catch((error: unknown) => {
    failProgress(stateDir, requestId, error instanceof Error ? error.message : String(error))
  })
  return { requestId, kind }
}

/** Whether the installed bundle is a git checkout whose files could be refreshed on disk. */
export function installedGitDirectory(ctx?: Pick<Context, 'get'>): string | undefined {
  const source = sourceOf(profileDirOf(ctx), BUNDLE)
  return source?.kind === 'git' && existsSync(join(source.directory, '.git')) ? source.directory : undefined
}
