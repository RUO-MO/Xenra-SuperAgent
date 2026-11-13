/**
 * Reporting on, and upgrading, the git that worker sessions run.
 *
 * The plugin needs git 2.32 or later because that is the version whose `GIT_CONFIG_GLOBAL` reaches a repository's own
 * configuration; older releases ignore the isolated configuration the plugin writes and quietly use the operator's. A
 * diagnostic that says only "needs 2.32" leaves an operator to work out what they have and how to change it, so this module
 * answers both: the git that actually runs, and the exact command that would upgrade it on this machine.
 *
 * Nothing here installs anything on its own. `upgrade()` is called only after a person has read the command and what it
 * changes, and every plan is a command run as that person, never a package the plugin vendored.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WINDOWS } from '../infra/platform.ts'

const exec = promisify(execFile)
/** The oldest git whose `GIT_CONFIG_GLOBAL` applies to every repository, which the worker environment depends on. */
export const GIT_MINIMUM = '2.32'

/** What this machine could upgrade git with, or why it cannot. */
export interface GitUpgradePlan {
  /** The command a person would run, as an argv the plugin spawns for them. */
  readonly argv: string[]
  /** The same command as one line, for the dialog to show before anything runs. */
  readonly command: string
  /** How the upgrade reaches git, by mechanism, so the dialog can describe what it changes. */
  readonly by: 'winget' | 'brew' | 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | 'unknown'
}

/** The git version string a program reported, or undefined when it is not a git version at all. */
export function gitVersionOf(text: string): string | undefined {
  return /^git version (\S+)/i.exec(text.trim())?.[1]
}

/** Compare two dotted versions by their numeric parts; a Windows-specific suffix such as `.windows.1` is ignored. */
export function atLeast(version: string, minimum: string): boolean {
  const parts = (value: string): number[] => value.split(/[.\-+ ]/).flatMap(part => {
    const number = Number.parseInt(part, 10)
    return Number.isFinite(number) ? [number] : []
  })
  const [have, need] = [parts(version), parts(minimum)]
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    const [mine, theirs] = [have[index] ?? 0, need[index] ?? 0]
    if (mine !== theirs) return mine > theirs
  }
  return true
}

/**
 * The upgrade this machine offers for git, or `undefined` when the plugin knows no way to change it.
 * The plan names the package manager it found; finding none is a fact to report, not a failure to hide.
 */
export async function planUpgrade(): Promise<GitUpgradePlan | undefined> {
  /** A package manager this machine can run: its program, and the arguments that upgrade git through it. */
  const managers: readonly (GitUpgradePlan & { probe: string[] })[] = WINDOWS
    ? [{ by: 'winget', argv: ['winget', 'upgrade', '--id', 'Git.Git', '--exact', '--silent', '--accept-package-agreements',
      '--accept-source-agreements'], command: 'winget upgrade --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements',
    // winget reports a non-zero code when the package is absent, which is exactly what "not installed" means here.
    probe: ['winget', 'list', '--id', 'Git.Git', '--exact', '--accept-source-agreements'] }]
    : [{ by: 'brew', argv: ['brew', 'upgrade', 'git'], command: 'brew upgrade git', probe: ['brew', 'list', '--formula', 'git'] },
      { by: 'apt', argv: ['sudo', 'apt-get', 'install', '--only-upgrade', '-y', 'git'], command: 'sudo apt-get install --only-upgrade -y git',
        probe: ['apt-get', '--version'] },
      { by: 'dnf', argv: ['sudo', 'dnf', 'upgrade', '-y', 'git'], command: 'sudo dnf upgrade -y git', probe: ['dnf', '--version'] },
      { by: 'pacman', argv: ['sudo', 'pacman', '-Syu', '--noconfirm', 'git'], command: 'sudo pacman -Syu --noconfirm git',
        probe: ['pacman', '--version'] },
      { by: 'zypper', argv: ['sudo', 'zypper', 'update', '-y', 'git'], command: 'sudo zypper update -y git', probe: ['zypper', '--version'] },
      { by: 'apk', argv: ['sudo', 'apk', 'upgrade', 'git'], command: 'sudo apk upgrade git', probe: ['apk', '--version'] }]
  for (const manager of managers) {
    try {
      await exec(manager.probe[0]!, manager.probe.slice(1), { timeout: 20_000 })
      return { by: manager.by, argv: manager.argv, command: manager.command }
    } catch { /* This package manager is not on this machine; try the next. */ }
  }
  return undefined
}

/** What running the plan did, in the terms a dialog reports back. */
export interface UpgradeResult { readonly ok: boolean; readonly output: string }

/**
 * Run one upgrade plan as the operator, without a shell, and report what happened.
 *
 * This changes software on the machine. It is only ever called from the panel's explicit upgrade action, after the dialog has
 * shown `plan.command` and the person has confirmed it; the plugin cannot detect a git that needs upgrading and install one
 * on its own.
 */
export async function upgrade(plan: GitUpgradePlan, signal: AbortSignal): Promise<UpgradeResult> {
  try {
    const { stdout, stderr } = await exec(plan.argv[0]!, plan.argv.slice(1), { signal, timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, output: `${stdout}${stderr}`.trim().slice(-4000) }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || failure.message || String(error)
    return { ok: false, output: output.slice(-4000) }
  }
}
