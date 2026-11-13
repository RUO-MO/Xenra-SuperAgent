/**
 * The platform facts the Host adapts to: which shell runs a configured command, how PATH names an executable, and which
 * PATH variable a child reads. The worker shims, the setup probes, the prepare command and the subprocess launcher each
 * need one of them, and keeping them here means every caller answers the question the same way.
 */
import { constants, accessSync, realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'

/** True on Windows, where paths use `\`, the shell is `cmd.exe`, and a program may be named by a PATHEXT extension. */
export const WINDOWS = process.platform === 'win32'
/** The extensions Windows tries for a bare command name, most preferred first: a native image before a batch wrapper. */
const PATHEXT = ['.exe', '.com', '.bat', '.cmd', '.ps1']
/** A Windows batch file, which Node cannot start without a shell: `cmd.exe` has to interpret it. */
export const BATCH = /\.(?:cmd|bat)$/i

/**
 * Whether two paths name the same directory. A missing path is compared as written, so a directory that does not exist yet
 * still compares equal to itself.
 */
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}

/**
 * The environment key that names the directory list. Windows names variables case-insensitively, so a child given `PATH`
 * while its parent set `Path` sees one list, but replacing it needs the spelling the parent used.
 * @returns `PATH`, or whichever case of it `env` already holds.
 */
export function pathKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
}
/** The directory list the environment holds, read under whichever spelling this platform or parent used. */
export const pathValue = (env: NodeJS.ProcessEnv = process.env): string => env[pathKey(env)] ?? ''
/**
 * One environment override for the directory list.
 * @param value - the list to set.
 * @param env - the environment whose spelling of the key is matched.
 */
export const pathEnv = (value: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> => ({ [pathKey(env)]: value })

/**
 * The argv that runs one command line through the platform shell: `cmd /d /s /c` on Windows, `sh -c` elsewhere. The
 * `prepare` command and the Feishu event consumer both take a command line a person wrote, so they run under this.
 * @param command - the command line, written for that platform's shell.
 */
export function shellCommand(command: string): string[] {
  return WINDOWS
    // `/d` skips AutoRun, `/s` keeps the outer quotes so a quoted program path survives, and `/c` runs then exits.
    ? [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', command]
    : ['sh', '-c', command]
}

/**
 * The argv that starts one program. On Windows a batch file is not an image: `cmd.exe` has to interpret it, which is why
 * Node refuses one without a shell. Any other program is passed through unchanged.
 * @param program - absolute path or command name.
 * @param args - the program's arguments.
 */
export function spawnArgv(program: string, args: readonly string[]): string[] {
  return WINDOWS && BATCH.test(program) ? [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', program, ...args] : [program, ...args]
}

/** Whether `file` is a regular file this process may execute. Windows has no executable bit, so existing is the whole test. */
function executableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (!WINDOWS) accessSync(file, constants.X_OK)
    return true
  } catch { return false }
}

/**
 * The file a command name or absolute path resolves to, trying the platform's executable extensions.
 *
 * A bare name is looked up in each PATH directory but `exclude`, the worker shim directory, so a wrapper script resolving
 * `gh` or `lark-cli` by name reaches the real binary instead of the shim again.
 * @param name - a command name, or an absolute path.
 * @param path - the directory list to search for a name.
 * @param exclude - a directory to skip, which the worker shims occupy.
 * @returns the path of the executable file.
 * @throws when no candidate is an executable file.
 */
export function resolveExecutable(name: string, path: string, exclude?: string): string {
  if ((name.includes('/') || name.includes('\\')) && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  // The name as written comes first: a path that already names a file wins, and Windows only appends its own extensions
  // to a name that carries none.
  const names = WINDOWS && !extname(name) ? [name, ...PATHEXT.map(extension => name + extension)] : [name]
  const directories = isAbsolute(name) ? [''] : path.split(delimiter)
    .filter(entry => isAbsolute(entry) && !(exclude && sameDirectory(entry, exclude)))
  const candidates = isAbsolute(name) ? names : directories.flatMap(directory => names.map(entry => join(directory, entry)))
  for (const candidate of candidates) if (executableFile(candidate)) return candidate
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}
