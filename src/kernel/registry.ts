import { describeOperation } from './operationDefinition'
// ---------------------------------------------------------------------------
// WO-1819 stage 1 — ONE operation manifest, keyed by OperationType.
//
// The architecture audit (docs/ARCHITECTURE-AUDIT-2026-08-26.md §3.6) counted
// at least five hand-kept enumerations of OperationType: the toolpath worker's
// if/else chain, the store's compute gate chain, the store's payload-builder
// switch, the two cam3d forks, and the wizard/properties booleans. They drift
// independently, which is the mechanism behind the recurring op-family bugs: a
// new operation silently misses one enumeration and half the product does not
// know it exists.
//
// This table is the single place an operation declares HOW IT COMPUTES. It is
// `satisfies Record<OperationType, ...>`, so adding a member to the
// OperationType union without declaring its route here is a COMPILE ERROR
// (`npm run build`), not a memory - the same narrow compile-time exhaustiveness
// pattern already proven in-tree by STOCK_CUTTING_BY_ROLE / MOVE_MOTION_BY_ROLE
// (audit §1.7).
//
// STAGE 1 SCOPE (this order): the worker's dispatch entry (`requestType`) and
// the store's payload-builder descriptor (`buildRequest`). The remaining
// consumers are ENUMERATED below in OPERATION_MANIFEST_CONSUMERS with the
// follow-on slice that migrates each; none of them is migrated here.
//
// BYTE-IDENTICAL BY CONSTRUCTION: every buildRequest below is the former store
// branch moved verbatim - the same conditional spreads, so a field the old
// branch omitted stays ABSENT from the posted payload rather than present-and-
// undefined. Nothing about a payload's content changes.
//
// WHY NO BUILDER FUNCTIONS LIVE HERE: the store imports this module, and the
// toolpath builders (pocket2d, drill2d, vcarve2d, the adaptive engine...) are
// worker-bundle code. Naming them here would statically pull every CAM engine
// into the main bundle. The worker keeps its builder table (toolpathWorker.ts,
// TOOLPATH_BUILDERS) and that table is keyed by `ToolpathWorkerRequestType`,
// which is derived from the ONE WorkerRequestMsg union - so a new operation
// still cannot ship without both the manifest row and the worker arm existing.
// ---------------------------------------------------------------------------
import type { HeightParams, Operation, OperationType } from '../types'
import type {
  ACParams,
  BoreParams,
  ChamferParams,
  ContourParams,
  ContourWorkerPayload,
  DrillParams,
  EngraveParams,
  FaceParams,
  PatternMachineLimits,
  PatternParams,
  PocketParams,
  ThreadMillParams,
  VCarveParams,
  WorkerRequestMsg,
} from '../lib/cam/types'

/** Every worker request that computes a toolpath. Derived from the ONE
 *  WorkerRequestMsg union, never re-listed: COMPUTE_NEST rides the same
 *  transport but produces placements, not moves, and has no OperationType. */
export type ToolpathWorkerRequestType = Exclude<WorkerRequestMsg['type'], 'COMPUTE_NEST'>

/** The fields the store resolves once for EVERY 2.5D operation before dispatch
 *  (opId/setupId, the resolved heights, passes, linking, the tool, the world-
 *  space loops, the WCS origin, and the crash-guard holder/stock). The tool-
 *  reach inputs the store also spreads in ride along untouched - they are read
 *  through ToolReachInputs in the worker, not through the payload interfaces. */
export type OperationBasePayload = Pick<
  ContourWorkerPayload,
  'opId' | 'setupId' | 'heights' | 'passes' | 'linking' | 'tool' | 'loops'
  | 'wcsOrigin' | 'feedrateOverride' | 'holder' | 'stockBlock'
>

/** Contour's pre-dispatch work stays in the store: it can REFUSE (an open
 *  contour with no resolvable stock XY bounds) and it derives the in-viewport
 *  tab-marker preview afterwards. What it resolves is handed here. */
export interface ContourDispatchInputs {
  readonly params: ContourParams
  readonly loopBottoms?: { [loopId: string]: number }
  readonly stockBottomZ?: number
  readonly stockBounds?: { min: { x: number; y: number }; max: { x: number; y: number } }
}

