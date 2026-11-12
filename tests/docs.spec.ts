import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
/** A numbered document's stem, such as `001-domain`; `en` is set for its English counterpart `001-domain.en.md`. */
const NUMBERED = /^(\d{3})-[a-z0-9-]+?((?:\.en)?)\.md$/
const documents = readdirSync(DOCS).filter(name => NUMBERED.test(name)).sort()
/** The Chinese primary documents, which define the numbering and are listed in README. */
const numbered = documents.filter(name => !name.endsWith('.en.md'))
/** Every document in the repository, in either language. */
const entries = readdirSync(ROOT).filter(name => /^[A-Z][A-Za-z]*\.md$/.test(name)).sort()
const all = [...entries.map(name => join(ROOT, name)), ...documents.map(name => join(DOCS, name))]
const read = (path: string): string => readFileSync(path, 'utf8')
function links(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
/** The language counterpart of a document: `docs/001-domain.md` ↔ `docs/001-domain.en.md`. */
const counterpart = (file: string): string => file.endsWith('.en.md') ? file.slice(0, -6) + '.md' : file.slice(0, -3) + '.en.md'
/**
 * Extract repo-relative file paths from the first column of the table that lists `kind` files in a 007 Architecture
 * document. The headings are translated, so the table is found by the paths it cites rather than by its title. A
 * cell's first full path sets the directory that its following bare filenames inherit, as the tables are written.
 */
function listed(document: string, kind: 'src' | 'tests'): string[] {
  const lines = read(join(ROOT, document)).split('\n')
  const tableAt = (start: number): string[] => {
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
    // The first two rows are the header and its separator.
    return lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  }
  const rows = lines.flatMap((line, start) => line.startsWith('## ') && tableAt(start).some(row => row.includes(`\`${kind}/`)) ? [start] : [])
    .flatMap(start => tableAt(start))
  const inKind = (directory: string): boolean => directory === kind || directory.startsWith(`${kind}/`)
    return rows.flatMap(row => {
      let directory = ''
      // A cited file is backticked; prose in the cell is not. Paths are compared with `/`, as the documents write them.
      return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => name!)
        .flatMap(name => {
          if (name.includes('/')) {
            // A glob cites a family of files, such as `github*.ts`, rather than one path that must exist.
            if (name.includes('*')) return []
            if (!inKind(dirname(name))) return []
            if (!inKind(directory)) directory = dirname(name)
            return [name]
          }
          return inKind(directory) ? [`${directory}/${name}`] : []
        })
    })
}

describe('documentation', () => {
  it('numbers documents consecutively from 000', () => {
    expect(numbered.map(name => name.slice(0, 3))).toEqual(numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('gives every document an English counterpart, and every English counterpart a document', () => {
    const missing = all.map(path => relative(ROOT, path)).filter(path => !existsSync(join(ROOT, counterpart(path))))
    expect(missing).toEqual([])
    // A counterpart keeps the primary's name, so a rename updates both.
    const stems = all.map(path => counterpart(path).replace(/\.en\.md$/, '').replace(/\.md$/, ''))
    for (const stem of stems) expect(existsSync(`${stem}.md`) && existsSync(`${stem}.en.md`)).toBe(true)
  })
  it('links each language only to its own language', () => {
    // The language switch at the top is the one cross-language link a document may have.
    const violations = all.flatMap(file => links(file).flatMap(target => {
      const linked = resolve(dirname(file), target)
      if (!linked.endsWith('.md')) return []
      const englishSource = file.endsWith('.en.md')
      const englishTarget = linked.endsWith('.en.md')
      if (englishSource === englishTarget) return []
      return linked === counterpart(file) ? [] : [`${relative(ROOT, file)} → ${target}`]
    }))
    expect(violations).toEqual([])
  })
  it('links numbered documents only to earlier numbered documents', () => {
    // The language switch points at the same document in the other language, so it is not a forward link.
    const violations = documents.flatMap(name => links(join(DOCS, name)).flatMap(target => {
      const linked = resolve(DOCS, target)
      if (!linked.endsWith('.md')) return []
      if (linked === counterpart(join(DOCS, name))) return []
      const number = NUMBERED.exec(basename(linked))?.[1]
      return dirname(linked) === DOCS && number !== undefined && number < name.slice(0, 3) ? [] : [`${name} → ${target}`]
    }))
    expect(violations).toEqual([])
  })
  it('resolves every local link', () => {
    const missing = all.flatMap(file => links(file).filter(target => !existsSync(resolve(dirname(file), target)))
      .map(target => `${relative(ROOT, file)} → ${target}`))
    expect(missing).toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(all.filter(path => /^(<{7}|>{7}) /m.test(read(path))).map(path => relative(ROOT, path))).toEqual([])
  })
  it('states the other language at the top of every document', () => {
    // Each document names its counterpart early, so a reader lands in the right language.
    const missing = all.flatMap(file => {
      const head = read(file).split('\n').slice(0, 4).join('\n')
      const name = basename(counterpart(file))
      return head.includes(`](${name})`) ? [] : [relative(ROOT, file)]
    })
    expect(missing).toEqual([])
  })
  it('lists every module of src in the module table of 007 Architecture, in both languages, and only files that exist', () => {
    for (const document of ['docs/007-architecture.md', 'docs/007-architecture.en.md']) {
      const modules = listed(document, 'src')
      expect(files('src').filter(path => !modules.includes(path)), document).toEqual([])
      expect(modules.filter(path => !existsSync(join(ROOT, path))), document).toEqual([])
    }
  })
  it('lists every test in the test table of 007 Architecture, in both languages, and only files that exist', () => {
    for (const document of ['docs/007-architecture.md', 'docs/007-architecture.en.md']) {
      const tests = listed(document, 'tests')
      expect(files('tests').filter(path => /\.spec\.tsx?$/.test(path) && !tests.includes(path)), document).toEqual([])
      expect(tests.filter(path => !existsSync(join(ROOT, path))), document).toEqual([])
    }
  })
})
