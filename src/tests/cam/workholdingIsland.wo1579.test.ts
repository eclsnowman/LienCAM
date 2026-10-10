// WO-1579: pocket and adaptive clearing clear around a clamp.
//
// Architect decision 2026-09-15 on Operator's fixture and clamp avoidance mandate: a clamp
// inside a clearing region is cleared around like an island, not left as a trimmed gap.
//
// Every program comes out of the REAL worker entry point (self.onmessage), so the
// WO-1575 reach trim runs on it exactly as in the app. Distances and coverage are
// measured against plain box geometry computed HERE.
//
// SCENE: a 100 x 60 pocket (X -50..50, Y -30..30) cut from Z 10 to Z 5 with a 6 mm end
// mill. A 15 mm wide STRAP clamp lies across its middle (X -7.5..7.5) on the stock top,
// Z 10..16, and runs past both long walls. LIFTED is the same strap at Z 5000, far above
// anything the cutter or holder reaches while cutting.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import type { HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove } from '../../types'
import type {
  ACWorkerPayload, LoopData, PocketWorkerPayload, ToolpathStockBlock, WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import type { ToolReachInputs } from '../../lib/cam/holderClearanceGate'
import type { ToolpathCompleteWithNotices } from '../../lib/cam/toolpathWorker'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { trimToolpathToToolReach } from '../../lib/cam/holderClearanceGate'

type Box = readonly [number, number, number, number, number, number]

const STRAP: Box = [-7.5, -45, 10, 7.5, 45, 16]
const LIFTED: Box = [-7.5, -45, 5000, 7.5, 45, 5006]
const TOOL_RADIUS = 3
const ALLOWANCE = 0.25
const TOP_Z = 10
const BOTTOM_Z = 5

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function xyDistanceToBox(x: number, y: number, [x0, y0, , x1, y1]: Box): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

const FLAT_6 = {
  id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2.5, stepover: 2.4 } },
} as unknown as Tool

const STOCK_BLOCK: ToolpathStockBlock = { min: { x: -60, y: -40, z: 0 }, max: { x: 60, y: 40, z: TOP_Z } }
const HEIGHTS: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute',
  retractHeight: 25, feedHeight: 22,
  topHeight: TOP_Z, topHeightMode: 'absolute',
  bottomHeight: BOTTOM_Z, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 2.5, stepover: 2.4, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
// The adaptive engine's own entry-test settings.
const AC_PARAMS = {
  geometryId: 'g', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
  stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
  helixDiameter: 90, tolerance: 0.02,
} as unknown as ACWorkerPayload['params']
const AC_PASSES: PassParams = { stepdown: 5, stepover: 1.2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const AC_LINKING: LinkingParams = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1,
  retractType: 'full', transitionType: 'safe_height',
}
const POCKET_LOOP: LoopData = {
  id: 'pocket', closed: true, type: 'contour',
  points: [{ x: -50, y: -30 }, { x: 50, y: -30 }, { x: 50, y: 30 }, { x: -50, y: 30 }],
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

function reachWith(boxes: readonly Box[] | null): ToolReachInputs {
  return {
    clearanceAllowanceMm: ALLOWANCE,
    ...(boxes ? { workholding: [meshOf(boxes)] } : {}),
  }
}

function pocketPayload(reach: ToolReachInputs): PocketWorkerPayload & ToolReachInputs {
  return {
    opId: 'op-pocket', setupId: 'setup-1',
    params: { loopIds: [], direction: 'climb', fillStrategy: 'outside_in', finishContour: false } as unknown as PocketWorkerPayload['params'],
    heights: HEIGHTS, passes: PASSES, linking: LINKING,
    tool: FLAT_6, loops: [POCKET_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: STOCK_BLOCK,
    ...reach,
  }
}

async function run(type: 'COMPUTE_POCKET' | 'COMPUTE_ADAPTIVE_CLEARING', reach: ToolReachInputs):
  Promise<ToolpathCompleteWithNotices> {
  const payload = type === 'COMPUTE_POCKET'
    ? pocketPayload(reach)
    : {
        opId: 'op-ac', setupId: 'setup-1',
        params: AC_PARAMS,
        heights: HEIGHTS, passes: AC_PASSES, linking: AC_LINKING,
        tool: FLAT_6, loops: [POCKET_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
        holder: HOLDER, stockBlock: STOCK_BLOCK,
        ...reach,
      } satisfies ACWorkerPayload & ToolReachInputs
  posted.length = 0
  await handler!({ data: { type, payload } } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  if (terminal[0].type !== 'TOOLPATH_COMPLETE') throw new Error(`expected a toolpath, got ${JSON.stringify(terminal[0])}`)
  return terminal[0] as ToolpathCompleteWithNotices
}

// ── Reading a path ───────────────────────────────────────────────────────────

interface Sample { x: number; y: number; z: number; type: ToolpathMove['type'] }

/** Positions along the path, arcs followed around their centre. */
function samples(moves: readonly ToolpathMove[], step = 0.1): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && typeof b.cx === 'number' && typeof b.cy === 'number') {
      const r = Math.hypot(a.x - b.cx, a.y - b.cy)
      const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
      let a1 = Math.atan2(b.y - b.cy, b.x - b.cx)
      if (b.type === 'arc_ccw') { while (a1 <= a0) a1 += 2 * Math.PI } else { while (a1 >= a0) a1 -= 2 * Math.PI }
      const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) * r / step))
      for (let k = 0; k <= n; k++) {
        const t = k / n
        const ang = a0 + (a1 - a0) * t
        out.push({ x: b.cx + r * Math.cos(ang), y: b.cy + r * Math.sin(ang), z: a.z + (b.z - a.z) * t, type: b.type })
      }
      continue
    }
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, type: b.type })
    }
  }
  return out
}

