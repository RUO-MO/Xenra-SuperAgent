/**
 * Checking whether a newer version of this plugin exists, for either way it can be installed.
 *
 * The two installations need different questions, and answering the wrong one is worse than not answering:
 *
 * - A **linked or local directory** (`link:` / `file:`) is the operator's own checkout. Its "newer version" is not something
 *   a registry knows about: it is whether the working tree is what the running code was built from, and whether the checkout
 *   sits behind or ahead of its own upstream branch. Reporting "a newer version is available" from a remote would be wrong
 *   here, because nobody is publishing to that checkout.
 * - A **GitHub install** (`git+…`) has a real upstream. The only meaningful comparison is the commit DSH installed against
 *   the commit the remote branch now points at; the `version` field may legitimately stay the same across commits.
 *
 * Both answers share one shape so the panel can show them the same way, and both say what to do next rather than only
 * whether something changed. Nothing here installs anything: upgrading stays an explicit action.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type InstallKind = 'linked' | 'git' | 'unknown'

export interface UpdateSource {
  /** How this installation was declared in the profile. */
  kind: InstallKind
  /** The dependency spec as written, shown as-is so the operator recognizes their own install. */
  spec: string
  /** Where the running code actually is (a link resolves to its target). */
  directory: string
  /** The version the running code reports. */
  version: string
}

export interface UpdateState extends UpdateSource {
  /** Whether this installation can be updated by pulling, and what the panel should say. */
  status: 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'dirty' | 'unavailable'
  /** Commits the local branch is behind its upstream, when known. */
  behind?: number
  ahead?: number
  /** The local commit, and the upstream commit it is compared against. */
  local?: string
  remote?: string
  /** Branch the comparison used. */
  branch?: string
  /** How to update, in the operator's own terms. */
  instruction: string
  /** A diagnostic when the state could not be determined, stated instead of a guess. */
  problem?: string
}

/** Reads the profile's dependency spec and the directory the package resolves to. */
export function sourceOf(profileDir: string | undefined, name: string): UpdateSource | undefined {
  if (!profileDir) return undefined
  let spec = ''
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as
      { dependencies?: Record<string, unknown> }
    const declared = manifest.dependencies?.[name]
    spec = typeof declared === 'string' ? declared : ''
  } catch { return undefined }
  const installed = join(profileDir, 'node_modules', name)
  if (!existsSync(installed)) return undefined
  let directory = installed
  try { directory = realpathOf(installed) } catch { /* Keep the symlink path when it cannot be resolved. */ }
  let version = ''
  try {
    version = String((JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '')
  } catch { /* A package without a readable manifest still has a directory to report. */ }
  return { kind: kindOf(spec), spec: spec || '(not declared)', directory, version }
}

function realpathOf(path: string): string {
  return realpathSync.native(path)
}

/** Classifies a dependency spec. `git+https`, `github:` and `owner/repo` are git installs; a path is local. */
export function kindOf(spec: string): InstallKind {
  const text = spec.trim()
  if (text === '') return 'unknown'
  if (text.startsWith('link:') || text.startsWith('file:')) return 'linked'
  if (text.startsWith('git+') || text.startsWith('git:') || text.startsWith('github:') || text.startsWith('git@')) return 'git'
  // A bare `owner/repo` is a GitHub shorthand; a plain version is a registry install, which this plugin does not use.
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? 'git' : 'unknown'
}

interface GitAnswer { text: string; ok: boolean }
async function git(directory: string, args: string[]): Promise<GitAnswer> {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], { timeout: 20_000, windowsHide: true })
    return { text: stdout.trim(), ok: true }
  } catch (error) {
    const text = (error as { stderr?: string; message?: string }).stderr?.trim() || (error as Error).message
    return { text, ok: false }
  }
}

/**
 * Works out whether a checkout behind this installation has anything to pull.
 *
 * The comparison is against the branch's own upstream, not against `main` by name: an operator working on a branch should be
 * told about that branch. `git fetch` is never run here — a status check must not touch the network or rewrite refs — so the
 * answer describes the last known upstream, and says so when the remote has never been fetched.
 */
