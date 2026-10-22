// WO-2750 Slice A (WO-2981): MEASURED projection capability.
//
// The plan (docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md s5) asked whether the
// kernel can do BREP hidden-line projection at all. The pinned occt-wasm
// already binds OCCT's HLRBRep as `projectEdges`; these tests measure it on
// parts whose drawing is known by hand, measure the raw-mesh producer against
// it, and pin the frame convention so a kernel change cannot flip a view
// silently. With WO2981_EVIDENCE=1 the measured numbers and SVG views are
// written to src/tests/evidence/WO-2750/A/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  makeViewFrame,
  projectBrepHlr,
  projectMesh,
  projectPoint,
  standardViewFrame,
  toSheet,
  polylineLength,
  suppressHiddenUnderVisible,
} from '../../lib/drawing/project'
import type { ProjectionScene, StandardViewName } from '../../lib/drawing/types'
import type { MeshBuffers } from '../../mesh/types'

const EVIDENCE_DIR = 'src/tests/evidence/WO-2750/A'
const measured: Record<string, unknown> = {}

let k: OcctKernel
// 100 x 50 x 20 block, a 10 mm through hole at (30, 25), and a 20 x 10 x 10
// pocket opening in the FRONT face (y = 0) at x 10..30, z 5..15.
let part: ShapeHandle
// The same block with only the hole (the drawing everyone knows by heart).
let holed: ShapeHandle
// The block with only the pocket: every edge straight, for the frame check.
let pocketOnly: ShapeHandle

beforeAll(async () => {
  k = await OcctKernel.init()
  const box = k.makeBox(100, 50, 20)
  const hole = k.translate(k.makeCylinder(5, 20), 30, 25, 0)
  holed = k.cut(box, hole)
  const pocket = k.makeBoxFromCorners({ x: 10, y: -1, z: 5 }, { x: 30, y: 10, z: 15 })
  part = k.cut(holed, pocket)
  pocketOnly = k.cut(k.makeBox(100, 50, 20), pocket)
}, 120_000)

function bbox(scene: ProjectionScene, which: 'visible' | 'hidden') {
  const pts = scene.lines.filter(l => l.visibility === which).flatMap(l => l.points)
  return {
    minU: Math.min(...pts.map(p => p[0])), maxU: Math.max(...pts.map(p => p[0])),
    minV: Math.min(...pts.map(p => p[1])), maxV: Math.max(...pts.map(p => p[1])),
  }
}

function round(v: number, d = 3) {
  return Math.round(v * 10 ** d) / 10 ** d
}

function sceneSummary(s: ProjectionScene) {
  return {
    producer: s.producerVersion,
    visibleLengthMm: round(s.stats.visibleLengthMm),
    hiddenLengthMm: round(s.stats.hiddenLengthMm),
    hiddenSuppressedLengthMm: round(s.stats.hiddenSuppressedLengthMm),
    duplicateSuppressedLengthMm: round(s.stats.duplicateSuppressedLengthMm),
    lines: s.lines.length,
    ms: round(s.stats.ms, 1),
  }
}

