#!/usr/bin/env node
// Use the same store/Open/recompute/post boundary as Post Process Export.
// Chromium supplies the real worker, binary caches and stock-bounds viewport.
import { isMain } from '../lib/is-main.mjs';
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const DIALECTS = ['uccnc', 'grbl', 'grblhal', 'linuxcnc', 'generic']
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

export function discoverExamples(root = ROOT) {
  const examples = [], designSources = []
  for (const folder of readdirSync(path.join(root, 'examples')).filter(f => /^\d\d-/.test(f)).sort()) {
    for (const file of readdirSync(path.join(root, 'examples', folder)).filter(f => f.endsWith('.camproject')).sort()) {
      const source = `examples/${folder}/${file}`
      const project = JSON.parse(readFileSync(path.join(root, source), 'utf8'))
      // Auxiliary modeling sources are not machining examples: there is nothing
      // for Export to emit. List them explicitly instead of fabricating motion.
      if (!project.setups.some(s => s.operations.some(o => o.enabled))) {
        designSources.push({ source, name: project.name })
        continue
      }
      assert.match(project.name, new RegExp(`^${folder.slice(0, 2)} .+`), `${source}: expected NN Title`)
      const stem = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')
      examples.push({ folder, source, name: project.name, stem })
    }
  }
  assert.ok(examples.length, 'No machining examples found')
  assert.equal(new Set(examples.map(e => e.stem)).size, examples.length, 'Duplicate posted filenames')
  return { examples, designSources }
}

// Same WASM-only cross-drive rewrite as vite.config.mts; the isolated preview
// deliberately omits the desktop config and its controller broker.
export function crossDriveWasmUrl(url, root, installed) {
  if (root.slice(0, 2).toLowerCase() === installed.slice(0, 2).toLowerCase()) return url
  const prefix = ('/@fs/' + installed.replaceAll('\\', '/') + '/').toLowerCase()
  const pathname = url.split('?', 1)[0]
  return pathname.toLowerCase().startsWith(prefix) && pathname.toLowerCase().endsWith('.wasm')
    ? '/node_modules/' + url.slice(prefix.length) : url
}

export async function postAll({ check = false, overrides = {}, only } = {}) {
  const discovery = discoverExamples()
  // A private ephemeral Vite host avoids the desktop config's controller broker.
  // It serves this worktree's actual source; no dist or copied post engine.
  const server = await createServer({ root: ROOT, configFile: false,
    cacheDir: path.join(tmpdir(), `liencam-examples-vite-${process.pid}`),
    plugins: [{ name: 'liencam-examples-cross-drive-wasm', configureServer(server) {
      const installed = realpathSync(path.join(ROOT, 'node_modules'))
      server.middlewares.use((req, _res, next) => {
        req.url = crossDriveWasmUrl(req.url ?? '', ROOT, installed)
        next()
      })
    } }],
    server: { host: '127.0.0.1', port: 0,
      fs: { allow: [ROOT, realpathSync(path.join(ROOT, 'node_modules'))] } },
    define: { __APP_GIT_COMMIT__: JSON.stringify('examples'),
      __APP_GIT_BRANCH__: JSON.stringify('examples'), __APP_BUILD_DATE__: JSON.stringify('examples') },
    optimizeDeps: { entries: ['index.html'] },
  })
  let browser
  const files = [], differences = []
  try {
    await server.listen()
    const address = server.httpServer.address()
    browser = await chromium.launch({ headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    for (const example of discovery.examples.filter(e => !only || only.includes(e.folder))) {
      console.log(`Posting ${example.name}`)
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
      try {
        const page = await context.newPage()
        // The first navigation waits for Vite's cold dependency scan (fresh cacheDir per run).
        await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded', timeout: 300_000 })
        await page.getByRole('button', { name: 'New project', exact: true }).waitFor({ timeout: 120_000 })
        const json = readFileSync(overrides[example.folder] ?? path.join(ROOT, example.source), 'utf8')
        const posted = await page.evaluate(async ({ json, dialects, version, title }) => {
          const { useCamStore } = await import('/src/store/index.ts')
          const post = await import('/src/lib/post/index.ts')
          await useCamStore.getState().loadProjectFromFile(json)
          if (useCamStore.getState().project.id !== JSON.parse(json).id) throw new Error('File Open did not load the example')
          await useCamStore.getState().verifyModelReferences()
          const restores = []
          try {
            for (const setup of useCamStore.getState().project.setups) {
              const staged = await useCamStore.getState().stageOperationsForEmission(setup.id, undefined)
              restores.push(staged.restore)
            }
            const state = useCamStore.getState()
            const project = { ...state.project, toolLibrary: state.toolLibrary }
            const configs = { uccnc: post.UCCNC_CONFIG, grbl: post.GRBL_CONFIG,
              grblhal: post.GRBLHAL_CONFIG, linuxcnc: post.LINUXCNC_CONFIG, generic: post.GENERIC_CONFIG }
            return dialects.map(id => {
              const original = configs[id]
              const header = `LienCAM ${version} - ${title} - ${id}`
              const comment = original.capabilities.comment === 'semicolon' ? `; ${header}` : `(${header})`
              const config = { ...original, framing: { ...original.framing,
                programStart: [comment, ...original.framing.programStart] } }
              const result = post.postProject(project, project.setups, config, {
                mode: 'combined', pauseBetweenSetups: true, baseName: title, ext: 'nc',
                modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad,
              })
              if (!result.ok) throw new Error(`${title}-${id}.nc: ${JSON.stringify(result.diagnostics)}`)
              const expected = project.setups.flatMap(s => s.operations.filter(o => o.enabled).map(o => o.id))
              const emitted = [...new Set(result.combined.operationSpans.map(s => s.opId))]
              if (JSON.stringify(emitted) !== JSON.stringify(expected)) throw new Error(`${title}-${id}.nc: omitted operations`)
              if (!result.combined.gcode.trim()) throw new Error(`${title}-${id}.nc: empty output`)
              return { dialect: id, gcode: result.combined.gcode, operations: expected.length }
            })
          } finally { restores.reverse().forEach(restore => restore()) }
        }, { json, dialects: DIALECTS, version, title: example.name })
        for (const output of posted) {
          const filename = `${example.stem}-${output.dialect}.nc`
          const file = path.join(ROOT, 'examples/gcode', filename)
          const bytes = Buffer.from(output.gcode, 'utf8')
          if (check) {
            if (!existsSync(file) || !readFileSync(file).equals(bytes)) differences.push(filename)
          } else {
            mkdirSync(path.dirname(file), { recursive: true })
            writeFileSync(file, bytes)
          }
          files.push({ filename, operations: output.operations, bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') })
        }
      } finally { await context.close() }
    }
    const expected = files.map(f => f.filename).sort()
    const actual = readdirSync(path.join(ROOT, 'examples/gcode')).filter(f => f.endsWith('.nc')).sort()
    if (!only && JSON.stringify(actual) !== JSON.stringify(expected)) differences.push('examples/gcode/: unexpected or missing files')
    return { ...discovery, version, files, differences }
  } finally { await browser?.close(); await server.close() }
}

if (isMain(import.meta.url)) {
  const result = await postAll({ check: process.argv.includes('--check'),
    overrides: JSON.parse(process.env.LIENCAM_EXAMPLE_OVERRIDES || '{}'),
    only: process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : undefined })
  console.log(`WO2383_RESULT=${JSON.stringify(result)}`)
  if (result.differences.length) {
    console.error(`Posted examples differ: ${result.differences.join(', ')}`)
    process.exitCode = 1
  }
}
