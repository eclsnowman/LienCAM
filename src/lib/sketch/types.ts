// Sketch document model (PLAN.md 3.1, ADR-0016).
//
// Everything here is PLAIN SERIALIZABLE DATA — a Sketch rides inside
// project.geometry[] and persists through the existing .camproject
// partialize middleware with no new storage mechanism. No classes, no
// functions, no planegcs types: the solver representation is a private
// concern of solver/gcsMapping.ts, so the persisted format cannot be
// broken by a solver-package upgrade.
//
// IDs are strings (crypto.randomUUID at creation). Constraints and
// dimensions reference entities by id; geometry coordinates live ON the
// entities (the document is always renderable without a solve — the
// solver only ever REWRITES these coordinates, it is not the source of
// truth between solves).

export interface Vec2 {
  x: number
  y: number
}

// ---- Entities ----------------------------------------------------------

// `construction` geometry participates fully in constraints but is NEVER
// baked to Loop2D (PLAN 3.4) — the bake layer filters on this flag, so it
// must exist on every entity from day one even though Stage 1 ignores it.
interface SketchEntityBase {
  id: string
  construction: boolean
  /** Durable display semantics for geometry copied from another layer/body.
   *  Project/Use emits a static, fixed copy; preserving that origin lets every
   *  sketch renderer distinguish reference geometry from native geometry
   *  without inferring intent from a generic fix constraint. */
  provenance?: 'projected'
  /** The first supported geometry edit has released Project/Use grounding.
   *  This durable lifecycle bit distinguishes a later user Fix from the
   *  unmarked automatic Fix stored by pre-migration project files. */
  projectionDetached?: true
  /** ASSOCIATIVE OFFSET (WO-1859): this entity is one piece of an offset that
   *  stays tied to the chain it was offset from. Present on EVERY piece of one
   *  offset result; all of them carry the same `id` and the same source
   *  description and differ only in `index`. UNSET = an ordinary entity, which
   *  is what every offset made before this field existed (and every offset
   *  whose link the operator broke) is — byte-identical, no migration.
   *
   *  The link is DURABLE DATA, not a constraint: nothing here enters the
   *  planegcs network, so the existing pin that an offset carries no
   *  constraint to its source still holds. The re-offset happens after the
   *  solve, in gcsMapping.entitiesFromSolved, from the SOLVED source geometry
   *  — which is why driving a source dimension carries the offset in the SAME
   *  solve rather than on the next interaction. Precedent: SketchTextEntity's
   *  `pathId`, an entity that stays tied to another entity and re-derives from
   *  live geometry with no solver change. */
  offsetLink?: SketchOffsetLink
  /** LIVE MODEL REFERENCE (WO-1864): this projected entity is one piece of a
   *  Project/Use of a model face, edge or vertex and follows that source when
   *  the model changes. The workbench regen pass re-resolves the stored
   *  source through the persistent-naming ids and rewrites the grounded
   *  coordinates, so everything constrained to it moves in the same solve.
   *  UNSET = a static copy: every projection made before this field existed,
   *  every CAM-layer projection, every pasted copy and every entity whose link
   *  the operator broke or whose geometry he edited. Plain data, no migration. */
  projectionLink?: SketchProjectionLink
}

/** Model source kinds a live projection may follow (projectUse.ts's model kinds). */
export type SketchProjectionSourceKind = 'model-face' | 'model-edge' | 'model-vertex'

/** The durable description of ONE projected piece's model source (WO-1864). */
export interface SketchProjectionLink {
  /** Shared by every piece of one Project commit. */
  id: string
  sourceKind: SketchProjectionSourceKind
  /** Body feature id the source was picked on (followed to its live descendant). */
  bodyId: string
  /** Persistent source id: a face/edge StableId, or the vertex key
   *  `vertex:<adjacent edge ids>@<point>` projectGeometry.ts mints. */
  stableId: string
  /** Operator-facing name of the source ("Edge (...)", "Model vertex"). */
  sourceLabel: string
  /** Which projected path this piece came from (face: 0 = outer, 1.. = holes;
   *  edge: 0). -1 for a projected point. */
  path: number
  /** This piece's position within its path (or point list). */
  piece: number
  /** How many pieces that path (or point list) committed. A re-resolved source that lifts to a
   *  different count has changed shape and cannot be written back piece-for-piece. */
  pathPieces: number
  /** Set when the last re-resolution could not find the source: the piece
   *  keeps its last resolved position and still solves and bakes. */
  unresolved?: true
}

/** One traversed source entity of an associative offset, in the SAME
 *  traversal the offset was built from (bake.ChainStep's public form by id).
 *  The stored traversal — not a fresh re-chain — is the link's memory: a
 *  source edit moves coordinates, it does not renumber which endpoint joins
 *  which, so replaying the recorded order is both cheaper and more stable
 *  than re-deriving it on every solve. */
export interface OffsetSourceRef {
  entityId: string
  /** True when the chain traverses that entity start -> end. */
  forward: boolean
}