/** The closest the cutter's side comes to the strap, over every position where the
 *  tool (tip to 1000 mm up) is below the strap's top. */
function closestUnderStrapTop(moves: readonly ToolpathMove[], strap: Box): number {
  let closest = Number.POSITIVE_INFINITY
  for (const s of samples(moves)) {
    if (s.z >= strap[5]) continue
    closest = Math.min(closest, xyDistanceToBox(s.x, s.y, strap) - TOOL_RADIUS)
  }
  return closest
}

/** Grid points of the pocket floor the cutter swept at the final depth. */
function sweptFloor(moves: readonly ToolpathMove[]): Set<string> {
  const buckets = new Map<string, Sample[]>()
  for (const s of samples(moves, 0.2)) {
    if (s.type === 'rapid' || Math.abs(s.z - BOTTOM_Z) > 1e-6) continue
    const key = `${Math.floor(s.x)},${Math.floor(s.y)}`
    const list = buckets.get(key)
    if (list) list.push(s); else buckets.set(key, [s])
  }
  const swept = new Set<string>()
  for (let gx = -50; gx <= 50; gx += 0.5) {
    for (let gy = -30; gy <= 30; gy += 0.5) {
      let hit = false
      for (let bx = Math.floor(gx) - 4; bx <= Math.floor(gx) + 4 && !hit; bx++) {
        for (let by = Math.floor(gy) - 4; by <= Math.floor(gy) + 4 && !hit; by++) {
          for (const s of buckets.get(`${bx},${by}`) ?? []) {
            if (Math.hypot(s.x - gx, s.y - gy) <= TOOL_RADIUS + 0.05) { hit = true; break }
          }
        }
      }
      if (hit) swept.add(`${gx},${gy}`)
    }
  }
  return swept
}

/** Floor points the plain program clears, at least `margin` from the strap, that the
 *  clamped program leaves standing. */
function uncleared(plain: Set<string>, clamped: Set<string>, margin: number): string[] {
  const missing: string[] = []
  for (const key of plain) {
    const [x, y] = key.split(',').map(Number)
    const d = xyDistanceToBox(x, y, STRAP)
    if (d < margin) continue
    // The strap meets each long wall in a square inside corner no round cutter reaches.
    if (Math.abs(y) > 30 - TOOL_RADIUS && d < margin + TOOL_RADIUS) continue
    if (!clamped.has(key)) missing.push(key)
  }
  return missing
}

function stopNotices(notices: readonly string[] | undefined): string[] {
  return (notices ?? []).filter((notice) => notice.includes('left uncut') || notice.includes('cut stopped'))
}

// Grown footprint: allowance + half-diagonal of the 0.05 mm column cell + 0.05 margin.
const GROW = ALLOWANCE + 0.05 * Math.SQRT1_2 + 0.05

// ── Pocket ───────────────────────────────────────────────────────────────────

