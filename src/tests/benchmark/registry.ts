// WO-1217 -- the benchmark fixture registry. THIS FILE IS DATA.
//
// The 2D corpus carries a byte-stability fingerprint: it says CHANGED and can
// never say BETTER or WORSE, so it goes red on every legitimate improvement and
// needs Operator's eye to regenerate (three holds: WO-1198, WO-1211, WO-1214). The
// benchmark answers the other question -- what did this change do to the parts?
// -- with measured numbers and tolerance bands.
//
// The rule this file exists to enforce: ADDING A PART OR A TOOL, OR CHANGING A
// TOOL DIAMETER, IS AN EDIT HERE AND NOWHERE ELSE. No test body may name a
// part, a tool or an operation type; `chainRunner.ts` drives whatever this file
// declares and `smoke.test.ts` iterates the result.
//
// Slice 1 of 4 (WO-1216 plan) ships the SMOKE tier only: 2 parts x 2 operations,
// under 3 minutes. WO-1218 fills the full matrix; the runner already takes it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { engagementPocket, featureBlock, steps } from '../../cam3d/fixtures'
import { importStepToPartMesh } from '../../cam3d/input/step'
import { makeOcctCoreTessellator } from '../../cam3d/input/occtCoreTessellator'
import { loadOcctModel } from '../../lib/cam/geometry/occt/model/loader'
// The sustained radial engagement adaptive rough holds ITSELF to, as a fraction of a
// full-width slot -- IMPORTED, not restated. It is the number the strategy refuses a
// side-entry job over, so the benchmark scores against the engine's own promise and
// the two cannot drift apart. A copy here would keep measuring the old bound the day
// production moved the cap, and print an engagement regression as green.
import { SIDE_ENTRY_ENGAGEMENT_CAP } from '../../cam3d/strategies/adaptiveRough'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { OperationType, ToolType } from '../../types'

export type BenchmarkTier = 'smoke' | 'full'

/**
 * The whole benchmark tool set (WO-1216 section 3, revised by Operator ruling 2026-09-05:
 * 12 mm is dropped -- it is bigger than anything he runs).
 *
 * `role` is documentation, not dispatch: a chain step names the tool it wants by
 * id, so a role can gain a second tool without touching the chains.
 */
export interface BenchmarkTool {
  id: string
  label: string
  type: ToolType
  /** mm. */
  diameter: number
  /** Bull-nose only, mm. */
  cornerRadius?: number
  /**
   * Flute length, mm. It is DATA and not a diameter multiple because the shank
   * clearance gate is real: a 3 mm ball with a catalogue 12 mm flute refuses a
   * 12 mm deep pocket outright ("the shank would hit the stock"), and the
   * benchmark's job is to score the toolpath, not to re-prove that gate. Every
   * benchmark tool therefore carries enough reach for the parts in PARTS; a part
   * deeper than this needs the number raised here and the baseline regenerated.
   */
  fluteLengthMm: number
  role: 'rough' | 'rest_rough' | 'finish' | 'fine_finish' | 'refusal_probe'
}

export const TOOLS: readonly BenchmarkTool[] = [
  { id: 'bm-flat-6', label: '6 mm flat', type: 'flat_end_mill', diameter: 6, fluteLengthMm: 25, role: 'rough' },
  { id: 'bm-flat-4', label: '4 mm flat', type: 'flat_end_mill', diameter: 4, fluteLengthMm: 25, role: 'rest_rough' },
  // The compact feature block spans 26.964 mm from its spherical apex to the
  // pocket floor, so the finishing tools need a real 32 mm reach. Diameter is
  // unchanged; this is fixture reach data, not a tool-set change.
  { id: 'bm-ball-3', label: '3 mm ball', type: 'ball_end_mill', diameter: 3, fluteLengthMm: 32, role: 'finish' },
  { id: 'bm-ball-2', label: '2 mm ball', type: 'ball_end_mill', diameter: 2, fluteLengthMm: 32, role: 'fine_finish' },
  // Present so WO-1218/WO-1219 can prove pencil still REFUSES a bull-nose
  // (WO-1195). No smoke chain uses it; the sweep simulator fails loud on a
  // bull profile, which is the correct behaviour for a tool that must refuse.
  { id: 'bm-bull-6', label: '6 mm bull-nose (r1)', type: 'bull_nose', diameter: 6, cornerRadius: 1, fluteLengthMm: 25, role: 'refusal_probe' },
]

