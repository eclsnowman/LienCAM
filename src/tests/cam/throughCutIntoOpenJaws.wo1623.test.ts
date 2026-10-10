// WO-1623, Operator's condition on WO-1618 (2026-09-16 23:01Z): "Does it account for not
// colliding with the vise where the vise geometry is defined? Or is it the bounding box
// of the vise... can it poke through the bottom of a pocket that would go into the
// negative space of the vise geometry?"
//
// The workholding footprint is read off the vise MESH as solid columns, so the open gap
// between two jaws is not kept out. This proves it for Pocket 2D and Adaptive 2D.
//
// Every program comes out of the REAL worker entry point (self.onmessage), so the
// WO-1575 reach trim runs on it exactly as in the app. The vise is a real multi-body
// mesh here - the store's height scenario only builds a box vise - so this is the
// worker's truth for a mesh the store hands it, not a store round trip.
//
// SCENE (machine Z): stock Z 0..10. A vise of three boxes: a base Z -30..-5 under
// everything, and two jaws Z -5..0 at X <= -10 and X >= 10, leaving an open gap
// X -10..10 between them down to the base. A 60 x 30 region (X -30..30, Y -15..15)
// is cut from Z 10 through to Z -6 with a 6 mm end mill, Shank clearance 0.25 mm.
//
// Hand-worked expectation: over each jaw the cut stops at the jaw top plus the allowance,
// Z 0.25; over the gap it goes on into the gap and stops at the base top plus the
// allowance, Z -4.75. Nothing reaches Z -6 (the base is under the whole region).

import { mkdirSync, writeFileSync } from 'node:fs'
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

type Box = readonly [number, number, number, number, number, number]

const BASE: Box = [-60, -40, -30, 60, 40, -5]
const LEFT_JAW: Box = [-60, -40, -5, -10, 40, 0]
const RIGHT_JAW: Box = [10, -40, -5, 60, 40, 0]
const GAP_HALF_WIDTH = 10
const BASE_TOP = -5
const JAW_TOP = 0
const TOOL_RADIUS = 3
const ALLOWANCE = 0.25
const TOP_Z = 10
const BOTTOM_Z = -6

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

const STOCK_BLOCK: ToolpathStockBlock = { min: { x: -40, y: -25, z: 0 }, max: { x: 40, y: 25, z: TOP_Z } }
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
const AC_PARAMS = {
  geometryId: 'g', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
  stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
  helixDiameter: 90, tolerance: 0.02,
} as unknown as ACWorkerPayload['params']
const AC_PASSES: PassParams = { stepdown: 2.5, stepover: 1.8, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const AC_LINKING: LinkingParams = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1,
  retractType: 'full', transitionType: 'safe_height',
}
const REGION_LOOP: LoopData = {
  id: 'region', closed: true, type: 'contour',
  points: [{ x: -30, y: -15 }, { x: 30, y: -15 }, { x: 30, y: 15 }, { x: -30, y: 15 }],
}

type Operation = 'COMPUTE_POCKET' | 'COMPUTE_ADAPTIVE_CLEARING'
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

async function run(type: Operation): Promise<ToolpathCompleteWithNotices> {
  const reach: ToolReachInputs = {
    clearanceAllowanceMm: ALLOWANCE,
    workholding: [meshOf([BASE, LEFT_JAW, RIGHT_JAW])],
  }
  const common = {
    heights: HEIGHTS, tool: FLAT_6, loops: [REGION_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: STOCK_BLOCK, ...reach,
  }
  const payload = type === 'COMPUTE_POCKET'
    ? {
        opId: 'op-pocket', setupId: 'setup-1',
        params: { loopIds: [], direction: 'climb', fillStrategy: 'outside_in', finishContour: false } as unknown as PocketWorkerPayload['params'],
        passes: PASSES, linking: LINKING, ...common,
      } satisfies PocketWorkerPayload & ToolReachInputs
    : {
        opId: 'op-ac', setupId: 'setup-1',
        params: AC_PARAMS, passes: AC_PASSES, linking: AC_LINKING, ...common,
      } satisfies ACWorkerPayload & ToolReachInputs
  posted.length = 0
  await handler!({ data: { type, payload } } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  if (terminal[0].type !== 'TOOLPATH_COMPLETE') throw new Error(`expected a toolpath, got ${JSON.stringify(terminal[0])}`)
  return terminal[0] as ToolpathCompleteWithNotices
}

interface Sample { x: number; y: number; z: number }

/** Tool-tip positions along every non-rapid move, arcs followed around their centre. */
function cuttingSamples(moves: readonly ToolpathMove[], step = 0.2): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid') continue
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && typeof b.cx === 'number' && typeof b.cy === 'number') {
      const r = Math.hypot(a.x - b.cx, a.y - b.cy)
      const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
      let a1 = Math.atan2(b.y - b.cy, b.x - b.cx)
      if (b.type === 'arc_ccw') { while (a1 <= a0) a1 += 2 * Math.PI } else { while (a1 >= a0) a1 -= 2 * Math.PI }
      const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) * r / step))
      for (let k = 0; k <= n; k++) {
        const t = k / n
        const ang = a0 + (a1 - a0) * t
        out.push({ x: b.cx + r * Math.cos(ang), y: b.cy + r * Math.sin(ang), z: a.z + (b.z - a.z) * t })
      }
      continue
    }
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  return out
}

/** Side view (X across, Z up) of the program with the stock and the vise's three bodies,
 *  for the picture verdict. Written only with WRITE_EVIDENCE=1; EVIDENCE_TAG names
 *  before/after. */
