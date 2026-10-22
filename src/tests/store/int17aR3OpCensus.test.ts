// INT-17A-R3 C1 GATE: the CLOSED-UNION guard-coverage census.
//
// The round-3 audit's C1 asked for coverage DERIVED from the closed
// `OperationType` union rather than asserted about a hand-picked set of call
// sites. That is what this file is, and the derivation has two halves:
//
//   COMPILE TIME. src/store/opModelOriginGuard.ts declares
//   `OP_GEOMETRY_REFERENCE_SOURCE: Record<OperationType, ...>`. tsc rejects a
//   missing member, so a new op type added to the union fails `npm run build`
//   until it is classified. That is the half that catches "someone added a
//   type and never thought about geometry references at all".
//
//   RUN TIME (this file). The census enumerates `ALL_OPERATION_TYPES`, which is
//   `Object.keys` of that same Record - NOT a hand-typed list, because a
//   hand-typed list is a second source of truth that fails in whichever
//   direction hides a gap. For each type it drives the REAL store action a
//   user's Compute button calls, with a modeled entry planted in the field that
//   type's family actually reads, and requires a refusal BY NAME plus zero
//   toolpath. That is the half that catches "someone classified a type into the
//   wrong field, or added a family whose build path returns before the guard" -
//   which is precisely the R2 defect this WO exists to cure.
//
// HOW IT CAN FAIL (charter rule 1 - a probe that cannot fail is not a gate):
//   - delete any row from OP_GEOMETRY_REFERENCE_SOURCE  -> build fails
//   - misclassify parallel_3d as 'params.geometryId'    -> its census case AND
//                                                          the R5 cross-check fail
//   - move guardOperationModelOrigin below the 3D branches (the R2 placement)
//                                                       -> both 3D cases fail
//   - weaken the guard to a non-named error             -> every case fails
//   - rename `geometryId` on a payload interface OP_GEOMETRY_FIELD_MAP checks
//     it against (or delete a row from that map)        -> build fails (B3)
// The mutation proofs committed with R3, R4 and R5 (B3, on a scratch copy)
// exercise the third, second and this last one respectively.
//
// NOT-VACUITY CONTROL: the same census also drives every type with a LEGITIMATE
// source and requires it NOT to hit the model-origin refusal. Without that,
// a guard that refused everything unconditionally would pass the whole census.
//
// INT-17A-R5 C1: the field each makeOp() fixture plants its entry id in is no
// longer a RUNTIME derivation at all - see independentGeometryField below,
// which now reads ONLY the COMPILE-TIME-CHECKED map in
// src/store/opGeometryFieldContract.ts. That file's own header is the full
// account of why (the DECISIONS 2026-07-18 "INT-17A C1 two-bounce STOP"
// ruling: a runtime string-suffix heuristic can never be a sound derivation
// of a TYPE-level fact, because TypeScript types erase at runtime - only tsc
// itself can check a field name against a real payload interface).
//
// INT-17A-R6 C1: R5's own major finding (coordination/reports/INT-17A-R5.audit.json)
// was that reading the MAP was not enough - makeOp() still planted the hostile
// id through fieldRefToLegacySource()'s REDUCED three-value vocabulary
// ('params.geometryId' | 'geometrySelections' | 'none'), which discards
// OP_GEOMETRY_FIELD_MAP[type].fields entirely and hardcodes every 'params'
// family's plant to the literal token `geometryId`. A map row naming a
// DIFFERENT (but type-valid) params field would still pass, because the
// fixture never looked at the row's own `fields` array - only at which of the
// three buckets it reduced to. makeOp() below now reads
// OP_GEOMETRY_FIELD_MAP[type] DIRECTLY and plants the hostile id into every
// field named in `ref.fields`, not a hardcoded literal. See that map's own
// R6 mutation proof (this WO's B3): mutating one family's `fields` entry to a
// different-but-type-valid key turns exactly that family's census case red,
// which R5's reduction-based fixture could not detect.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import {
  ALL_OPERATION_TYPES,
  OP_GEOMETRY_REFERENCE_SOURCE,
  operationReferencedGeometryIds,
} from '../../store/opModelOriginGuard'
import type { OpGeometryReferenceSource } from '../../store/opModelOriginGuard'
import {
  OP_GEOMETRY_FIELD_MAP,
  ALL_OPERATION_TYPES_FROM_FIELD_CONTRACT,
  fieldRefToLegacySource,
} from '../../store/opGeometryFieldContract'
import { operationHeightPolicy } from '../../lib/cam/smartHeights'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, Operation, OperationType, PhysicalStock, Project, SceneStock,
  Setup, Tool, Vec3, BoundingBox, WCS, HeightParams, PassParams, LinkingParams,
} from '../../types'