describe('WO-1579 pocket clears around a strap clamp', () => {
  it('clears both halves, keeps the cutter clear of the clamp, and no trim stop is left', async () => {
    const plain = await run('COMPUTE_POCKET', reachWith(null))
    const clamped = await run('COMPUTE_POCKET', reachWith([STRAP]))

    // Precondition: the plain program really runs through the strap's footprint.
    expect(closestUnderStrapTop(plain.moves, STRAP)).toBeLessThan(0)

    expect(stopNotices(clamped.notices)).toEqual([])
    // The reduction reaches the console through the worker, not only the planner.
    expect((clamped.notices ?? []).some((notice) => notice.includes('clearing region was reduced'))).toBe(true)
    expect(closestUnderStrapTop(clamped.moves, STRAP)).toBeGreaterThanOrEqual(ALLOWANCE)

    const plainFloor = sweptFloor(plain.moves)
    const clampedFloor = sweptFloor(clamped.moves)
    // Both halves: everything the plain pocket clears more than the grown footprint
    // (plus one grid step) away from the strap is cleared with the clamp in place.
    expect(uncleared(plainFloor, clampedFloor, GROW + 0.5)).toEqual([])
    let left = 0
    let right = 0
    for (const key of clampedFloor) {
      const x = Number(key.split(',')[0])
      if (x < -7.5) left++
      if (x > 7.5) right++
    }
    expect(left).toBeGreaterThan(0.9 * (42.5 * 2 + 1) * (60 * 2 + 1) * 0.8)
    expect(right).toBeGreaterThan(0.9 * (42.5 * 2 + 1) * (60 * 2 + 1) * 0.8)
  })

  it('a clamp lifted above the holder leaves the program identical to no clamp', async () => {
    const notices: string[] = []
    const planned = buildPocketToolpath(pocketPayload(reachWith([LIFTED])), undefined, (message) => notices.push(message))
    expect(planned).toEqual(buildPocketToolpath(pocketPayload(reachWith(null))))
    expect(notices).toEqual([])
    // Through the worker the region is untouched too; what differs from the plain
    // program is only the WO-1575 trim, which models the spindle above the holder as
    // reaching all the way up, so it still stops under a clamp at any height.
    const lifted = await run('COMPUTE_POCKET', reachWith([LIFTED]))
    expect(lifted.moves.length).toBeGreaterThan(0)
    expect((lifted.notices ?? []).some((notice) => notice.includes('clearing region was reduced'))).toBe(false)
  })

  it('the console says the region was reduced around the workholding and by how much', () => {
    const notices: string[] = []
    buildPocketToolpath(pocketPayload(reachWith([STRAP])), undefined, (message) => notices.push(message))
    expect(notices).toHaveLength(1)
    const match = /^Pocket: the clearing region was reduced around the workholding by (\d+\.\d) sq mm/.exec(notices[0])
    expect(match, notices[0]).not.toBeNull()
    // The strap crosses the full 60 mm height; its 15 mm width grows by GROW each side.
    expect(Number(match![1])).toBeCloseTo(60 * (15 + 2 * GROW), 0)

    const quiet: string[] = []
    buildPocketToolpath(pocketPayload(reachWith([LIFTED])), undefined, (message) => quiet.push(message))
    expect(quiet).toEqual([])
  })

  it('a clamp inside the pocket becomes an island the rings go around', async () => {
    const block: Box = [-5, -5, 0, 5, 5, 14]
    const plain = await run('COMPUTE_POCKET', reachWith(null))
    const clamped = await run('COMPUTE_POCKET', reachWith([block]))
    expect(stopNotices(clamped.notices)).toEqual([])
    expect(closestUnderStrapTop(clamped.moves, block)).toBeGreaterThanOrEqual(ALLOWANCE)
    const plainFloor = sweptFloor(plain.moves)
    const clampedFloor = sweptFloor(clamped.moves)
    const missing = [...plainFloor].filter((key) => {
      const [x, y] = key.split(',').map(Number)
      return xyDistanceToBox(x, y, block) >= GROW + 0.5 && !clampedFloor.has(key)
    })
    expect(missing).toEqual([])
  })
})

// ── Adaptive clearing ────────────────────────────────────────────────────────

