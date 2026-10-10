// WO-1479 / BUG-541: bake typed a closed loop contour/hole by testing ONE
// vertex (points[0]) against every other loop. An angled rectangle whose
// first corner sits inside a centered rectangle -- the other three corners
// outside -- CROSSES it, yet came out a hole with reversed traversal, and the
// wrong type survived save + reopen.
//
// Contract pinned here: a loop counts as inside another only when its whole
// region is (boundary contact allowed); crossing outlines count toward
// neither loop's depth and are named in BakeResult.crossingLoops. Genuinely
// nested and genuinely disjoint loops type exactly as before.
//
// WRITE_EVIDENCE=1 (EVIDENCE_LABEL=before|after) renders the store case as
// SVG into src/tests/evidence/WO-1479/.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { bakeSketch } from '../../lib/sketch/bake'
import { buildRectCommit, buildRotatedRectCommit } from '../../lib/sketch/tools/rectTools'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'
import type { Loop2D, Vec2 } from '../../types'

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

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select',
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
})

const HALF_W = 100
const HALF_H = 94.696566 / 2
// Angled rectangle: first corner at the origin (inside the centered
// rectangle), first edge to (150, 50), 60 mm wide -> the other three corners
// all fall outside the centered rectangle.
const ANGLED_P1: Vec2 = { x: 0, y: 0 }
const ANGLED_P2: Vec2 = { x: 150, y: 50 }
const ANGLED_WIDTH_POINT: Vec2 = { x: -19, y: 57 }

function idFactory(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}