describe('BREP hidden-line removal through the pinned kernel (measured)', () => {
  it('front view of the holed block: outline visible, the hole as two hidden lines, nothing else', () => {
    const scene = projectBrepHlr(k, holed, standardViewFrame('front'))
    // 100 x 20 outline = 240 mm of visible line.
    expect(scene.stats.visibleLengthMm).toBeCloseTo(240, 6)
    // The bore shows as its two hidden limiting lines, x = 25 and x = 35, 20 mm each.
    expect(scene.stats.hiddenLengthMm).toBeCloseTo(40, 3)
    const hidden = scene.lines.filter(l => l.visibility === 'hidden')
    const us = [...new Set(hidden.flatMap(l => l.points.map(p => round(p[0], 3))))].sort((a, b) => a - b)
    expect(us).toEqual([25, 35])
    // The back outline lay exactly under the front one and was dropped.
    expect(scene.stats.hiddenSuppressedLengthMm).toBeGreaterThan(200)
    measured.holedFront = sceneSummary(scene)
  })

  it('the pocket in the front face is VISIBLE from the front and HIDDEN from the back: the frame is not flipped', () => {
    const front = projectBrepHlr(k, part, standardViewFrame('front'))
    const pocketVisible = front.lines.filter(l => l.visibility === 'visible' && l.points.every(p => p[0] >= 10 - 1e-6 && p[0] <= 30 + 1e-6 && p[1] >= 5 - 1e-6 && p[1] <= 15 + 1e-6))
    expect(pocketVisible.reduce((s, l) => s + polylineLength(l.points), 0)).toBeCloseTo(60, 3) // 2 x 20 + 2 x 10
    // The pocket floor lies behind its own opening: suppressed, not drawn twice.
    expect(front.lines.some(l => l.visibility === 'hidden' && l.points.every(p => p[0] > 10.5 && p[0] < 29.5 && p[1] > 5.5 && p[1] < 14.5))).toBe(false)

    const back = projectBrepHlr(k, part, makeViewFrame([0, 1, 0], [-1, 0, 0]))
    const pocketHidden = back.lines.filter(l => l.visibility === 'hidden')
      .filter(l => l.points.every(p => p[0] >= -30 - 1e-6 && p[0] <= -10 + 1e-6 && p[1] >= 5 - 1e-6 && p[1] <= 15 + 1e-6))
    expect(pocketHidden.reduce((s, l) => s + polylineLength(l.points), 0)).toBeGreaterThan(59.9)
    measured.pocketFront = sceneSummary(front)
    measured.pocketBack = sceneSummary(back)
  })

  it('kernel output uses the same (u, v) as projectPoint: every drawn point in an oblique view lies on a projected model edge', () => {
    const frame = standardViewFrame('iso')
    const scene = projectBrepHlr(k, pocketOnly, frame)
    // Every straight model edge of the block and pocket runs between lattice
    // points that differ in one coordinate; project all of them.
    const xs = [0, 10, 30, 100], ys = [0, 10, 50], zs = [0, 5, 15, 20]
    const segs: Array<[[number, number], [number, number]]> = []
    for (const x of xs) for (const y of ys) for (const z of zs) {
      for (const x2 of xs) if (x2 > x) segs.push([projectPoint(frame, [x, y, z]), projectPoint(frame, [x2, y, z])])
      for (const y2 of ys) if (y2 > y) segs.push([projectPoint(frame, [x, y, z]), projectPoint(frame, [x, y2, z])])
      for (const z2 of zs) if (z2 > z) segs.push([projectPoint(frame, [x, y, z]), projectPoint(frame, [x, y, z2])])
    }
    const dist = (p: [number, number], a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
    }
    const pts = scene.lines.flatMap(l => l.points)
    expect(pts.length).toBeGreaterThan(20)
    let worst = 0
    for (const p of pts) worst = Math.max(worst, Math.min(...segs.map(([a, b]) => dist(p, a, b))))
    expect(worst).toBeLessThan(1e-5) // HLR works to about 1e-6 mm here
    // ... and the hidden pocket walls are really there in the iso view.
    expect(scene.stats.hiddenLengthMm).toBeGreaterThan(10)
    // Paper up is world +Z in the iso view: the top face projects above the bottom.
    expect(projectPoint(frame, [0, 0, 20])[1]).toBeGreaterThan(projectPoint(frame, [0, 0, 0])[1])
    measured.isoFrameCheck = { worstOffEdgeMm: worst, points: pts.length }
    measured.iso = sceneSummary(projectBrepHlr(k, part, frame))
  })

  it('top view: the hole is a visible circle whose chord error stays inside the declared tolerance', () => {
    const scene = projectBrepHlr(k, holed, standardViewFrame('top'), { chordMm: 0.01 })
    const circle = scene.lines.filter(l => l.visibility === 'visible' && l.points.every(p => Math.hypot(p[0] - 30, p[1] - 25) < 5.5))
    const pts = circle.flatMap(l => l.points)
    expect(pts.length).toBeGreaterThan(20)
    const radialErr = Math.max(...pts.map(p => Math.abs(Math.hypot(p[0] - 30, p[1] - 25) - 5)))
    expect(radialErr).toBeLessThan(1e-4) // sample points lie ON the circle
    // Chord sagitta between samples is the real error; it must not exceed the deflection asked for.
    let worstSag = 0
    for (const l of circle) for (let i = 0; i + 1 < l.points.length; i++) {
      const m = [(l.points[i][0] + l.points[i + 1][0]) / 2, (l.points[i][1] + l.points[i + 1][1]) / 2]
      worstSag = Math.max(worstSag, 5 - Math.hypot(m[0] - 30, m[1] - 25))
    }
    expect(worstSag).toBeLessThanOrEqual(0.01 + 1e-9)
    expect(circle.reduce((s, l) => s + polylineLength(l.points), 0)).toBeCloseTo(2 * Math.PI * 5, 1)
    measured.topCircle = { samples: pts.length, radialErrMm: radialErr, worstChordSagMm: round(worstSag, 5), declaredChordMm: 0.01 }
    measured.holedTop = sceneSummary(scene)
  })

  it('scale changes paper length only: a 100 mm edge is 50 mm at 1:2 and 200 mm at 2:1', () => {
    const scene = projectBrepHlr(k, holed, standardViewFrame('front'))
    const width = (num: number, den: number) => {
      const pts = toSheet(scene, { numerator: num, denominator: den }, [20, 150]).flatMap(l => l.points)
      return Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]))
    }
    expect(width(1, 2)).toBeCloseTo(50, 9)
    expect(width(2, 1)).toBeCloseTo(200, 9)
    // Sheet Y points down: the top edge (v = 20) sits ABOVE the bottom edge on paper.
    const sheet = toSheet(scene, { numerator: 1, denominator: 1 }, [20, 150]).flatMap(l => l.points)
    expect(Math.min(...sheet.map(p => p[1]))).toBeCloseTo(130, 9)
    expect(() => toSheet(scene, { numerator: 0, denominator: 1 }, [0, 0])).toThrow(/positive ratio/)
  })
})

