// WO-1565: an undercut cut goes only as far as the tool reaches without the neck,
// shank or holder rubbing the part or the remaining stock.
//
// Operator ruling 2026-09-15: "we can't ignore the holder or shank rubbing on the part... if
// the length of the undercut can't reach the narrow section of the T without
// rubbing the shank, we would have to only cut up to the point where there would be
// rubbing plus some allowance of clearance."
//
// Every case drives the REAL worker entry point (self.onmessage in
// toolpathWorker.ts) with a REAL contour built by the real builder, and checks the
// result against plain box geometry computed HERE - never against the module's own
// column grid.
//
// FIXTURES (decide-and-log in the WO): the builder enters a finish profile with a
// vertical plunge at its start point, so an undercut head can only work under an
// overhang it can reach sideways from where it came down. The WO's literal 40x20
// flange over a 10x10 stem hides the whole stem from a 6 mm lollipop (it reaches
// 1 mm sideways past its neck) and from a 20 mm disc's plunge point. So:
//   - the LIP T: 10x10 stem Z 0..10 under a flange Z 10..15 that overhangs the stem
//     by 0.3 mm and covers only its X <= 0 half (lollipop and flat end mill cases);
//   - the SHELF: the same stem with a shelf Z 10..15 standing 5 or 7 mm out of its
//     -X face (disc cases: a 20 mm disc with a 6 mm neck reaches 6.5 mm).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import type { HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove } from '../../types'
import type {
  ContourWorkerPayload, LoopData, PocketParams, PocketWorkerPayload, ToolpathStockBlock,
  WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import type { StockState } from '../../lib/cam/stockState'
import type { ToolReachInputs } from '../../lib/cam/holderClearanceGate'
import type { ToolpathCompleteWithNotices } from '../../lib/cam/toolpathWorker'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'

// ── Geometry ─────────────────────────────────────────────────────────────────

/** [minX, minY, minZ, maxX, maxY, maxZ] */
type Box = readonly [number, number, number, number, number, number]

const STEM: Box = [-5, -5, 0, 5, 5, 10]
const LIP: Box = [-5.3, -5.3, 10, 0, 5.3, 15]
const SHELF_5: Box = [-10, -4, 10, -5, 4, 15]
const SHELF_7: Box = [-12, -4, 10, -5, 4, 15]
/** Stock an earlier operation left standing beside the lip's -X side. */
const LUMP: Box = [-10, -12, 0, -7, 12, 15]
const CUT_Z = 5
const ALLOWANCE = 0.25

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    // corners: 0..3 bottom (x0y0, x1y0, x0y1, x1y1), 4..7 top
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/** What three-axis operations leave: each column filled up to the highest box over it. */
function silhouetteStock(boxes: readonly Box[], cell = 0.25): StockState {
  const bounds = { minX: -40, minY: -40, minZ: 0, maxX: 40, maxY: 40, maxZ: 15 }
  const nx = Math.round((bounds.maxX - bounds.minX) / cell)
  const ny = Math.round((bounds.maxY - bounds.minY) / cell)
  const topZ = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const y = bounds.minY + (j + 0.5) * cell
    for (let i = 0; i < nx; i++) {
      const x = bounds.minX + (i + 0.5) * cell
      for (const [x0, y0, , x1, y1, z1] of boxes) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) topZ[j * nx + i] = Math.max(topZ[j * nx + i], z1)
      }
    }
  }
  return {
    schemaVersion: 1, representation: 'z-dexel', bounds, requestedResolutionMm: cell, resolutionMm: cell,
    warnings: [], nx, ny, bottomZ: 0, topZ,
  }
}

function xyDistanceToBox(x: number, y: number, [x0, y0, , x1, y1]: Box): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

// ── Tools ────────────────────────────────────────────────────────────────────

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool-1', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

