import { describe, it, expect } from 'vitest'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import type { Tool, ToolType } from '../../types'

// Minimal Tool factory: every required field present, overridable.
function makeTool(over: Partial<Tool> & { type: ToolType }): Tool {
  return {
    id: 't',
    name: 'test',
    diameter: 6,
    fluteLength: 20,
    shankDiameter: 6,
    overallLength: 60,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {},
    ...over,
  }
}

describe('buildThread (thread_mill profile)', () => {
  it('no threadPitch -> backward-compatible plain cylinder (no sub-crest dips)', () => {
    const crestR = 3 // diameter 6
    const p = buildToolProfile(
      makeTool({ type: 'thread_mill', diameter: 6, fluteLength: 13, overallLength: 50 }),
    )
    // Max radius is the crest (== diameter/2); cylinder + shank only.
    const maxR = Math.max(...p.vertices.map(v => v.r))
    expect(maxR).toBeCloseTo(crestR, 10)
    // No "tooth root" vertex: nothing sits strictly between a notional rootR and
    // the crest. A plain cylinder only has r == crestR (cutting) or r == Rsh.
    const Rsh = 3 // shankDiameter 6
    for (const v of p.vertices) {
      const isCrest = Math.abs(v.r - crestR) < 1e-9
      const isShank = Math.abs(v.r - Rsh) < 1e-9
      expect(isCrest || isShank).toBe(true)
    }
  })

  it('legacy thread_mill with a neck still has no teeth (plain cylinder + neck)', () => {
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 6,
        fluteLength: 13,
        overallLength: 50,
        neckDiameter: 4,
        shoulderLength: 8,
      }),
    )
    const crestR = 3
    const maxR = Math.max(...p.vertices.map(v => v.r))
    expect(maxR).toBeCloseTo(crestR, 10)
    // Neck vertex present at neckR=2 between fluteLength(13) and 13+8.
    const neck = p.vertices.find(v => Math.abs(v.r - 2) < 1e-9 && v.z >= 13 && v.z <= 21)
    expect(neck).toBeDefined()
  })

  it('pitch=1 form=60 teeth=4 dia=6 -> toothDepth ~0.866, rootR ~2.134, 4 crests', () => {
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 6,
        threadPitch: 1,
        threadFormAngleDeg: 60,
        threadTeethCount: 4,
        overallLength: 50,
      }),
    )
    const crestR = 3
    const toothDepth = 0.5 / Math.tan(30 * (Math.PI / 180)) // 0.5/tan30
    expect(toothDepth).toBeCloseTo(0.8660, 3)
    const rootR = crestR - toothDepth
    expect(rootR).toBeCloseTo(2.1340, 3)

    // First vertex at z=0 sits at the root.
    expect(p.vertices[0].z).toBe(0)
    expect(p.vertices[0].r).toBeCloseTo(rootR, 6)

    // cuttingMaxZ == Lc == N*pitch == 4.
    expect(p.cuttingMaxZ).toBe(4)
    expect(p.fluteTopZ).toBe(4)

    // Exactly 4 crest vertices (r == crestR) strictly inside the threaded region
    // (z < Lc). The vertex at z==Lc is the root/tail, not a tooth crest. (Using
    // strict z < Lc disambiguates from a tail shank vertex when shank == crest.)
    const crests = p.vertices.filter(v => Math.abs(v.r - crestR) < 1e-9 && v.z < 4 - 1e-9)
    expect(crests.length).toBe(4)

    // z values are non-decreasing across the whole list.
    for (let i = 1; i < p.vertices.length; i++) {
      expect(p.vertices[i].z).toBeGreaterThanOrEqual(p.vertices[i - 1].z - 1e-9)
    }
  })

  it('teeth=1 (single-point) -> exactly one crest', () => {
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 6,
        threadPitch: 1,
        threadFormAngleDeg: 60,
        threadTeethCount: 1,
        overallLength: 50,
      }),
    )
    const crests = p.vertices.filter(v => Math.abs(v.r - 3) < 1e-9 && v.z < p.cuttingMaxZ - 1e-9)
    expect(crests.length).toBe(1)
    expect(p.cuttingMaxZ).toBe(1)
  })

  it('neck appears after the teeth (neckR vertex between Lc and Lc+shoulderLength)', () => {
    const pitch = 0.8
    const teeth = 6
    const Lc = pitch * teeth // 4.8
    const shoulderLength = 4
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 4,
        shankDiameter: 6,
        threadPitch: pitch,
        threadFormAngleDeg: 60,
        threadTeethCount: teeth,
        neckDiameter: 3,
        shoulderLength,
        overallLength: 50,
      }),
    )
    const neckR = 1.5 // neckDiameter 3 / 2
    const neck = p.vertices.find(
      v => Math.abs(v.r - neckR) < 1e-9 && v.z >= Lc - 1e-9 && v.z <= Lc + shoulderLength + 1e-9,
    )
    expect(neck).toBeDefined()
    expect(p.cuttingMaxZ).toBeCloseTo(Lc, 6)
  })

  it('neck->shank transition is a SLOPED cone (default/30 deg), not a vertical step', () => {
    const Rn = 1.5 // neckDiameter 3 / 2
    const Rsh = 3 // shankDiameter 6 / 2
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 4,
        shankDiameter: 6,
        threadPitch: 0.8,
        threadFormAngleDeg: 60,
        threadTeethCount: 6,
        neckDiameter: 3,
        shoulderLength: 4,
        neckTransitionAngleDeg: 30,
        overallLength: 50,
      }),
    )
    // There exist two consecutive vertices going r==Rn -> r==Rsh with DIFFERENT
    // z (a slope, not a vertical step).
    let sloped = false
    for (let i = 0; i < p.vertices.length - 1; i++) {
      const a = p.vertices[i]
      const b = p.vertices[i + 1]
      if (Math.abs(a.r - Rn) < 1e-9 && Math.abs(b.r - Rsh) < 1e-9) {
        expect(b.z - a.z).toBeGreaterThan(1e-6)
        // Expected dz = (Rsh - Rn) / tan(30deg) ~= 2.598.
        const expectedDz = (Rsh - Rn) / Math.tan(30 * (Math.PI / 180))
        expect(b.z - a.z).toBeCloseTo(expectedDz, 6)
        sloped = true
      }
    }
    expect(sloped).toBe(true)
  })

  it('neckTransitionAngleDeg = 90 -> sharp step (Rn->Rsh vertices share a z)', () => {
    const Rn = 1.5
    const Rsh = 3
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 4,
        shankDiameter: 6,
        threadPitch: 0.8,
        threadFormAngleDeg: 60,
        threadTeethCount: 6,
        neckDiameter: 3,
        shoulderLength: 4,
        neckTransitionAngleDeg: 90,
        overallLength: 50,
      }),
    )
    let found = false
    for (let i = 0; i < p.vertices.length - 1; i++) {
      const a = p.vertices[i]
      const b = p.vertices[i + 1]
      if (Math.abs(a.r - Rn) < 1e-9 && Math.abs(b.r - Rsh) < 1e-9) {
        expect(Math.abs(b.z - a.z)).toBeLessThan(1e-6)
        found = true
      }
    }
    expect(found).toBe(true)
  })
})