/** The durable description of ONE associative offset result (WO-1859). */
export interface SketchOffsetLink {
  /** Shared by every entity of this one offset result. */
  id: string
  /** The source chain in traversal order. A single entry naming a CIRCLE is a
   *  standalone-circle source (circles never chain); any other single entry is
   *  a one-entity chain. */
  source: OffsetSourceRef[]
  /** Whether the source chain closes back on itself. */
  closed: boolean
  /** Offset distance in mm (> 0). */
  distance: number
  /** Which side of the traversal the offset lies on: +1 left, -1 right. */
  side: 1 | -1
  /** This entity's position in the offset's flat piece list. */
  index: number
  /** Piece count of each published loop, in order. The offset's SHAPE
   *  TOPOLOGY: a re-offset that produces a different partition (a corner
   *  flipping convex/concave, a neck collapsing into disjoint regions) cannot
   *  be written back onto this entity set in place, and the recompute says so
   *  in one console line instead of emitting a wrong shape. */
  loopSizes: number[]
}

export interface SketchPointEntity extends SketchEntityBase {
  kind: 'point'
  at: Vec2
}

// Lines own their endpoints (independent-endpoint model): two rectangle sides meeting
// at a corner are FOUR distinct points joined by coincident constraints,
// not a shared vertex. This keeps delete/trim local (removing a line
// never mutates a neighbor) and maps 1:1 to planegcs lines.
export interface SketchLineEntity extends SketchEntityBase {
  kind: 'line'
  start: Vec2
  end: Vec2
  // Durable chamfer identity (UI-50C-R1 major 1). Set ONLY by
  // chamferTool.chamferLines on the straight cut it inserts; never set
  // elsewhere, never cleared once created (persists through save/load --
  // migration is identity, the field is purely additive). Distinguishes a
  // genuine chamfer line -- which must NAMED-REFUSE the smart-dim d1xd2
  // pick when its theoretical corner cannot resolve -- from an ordinary
  // line whose endpoints simply happen to be coincident-joined on both
  // sides (e.g. a polyline segment sharing vertices with its neighbors),
  // which must keep plain distance behavior. Structural rig-shape alone
  // (theoreticalCorner.resolveChamferCorner) cannot make this distinction:
  // an ordinary polyline segment can accidentally match the same
  // coincident-joint shape a chamfer line has.
  chamferSetback?: true
}

// Arc sweeps COUNTERCLOCKWISE from startAngle to endAngle (radians),
// matching PlaneGCS convention. Bake converts to LoopSegment's
// center+radius+clockwise form; storing one canonical winding here keeps
// the solver mapping bijective (no clockwise ambiguity inside a solve).
export interface SketchArcEntity extends SketchEntityBase {
  kind: 'arc'
  center: Vec2
  radius: number
  startAngle: number
  endAngle: number
  /** Durable reconstruction data for a fillet touching an ellipse or
   * spline. PlaneGCS has no primitive for either native curve. */
  curveFillet?: {
    hostAId: string
    hostBId: string
    /** Construction point at the hosts' untrimmed theoretical intersection. */
    theoreticalPointId: string
    hostAKeep: 'forward' | 'backward'
    hostBKeep: 'forward' | 'backward'
    arcAAtStart: boolean
  }
}

export interface SketchCircleEntity extends SketchEntityBase {
  kind: 'circle'
  center: Vec2
  radius: number
}

// Ellipse (Tier 2a): center, major/minor radii, and the rotation of the
// MAJOR axis from +X (CCW radians). v1 is SOLVER-INERT (explicit fork, ADR
// 0003): the shape params (radii/rotation) do NOT participate in the
// constraint solve -- only the CENTER is a real solver point, so coincident
// / concentric / fix work on the center while the shape is carried through
// every solve unchanged. It still renders, snaps, tessellates and bakes
// like any other entity. The only addressable PointSite is 'center'.
export interface SketchEllipseEntity extends SketchEntityBase {
  kind: 'ellipse'
  center: Vec2
  majorRadius: number
  minorRadius: number
  /** Rotation of the major axis from +X, CCW radians. */
  rotation: number
}

// Elliptical arc (Tier 2a): an ellipse plus a CCW sweep in the ellipse's
// OWN eccentric-parameter space (startParam -> endParam, radians; same
// convention as ellipse.ts). Solver-inert exactly like the full ellipse;
// only 'center' is an addressable PointSite.
export interface SketchEllipticalArcEntity extends SketchEntityBase {
  kind: 'elliptical-arc'
  center: Vec2
  majorRadius: number
  minorRadius: number
  /** Rotation of the major axis from +X, CCW radians. */
  rotation: number
  /** CCW sweep start parameter (eccentric angle, radians). */
  startParam: number
  /** CCW sweep end parameter (eccentric angle, radians). */
  endParam: number
}