function sketchOf(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: 'layer-under-test', entities, constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function rect(prefix: string, a: Vec2, b: Vec2): SketchEntity[] {
  return buildRectCommit(a, b, false, idFactory(prefix)).entities.filter((e) => !e.construction)
}

function signedArea(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

const hasPoint = (loop: Loop2D, p: Vec2): boolean =>
  loop.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)

/** Enter sketch mode and draw the BUG-541 pair through the store's own
 *  entity/constraint actions, exactly as the rectangle tools commit them. */
function drawCrossingPair(): string {
  useCamStore.getState().setViewerMode('sketch')
  const layerId = useCamStore.getState().activeSketch!.layerId
  const centered = buildRectCommit(
    { x: -HALF_W, y: -HALF_H }, { x: HALF_W, y: HALF_H }, false, idFactory('c'))
  const angled = buildRotatedRectCommit(
    ANGLED_P1, ANGLED_P2, ANGLED_WIDTH_POINT, false, idFactory('a'))
  for (const commit of [centered, angled]) {
    for (const e of commit.entities) useCamStore.getState().addEntity(e)
    for (const c of commit.constraints) useCamStore.getState().addConstraint(c)
  }
  return layerId
}

function layerLoops(layerId: string): Loop2D[] {
  // WO-2189: every new sketch is its own part - find it through its layer's owner.
  const geo = useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
  return (geo?.loops ?? []).filter((l) => l.layerId === layerId && l.closed)
}

function writeEvidence(loops: Loop2D[]): void {
  if (!process.env.WRITE_EVIDENCE) return
  const label = process.env.EVIDENCE_LABEL ?? 'after'
  const dir = path.resolve(__dirname, '../evidence/WO-1479')
  fs.mkdirSync(dir, { recursive: true })
  const pad = 20
  const all = loops.flatMap((l) => l.points)
  const minX = Math.min(...all.map((p) => p.x)) - pad
  const maxX = Math.max(...all.map((p) => p.x)) + pad
  const minY = Math.min(...all.map((p) => p.y)) - pad
  const maxY = Math.max(...all.map((p) => p.y)) + pad
  const scale = 3
  const W = Math.max((maxX - minX) * scale, 1180)
  const H = (maxY - minY) * scale + 90
  const sx = (x: number) => (x - minX) * scale
  const sy = (y: number) => (maxY - y) * scale + 60
  const body = loops.map((l) => {
    const color = l.type === 'hole' ? '#d62728' : '#1f77b4'
    const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ') + ' Z'
    const c = l.points.reduce((acc, p) => ({ x: acc.x + p.x / l.points.length, y: acc.y + p.y / l.points.length }), { x: 0, y: 0 })
    const dir = signedArea(l.points) >= 0 ? 'CCW' : 'CW'
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${l.type === 'hole' ? 5 : 3}" ${l.type === 'hole' ? 'stroke-dasharray="14 8"' : ''}/>` +
      `<text x="${sx(c.x).toFixed(1)}" y="${(sy(c.y) + 70).toFixed(1)}" font-family="sans-serif" font-size="22" fill="${color}" text-anchor="middle">${l.type} (${dir})</text>`
  }).join('\n')
  const title = label === 'before'
    ? 'BEFORE (main): angled rectangle crossing the centered one is baked as a HOLE'
    : 'AFTER (WO-1479): crossing rectangle stays a CONTOUR; the pair is named as crossing'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="16" y="36" font-family="sans-serif" font-size="24" fill="#222">${title}</text>
${body}
</svg>
`
  fs.writeFileSync(path.join(dir, `${label}.svg`), svg)
  fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(
    loops.map((l) => ({ type: l.type, signedArea: signedArea(l.points), firstPoint: l.points[0] })), null, 2) + '\n')
}

describe('WO-1479: bake classifies loops by whole-loop containment', () => {
  it('BUG-541 through the store: Finish does not bake the crossing angled rectangle as a hole, and reopen keeps it', async () => {
    const layerId = drawCrossingPair()
    useCamStore.getState().finishSketch()

    const loops = layerLoops(layerId)
    expect(loops).toHaveLength(2)
    writeEvidence(loops)
    const angled = loops.find((l) => hasPoint(l, { x: 150, y: 50 }))!
    const centered = loops.find((l) => hasPoint(l, { x: HALF_W, y: HALF_H }))!
    expect(angled).toBeDefined()
    expect(centered).toBeDefined()
    expect(angled.type).toBe('contour')
    expect(signedArea(angled.points)).toBeGreaterThan(0) // CCW = contour traversal
    expect(centered.type).toBe('contour')
    expect(signedArea(centered.points)).toBeGreaterThan(0)

    // Cold reopen: save the project exactly as saveProjectToFile snapshots it
    // (JSON of the project), clear the session, open it through the store.
    const saved = JSON.stringify({ ...useCamStore.getState().project, schemaVersion: undefined })
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [] } }))
    await useCamStore.getState().loadProjectFromFile(saved)
    const reopened = layerLoops(layerId)
    expect(reopened).toHaveLength(2)
    const reAngled = reopened.find((l) => hasPoint(l, { x: 150, y: 50 }))!
    expect(reAngled.type).toBe('contour')
    expect(signedArea(reAngled.points)).toBeGreaterThan(0)
    expect(reopened.every((l) => l.type === 'contour')).toBe(true)
  })

  it('names the crossing pair (both loop ids) instead of guessing a hole', () => {
    const centered = rect('c', { x: -HALF_W, y: -HALF_H }, { x: HALF_W, y: HALF_H })
    const angled = buildRotatedRectCommit(ANGLED_P1, ANGLED_P2, ANGLED_WIDTH_POINT, false, idFactory('a'))
      .entities.filter((e) => !e.construction)
    const r = bakeSketch(sketchOf([...centered, ...angled]), { newId: idFactory('loop') })
    expect(r.loops.map((l) => l.type)).toEqual(['contour', 'contour'])
    expect(r.crossingLoops).toHaveLength(1)
    const ids = new Set([r.crossingLoops[0].a, r.crossingLoops[0].b])
    expect(ids).toEqual(new Set(r.loops.map((l) => l.id)))
  })

  it('a genuinely nested hole still bakes as a hole (CW), unchanged', () => {
    const outer = rect('o', { x: 0, y: 0 }, { x: 100, y: 60 })
    const inner = rect('i', { x: 20, y: 20 }, { x: 40, y: 40 })
    const r = bakeSketch(sketchOf([...outer, ...inner]))
    const byArea = [...r.loops].sort((a, b) => b.area - a.area)
    expect(byArea.map((l) => l.type)).toEqual(['contour', 'hole'])
    expect(signedArea(byArea[1].points)).toBeLessThan(0)
    expect(r.crossingLoops).toEqual([])
  })

  it('a nested hole that touches its parent boundary is still a hole, not a crossing', () => {
    const outer = rect('o', { x: 0, y: 0 }, { x: 100, y: 60 })
    const notch = rect('n', { x: 0, y: 20 }, { x: 30, y: 40 }) // left edge on the parent's left edge
    const r = bakeSketch(sketchOf([...outer, ...notch]))
    const byArea = [...r.loops].sort((a, b) => b.area - a.area)
    expect(byArea.map((l) => l.type)).toEqual(['contour', 'hole'])
    expect(r.crossingLoops).toEqual([])
  })

  it('two genuinely disjoint rectangles both stay contours, unchanged', () => {
    const a = rect('a', { x: 0, y: 0 }, { x: 40, y: 40 })
    const b = rect('b', { x: 60, y: 0 }, { x: 100, y: 40 })
    const r = bakeSketch(sketchOf([...a, ...b]))
    expect(r.loops.map((l) => l.type)).toEqual(['contour', 'contour'])
    expect(r.crossingLoops).toEqual([])
  })

  it('a plus-sign crossing with no vertex inside the other loop is still named', () => {
    const h = rect('h', { x: -50, y: -5 }, { x: 50, y: 5 })
    const v = rect('v', { x: -5, y: -50 }, { x: 5, y: 50 })
    const r = bakeSketch(sketchOf([...h, ...v]))
    expect(r.loops.map((l) => l.type)).toEqual(['contour', 'contour'])
    expect(r.crossingLoops).toHaveLength(1)
  })

  it('two crossing holes inside one contour are both holes (neither deepens the other)', () => {
    const outer = rect('o', { x: 0, y: 0 }, { x: 200, y: 100 })
    const h1 = rect('p', { x: 20, y: 20 }, { x: 80, y: 60 })
    const h2 = rect('q', { x: 50, y: 40 }, { x: 120, y: 80 }) // corner (50,40) inside h1
    const r = bakeSketch(sketchOf([...outer, ...h1, ...h2]))
    const byArea = [...r.loops].sort((a, b) => b.area - a.area)
    expect(byArea.map((l) => l.type)).toEqual(['contour', 'hole', 'hole'])
    expect(r.crossingLoops).toHaveLength(1)
  })

  it('island inside a hole (depth 2) still types back to contour', () => {
    const outer = rect('o', { x: 0, y: 0 }, { x: 100, y: 100 })
    const hole = rect('h', { x: 10, y: 10 }, { x: 90, y: 90 })
    const island = rect('i', { x: 40, y: 40 }, { x: 60, y: 60 })
    const r = bakeSketch(sketchOf([...outer, ...hole, ...island]))
    const byArea = [...r.loops].sort((a, b) => b.area - a.area)
    expect(byArea.map((l) => l.type)).toEqual(['contour', 'hole', 'contour'])
  })
})
