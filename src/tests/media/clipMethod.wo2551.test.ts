import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
// Recorder-only code, never imported by an application entry point.
// @ts-expect-error external capture scripts have no application declaration file
import { validateSequence } from '../../../tools/capture/clips-v2/proof.mjs'

const sequence = () => JSON.parse(readFileSync('tools/capture/clips-v2/proof.json', 'utf8'))
describe('WO-2551 rehearsed clip method', () => {
  it('declares a real example, 1080p, Play, two timed orbits and Pause within 26 s', () => {
    const s = validateSequence(sequence())
    expect(s.durationSeconds).toBe(26)
    expect(s.steps.map((x: { action: string }) => x.action)).toEqual(['play', 'orbit', 'orbit', 'pause'])
    expect(JSON.parse(readFileSync(s.project, 'utf8'))).toBeTruthy()
  })
  it.each([-1, NaN, 30])('rejects invalid or overrun action start %s', at => {
    const s = sequence(); s.steps[0].at = at
    expect(() => validateSequence(s)).toThrow()
  })
  it('rejects overlapping actions, unsupported actions and nonlocal input', () => {
    for (const mutate of [
      (s: ReturnType<typeof sequence>) => { s.steps[1].at = 2 },
      (s: ReturnType<typeof sequence>) => { s.steps[1].action = 'seek' },
      (s: ReturnType<typeof sequence>) => { s.project = '../main/example.camproject' },
    ]) {
      const s = sequence(); mutate(s)
      expect(() => validateSequence(s)).toThrow()
    }
  })
  it('rejects off-canvas drag coordinates and missing playback', () => {
    const s = sequence(); s.steps[1].to = [1.5, 0.5]
    expect(() => validateSequence(s)).toThrow()
    const noPlay = sequence(); noPlay.steps.shift()
    expect(() => validateSequence(noPlay)).toThrow()
  })
  it('keeps pointer presentation outside all production source (no dev-only additions)', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'tests') continue
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.(tsx?|m?js)$/.test(file)) files.push(file)
      }
    }
    walk('src')
    for (const file of [...files, 'index.html', 'vite.config.mts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/wo2551-pointer|wo2551-click|clips-v2\/proof|__wo2551Samples/)
    }
  })
})