// Spline (basic interpolating Catmull-Rom, item C4). v1 is SOLVER-INERT
// (explicit fork, same doctrine as the ellipse): the curve interpolates the
// stored through-points verbatim and only the FIRST point participates in
// the constraint solve (addressable as the 'start' PointSite -- the single
// constrainable anchor). When the anchor is moved by a constraint the whole
// spline translates rigidly (shape carried verbatim). It still renders,
// snaps, tessellates and bakes (Catmull-Rom -> polyline) like any other
// entity. A later milestone makes every through-point constrainable.
export interface SketchSplineEntity extends SketchEntityBase {
  kind: 'spline'
  /** Through-points the curve passes through, in click order. points[0] is
   *  the single constrainable anchor (site 'start'). */
  points: Vec2[]
  /** Closed (wraps back to points[0]) vs open. v1 commits OPEN. */
  closed: boolean
  /** Original native through-points retained when a fillet trims the curve. */
  filletSourcePoints?: Vec2[]
  /** How `points` are read (WO-1861). Absent/'fit' = through-points (the
   *  curve passes through each); 'control' = the control polygon of a
   *  uniform cubic B-spline (clamped when open, periodic when closed) that
   *  pulls the curve toward the points. Same solver-inert doctrine either
   *  way: points[0] is the anchor and the rest are direct-edit. 'bezier'
   *  (WO-1862) = a chain of cubic bezier segments laid out anchor,
   *  out-handle, in-handle, anchor, ... (spline.ts); every anchor and handle
   *  is direct-edit. 'conic' (WO-1863) = one conic arc stored as start, apex,
   *  shoulder, end: the rational quadratic bezier over start/apex/end whose
   *  t = 0.5 point is the shoulder, rho of the way from the chord midpoint to
   *  the apex (rho is read back from the shoulder, spline.ts conicRho). */
  form?: 'fit' | 'control' | 'bezier' | 'conic'
  /** Bezier chains only (WO-1862): smooth[k] = anchor points[3k] is a SMOOTH
   *  joint whose two handles stay collinear through handle drags; false or
   *  absent = a corner, the handles move independently. The curve's own edit
   *  rule, not a constraint -- a spline tangent maps to no solver primitive. */
  smooth?: boolean[]
}

/** ON-PATH text alignment mode (spec T2). 'left'/'center'/'right' anchor the
 *  text to the curve start/middle/end; 'free' positions by `pathOffsetMm`. */
export type TextPathAlign = 'left' | 'center' | 'right' | 'free'

// Single-line ENGRAVING text (sketch text, item C3 part A). SOLVER-INERT,
// same doctrine as the spline/ellipse: the glyph geometry is carried
// VERBATIM (a string + cap height), tessellated to OPEN stroke polylines at
// render and bake time via a bundled public-domain Hershey single-stroke
// font (fonts/hersheySimplex.ts -> text.ts). Only the anchor `at` is
// solver-addressable (site 'start', the baseline-left origin); a constraint
// that moves the anchor translates the whole text rigidly. It NEVER pushes
// hundreds of line primitives into the solver. Empty/whitespace text or
// height <= 0 is degenerate (excluded from bake). `fontStyle` selects the
// face: 'single-line' (Hershey stroke font -> OPEN engraving strokes, part A)
// or 'outline' (a bundled OFL TTF face -> CLOSED filled-glyph contours + holes
// via three.js FontLoader, part B). Both stay solver-inert (anchor only).
export interface SketchTextEntity extends SketchEntityBase {
  kind: 'text'
  /** Anchor: the baseline-left origin of the first glyph (site 'start'). */
  at: Vec2
  /** The string to engrave (laid out left-to-right). */
  text: string
  /** Cap height in mm (the cap line maps to this height; > 0). */
  height: number
  /** Baseline rotation in radians, CCW about the anchor. Default 0. */
  rotation?: number
  /** Font family style. 'single-line' = Hershey stroke font (open engraving
   *  strokes); 'outline' = bundled OFL TTF face (closed filled-glyph contours
   *  + interior holes). */
  fontStyle: 'single-line' | 'outline'
  /** OUTLINE font family (registry key: a built-in or an imported face). Unset
   *  -> the default M+ face, so the default text path stays byte-identical.
   *  Ignored for 'single-line' (that face is always the Hershey stroke font).
   *  An unregistered family (project opened without the imported font) falls
   *  back to the default with a named, logged notice. */
  fontFamily?: string
  /** TEXT-ON-PATH ("text on curve"): the id of a sibling curve entity (line,
   *  arc, circle, ellipse, elliptical-arc, or spline) this text follows. UNSET
   *  = free text (anchor + rotation, byte-identical to before). When set, the
   *  horizontal local glyph layout is warped onto the path's arc-length at
   *  render + bake time, so the text FOLLOWS the path when it is edited/solved
   *  (the anchor `at` / `rotation` are then ignored). A pathId that no longer
   *  resolves to a usable curve falls back to the free layout + a named notice. */
  pathId?: string
  /** Start offset along the path (mm arc-length from the path start). Default 0.
   *  Only meaningful when `pathId` is set. */
  pathOffsetMm?: number
  /** Flip the text to the OTHER side of the path (and reverse its reading
   *  direction, glyphs upright not mirrored). Default false. pathId only. */
  pathFlip?: boolean
  /** ON-PATH alignment mode. Only meaningful when `pathId` is set.
   *  'left'/'center'/'right' anchor the text to the curve start/middle/end,
   *  with the start offset resolved from the path arc length and the
   *  UNTRIMMED string advance (whitespace counts -- spec T3) by ONE shared
   *  helper (textOnPath.effectiveStartOffsetMm) for render AND bake; 'free'
   *  positions by `pathOffsetMm`. OPTIONAL-ADDITIVE: ABSENT = legacy behavior
   *  (the `pathOffsetMm` start offset, i.e. 'free' semantics), so projects
   *  saved before the field existed load unchanged (no schema migration). */
  pathAlign?: TextPathAlign
  /** MIRROR the glyphs (flip-TEXT, spec T5b): each glyph is mirror-imaged and
   *  the string reads reversed -- unlike `pathFlip` (flip-SIDE: other side of
   *  the curve, glyphs upright). Applies to FREE and ON-PATH text alike. The
   *  x-negation happens ONCE in the LOCAL layout about the string's ADVANCE
   *  MIDPOINT (text.ts mirrorLocalLayoutX, consumed by render, bake AND pick),
   *  so mirrored text occupies the SAME [0, advance] span as unmirrored text.
   *  OPTIONAL-ADDITIVE: ABSENT = false = legacy behavior, so projects saved
   *  before the field existed load unchanged (no schema migration). */
  mirrored?: boolean
  /** LETTER SPACING (tracking): absolute mm ADDED between adjacent glyph
   *  advances, tightening (negative) or widening (positive) the font's natural
   *  spacing. Applies BETWEEN glyphs only -- N glyphs get (N-1) gaps, no
   *  trailing space after the last glyph -- and threads through the ONE local
   *  layout (text.ts / textOutline.ts), so render, bake, pick AND
   *  advance/alignment all inherit it. OPTIONAL-ADDITIVE: ABSENT = undefined =
   *  0 = the font's natural spacing, so projects saved before the field
   *  existed load unchanged (no schema migration). */
  letterSpacingMm?: number
}

