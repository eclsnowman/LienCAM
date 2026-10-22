// operationGeometry.ts
//
// Declarative, PURE single-source-of-truth for "what geometry each operation
// consumes and how a clicked entity routes." Encodes the APPROVED entity-facts
// design from docs/ui-ux/smart-selection (R1 + the consumption matrix + R2a
// height roles). NO React / store / viewport imports, no side effects,
// deterministic. Consumed later by the unified "Click to select" mode chunk;
// nothing is wired into the UI yet.
//
// OperationType (src/types/index.ts) is the authority for the key set; the
// `Record<OperationType, OpGeometrySpec>` below forces every variant to be
// covered at compile time.
//
// NOTE on naming: the facing operation's OperationType is `face` (not the
// `face_2d` used informally in the design docs). It is the one op whose picked
// planar face is a FLOOR reference (R2a); the feature ops treat a picked planar
// face as a TOP reference.

import type { OperationType } from '../../types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClickableEntity = 'planarFace' | 'cylinder' | 'edge' | 'loop' | 'openCurve'

/** What a clicked entity carries (the "bundle of derivable facts", R1/D5). */
export interface EntityFacts {
  kind: ClickableEntity
  // common
  geoId: string
  // face / cylinder
  faceIndex?: number
  surfaceType?: number      // OCCT GeomAbs (0 plane, 1 cylinder, 2 cone...)
  topZ?: number
  bottomZ?: number
  // cylinder
  diameter?: number
  axis?: [number, number, number]
  cylinderKind?: 'bore' | 'boss'
  // edge / loop
  edgeIndex?: number
  loopId?: string
  closed?: boolean
}

/** How a given op consumes a given entity. */
export interface ConsumeResult {
  ok: boolean
  /** Why not, for the inline hint (only meaningful when ok === false). */
  reason?: string
  deriveKind?: 'face' | 'edge' | 'cylinder' | 'holes' | 'section' | 'loop'
  /** R2a: planar face -> top (feature ops) / floor (face). */
  heightRole?: 'top' | 'floor' | 'none'
  /** bore -> inside, boss -> outside (contour / pocket-family). */
  side?: 'inside' | 'outside'
  /**
   * Part B: for boundary-inference ops (pocket / adaptive / face), does a
   * coerced cylinder become a machined boundary ('contour') or an avoid-ISLAND
   * ('hole')? Maps directly onto LoopData.type so a synthesized boss outline
   * routes through pocket2d classifyLoops as an island. Unset for ops that do
   * no boundary inference (the cylinder is just a profile).
   */
  loopType?: 'contour' | 'hole'
  /** Set when the click was an unambiguous coercion (e.g. cylinder -> top rim loop). */
  coercedFrom?: ClickableEntity
}