const FLAT_6 = tool({ name: '6 mm flat end mill' })
/** Lollipop 6, neck 3. The ball wraps to where it meets the neck at 3 + 2.598 mm. */
const LOLLIPOP_NECK_BOTTOM = 3 + Math.sqrt(9 - 2.25)
function lollipop(neckLengthMm: number): Tool {
  return tool({
    name: `6 mm lollipop, ${neckLengthMm} mm neck`, type: 'lollipop_mill',
    diameter: 6, fluteLength: 6, shankDiameter: 6, neckDiameter: 3, shoulderLength: neckLengthMm,
  })
}
const DISC_20 = tool({
  name: '20 mm slot cutter, 6 mm neck', type: 'slitting_saw',
  diameter: 20, fluteLength: 3, shankDiameter: 10, neckDiameter: 6, shoulderLength: 20, numberOfFlutes: 6,
})

// ── Requests ─────────────────────────────────────────────────────────────────

const STOCK_BLOCK: ToolpathStockBlock = { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 15 } }

const HEIGHTS: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute',
  retractHeight: 25, feedHeight: 20,
  topHeight: CUT_Z + 1, topHeightMode: 'absolute',
  bottomHeight: CUT_Z, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const STEM_LOOP: LoopData = {
  id: 'stem', closed: true, type: 'contour',
  points: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
}

function contourPayload(t: Tool, reach: ToolReachInputs = {}): ContourWorkerPayload & ToolReachInputs {
  return {
    opId: 'op-undercut', setupId: 'setup-1',
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false },
    heights: HEIGHTS, passes: PASSES, linking: LINKING,
    tool: t, loops: [STEM_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: STOCK_BLOCK,
    ...reach,
  }
}

type WorkerHandler = (event: MessageEvent<WorkerRequestMsg>) => Promise<void> | void
let handler: WorkerHandler | undefined
const posted: WorkerResponseMsg[] = []

beforeAll(async () => {
  await ensureClipperReady()
  ;(globalThis as unknown as Record<string, unknown>).self = {
    set onmessage(fn: WorkerHandler) { handler = fn },
    postMessage: (message: WorkerResponseMsg) => { posted.push(message) },
  }
  await import('../../lib/cam/toolpathWorker')
})

async function runWorker(type: string, payload: unknown): Promise<WorkerResponseMsg> {
  posted.length = 0
  await handler!({ data: { type, payload } } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  return terminal[0]
}

async function contour(t: Tool, reach: ToolReachInputs = {}): Promise<ToolpathCompleteWithNotices> {
  const response = await runWorker('COMPUTE_CONTOUR', contourPayload(t, reach))
  if (response.type !== 'TOOLPATH_COMPLETE') throw new Error(`expected a toolpath, got ${JSON.stringify(response)}`)
  return response as ToolpathCompleteWithNotices
}

// ── Reading a path ───────────────────────────────────────────────────────────

interface Sample { x: number; y: number; z: number; type: ToolpathMove['type'] }

function samples(moves: readonly ToolpathMove[], step = 0.1): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    expect(b.type === 'arc_cw' || b.type === 'arc_ccw', 'the contour fixture is polyline-only').toBe(false)
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, type: b.type })
    }
  }
  return out
}

/** Feed length cut at the profile's own depth. */
function cutLengthAtDepth(moves: readonly ToolpathMove[]): number {
  let length = 0
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid' || Math.abs(a.z - CUT_Z) > 1e-6 || Math.abs(b.z - CUT_Z) > 1e-6) continue
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return length
}

/** Smallest XY gap between a radial band of the tool and a box, over every sample
 *  where the band's height range meets the box's (the allowance widened in Z too). */
function smallestGap(moves: readonly ToolpathMove[], box: Box, bottom: number, top: number, radius: number): number {
  let gap = Number.POSITIVE_INFINITY
  for (const s of samples(moves)) {
    if (s.z + bottom - ALLOWANCE >= box[5] || s.z + top + ALLOWANCE <= box[2]) continue
    gap = Math.min(gap, xyDistanceToBox(s.x, s.y, box) - radius)
  }
  return gap
}

function stopNotices(response: ToolpathCompleteWithNotices): string[] {
  return (response.notices ?? []).filter((notice) => notice.includes('left uncut'))
}

// ── Evidence (WRITE_EVIDENCE=1 only) ─────────────────────────────────────────

const EVIDENCE_DIR = join('src', 'tests', 'evidence', 'WO-1565')