// RIGID BLOCK (SKC-BLOCKS Stage 1). A block collapses a group of entities into
// ONE rigid object placed by a single solver anchor -- the generalization of the
// solver-inert ellipse/spline/text doctrine from "one carried shape" to "a
// carried nested sub-sketch". Only the `origin` anchor is a real planegcs point
// (2 DoF); the members NEVER enter the constraint network, so a block contributes
// exactly 2 DoF regardless of how many members it holds and is fully-defined the
// instant its origin is pinned.
//
// COORDINATE FRAME: members live in the block's OWN LOCAL frame. The world
// placement of any member coordinate is
//   world = origin + Rot(rotation) * scale * local
// (see blocks.ts blockMemberWorldEntities). v1 (Stage 1) commits rotation=0 and
// scale=1 (pure translation); rotation/scale are typed/inert like ellipse.rotation
// -- a later stage promotes them to editable direct values (Stage 2) and rotation
// to a solvable angle (Stage 5). Members are carried VERBATIM through every solve;
// entitiesFromSolved only updates `origin`.
//
// SINGLE-USE v1: the members are stored inline (no shared definition/instance
// registry). Nested blocks are forbidden by name at group time (a member is never
// itself a block in v1). Still plain-serializable data -- a block nests only the
// same entity/constraint/dimension types that already persist, so it rides the
// existing .camproject partialize middleware with no new storage mechanism
// (schema bump 12->13 is an additive identity claim; see projectMigrations.ts).
export interface SketchBlockEntity extends SketchEntityBase {
  kind: 'block'
  /** The block's solver anchor, sketch-plane mm. The ONE real gcs point. */
  origin: Vec2
  /** Rotation of the local frame about `origin`, CCW radians. Typed/inert v1
   *  (Stage 1 commits 0), like ellipse.rotation. */
  rotation: number
  /** Uniform scale of the local frame about `origin`. Typed/inert v1 (Stage 1
   *  commits 1); no free-drag scaling in v1. */
  scale: number
  /** Optional user label ("Bracket", "LogoDXF"). */
  name?: string
  /** SKC-BLOCKS Stage 5 -- DEFINITION/INSTANCE model. When present, this block
   *  is an INSTANCE: its members are the SHARED definition `sketch.blockDefs[defId]`,
   *  NOT the inline `members` below (which are empty for an instance). Placing the
   *  same block many times = many instances sharing ONE defId; editing the
   *  definition updates EVERY instance. ABSENT = the Stage-1 single-use inline
   *  block (members live in `members`), unchanged and backward-compatible: a
   *  project saved before Stage 5 has no defId anywhere and loads identically.
   *  Resolve members through blocks.ts `resolveBlockMembers(block, defs)` -- never
   *  read `members` directly, or an instance renders empty. */
  defId?: string
  /** The nested sub-sketch, in the block's OWN LOCAL coordinate frame. Members
   *  are carried verbatim through the solve; only `origin` is solved. For a
   *  def-backed INSTANCE (defId set) this is empty -- the members live on the
   *  shared BlockDefinition. */
  members: {
    entities: SketchEntity[]
    constraints: SketchConstraint[]
    dimensions: SketchDimension[]
  }
}

// SKC-BLOCKS Stage 5 -- a shared block DEFINITION. Its members live ONCE in the
// definition's OWN LOCAL frame; N instances (SketchBlockEntity with defId) each
// place that one member set with their own origin/rotation/scale. Editing a
// definition's members updates every instance that references it. Kept as plain
// serializable data (same entity/constraint/dimension types that already persist)
// so the def registry rides the existing .camproject partialize with no new
// storage mechanism (schema bump 13->14 is an additive identity claim).
export interface BlockDefinition {
  id: string
  /** Optional user label, shared by every instance's default name. */
  name?: string
  /** The definition's sub-sketch in its OWN LOCAL frame (canonical: no instance
   *  transform baked in). */
  members: {
    entities: SketchEntity[]
    constraints: SketchConstraint[]
    dimensions: SketchDimension[]
  }
}

export type SketchEntity =
  | SketchPointEntity
  | SketchLineEntity
  | SketchArcEntity
  | SketchCircleEntity
  | SketchEllipseEntity
  | SketchEllipticalArcEntity
  | SketchSplineEntity
  | SketchTextEntity
  | SketchBlockEntity

// ---- Point references --------------------------------------------------