function writeSideView(name: string, samples: readonly Sample[]) {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const tag = process.env.EVIDENCE_TAG ?? 'after'
  const x0 = -45
  const x1 = 45
  const z0 = -12
  const z1 = 14
  const scale = 12
  const W = (x1 - x0) * scale
  const H = (z1 - z0) * scale
  const px = (x: number) => ((x - x0) * scale).toFixed(1)
  const pz = (z: number) => ((z1 - z) * scale).toFixed(1)
  const rect = (bx0: number, bz0: number, bx1: number, bz1: number, fill: string, stroke: string) =>
    `<rect x="${px(Math.max(bx0, x0))}" y="${pz(Math.min(bz1, z1))}" width="${((Math.min(bx1, x1) - Math.max(bx0, x0)) * scale).toFixed(1)}" ` +
    `height="${((Math.min(bz1, z1) - Math.max(bz0, z0)) * scale).toFixed(1)}" fill="${fill}" stroke="${stroke}"/>`
  const dots = samples.filter((_, i) => i % 3 === 0)
    .map(s => `<circle cx="${px(s.x)}" cy="${pz(s.z)}" r="1.2"/>`).join('')
  const deepest = samples.length ? Math.min(...samples.map(s => s.z)) : NaN
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 40}" font-family="sans-serif">
<rect width="100%" height="100%" fill="white"/>
<text x="8" y="22" font-size="18">WO-1623 ${tag}: ${name} - side view, tool tip positions, deepest Z ${Number.isFinite(deepest) ? deepest.toFixed(3) : 'none'}</text>
<g transform="translate(0,40)">
${rect(STOCK_BLOCK.min.x, STOCK_BLOCK.min.z, STOCK_BLOCK.max.x, STOCK_BLOCK.max.z, '#d9c7a3', '#8a7550')}
${rect(BASE[0], BASE[2], BASE[3], BASE[5], '#7d8fa6', '#34455c')}
${rect(LEFT_JAW[0], LEFT_JAW[2], LEFT_JAW[3], LEFT_JAW[5], '#5f7189', '#34455c')}
${rect(RIGHT_JAW[0], RIGHT_JAW[2], RIGHT_JAW[3], RIGHT_JAW[5], '#5f7189', '#34455c')}
<text x="${px(-40)}" y="${pz(-2)}" font-size="16" fill="white">Jaw (top Z 0)</text>
<text x="${px(22)}" y="${pz(-2)}" font-size="16" fill="white">Jaw (top Z 0)</text>
<text x="${px(-8)}" y="${pz(-8)}" font-size="16" fill="white">Base (top Z -5)</text>
<g fill="#d62728">${dots}</g>
</g></svg>`
  const dir = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-1623')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${tag}-${name}.svg`), svg)
}

describe.each([
  ['Pocket 2D', 'COMPUTE_POCKET' as const, 'pocket-open-jaws'],
  ['Adaptive 2D', 'COMPUTE_ADAPTIVE_CLEARING' as const, 'adaptive-open-jaws'],
])('WO-1623 %s through a vise with open jaws', (label, type, evidenceName) => {
  it('cuts into the gap between the jaws down to the base, and stops above each jaw', async () => {
    const result = await run(type)
    const samples = cuttingSamples(result.moves)
    writeSideView(evidenceName, samples)
    // Tool centre far enough in that the cutter and allowance clear both jaws.
    const overGap = samples.filter(s => Math.abs(s.x) < GAP_HALF_WIDTH - TOOL_RADIUS - ALLOWANCE)
    // Tool centre where the cutter overlaps a jaw grown by the allowance.
    const overJaw = samples.filter(s => Math.abs(s.x) > GAP_HALF_WIDTH - TOOL_RADIUS - ALLOWANCE + 0.05)
    const deepestOverGap = Math.min(...overGap.map(s => s.z))
    const deepestOverJaw = Math.min(...overJaw.map(s => s.z))
    console.log(`[WO-1623 ${label} open jaws] ${result.moves.length} moves, deepest over gap ${deepestOverGap}, ` +
      `over jaws ${deepestOverJaw}, notices ${JSON.stringify(result.notices ?? [])}`)

    expect(overGap.length, 'cuts over the gap').toBeGreaterThan(0)
    expect(overJaw.length, 'cuts over the jaws').toBeGreaterThan(0)
    // Into the gap: down past the jaw tops to the base top plus the allowance.
    expect(deepestOverGap, 'deepest cut over the gap').toBeCloseTo(BASE_TOP + ALLOWANCE, 2)
    // Over each jaw: the jaw top plus the allowance, never lower.
    expect(deepestOverJaw, 'deepest cut over the jaws').toBeGreaterThanOrEqual(JAW_TOP + ALLOWANCE - 0.01)
    expect(deepestOverJaw, 'the region over the jaws is cut down to them').toBeCloseTo(JAW_TOP + ALLOWANCE, 2)
    for (const side of [-1, 1]) {
      const overThisJaw = overJaw.filter(s => Math.sign(s.x) === side && Math.abs(s.x) > GAP_HALF_WIDTH + TOOL_RADIUS)
      expect(overThisJaw.length, `cuts over the jaw at X ${side * GAP_HALF_WIDTH}`).toBeGreaterThan(0)
      expect(Math.min(...overThisJaw.map(s => s.z))).toBeCloseTo(JAW_TOP + ALLOWANCE, 2)
    }
    // Nothing reaches the programmed bottom: the base is under the whole region.
    expect(Math.min(...samples.map(s => s.z))).toBeGreaterThanOrEqual(BASE_TOP + ALLOWANCE - 0.01)
  }, 300_000)
})