function writePicture(name: string, title: string, boxes: readonly Box[], before: readonly ToolpathMove[],
  after: ToolpathMove[], notices: readonly string[]): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  // Fit the view to the profile, so a 10 mm stem is not lost in the frame.
  const reach = before.reduce((far, m) => Math.abs(m.z - CUT_Z) < 1e-6 ? Math.max(far, Math.abs(m.x), Math.abs(m.y)) : far, 0)
  const half = Math.max(12, Math.ceil(reach + 3))
  const scale = 616 / (2 * half)
  const panel = (moves: readonly ToolpathMove[], offsetX: number, heading: string): string => {
    const px = (x: number) => (offsetX + (x + half) * scale).toFixed(1)
    const py = (y: number) => (60 + (half - y) * scale).toFixed(1)
    const parts: string[] = [`<text x="${offsetX + 10}" y="48" font-size="17" font-weight="bold">${heading}</text>`]
    parts.push(`<rect x="${offsetX}" y="60" width="${2 * half * scale}" height="${2 * half * scale}" fill="#fafafa" stroke="#999"/>`)
    for (const box of boxes) {
      const overhang = box[2] >= 10
      parts.push(
        `<rect x="${px(box[0])}" y="${py(box[4])}" width="${((box[3] - box[0]) * scale).toFixed(1)}" ` +
        `height="${((box[4] - box[1]) * scale).toFixed(1)}" fill="${overhang ? '#f4a340' : '#9aa4ad'}" ` +
        `fill-opacity="${overhang ? 0.55 : 0.9}" stroke="#333" stroke-width="1"/>`,
      )
    }
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1]
      const b = moves[i]
      const atDepth = Math.abs(a.z - CUT_Z) < 1e-6 && Math.abs(b.z - CUT_Z) < 1e-6 && b.type !== 'rapid'
      if (!atDepth) continue
      const back = b.role === 'lead_in' || b.role === 'lead_out'
      parts.push(
        `<line x1="${px(a.x)}" y1="${py(a.y)}" x2="${px(b.x)}" y2="${py(b.y)}" stroke="${back ? '#2a6fdb' : '#1b9e3e'}" ` +
        `stroke-width="${back ? 2 : 4}" ${back ? 'stroke-dasharray="5 4"' : ''}/>`,
      )
    }
    for (let i = 1; i < moves.length; i++) {
      const m = moves[i]
      if (m.role === 'plunge' || (m.type !== 'rapid' && moves[i - 1].type === 'rapid')) {
        parts.push(`<circle cx="${px(m.x)}" cy="${py(m.y)}" r="5" fill="none" stroke="#c0392b" stroke-width="2.5"/>`)
      }
    }
    return parts.join('\n')
  }
  const width = 2 * (2 * half * scale) + 60
  const lines = [
    'Top view. Grey = stem (Z 0..10). Orange = overhang (Z 10..15). Green = cut at Z 5.',
    'Dashed blue = backing out / in along the cut path. Red ring = where the tool comes down.',
    ...notices,
  ]
  const textY = 60 + 2 * half * scale + 30
  const wrapped: string[] = []
  for (const line of lines) {
    let rest = line
    while (rest.length > 150) {
      const cut = rest.lastIndexOf(' ', 150)
      wrapped.push(rest.slice(0, cut))
      rest = rest.slice(cut + 1)
    }
    wrapped.push(rest)
  }
  const height = textY + wrapped.length * 20 + 20
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    `<text x="20" y="24" font-size="19" font-weight="bold">${title}</text>`,
    panel(before, 20, 'Before: the builder path, as it reached the operation'),
    panel(after, 40 + 2 * half * scale, 'After WO-1565: cut only what the tool reaches'),
    ...wrapped.map((line, i) =>
      `<text x="20" y="${textY + i * 20}" font-size="14">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`),
    '</svg>',
  ].join('\n')
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, `${name}.svg`), svg)
}

// ── 1 + 2. Lollipop on the lip T ─────────────────────────────────────────────