export interface OpGeometrySpec {
  /** 2.5d = profile + depth; 3d = body + stock (future, not modelled yet). */
  dimensionality: '2.5d' | '3d'
  /** Entities this op consumes directly, in priority order. */
  accepts: ClickableEntity[]
  /** Open-capable contour/engrave ops use closedAndOpen; everything else is closed. */
  loopFilter: 'closed' | 'closedAndOpen'
  /** pocket / AC / face do island inference; others do not. */
  boundaryInference: 'largest-outer-inner-island' | 'none'
  /** Optional unambiguous coercion for a non-accepted entity (else: inline hint). */
  coerce?: Partial<Record<ClickableEntity, { to: ClickableEntity; note: string }>>
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

// Clicking a cylinder for a loop-consuming op uses the cylinder's TOP circular
// edge as a closed loop (unambiguous + useful). Heights then come from the
// cylinder's own facts (topZ/bottomZ), not from the planar-face height role.
const RIM_COERCE: NonNullable<OpGeometrySpec['coerce']> = {
  cylinder: { to: 'loop', note: 'top rim circle' },
}

// 3D ops have no 'body' clickable entity yet. Per spec, accept nothing for now
// and leave routing to a future chunk. Do NOT invent body handling here.
// TODO(smart-selection 3d): add a 'body' ClickableEntity + body/stock routing
// when 3D body selection is designed.
const THREE_D: OpGeometrySpec = {
  dimensionality: '3d',
  accepts: [],
  loopFilter: 'closed',
  boundaryInference: 'none',
}

export const OPERATION_GEOMETRY: Record<OperationType, OpGeometrySpec> = {
  // --- 2.5D ---
  // Feature boundary ops: picked planar face -> TOP reference (R2a).
  contour_2d: {
    dimensionality: '2.5d',
    accepts: ['planarFace', 'edge', 'loop', 'openCurve'],
    loopFilter: 'closedAndOpen',
    boundaryInference: 'none',
    coerce: RIM_COERCE,
  },
  pocket_2d: {
    dimensionality: '2.5d',
    accepts: ['planarFace', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'largest-outer-inner-island',
    coerce: RIM_COERCE,
  },
  // adaptive_clearing_2d: same as pocket.
  adaptive_clearing_2d: {
    dimensionality: '2.5d',
    accepts: ['planarFace', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'largest-outer-inner-island',
    coerce: RIM_COERCE,
  },
  // face: the one op whose picked planar face is a FLOOR reference (R2a / D8).
  face: {
    dimensionality: '2.5d',
    accepts: ['planarFace', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'largest-outer-inner-island',
    coerce: RIM_COERCE,
  },
  drill: {
    dimensionality: '2.5d',
    accepts: ['cylinder', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'none',
  },
  // bore: same as drill.
  bore: {
    dimensionality: '2.5d',
    accepts: ['cylinder', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'none',
  },
  thread_mill: {
    dimensionality: '2.5d',
    accepts: ['cylinder', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'none',
  },
  chamfer: {
    dimensionality: '2.5d',
    accepts: ['edge', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'none',
  },
  engrave: {
    dimensionality: '2.5d',
    accepts: ['edge', 'loop', 'openCurve'],
    loopFilter: 'closedAndOpen',
    boundaryInference: 'none',
  },
  // WO-3001: a pattern's optional region is closed loops, read even-odd by the
  // pattern builder itself (an inner loop is a hole), so no island inference.
  pattern: {
    dimensionality: '2.5d',
    accepts: ['loop'],
    loopFilter: 'closed',
    boundaryInference: 'none',
  },
  // vcarve: mirror engrave/contour for closed profiles (spec R1 line 72).
  // Accepts edges + closed loops; a clicked cylinder coerces to its top rim.
  // TODO(smart-selection): the design is silent on whether vcarve consumes a
  // planar face as a boundary; left non-consumable (hint) until confirmed.
  vcarve: {
    dimensionality: '2.5d',
    accepts: ['edge', 'loop'],
    loopFilter: 'closed',
    boundaryInference: 'none',
    coerce: RIM_COERCE,
  },

  // --- 3D (no 'body' entity yet; accepts [] for now) ---
  parallel_3d: THREE_D,
  waterline_3d: THREE_D,
  adaptive_3d: THREE_D,
  scallop_3d: THREE_D,
  steep_shallow_3d: THREE_D,
  pencil_3d: THREE_D,
}

// ---------------------------------------------------------------------------
// Op categories (internal routing helpers)
// ---------------------------------------------------------------------------

// Facing: a picked planar face is the FLOOR of the cut (R2a / D8). Every other
// planar-face-accepting op (contour / pocket / adaptive_clearing / vcarve)
// treats a picked planar face as the TOP of the cut.
const FACE_FLOOR_OPS: ReadonlySet<OperationType> = new Set(['face'])
// Hole-deriving ops: a cylinder/loop becomes a hole feature.
const DRILL_OPS: ReadonlySet<OperationType> = new Set(['drill', 'bore'])

function sideFromCylinder(facts: EntityFacts): 'inside' | 'outside' | undefined {
  if (facts.cylinderKind === 'bore') return 'inside'
  if (facts.cylinderKind === 'boss') return 'outside'
  return undefined
}

const ENTITY_LABEL: Record<ClickableEntity, string> = {
  planarFace: 'planar face',
  cylinder: 'cylindrical wall',
  edge: 'edge',
  loop: 'loop',
  openCurve: 'open curve',
}

/** Inline-hint text for a non-consumable, non-coercible click. */
function hintFor(op: OperationType, kind: ClickableEntity): string {
  const ent = ENTITY_LABEL[kind]
  if (DRILL_OPS.has(op) && kind === 'planarFace') {
    return `${op} needs a hole - click the bore/hole, not the ${ent}.`
  }
  if (kind === 'openCurve') {
    return `${op} uses closed profiles - an ${ent} cannot be used here.`
  }
  if (kind === 'cylinder') {
    return `${op} cannot use a ${ent} - click its top edge instead.`
  }
  return `${op} cannot use a ${ent}.`
}

/** Route an entity the op accepts directly. */
function deriveAccepted(op: OperationType, facts: EntityFacts): ConsumeResult {
  switch (facts.kind) {
    case 'planarFace': {
      // Only feature-boundary + facing ops accept a planar face.
      const heightRole = FACE_FLOOR_OPS.has(op) ? 'floor' : 'top'
      return { ok: true, deriveKind: 'face', heightRole }
    }
    case 'edge':
      return { ok: true, deriveKind: 'edge', heightRole: 'none' }
    case 'loop':
      // drill/bore: a (circular) loop derives a hole; everyone else: a loop.
      if (DRILL_OPS.has(op)) return { ok: true, deriveKind: 'holes', heightRole: 'none' }
      return { ok: true, deriveKind: 'loop', heightRole: 'none' }
    case 'cylinder':
      // Accepted only by drill/bore (-> holes) and thread_mill (-> cylinder).
      if (DRILL_OPS.has(op)) return { ok: true, deriveKind: 'holes', heightRole: 'none' }
      return { ok: true, deriveKind: 'cylinder', heightRole: 'none' }
    case 'openCurve':
      // Accepted by open-capable contour and engrave operations. An open curve
      // becomes an open loop entry; deriveKind 'loop' (no dedicated 'curve' kind).
      return { ok: true, deriveKind: 'loop', heightRole: 'none' }
  }
}

/** Route a non-accepted entity via the op's declared coercion. */
function deriveCoerced(
  op: OperationType,
  facts: EntityFacts,
  to: ClickableEntity,
): ConsumeResult {
  // Only cylinder -> loop (top rim circle) is modelled today.
  if (facts.kind === 'cylinder' && to === 'loop') {
    // Part B - OP-AWARE cylinder routing. For boundary-inference ops (pocket /
    // adaptive_clearing / face) a clicked cylinder is NOT the machined boundary:
    // a BOSS becomes an avoid-ISLAND (loopType 'hole'), a BORE a boundary region
    // (loopType 'contour'). Non-boundary ops (contour / vcarve) keep a plain
    // profile loop (NO island loopType).
    //
    // The cut FLOOR is the cylinder's base (bottomZ = the deck) for EVERY one of
    // these ops, so heightRole 'floor' in BOTH branches: contouring a boss
    // descends its wall from the top rim down to the base, exactly as clearing
    // around it does (Bug A fix - contour previously returned 'none', so the
    // bottom silently fell to a default depth instead of the boss base). The
    // depth binding is identical; only the island inference differs.
    const spec = OPERATION_GEOMETRY[op]
    if (spec.boundaryInference === 'largest-outer-inner-island') {
      return {
        ok: true,
        deriveKind: 'loop',
        heightRole: 'floor',
        side: sideFromCylinder(facts),
        loopType: facts.cylinderKind === 'boss' ? 'hole' : 'contour',
        coercedFrom: 'cylinder',
      }
    }
    return {
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor', // cut floor = the cylinder base (bottomZ); see above
      side: sideFromCylinder(facts),
      coercedFrom: 'cylinder',
    }
  }
  // TODO(smart-selection): no other coercions are approved; fall back to a hint.
  return { ok: false, reason: hintFor(op, facts.kind) }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Entities this op consumes directly (priority order), per the matrix. */
export function consumableEntities(op: OperationType): ClickableEntity[] {
  return [...OPERATION_GEOMETRY[op].accepts]
}

/**
 * Lead help sentence for the B-rep model-FACE picking banner, per op. Co-located
 * with OPERATION_GEOMETRY so the user-facing wording stays in sync with what
 * each op actually consumes from a clicked face (see consumeEntity / consume-
 * Cylinder). Only thread_mill talks about a thread; every other op describes its
 * own semantics. Ops with no face-specific behaviour get a generic fallback.
 * Pure (string in / string out; no imports beyond OperationType). Wording is a
 * sensible default the user will review later.
 */
export function facePickBannerText(op: OperationType): string {
  switch (op) {
    case 'thread_mill':
      return "Click a cylindrical wall (bore or boss) to set the thread's kind, size and depth. Other faces are ignored."
    case 'contour_2d':
      return 'Click a cylindrical wall to profile it down to its base, or a planar face to set the top of cut. Other faces become boundary loops.'
    case 'pocket_2d':
    case 'adaptive_clearing_2d':
      return 'Click a boss to avoid it as an island, or a bore for the pocket boundary - both are cleared down to the wall base. A planar face sets the top of cut.'
    case 'face':
      return 'Click a planar face to face down to it, or a boss wall to avoid it as an island.'
    case 'drill':
    case 'bore':
      return 'Click a bore or hole to drill it to its depth.'
    default:
      // chamfer, engrave, vcarve, and all *_3d ops: no face-specific routing.
      return 'Click faces on the model to select or deselect them.'
  }
}

/**
 * Convenience wrapper: route a DERIVED cylinder feature (deriveBrepLayer's
 * CylinderFeature shape) through consumeEntity for the op being configured,
 * building the EntityFacts a clicked cylindrical wall carries (surfaceType 1 =
 * GeomAbs_Cylinder, diameter, top/bottom Z, bore/boss). Used by the modal's
 * cylinder-pick path so loopType / heightRole / side come from this single
 * matrix instead of hardcoded per-op logic. Pure; mirrors a real face click.
 */
export function consumeCylinder(
  op: OperationType,
  cyl: {
    geoId: string
    kind: 'bore' | 'boss'
    diameter: number
    topZ: number
    bottomZ: number
    faceIndex?: number
  },
): ConsumeResult {
  return consumeEntity(op, {
    kind: 'cylinder',
    geoId: cyl.geoId,
    faceIndex: cyl.faceIndex,
    surfaceType: 1,
    diameter: cyl.diameter,
    topZ: cyl.topZ,
    bottomZ: cyl.bottomZ,
    cylinderKind: cyl.kind,
  })
}

/**
 * Decide how `op` consumes a clicked entity described by `facts`.
 * - accepted entity  -> ok with deriveKind (+ heightRole / side as relevant)
 * - coercible entity -> ok with coercedFrom + the coerced deriveKind (+ side)
 * - otherwise        -> ok:false with a reason (the inline-hint text)
 */
export function consumeEntity(op: OperationType, facts: EntityFacts): ConsumeResult {
  const spec = OPERATION_GEOMETRY[op]

  if (spec.accepts.includes(facts.kind)) {
    return deriveAccepted(op, facts)
  }

  const coercion = spec.coerce?.[facts.kind]
  if (coercion) {
    return deriveCoerced(op, facts, coercion.to)
  }

  return { ok: false, reason: hintFor(op, facts.kind) }
}
