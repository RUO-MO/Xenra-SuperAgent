// Workspace targets: the places a workbench request may act on, kept distinguishable from the one watched repository.
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { idFor, targetOf, targetProblem, TargetsConfigSchema, TargetSchema } from '../src/workspace/targets.ts'

const repository = (id: string, name: string, root = '') =>
  ({ id, kind: 'repository' as const, name, repository: name, root })
const directory = (id: string, root: string) => ({ id, kind: 'directory' as const, name: id, root })

it('keeps the two kinds apart, each carrying only what identifies it', () => {
  const parsed = TargetsConfigSchema.parse({ items: [
    { id: 'widgets', kind: 'repository', repository: 'acme/widgets' },
    { id: 'notes', kind: 'directory', root: 'D:\\notes' },
  ], selected: 'widgets' })
  expect(parsed.items[0]).toMatchObject({ kind: 'repository', repository: 'acme/widgets', root: '' })
  expect(parsed.items[1]).toMatchObject({ kind: 'directory', root: 'D:\\notes' })
  // A directory target has no repository field at all, so it cannot be mistaken for a repository with a blank name.
  expect(parsed.items[1]).not.toHaveProperty('repository')
  expect(targetOf(parsed, 'notes')).toMatchObject({ kind: 'directory' })
  expect(targetOf(parsed, 'absent')).toBeUndefined()
})

it('refuses a selection that names no registered target', () => {
  expect(() => TargetsConfigSchema.parse({ items: [directory('notes', 'D:\\notes')], selected: 'gone' })).toThrow()
  expect(() => TargetsConfigSchema.parse({ items: [directory('a', 'D:\\a'), directory('a', 'D:\\b')] })).toThrow()
  // A repository target needs owner/name; a directory target needs a path.
  expect(TargetSchema.safeParse({ id: 'x', kind: 'repository', repository: 'not a repo' }).success).toBe(false)
  expect(TargetSchema.safeParse({ id: 'x', kind: 'directory', root: '' }).success).toBe(false)
})

it('refuses a path that is relative, is the state directory, or nests inside another target', () => {
  // Paths are resolved by the platform running the tests, so the fixture uses `resolve` rather than a literal.
  const stateDir = resolve(tmpdir(), 'xenra-state')
  const inside = join(stateDir, 'nested')
  const outerRoot = resolve(tmpdir(), 'xenra-src')
  const innerRoot = join(outerRoot, 'widgets')

  expect(targetProblem(TargetSchema.parse(directory('notes', 'relative/notes')), stateDir, [])).toContain('absolute')
  // Pointing the agent at its own database, or at a parent of it, would let a request rewrite the installation.
  expect(targetProblem(TargetSchema.parse(directory('bad', stateDir)), stateDir, [])).toContain('state directory')
  expect(targetProblem(TargetSchema.parse(directory('bad', inside)), stateDir, [])).toContain('state directory')
  // Two targets covering the same files would make the same request act on different things.
  const outer = directory('outer', outerRoot)
  expect(targetProblem(TargetSchema.parse(directory('inner', innerRoot)), stateDir, [TargetSchema.parse(outer)]))
    .toContain('Overlaps')
  expect(targetProblem(TargetSchema.parse(outer), stateDir, [])).toBeUndefined()
  // A repository target with no root has no path to validate; one that names its local clone is checked the same way.
  expect(targetProblem(TargetSchema.parse(repository('widgets', 'acme/widgets')), stateDir, [])).toBeUndefined()
  const clone = resolve(tmpdir(), 'xenra-widgets')
  expect(targetProblem(TargetSchema.parse(repository('widgets', 'acme/widgets', clone)), stateDir, [])).toBeUndefined()
  expect(targetProblem(TargetSchema.parse(repository('widgets', 'acme/widgets', 'relative/clone')), stateDir, [])).toContain('absolute')
  expect(targetProblem(TargetSchema.parse(repository('widgets', 'acme/widgets', stateDir)), stateDir, [])).toContain('state directory')
})

it('derives a stable id from a name, avoiding the ones already taken', () => {
  expect(idFor('My Notes', [])).toBe('my-notes')
  expect(idFor('我的笔记', [])).toBe('target')
  expect(idFor('Widgets', ['widgets'])).toBe('widgets-2')
  expect(idFor('Widgets', ['widgets', 'widgets-2'])).toBe('widgets-3')
  expect(idFor('   ', [])).toBe('target')
})
