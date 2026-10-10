// WO-1475 (BUG-438): a large inward offset across a thin neck used to publish
// a self-intersecting profile. computeOffset's collapse guards are local (one
// corner, one trimmed piece at a time), so a dumbbell whose two blocks are
// joined by a narrow neck trimmed cleanly corner by corner while the assembled
// loop crossed itself across the neck; Offset said "created 16 entities" and
// Finish baked a loop that fails polygon validity. A slightly larger distance
// refused outright even though two valid, disjoint regions survive.
//
// The shape: two 100x100 blocks (x 0..100 and 160..260) joined by a 60 long,
// 20 wide neck (y 40..60) - twelve lines, one closed chain. Offsetting it
// inward by 30 or 45 mm collapses the neck; the true offset is two separate
// regions, one per block.
//
// Driven through the store and the sketcher tool pipeline (arm, pick, lock the
// side, set the distance, OK), then Finish, and the BAKED loops are checked -
// what Finish persists is the application truth.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { SketchEntity, SketchLineEntity, Vec2 } from '../../lib/sketch/types'
import {
  computeOffset, offsetCommit, type OffsetSource,
} from '../../lib/sketch/tools/offsetTool'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import MUST come first: it binds the CAM document into the
  // sketcher package so sketcherTools has a document to drive.
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
  sketcherToolStore.setState({ tool: 'select', chain: null, offsetDistance: 2 })
})

const NECK: [number, number][] = [
  [0, 0], [100, 0], [100, 40], [160, 40], [160, 0], [260, 0],
  [260, 100], [160, 100], [160, 60], [100, 60], [100, 100], [0, 100],
]

function neckLines(): SketchLineEntity[] {
  return NECK.map(([x, y], i) => {
    const [x2, y2] = NECK[(i + 1) % NECK.length]
    return {
      id: `n${i}`, kind: 'line', construction: false,
      start: { x, y }, end: { x: x2, y: y2 },
    }
  })
}

function neckSource(): OffsetSource {
  return {
    kind: 'chain', closed: true,
    steps: neckLines().map((entity) => ({ entity, forward: true })),
  }
}

function area(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Drop the repeated closing point a baked loop may carry. */
function ring(pts: Vec2[]): Vec2[] {
  const last = pts[pts.length - 1]
  return pts.length > 1 && Math.hypot(last.x - pts[0].x, last.y - pts[0].y) < 1e-9
    ? pts.slice(0, -1) : pts
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function segmentsTouch(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const eps = 1e-9
  const d1 = orient(c, d, a), d2 = orient(c, d, b)
  const d3 = orient(a, b, c), d4 = orient(a, b, d)
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true
  const on = (p: Vec2, q: Vec2, r: Vec2, o: number) =>
    Math.abs(o) <= eps &&
    Math.min(p.x, q.x) - eps <= r.x && r.x <= Math.max(p.x, q.x) + eps &&
    Math.min(p.y, q.y) - eps <= r.y && r.y <= Math.max(p.y, q.y) + eps
  return on(c, d, a, d1) || on(c, d, b, d2) || on(a, b, c, d3) || on(a, b, d, d4)
}

/** Polygon validity: no two non-adjacent edges of the ring touch. */
function isSimple(ptsIn: Vec2[]): boolean {
  const pts = ring(ptsIn)
  const n = pts.length
  if (n < 3) return false
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (segmentsTouch(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false
    }
  }
  return true
}

function bboxOf(pts: Vec2[]) {
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  }
}

/** Area of one block's offset region: the (100 - 2d) square plus the two
 *  circular bulges past the reflex neck corners (numeric, exact enough). */
function expectedRegionArea(d: number): number {
  // Left block: x >= d, d <= y <= 100 - d. The neck-side edge sits at
  // 100 - d beside the block's vertical edges; inside the neck band
  // (40 < y < 60) only the reflex corners (100,40) and (100,60) bound it.
  const y0 = d, y1 = 100 - d
  const steps = 20000
  let a = 0
  for (let i = 0; i < steps; i++) {
    const y = y0 + ((i + 0.5) / steps) * (y1 - y0)
    const dy = Math.min(Math.abs(y - 40), Math.abs(y - 60))
    const edge = y > 40 && y < 60 ? 100 - Math.sqrt(Math.max(0, d * d - dy * dy)) : 100 - d
    a += (edge - d) * ((y1 - y0) / steps)
  }
  return a
}

function writeEvidence(name: string, loops: Vec2[][], notice: string | null): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const dir = 'src/tests/evidence/WO-1475'
  mkdirSync(dir, { recursive: true })
  const tag = process.env.EVIDENCE_TAG ?? 'after'
  const colors = ['#9aa4b2', '#e5484d', '#30a46c', '#0090ff', '#f76b15']
  const paths = loops.map((pts, i) => {
    const d = ring(pts).map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(3)},${(100 - p.y).toFixed(3)}`).join(' ')
    const color = colors[i % colors.length]
    return `<path d="${d} Z" fill="${i === 0 ? 'none' : color}" fill-opacity="0.18" ` +
      `stroke="${color}" stroke-width="${i === 0 ? 1 : 0.8}"/>`
  }).join('\n')
  const simple = loops.map((l) => (isSimple(l) ? 'valid' : 'SELF-INTERSECTING')).join(', ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -40 300 160" width="1200" height="640">
<rect x="-20" y="-40" width="300" height="160" fill="#111418"/>
<text x="-15" y="-28" font-family="monospace" font-size="6" fill="#e6e8eb">WO-1475 ${tag}: ${name} - ${loops.length} baked loop(s): ${simple}</text>
<text x="-15" y="-20" font-family="monospace" font-size="5" fill="#b0b4ba">notice: ${(notice ?? '').replace(/[<&]/g, '')}</text>
${paths}
</svg>`
  writeFileSync(`${dir}/${tag}-${name}.svg`, svg)
}

/** Arm Offset, pick the chain, lock the inside, set the distance, OK. */
function offsetThroughStore(distance: number): void {
  const s = useCamStore.getState()
  s.setViewerMode('sketch')
  for (const l of neckLines()) useCamStore.getState().addEntity(l as SketchEntity)
  sketcherTools.armTool('offset')
  sketcherTools.click({ x: 130, y: 40 }, 0.5, null, false) // picks the 12-line chain (clear of the origin axes)
  sketcherTools.click({ x: 50, y: 50 }, 0.5, null, false) // locks the inside
  sketcherTools.setOffsetDistance(distance)
  sketcherTools.overlayApply()
}

function bakedLoops(): Vec2[][] {
  const layerId = useCamStore.getState().activeSketch!.layerId
  useCamStore.getState().finishSketch()
  // WO-2189: every new sketch is its own part - find it through its layer's owner.
  const geo = useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))!
  return (geo.loops ?? []).filter((l) => l.layerId === layerId).map((l) => l.points)
}

