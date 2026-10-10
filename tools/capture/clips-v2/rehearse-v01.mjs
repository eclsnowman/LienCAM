// Preserve V01's existing sequence; redirect its disposable rehearsal I/O.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { runV01 } from './v01.mjs'
import { EVIDENCE, ROOT, scratchFolder, sampleFrames, videoStrip } from './rehearse.mjs'
import { captureSourceProvenance } from '../lib/provenance.mjs'

const scratch = scratchFolder(process.argv[2] || process.env.CLIP_OUTPUT_DIR)
const out = path.join(EVIDENCE, 'V01'); mkdirSync(out, { recursive: true })
const result = { id: 'V01', source: captureSourceProvenance({ repoRoot: ROOT }), startedAt: new Date().toISOString(), status: 'running', consoleErrors: [], pageErrors: [], steps: [], adaptation: 'Original v01.json and perform() unchanged. Linux CPU sampler, explicit software-renderer rehearsal opt-in and isolated output paths. Final capture still requires hardware.' }
const epoch = Date.now(); let finishFrames, video
try {
  const angle = process.env.CLIP_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'gl-egl')
  await runV01({ rehearsal: { evidence: scratch, output: scratch, angle, software: angle === 'swiftshader', onPage: async page => {
    video = page.video()
    page.on('pageerror', e => result.pageErrors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()) })
    // Start sampling only after navigation has supplied the live app.
    page.once('domcontentloaded', async () => { finishFrames = await sampleFrames(page, scratch, out) })
  } } })
  const receipt = JSON.parse(readFileSync(path.join(scratch, 'rehearsal.json'), 'utf8'))
  Object.assign(result, receipt)
  let previousCamera = receipt.prep.initialCamera
  result.steps = receipt.actions.map(s => {
    const passed = s.action === 'play' ? s.readback.playing === true
      : s.action === 'compare' ? s.readback.comparePressed && !s.readback.playing
      : s.action === 'opacity' ? s.readback.opacity === .15 && s.readback.comparePressed
      : s.action === 'zoom' ? s.readback.camera.zoom !== previousCamera.zoom
      : s.action === 'orbit' ? JSON.stringify(s.readback.camera.position) !== JSON.stringify(previousCamera.position)
      : false
    previousCamera = s.readback.camera
    return { ...s, passed }
  })
  if (!result.steps.every(s => s.passed)) throw new Error('V01 action failed its production readback assertion')
  const last = receipt.actions.at(-1).readback
  if (result.pageErrors.length || result.consoleErrors.length) throw new Error('Application errors recorded')
  if (!last.comparePressed || last.opacity !== .15 || last.playing || last.stockSync !== 'exact' || Math.abs(last.positionMs - receipt.prep.durationMs) > 1) throw new Error('Incomplete finished stock/Compare/fade readback')
  result.status = 'PASS'
} catch (e) {
  result.status = result.pageErrors.length || result.consoleErrors.length ? 'BROKE-APP' : 'BROKE-SCRIPT'; result.error = e.stack
  result.reproduce = 'node tools/capture/clips-v2/rehearse-v01.mjs'
  console.error(e)
} finally {
  if (finishFrames) await finishFrames().catch(e => { result.stripError = e.message })
  if (video) { const file = await video.path().catch(() => null); if (file) {
    try { result.strip = videoStrip(file, scratch, out) } catch (e) { result.stripError = e.message; if (result.status === 'PASS') result.status = 'PLATFORM' }
    // 10-09 keep-take (see rehearse.mjs): CLIP_KEEP_DIR retains a PASS take as a candidate final.
    if (process.env.CLIP_KEEP_DIR && result.status === 'PASS') {
      try {
        const keep = scratchFolder(process.env.CLIP_KEEP_DIR)
        execFileSync(process.env.FFMPEG_BIN || process.env.FFMPEG || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(keep, 'V01.mp4')], { maxBuffer: 8 * 1024 * 1024 })
        result.keptTake = path.join(keep, 'V01.mp4'); writeFileSync(path.join(keep, 'V01.run.json'), JSON.stringify(result, null, 2))
      } catch (e) { result.keepError = e.message }
    }
    rmSync(file, { force: true })
  } }
  for (const name of ['prepared.png', 'rehearsed.png', 'failed.png', 'rehearsal.json']) rmSync(path.join(scratch, name), { force: true })
  if (result.status === 'PASS' && (result.pageErrors.length || result.consoleErrors.length)) {
    result.status = 'BROKE-APP'; result.error = 'Late application errors: ' + [...result.pageErrors, ...result.consoleErrors].join('; ')
  }
  result.runtimeSeconds = (Date.now() - epoch) / 1000
  writeFileSync(path.join(out, 'run.json'), JSON.stringify(result, null, 2) + '\n')
}
if (result.status !== 'PASS') process.exitCode = 1