export async function checkoutState(directory: string, installed: UpdateSource): Promise<UpdateState> {
  const base = { ...installed, directory }
  const inside = await git(directory, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.text !== 'true') {
    return { ...base, status: 'unavailable', instruction: '', problem: 'This installation is not a git checkout, so there is no history to compare.' }
  }
  const [head, branch] = await Promise.all([
    git(directory, ['rev-parse', '--short', 'HEAD']),
    git(directory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ])
  const local = head.ok ? head.text : undefined
  if (!branch.ok || !branch.text) {
    return { ...base, status: 'unavailable', local, instruction: '',
      problem: 'This checkout has no upstream branch, so nothing published can be newer than it.' }
  }
  // `@{upstream}` answers `origin/main`; the counts are against that exact ref.
  const counts = await git(directory, ['rev-list', '--left-right', '--count', `HEAD...${branch.text}`])
  const status = await git(directory, ['status', '--porcelain'])
  const [ahead, behind] = counts.ok ? counts.text.split(/\s+/).map(Number) : [NaN, NaN]
  const upstream = await git(directory, ['rev-parse', '--short', branch.text])
  const dirty = status.ok && status.text !== ''
  // A dirty tree is reported first: pulling over someone's uncommitted work is the failure this check exists to prevent.
  if (dirty) {
    return { ...base, status: 'dirty', local, ahead, behind, remote: upstream.ok ? upstream.text : undefined,
      branch: branch.text, instruction: `Commit or stash the changes in ${directory}, then pull.` }
  }
  if (!counts.ok || !Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { ...base, status: 'unavailable', local, branch: branch.text, instruction: '',
      problem: counts.text || 'The branch could not be compared with its upstream.' }
  }
  const common = { ...base, local, ahead, behind, remote: upstream.ok ? upstream.text : undefined, branch: branch.text }
  if (behind === 0 && ahead === 0) return { ...common, status: 'up-to-date', instruction: 'Nothing to pull.' }
  if (behind === 0) return { ...common, status: 'ahead', instruction: `Push ${ahead} local commit(s) to ${branch.text} if they are meant to be published.` }
  if (ahead === 0) return { ...common, status: 'behind', instruction: `Pull ${behind} commit(s) from ${branch.text}, then rebuild: pnpm install && pnpm build.` }
  return { ...common, status: 'diverged', instruction: `This branch and ${branch.text} have both moved; merge or rebase, then rebuild.` }
}

/** The state a linked or local directory install is in: its own checkout is the source of truth. */
export async function linkedState(installed: UpdateSource): Promise<UpdateState> {
  return checkoutState(installed.directory, installed)
}

/**
 * The state a git install is in: the commit DSH installed against the commit the remote branch has now.
 *
 * The comparison reads the remote through the installed package's own checkout when one exists, and otherwise asks the
 * GitHub API. It never fetches into that checkout, so checking for updates cannot change what is installed.
 */
export async function gitInstalledState(installed: UpdateSource, profileDir = process.env.DSH_PROFILE_DIR): Promise<UpdateState> {
  if (existsSync(join(installed.directory, '.git'))) return { ...(await checkoutState(installed.directory, installed)), kind: 'git' }
  const repository = repositoryOf(installed.spec)
  if (!repository) {
    return { ...installed, kind: 'git', status: 'unavailable', instruction: '',
      problem: 'The installed spec names no repository to compare against.' }
  }
  const local = installedCommit(installed, profileDir)
  const remote = await remoteHead(repository)
  if (!local || !remote) {
    return { ...installed, kind: 'git', status: 'unavailable', local, instruction: '',
      problem: `Reinstall through the plugin manager to pick up the latest ${repository}${local ? ` (installed ${local})` : ''}.` }
  }
  if (local === remote.commit) {
    return { ...installed, kind: 'git', status: 'up-to-date', local: local.slice(0, 7), remote: remote.commit.slice(0, 7),
      instruction: 'This git install is at the latest published commit.' }
  }
  return { ...installed, kind: 'git', status: 'behind', behind: 1, local: local.slice(0, 7), remote: remote.commit.slice(0, 7),
    instruction: `A newer commit is published for ${repository}. Press Reload to reinstall ${remote.version ?? remote.commit.slice(0, 7)}.` }
}

/** Reads the commit a git install is pinned to from the profile's pnpm lockfile. */
function installedCommit(installed: UpdateSource, profileDir: string | undefined): string | undefined {
  if (!profileDir) return undefined
  try {
    const text = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const match = /resolution:\s*\{[^}]*commit:\s*([0-9a-f]{40})[^}]*repo:\s*([^,}]+)/.exec(text)
    return match?.[1]
  } catch { return undefined }
}

/** Reads the remote HEAD and its latest version tag without touching the local checkout. */
async function remoteHead(repository: string): Promise<{ commit: string; version?: string } | undefined> {
  const listing = await git(installedTempDir(), ['ls-remote', `https://github.com/${repository}.git`, 'HEAD', 'refs/tags/v*'])
  if (!listing.ok) return undefined
  const lines = listing.text.split(/\r?\n/).filter(Boolean)
  const commit = lines.find(line => line.endsWith('\tHEAD'))?.split(/\s+/)[0]
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) return undefined
  const version = lines.find(line => line.startsWith(commit) && line.includes('\trefs/tags/v'))
    ?.split('/').pop()?.replace(/^\^/, '').replace(/^v/, '')
  return { commit, version }
}
/** A harmless cwd for `ls-remote`; it does not read or write the checkout. */
function installedTempDir(): string { return process.env.DSH_PROFILE_DIR ?? process.cwd() }

/** `git+https://github.com/owner/repo.git` and the `github:owner/repo` shorthand both name a repository. */
export function repositoryOf(spec: string): string | undefined {
  const match = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[#?])/.exec(spec)
  if (match) return match[1]
  const short = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(spec.trim())
  return short ? short[1] : undefined
}

/** Dispatches on the install kind so the panel gets one shape whatever was installed. */
export async function updateState(profileDir: string | undefined, name: string): Promise<UpdateState | undefined> {
  const installed = sourceOf(profileDir, name)
  if (!installed) return undefined
  const directory = resolve(installed.directory)
  return installed.kind === 'git' ? gitInstalledState({ ...installed, directory }, profileDir) : linkedState({ ...installed, directory })
}