/** WO-1820: Facing's 'rest' boundary is settled in the store at DISPATCH, not
 *  up at boundary resolution - the depth rule (does an earlier pocket reach at
 *  least as deep as this face?) needs the face's own resolved bottom plane.
 *  What it settles is handed here. Present only when the operator asked for
 *  boundary source 'rest'; a stock/geometry face leaves it undefined and its
 *  payload is exactly what it always was. */
export interface FaceDispatchInputs {
  /** The rest region's outer boundary, which REPLACED the face's resolved loops
   *  after basePayload had already been built - so the row restates it. */
  readonly loops: OperationBasePayload['loops']
  /** The islands the earlier pockets already cleared. Absent for a non-rest
   *  face, which is the gate the face builder itself reads. */
  readonly regionHoles?: Array<Array<{ x: number; y: number }>>
}

/** WO-3001: what the pattern row reports against - the spindle speed the post
 *  will command and the machine's stated bounds. Notes only; nothing refuses. */
export interface PatternDispatchInputs {
  readonly spindleRpm?: number
  readonly machine?: PatternMachineLimits
}

/** Everything a payload builder may read. One context for all of them, so a
 *  row cannot quietly reach for a store local nobody declared. */
export interface OperationRequestContext {
  readonly op: Operation
  readonly basePayload: OperationBasePayload
  /** The Smart Height V2 worker heights for this op (already resolved). */
  readonly opHeights: HeightParams
  /** WCS-relative planes the height resolution above settled on. */
  readonly resolvedTopPlane: number
  readonly resolvedBottomPlane: number
  /** Drill/bore: per-feature bottoms from the smart-height resolution. */
  readonly featureBottoms?: { [loopId: string]: number }
  /** Drill: loop ids stamped from a model body, overriding the persisted ones. */
  readonly drillLoopIdsOverride?: string[]
  /** Smart-height runtime params, when that family resolved them. */
  readonly chamferWorkerParams?: ChamferParams
  readonly engraveWorkerParams?: EngraveParams
  readonly threadMillWorkerParams?: ThreadMillParams
  /** Whether the smart resolution produced a BOTTOM for chamfer/engrave. When
   *  it did not, those payloads must omit bottomHeight exactly as before. */
  readonly chamferBottomResolved: boolean
  readonly engraveBottomResolved: boolean
  /** Adaptive clearing: the project machine rate used by runtime/post execution. */
  readonly machineRapidRate?: number
  /** Adaptive clearing: authored XY placement per source loop. */
  readonly loopOrigins?: Record<string, { x: number; y: number }>
  /** Contour only; resolved by the store because it can refuse first. */
  readonly contour?: ContourDispatchInputs
  /** Face only, and only for boundary source 'rest'; resolved by the store
   *  because it can refuse first (nothing left to face) and because the
   *  subtraction needs the resolved bottom plane. */
  readonly face?: FaceDispatchInputs
  /** Pattern only (WO-3001). */
  readonly pattern?: PatternDispatchInputs
}

type ToolpathRoute<T extends ToolpathWorkerRequestType> = {
  readonly lane: 'toolpath-worker'
  readonly requestType: T
  readonly buildRequest: (ctx: OperationRequestContext) => Extract<WorkerRequestMsg, { type: T }>
  /** Contour alone derives the tab-marker preview after dispatch. REQUIRED, so
   *  a new operation must answer the question here instead of leaving the store
   *  to re-test op.type. */
  readonly derivesTabPreview: boolean
}

type AnyToolpathRoute = {
  [T in ToolpathWorkerRequestType]: ToolpathRoute<T>
}[ToolpathWorkerRequestType]

/** The 3D families do NOT run through toolpathWorker: they branch earlier in
 *  computeOperationToolpath into the serialized cam3d lane. Declared, not
 *  migrated - see OPERATION_MANIFEST_CONSUMERS. */
type Cam3dRoute = {
  readonly lane: 'cam3d'
  readonly orchestrator: 'parallel3d' | 'waterline3d' | 'adaptive3d'
}