// ─── INT-17A-R5 C1: the COMPILE-TIME geometry-reference derivation ─────────
//
// The round-4 audit's C1 finding (coordination/reports/INT-17A-R4.audit.json):
// the R4 cure's independentGeometryField still classified every family from
// the OperationType STRING's `_3d` suffix - a runtime heuristic, disconnected
// from the map's own keys, that a compile-time payload-shape tuple merely
// happened to agree with for the ten families it covered. The DECISIONS
// ruling this WO is bound to says that agreement can never be FORCED at
// runtime - types erase - so the derivation has to happen at compile time,
// where tsc itself is the enforcement.
//
// independentGeometryField below is now a THIN wrapper over
// OP_GEOMETRY_FIELD_MAP (src/store/opGeometryFieldContract.ts) - ZERO suffix
// heuristics, zero hand-typed classification. That map is
// `as const satisfies OpGeometryFieldMapType`, where OpGeometryFieldMapType
// is built from EACH family's own REAL payload interface (`OpPayloadByType`
// in that file) - so renaming `geometryId` on any covered payload interface,
// or omitting an OperationType from the map, fails `npm run build` directly.
// See that file's header for the full account, including why families with no
// compute path yet still get a REAL per-family check.
//
// The cross-check test below asserts OP_GEOMETRY_REFERENCE_SOURCE (the
// PRODUCTION guard's own map, unchanged by this WO) agrees with
// OP_GEOMETRY_FIELD_MAP for every type in the union. THAT is the direct
// target of the R3 audit's original mutation and the B3 mutation-proof pair
// this round commits: reclassify any type in either map and this test fails.

/**
 * INDEPENDENT of OP_GEOMETRY_REFERENCE_SOURCE - see file header above. Never
 * reads that map; reads ONLY the compile-time-checked OP_GEOMETRY_FIELD_MAP.
 */
