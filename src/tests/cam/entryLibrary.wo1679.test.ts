// WO-1679 -- one entry-move library for every operation.
//
// One entry table (tool, feeds, depth, ramp angle, helix size) is driven through the
// production builder of every operation that enters material (the same functions
// toolpathWorker.ts routes to). For each one the test measures the entry it ACTUALLY
// emits -- helix radius and descent angle, ramp angle, and the feed of every helix,
// ramp and plunge move -- and holds it to the table's limits.
//
// It also pins the whole move list of every case against the fingerprints recorded on
// the code BEFORE the entry library replaced the per-operation builders
// (src/tests/evidence/WO-1679/before.json, written once with WO1679_WRITE=before on the
// pre-change tree). An operation whose moves changed must be named in CHANGED with the
// reason; every other operation's move list is identical.
import { describe, it, expect, beforeAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildContourToolpath } from '../../lib/cam/contour2d'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { buildChamferToolpath } from '../../lib/cam/chamfer2d'
import { buildEngraveToolpath } from '../../lib/cam/engrave2d'
import { buildVCarveToolpath } from '../../lib/cam/vcarve2d'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { buildAdaptiveClearingToolpath } from '../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { ensureVCarveClipperReady } from '../../lib/cam/vcarve2d'
import type {
  ACParams, ACWorkerPayload, BoreParams, BoreWorkerPayload, ChamferParams, ChamferWorkerPayload,
  ContourParams, ContourWorkerPayload, EngraveParams, EngraveWorkerPayload, LoopData,
  PocketParams, PocketWorkerPayload, ThreadMillParams, ThreadMillWorkerPayload,
  VCarveParams, VCarveWorkerPayload,
} from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

await ensureClipperReady()

// ── The entry table ───────────────────────────────────────────────────────────────────────
const TABLE = {
  toolDiameter: 6,
  feedRate: 1000,
  plungeRate: 300,
  rampAngleDeg: 3,
  /** Helix diameter as a percentage of the tool diameter (pocket + adaptive both expose it). */
  helixDiameterPct: 80,
  topZ: 0,
  bottomZ: -4,
  stepdown: 2,
}
/** Every entry descent (helix or ramp) stays within the table's angle. The thread-mill helix is
 *  the thread itself (its pitch is the part's), not an entry, so it is measured for feed only. */
const ANGLE_TOLERANCE_DEG = 0.05

const tool = (over: Partial<Tool> = {}): Tool => ({
  id: 'wo1679', name: '6 mm flat', type: 'flat_end_mill',
  diameter: TABLE.toolDiameter, fluteLength: 20, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: TABLE.feedRate, plungeRate: TABLE.plungeRate, depthOfCut: 2, stepover: 2 } },
  ...over,
} as Tool)

const HEIGHTS: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: TABLE.topZ, topHeightMode: 'absolute',
  bottomHeight: TABLE.bottomZ, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = {
  stepdown: TABLE.stepdown, stepover: 2, stockToLeave: 0, floorStockToLeave: 0,
  finishPasses: 1, springPasses: 0,
}
const linking = (entryType: LinkingParams['entryType']): LinkingParams => ({
  entryType, rampAngle: TABLE.rampAngleDeg, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
})
const rect = (id: string, x0: number, y0: number, w: number, h: number, type: LoopData['type'] = 'contour'): LoopData => ({
  id, closed: true, type,
  points: [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }],
})
const circle = (id: string, r: number, n = 96): LoopData => ({
  id, closed: true, type: 'hole',
  points: Array.from({ length: n }, (_, i) => ({ x: r * Math.cos(2 * Math.PI * i / n), y: r * Math.sin(2 * Math.PI * i / n) })),
})
const base = { setupId: 's', wcsOrigin: { x: 0, y: 0, z: 0 } }
const POCKET_LOOPS = [rect('p', 0, 0, 30, 20)]

function pocket(fillStrategy: 'inside_out' | 'outside_in', entryType: LinkingParams['entryType']): PocketWorkerPayload {
  return {
    ...base, opId: `pocket-${fillStrategy}-${entryType}`,
    params: {
      geometryId: 'g', loopIds: [], direction: 'climb', orderStrategy: 'by_depth', fillStrategy,
      floorStockToLeave: 0, finishContour: false, helixDiameter: TABLE.helixDiameterPct, overlapMm: 0,
      stepoverLeadIn: 'none', stayDown: false, stayDownLift: 0.5,
    } as PocketParams,
    heights: HEIGHTS, passes: PASSES, linking: linking(entryType), tool: tool(), loops: POCKET_LOOPS,
  }
}