function meshOf(shape: ShapeHandle, deflection: number): MeshBuffers {
  const m = k.tessellate(shape, { linearDeflection: deflection, angularDeflection: 0.2 })
  return { positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) }
}

describe('raw mesh projection (no BREP conversion), measured against the kernel HLR', () => {
  it('front view of the tessellated holed block matches the BREP drawing within the facet error', () => {
    const mesh = meshOf(holed, 0.01)
    const brep = projectBrepHlr(k, holed, standardViewFrame('front'))
    const scene = projectMesh(mesh, standardViewFrame('front'))
    expect(scene.stats.visibleLengthMm).toBeCloseTo(brep.stats.visibleLengthMm, 0)
    expect(Math.abs(scene.stats.hiddenLengthMm - brep.stats.hiddenLengthMm)).toBeLessThan(1)
    const h = bbox(scene, 'hidden')
    expect(h.minU).toBeGreaterThan(24.9)
    expect(h.maxU).toBeLessThan(35.1)
    expect(scene.limits.length).toBeGreaterThan(0)
    measured.meshFront = { ...sceneSummary(scene), triangles: mesh.indices.length / 3, vsBrepVisibleMm: round(scene.stats.visibleLengthMm - brep.stats.visibleLengthMm), vsBrepHiddenMm: round(scene.stats.hiddenLengthMm - brep.stats.hiddenLengthMm) }
  })

  it('triangle order does not change the mesh drawing', () => {
    const mesh = meshOf(part, 0.05)
    const tris = mesh.indices.length / 3
    const order = Array.from({ length: tris }, (_, i) => (i * 7919) % tris)
    expect(new Set(order).size).toBe(tris)
    const shuffled = new Uint32Array(mesh.indices.length)
    order.forEach((src, dst) => shuffled.set(mesh.indices.subarray(src * 3, src * 3 + 3), dst * 3))
    const a = projectMesh(mesh, standardViewFrame('iso'))
    const b = projectMesh({ positions: mesh.positions, indices: shuffled }, standardViewFrame('iso'))
    expect(b.stats.visibleLengthMm).toBeCloseTo(a.stats.visibleLengthMm, 6)
    expect(b.stats.hiddenLengthMm).toBeCloseTo(a.stats.hiddenLengthMm, 6)
  })

  it('an open mesh (a face torn off) still projects; its boundary is drawn, nothing throws', () => {
    const mesh = meshOf(holed, 0.05)
    const keep: number[] = []
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const zs = [0, 1, 2].map(j => mesh.positions[mesh.indices[t + j] * 3 + 2])
      if (!zs.every(z => Math.abs(z - 20) < 1e-6)) keep.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2])
    }
    const open = { positions: mesh.positions, indices: new Uint32Array(keep) }
    const scene = projectMesh(open, standardViewFrame('top'))
    expect(scene.lines.length).toBeGreaterThan(0)
    // With the top gone the floor of the part is seen from above: its outline is visible.
    expect(scene.stats.visibleLengthMm).toBeGreaterThan(300 - 1)
    measured.meshOpenTop = sceneSummary(scene)
  })
})

