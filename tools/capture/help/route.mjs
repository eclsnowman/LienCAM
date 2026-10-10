// Replay the recorded Help routes without writing into another order's evidence.
// Generated adapters are disposable; the source route and its hash are recorded.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { demoProject } from './demo-project.mjs'

const [lane, script, ...args] = process.argv.slice(2)
if (!/^WO-(2129|2130|2131|2132|2133|2134|2135|2252)$/.test(lane)) throw new Error('Unknown route lane')
const root = process.cwd()
const original = path.join(root, 'src/tests/evidence', lane)
const output = path.join(root, 'src/tests/evidence/WO-2491/routes', lane)
const generated = path.join(output, 'generated')
fs.mkdirSync(generated, { recursive: true })
for (const asset of ['fixtures', 'Shop endmills.json', 'Engraving.json']) {
  const src = path.join(original, asset)
  if (fs.existsSync(src)) fs.cpSync(src, path.join(output, asset), { recursive: true })
}
// WO-2708: the help demo is today's Full Suite example; follow its name and
// setup count instead of the retired "Full Suite Test" (5 setups, one empty).
const demo = JSON.parse(fs.readFileSync(demoProject, 'utf8'))
// WO-2708 publish guard. A lane's publisher turns pictures its shooter wrote
// into public/help. It may only publish a picture shot in THIS run: a shooter
// run records the lane's run start; a publisher refuses outright without one,
// and refuses any lane picture older than it (e.g. a committed picture that a
// failed shoot left in place). One capture run = one CAPTURE_RUN_ID (sweep.mjs
// sets it for its children); without one, each shooter run starts a new run.
const PUBLISHERS = { 'WO-2130': 'make-pictures.mjs', 'WO-2133': 'pictures.mjs', 'WO-2134': 'publish.mjs', 'WO-2135': 'make-pictures.mjs' }
const stampPath = path.join(output, 'shoot-run.json')
const runId = process.env.CAPTURE_RUN_ID || null
const publisher = PUBLISHERS[lane] === script
let stamp = fs.existsSync(stampPath) ? JSON.parse(fs.readFileSync(stampPath, 'utf8')) : null
if (publisher) {
  if (!stamp || (runId && stamp.runId !== runId)) {
    console.error(`PUBLISH REFUSED: ${lane} ${script}: no ${lane} shoot ran in this capture run${runId ? ` (${runId})` : ''}; nothing published`)
    process.exit(1)
  }
} else if (!stamp || !runId || stamp.runId !== runId) {
  stamp = { runId, startedAtMs: Date.now(), startedAt: new Date().toISOString(), script, args }
  fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n')
}
// Every sharp() input under this lane's folder must be younger than the run.
const freshGuard = (code) => code.replace(/^import sharp from 'sharp'$/m, [
  "import __sharp from 'sharp'",
  "import { statSync as __statSync } from 'node:fs'",
  `const __LANE = ${JSON.stringify(output)}, __RUN = ${stamp.startedAtMs}`,
  "const __fresh = (input) => {",
  "  if (typeof input !== 'string' || !input.startsWith(__LANE)) return input",
  "  const m = __statSync(input).mtimeMs",
  "  if (m < __RUN) throw new Error(`PUBLISH REFUSED: ${input} was not shot in this run (written ${new Date(m).toISOString()}, run started ${new Date(__RUN).toISOString()})`)",
  "  return input",
  "}",
  "const sharp = Object.assign((input, ...rest) => __sharp(__fresh(input), ...rest), __sharp)",
].join('\n'))
const records = []
const names = fs.readdirSync(original).filter(n => n.endsWith('.mjs'))
for (const name of names) {
  const src = path.join(original, name)
  const raw = fs.readFileSync(src, 'utf8')
  records.push({ path: path.relative(root, src), sha256: createHash('sha256').update(raw).digest('hex') })
  let code = raw
    .replace(/dirname\(fileURLToPath\(import\.meta\.url\)\)/g, JSON.stringify(output))
    .replace(/(?:path\.)?resolve\(HERE, '\.\.\/\.\.\/\.\.\/\.\.'\)/g, 'process.cwd()')
    .replaceAll('src/tests/evidence/' + lane + '/', 'src/tests/evidence/WO-2491/routes/' + lane + '/')
    .replace(/width: (?:1440|1600), height: (?:900|950|1000)/g, 'width: 1920, height: 1080')
    .replace(/viewport: tall \? \{ width: 1400, height: 1900 \} : \{ width: 1920, height: 1080 \}/g, 'viewport: { width: 1920, height: 1080 }')
    .replace("chromium.launch()", "chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })")
    .replaceAll('Example Projects/Full_Suite_Test.camproject', demoProject)
    .replaceAll('Example Projects/Full Suite.camproject', demoProject)
    .replace("path.join(REPO_ROOT, 'Example Projects', 'Full_Suite_Test.camproject')", `path.resolve(${JSON.stringify(demoProject)})`)
    .replace("path.join(REPO_ROOT, 'Example Projects', 'Full Suite.camproject')", `path.resolve(${JSON.stringify(demoProject)})`)
    // WO-2546 renamed the GOOD corpus example; same file, plain name.
    .replaceAll('Example Projects/GOOD-Corpus-2026-08-23.camproject', 'Example Projects/Adaptive Clearing Shapes.camproject')
  if (lane === 'WO-2134') {
    code = code.replaceAll("'Full Suite Test'", JSON.stringify(demo.name))
      .replace('loaded.setups !== 5', `loaded.setups !== ${demo.setups.length}`)
  }
  // WO-2700: the plain Model tab now opens the New Model dialog. These lanes
  // picture a fresh model, so take the operator's Create Model route.
  if (lane === 'WO-2252' && name === 'pictures.mjs') {
    code = code.replace(`await page.click('[data-testid="mode-tab-part"]')`, `await page.click('[data-testid="mode-tab-part"]')\n  await page.click('[data-testid="model-entry-new"]')`)
    // WO-2503 folds "Form - start from" at an edit when the rail overflows.
    // The operator unfolds it (its header chevron) before picking a starter.
    code = code.replace(/await page\.click\('\[data-testid="form-starter-(\w+)"\]'\)/g, (_, kind) =>
      `{ const unfold = page.locator('[data-testid="workbench-rail-collapse-form-create"][aria-expanded="false"]'); if (await unfold.count()) await unfold.click(); await page.click('[data-testid="form-starter-${kind}"]') }`)
    // WO-2704: Help's "Open this example" asks Save / Discard / Cancel when the
    // current (fresh) model holds unsaved work. The operator discards it.
    code = code.replace(`await page.click('[data-testid="help-open-example"]')`, `await page.click('[data-testid="help-open-example"]')\n  { const discard = page.getByTestId('confirm-dialog-alt').filter({ hasText: /^Discard$/ }); await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {}) }`)
  }
  if (lane === 'WO-2132' && name === 'lib.mjs') {
    code = code.replace("await page.getByTestId('mode-tab-part').click({ timeout: 60_000 })", "await page.getByTestId('mode-tab-part').click({ timeout: 60_000 })\n    await page.getByTestId('model-entry-new').click({ timeout: 60_000 })")
  }
  code = freshGuard(code)
  if (lane === 'WO-2133' && name === 'walk.mjs') {
    code = code.replace('await page.goto(server.base)', "await page.goto(server.base, { waitUntil: 'domcontentloaded', timeout: 120000 })")
    code = code.replaceAll('.click()', '.click({ force: true })').replaceAll('.check()', '.check({ force: true })')
    code = code.replace('if (target) await target.screenshot({ path })', "if (target) { const clip = await target.boundingBox(); if (!clip) throw new Error('Capture target absent'); await page.screenshot({ path, clip, animations: 'disabled' }) }")
    // These two diagnostic shots photograph an expanded native select across
    // the entire scroll panel. The final Help shot below uses its actual bounds.
    code = code.replace("await shot('71-membership-rows', tree)", '/* final bounded membership capture below */')
      .replace("await shot('72-membership-open', tree)", '/* final bounded membership capture below */')
    code = code.replace("await shot('61-workholding-on')", "await page.waitForTimeout(5000)")
      .replaceAll('else await page.screenshot({ path })', "else await page.screenshot({ path, animations: 'disabled', timeout: 120000 })")
      .replace('else if (target) await target.screenshot({ path })', "else if (target) await target.screenshot({ path, animations: 'disabled', timeout: 120000 })")
  }
  if (lane === 'WO-2132' && name === 'pictures.mjs') {
    code = code.replaceAll("page.locator('[data-testid=\"console-strip\"]:visible').click()", "page.locator('[data-testid=\"console-strip\"]:visible').click({ force: true })")
  }
  if (lane === 'WO-2130' && name === 'walk.mjs') {
    // The excluded third-party mesh must never enter a public Help scene.
    code = code.replace('src/tests/mesh/fixtures/obj_1_Platte C.stl', 'src/tests/mesh/fixtures/prismatic-plate.stl')
  }
  if (lane === 'WO-2131' && name === 'capture.mjs') {
    code = code.replace('if (l) l.scrollTop = l.scrollHeight', 'if (l) { l.style.maxHeight = "none"; l.style.overflow = "visible"; l.scrollTop = 0 }')
    code = code.replace('const clip = union(sb, { x: vp.x, y: sb.y - 40, width: 1, height: sb.height + 120 })', "const clip = union(await box(page, '.sketch-toolbox'), vp)")
  }
  if (lane === 'WO-2133' && name === 'walk.mjs') {
    code = code.replace("await page.locator('.tree-geo-stock-select').first().click()", "await page.locator('.tree-geo-stock-select').first().click(); await page.keyboard.press('Escape')")
    code = code.replace("await pic('stock-membership', 'membership-dropdown', null, { x: tb.x, y: gh.y, width: tb.width, height: sh.y - gh.y })", "const first = page.locator('.tree-geo-stock-select').first(); await first.evaluate(el => { el.size = el.options.length; el.style.height = (el.options.length * 24 + 8) + 'px'; el.style.maxWidth = 'none'; el.style.width = '240px'; el.style.fontSize = '12px'; el.style.padding = '4px'; el.style.display = 'block'; const actions = el.closest('.tree-item-geo-actions'); actions.style.flexWrap = 'wrap'; const owner = el.parentElement; owner.style.flexBasis = '100%'; owner.style.height = el.style.height; }); await page.waitForTimeout(200); const expanded = await first.boundingBox(); const bottom = await setupsHeader.boundingBox(); await pic('stock-membership', 'membership-dropdown', null, { x: tb.x, y: gh.y, width: tb.width, height: bottom.y - gh.y })")
  }
  if (lane === 'WO-2132' && name === 'lib.mjs') {
    // killTree only knew taskkill.exe: off Windows the walk's Vite server
    // outlived the walk and the route never exited after its last picture.
    code = code.replace("try { spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F']) } catch { /* gone */ }",
      "if (process.platform === 'win32') { try { spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F']) } catch { /* gone */ } } else { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }")
  }
  if (lane === 'WO-2135' && name === 'make-pictures.mjs') {
    // A missing comparison input must not discard the independently completed
    // Post and Nest captures below it. compare.mjs lists the missing slot.
    code = code.replace('const view =', 'try {\nconst view =').replace('// Post Process: the dialog itself.', '} catch (error) { console.error("Engine comparison not published:", error.message) }\n// Post Process: the dialog itself.')
  }
  if (lane === 'WO-2135' && name === 'walk.mjs') {
    code = code.replace("await crop(page.locator('.modal-container').first(), 'settings-engine')", "await page.screenshot({ path: path.join(CROPS, 'settings-engine.png'), animations: 'disabled' })")
  }
  // Resolve shared imports read-only; lane-local imports use the relocated copy.
  code = code.replace(/(['"])(\.\.?\/[^'"\n]+)\1/g, (match, quote, spec) => {
    const abs = path.resolve(original, spec)
    if (!fs.existsSync(abs) || !/\.(mjs|js)$/.test(abs)) return match
    const target = path.dirname(abs) === original ? path.join(generated, path.basename(abs)) : abs
    return quote + pathToFileURL(target).href + quote
  })
  fs.writeFileSync(path.join(generated, name), code)
}
fs.writeFileSync(path.join(output, 'route-sources.json'), JSON.stringify({ viewport: [1920, 1080], records }, null, 2) + '\n')
const result = spawnSync(process.execPath, [path.join(generated, script), ...args], { stdio: 'inherit', cwd: root })
process.exitCode = result.status ?? 1