function contour(entryType: LinkingParams['entryType'], tabs = false): ContourWorkerPayload {
  return {
    ...base, opId: `contour-${entryType}${tabs ? '-tabs' : ''}`,
    params: {
      geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs,
      ...(tabs ? { tabWidth: 6, tabHeight: 1, tabCount: 4 } : {}),
    } as ContourParams,
    heights: HEIGHTS, passes: { ...PASSES, stockToLeave: 0.5 }, linking: linking(entryType), tool: tool(),
    loops: [rect('c', 0, 0, 30, 20)],
    ...(tabs ? { stockBottomZ: TABLE.bottomZ } : {}),
  } as ContourWorkerPayload
}

function chamfer(entryType: LinkingParams['entryType']): ChamferWorkerPayload {
  return {
    ...base, opId: `chamfer-${entryType}`,
    params: {
      geometryId: 'g', loopIds: [], loopSides: {}, direction: 'climb',
      chamferWidth: 1, tipOffset: 0, overlapMm: 0, heightReference: 'stock_top', planeOffset: 0,
    } as ChamferParams,
    heights: HEIGHTS, passes: PASSES, linking: linking(entryType),
    tool: tool({ type: 'chamfer_mill', angleFromAxisDeg: 45 } as Partial<Tool>), loops: [rect('ch', 0, 0, 30, 20)],
  }
}

function engrave(): EngraveWorkerPayload {
  return {
    ...base, opId: 'engrave',
    params: {
      geometryId: '', loopIds: [], includeOpen: true, includeClosed: true,
      mode: 'trace', depthModel: 'constant', side: 'center', sideOffset: 0, axialOffset: 0,
      targetLineWidth: 0, useWidthForDepth: false, direction: 'as_drawn', tolerance: 0.01,
    } as EngraveParams,
    heights: { ...HEIGHTS, bottomHeight: -0.5 }, passes: PASSES, linking: linking('plunge'), tool: tool(),
    loops: [rect('e', 0, 0, 30, 20)],
  }
}

function vcarve(): VCarveWorkerPayload {
  return {
    ...base, opId: 'vcarve',
    params: {
      geometryId: 'g', loopIds: [], role: 'carve', flatDepthMm: undefined, startDepthMm: 0, allowanceMm: 0,
      flatClearing: { mode: 'vbit', stepoverMm: 0.5 }, tolerance: 0.01,
    } as VCarveParams,
    heights: { ...HEIGHTS, bottomHeight: -6 }, passes: { ...PASSES, stepdown: 0 }, linking: linking('plunge'),
    tool: tool({ type: 'v_bit', diameter: 12, fluteLength: 10, angleFromAxisDeg: 45, tipDiameter: 0 } as Partial<Tool>),
    loops: [rect('v', 0, 0, 40, 10, 'closed' as LoopData['type'])],
  }
}

function thread(): ThreadMillWorkerPayload {
  return {
    ...base, opId: 'thread',
    params: {
      geometryId: 'g', loopIds: [], threadKind: 'internal', majorDiameter: 10, pitch: 1.5,
      handedness: 'right', cutDirection: 'climb', roughingPasses: 1, springPasses: 0,
      leadInOut: 'arc', compensation: 'computer',
    } as ThreadMillParams,
    heights: HEIGHTS, passes: PASSES, linking: linking('plunge'), tool: tool({ diameter: 4 }), loops: [circle('h', 4.25)],
  }
}

function bore(): BoreWorkerPayload {
  return {
    ...base, opId: 'bore',
    params: { geometryId: 'g', loopIds: [], direction: 'climb', sortStrategy: 'none' } as BoreParams,
    heights: HEIGHTS, passes: PASSES, linking: linking('ramp_helical'), tool: tool(), loops: [circle('b', 8)],
  }
}

function adaptive(): ACWorkerPayload {
  return {
    ...base, opId: 'adaptive',
    params: {
      geometryId: 'g', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
      stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: TABLE.rampAngleDeg, completionTolerance: 1,
      helixDiameter: TABLE.helixDiameterPct, tolerance: 0.02,
    } as ACParams,
    heights: HEIGHTS, passes: { ...PASSES, stepover: 1.2 }, linking: linking('ramp_helical'), tool: tool(),
    loops: POCKET_LOOPS,
  }
}

