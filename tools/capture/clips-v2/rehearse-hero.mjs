// The existing hero's production-button performance is retained verbatim.
// Its hardcoded WO-2395/docs-media writes are redirected in memory to scratch;
// no out-of-lane file is edited, and no old public master is removed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, EVIDENCE, scratchFolder, sampleCpu, videoStrip } from './rehearse.mjs'
import { captureSourceProvenance } from '../lib/provenance.mjs'
import { stampBuild } from '../lib/scene-runner.mjs'

const scratch = scratchFolder(process.argv[2] || process.env.CLIP_OUTPUT_DIR)
const out = path.join(EVIDENCE, 'S01'); mkdirSync(out, { recursive: true })
const build = path.join(scratch, 'build'), take = path.join(scratch, 'take'), media = path.join(scratch, 'media')
const originalPath = path.join(ROOT, 'tools/capture/lib/hero-loop.mjs')
const original = readFileSync(originalPath, 'utf8')
const epoch = Date.now()
const result = { id: 'S01', source: captureSourceProvenance({ repoRoot: ROOT }), startedAt: new Date().toISOString(), status: 'running', helperSha256: createHash('sha256').update(original).digest('hex'), pageErrors: [], consoleErrors: [], adaptation: 'Unchanged hero UI actions. In-memory replacements redirect only ROOT resolution, imports, public output and evidence-root validation; added error receipts. Original 50x hero timing retained because outcome 1 asks to run this helper as it is.' }
try {
  result.cpu = await sampleCpu()
  process.env.HERO_CAPTURE_ANGLE ||= process.platform === 'win32' ? 'd3d11' : 'gl-egl'
  process.env.VITE_DEMO_BUILD = 'true'
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', build, '--emptyOutDir'], { cwd: ROOT, env: process.env, stdio: 'inherit' })
  result.build = stampBuild(build, ROOT)
  const replace = (text, from, to) => {
    if (!text.includes(from)) throw new Error('Hero helper changed; review I/O adapter: ' + from)
    return text.replace(from, to)
  }
  let adapted = original.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => `from '${pathToFileURL(path.resolve(path.dirname(originalPath), relative)).href}'`)
  adapted = replace(adapted, "from 'playwright'", `from '${import.meta.resolve('playwright')}'`)
  adapted = `import { sampleFrames } from '${pathToFileURL(path.join(ROOT, 'tools/capture/clips-v2/rehearse.mjs')).href}'; let finishRehearsalFrames;\n` + adapted
  adapted = replace(adapted, "fileURLToPath(new URL('../../../', import.meta.url))", JSON.stringify(ROOT))
  adapted = replace(adapted, "const output = path.join(repoRoot, 'docs/media')", `const output = ${JSON.stringify(media)}`)
  adapted = replace(adapted, "const evidenceRoot = path.join(repoRoot, 'src/tests/evidence/WO-2395')", `const evidenceRoot = ${JSON.stringify(scratch)}`)
  adapted = replace(adapted, "page.on('pageerror', error => errors.push(error.message))", "result.pageErrors = errors; result.consoleErrors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()) })")
  adapted = replace(adapted, "await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })", `await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 }); finishRehearsalFrames = await sampleFrames(page, ${JSON.stringify(scratch)}, ${JSON.stringify(out)})`)
  adapted = replace(adapted, "await page.locator('#liencam-splash').waitFor({ state: 'hidden' })", "await page.locator('#liencam-splash').waitFor({ state: 'hidden' }); result.renderer = await page.evaluate(() => { const gl = document.querySelector('.viewport-canvas canvas')?.getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(unknown)' })")
  adapted = replace(adapted, 'if (context) await context.close()', 'if (finishRehearsalFrames) await finishRehearsalFrames(); if (context) await context.close()')
  const { runHeroLoop } = await import('data:text/javascript;base64,' + Buffer.from(adapted).toString('base64'))
  const receipt = await runHeroLoop({ build, evidence: take, repoRoot: ROOT })
  Object.assign(result, receipt); result.status = 'PASS'
  if (receipt.consoleErrors.length) { result.status = 'BROKE-APP'; result.error = 'Application console errors: ' + receipt.consoleErrors.join('; ') }
} catch (e) {
  result.status = /ENOENT|ffmpeg|Executable doesn't exist|spawn.*ENOENT/.test(e.message) ? 'PLATFORM' : 'BROKE-SCRIPT'
  result.error = e.stack?.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'hero-output-adapter'); result.reproduce = 'FFMPEG_BIN=/path/to/arm64/ffmpeg node tools/capture/clips-v2/rehearse-hero.mjs'
  console.error(e.message)
} finally {
  try {
    const receipt = JSON.parse(readFileSync(path.join(take, 'run.json'), 'utf8'))
    result.actions = receipt.actions; result.stages = receipt.stages; result.transitions = receipt.transitions
    result.pageErrors = receipt.pageErrors || []; result.consoleErrors = receipt.consoleErrors || []
    if (result.pageErrors.length || result.consoleErrors.length) result.status = 'BROKE-APP'
    if (receipt.recording) result.strip = videoStrip(path.join(take, receipt.recording), scratch, out)
  } catch {}
  // sampleFrames preserves the full wall-time rehearsal strip, including a
  // failed action; the helper's edited 11-second PNG stays disposable.
  // These directories are newly created beneath our dedicated scratch folder.
  for (const dir of [build, take, media]) rmSync(dir, { recursive: true, force: true })
  result.runtimeSeconds = (Date.now() - epoch) / 1000
  writeFileSync(path.join(out, 'run.json'), JSON.stringify(result, null, 2) + '\n')
}
if (result.status !== 'PASS') process.exitCode = 1