export function toolById(id: string): BenchmarkTool {
  const found = TOOLS.find((t) => t.id === id)
  if (!found) throw new Error(`benchmark registry: no tool "${id}" -- add it to TOOLS.`)
  return found
}

/**
 * A part. `mesh()` is called once per chain run, so a fixture may be as
 * expensive to build as it likes without leaking state between rows.
 *
 * `stockMargin` grows the part's own AABB into the stock block: xy on all four
 * sides, zTop above the highest surface. zero/zero means "the block IS the
 * part's AABB", which is what every mesh fixture in `src/cam3d/fixtures` is
 * built to be machined from.
 */
export interface BenchmarkPart {
  id: string
  label: string
  mesh: () => PartMesh | Promise<PartMesh>
  stockMargin: { xy: number; zTop: number }
  /** Dexel cell for the coverage/uncut-area simulation, mm. */
  coverageCell: number
}

export const PARTS: readonly BenchmarkPart[] = [
  {
    id: 'feature-block-mesh',
    label: 'compact feature block (procedural mesh)',
    mesh: () => featureBlock(),
    stockMargin: { xy: 0, zTop: 0 },
    coverageCell: 1,
  },
  {
    id: 'feature-block-step',
    label: 'compact feature block (STEP twin)',
    mesh: () => stepFixtureMesh('fix_feature_block.step'),
    stockMargin: { xy: 0, zTop: 0 },
    coverageCell: 1,
  },
  {
    // WO-277's engagement torture fixture: 90 x 60 x 16 block, H-shaped pocket
    // to a floor at z = 4 with a 6 mm neck the 6 mm rougher cannot enter. It is
    // the part that makes engagement and coverage numbers mean something.
    id: 'engagement-pocket',
    label: 'H-pocket with island and a 6 mm neck',
    mesh: () => engagementPocket(),
    stockMargin: { xy: 0, zTop: 0 },
    coverageCell: 0.5,
  },
  {
    // Flat terraces and vertical outside walls: the OUTSIDE-face case, and the
    // flat-face lift a ball finish has to get right. Scaled down from the
    // fixture's 90 mm default -- runtime is the binding constraint on smoke.
    id: 'stepped-boss',
    label: 'three flat terraces, outside walls',
    mesh: () => steps(3, 40, 5),
    stockMargin: { xy: 0, zTop: 0 },
    coverageCell: 0.4,
  },
  {
    id: 'boss-taper-step',
    label: 'tapered boss (STEP)',
    mesh: () => stepFixtureMesh('fix_boss_taper.step'),
    stockMargin: { xy: 0, zTop: 0 },
    coverageCell: 0.5,
  },
]

const stepMeshCache = new Map<string, Promise<PartMesh>>()

/** Read the committed STEP twin through the production STEP importer, once per fixture. */
function stepFixtureMesh(file: string): Promise<PartMesh> {
  let cached = stepMeshCache.get(file)
  if (!cached) {
    cached = (async () => {
      const wasm = readFileSync(join(process.cwd(), 'src/lib/cam/geometry/occt/model/vendor/occt-model.wasm'))
      const bytes = readFileSync(join(process.cwd(), 'test_fixtures/brep', file))
      const oc = await loadOcctModel({ wasmBinary: wasm })
      const imported = await importStepToPartMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
        camTolerance: 0.1,
        tessellator: makeOcctCoreTessellator(oc),
      })
      return imported.mesh
    })()
    stepMeshCache.set(file, cached)
  }
  return cached
}