describe('WO-1565 lollipop under the lip', () => {
  const part = meshOf([STEM, LIP])
  const remainingStock = silhouetteStock([STEM, LIP])

  it('1. a neck long enough to clear the flange cuts the whole stem profile, no rub reported', async () => {
    const t = lollipop(12)
    const builder = buildContourToolpath(contourPayload(t))
    const response = await contour(t, { clearancePart: part, remainingStock, clearanceAllowanceMm: ALLOWANCE })
    expect(response.moves).toEqual(builder)
    expect(stopNotices(response)).toEqual([])
    // Checked here from plain geometry: the neck clears the lip by the allowance.
    expect(smallestGap(response.moves, LIP, LOLLIPOP_NECK_BOTTOM, LOLLIPOP_NECK_BOTTOM + 12, 1.5))
      .toBeGreaterThanOrEqual(ALLOWANCE)
    writePicture('case1-lollipop-long-neck', 'Case 1 - 6 mm lollipop, 3 mm neck, 12 mm long: reaches under the 0.3 mm lip',
      [STEM, LIP], builder, response.moves, response.notices ?? ['(no console notices - nothing to report)'])
  })

  it('2. a neck too short stops the cut where the shank would come within 0.25 mm of the flange, and says so', async () => {
    const t = lollipop(3)
    const builder = buildContourToolpath(contourPayload(t))
    const response = await contour(t, { clearancePart: part, remainingStock, clearanceAllowanceMm: ALLOWANCE })
    const shankBottom = LOLLIPOP_NECK_BOTTOM + 3

    // Today's path would drive the shank straight through the flange.
    expect(smallestGap(builder, LIP, shankBottom, 1e6, 3)).toBeLessThan(0)
    // The trimmed path never brings it within the allowance.
    expect(smallestGap(response.moves, LIP, shankBottom, 1e6, 3)).toBeGreaterThanOrEqual(ALLOWANCE)

    const cut = cutLengthAtDepth(response.moves)
    expect(cut).toBeGreaterThan(10)
    expect(cut).toBeLessThan(cutLengthAtDepth(builder) - 10)

    const stops = stopNotices(response)
    expect(stops.length).toBeGreaterThan(0)
    expect(stops[0]).toMatch(
      /^Contour: cut stopped at X -?[\d.]+ Y -?[\d.]+ Z 5\.00 - the shank would come within 0.25 mm of the part\. [\d.]+ mm of cutting path was left uncut, up to X .* where it picks up again; reached Z [\d.]+ of Z [\d.]+ asked; a tool with a longer reach cuts the rest\.$/,
    )
    // "Stops short where the shank would come within 0.25 mm": the stop sits at the allowance, not far before it.
    const [, sx, sy] = /cut stopped at X (-?[\d.]+) Y (-?[\d.]+)/.exec(stops[0])!
    const gapAtStop = xyDistanceToBox(Number(sx), Number(sy), LIP) - 3
    expect(gapAtStop).toBeGreaterThanOrEqual(ALLOWANCE - 0.01)
    expect(gapAtStop).toBeLessThan(ALLOWANCE + 0.5)
    writePicture('case2-lollipop-short-neck', 'Case 2 - 6 mm lollipop, 3 mm neck only 3 mm long: the shank would rub the flange',
      [STEM, LIP], builder, response.moves, response.notices ?? [])
  })
})

// ── 3. Slot (disc) cutter under a shelf ──────────────────────────────────────