// Constraints address a specific POINT SITE on an entity, not bare
// coordinates: 'start'/'end' for lines and arcs, 'center' for circles and
// arcs, 'self' for point entities. Sites (not coordinates) are what
// survive a solve — the coordinates they resolve to change every solve.
//
// 'focus1'/'focus2' exist ONLY on ellipse / elliptical-arc: the two focus
// points (ellipse.ts ellipseFoci — focus1 rides +long-axis, focus2 the
// opposite; a circle-degenerate ellipse collapses BOTH onto the center).
// Their positions DERIVE from center + inert shape params; the gcs mapping
// materializes them as solver points rigidly tied to the center (difference
// constraints), so dims/constraints on a focus behave exactly like center
// refs. ADDITIVE enum value: old saved documents never contain it, and a
// document that does simply resolves it — no migration required.
// Elliptical arcs and open splines expose 'start'/'end' trim endpoints.
// 'origin' exists ONLY on a block: its single solver anchor (SKC-BLOCKS Stage 1).
// ADDITIVE enum value like 'focus1'/'focus2' -- old saved documents never contain
// it and a document that does simply resolves it, no migration required.
// `cp<i>` exists ONLY on a control-point spline (WO-1861) or a bezier chain
// (WO-1862, anchors and handles alike): control point i as
// a solver site, named by a select-tool drag so one control point moves
// alone. gcsMapping materializes it only while a drag references it; stored
// constraints and dimensions never carry one.
export type PointSite =
  | 'self' | 'start' | 'end' | 'center' | 'focus1' | 'focus2' | 'origin' | `cp${number}`

export interface PointRef {
  entityId: string
  site: PointSite
}

// ---- Constraints -------------------------------------------------------

// v1 constraint set (PLAN 3.5). Each variant lists exactly the references
// it needs — no generic { refs: string[] } bag — so an invalid target
// (e.g. parallel on a circle) is unrepresentable or rejected loudly in
// the mapping layer rather than silently producing a wrong gcs network.

interface SketchConstraintBase {
  id: string
}

/** Two point sites occupy the same location. */
export interface CoincidentConstraint extends SketchConstraintBase {
  kind: 'coincident'
  a: PointRef
  b: PointRef
}

/** Two circles/arcs share a center. */
export interface ConcentricConstraint extends SketchConstraintBase {
  kind: 'concentric'
  a: string // circle or arc entity id
  b: string // circle or arc entity id
}

export interface ParallelConstraint extends SketchConstraintBase {
  kind: 'parallel'
  a: string // line entity id
  b: string // line entity id
}

export interface PerpendicularConstraint extends SketchConstraintBase {
  kind: 'perpendicular'
  a: string // line entity id
  b: string // line entity id
}

// Two lines lie on the SAME infinite line (same direction AND zero offset).
// planegcs has no dedicated collinear primitive, so the mapping layer
// expresses it as the documented composition parallel + point-on-line
// (ADR-0003, explicit — no silent fallback): see gcsMapping.ts. Removes 2
// DoF (one for direction via parallel, one for offset via point-on-line).
export interface CollinearConstraint extends SketchConstraintBase {
  kind: 'collinear'
  a: string // line entity id
  b: string // line entity id
}

// Horizontal/vertical apply to a line OR to a pair of points.
// Exactly one of `line` / `points` must be set; the
// mapping layer fails loud otherwise instead of guessing.
export interface HorizontalConstraint extends SketchConstraintBase {
  kind: 'horizontal'
  line?: string
  points?: [PointRef, PointRef]
}

export interface VerticalConstraint extends SketchConstraintBase {
  kind: 'vertical'
  line?: string
  points?: [PointRef, PointRef]
}

/** Line-circle, line-arc, circle-circle, arc-arc, circle-arc tangency. */
export interface TangentConstraint extends SketchConstraintBase {
  kind: 'tangent'
  a: string
  b: string
}

// Equal length (line+line) or equal radius (circle/arc + circle/arc).
// Which meaning applies is derived from the entity kinds; mixing a line
// with a circle is rejected in the mapping layer.
export interface EqualConstraint extends SketchConstraintBase {
  kind: 'equal'
  a: string
  b: string
}

/** A point site sits at the midpoint of a line. */
export interface MidpointConstraint extends SketchConstraintBase {
  kind: 'midpoint'
  point: PointRef
  line: string
}

/** Two point sites mirror each other across an axis line. */
export interface SymmetricConstraint extends SketchConstraintBase {
  kind: 'symmetric'
  a: PointRef
  b: PointRef
  axis: string // line entity id
}

// Ground a point site or a whole entity (every coordinate it owns).
// Exactly one of `point` / `entityId` must be set. Grounding removes the
// target's parameters from the solve instead of adding equations — the
// difference matters for DoF accounting and conflict diagnosis.
export interface FixConstraint extends SketchConstraintBase {
  kind: 'fix'
  point?: PointRef
  entityId?: string
  /** Automatic whole-entity grounding emitted by Project/Use. */
  projectionGrounding?: true
}

/** A point site lies on a curve (line, circle, or arc). */
export interface PointOnObjectConstraint extends SketchConstraintBase {
  kind: 'point_on_object'
  point: PointRef
  object: string
}

/** WO-1866: two curves meeting at a shared end are held smooth across the
 *  joint. `a` is an OPEN control-point spline's 'start' or 'end'; `b` is the
 *  neighbour's joint end: a line or arc 'start'/'end', or (G1 only) another
 *  control-point spline's end. The constraint carries the joint coincidence
 *  itself (a separate coincident on the same two sites is subsumed by the
 *  mapping, never double-counted).
 *   - 'continuity_g1': tangent continuous -- the spline leaves the joint along
 *     the neighbour's own direction (never a cusp).
 *   - 'continuity_g2': curvature continuous -- additionally the spline's end
 *     curvature equals the neighbour's (0 for a line, 1/r toward the centre
 *     for an arc).
 *  Composed in gcsMapping from existing planegcs point/line equations on the
 *  spline's end control points; a spline under one is edited locally (types
 *  doctrine above: its rigid-translation rule is suspended). */