function independentGeometryField(type: OperationType): OpGeometryReferenceSource {
  return fieldRefToLegacySource(OP_GEOMETRY_FIELD_MAP[type])
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function ordinaryGeo(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function hostileModelGeo(): ImportedGeometry {
  return {
    id: 'modelbody:F1', name: 'Model F1', filename: '', type: 'brep', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: -50 }, { x: 10, y: 10, z: 50 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'modelbody:F1-loop',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  } as unknown as ImportedGeometry
}

function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 12, y: 12, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

const tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

/**
 * Build an op of `type` that names `entryId` THROUGH THE EXACT FIELD(S)
 * OP_GEOMETRY_FIELD_MAP[type] DECLARES - not through fieldRefToLegacySource's
 * reduced three-value vocabulary, which R5's audit found discards the map's
 * own `fields` array and hardcodes every 'params' family's plant to the
 * literal `geometryId`.
 *
 * `ref` is read directly from OP_GEOMETRY_FIELD_MAP so a map row naming a
 * DIFFERENT (but type-valid) params field is observable: for a `kind:
 * 'params'` entry, `entryId` is spread into every name in `ref.fields`,
 * overriding whichever fixture default shares that name. If a family's map
 * row named `side` instead of `geometryId`, this plants the hostile id into
 * `params.side`, `params.geometryId` stays unset, and
 * operationReferencedGeometryIds (src/store/opModelOriginGuard.ts, which
 * reads only the hardcoded literal `params.geometryId` - production,
 * unchanged by this WO) finds nothing there. The guard never fires, and the
 * census's own sanity assertion (the op must actually NAME the modeled entry
 * through the field the map declares) fails immediately - which is exactly
 * the observability this WO's B3 mutation proof demonstrates.
 *
 * `source` (via fieldRefToLegacySource) is still used for the
 * `geometrySelections` vs `params` branch and for the cross-check test below;
 * it is `ref`'s own field-name list that is new here.
 */
function makeOp(type: OperationType, entryId: string): Operation {
  const ref = OP_GEOMETRY_FIELD_MAP[type]
  const source = fieldRefToLegacySource(ref)
  const plantedFields = ref.kind === 'params'
    ? Object.fromEntries(ref.fields.map((field) => [field, entryId] as const))
    : {}
  const geometrySelections = source === 'geometrySelections' ? [entryId] : []
  const params = ref.kind === 'params'
      // loopIds is carried by every 2.5D op the modal creates, and the
      // implemented families dereference it during worker dispatch (e.g.
      // index.ts:7200 for drill). The CONTROL cases below are the only ones
      // that get that far - a refusal case never reaches dispatch - so without
      // it the controls die on fixture shape rather than on the guard.
      // plantedFields is spread LAST so it overrides these defaults for any
      // field name the map itself names, which is the point of B3's mutation.
      ? { loopIds: [], side: 'outside', direction: 'climb', ...plantedFields }
      : { stepover: 1, angleDeg: 0 }
  return {
    id: 'op-1', name: `Op ${type}`, type, enabled: true, status: 'ready',
    toolId: 'tool-1',
    geometrySelections,
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params,
    // Commit 2e5678b7: a valid smart_v2 envelope is now the ONLY runtime
    // height authority, and ensureOperationSmartHeightAuthority runs BEFORE
    // guardOperationModelOrigin (store/index.ts computeOperationToolpath) -
    // so an op with no authority at all never reaches this file's guard, it
    // dies one boundary earlier. Stamp one for every family this census
    // drives so the cases below actually exercise the guard again. Families
    // with no LIVE Smart Height V2 policy (operationHeightPolicy(type).support
    // !== 'live') have no valid envelope a fixture could ever author - see
    // the NON_LIVE_HEIGHT_POLICY_TYPES block below, which asserts the V2
    // authority refusal directly instead.
    ...(operationHeightPolicy(type).support === 'live'
      ? { smartHeight: smartHeightAuthorityFixture(type, { setupId: 'setup-1', geometryIds: [entryId], stockId: DERIVED_STOCK_ID }) }
      : {}),
  } as unknown as Operation
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // Drill/Bore's Smart Height runtime (setupProvenStockId, store/index.ts)
      // requires a proven owning stock before it will resolve anything, live
      // or hostile source alike. Bind it to the same derived stock the
      // fixture's geometry and PhysicalStock already use.
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

function installProject(geometry: ImportedGeometry[], op: Operation): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project, geometry, stocks: [derivedStock()],
      setups: [makeSetup(op)], sceneStock,
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

/** The named CAM-BINDING Stage 1 "modeled source, no compute yet" state, as
 *  setOperationModelSourceUnsupported() renders it (store/index.ts). Was
 *  `/refusing modeled geometry "Model F1"/` (the hard-error phrasing) through
 *  INT-17A-R3; CAM-BINDING Stage 1 changed the OUTCOME (status 'unsupported',
 *  not 'error' - see the describe block below) so the message changed with it. */
const NAMED_REFUSAL = /sources modeled geometry "Model F1"/

describe('INT-17A-R3 C1: closed-union model-origin guard census', () => {
  let OrigWorker: typeof Worker | undefined

  beforeEach(() => {
    OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
    // A SILENT worker on purpose. This census asserts refusals, so any op that
    // reaches a worker at all has already failed its case; a responding worker
    // would only add noise. The real-compute proof lives in
    // int17aR3OpCompute.test.ts, which is where a completed toolpath belongs.
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      postMessage(): void { /* no-op */ }
      terminate(): void { /* no-op */ }
    }
  })
  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
    vi.restoreAllMocks()
  })

  it('the census enumerates the union itself, not a hand-typed list', () => {
    // Guards the derivation. If ALL_OPERATION_TYPES ever stops tracking the
    // Record (e.g. someone replaces it with a literal), this fails. Checked
    // against BOTH maps' own key sets - the guard's (production) and the
    // compile-time field contract's (this WO) - so neither can silently drop
    // a family without the other noticing.
    expect(ALL_OPERATION_TYPES).toEqual(Object.keys(OP_GEOMETRY_REFERENCE_SOURCE))
    expect(ALL_OPERATION_TYPES_FROM_FIELD_CONTRACT).toEqual(Object.keys(OP_GEOMETRY_FIELD_MAP))
    expect([...ALL_OPERATION_TYPES].sort()).toEqual([...ALL_OPERATION_TYPES_FROM_FIELD_CONTRACT].sort())
    expect(ALL_OPERATION_TYPES.length).toBeGreaterThanOrEqual(16)
    // Every classification is one of the three legal values - a typo'd source
    // string would otherwise silently make operationReferencedGeometryIds
    // return [] and every op of that family sail through unguarded.
    for (const type of ALL_OPERATION_TYPES) {
      expect(['params.geometryId', 'geometrySelections', 'none'])
        .toContain(OP_GEOMETRY_REFERENCE_SOURCE[type])
    }
  })

  it('INT-17A-R5 C1: the compile-time field map agrees with the guard map for every type', () => {
    // THE cross-check B2 requires. independentGeometryField never reads
    // OP_GEOMETRY_REFERENCE_SOURCE (see the file header and
    // independentGeometryField's own doc comment) - it reads ONLY
    // OP_GEOMETRY_FIELD_MAP, which is `as const satisfies` a mapped type built
    // from each family's OWN real payload interface
    // (src/store/opGeometryFieldContract.ts). A mismatch here means either
    // the guard's map or the compile-time map is wrong, and either way an op
    // of that family is at risk of being checked against the wrong field -
    // this is the failure the R3 audit's adversarial mutation (reclassifying
    // parallel_3d as 'params.geometryId') produced, and it could not have
    // been caught by comparing either map to itself. No suffix heuristic and
    // no runtime string derivation appears anywhere in this comparison - both
    // sides are maps, one production and one compile-time-checked.
    for (const type of ALL_OPERATION_TYPES) {
      expect(OP_GEOMETRY_REFERENCE_SOURCE[type], `type: ${type}`)
        .toBe(independentGeometryField(type))
    }
  })

  // CAM-DRILL-FIX1 (2026-07-23): 'drill' is EXCLUDED from this hostile-source
  // census below and given its own dedicated case. hostileModelGeo() carries
  // a landed `loops` entry (a wizard "Detect holes" snapshot shape), and
  // CAM-DRILL-ADAPTER's drill branch (store/index.ts, `op.type === 'drill'`)
  // treats ANY non-empty `refGeo.loops` as a valid wizard-landed snapshot -
  // unlike contour_2d/pocket_2d, which still require deriveModelBodyProfile
  // to re-derive from real tessellation (absent here, so THEY still refuse
  // at "unsupported"). Drill's height resolution used to also refuse (the
  // exact CAM-DRILL-EVIDENCE defect: resolveTopZ's stock_top/stock_bottom
  // arrival guard threw ModelOriginComputeError for the op's own declared
  // model-origin source), landing this census case on 'error', not
  // 'unsupported' - so this test was ALREADY failing that assertion before
  // CAM-DRILL-FIX1 (confirmed via `git stash`: pre-fix HEAD fails the SAME
  // 'unsupported' assertion with status 'error'). CAM-DRILL-FIX1's narrow
  // resolveTopZ opt-in makes height resolution SUCCEED for this single-stock
  // fixture, so drill now proceeds all the way to a real worker dispatch -
  // exactly the CONTROL shape below, not the hostile-refusal shape. Given a
  // single stock and a landed loop, drill graduated past "hostile" for this
  // fixture; it belongs with the CONTROL cases, not with the still-genuinely-
  // unsupported types.
  const HOSTILE_CENSUS_TYPES = ALL_OPERATION_TYPES.filter((t) => t !== 'drill')

  // Commit 2e5678b7 split this census down the middle. Only a family with a
  // LIVE Smart Height V2 policy can be stamped a valid envelope (see makeOp
  // above), so only those families ever reach guardOperationModelOrigin at
  // all - families with no live policy are turned away by
  // ensureOperationSmartHeightAuthority BEFORE the model-origin guard runs,
  // regardless of what geometry they name. Derived from operationHeightPolicy
  // itself, not hand-typed, for the same reason the rest of this file avoids
  // hand-typed lists: a family's support flipping to 'live' moves it between
  // these two groups automatically.
  const LIVE_HEIGHT_POLICY_HOSTILE_TYPES = HOSTILE_CENSUS_TYPES.filter(
    (t) => operationHeightPolicy(t).support === 'live',
  )
  const NON_LIVE_HEIGHT_POLICY_TYPES = HOSTILE_CENSUS_TYPES.filter(
    (t) => operationHeightPolicy(t).support !== 'live',
  )

  it.each(LIVE_HEIGHT_POLICY_HOSTILE_TYPES)(
    // CAM-BINDING Stage 1: a model-origin source is now a LEGAL declared
    // source for every op family (the op-picker gate) - the guard still
    // catches the reference and still produces no toolpath, but the status is
    // the named 'unsupported' (no Stage 2 compute path yet), never 'error'.
    '%s names its model-origin source BY NAME, lands on the unsupported status, and produces no toolpath',
    async (type) => {
      installProject(
        [ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
        makeOp(type, 'modelbody:F1'),
      )

      // Sanity on the fixture itself: the op must actually NAME the modeled
      // entry through its declared field, or this case would pass vacuously.
      expect(operationReferencedGeometryIds(currentOp())).toContain('modelbody:F1')

      await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

      expect(currentOp().status).toBe('unsupported')
      expect(currentOp().errorMessage ?? '').toMatch(NAMED_REFUSAL)
      expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
    },
  )

  it.each(NON_LIVE_HEIGHT_POLICY_TYPES)(
    // These families have no live Smart Height V2 policy at all, so no
    // fixture (and no real operation dialog) can ever author them a valid
    // envelope. ensureOperationSmartHeightAuthority (src/store/index.ts,
    // ahead of guardOperationModelOrigin) refuses on that fact alone, before
    // it ever looks at the op's geometry reference - so the model-origin
    // guard this file censuses is unreachable for these types, hostile
    // source or not. This is V2-authority truth, not a guard-census result.
    '%s has no live Smart Height V2 policy, so it is refused before the model-origin guard even runs',
    async (type) => {
      installProject(
        [ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
        makeOp(type, 'modelbody:F1'),
      )

      await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

      expect(currentOp().status).toBe('error')
      expect(currentOp().errorMessage ?? '').toMatch(
        new RegExp(`^${type} has no live Smart Height V2 policy in this build\\.`),
      )
      expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
    },
  )

  it('drill names its model-origin source BY NAME but, given a landed Detect-holes snapshot and a single stock, now proceeds to real compute (CAM-DRILL-FIX1) instead of refusing', async () => {
    installProject(
      [ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeOp('drill', 'modelbody:F1'),
    )

    expect(operationReferencedGeometryIds(currentOp())).toContain('modelbody:F1')

    // NOT awaited - same reason as the CONTROL block below: drill now reaches
    // a real toolpathWorker dispatch, and this suite's Worker is deliberately
    // silent, so awaiting would hang forever.
    void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      .catch(() => { /* unrelated downstream failure is not this gate's concern */ })
    await Promise.resolve()
    await Promise.resolve()

    expect(currentOp().errorMessage ?? '').not.toMatch(NAMED_REFUSAL)
    expect(currentOp().status).not.toBe('unsupported')
    expect(currentOp().status).not.toBe('error')
  })

  it.each(ALL_OPERATION_TYPES)(
    'CONTROL: %s with a legitimate source is NOT turned away by the model-origin guard',
    async (type) => {
      // Non-vacuity. A guard that refused every op unconditionally would pass
      // every case above; it cannot pass these. Note this asserts only that the
      // MODEL-ORIGIN refusal is absent - unimplemented types still legitimately
      // stop at "unsupported operation type", which is a different message and
      // a different concern.
      installProject(
        [ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
        makeOp(type, 'g1'),
      )

      // NOT awaited, deliberately. guardOperationModelOrigin is SYNCHRONOUS and
      // runs before any branch, worker hand-off or await in
      // computeOperationToolpath, so if it were going to refuse this op it has
      // already done so by the time control returns to us. Awaiting instead
      // would hang: the implemented 2.5D families reach a real toolpathWorker
      // dispatch, and this suite's Worker is deliberately silent (see
      // beforeEach). A completed toolpath is not this file's job - that is
      // int17aR3OpCompute.test.ts, which drives the REAL worker and awaits.
      void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
        .catch(() => { /* an unrelated downstream failure is not this gate's concern */ })
      await Promise.resolve()
      await Promise.resolve()

      expect(currentOp().errorMessage ?? '').not.toMatch(NAMED_REFUSAL)
    },
  )
})