describe('WO-1565 slot cutter under a shelf', () => {
  it('3a. reaching 5 mm under the shelf: the whole profile is cut', async () => {
    const response = await contour(DISC_20, {
      clearancePart: meshOf([STEM, SHELF_5]), remainingStock: silhouetteStock([STEM, SHELF_5]), clearanceAllowanceMm: ALLOWANCE,
    })
    expect(response.moves).toEqual(buildContourToolpath(contourPayload(DISC_20)))
    expect(stopNotices(response)).toEqual([])
  })

  it('3b. a 7 mm shelf is past its reach: cut to its reach, the rest reported', async () => {
    const builder = buildContourToolpath(contourPayload(DISC_20))
    const response = await contour(DISC_20, {
      clearancePart: meshOf([STEM, SHELF_7]), remainingStock: silhouetteStock([STEM, SHELF_7]), clearanceAllowanceMm: ALLOWANCE,
    })
    // Neck: 6 mm, from the top of the 3 mm disc for 20 mm.
    expect(smallestGap(builder, SHELF_7, 3, 23, 3)).toBeLessThan(ALLOWANCE)
    expect(smallestGap(response.moves, SHELF_7, 3, 23, 3)).toBeGreaterThanOrEqual(ALLOWANCE)

    const atDepth = samples(response.moves).filter((s) => s.type !== 'rapid' && Math.abs(s.z - CUT_Z) < 1e-6)
    // The -X face under the shelf is not cut; the other three faces are.
    expect(atDepth.some((s) => s.x < -14 && Math.abs(s.y) < 3)).toBe(false)
    expect(atDepth.some((s) => s.x > 14 && Math.abs(s.y) < 3)).toBe(true)
    expect(atDepth.some((s) => s.y > 14 && Math.abs(s.x) < 3)).toBe(true)
    expect(atDepth.some((s) => s.y < -14 && Math.abs(s.x) < 3)).toBe(true)

    const stops = stopNotices(response)
    expect(stops).toHaveLength(1)
    // The shelf is both the part and the remaining stock here; either names the same obstacle.
    expect(stops[0]).toMatch(/the neck would come within 0.25 mm of the (part|remaining stock)/)
    const uncut = Number(/([\d.]+) mm of cutting path was left uncut/.exec(stops[0])![1])
    expect(uncut).toBeGreaterThan(10)
    writePicture('case3-slot-cutter-shelf', 'Case 3 - 20 mm slot cutter, 6 mm neck (reaches 6.5 mm) under a 7 mm shelf',
      [STEM, SHELF_7], builder, response.moves, response.notices ?? [])
  })
})

// ── 4. Flat end mill ─────────────────────────────────────────────────────────

describe('WO-1565 flat end mill under the lip', () => {
  it('4. cuts nothing under the flange and reports it', async () => {
    const builder = buildContourToolpath(contourPayload(FLAT_6))
    const response = await contour(FLAT_6, {
      clearancePart: meshOf([STEM, LIP]), remainingStock: silhouetteStock([STEM, LIP]), clearanceAllowanceMm: ALLOWANCE,
    })
    // Today: the flutes (Z 5..25) run through the lip.
    expect(smallestGap(builder, LIP, 0, 20, 3)).toBeLessThan(0)
    // After: no flute ever enters it (past the 0.08 mm the part grid can resolve).
    const flutesInLip = samples(response.moves).filter((s) =>
      s.z < LIP[5] && s.z + 20 > LIP[2] && xyDistanceToBox(s.x, s.y, LIP) < 3 - 0.08)
    expect(flutesInLip).toEqual([])
    expect(cutLengthAtDepth(response.moves)).toBeGreaterThan(10)
    const stops = stopNotices(response)
    expect(stops.length).toBeGreaterThan(0)
    expect(stops.join('\n')).toMatch(/the cutter would cut into the part/)
    writePicture('case4-flat-end-mill', 'Case 4 - 6 mm flat end mill: its flutes cannot go under the flange',
      [STEM, LIP], builder, response.moves, response.notices ?? [])
  })
})

// ── 5. Remaining stock ───────────────────────────────────────────────────────

describe('WO-1565 remaining stock', () => {
  it('5. keeps the neck and shank clear of stock an earlier operation left beside the flange', async () => {
    const t = lollipop(12)
    const response = await contour(t, {
      clearancePart: meshOf([STEM, LIP]), remainingStock: silhouetteStock([STEM, LIP, LUMP]), clearanceAllowanceMm: ALLOWANCE,
    })
    expect(smallestGap(buildContourToolpath(contourPayload(t)), LUMP, LOLLIPOP_NECK_BOTTOM, 1e6, 1.5)).toBeLessThan(0)
    expect(smallestGap(response.moves, LUMP, LOLLIPOP_NECK_BOTTOM, LOLLIPOP_NECK_BOTTOM + 12, 1.5)).toBeGreaterThanOrEqual(ALLOWANCE)
    expect(smallestGap(response.moves, LUMP, LOLLIPOP_NECK_BOTTOM + 12, 1e6, 3)).toBeGreaterThanOrEqual(ALLOWANCE)
    const stops = stopNotices(response)
    expect(stops.length).toBeGreaterThan(0)
    expect(stops.join('\n')).toMatch(/would come within 0.25 mm of the remaining stock/)
  })

  it('uses the stock as loaded when no remaining stock is known, and says so', async () => {
    const response = await contour(lollipop(12), { clearancePart: meshOf([STEM, LIP]) })
    expect(response.notices?.join('\n')).toMatch(/kept clear of the stock as loaded - this operation was not told what earlier operations removed/)
    expect(stopNotices(response).join('\n')).toMatch(/of the stock as loaded/)
  })

  it('defaults the allowance to 0.25 mm (Operator) when the operation sets none', async () => {
    const response = await contour(lollipop(3), { clearancePart: meshOf([STEM, LIP]), remainingStock: silhouetteStock([STEM, LIP]) })
    expect(stopNotices(response)[0]).toMatch(/within 0.25 mm/)
  })
})