export interface ContinuityConstraint extends SketchConstraintBase {
  kind: 'continuity_g1' | 'continuity_g2'
  a: PointRef
  b: PointRef
}

/** WO-1865: the model edge a pierce follows -- the same stored identity a WO-1864 live
 *  projection carries (body feature id followed to its live descendant + persistent edge id). */
export interface SketchPierceSource {
  bodyId: string
  /** Persistent edge StableId. */
  stableId: string
  /** Operator-facing name of the edge ("Edge (...)"). */
  sourceLabel: string
}

/** WO-1865: a point site sits where a 3D model edge crosses the sketch plane. `at` is that
 *  crossing in sketch-local mm as last resolved; the workbench regen pass re-resolves the edge
 *  and rewrites `at` before the solve, so the point (and everything tied to it) follows the model
 *  in the same solve. Mapped as two hard coordinate equations: removes 2 DoF like any other
 *  point placement. When the edge no longer crosses the plane (or is gone) `unresolved` is set
 *  and `at` keeps its last value -- the point stays where it last was, the sketch still solves.
 *  A straight edge is taken as its infinite line (a sketch on an offset plane still pierces);
 *  a curved edge must cross within its own span. */
export interface PierceConstraint extends SketchConstraintBase {
  kind: 'pierce'
  point: PointRef
  at: Vec2
  source: SketchPierceSource
  /** Set (to the reason: 'parallel' | 'in-plane' | 'no-crossing' | a lost-edge reason) when the
   *  last re-resolution found no crossing; `at` then holds the last crossing found. */
  unresolved?: string
}

export type SketchConstraint =
  | CoincidentConstraint
  | ConcentricConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | CollinearConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | TangentConstraint
  | EqualConstraint
  | MidpointConstraint
  | SymmetricConstraint
  | FixConstraint
  | PointOnObjectConstraint
  | ContinuityConstraint
  | PierceConstraint

export type SketchConstraintKind = SketchConstraint['kind']

// ---- Dimensions --------------------------------------------------------

// Dimensions are kept separate from constraints (distinct array) because
// they carry a user-editable VALUE and a driving/reference toggle — the
// smart-dimension UI and the "set value" store action operate only on
// this array. `driving: false` (reference dimension) is NEVER pushed to
// the solver (a free value param lets the solver trade geometry against
// it — measured); its `value` is re-measured from the solved geometry
// after every solve and displayed parenthesized.

interface SketchDimensionBase {
  id: string
  /** Driving dims constrain geometry; reference dims only report. */
  driving: boolean
  /** mm for distances/radii/diameters, RADIANS for angles. */
  value: number
  /** Where the dimension's value label sits (sketch-plane mm). Set by the
   *  Stage 4 placement click; when absent the renderer computes a default
   *  beside the measured geometry. Pure display data — never solved. */
  labelAnchor?: Vec2
  /** "sketch-dim equations wiring" hitlist item: the raw "=..." source text the value editor was
   *  last committed with (leading "=" included), or absent for a plain typed number. Purely a
   *  redisplay convenience -- reopening the editor shows the equation again instead of just its
   *  resolved number (src/lib/sketch/dimExpr.ts resolves it; both hosts' commitDimensionValue write
   *  it alongside `value`, ports.ts SketcherOverlaysPort#commitDimensionValue). Cleared whenever the
   *  dimension is committed with a plain number. ADDITIVE: absent on every pre-existing saved
   *  dimension and on every non-driving/measured commit -- never required, never migrated. */
  expression?: string
}

/** Euclidean distance between two point sites. Line length = distance
 *  between the line's own endpoints (the smart-dim tool resolves that). */
export interface DistanceDimension extends SketchDimensionBase {
  kind: 'distance'
  a: PointRef
  b: PointRef
}

export interface DistanceXDimension extends SketchDimensionBase {
  kind: 'distanceX'
  a: PointRef
  b: PointRef
}

export interface DistanceYDimension extends SketchDimensionBase {
  kind: 'distanceY'
  a: PointRef
  b: PointRef
}

/** ORDINATE (baseline) dimension, WO-1867: one point's offset from a shared
 *  DATUM point, measured along a world axis. A hole pattern on a plate is
 *  dimensioned this way in a real drawing -- every hole from one corner, not
 *  chained -- so the datum is explicit in the document instead of being lost
 *  in a fan of unrelated distanceX/distanceY dimensions.
 *
 *  Mechanically ONE ordinate is the same signed component a distanceX /
 *  distanceY measures (planegcs 'difference', origin -> point, NOT abs'd), so
 *  a driving ordinate removes exactly one degree of freedom like any other
 *  linear dimension. What the kind adds over a bare distanceX is the shared
 *  `origin`: every ordinate of a stack names the SAME datum ref, which is what
 *  lets the labels line up on one witness line (sketchLayer.dimensionDisplay /
 *  dimPlacement.ordinateStackAnchor derive that line from the ORIGIN alone, so
 *  the stack is common by construction and never needs a sibling lookup) and
 *  what makes a datum move carry the whole stack in one solve.
 *
 *  `value` is SIGNED (point[axis] - origin[axis]), like distanceX: a point to
 *  the left of / below its datum reads negative, and the label shows that
 *  honestly rather than a magnitude that disagrees with the geometry. The
 *  operand order is FIXED (origin first), so there is no normalize-positive
 *  reordering to hide the sign behind. */
