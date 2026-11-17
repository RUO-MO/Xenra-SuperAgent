/**
 * Pollable progress for a manual plugin reload.
 *
 * A reload can replace the very fiber that started it (a git install is removed and reinstalled; a linked install is
 * reconciled by HMR). In-memory progress would be lost with that fiber, so each stage is written to a small JSON file in the
 * plugin's own state directory. A fresh instance — or the still-running one — reads the same file, so the panel can follow
 * checking → removing/reloading → installing → done even across a restart.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InstallKind } from './update-check.ts'

export const RELOAD_STAGES = ['checking', 'reloading', 'removing', 'installing', 'done', 'failed'] as const
export type ReloadStage = typeof RELOAD_STAGES[number]

export interface ReloadProgress {
  /** Correlates a poll with the reload that was started. */
  readonly requestId: string
  readonly kind: InstallKind
  /** The current stage; `done` and `failed` are terminal. */
  readonly stage: ReloadStage
  /** The ordered stages this run goes through (a subset for a linked install; `failed` is never listed). */
  readonly steps: ReloadStage[]
  /** Short human-readable state, in the host's language; the panel localizes the stage keys themselves. */
  readonly message: string
  /** Optional extra line (a commit, a spec, a diagnostic). */
  readonly detail?: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly restartRequired?: boolean
}

/** The stages a given install kind passes through. */
export function stepsFor(kind: InstallKind): ReloadStage[] {
  return kind === 'git' ? ['checking', 'removing', 'installing', 'done']
    : kind === 'linked' ? ['checking', 'reloading', 'done'] : ['checking', 'done']
}

function file(stateDir: string): string { return join(stateDir, 'reload-progress.json') }

/** Read the last reload's progress, or undefined when none has been started. */
export function readProgress(stateDir: string): ReloadProgress | undefined {
  try { return JSON.parse(readFileSync(file(stateDir), 'utf8')) as ReloadProgress }
  catch { return undefined }
}

function write(stateDir: string, value: ReloadProgress): void {
  try {
    mkdirSync(dirname(file(stateDir)), { recursive: true, mode: 0o700 })
    const temp = `${file(stateDir)}.tmp`
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    renameSync(temp, file(stateDir))
  } catch { /* Progress is advisory; a failed write must never fail the reload itself. */ }
}

/** Begin a run, clearing any previous progress. */
export function startProgress(stateDir: string, requestId: string, kind: InstallKind): ReloadProgress {
  const at = new Date().toISOString()
  const value: ReloadProgress = { requestId, kind, stage: 'checking', steps: stepsFor(kind),
    message: 'Checking the installation', startedAt: at, updatedAt: at }
  write(stateDir, value)
  return value
}

/** Advance to a stage, keeping the record correlated with the same run. */
export function advanceProgress(stateDir: string, requestId: string, stage: ReloadStage,
  { message, detail }: { message: string; detail?: string } = { message: stage }): void {
  const current = readProgress(stateDir)
  if (!current || current.requestId !== requestId) return
  write(stateDir, { ...current, stage, message, ...detail === undefined ? {} : { detail }, updatedAt: new Date().toISOString() })
}

/** Finish a run successfully; `restartRequired` is surfaced as a distinct final hint. */
export function finishProgress(stateDir: string, requestId: string, { message, detail, restartRequired }: {
  message: string; detail?: string; restartRequired: boolean
}): void {
  const current = readProgress(stateDir)
  if (!current || current.requestId !== requestId) return
  write(stateDir, { ...current, stage: 'done', message, ...detail === undefined ? {} : { detail }, restartRequired,
    updatedAt: new Date().toISOString() })
}

/** Finish a run with a failure. */
export function failProgress(stateDir: string, requestId: string, message: string): void {
  const current = readProgress(stateDir)
  if (!current || current.requestId !== requestId) return
  write(stateDir, { ...current, stage: 'failed', message, updatedAt: new Date().toISOString() })
}
