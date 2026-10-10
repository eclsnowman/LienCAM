// WO-2710: the P2 wiki picture gaps (docs/launch/WIKI-IMAGE-AUDIT-1009.md,
// "Capture plan assignment"), shot from a PRODUCTION build served by
// `vite preview`, through the real UI only (clicks, typing and the browser's
// own file pickers - no store writes, no test hooks, no hand-built payloads).
// Control gaps use the built-in simulator only - never a board.
//
//   node tools/capture/wiki-gaps/p2.mjs --all              build + shoot every gap + contact sheet + publish
//   node tools/capture/wiki-gaps/p2.mjs --only=G11,C-4     just those gaps (no publish)
//   flags: --skip-build (reuse dist/ and dist-demo/), --no-publish, --port=47210
//
// Idempotent: candidates are deleted before they are re-made; publish copies
// only pictures shot in THIS run (same CAPTURE_RUN_ID) into public/help and
// docs/wiki/images.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { OUT, EVIDENCE, ROOT, build, buildIdentity, preview, launch, openApp, waitForCpu } from './p2-lib.mjs'
import { GAPS as CONTROL_GAPS } from './p2-gaps.mjs'
import { CAM_GAPS } from './p2-gaps-cam.mjs'
import { publish } from './p2-publish.mjs'

const GAPS = { ...CONTROL_GAPS, ...CAM_GAPS }
const argv = process.argv.slice(2)
const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=')
const all = argv.includes('--all')
const only = arg('only').split(',').filter(Boolean)
const skipBuild = argv.includes('--skip-build')
const doPublish = all && !argv.includes('--no-publish')
const port = Number(arg('port') || 47210)
if (!all && !only.length) {
  console.log('usage: node tools/capture/wiki-gaps/p2.mjs --all | --only=G11,C-4 [--skip-build] [--no-publish]')
  console.log('gaps:', Object.keys(GAPS).join(' '))
  process.exit(2)
}
const unknown = only.filter((g) => !GAPS[g])
if (unknown.length) throw new Error('unknown gap(s): ' + unknown.join(','))
const selected = all ? Object.keys(GAPS) : only
const runId = process.env.CAPTURE_RUN_ID || `wo2710-${new Date().toISOString().replace(/[:.]/g, '-')}`
const runStartMs = Date.now()
console.log('CAPTURE_RUN_ID', runId, 'gaps', selected.join(' '))

const needDemo = selected.some((g) => GAPS[g].demoBuild)
const needRelease = selected.some((g) => !GAPS[g].demoBuild)
if (!skipBuild) {
  if (needRelease) build({ outDir: 'dist' })
  if (needDemo) build({ outDir: 'dist-demo', demo: true })
}

const results = []
for (const [outDir, demo] of [['dist', false], ['dist-demo', true]]) {
  const gaps = selected.filter((g) => !!GAPS[g].demoBuild === demo)
  if (!gaps.length) continue
  const buildId = buildIdentity(outDir)
  const server = await preview({ outDir, port: port + (demo ? 1 : 0) })
  try {
    for (const gap of gaps) {
      await waitForCpu()
      const browser = await launch()
      const started = Date.now()
      let h
      try {
        h = await openApp(browser, server.baseUrl, { gap, runId, buildId, route: `node tools/capture/wiki-gaps/p2.mjs --only=${gap}` })
        await h.goto()
        await GAPS[gap].run(h)
        if (h.errors.length) throw new Error('browser errors: ' + JSON.stringify(h.errors))
        results.push({ gap, ok: true, pictures: h.pictures, seconds: Math.round((Date.now() - started) / 1000) })
        console.log('[ok]', gap, h.pictures.join(' '))
      } catch (error) {
        if (h) await h.debug('failure').catch(() => {})
        results.push({ gap, ok: false, error: String(error?.message || error).slice(0, 2000), seconds: Math.round((Date.now() - started) / 1000) })
        console.error('[FAIL]', gap, error?.message || error)
      } finally {
        await browser.close()
      }
    }
  } finally {
    server.stop()
  }
}

fs.writeFileSync(path.join(EVIDENCE, all ? 'run-results.json' : `run-results-${selected.join('-')}.json`),
  JSON.stringify({ runId, startedAt: new Date(runStartMs).toISOString(), finishedAt: new Date().toISOString(), results }, null, 2) + '\n')
const failed = results.filter((r) => !r.ok)
if (all) {
  const sheet = spawnSync(process.execPath, [path.join(ROOT, 'tools/capture/wiki-gaps/contact-sheet.mjs'), '--dir', OUT, '--out', path.join(EVIDENCE, 'contact-sheet.png')], { stdio: 'inherit', cwd: ROOT })
  if (sheet.status !== 0) failed.push({ gap: 'contact-sheet' })
}
if (doPublish) {
  if (failed.length) console.error('PUBLISH SKIPPED: failed gaps', failed.map((f) => f.gap).join(' '))
  else await publish({ runId, runStartMs })
}
console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.gap} ${r.seconds}s ${r.ok ? r.pictures.join(' ') : r.error}`).join('\n'))
process.exitCode = failed.length ? 1 : 0