describe('coincident-line cleanup', () => {
  it('keeps a small arc made of very short segments whole (its own previous piece is not a duplicate)', () => {
    const pts: Array<[number, number]> = []
    for (let a = 0; a <= Math.PI + 1e-12; a += 0.016) pts.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)])
    const before = polylineLength(pts)
    const { lines, duplicateMm } = suppressHiddenUnderVisible([{ visibility: 'visible', category: 'sharp', points: pts }], 0.02)
    expect(lines).toHaveLength(1)
    expect(polylineLength(lines[0].points)).toBeCloseTo(before, 6)
    expect(duplicateMm).toBe(0)
  })

  it('still drops a line that turns back over itself, and keeps the part of a hidden line no visible line covers', () => {
    const back = suppressHiddenUnderVisible([{ visibility: 'visible', category: 'feature', points: [[0, 0], [0, 20], [0, 0]] }], 0.01)
    // one cleanup piece (0.1 mm) right at the turn survives; the 20 mm return run goes
    expect(back.lines.reduce((s, l) => s + polylineLength(l.points), 0)).toBeLessThan(20.2)
    const part = suppressHiddenUnderVisible([
      { visibility: 'visible', category: 'sharp', points: [[0, 0], [10, 0]] },
      { visibility: 'hidden', category: 'sharp', points: [[0, 0], [20, 0]] },
    ], 0.01)
    const hidden = part.lines.filter(l => l.visibility === 'hidden')
    expect(hidden.reduce((s, l) => s + polylineLength(l.points), 0)).toBeCloseTo(10, 1)
    expect(part.suppressedMm).toBeCloseTo(10, 1)
  })
})

describe('evidence', () => {
  it('writes the measured table and SVG views when asked', () => {
    if (process.env.WO2981_EVIDENCE !== '1') return
    const views: StandardViewName[] = ['front', 'top', 'right', 'iso']
    const svgs: Record<string, string> = {}
    for (const v of views) {
      svgs[`brep-${v}`] = svgOf(projectBrepHlr(k, part, standardViewFrame(v)))
      svgs[`mesh-${v}`] = svgOf(projectMesh(meshOf(part, 0.05), standardViewFrame(v)))
      measured[`part-${v}-brep`] = sceneSummary(projectBrepHlr(k, part, standardViewFrame(v)))
      measured[`part-${v}-mesh`] = sceneSummary(projectMesh(meshOf(part, 0.05), standardViewFrame(v)))
    }
    mkdirSync(`${EVIDENCE_DIR}/views`, { recursive: true })
    for (const [name, svg] of Object.entries(svgs)) writeFileSync(`${EVIDENCE_DIR}/views/${name}.svg`, svg)
    writeFileSync(`${EVIDENCE_DIR}/projection-measured.json`, JSON.stringify(measured, null, 2) + '\n')
  })
})

function svgOf(scene: ProjectionScene): string {
  const pts = scene.lines.flatMap(l => l.points)
  const minU = Math.min(...pts.map(p => p[0])) - 5, maxU = Math.max(...pts.map(p => p[0])) + 5
  const minV = Math.min(...pts.map(p => p[1])) - 5, maxV = Math.max(...pts.map(p => p[1])) + 5
  const paths = scene.lines.map(l => {
    const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${round(p[0] - minU)} ${round(maxV - p[1])}`).join(' ')
    return l.visibility === 'visible'
      ? `<path d="${d}" fill="none" stroke="#111" stroke-width="0.5"/>`
      : `<path d="${d}" fill="none" stroke="#d33" stroke-width="0.35" stroke-dasharray="2 1.2"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(maxU - minU)} ${round(maxV - minV)}" width="${round(maxU - minU) * 3}" height="${round(maxV - minV) * 3}">${paths.join('')}</svg>\n`
}