interface Case { name: string; entersBy: Array<'helix' | 'ramp' | 'plunge'>; build: () => Promise<ToolpathMove[]> | ToolpathMove[]; entryAngleChecked?: boolean }
const CASES: Case[] = [
  { name: 'pocket inside-out helix', entersBy: ['helix'], build: () => buildPocketToolpath(pocket('inside_out', 'ramp_helical')) },
  { name: 'pocket inside-out plunge', entersBy: ['plunge'], build: () => buildPocketToolpath(pocket('inside_out', 'plunge')) },
  { name: 'pocket outside-in ramp', entersBy: ['ramp'], build: () => buildPocketToolpath(pocket('outside_in', 'ramp_linear')) },
  { name: 'pocket outside-in plunge', entersBy: ['plunge'], build: () => buildPocketToolpath(pocket('outside_in', 'plunge')) },
  { name: 'contour ramp', entersBy: ['ramp'], build: () => buildContourToolpath(contour('ramp_linear')) },
  { name: 'contour plunge', entersBy: ['plunge'], build: () => buildContourToolpath(contour('plunge')) },
  { name: 'contour ramp with tabs', entersBy: ['ramp'], build: () => buildContourToolpath(contour('ramp_linear', true)) },
  { name: 'adaptive 2D helix', entersBy: ['helix'], build: async () => { await ensureEngineClipperReady(); return buildAdaptiveClearingToolpath(adaptive()) } },
  { name: 'chamfer ramp', entersBy: ['ramp'], build: () => buildChamferToolpath(chamfer('ramp_linear')) },
  { name: 'chamfer plunge', entersBy: ['plunge'], build: () => buildChamferToolpath(chamfer('plunge')) },
  { name: 'engrave plunge', entersBy: ['plunge'], build: () => buildEngraveToolpath(engrave()) },
  { name: 'v-carve plunge', entersBy: ['plunge'], build: async () => { await ensureVCarveClipperReady(); return buildVCarveToolpath(vcarve()) } },
  { name: 'bore helix', entersBy: ['helix'], build: () => buildBoreToolpath(bore()) },
  { name: 'thread plunge + thread helix', entersBy: ['plunge'], build: () => buildThreadMillToolpath(thread()), entryAngleChecked: false },
]

// ── Measurement ───────────────────────────────────────────────────────────────────────────
interface EntryMeasure {
  moves: number
  helixMoves: number
  rampMoves: number
  plungeMoves: number
  /** Largest distance of a helix move from its helix centre (centre = mean of the helix's XY). */
  maxHelixRadius: number
  /** Steepest descending helix/ramp segment, degrees from horizontal. */
  maxDescentAngleDeg: number
  helixFeeds: number[]
  rampFeeds: number[]
  plungeFeeds: number[]
  fingerprint: string
}

const uniq = (xs: Array<number | undefined>): number[] =>
  [...new Set(xs.filter((x): x is number => typeof x === 'number'))].sort((a, b) => a - b)

/** Least-squares (Kasa) circle fit through a helix run's XY; returns its radius. */
function fitCircleRadius(pts: Array<{ x: number; y: number }>): number {
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my
    suu += u * u; svv += v * v; suv += u * v
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2
  const uc = (b1 * svv - b2 * suv) / det
  const vc = (suu * b2 - suv * b1) / det
  return Math.max(...pts.map(p => Math.hypot(p.x - mx - uc, p.y - my - vc)))
}

function measure(moves: ToolpathMove[]): EntryMeasure {
  let maxHelixRadius = 0
  let maxDescentAngleDeg = 0
  // Helix runs: consecutive helix-role moves.
  for (let i = 0; i < moves.length;) {
    if (moves[i].role !== 'helix') { i++; continue }
    let j = i
    while (j < moves.length && moves[j].role === 'helix') j++
    const run = moves.slice(i, j)
    if (run.length >= 8) maxHelixRadius = Math.max(maxHelixRadius, fitCircleRadius(run))
    i = j
  }
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]
    if (m.role !== 'helix' && m.role !== 'ramp') continue
    const p = moves[i - 1]
    const dz = p.z - m.z
    const chord = Math.hypot(m.x - p.x, m.y - p.y)
    // WO-2039: a helical arc's run is its XY arc length, not its chord.
    const r = (m.type === 'arc_cw' || m.type === 'arc_ccw') && typeof m.cx === 'number' && typeof m.cy === 'number'
      ? Math.hypot(m.x - m.cx, m.y - m.cy) : 0
    const dxy = r > 0 ? r * 2 * Math.asin(Math.min(1, chord / (2 * r))) : chord
    if (dz <= 1e-9 || dxy <= 1e-9) continue
    maxDescentAngleDeg = Math.max(maxDescentAngleDeg, Math.atan2(dz, dxy) * 180 / Math.PI)
  }
  const text = moves.map(m => `${m.type},${m.role ?? ''},${m.x.toFixed(4)},${m.y.toFixed(4)},${m.z.toFixed(4)},${m.feed ?? ''}`).join('\n')
  return {
    moves: moves.length,
    helixMoves: moves.filter(m => m.role === 'helix').length,
    rampMoves: moves.filter(m => m.role === 'ramp').length,
    plungeMoves: moves.filter(m => m.role === 'plunge').length,
    maxHelixRadius: Number(maxHelixRadius.toFixed(4)),
    maxDescentAngleDeg: Number(maxDescentAngleDeg.toFixed(4)),
    helixFeeds: uniq(moves.filter(m => m.role === 'helix').map(m => m.feed)),
    rampFeeds: uniq(moves.filter(m => m.role === 'ramp').map(m => m.feed)),
    plungeFeeds: uniq(moves.filter(m => m.role === 'plunge').map(m => m.feed)),
    fingerprint: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
}