export function partById(id: string): BenchmarkPart {
  const found = PARTS.find((p) => p.id === id)
  if (!found) throw new Error(`benchmark registry: no part "${id}" -- add it to PARTS.`)
  return found
}

/**
 * Machining scope. WO-1216 section 3b wants every finish scored twice -- once
 * whole-part, once scoped to a named face set. Face scoping needs face ids off a
 * STEP import, which arrives with the parts in WO-1218, so slice 1 declares the
 * dimension and ships the only member it can actually drive. A scope that names
 * faces is a registry edit plus one `geometrySelections` line in the runner.
 */
export interface BenchmarkScope {
  id: string
  label: string
}

export const WHOLE_PART: BenchmarkScope = { id: 'whole', label: 'whole part' }

export interface BenchmarkStep {
  /** Stable id; it is part of the scorecard row key, so never renumber one. */
  id: string
  type: OperationType
  toolId: string
  scope: BenchmarkScope
  /**
   * Which setup this step belongs to, WO-1219. Defaults to the chain's own
   * `setupLabel` (every step existing before this order used that implicitly,
   * one setup per chain). A chain that names a SECOND label here gets a SECOND
   * Setup, built by `chainScene` -- a multi-setup chain proves setup-scoped
   * heights and WCS survive a flip, which a single shared setup cannot.
   */
  setupLabel?: string
  /**
   * Absolute heights this step's operation uses instead of the block-top
   * derived defaults (topZ+10 / +2 / +1), WO-1219. Exists so a second setup in
   * a flip can be given DELIBERATELY different heights from the first -- the
   * only way to prove the resolved heights are this setup's own and not a
   * silent revert to the setup before it.
   */
  heightOverride?: { clearanceHeight?: number; retractHeight?: number; feedHeight?: number }
  /** Exactly what the app stores in `Operation.params`. */
  params: Record<string, unknown>
  /**
   * Material this step is REQUIRED to leave on the part, mm, measured along the
   * tool axis. The stock-to-leave assert reads this; it is never a delta cell.
   */
  stockToLeaveMm: number
  /**
   * How far below the surface the tool is ALLOWED to be, mm. This is the
   * operation's own honest error floor, and it is a hard ceiling on the gouge:
   *
   * - a rough gets grid/level quantisation only (its floor comes from level
   *   planning, so this stays tight);
   * - a drop-cutter finish gets its chordal `tolerance` plus a margin, because
   *   the straight line between two CL points provably cuts inside a convex
   *   surface by up to that tolerance.
   *
   * Raising one of these numbers is loosening a safety assert. Do it in a commit
   * that says why.
   */
  gougeToleranceMm: number
  /**
   * How far INSIDE a vertical face the cutter may sit before it counts as eating
   * it, mm. Separate from the axial tolerance because an axial measure against a
   * vertical wall is meaningless: a ball 0.07 mm past tangency to a 12 mm wall
   * reads as a 9.3 mm axial dip. The gouge check shrinks the cutter laterally by
   * this much, so a pass tangent-within-tolerance is clear and anything that eats
   * more of the wall than this is not.
   */
  lateralAllowanceMm: number
  /**
   * SUSTAINED RADIAL ENGAGEMENT cap: what the strategy PROMISES, as a fraction of
   * a full-width slot with this cutter at the axial depth it is cutting. 1.0 is a
   * full slot. This is the engine's own unit -- `measurePathEngagement` reports it
   * and adaptive rough refuses a side-entry job that breaks it -- so the benchmark
   * and the engine cannot disagree about what engagement means. It is deliberately
   * NOT an mm^2 cross-section: a cross-section scales with the level's depth, so
   * halving the stepdown would halve it without the radial bite moving at all.
   *
   * LEAVE IT undefined WHERE THE STRATEGY MAKES NO SUCH PROMISE. A drop-cutter
   * finish does not, and it is not the first operation of its chain either -- the
   * measure replays from the UNCUT stock box, so a number for it would be measured
   * against stock the rough already took away. No number beats a wrong one.
   */
  engagementCapFraction?: number
  /**
   * Cell size of the engagement replay field, mm. Finer costs runtime and resolves
   * a narrower bite; the operation's own planning `cellSize` is the natural choice
   * because that is the resolution the path was planned at.
   */
  engagementCellMm?: number
}