export interface OrdinateDimension extends SketchDimensionBase {
  kind: 'ordinate'
  /** The stack's shared DATUM point site. */
  origin: PointRef
  /** The measured point site. */
  point: PointRef
  /** World axis the offset is measured along. */
  axis: 'x' | 'y'
}

/** Perpendicular distance from a point site to a line (point+line smart
 *  dim, and line+line when the lines are parallel).
 *  Maps to planegcs p2l_distance (distance to the INFINITE line). */
export interface DistancePLDimension extends SketchDimensionBase {
  kind: 'distancePL'
  point: PointRef
  line: string // line entity id
}

/** Angle between two lines (radians). */
export interface AngleDimension extends SketchDimensionBase {
  kind: 'angle'
  a: string // line entity id
  b: string // line entity id
  /** SKC-58B far/obtuse-sector orientation. When true, operand B's direction
   *  is REVERSED (end->start) in the solver constraint, so the stored signed
   *  `value` (a directed angle for the reversed operand, e.g. -145deg for a
   *  35deg line's obtuse pick) is ALREADY satisfied by the current geometry
   *  -- committing the obtuse sector no longer drags the line to the
   *  supplement (Operator's no-motion bar). Absent/false = near sector, operands
   *  in start->end order (the pre-SKC-58B behavior, unchanged). The LABEL is
   *  always the positive sweep (formatDimensionValue abs's the value), so the
   *  reversal is invisible to the readout. */
  reverseB?: boolean
}

/** THREE-POINT angle (WO-1868): the angle at `vertex` between the directions
 *  vertex->a and vertex->b, for ANY three addressable point sites -- the legs
 *  need not be whole line entities. An arc's INCLUDED angle is this same kind at
 *  the arc's (center, start, end) sites, so one mechanism serves both.
 *
 *  `value` is the SIGNED directed angle from leg A to leg B (radians), the same
 *  convention as AngleDimension, and `reverseB` carries the same SKC-58B far
 *  sector rule: when true, leg B's direction is reversed so the stored
 *  (obtuse-reading) value is ALREADY satisfied by the drawn geometry -- picking
 *  the far sector moves nothing. The label is always |value|. */
export interface Angle3Dimension extends SketchDimensionBase {
  kind: 'angle3'
  vertex: PointRef
  a: PointRef
  b: PointRef
  reverseB?: boolean
  /** An arc's INCLUDED angle: `value` is then the counter-clockwise sweep from
   *  leg A to leg B in (0, 2pi] (a 270-degree arc reads 270), never folded into
   *  the near/far pair. The solver constraint is periodic, so the same directed
   *  equation drives it. reverseB is never set together with ccw. */
  ccw?: boolean
}

export interface RadiusDimension extends SketchDimensionBase {
  kind: 'radius'
  entityId: string // circle or arc
}

export interface DiameterDimension extends SketchDimensionBase {
  kind: 'diameter'
  entityId: string // circle or arc
}

/** Length along a true circular arc. The value is radius times the positive
 *  counter-clockwise sweep from startAngle to endAngle. Full circles and
 *  elliptical arcs intentionally use different entity kinds and cannot be
 *  targeted by this dimension. */
export interface ArcLengthDimension extends SketchDimensionBase {
  kind: 'arcLength'
  entityId: string // arc only
}

// Ellipse MAJOR / MINOR radius dimensions (Tier 2a). The ellipse is
// SOLVER-INERT (see SketchEllipseEntity), so these are an INERT DIRECT-EDIT
// affordance, NOT a planegcs constraint (explicit fork, ADR-0003 -- documented
// in gcsMapping.applyInertEllipseDims and mapDimension). measureDimension
// reports the current major/minor radius; a DRIVING dim's value directly
// rewrites the owning ellipse's radius before each solve (an inert entity is
// manipulated directly, exactly like the ellipse's verbatim shape carry). A
// reference (driving:false) dim only reports, re-measured after every solve.
export interface MajorRadiusDimension extends SketchDimensionBase {
  kind: 'majorRadius'
  entityId: string // ellipse or elliptical-arc
}

export interface MinorRadiusDimension extends SketchDimensionBase {
  kind: 'minorRadius'
  entityId: string // ellipse or elliptical-arc
}

// FOCUS-TO-FOCUS ellipse dimension (Tier 2a). Value = the inter-focal distance
// 2c (distance between the ellipse's two foci). Like majorRadius/minorRadius it
// is an INERT DIRECT-EDIT affordance, NOT a planegcs constraint (the ellipse is
// SOLVER-INERT and planegcs has no ellipse primitive -- the foci are rigidly
// center-derived). Editing 2c DEFINES the ellipse: with c = value/2 and b = the
// current SHORTER semi-axis, the foci-bearing (longer) semi-axis becomes
// a = sqrt(c^2 + b^2) (gcsMapping.applyInertEllipseDims via
// ellipse.ellipseRadiiForFocalDistance). measureDimension reports the current
// 2c; a non-positive / non-finite edit is rejected loudly (a focus-to-focus dim
// needs two DISTINCT foci -- c = 0 collapses the ellipse to a circle).
export interface FocusDistanceDimension extends SketchDimensionBase {
  kind: 'focusDistance'
  entityId: string // ellipse or elliptical-arc
}