export type OperationManifestEntry = {
  readonly compute: AnyToolpathRoute | Cam3dRoute
}

/** Contour's payload was the `else` arm of the old chain, reached by
 *  contour_2d alone (every 3D family returns earlier, and the other nine 2.5D
 *  families had explicit arms). It is a named row now. */
const contourRequest = (ctx: OperationRequestContext): Extract<WorkerRequestMsg, { type: 'COMPUTE_CONTOUR' }> => {
  const contour = ctx.contour!
  return {
    type: 'COMPUTE_CONTOUR',
    payload: {
      ...ctx.basePayload,
      params: contour.params,
      ...(contour.loopBottoms ? { loopBottoms: contour.loopBottoms } : {}),
      ...(contour.stockBottomZ !== undefined ? { stockBottomZ: contour.stockBottomZ } : {}),
      ...(contour.stockBounds ? { stockBounds: contour.stockBounds } : {}),
    },
  }
}

const OPERATION_ROUTES = {
  // ── 2.5D: the toolpath worker ────────────────────────────────────────────
  contour_2d: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_CONTOUR',
      derivesTabPreview: true,
      buildRequest: contourRequest,
    },
  },

  pocket_2d: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_POCKET',
      derivesTabPreview: false,
      // Bottom plane resolved by the store (selected_face wins over
      // heightReference). Top plane too: for a GEOMETRY pocket resolvedTopPlane
      // equals opHeights.topHeight (byte-identical), but for a STOCK pocket it is
      // the captured stock top (opHeights.topHeight was never re-resolved), so
      // resolvedTopPlane is what puts the cut top on the stock surface.
      buildRequest: (ctx) => ({
        type: 'COMPUTE_POCKET',
        payload: {
          ...ctx.basePayload,
          params: ctx.op.params as unknown as PocketParams,
          heights: { ...ctx.opHeights, topHeight: ctx.resolvedTopPlane, bottomHeight: ctx.resolvedBottomPlane },
        },
      }),
    },
  },

  drill: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_DRILL',
      derivesTabPreview: false,
      buildRequest: (ctx) => {
        const base = ctx.op.params as unknown as DrillParams
        const params: DrillParams = ctx.drillLoopIdsOverride
          ? { ...base, loopIds: ctx.drillLoopIdsOverride }
          : base
        return {
          type: 'COMPUTE_DRILL',
          payload: {
            ...ctx.basePayload,
            params,
            ...(ctx.featureBottoms ? { holeBottoms: ctx.featureBottoms } : {}),
          },
        }
      },
    },
  },

  bore: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_BORE',
      derivesTabPreview: false,
      buildRequest: (ctx) => ({
        type: 'COMPUTE_BORE',
        payload: {
          ...ctx.basePayload,
          params: ctx.op.params as unknown as BoreParams,
          heights: { ...ctx.opHeights, topHeight: ctx.resolvedTopPlane, bottomHeight: ctx.resolvedBottomPlane },
          ...(ctx.featureBottoms ? { boreBottoms: ctx.featureBottoms } : {}),
        },
      }),
    },
  },

  chamfer: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_CHAMFER',
      derivesTabPreview: false,
      buildRequest: (ctx) => ({
        type: 'COMPUTE_CHAMFER',
        payload: {
          ...ctx.basePayload,
          heights: {
            ...ctx.opHeights,
            topHeight: ctx.resolvedTopPlane,
            ...(ctx.chamferBottomResolved ? { bottomHeight: ctx.resolvedBottomPlane } : {}),
          },
          params: ctx.chamferWorkerParams ?? (ctx.op.params as unknown as ChamferParams),
        },
      }),
    },
  },

  face: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_FACE',
      derivesTabPreview: false,
      // V2 already applied the floor allowance to the cutter endpoint. Zero
      // BOTH legacy worker inputs so Face cannot apply it a second time.
      buildRequest: (ctx) => {
        const faceParams = ctx.op.params as unknown as FaceParams
        return {
          type: 'COMPUTE_FACE',
          payload: {
            ...ctx.basePayload,
            // WO-1820: a 'rest' face posts the rest region, not the boundary
            // basePayload snapshotted before the earlier-pocket subtraction ran.
            // Absent for stock/geometry, where basePayload's loops are already
            // the right ones - same key, same position, same value as before.
            ...(ctx.face ? { loops: ctx.face.loops } : {}),
            heights: { ...ctx.opHeights, topHeight: ctx.resolvedTopPlane, bottomHeight: ctx.resolvedBottomPlane },
            passes: { ...ctx.op.passes, floorStockToLeave: 0 },
            params: { ...faceParams, floorStockToLeave: 0 },
            // The gate the face builder reads: no regionHoles field at all means
            // a plain face, so a non-rest face must NOT carry an empty array.
            ...(ctx.face?.regionHoles ? { regionHoles: ctx.face.regionHoles } : {}),
          },
        }
      },
    },
  },

  engrave: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_ENGRAVE',
      derivesTabPreview: false,
      // Engrave/Trace rides the surface; the reference plane was resolved into
      // the top of cut (matches chamfer/face). The builder measures depth down
      // from this plane. The loops carry all curves (open + closed); the builder
      // filters by includeOpen/includeClosed.
      buildRequest: (ctx) => ({
        type: 'COMPUTE_ENGRAVE',
        payload: {
          ...ctx.basePayload,
          heights: {
            ...ctx.opHeights,
            topHeight: ctx.resolvedTopPlane,
            ...(ctx.engraveBottomResolved ? { bottomHeight: ctx.resolvedBottomPlane } : {}),
          },
          params: ctx.engraveWorkerParams ?? (ctx.op.params as unknown as EngraveParams),
        },
      }),
    },
  },

  vcarve: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_VCARVE',
      derivesTabPreview: false,
      // Material Start (datum - start depth) and Cutter End (Material Start -
      // the effective maximum depth) were resolved by the V2 formula; the
      // builder places every ridge point between them.
      buildRequest: (ctx) => ({
        type: 'COMPUTE_VCARVE',
        payload: {
          ...ctx.basePayload,
          params: ctx.op.params as unknown as VCarveParams,
          heights: { ...ctx.opHeights, topHeight: ctx.resolvedTopPlane, bottomHeight: ctx.resolvedBottomPlane },
        },
      }),
    },
  },

  adaptive_clearing_2d: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_ADAPTIVE_CLEARING',
      derivesTabPreview: false,
      // FreeCAD-port adaptive engine (Phase 6). Previously fell through to
      // COMPUTE_CONTOUR; it has had its own worker handler since.
      buildRequest: (ctx) => ({
        type: 'COMPUTE_ADAPTIVE_CLEARING',
        payload: {
          ...ctx.basePayload,
          params: ctx.op.params as unknown as ACParams,
          machineRapidRate: ctx.machineRapidRate,
          loopOrigins: ctx.loopOrigins,
        },
      }),
    },
  },

  thread_mill: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_THREAD_MILL',
      derivesTabPreview: false,
      // Explicit route. A thread_mill op once fell through to COMPUTE_CONTOUR
      // (silent wrong toolpath). The builder fails loud (ADR-0003) on orphaned
      // holes / out-of-scope params / a tool too large for the hole. Heights are
      // chamfer-style, top-referenced: topZ = thread top (reference plane +
      // offset), bottomZ = top - threadDepth.
      buildRequest: (ctx) => ({
        type: 'COMPUTE_THREAD_MILL',
        payload: {
          ...ctx.basePayload,
          params: ctx.threadMillWorkerParams ?? (ctx.op.params as unknown as ThreadMillParams),
          heights: { ...ctx.opHeights, topHeight: ctx.resolvedTopPlane, bottomHeight: ctx.resolvedBottomPlane },
        },
      }),
    },
  },

  pattern: {
    compute: {
      lane: 'toolpath-worker',
      requestType: 'COMPUTE_PATTERN',
      derivesTabPreview: false,
      // WO-3001: the spec's depth is measured down from the resolved Material
      // Start, so the top of cut is the resolved top plane (as for engrave).
      buildRequest: (ctx) => ({
        type: 'COMPUTE_PATTERN',
        payload: {
          ...ctx.basePayload,
          params: ctx.op.params as unknown as PatternParams,
          heights: { ...ctx.opHeights, topHeight: ctx.resolvedTopPlane, bottomHeight: ctx.resolvedBottomPlane },
          ...(ctx.pattern?.spindleRpm !== undefined ? { spindleRpm: ctx.pattern.spindleRpm } : {}),
          ...(ctx.pattern?.machine ? { machine: ctx.pattern.machine } : {}),
        },
      }),
    },
  },

  // ── 3D: the serialized cam3d lane (D-018) ────────────────────────────────
  // Declared so a new 3D operation still has to answer "how does this compute?"
  // here. The store's own cam3d forks are NOT migrated in stage 1.
  parallel_3d:       { compute: { lane: 'cam3d', orchestrator: 'parallel3d' } },
  steep_shallow_3d:  { compute: { lane: 'cam3d', orchestrator: 'parallel3d' } },
  scallop_3d:        { compute: { lane: 'cam3d', orchestrator: 'parallel3d' } },
  pencil_3d:         { compute: { lane: 'cam3d', orchestrator: 'parallel3d' } },
  waterline_3d:      { compute: { lane: 'cam3d', orchestrator: 'waterline3d' } },
  adaptive_3d:       { compute: { lane: 'cam3d', orchestrator: 'adaptive3d' } },
} as const satisfies Record<OperationType, OperationManifestEntry>