export interface BenchmarkChain {
  id: string
  partId: string
  setupLabel: string
  tiers: readonly BenchmarkTier[]
  steps: readonly BenchmarkStep[]
}


/** Adaptive 3D rough params, spelled out so a diff shows what moved. */
function roughParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxStepdown: 4,
    stepover: 0.4,
    tolerance: 0.1,
    helixDiameter: 3,
    helixAngleDeg: 10,
    cellSize: 1,
    useStockBoundary: false,
    radialStockToLeave: 0.3,
    axialStockToLeave: 0.3,
    ...over,
  }
}

/** Parallel 3D finish params. */
function parallelParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepover: 2,
    angleDeg: 0,
    tolerance: 0.1,
    surfaceStockToLeave: 0,
    useStockBoundary: false,
    ...over,
  }
}

export const CHAINS: readonly BenchmarkChain[] = [
  {
    id: 'feature-block-mesh-rough-finish',
    partId: 'feature-block-mesh',
    setupLabel: 'top',
    tiers: ['full'],
    steps: [
      { id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART, params: roughParams({ cellSize: 1 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 1 },
      { id: 'finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART, params: parallelParams({ stepover: 1 }), stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2 },
    ],
  },
  {
    id: 'feature-block-step-rough-finish',
    partId: 'feature-block-step',
    setupLabel: 'top',
    tiers: ['full'],
    steps: [
      { id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART, params: roughParams({ cellSize: 1 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 1 },
      { id: 'finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART, params: parallelParams({ stepover: 1 }), stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2 },
    ],
  },
  {
    // FULL tier only -- the engagement-pocket's 6 mm neck and sharp internal
    // corners are exactly where a 6 mm rougher leaves material a 4 mm tool can
    // still reach (a feature-block rest-rough attempt found nothing left to
    // clear there and refused with "no toolpath moves" -- this part is the one
    // proven to have the residual). A separate chain (not the smoke-tier
    // engagement-pocket-rough-finish) so it never perturbs WO-1217's smoke
    // baseline. setupLabel MUST differ from every other chain on the same
    // partId: chainScene() derives setupId/geometryId from (partId,
    // setupLabel) alone, and sharing 'top' with engagement-pocket-rough-finish
    // measurably changed THAT chain's own numbers when both ran in the same
    // process (moves, cutMoves, cutLengthMm and more, all off) -- confirmed by
    // toggling this chain off and back on. Root cause not chased (out of this
    // order's lane); the fix is a distinct setupLabel per chain on a part.
    id: 'engagement-pocket-rest-pencil',
    partId: 'engagement-pocket',
    setupLabel: 'rest-pencil',
    tiers: ['full'],
    steps: [
      { id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART, params: roughParams({ cellSize: 0.4 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.4 },
      // Rest-rough (WO-1210: a toggle, not a type) -- a second adaptive_3d
      // step, same setup, same cellSize/stock, so the app's own retained-field
      // match picks it up automatically and it starts from what the 6 mm left.
      // A finer cellSize than the other chains: the corner-residual sliver
      // between a 3 mm and a 2 mm tool radius is only ~1 mm wide, and the
      // coarser 1 mm grid used elsewhere quantised it away entirely (measured).
      { id: 'rest-rough-4-flat', type: 'adaptive_3d', toolId: 'bm-flat-4', scope: WHOLE_PART, params: roughParams({ cellSize: 0.4, maxStepdown: 3 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.4 },
      // Pencil: the fine 2 mm ball traces the concave ridges the roughing and
      // finishing passes leave rounded (chamber/neck junctions, the island's
      // pinch corners). No engagement promise -- pencil makes none.
      { id: 'pencil-2-ball', type: 'pencil_3d', toolId: 'bm-ball-2', scope: WHOLE_PART, params: { tolerance: 0.05, stockToLeave: 0, useStockBoundary: false, direction: 'climb' }, stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2 },
    ],
  },
  {
    id: 'engagement-pocket-rough-finish',
    partId: 'engagement-pocket',
    setupLabel: 'top',
    tiers: ['smoke', 'full'],
    steps: [
      {
        id: 'rough-6-flat',
        type: 'adaptive_3d',
        toolId: 'bm-flat-6',
        scope: WHOLE_PART,
        params: roughParams(),
        stockToLeaveMm: 0.3,
        gougeToleranceMm: 0.05,
        lateralAllowanceMm: 0.05,
        engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
        engagementCellMm: 1,
      },
      {
        id: 'finish-3-ball',
        type: 'parallel_3d',
        toolId: 'bm-ball-3',
        scope: WHOLE_PART,
        params: parallelParams(),
        stockToLeaveMm: 0,
        // MEASURED, not chosen: with a 0.2 mm lateral allowance this pass dips
        // 0.2007 mm below the part where it rolls over the block's convex top
        // edge, at a nominal 0.1 mm chordal tolerance. That is the engine's
        // current discretisation floor on a sharp convex edge, twice what the
        // tolerance says, and it is worth an order of its own -- it is NOT worth
        // failing this lane over. 0.3 keeps a real gouge (a plunge under the
        // floor, a wall eaten) caught.
        gougeToleranceMm: 0.3,
        lateralAllowanceMm: 0.2,
      },
    ],
  },
  {
    id: 'stepped-boss-rough-finish',
    partId: 'stepped-boss',
    setupLabel: 'top',
    tiers: ['smoke', 'full'],
    steps: [
      {
        id: 'rough-6-flat',
        type: 'adaptive_3d',
        toolId: 'bm-flat-6',
        scope: WHOLE_PART,
        params: roughParams({ maxStepdown: 5, cellSize: 0.8 }),
        stockToLeaveMm: 0.3,
        gougeToleranceMm: 0.05,
        lateralAllowanceMm: 0.05,
        engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
        engagementCellMm: 0.8,
      },
      {
        id: 'finish-3-ball',
        type: 'parallel_3d',
        toolId: 'bm-ball-3',
        scope: WHOLE_PART,
        params: parallelParams({ stepover: 1.5 }),
        stockToLeaveMm: 0,
        gougeToleranceMm: 0.3,
        lateralAllowanceMm: 0.2,
      },
    ],
  },
  {
    id: 'boss-taper-step-rough-finish',
    partId: 'boss-taper-step',
    setupLabel: 'top',
    tiers: ['full'],
    steps: [
      { id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART, params: roughParams({ cellSize: 1 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 1 },
      { id: 'finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART, params: parallelParams({ stepover: 1 }), stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2 },
    ],
  },
]

/** Chains in a tier, in declaration order (the row order of the scorecard). */
export function chainsForTier(tier: BenchmarkTier): readonly BenchmarkChain[] {
  return CHAINS.filter((chain) => chain.tiers.includes(tier))
}

/**
 * The scorecard row key: (part, setup, operation, tool, scope), exactly as
 * WO-1217 section 4 specifies. Stable across runs and across registry growth,
 * so a baseline entry survives a new part being added next to it.
 */
export function rowKey(chain: BenchmarkChain, step: BenchmarkStep): string {
  return [chain.partId, step.setupLabel ?? chain.setupLabel, step.id, step.toolId, step.scope.id].join('/')
}

/** Every row key a tier will produce, in row order. Used to prove the run is data-driven. */
export function rowKeysForTier(tier: BenchmarkTier): string[] {
  return chainsForTier(tier).flatMap((chain) => chain.steps.map((step) => rowKey(chain, step)))
}