// Chamfer d1xd2 setback pair (UI-50C, split from UI-50B by preflight).
// DRIVABLE since WO-1858: planegcs has no chamfer-distance constraint, so a
// driving d1xd2 is expressed as a COMPOUND mapping -- two p2p_distance
// primitives from the SKC-41A theoretical-corner phantom to the chamfer
// line's two endpoints (gcsMapping.mapDimension, which returns a LIST of
// primitives for exactly this reason). Both halves are independently
// editable and each removes one degree of freedom; a reference d1xd2 still
// only reports, re-measured after every solve.
//
// entityId is the CHAMFER LINE (the straight cut chamferTool.ts inserts).
// `value` (base) carries d1 = distance from the theoretical corner to the
// chamfer line's own START; `d2` carries d2 = distance from the corner to
// the line's own END -- a fixed, documented convention (the chamfer line's
// endpoint order), not a "host A / host B" label. Both are re-measured
// after every solve like any other reference dimension
// (theoreticalCorner.measureChamferSetbacks). A chamfer line with no
// resolvable theoretical corner (hand-drawn, or a file predating SKC-41A)
// or with parallel current legs measures null (dimTool "missing entity"
// convention) rather than guessing a virtual intersection.
export interface ChamferSetbackDimension extends SketchDimensionBase {
  kind: 'd1xd2'
  entityId: string // the chamfer line
  d2: number
}

export type SketchDimension =
  | DistanceDimension
  | DistanceXDimension
  | DistanceYDimension
  | OrdinateDimension
  | DistancePLDimension
  | AngleDimension
  | Angle3Dimension
  | RadiusDimension
  | DiameterDimension
  | ArcLengthDimension
  | MajorRadiusDimension
  | MinorRadiusDimension
  | FocusDistanceDimension
  | ChamferSetbackDimension

export type SketchDimensionKind = SketchDimension['kind']

// ---- Solve status ------------------------------------------------------

// Conflicting/redundant sets are reported BY ID (fail loud, ADR 0003):
// the over-defined UX names the offending constraints/dimensions so the
// user can delete one — they are never silently dropped by the solver
// layer. dof === 0 with empty conflicts = "fully defined" (black);
// dof > 0 = under-defined (blue); non-empty conflicting = red.
export interface SolveStatus {
  dof: number
  conflicting: string[]
  redundant: string[]
  /** EXACT per-entity definition state (Stage 4): ids of entities whose
   *  solver parameters are ALL determined — measured by the fix-probe
   *  diagnosis in gcsMapping (planegcs exposes no per-parameter freedom
   *  API), never inferred from whole-sketch DoF. Undefined on statuses
   *  persisted before this field existed AND on statuses where the
   *  diagnosis could not run; the render layer then falls back to the
   *  documented whole-sketch approximation. */
  fullyDefinedEntities?: string[]
  /** FAIL-LOUD marker (ADR 0003): present (true) ONLY on a status produced
   *  by a FAILED solve (mapping error / non-convergence / conflict —
   *  every ok:false SketchSolveOutcome). On such a status `dof` is NOT a
   *  definition verdict (the mapping-failure path never even reached the
   *  solver and reports a placeholder dof of 0), so the UI must NEVER
   *  render "fully defined" / "N DoF" from it — a false green here is a
   *  safety signal lie. Optional-additive like fullyDefinedEntities:
   *  absent on every successful solve and on statuses persisted before
   *  the field existed (no schema migration needed). */
  solveFailed?: true
  /** Human-readable failure detail carried alongside `solveFailed` for the
   *  failed-solve chip tooltip. Only present when solveFailed is set. */
  failureMessage?: string
}

// ---- Sketch document ---------------------------------------------------

export interface Sketch {
  id: string
  /** Owning Layer2D — the layer whose loops this sketch bakes to/lifted from. */
  layerId: string
  /** WO-1377: the ImportedGeometry this sketch was opened from/for, resolved
   *  by every real open path (openSketchForLayer's own geoId-first lookup,
   *  or the fixed SKETCH_CONTAINER_ID a fresh "New sketch"/tool-click document
   *  always lands on). layerId alone is not unique across geometries — two
   *  imports can both produce layer id "color-0" — so bake must never fall
   *  back to a first-match-by-layerId search once the owner is known.
   *  Undefined only for a Sketch built outside the store's real open paths
   *  (older persisted documents, ad-hoc test fixtures); bake falls back to
   *  the old first-match search in that case, same as before this field
   *  existed. */
  ownerGeometryId?: string
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions: SketchDimension[]
  /** SKC-BLOCKS Stage 5 -- shared block DEFINITIONS keyed by def id. A block
   *  entity with `defId` (an INSTANCE) resolves its members from here. ABSENT /
   *  empty on any project that never defined a reusable block (all Stage 1-4
   *  blocks are single-use inline), so pre-Stage-5 files load unchanged. */
  blockDefs?: Record<string, BlockDefinition>
  /** Last solve result; persisted so re-opening a sketch shows definition
   *  state immediately, before the first live solve returns.
   *  null = NEVER SOLVED (e.g. a freshly lifted import): definition state is
   *  UNKNOWN — the UI must not show "fully defined" or gate edits on it;
   *  opening the document triggers a real solve that fills it in. */
  solveStatus: SolveStatus | null
}
