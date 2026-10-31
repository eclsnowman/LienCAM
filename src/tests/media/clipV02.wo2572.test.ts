import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
// @ts-expect-error external recorder has no TS declaration
import { validateSequence } from '../../../tools/capture/clips-v2/v02.mjs'

const evidence = 'src/tests/evidence/WO-2572/'
const read = (name: string) => JSON.parse(readFileSync(evidence + name, 'utf8'))
const sequence = () => JSON.parse(readFileSync('tools/capture/clips-v2/v02.json', 'utf8'))

describe('WO-2572 delivered complete multi-tool fixture plate', () => {
  it('allows one Play, timed camera input, Compare and fade with a final hold; refuses seeking', () => {
    expect(validateSequence(sequence()).durationSeconds).toBe(215)
    for (const patch of [{ action: 'seek' }, { at: -1 }, { duration: NaN }, { deltaY: 501 }]) {
      const s = sequence(); Object.assign(s.steps[0], patch)
      expect(() => validateSequence(s)).toThrow()
    }
    const overlap = sequence(); overlap.steps[1].at = 2
    expect(() => validateSequence(overlap)).toThrow()
    expect(() => validateSequence({ ...sequence(), durationSeconds: 210 })).toThrow()
  })

  it('independently decodes the delivered file, measures motion, and ties the final frame to exact stock', () => {
    const decoded = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-B', 'tools/capture/clips-v2/analyze-v02.py', '--verify-only'],
      { encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }))
    expect(decoded.verifiedResolution).toEqual([1920, 1080])
    expect(decoded.verifiedStreamFps).toBe(30)
    expect(decoded.durationSeconds).toBe(76)
    expect(decoded.decodedFrames).toBe(2280)
    expect(decoded.lastSecondsVisibleHoleCounts).toEqual([14, 14, 14, 14, 14])
    expect(decoded.coveredHoleControlCount).toBe(13)
    expect(decoded.finishedTailExact).toBe(true)
    expect(decoded.finishedTailSamples).toBeGreaterThan(100)
    expect(decoded.lastFrameVsFinishedScreenshotMad).toBeLessThan(2)
    expect(decoded.visibleMotion.failures).toEqual([])
    expect(decoded.visibleMotion.checkedWindows).toBeGreaterThan(1600)
    expect(decoded.visibleMotion.fadeWindows).toEqual([[17.5, 18], [33, 33.5], [45.5, 46], [60, 60.5]])
    expect(decoded.edit.segments.map((s: { sourceStart: number; sourceEnd: number }) => [s.sourceStart, s.sourceEnd])).toEqual([
      [0, 18], [31, 47], [77, 90], [173, 188], [199, 215]])
    expect(decoded.sourceCaptureFrames).toBe(6450)
    expect(decoded.unfadedSourceCorrespondence.checkedFrames).toBe(2220)
    expect(decoded.unfadedSourceCorrespondence.maximumMad).toBeLessThan(2)
    expect(decoded.captureGapsOver100ms).toEqual([])
  }, 100_000)

  it('cuts only repeat interiors while keeping every real-app tool change outside dissolves', () => {
    const capture = read('capture.json'), edit = read('pacing.json'), samples = read('telemetry.json')
    expect(capture.edit).toEqual(edit)
    expect(edit.sourceSha256).toBe(read('capture-source.json').sha256)
    expect(edit.plan).toEqual(JSON.parse(readFileSync('tools/capture/clips-v2/v02-pacing.json', 'utf8')))
    const transitions = samples.filter((s: { playing: boolean; tool: { type: string } }, i: number) =>
      s.playing && (i === 0 || !samples[i - 1].playing || samples[i - 1].tool.type !== s.tool.type))
    expect(transitions).toHaveLength(5)
    for (const sample of transitions) {
      const sourceTime = sample.wallTime - capture.frames[0].timestamp
      const segment = edit.segments.find((s: { sourceStart: number; sourceEnd: number }) =>
        sourceTime >= s.sourceStart && sourceTime < s.sourceEnd)
      expect(segment).toBeDefined()
      const outputTime = segment.outputStart + sourceTime - segment.sourceStart
      expect(edit.fadeWindows.some(([a, b]: number[]) => outputTime >= a && outputTime < b)).toBe(false)
    }
    expect(edit.fadeWindows.every(([a, b]: number[]) => b - a === .5)).toBe(true)
    expect(edit.durationSeconds).toBeLessThan(edit.plan.sourceDurationSeconds / 2)
  })

  it('regenerates all five supplied operations and all fourteen holes through the production UI', () => {
    const capture = read('capture.json'), diagnostic = read('project-diagnostic.json')
    expect(capture.source.workingTreeDirty).toBe(false)
    expect(capture.source.commit).toBe('ffe55d095810e310d5d25e8eca8cdc1d1200dab6')
    expect(capture.source.exportArchiveSha256).toBe(diagnostic.source.exportArchiveSha256)
    expect(capture.prep.speed).toBe(10)
    expect(capture.prep.project.activeOperationId).toBe(null)
    expect(capture.prep.project.operations.map((o: { name: string }) => o.name)).toEqual([
      'Face 1', 'Drill 2', 'Thread Mill 3', 'Contour 4', 'Chamfer 5'])
    expect(capture.prep.project.operations.every((o: { status: string }) => o.status === 'ready')).toBe(true)
    const operations = diagnostic.projectReadback.setups[0].operations
    expect(operations.map((o: { tool: { toolNumber: number } }) => o.tool.toolNumber)).toEqual([2, 3, 4, 2, 6])
    expect(operations[1].params.loopIds).toHaveLength(14)
    expect(operations[2].params.loopIds).toHaveLength(12)
    expect(operations[1].minimumCutZ).toBeLessThan(-8)
    expect(operations[3].minimumCutZ).toBeLessThan(-8)
  })

  it('reads the rendered cutter changes in order during continuous playback without a seek', () => {
    const samples = read('telemetry.json'), capture = read('capture.json')
    const active = samples.filter((s: { playing: boolean }) => s.playing)
    const changes: string[] = []
    for (const sample of active) if (sample.tool.type !== changes.at(-1)) changes.push(sample.tool.type)
    expect(changes).toEqual(['flat_end_mill', 'drill', 'thread_mill', 'flat_end_mill', 'chamfer_mill'])
    expect(active.every((s: { toolVisible: boolean }) => s.toolVisible)).toBe(true)
    expect(samples[0].sim).toBe(0)
    expect(Math.abs(samples.at(-1).sim - capture.prep.durationMs)).toBeLessThanOrEqual(1)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].sim).toBeGreaterThanOrEqual(samples[i - 1].sim)
      // Carving runs between rAF timestamps and our DOM observation, so
      // adjacent sample gaps are not the playback clock. The cumulative
      // wall-clock ceiling detects forward skips without treating carve
      // latency as a seek. Strict decoded-motion checks remain separate.
      if (samples[i].wallTime >= active[0].wallTime) expect(samples[i].sim).toBeLessThanOrEqual(
        (samples[i].wallTime - active[0].wallTime) * capture.prep.speed * 1000 + 100)
    }
  })

  it('holds completed Compare stock at minimum opacity from a readable high angle', () => {
    const capture = read('capture.json'), samples = read('telemetry.json')
    const orbit = capture.actions.find((s: { action: string; finished?: boolean }) => s.action === 'orbit' && s.finished)
    expect(orbit.readback.playing).toBe(false)
    expect(orbit.readback.stockSync).toBe('exact')
    const tail = samples.filter((s: { t: number }) => s.t >= 210)
    expect(tail.length).toBeGreaterThan(100)
    for (const sample of tail) {
      expect(sample.comparePressed).toBe(true)
      expect(sample.opacity).toBe(.15)
      expect(sample.materialOpacity).toBe(.15)
      const [x, y, z] = sample.camera, target = orbit.readback.camera.target
      expect((z - target.z) / Math.hypot(x - target.x, y - target.y, z - target.z)).toBeGreaterThanOrEqual(Math.sin(50 * Math.PI / 180))
    }
    const fade = capture.actions.find((s: { action: string }) => s.action === 'opacity')
    const drag = samples.filter((s: { wallTime: number }) => s.wallTime >= fade.motion.beganWallTime && s.wallTime <= fade.motion.endedWallTime)
    expect(new Set(drag.map((s: { opacity: number }) => s.opacity)).size).toBeGreaterThanOrEqual(17)
    expect(drag.every((s: { pointer: { down: boolean }; pointerOnSlider: boolean }) => s.pointer.down && s.pointerOnSlider)).toBe(true)
  })

  it('captures on hardware below the CPU ceiling, with a text-free pointer and neither move sphere', () => {
    const capture = read('capture.json'), samples = read('telemetry.json')
    expect(capture.recorder.method).toBe('CDP deterministic frame screenshots')
    expect(capture.recorder.headless).toBe(false)
    expect(capture.recorder.browserScreencast).toBe(false)
    expect(capture.recorder.captureRegion.calibration.mad).toBeLessThanOrEqual(2)
    expect(capture.prep.gpu.ok).toBe(true)
    expect(capture.prep.renderer).toContain('OpenGL')
    expect(capture.prep.renderer).not.toMatch(/Direct3D|D3D11/)
    expect(capture.captureCpu.average).toBeLessThan(60)
    expect(capture.cpu.average).toBeLessThan(60)
    expect(capture.errors).toEqual([])
    expect(samples.length).toBeGreaterThan(2000)
    expect(samples.every((s: { wcsGizmo: boolean; stockGizmo: boolean; overlayText: string; presentationOverlays: number }) =>
      !s.wcsGizmo && !s.stockGizmo && s.overlayText === '' && s.presentationOverlays === 2)).toBe(true)
    const recorder = readFileSync('tools/capture/clips-v2/v02.mjs', 'utf8')
    expect(recorder).not.toMatch(/Page\.startScreencast|Page\.screencastFrame|recordVideo/)
    expect(recorder).not.toMatch(/\.fill\(|\.setState\(|caption|titleCard|optical.flow|\.currentTime\s*=/)
    expect(readFileSync('docs/media/clips-v2/review.html', 'utf8')).toContain('src="V02.mp4"')
  })

  it('retains every full-resolution frame in both five-second dumps and whole-frame stills', () => {
    for (const dir of ['busiest-5s', 'last-5s']) expect(readdirSync(evidence + dir).filter(x => x.endsWith('.jpg'))).toHaveLength(150)
    for (const name of ['cutting.jpg', 'finished-decoded.jpg']) expect(readFileSync(evidence + name).length).toBeGreaterThan(50000)
    expect(read('motion.json').last5sDumpFrames).toBe(150)
    expect(read('motion.json').fullRateDumpFrames).toBe(150)
  })
})
