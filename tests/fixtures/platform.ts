/**
 * Platform facts the tests read.
 *
 * Most of the Host behaves the same everywhere; what differs is the shell form of a shim, the spelling of the directory
 * list, and how a command name resolves. The cases that exercise a real `#!/bin/sh` wrapper, `tmux`/`ps`, or a `chmod`
 * permission mode need a POSIX host, and are skipped on Windows with `it.skipIf`, so a Windows run says which checks it
 * did not make. Cases that assert platform-specific *content* run everywhere and branch on `WINDOWS`.
 */
export const POSIX = process.platform !== 'win32'
/** True on Windows, where shims are `.cmd` batch files and the directory list is `Path` as often as `PATH`. */
export const WINDOWS = process.platform === 'win32'