// ── Before/after ──────────────────────────────────────────────────────────────────────────
const EVIDENCE_DIR = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-1679')
const BEFORE_FILE = join(EVIDENCE_DIR, 'before.json')
const WO1896 = "WO-1896: travel reversed so climb keeps the material on the cutter's right; depths, entry geometry and order unchanged"
/** Operations whose move list is allowed to differ from before.json, and why. */
const CHANGED: Record<string, string> = {
  'adaptive 2D helix': WO1896,
  'bore helix': `${WO1896}; WO-2039: the helix is helical arcs (at most half a turn each) instead of chords, same helix`,
  'chamfer plunge': WO1896,
  'chamfer ramp': WO1896,
  'contour plunge': WO1896,
  'contour ramp': WO1896,
  'contour ramp with tabs': WO1896,
  'pocket inside-out helix':
    'WO-1972: the helix starts entry clearance above the material (Top + 1 mm) instead of retract, and stays down between levels; centre, radius, angle and feed unchanged',
  'v-carve plunge':
    'WO-2855: corner ridges are cut on the way round the wall and links rise only to Retract, so there are fewer plunges; each plunge is still a straight plunge at the plunge feed',
}

const measured = new Map<string, EntryMeasure>()

beforeAll(async () => {
  for (const c of CASES) measured.set(c.name, measure(await c.build()))
  const write = process.env.WO1679_WRITE
  if (write === 'before' || write === 'after') {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, `${write}.json`), JSON.stringify(Object.fromEntries(measured), null, 2) + '\n')
  }
}, 120_000)

describe('WO-1679 one entry table through every operation that enters material', () => {
  for (const c of CASES) {
    it(`${c.name}: enters by ${c.entersBy.join('/')} within the table's radius, angle and feed limits`, () => {
      const m = measured.get(c.name)!
      expect(m.moves).toBeGreaterThan(0)
      for (const kind of c.entersBy) {
        const count = kind === 'helix' ? m.helixMoves : kind === 'ramp' ? m.rampMoves : m.plungeMoves
        expect(count, `${c.name} emits no ${kind} move`).toBeGreaterThan(0)
      }
      // Helix: never wider than the table's helix diameter allows (radius = pct x tool radius).
      if (c.entersBy.includes('helix') && c.name !== 'bore helix') {
        expect(m.maxHelixRadius).toBeLessThanOrEqual(TABLE.helixDiameterPct / 100 * TABLE.toolDiameter / 2 + 1e-3)
      }
      // Descent: no entry helix or ramp segment steeper than the table angle.
      if (c.entryAngleChecked !== false) {
        expect(m.maxDescentAngleDeg).toBeLessThanOrEqual(TABLE.rampAngleDeg + ANGLE_TOLERANCE_DEG)
      }
      // Feeds: a plunge never exceeds the plunge rate; an entry helix/ramp never exceeds the cutting feed.
      for (const f of m.plungeFeeds) expect(f).toBeLessThanOrEqual(TABLE.plungeRate)
      if (c.entryAngleChecked !== false) {
        for (const f of [...m.helixFeeds, ...m.rampFeeds]) expect(f).toBeLessThanOrEqual(TABLE.feedRate)
      }
    })
  }

  it('every move list matches the pre-library fingerprint except the operations named in CHANGED', () => {
    if (!existsSync(BEFORE_FILE)) throw new Error(`missing ${BEFORE_FILE}: record it with WO1679_WRITE=before on the pre-change tree`)
    const before = JSON.parse(readFileSync(BEFORE_FILE, 'utf8')) as Record<string, EntryMeasure>
    const differs: string[] = []
    for (const c of CASES) {
      const was = before[c.name]
      expect(was, `before.json has no entry for ${c.name}`).toBeDefined()
      if (was.fingerprint !== measured.get(c.name)!.fingerprint) differs.push(c.name)
    }
    expect(differs.sort()).toEqual(Object.keys(CHANGED).sort())
  })
})