describe('WO-1475: offset across a collapsed neck, through the store', () => {
  for (const d of [30, 45]) {
    it(`${d} mm inward: two valid disjoint regions are created and Finish bakes them intact`, () => {
      offsetThroughStore(d)
      const notice = useCamStore.getState().sketchNotice
      const loops = bakedLoops()
      writeEvidence(`${d}mm`, loops, notice)

      expect(notice).toMatch(/created/)
      // The source outline plus one region per block.
      expect(loops).toHaveLength(3)
      for (const l of loops) expect(isSimple(l)).toBe(true)

      const offsets = loops
        .filter((l) => Math.abs(Math.abs(area(ring(l))) - 2 * 100 * 100 - 60 * 20) > 1)
        .sort((a, b) => bboxOf(a).minX - bboxOf(b).minX)
      expect(offsets).toHaveLength(2)
      const [left, right] = offsets.map(bboxOf)
      expect(left.maxX).toBeLessThan(100)
      expect(right.minX).toBeGreaterThan(160)
      const want = expectedRegionArea(d)
      for (const l of offsets) {
        expect(Math.abs(Math.abs(area(ring(l))) - want)).toBeLessThan(1)
      }
    })
  }
})

describe('WO-1475: computeOffset whole-result check', () => {
  it('30 mm: the offset separates into two closed loops, each chained only to itself', () => {
    const geo = computeOffset(neckSource(), 1, 30)
    expect(typeof geo).not.toBe('string')
    if (typeof geo === 'string') return
    expect(geo.loops).toHaveLength(2)
    for (const loop of geo.loops) expect(loop.closed).toBe(true)
    let id = 0
    const commit = offsetCommit(geo, () => `w${id++}`)
    // One coincident per joint, all joints inside their own loop.
    expect(commit.constraints).toHaveLength(geo.pieces.length)
    const loopOf = new Map<string, number>()
    let k = 0
    geo.loops.forEach((loop, li) => {
      for (let i = 0; i < loop.pieces.length; i++) loopOf.set(commit.entities[k++].id, li)
    })
    for (const c of commit.constraints) {
      if (c.kind !== 'coincident') continue
      expect(loopOf.get(c.a.entityId)).toBe(loopOf.get(c.b.entityId))
    }
  })

  it('a distance nothing survives still refuses with the size reason', () => {
    const r = computeOffset(neckSource(), 1, 55)
    expect(typeof r).toBe('string')
    expect(r as string).toMatch(/too large|cannot trim|collapses/)
  })

  it('an offset with no crossing is unchanged: one loop, the local construction', () => {
    const geo = computeOffset(neckSource(), 1, 5)
    expect(typeof geo).not.toBe('string')
    if (typeof geo === 'string') return
    expect(geo.loops).toHaveLength(1)
    // 12 trimmed/parallel lines + 4 corner arcs at the reflex neck corners.
    expect(geo.pieces).toHaveLength(16)
  })
})
