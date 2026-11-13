/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { WINDOWS, pathKey, resolveExecutable, spawnArgv } from './platform.ts'
import { GIT_MINIMUM, gitVersionOf } from '../app/git-upgrade.ts'

const MARKER = '# Written by xenra-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-superagent`, `dsh-tag`, `dsh-go`, `dsh-freelancer`), which `xenra-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-superagent', 'dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
/**
 * Quote a path for a git configuration value. Git for Windows runs a `!` helper through its bundled `sh`, where a backslash
 * is an escape character, so a Windows path is written with forward slashes; other platforms keep it as is.
 */
/**
 * A path as the worker git configuration writes it. Git for Windows runs a `!` helper through its bundled `sh`, where a
 * backslash is an escape character, so a Windows path is written with forward slashes; other platforms keep it as is.
 * The value written and the value `verifyEnvironment` expects both come from here, so they cannot drift.
 */
const helperPath = (value: string): string => WINDOWS ? value.replaceAll('\\', '/') : value
const gitQuote = (value: string): string => `"${helperPath(value).replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(helperPath(cli))} auth git-credential`
/** Quote one argument for a Windows batch file, which `cmd.exe` re-parses: a value with spaces or quotes is wrapped and its quotes doubled. */
const batchQuote = (value: string): string => /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 *
 * These are handed to a child process, never assigned to `process.env`: the plugin shares a process with DSH's other Sessions
 * and with the operator's own terminals, and a process-wide `GIT_CONFIG_GLOBAL` would change their git too.
 *
 * Nothing here writes, replaces or deletes a configuration file the machine already had. The worker reads its own
 * `GIT_CONFIG_GLOBAL`, and because that file redirects only github.com, a credential helper for any other host is still found
 * through the layers git reads anyway. `GIT_CONFIG_NOSYSTEM` stays: without it, a system-wide helper such as Git Credential
 * Manager answers for github.com before the worker's own file does, handing the agent the operator's real token — which is
 * exactly the leak this isolation exists to prevent.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    // The worker's own configuration decides github.com; the machine's system configuration never supplies its credentials.
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/**
 * True when a regular file starts with the xenra-superagent marker in its first two lines; a symbolic link, directory, or
 * other non-regular file never counts as written by xenra-superagent.
 *
 * A Windows batch shim carries the marker on a `REM` line, since that is the only comment a `.cmd` file has, so the
 * marker is read with or without that prefix. Both forms therefore count, and a shim left by the other platform is
 * replaced rather than rejected.
 */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.trim().replace(/^REM +/i, '').replace(/\r$/, ''))
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to
 * overwrite foreign files.
 *
 * A shim is a small wrapper that strips the shim directory from the child's directory list before running the real
 * program, so a wrapper script that resolves `gh` or `lark-cli` by name reaches the binary instead of the shim again. A
 * blocked name is a shim that only prints why it is refused, which is how the configured `blockedCommands` are enforced.
 *
 * The form follows the platform: a POSIX host gets `#!/bin/sh` scripts, and a Windows host gets `.cmd` batch files, since
 * Windows cannot execute a shell script and a program is found through its PATHEXT extension. Both are written with the
 * same marker, so `written` recognises either, and a shim written by the other platform is replaced rather than rejected.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  // The file a command name takes on this platform: `gh.cmd` on Windows, where a bare `gh` cannot run a batch file.
  const suffix = (name: string): string => WINDOWS && !/\.(?:cmd|bat|exe|com|ps1)$/i.test(name) ? `${name}.cmd` : name
  const shim = async (name: string, body: string): Promise<void> => {
    const file = suffix(name)
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    await writeFile(temporary, `${header()}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, file))
    kept.add(file)
  }
  const header = (): string => WINDOWS ? `@echo off\r\nREM ${MARKER}` : `#!/bin/sh\n${MARKER}`
  // Strip the shim directory from the child's list so a wrapper resolving the command by name cannot reach the shim again.
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  // A Windows batch file cannot `exec`, and `cmd.exe` cannot edit its own environment from inside a `for` loop without
  // delayed expansion, so the shim removes its own directory from the list by literal substitution and then `call`s the
  // program. Both substitutions cover the directory being first, last, or the only entry.
  const runWindows = (program: string): string => [
    `set "XENRA_SHIM=${dir}"`,
    'set "PATH=%PATH:%XENRA_SHIM%;=%"',
    'set "PATH=%PATH:;%XENRA_SHIM%=%"',
    `if /I "%PATH%"=="%XENRA_SHIM%" set "PATH="`,
    `call ${batchQuote(program)} %*`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n')
  const run = (program: string): string => WINDOWS ? runWindows(program) : `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => WINDOWS
    ? [`>&2 echo ${batchQuote(message)}`, 'exit /b 1'].join('\r\n')
    : `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    // No blanket `[credential] helper =`: emptying the helper list is what stripped every other host's credentials, so a
    // codeup or GitLab remote the machine could still reach stopped authenticating while this file was in effect. Only
    // github.com is redirected below; every other host keeps whatever helper the machine already had.
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/**
 * Removes the files this plugin wrote into `stateDir`, so uninstalling it leaves nothing behind that another tool — or a
 * later run of git — could pick up.
 *
 * Only what xenra-superagent wrote is removed. A file it did not write stays, and the directory stays whenever anything is
 * left in it, because a state directory a person chose may also hold their own work: deleting it wholesale would be the same
 * mistake as overwriting a foreign `worker-gitconfig`. The database is named explicitly rather than the whole directory being
 * removed, so an unknown file is kept and reported instead of silently destroyed.
 * @returns the paths that were removed, and those that were kept because xenra-superagent did not write them.
 */
export async function removeState(stateDir: string): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = []
  const kept: string[] = []
  // The shims directory and the git configuration are ours; the database is ours by name; anything else is not.
  const ours = [workerBin(stateDir), workerGitConfig(stateDir), join(stateDir, 'orchestrator.sqlite')]
  for (const path of ours) {
    if (!existsSync(path)) continue
    try { await lstat(path) } catch { continue }
    const dir = (await lstat(path)).isDirectory()
    // A file is removed only when it carries our marker; a directory of shims is ours as a whole, since it holds only shims.
    if (!dir && !await written(path).catch(() => false)) { kept.push(path); continue }
    await rm(path, { recursive: dir, force: true })
    removed.push(path)
  }
  // The SQLite side files belong to the database we just removed.
  for (const suffix of ['-shm', '-wal']) {
    const path = join(stateDir, `orchestrator.sqlite${suffix}`)
    if (!existsSync(path)) continue
    await rm(path, { force: true })
    removed.push(path)
  }
  // A directory that still holds something a person put there is theirs, so it is left in place along with its contents.
  if (existsSync(stateDir) && (await readdir(stateDir)).length === 0) await rm(stateDir, { recursive: false, force: true })
  return { removed, kept }
}

/**
 * The environment a worker program runs under: the agent's git variables over the caller's, with the worker shim directory
 * first on the directory list.
 *
 * This is deliberately a value handed to one child process, never assigned to `process.env`. DSH runs every Session, and the
 * operator's own terminals, inside this one process; a process-wide `GIT_CONFIG_GLOBAL` pointing at the worker's
 * GitHub-redirected configuration breaks the credential helper of every other host for every Session it reaches. `Commands`
 * and `runAsWorker` already merge this into each program they start, which is the only place it is needed.
 */
export function workerEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string,
  env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...variables, [pathKey(env)]: [workerBin(stateDir), path].filter(Boolean).join(delimiter) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal,
  env?: NodeJS.ProcessEnv): Promise<string> {
  // A Windows batch file is not an image Node can start, so it runs through `cmd.exe`; `spawnArgv` leaves other programs alone.
  const handle = subprocess.spawn({ argv: spawnArgv(argv[0] ?? '', argv.slice(1)), cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/**
 * Verifies that worker git invocations resolve the deployment's GitHub credential helper.
 *
 * The diagnostic carries what git actually said and which git ran, because the usual cause is a git too old to read
 * `GIT_CONFIG_GLOBAL` — but a different git on `PATH`, or a wrapper that rewrites the value, looks the same from here, and
 * "needs git 2.32" without the version is a guess the operator cannot check.
 */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // The check runs the way a worker's git does, `GIT_CONFIG_GLOBAL` and all: without that environment git reads the operator's
  // own `~/.gitconfig`, so the answer says nothing about what the worker will do and reports a perfectly correct machine as
  // misconfigured. This is also the only place the worker environment is proved to work end to end. An `undefined` entry is a
  // tombstone that removes an ambient variable, so it is passed through rather than narrowed away.
  const environment: NodeJS.ProcessEnv = agentVariables(stateDir)
  const run = (argv: string[]): Promise<string> => runAsWorker(subprocess, argv, stateDir, AbortSignal.any([signal,
    AbortSignal.timeout(60_000)]), environment)
  // `-z` separates fields with NUL and never quotes paths.
  const expected = [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')
  const [helpers, version] = await Promise.all([
    run(['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper']).catch(() => ''),
    // A git that cannot even report its version is reported as unknown rather than failing the check with a TypeError.
    run(['git', '--version']).then(text => gitVersionOf(String(text ?? '')) ?? 'unknown').catch(() => 'unknown'),
  ])
  if (helpers === expected) return
  throw new SetupError('gitTooOld', { version, minimum: GIT_MINIMUM, actual: helpers.replaceAll('\0', ' | ').trim() || '(nothing)',
    expected: expected.replaceAll('\0', ' | ').trim() })
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