/**
 * The manifest row for an operation. Total by construction - every
 * OperationType has a row or the module does not compile.
 */
export function operationManifestEntry(type: OperationType): OperationManifestEntry {
  return OPERATION_REGISTRY[type]
}

// ---------------------------------------------------------------------------
// STAGE 2: the consumers this manifest does NOT yet own.
//
// Enumerated here, by file, so the next slice starts from a derived list rather
// than another reading of the audit. Each names the follow-on order that
// migrates it; those orders are named in
// queue/WO-1819-one-operation-manifest-replaces-the-five-enumerations.md.
// ---------------------------------------------------------------------------
export interface DeclaredManifestConsumer {
  /** Repo-relative file holding the enumeration. */
  readonly file: string
  /** What it enumerates per OperationType. */
  readonly enumerates: string
  /** The follow-on slice that turns it into a manifest lookup. */
  readonly followOnSlice: string
  readonly migrated: false
}

export const OPERATION_MANIFEST_CONSUMERS: readonly DeclaredManifestConsumer[] = [
  {
    file: 'src/components/modals/NewOperationModalBody.tsx',
    enumerates: 'the new-operation wizard booleans (which families the picker offers, and which '
      + 'parameter groups each one shows)',
    followOnSlice: 'WO-1819 stage 2a - wizard picker reads the manifest',
    migrated: false,
  },
  {
    file: 'src/components/panels/PropertiesPanel.tsx',
    enumerates: 'the properties-panel per-family booleans (which editors an operation shows)',
    followOnSlice: 'WO-1819 stage 2b - properties panel reads the manifest',
    migrated: false,
  },
  {
    file: 'src/store/index.ts',
    enumerates: 'the two cam3d forks in computeOperationToolpath (which 3D orchestrator each 3D '
      + 'family hands off to) and the pre-dispatch compute gate chain',
    followOnSlice: 'WO-1819 stage 2c - cam3d forks read the manifest cam3d route',
    migrated: false,
  },
]

// Every legacy consumer reads the same compute descriptors from this table.
export const OPERATION_REGISTRY = Object.fromEntries(
  (Object.keys(OPERATION_ROUTES) as OperationType[]).map(id => [id, {
    ...OPERATION_ROUTES[id], ...describeOperation(id),
  }]),
) as { readonly [K in OperationType]: (typeof OPERATION_ROUTES)[K] & ReturnType<typeof describeOperation> }
export const OPERATION_MANIFEST = OPERATION_REGISTRY
export const operationTypes = Object.freeze(Object.keys(OPERATION_REGISTRY) as OperationType[])
