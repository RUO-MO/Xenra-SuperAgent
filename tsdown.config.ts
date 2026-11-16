import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
/**
 * Strips the bundler's `//#region <path>` markers from the emitted files.
 *
 * Those markers name the resolved path of every bundled module, which for a bundled dependency is a pnpm store path such as
 * `node_modules/.pnpm/graceful-fs@4.2.11/...`. Two consequences, both bad: the artifact records how the build machine's
 * package store happens to be laid out, so the same sources build differently on another machine (and CI's "lib is current"
 * check fails over nothing but a version in a comment); and the published package advertises the builder's filesystem. The
 * markers carry no runtime meaning, so removing them makes the output reproducible.
 */
const stripRegions = { name: 'strip-regions', writeBundle() {
  for (const file of readdirSync('lib').filter(name => name.endsWith('.js'))) {
    const path = join('lib', file)
    const text = readFileSync(path, 'utf8')
    const stripped = text.replace(/^\/\/#region .*\r?\n/gm, '').replace(/^\/\/#endregion.*\r?\n/gm, '')
    if (stripped !== text) writeFileSync(path, stripped)
  }
} }
// Only DSH's own packages stay external: DSH provides them, and bundling a second copy of its runtime would split the
// service identity. `zod` and `proper-lockfile` are pure JavaScript with no native code, so they are bundled into `lib/`
// instead — a `link:` install resolves externals from the checkout's own node_modules, and a checkout without one installed
// made the plugin fail to import with `Cannot find module 'zod'`. Shipping them removes that failure mode for both ways of
// installing, and keeps the installed copy self-contained.
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
    workbench: 'src/sources/workbench.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, plugins: [stripRegions], deps: { neverBundle: [/^@deepseek-ai\//], alwaysBundle: ['zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw, stripRegions],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "xenra-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