// ── Coming straight down ─────────────────────────────────────────────────────

describe('WO-1565 a head coming straight down', () => {
  const block = silhouetteStock([[-40, -40, 0, 40, 40, 15]])
  const plunge: ToolpathMove[] = [
    { type: 'rapid', x: 20, y: 20, z: 30, role: 'rapid' },
    { type: 'feed', x: 20, y: 20, z: 5, role: 'plunge', feed: 300 },
  ]

  it('lets the neck follow the bore its own ball made, but not the wider shank', async () => {
    const { trimToolpathToAssemblyReach } = await import('../../lib/cam/holderClearance')
    const neckOnly = trimToolpathToAssemblyReach({ moves: plunge, tool: lollipop(40), holder: HOLDER, stock: block, allowanceMm: ALLOWANCE })
    expect(neckOnly.trimmed).toBe(false)
    expect(neckOnly.moves).toBe(plunge)
    // The same head pushed on sideways drags its neck through solid stock.
    const sideways = [...plunge, { type: 'feed', x: 30, y: 20, z: 5, role: 'cut', feed: 1000 } as ToolpathMove]
    expect(trimToolpathToAssemblyReach({ moves: sideways, tool: lollipop(40), holder: HOLDER, stock: block, allowanceMm: ALLOWANCE })
      .stops[0]?.blocker).toEqual({ component: 'neck', obstacle: 'stock' })
    // A short neck puts the 6 mm shank (wider than the 6 mm ball's bore once the allowance is added) into the block.
    const shank = trimToolpathToAssemblyReach({ moves: plunge, tool: lollipop(3), holder: HOLDER, stock: block, allowanceMm: ALLOWANCE })
    expect(shank.stops[0]?.blocker).toEqual({ component: 'shank', obstacle: 'stock' })
  })
})

// ── The neck is modelled as the neck ─────────────────────────────────────────

describe('WO-1565 the tool assembly as it is', () => {
  it('names the neck, not the shank, when a lollipop neck meets the stock as loaded', async () => {
    const response = await runWorker('COMPUTE_CONTOUR', contourPayload(lollipop(12)))
    expect(response.type).toBe('TOOLPATH_ERROR')
    expect((response as { message: string }).message).toMatch(/^Contour: the neck would hit the stock\./)
  })
})

// ── 6. Unchanged without a neck ──────────────────────────────────────────────

describe('WO-1565 an open pocket with a no-neck tool', () => {
  const POCKET_PARAMS: PocketParams = {
    geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }
  const payload: PocketWorkerPayload = {
    opId: 'op-pocket', setupId: 'setup-1', params: POCKET_PARAMS,
    heights: { ...HEIGHTS, clearanceHeight: 15, retractHeight: 5, feedHeight: 1, topHeight: 0, bottomHeight: -6 },
    passes: { stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: LINKING, tool: FLAT_6,
    loops: [{ id: 'pocket', closed: true, type: 'contour', points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }] }],
    wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: { min: { x: 0, y: 0, z: -20 }, max: { x: 60, y: 60, z: 0 } },
  }

  it('6. gives today\'s result unchanged', async () => {
    const response = await runWorker('COMPUTE_POCKET', payload)
    expect(response.type).toBe('TOOLPATH_COMPLETE')
    expect((response as ToolpathCompleteWithNotices).moves).toEqual(buildPocketToolpath(payload))
    expect((response as ToolpathCompleteWithNotices).notices).toBeUndefined()
  })
})