describe('WO-1579 adaptive clearing clears around a strap clamp', () => {
  it('clears both halves with the cutter clear of the clamp and no trim stop', async () => {
    const plain = await run('COMPUTE_ADAPTIVE_CLEARING', reachWith(null))
    const clamped = await run('COMPUTE_ADAPTIVE_CLEARING', reachWith([STRAP]))

    expect(closestUnderStrapTop(plain.moves, STRAP)).toBeLessThan(0)
    expect(stopNotices(clamped.notices)).toEqual([])
    // The reduction reaches the console through the worker, not only the planner.
    expect((clamped.notices ?? []).some((notice) => notice.includes('clearing region was reduced'))).toBe(true)
    expect(closestUnderStrapTop(clamped.moves, STRAP)).toBeGreaterThanOrEqual(ALLOWANCE)
    expect((clamped.notices ?? []).some((notice) =>
      notice.startsWith('Adaptive Clearing: the clearing region was reduced around the workholding by'))).toBe(true)

    const plainFloor = sweptFloor(plain.moves)
    const clampedFloor = sweptFloor(clamped.moves)
    expect(uncleared(plainFloor, clampedFloor, GROW + 0.5)).toEqual([])
  }, 120_000)

  it('a clamp lifted above the holder leaves the program identical to no clamp', async () => {
    // As planned, before the worker's trim (see the pocket case for why the trim differs).
    const { buildAdaptiveClearingToolpath } = await import('../../lib/cam/adaptiveClearing2d/engine')
    const notices: string[] = []
    const base = { opId: 'op-ac', setupId: 'setup-1', params: AC_PARAMS, heights: HEIGHTS, passes: AC_PASSES,
      linking: AC_LINKING, tool: FLAT_6, loops: [POCKET_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 } }
    const planned = await buildAdaptiveClearingToolpath({ ...base, ...reachWith([LIFTED]) }, undefined, (m) => notices.push(m))
    expect(planned).toEqual(await buildAdaptiveClearingToolpath(base))
    expect(notices.some((notice) => notice.includes('clearing region was reduced'))).toBe(false)
  }, 120_000)
})

// ── Evidence (WRITE_EVIDENCE=1 only): the plan view Operator's verdict reads ─────
//
// A TOP view, not a side view: what this order changes is where in X/Y the
// clearing goes, so the shared side-view drawer (tests/helpers/sideViewEvidence)
// is the wrong picture for it and is not copied here.
//
// BEFORE is what main does with the same request: the pocket is planned without
// looking at the workholding and the WO-1575 reach trim stops the cut at the
// clamp - the same trimToolpathToToolReach the worker runs. AFTER is the worker
// on this branch. Same part, same tool, same request.

const EVIDENCE_DIR = join('src', 'tests', 'evidence', 'WO-1579')
const FLOOR_EPS = 1e-6

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) { out.push(line); line = word } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

function onFloor(a: ToolpathMove, b: ToolpathMove): boolean {
  return b.type !== 'rapid' && Math.abs(a.z - BOTTOM_Z) < FLOOR_EPS && Math.abs(b.z - BOTTOM_Z) < FLOOR_EPS
}

/** One polyline per run of consecutive kept moves, sampled (arcs followed). */
function runs(moves: readonly ToolpathMove[], keep: (a: ToolpathMove, b: ToolpathMove) => boolean): Sample[][] {
  const out: Sample[][] = []
  let current: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    if (!keep(moves[i - 1], moves[i])) {
      if (current.length > 1) out.push(current)
      current = []
      continue
    }
    const piece = samples([moves[i - 1], moves[i]], 0.25)
    current.push(...(current.length > 0 ? piece.slice(1) : piece))
  }
  if (current.length > 1) out.push(current)
  return out
}

interface PlanMeasures {
  closest: number; stops: string[]; uncutPoints: string[]
  /** Moves whose path passes over the strap's footprint, and the lowest tip Z there. */
  crossings: number; lowestOver: number
}

function measure(moves: readonly ToolpathMove[], notices: readonly string[], plainFloor: Set<string>): PlanMeasures {
  let crossings = 0
  let lowestOver = Number.POSITIVE_INFINITY
  for (let i = 1; i < moves.length; i++) {
    const over = samples([moves[i - 1], moves[i]], 0.25).filter((s) => xyDistanceToBox(s.x, s.y, STRAP) === 0)
    if (over.length === 0) continue
    crossings++
    lowestOver = Math.min(lowestOver, ...over.map((s) => s.z))
  }
  return {
    closest: closestUnderStrapTop(moves, STRAP),
    stops: stopNotices(notices),
    uncutPoints: uncleared(plainFloor, sweptFloor(moves), GROW + 0.5),
    crossings, lowestOver,
  }
}

