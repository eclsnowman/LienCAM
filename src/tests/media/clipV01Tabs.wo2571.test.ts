import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error external recorder has no TS declaration
import { validateSequence } from '../../../tools/capture/clips-v2/v01.mjs'

const evidence = 'src/tests/evidence/WO-2571/'
const read = (name: string) => JSON.parse(readFileSync(evidence + name, 'utf8'))

describe('WO-2571 recorded tab reveal', () => {
  it('uses regenerated application moves that reach below the tab tops', () => {
    const diagnostic = read('tab-diagnostic.json')
    const profile = diagnostic.projectReadback.setups[0].operations.find((o: { name: string }) => o.name === 'Clamp profiles - four tabs each')
    const stock = diagnostic.projectReadback.stocks[0]
    const tabTop = stock.position.z + profile.params.tabHeight
    expect(diagnostic.source.sourceHash).toBe(read('capture.json').source.sourceHash)
    expect(profile.status).toBe('ready')
    expect(profile.params.tabs).toBe(true)
    expect(profile.generatedMoves).toBeGreaterThan(500)
    expect(profile.minimumCutZ).toBeLessThan(tabTop)
    expect(profile.cuttingZValues).toContain(tabTop)
  })

  it('requires the finished orbit, Compare, fade, and a five-second hold', () => {
    const sequence = JSON.parse(readFileSync('tools/capture/clips-v2/v01.json', 'utf8'))
    expect(validateSequence(sequence).steps.slice(-2).map((s: { action: string }) => s.action)).toEqual(['compare', 'opacity'])
    for (const steps of [sequence.steps.slice(0, -2), [...sequence.steps.slice(0, -2), sequence.steps.at(-1), sequence.steps.at(-2)]]) {
      expect(() => validateSequence({ ...sequence, steps })).toThrow()
    }
    expect(() => validateSequence({ ...sequence, durationSeconds: 69 })).toThrow()
  })

  it('reads the actual Compare click and native slider drag from full to minimum opacity', () => {
    const capture = read('capture.json'), samples = read('telemetry.json')
    const compare = capture.actions.find((s: { action: string }) => s.action === 'compare')
    const fade = capture.actions.find((s: { action: string }) => s.action === 'opacity')
    expect(compare.readback.comparePressed).toBe(true)
    expect(compare.readback.playing).toBe(false)
    expect(Math.abs(compare.readback.positionMs - capture.prep.durationMs)).toBeLessThanOrEqual(1)
    expect(compare.readback.opacity).toBe(1)
    expect(fade.readback.opacity).toBe(.15)
    expect(fade.motion.endedWallTime - fade.motion.beganWallTime).toBeGreaterThan(3)
    const drag = samples.filter((s: { wallTime: number }) => s.wallTime >= fade.motion.beganWallTime && s.wallTime <= fade.motion.endedWallTime)
    expect(drag.length).toBeGreaterThan(100)
    expect(new Set(drag.map((s: { opacity: number }) => s.opacity)).size).toBeGreaterThanOrEqual(17)
    expect(drag.every((s: { comparePressed: boolean; pointerOnSlider: boolean; pointer: { down: boolean }; opacity: number; sliderOpacity: number }) => s.comparePressed && s.pointerOnSlider && s.pointer.down && s.opacity === s.sliderOpacity)).toBe(true)
    expect(drag.every((s: { opacity: number }, i: number) => i === 0 || s.opacity <= drag[i - 1].opacity)).toBe(true)
    const tail = samples.filter((s: { t: number }) => s.t >= 67)
    expect(tail.length).toBeGreaterThan(100)
    expect(tail.every((s: { comparePressed: boolean; opacity: number; materialOpacity: number; stockSync: string }) => s.comparePressed && s.opacity === .15 && s.materialOpacity === .15 && s.stockSync === 'exact')).toBe(true)
  })

  it('has neither move sphere during recording, keeps the normal origin, and retains the last 150 decoded frames', () => {
    const samples = read('telemetry.json')
    expect(samples.length).toBeGreaterThan(2000)
    expect(samples.every((s: { wcsGizmo: boolean; stockGizmo: boolean; originMarkerVisible: boolean }) => s.wcsGizmo === false && s.stockGizmo === false && s.originMarkerVisible === true)).toBe(true)
    expect(readdirSync(evidence + 'last-5s').filter(x => x.endsWith('.jpg'))).toHaveLength(150)
    expect(read('motion.json').last5sDumpFrames).toBe(150)
    expect(readFileSync(evidence + 'last-5s.mp4').length).toBeGreaterThan(10000)
    for (const name of ['cutting.jpg', 'finished-decoded.jpg']) expect(readFileSync(evidence + name).length).toBeGreaterThan(50000)
  })

  it('holds a steep finished-stock view so the channel walls do not hide the tab bridges', () => {
    const capture = read('capture.json'), samples = read('telemetry.json')
    const finalOrbit = capture.actions.find((s: { action: string; finished?: boolean }) => s.action === 'orbit' && s.finished)
    const target = finalOrbit.readback.camera.target
    const tail = samples.filter((s: { t: number }) => s.t >= 67)
    expect(tail.length).toBeGreaterThan(100)
    for (const sample of tail) {
      const [x, y, z] = sample.camera
      const vertical = z - target.z
      // >= 65 deg elevation sees the -7 mm bridges behind 8 mm walls in
      // the 6 mm cutter channel. The previous 24 deg ending hides them.
      expect(vertical / Math.hypot(x - target.x, y - target.y, vertical)).toBeGreaterThanOrEqual(Math.sin(65 * Math.PI / 180))
    }
  })
})
