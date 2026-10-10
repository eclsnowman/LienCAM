import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
// Recorder is external to the application.
// @ts-expect-error external recorder has no TS declaration
import { validateSequence } from '../../../tools/capture/clips-v2/v01.mjs'

const evidence = 'src/tests/evidence/WO-2571/'
const sequence = () => JSON.parse(readFileSync('tools/capture/clips-v2/v01.json', 'utf8'))
describe('WO-2552 delivered Toe Clamps walkthrough', () => {
  it('permits one real Play and camera actions, rejects skipping the program and invalid timing', () => {
    expect(validateSequence(sequence()).durationSeconds).toBe(72)
    for (const patch of [{ action: 'seek' }, { at: -1 }, { duration: NaN }, { deltaY: 501 }]) {
      const s = sequence(); Object.assign(s.steps[0], patch)
      expect(() => validateSequence(s)).toThrow()
    }
    const overlap = sequence(); overlap.steps[1].at = 2
    expect(() => validateSequence(overlap)).toThrow()
  })
  it('decodes the delivered MP4 and measures its moving workspace and completed terminal stock', () => {
    const decoded = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', 'tools/capture/clips-v2/analyze-v01.py', '--verify-only'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }))
    expect(decoded.verifiedResolution).toEqual([1920, 1080])
    expect(decoded.durationSeconds).toBe(72)
    expect(decoded.decodedFrames).toBe(2160)
    expect(decoded.verifiedStreamFps).toBe(30)
    expect(decoded.activeNearDuplicateRunsAtLeast100ms).toEqual([])
    expect(decoded.captureGapsOver100ms).toEqual([])
    expect(decoded.finishedTailExact).toBe(true)
    expect(decoded.finishedTailSamples).toBeGreaterThan(100)
    expect(decoded.lastFrameVsFinishedScreenshotMad).toBeLessThan(2)
  }, 100_000)
  it('retains full-rate evidence and identifies real hardware capture of all three ready operations', () => {
    const capture = JSON.parse(readFileSync(evidence + 'capture.json', 'utf8'))
    expect(capture.source.workingTreeDirty).toBe(false)
    expect(capture.prep.gpu.ok).toBe(true)
    expect(capture.captureCpu.average).toBeLessThan(60)
    expect(capture.errors).toEqual([])
    expect(capture.prep.project.operations).toHaveLength(3)
    expect(capture.prep.project.operations.every((o: { status: string }) => o.status === 'ready')).toBe(true)
    expect(readdirSync(evidence + 'busiest-5s').filter(x => x.endsWith('.jpg'))).toHaveLength(150)
    expect(readFileSync('docs/media/clips-v2/review.html', 'utf8')).toContain('src="V01.mp4"')
    const recorder = readFileSync('tools/capture/clips-v2/v01.mjs', 'utf8')
    expect(recorder).not.toMatch(/\.fill\(|\.setState\(|caption|titleCard|optical.flow/)
  })
})