function writePlanView(name: string, title: string, moves: readonly ToolpathMove[], m: PlanMeasures,
  captions: readonly string[]): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  // The window holds the pocket, the whole strap and every move of the program.
  const xs = [-50, 50, STRAP[0], STRAP[3], ...moves.map((mv) => mv.x)]
  const ys = [-30, 30, STRAP[1], STRAP[4], ...moves.map((mv) => mv.y)]
  const minX = Math.min(...xs) - 6
  const maxX = Math.max(...xs) + 6
  const minY = Math.min(...ys) - 6
  const maxY = Math.max(...ys) + 6
  const scale = 7
  const left = 40
  const top = 60
  const px = (x: number) => (left + (x - minX) * scale).toFixed(1)
  const py = (y: number) => (top + (maxY - y) * scale).toFixed(1)
  const w = (maxX - minX) * scale
  const h = (maxY - minY) * scale
  const poly = (pts: readonly Sample[]) => pts.map((s) => `${px(s.x)},${py(s.y)}`).join(' ')

  const parts: string[] = [
    `<text x="${left}" y="34" font-size="18" font-weight="bold">${esc(title)}</text>`,
    `<rect x="${left}" y="${top}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#fafafa" stroke="#999"/>`,
  ]
  // Floor swept at the final depth, drawn at the cutter's full diameter.
  const floorRuns = runs(moves, onFloor)
  parts.push(`<g opacity="0.35">${floorRuns.map((r) => `<polyline points="${poly(r)}" fill="none" stroke="#1f6feb" ` +
    `stroke-width="${(2 * TOOL_RADIUS * scale).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</g>`)
  // Every other move, centreline only.
  const otherRuns = runs(moves, (a, b) => !onFloor(a, b))
  parts.push(...otherRuns.map((r) => `<polyline points="${poly(r)}" fill="none" stroke="#e67e22" stroke-width="1" stroke-dasharray="4 3"/>`))
  parts.push(...floorRuns.map((r) => `<polyline points="${poly(r)}" fill="none" stroke="#0b3d91" stroke-width="1"/>`))
  // Pocket boundary.
  parts.push(`<rect x="${px(-50)}" y="${py(30)}" width="${(100 * scale).toFixed(1)}" height="${(60 * scale).toFixed(1)}" ` +
    'fill="none" stroke="#000" stroke-width="2"/>')
  // The strap, and the line the cutter's centre stays outside (tool radius + allowance).
  parts.push(`<rect x="${px(STRAP[0])}" y="${py(STRAP[4])}" width="${((STRAP[3] - STRAP[0]) * scale).toFixed(1)}" ` +
    `height="${((STRAP[4] - STRAP[1]) * scale).toFixed(1)}" fill="#c0392b" fill-opacity="0.45" stroke="#7b241c"/>`)
  const keep = TOOL_RADIUS + ALLOWANCE
  parts.push(`<rect x="${px(STRAP[0] - keep)}" y="${py(STRAP[4] + keep)}" width="${((STRAP[3] - STRAP[0] + 2 * keep) * scale).toFixed(1)}" ` +
    `height="${((STRAP[4] - STRAP[1] + 2 * keep) * scale).toFixed(1)}" rx="${(keep * scale).toFixed(1)}" fill="none" ` +
    'stroke="#c0392b" stroke-width="1.2" stroke-dasharray="6 4"/>')
  parts.push(`<text x="${px(STRAP[3] + keep + 0.6)}" y="${py(STRAP[4] - 2)}" font-size="12" fill="#7b241c">strap clamp, Z 10..16</text>`)
  // Floor the plain pocket clears (away from the clamp) that this program leaves standing.
  for (const key of m.uncutPoints) {
    const [x, y] = key.split(',').map(Number)
    parts.push(`<rect x="${(Number(px(x)) - 1.75).toFixed(1)}" y="${(Number(py(y)) - 1.75).toFixed(1)}" width="3.5" height="3.5" fill="#d100d1"/>`)
  }

  const legendY = top + h + 26
  const legend: [string, string][] = [
    ['#000', 'pocket boundary, 100 x 60, floor Z 5'],
    ['#1f6feb', 'floor swept by the 6 mm cutter at Z 5 (shaded at cutter width; dark line = centre)'],
    ['#e67e22', 'every other move, centre only (the Z 7.5 pass, entries, links, rapids)'],
    ['#c0392b', 'strap clamp footprint; dashed = cutter centre keeps 3.25 mm off (radius 3 + allowance 0.25)'],
    ['#d100d1', 'floor left uncut that the pocket clears with no clamp, more than 0.83 mm from the clamp'],
  ]
  legend.forEach(([colour, label], i) => {
    parts.push(`<rect x="${left}" y="${legendY + i * 18 - 10}" width="12" height="12" fill="${colour}" fill-opacity="0.7"/>`)
    parts.push(`<text x="${left + 18}" y="${legendY + i * 18}" font-size="12">${esc(label)}</text>`)
  })
  const lines: string[] = []
  for (const caption of [
    `Measured: closest the cutter's side comes to the clamp below its top: ${m.closest.toFixed(2)} mm. ` +
      `Trim stops: ${m.stops.length}. Uncut floor away from the clamp: ${(m.uncutPoints.length * 0.25).toFixed(1)} sq mm ` +
      `(${m.uncutPoints.length} points on a 0.5 mm grid). ` +
      `Moves passing over the clamp: ${m.crossings}` +
      (m.crossings > 0 ? `, lowest tip Z over it ${m.lowestOver.toFixed(2)} (clamp top Z 16).` : '.'),
    ...captions,
    'Nothing is cut off by the view: the window is sized to the pocket, the whole strap and every move.',
  ]) lines.push(...wrapText(caption, 110), '')
  const captionTop = legendY + legend.length * 18 + 16
  lines.forEach((line, i) => parts.push(`<text x="${left}" y="${captionTop + i * 16}" font-size="12">${esc(line)}</text>`))
  const width = Math.max(w + 2 * left, 820)
  const height = captionTop + lines.length * 16 + 10
  writeFileSync(join(EVIDENCE_DIR, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" font-family="sans-serif">` +
    `<rect width="100%" height="100%" fill="white"/>${parts.join('')}</svg>`)
}

describe.runIf(process.env.WRITE_EVIDENCE === '1')('WO-1579 evidence', () => {
  it('draws the pocket with a strap clamp: stopped short (before) and cleared around (after)', async () => {
    const plain = await run('COMPUTE_POCKET', reachWith(null))
    const plainFloor = sweptFloor(plain.moves)

    const planned = buildPocketToolpath(pocketPayload(reachWith(null)))
    const before = trimToolpathToToolReach({
      operation: 'Pocket', moves: planned, tool: FLAT_6, holder: HOLDER, stockBlock: STOCK_BLOCK,
      clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([STRAP])],
    })
    const beforeM = measure(before.moves, before.notices, plainFloor)
    writePlanView('pocket-strap-before', 'BEFORE: Pocket stops short at a strap clamp (WO-1575 trim only)',
      before.moves, beforeM,
      ['What differs from AFTER: the floor is swept up to the clamp on both sides in both pictures, but here ' +
        'every ring runs into the clamp, is stopped by the trim, and hops over it - one console line per stop.',
      `Console: ${before.notices.length} line(s). First stop: ${beforeM.stops[0] ?? 'none'}`])

    const after = await run('COMPUTE_POCKET', reachWith([STRAP]))
    const afterNotices = after.notices ?? []
    const afterM = measure(after.moves, afterNotices, plainFloor)
    writePlanView('pocket-strap-after', 'AFTER: Pocket clears around the strap clamp like an island',
      after.moves, afterM,
      ['The region is split into two pockets around the clamp; each is cleared in full rings with no stop. ' +
        'The one move over the clamp is the link between the two halves.',
      `Console: ${afterNotices.length} line(s). ${afterNotices.join(' | ')}`])

    const acPlain = await run('COMPUTE_ADAPTIVE_CLEARING', reachWith(null))
    const acAfter = await run('COMPUTE_ADAPTIVE_CLEARING', reachWith([STRAP]))
    const acNotices = acAfter.notices ?? []
    const acM = measure(acAfter.moves, acNotices, sweptFloor(acPlain.moves))
    writePlanView('adaptive-strap-after', 'AFTER: Adaptive Clearing clears around the same strap clamp',
      acAfter.moves, acM,
      [`Console: ${acNotices.length} line(s). ${acNotices.join(' | ')}`])

    for (const name of ['pocket-strap-before', 'pocket-strap-after', 'adaptive-strap-after']) {
      expect(existsSync(join(EVIDENCE_DIR, `${name}.svg`))).toBe(true)
    }
    // The pictures show what they claim.
    expect(beforeM.stops.length).toBeGreaterThan(0)
    expect(afterM.crossings).toBe(1)
    expect(afterM.lowestOver).toBeGreaterThan(STRAP[5])
    expect(beforeM.lowestOver).toBeGreaterThan(STRAP[5])
    expect(afterM.stops).toEqual([])
    expect(afterM.uncutPoints).toEqual([])
    expect(acM.stops).toEqual([])
    expect(acM.uncutPoints).toEqual([])
  }, 300_000)
})
