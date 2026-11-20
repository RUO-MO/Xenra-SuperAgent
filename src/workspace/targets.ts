/**
 * Workspace targets: the places a workbench request may act on.
 *
 * Two facts are deliberately separate, and this module owns only the second:
 *
 * - **What is watched** is a single deployment-level repository (`deployment.repository`). GitHub polling, PR correlation and
 *   channel links all read that one value, and keeping it single is what bounds the agent's attention.
 * - **What a request may act on** is a list of targets. A person can register several repositories and local directories,
 *   then pick one when writing a request in the workbench. Exactly one of the repository targets is the watched one; the
 *   rest are places work may be sent to, not places the agent listens to.
 *
 * A target is either a GitHub repository (`repository`) or a local directory (`directory`), and the two are kept
 * distinguishable everywhere: a repository target has no path, a directory target has no repository, and the panel shows
 * them as different kinds rather than one list of strings.
 */
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

export const TARGET_KINDS = ['repository', 'directory'] as const
export type TargetKind = typeof TARGET_KINDS[number]

/** `owner/name`, the same shape the GitHub Source validates. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** A slug used in persisted Trigger and thread ids, so it must not change once work refers to it. */
const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/**
 * One target. `kind` decides which of `repository` and `root` is meaningful; the other is absent, never empty, so a reader
 * cannot mistake a directory target for a repository with a blank name.
 */
export const TargetSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().regex(ID, 'Lowercase letters, digits and dashes'),
    kind: z.literal('repository'),
    name: z.string().trim().max(80).default(''),
    repository: z.string().trim().regex(REPOSITORY, 'owner/name'),
    /** The local clone this repository is checked out in, when the work should run there rather than in a fresh checkout. */
    root: z.string().trim().default(''),
  }).strict(),
  z.object({
    id: z.string().regex(ID, 'Lowercase letters, digits and dashes'),
    kind: z.literal('directory'),
    name: z.string().trim().max(80).default(''),
    root: z.string().trim().min(1, 'A local directory target needs a path'),
  }).strict(),
])
export type Target = z.infer<typeof TargetSchema>

export const TargetsConfigSchema = z.object({
  items: z.array(TargetSchema).refine(items => new Set(items.map(item => item.id)).size === items.length,
    'Duplicate target IDs').default([]),
  /**
   * The target a request acts on when none is named. It must name a registered target, so a console request can never fall
   * back to a target that was deleted.
   */
  selected: z.string().trim().default(''),
}).strict().refine(config => config.selected === '' || config.items.some(item => item.id === config.selected),
  { message: 'The selected target must be one of the registered targets', path: ['selected'] })
export type TargetsConfig = z.infer<typeof TargetsConfigSchema>

/** Whether a value names a usable target in `config`. */
export const targetOf = (config: TargetsConfig, id: string): Target | undefined => config.items.find(item => item.id === id)

/** Turns a display name into a usable id, adding a numeric suffix when it is taken. */
export function idFor(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'target'
  const stem = /^[a-z0-9]/.test(base) ? base : `t-${base}`
  if (!taken.includes(stem)) return stem
  for (let index = 2; index < 1000; index++) {
    const candidate = `${stem}-${index}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${stem}-${Date.now()}`
}

/**
 * Validates a target against the machine it will run on.
 * @returns a problem message, or undefined when the target is usable.
 */
export function targetProblem(target: Target, stateDir: string, others: readonly Target[]): string | undefined {
  // A repository target may omit its root (the prepare command creates a fresh checkout); either kind's root is the
  // workspace workers run in when it is present.
  const value = target.root.trim()
  if (!value) return undefined
  if (!isAbsolute(value)) return 'The path must be absolute'
  const root = resolve(value)
  // The agent must not be pointed at its own database, and two targets must not cover the same files by nesting.
  if (sameOrInside(stateDir, root)) return 'The state directory and its parents cannot be a target'
  for (const other of others) {
    if (other.id === target.id) continue
    const otherValue = other.root.trim()
    if (!otherValue || !isAbsolute(otherValue)) continue
    const otherRoot = resolve(otherValue)
    if (sameOrInside(otherRoot, root) || sameOrInside(root, otherRoot)) return `Overlaps the target ${other.id}`
  }
  return undefined
}

/** True when `inner` is `outer` or below it. */
function sameOrInside(outer: string, inner: string): boolean {
  const a = resolve(outer), b = resolve(inner)
  return b === a || b.startsWith(a.endsWith('/') || a.endsWith('\\') ? a : `${a}${separatorOf(a)}`)
}
const separatorOf = (path: string): string => path.includes('\\') && !path.includes('/') ? '\\' : '/'
