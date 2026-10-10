// Feature DAG store (DOC lane, WO DOC-2, WP2.1).
//
// Implements docs/3d-modeling-plan.md §3.4 "Document model & regeneration":
// nodes = sketches/datums/features/bodies/imports/parameters; edges =
// "consumes" (a node's upstream dependencies), including a feature's
// element-set references by StableId (resolved through DOC-1's ElementMap on
// regeneration). Zip persistence (DOC-3), the chunked/cancellable
// regeneration scheduler (DOC-5), and the parameters table (DOC-4) are out of
// scope -- this module builds the seams those land on: a plain-data node
// store, a deterministic derived order, and an honest per-node resolve pass.
//
// Determinism (grep-provable, same invariant as stable-id.ts's fragment
// comparator chain): the DAG's derived topological order is a pure function
// of its nodes + edges. Building the identical graph via any sequence of
// insert/setConsumes calls must produce the identical topoOrder() -- ties
// among independent nodes (no consumes relationship) break on the node's own
// stable id (compareIds), NEVER on insertion order, Map iteration order, or
// array/index position. There is no counter anywhere in this file.
//
// Pure TypeScript, zero kernel dependency: only plain-data types from
// geom-service.ts and DOC-1's ElementMap/Resolution machinery are imported --
// nothing here ever touches a BodyHandle, TessBuffers, or wasm/worker.

import type { Diag, StableId, SubshapeType } from '../geom/geom-service'
import { compareIds } from './stable-id'
import type { ElementMap, ReferenceKind, Resolution } from './element-map'
// WO SKC-15: ids only, zero geometry -- see genesis.ts's header for why the PlaneFrames live in the
// workbench layer instead (src/sketch3d imports from src/doc, so the reverse edge would be a cycle).
import {
  GENESIS_NODE_IDS, GenesisIngressError, GenesisNodeError, GenesisShapeError,
  isCanonicalGenesisShape, isGenesisNodeId, leadingGenesisCount,
} from './genesis'

// WO UI-24-R2 (schema-derived loader validation): the kind union is DERIVED from this runtime
// tuple, not declared as a parallel hand-written string-literal union -- a validator (or any other
// consumer) that imports DAG_NODE_KINDS for its own allowlist can never drift from DagNodeKind
// itself, because there is only one declaration to edit when a new kind is added.
export const DAG_NODE_KINDS = ['sketch', 'datum', 'feature', 'body', 'import', 'meshImport', 'parameter'] as const
export type DagNodeKind = (typeof DAG_NODE_KINDS)[number]

/** A node's reference to an upstream element-set, resolved via ElementMap on regen. */
export interface FeatureRef {
  id: StableId
  kind: ReferenceKind
  /** Semantic input slot for multi-reference features (point0, axisLine, supportFace, ...). */
  role?: string
  /** Explicit topology class; legacy refs omit it and retain their prior kind semantics. */
  elementType?: SubshapeType
}

/** Caller-supplied shape for inserting a new node (see FeatureDag.insertNode). */
export interface DagNodeInput {
  /** Stable, caller-assigned node id (e.g. featureId "F12", sketch "S3", parameter "P_width"). Never minted by the DAG itself. */
  id: string
  kind: DagNodeKind
  /** Upstream node ids this node structurally depends on (the "consumes" edges). */
  consumes?: string[]
  /** Element-set references by StableId this node's evaluation resolves through ElementMap. */
  refs?: FeatureRef[]
  /** Opaque plain-JSON data the owning feature type needs to replay (params, sizes, ...). Never geometry. */
  payload?: Record<string, unknown>
}

/** Full persisted state of one node, including regen-derived fields. */
export interface DagNodeSnapshot {
  id: string
  kind: DagNodeKind
  consumes: string[]
  refs: FeatureRef[]
  payload: Record<string, unknown>
  /** true once any of this node's refs resolved 'lost' on the most recent regenerate() pass. */
  degraded: boolean
  /** structured diagnostics from the most recent regenerate() pass (empty if never regenerated, or fully healthy). */
  diagnostics: Diag[]
  /** last NON-lost binding per ref id -- retained across a 'lost' resolution so downstream evaluation has "the last-good body" to use (plan §3.4 regeneration rule) instead of nothing. */
  lastGoodBoundTo: Record<StableId, StableId[]>
  /** WO UI-6 (BK-39): this node's OWN suppress flag -- "root" suppression, distinct from the CASCADE suppression a downstream consumer inherits (see FeatureDag.isEffectivelySuppressed). Additive/optional per the migration framework's rules (ADR-0027): a node restored from a pre-UI-6 document has no serialized `suppressed` field and defaults to false (cloneSnapshot), so no schemaVersion bump is needed. */
  suppressed: boolean
  /** WO UI-53: persisted display-only visibility for sketch outlines. Additive/optional under ADR-0027: documents written before UI-53 omit `hidden` and cloneSnapshot defaults them to visible, so no schemaVersion bump is needed. This flag never participates in DAG cascade or regeneration. */
  hidden: boolean
}

/**
 * WO UI-7 (BK-40): document-level rollback marker position. Distinct from
 * (and NEVER folded into) FeatureDag's serialize()/restore() -- that surface
 * is a frozen "pure function of nodes+edges, insertion-order-independent"
 * invariant (dag.test.ts's forward/reversed golden tests), whereas a
 * rollback timeline is intentionally insertion-order DEPENDENT (that is the
 * whole point of a marker position). See featureOrder()/restoreRollbackState
 * below and src/doc/persist/format.ts's separate `document.rollback` field.
 *  - 'end'   : marker after the LAST feature (default -- nothing rolled back).
 *  - 'start' : marker before the FIRST feature (every feature rolled back).
 *  - 'after' : marker immediately after `nodeId` in featureOrder() -- every
 *              feature later in featureOrder() is rolled back; `nodeId`
 *              itself is not.
 */
export type RollbackMarker = { kind: 'end' } | { kind: 'start' } | { kind: 'after'; nodeId: string }

/**
 * Index into `order` (a snapshot of FeatureDag.featureOrder()) the marker
 * resolves to -- the position a node inserted "at the marker" should occupy
 * (0..order.length). Pure function of the two inputs; shared by
 * InsertAtMarkerCommand (commands.ts) and FeatureTree's marker-row placement
 * so there is exactly one definition of "where the marker sits" among a
 * feature list, never two parallel computations.
 */
export function markerInsertIndex(order: readonly string[], marker: RollbackMarker): number {
  // WO SKC-15: 'start' means "before the first FEATURE", which is now below the genesis rows, not
  // above them. Keeping the skip HERE (rather than in each caller) preserves this function's whole
  // reason to exist: InsertAtMarkerCommand and FeatureTree's marker-row placement read one
  // definition of "where the marker sits", so the rendered marker and the insert slot cannot drift.
  if (marker.kind === 'start') return leadingGenesisCount(order)
  if (marker.kind === 'end') return order.length
  const idx = order.indexOf(marker.nodeId)
  return idx === -1 ? order.length : idx + 1
}

export type DagDiagCode = 'DAG_CYCLE' | 'REORDER_BLOCKED'

/** DOC-local structured diagnostic (geom-service.ts's DiagCode is frozen and cannot grow a DAG-specific code -- same pattern as stable-id.ts's FragmentDiag). */
export interface DagDiag {
  code: DagDiagCode
  severity: 'error'
  params: Record<string, string>
}

/**
 * Structured refusal thrown when a proposed edge (insertNode/setConsumes)
 * would create a cycle. Never silently drops the edge, never falls back to a
 * partial graph -- fail loud, same ethos as stable-id.ts's FragmentTieError.
 */
export class DagCycleError extends Error {
  readonly diagnostic: DagDiag
  constructor(diagnostic: DagDiag) {
    super(
      `FeatureDag: refusing edge -- '${diagnostic.params.consumer}' consuming ` +
        `'${diagnostic.params.producer}' would create a cycle (DAG_CYCLE).`,
    )
    this.name = 'DagCycleError'
    this.diagnostic = diagnostic
  }
}

/**
 * WO UI-9 (BK-41): the outcome of a refused reorder -- which OTHER node
 * blocks the move, and whether the move was refused because it would place
 * the dragged node ABOVE a producer it consumes, or BELOW a consumer of its
 * own output. Returned (never thrown) by the read-only checkReorder query so
 * a live drag-over indicator can call it on every hovered slot; reorderNode
 * itself throws ReorderBlockedError carrying the same shape.
 */
export interface ReorderBlocked {
  blockingId: string
  direction: 'above' | 'below'
  /**
   * WO SKC-15: WHY the move was refused. 'dependency' (the default, and every pre-SKC-15 refusal)
   * means the producer-before-consumer invariant. 'genesis' means Origin / a base datum plane was
   * dragged, or a feature was dragged above them -- a different sentence, so callers do not have
   * to invent a dependency that does not exist.
   */
  reason?: 'dependency' | 'genesis'
}

/**
 * Structured refusal thrown by reorderNode when the requested position would
 * violate the "a consumer never sits above the producer it depends on"
 * invariant featureOrder() (unlike topoOrder(), a pure function of nodes+
 * edges) does not enforce structurally on its own -- fail loud, same ethos as
 * DagCycleError above. `message` is a plain, UI-ready sentence naming the
 * blocking feature by id (callers wanting a display NAME instead of a raw id
 * build their own message from `diagnostic.params` -- this class only
 * guarantees an id-based fallback is always present).
 */
export class ReorderBlockedError extends Error {
  readonly diagnostic: DagDiag & { code: 'REORDER_BLOCKED'; params: { movedId: string; blockingId: string; direction: 'above' | 'below' } }
  constructor(movedId: string, blocked: ReorderBlocked) {
    super(
      blocked.reason === 'genesis'
        ? `FeatureDag: refusing reorder -- Origin and the XY/XZ/YZ base planes are permanent document ` +
          `fixtures: '${movedId}' cannot move, and nothing may move above them.`
        : blocked.direction === 'above'
          ? `FeatureDag: refusing reorder -- '${movedId}' uses '${blocked.blockingId}' -- it cannot move above it.`
          : `FeatureDag: refusing reorder -- '${blocked.blockingId}' uses '${movedId}' -- it cannot move below it.`,
    )
    this.name = 'ReorderBlockedError'
    this.diagnostic = {
      code: 'REORDER_BLOCKED',
      severity: 'error',
      params: { movedId, blockingId: blocked.blockingId, direction: blocked.direction },
    }
  }
}

function cloneRefs(refs: FeatureRef[]): FeatureRef[] {
  return refs.map((r) => ({
    id: r.id,
    kind: r.kind,
    ...(r.role !== undefined ? { role: r.role } : {}),
    ...(r.elementType !== undefined ? { elementType: r.elementType } : {}),
  }))
}

function cloneSnapshot(n: DagNodeSnapshot): DagNodeSnapshot {
  return {
    id: n.id,
    kind: n.kind,
    consumes: [...n.consumes],
    refs: cloneRefs(n.refs),
    payload: { ...n.payload },
    degraded: n.degraded,
    diagnostics: n.diagnostics.map((d) => ({ ...d, params: d.params ? { ...d.params } : d.params })),
    lastGoodBoundTo: Object.fromEntries(Object.entries(n.lastGoodBoundTo).map(([k, v]) => [k, [...v]])),
    // Defaulted, not copied verbatim: a snapshot parsed from a pre-UI-6
    // persisted document has no `suppressed` field at all (see restore()),
    // so `n.suppressed` is `undefined` there -- default it to false rather
    // than let `undefined` leak into a boolean-typed field.
    suppressed: n.suppressed ?? false,
    // Same additive-field rule as suppressed: older documents do not carry
    // this key and restore as visible.
    hidden: n.hidden ?? false,
  }
}

function freshNode(input: DagNodeInput): DagNodeSnapshot {
  return {
    id: input.id,
    kind: input.kind,
    consumes: [...(input.consumes ?? [])],
    refs: cloneRefs(input.refs ?? []),
    payload: { ...(input.payload ?? {}) },
    degraded: false,
    diagnostics: [],
    lastGoodBoundTo: {},
    suppressed: false,
    hidden: false,
  }
}

function sortRecord(rec: Record<StableId, StableId[]>): Record<StableId, StableId[]> {
  const out: Record<StableId, StableId[]> = {}
  for (const key of Object.keys(rec).sort(compareIds)) out[key] = [...rec[key]].sort(compareIds)
  return out
}

// Recursively sorts object keys so serialize() honors its documented
// "byte-identical string" contract for the two fields it emits with
// data-shaped (insertion-order) keys: a node's `payload` and each
// diagnostic's `params` (both Record<string, ...> with arbitrary keys).
// Everything else serialize() emits is already order-normalized -- consumes
// and refs are sorted, lastGoodBoundTo goes through sortRecord, and the node's
// own keys are written in a fixed literal order. The zip persistence archive
// canonicalizes ALL key order on save (createDocumentArchive -> stableStringify
// -> canonicalize), so before this fix the SAME document serialized before vs
// after a save/load round trip diverged ONLY in payload key order (INT-14
// item 4: `{"opType":"extrude","height":5}` vs `{"height":5,"opType":"extrude"}`).
// Sorting these keys here makes serialize() a pure function of the DAG's
// semantic content, so before === after byte-for-byte. Default lexicographic
// sort matches persist/stable-json's canonicalize exactly (same Object.keys().sort()),
// so the two layers cannot drift. Array order is PRESERVED (arrays are
// semantically ordered); non-finite/undefined values are left to the outer
// JSON.stringify exactly as before -- this changes key ORDER only, never which
// values survive serialization, so serialize()'s error behavior is unchanged.
function canonicalizeJsonKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonKeys(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = canonicalizeJsonKeys(src[key])
    return out as unknown as T
  }
  return value
}

export class FeatureDag {
  private readonly nodes = new Map<string, DagNodeSnapshot>()

  // WO UI-7 (BK-40): the explicit feature-timeline order -- a permutation of
  // nodeIds() reflecting actual insertion/insert-at-marker call sequence,
  // NOT re-sorted by id like nodeIds()/topoOrder(). This is intentionally
  // call-order dependent (see RollbackMarker's doc comment) and lives
  // entirely OUTSIDE serialize()/restore(); see restoreRollbackState() for
  // its own, separate persistence seam.
  private timeline: string[] = []
  private rollbackMarker: RollbackMarker = { kind: 'end' }
  /** WO SKC-15C: reserved genesis ids dropped by the last `FeatureDag.restore` as non-canonical.
   *  Populated only by that static factory; empty on a freshly constructed dag. */
  private readonly droppedGenesisIds: string[] = []

  // ---------------------------------------------------------------------
  // Mutation (insert / remove / reorder).
  // ---------------------------------------------------------------------

  /**
   * `atIndex` (WO UI-7): optional position to splice the new id into
   * featureOrder() -- omitted (the ordinary path every pre-UI-7 caller
   * uses) appends to the end, unchanged from before this WO.
   */
  insertNode(input: DagNodeInput, atIndex?: number): void {
    // WO SKC-15C (audit major: fail-closed genesis ingress). The generic insert path REFUSES a
    // reserved genesis id outright -- a genesis node may only be built through installGenesisNode, in
    // its canonical shape. Before this, `insertNode({id:'origin', kind:'feature'})` succeeded and
    // seeded an immortal fake Origin (delete/suppress then refused it by name, so it could never be
    // repaired). Checked BEFORE the already-exists check so a collision on a reserved id reports the
    // reservation, which is the more useful truth.
    if (isGenesisNodeId(input.id)) throw new GenesisIngressError(input.id, 'insertNode')
    if (this.nodes.has(input.id)) {
      throw new Error(`FeatureDag.insertNode: node '${input.id}' already exists.`)
    }
    const consumes = input.consumes ?? []
    for (const producer of consumes) {
      if (producer === input.id) {
        throw new DagCycleError({ code: 'DAG_CYCLE', severity: 'error', params: { consumer: input.id, producer } })
      }
      this.assertNoCycle(input.id, producer)
    }
    // WO UI-7 (BK-40 mission #3): a new feature may only consume outputs that
    // exist ABOVE the rollback marker -- refusing here (rather than letting
    // it insert and cascade-suppress itself) gives the caller a plain,
    // immediate reason. A no-op whenever the marker is at 'end' (the
    // default/not-rolled-back state), since isRolledBack() is then always
    // false for every node -- zero blast radius on any caller that has never
    // touched rollback.
    for (const producer of consumes) {
      if (this.nodes.has(producer) && this.isRolledBack(producer)) {
        throw new Error(
          `FeatureDag.insertNode: '${input.id}' cannot consume '${producer}' -- it is rolled back ` +
            `(below the rollback marker). A new feature may only consume outputs that exist above the marker.`,
        )
      }
    }
    this.nodes.set(input.id, freshNode(input))
    if (atIndex === undefined) this.timeline.push(input.id)
    else this.timeline.splice(this.clampTimelineIndex(input.id, atIndex), 0, input.id)
  }

  /**
   * WO SKC-15: the insertion floor. A genesis node splices exactly where it asks (it IS the floor
   * being built); anything else is clamped below the leading genesis run, so no insert-at-marker or
   * undo-restore can land a feature above Origin.
   */
  private clampTimelineIndex(id: string, atIndex: number): number {
    const floor = isGenesisNodeId(id) ? 0 : leadingGenesisCount(this.timeline)
    return Math.max(floor, Math.min(atIndex, this.timeline.length))
  }

  /** Removes a node and returns its full snapshot (so a command can invert the removal). Dangling consumes edges left pointing at the removed id are treated by topoOrder/regenerate as already-satisfied -- restoring the node (undo) makes them live again automatically, with no other node needing to change.
   *
   *  WO SKC-15: refuses a genesis node (Origin / base plane) BY NAME. This is the LAST consumer of
   *  every delete path -- the tree's Delete key, its context menu, handleDelete's leaf-first sweep
   *  and RemoveNodeCommand all funnel here -- so the invariant holds even for a caller that forgot
   *  to check. The UI still gates earlier, to explain rather than throw. */
  removeNode(id: string): DagNodeSnapshot {
    if (isGenesisNodeId(id)) throw new GenesisNodeError(id, 'deleted')
    const node = this.requireNode(id)
    this.nodes.delete(id)
    const idx = this.timeline.indexOf(id)
    if (idx !== -1) this.timeline.splice(idx, 1)
    return cloneSnapshot(node)
  }

  /**
   * Re-inserts a full node snapshot exactly as previously removed (undo of
   * removeNode). `atIndex` (WO UI-12-R1): optional position to splice the
   * restored id back into featureOrder() -- the caller-captured index the
   * node held (via featureOrder().indexOf(id)) immediately before the
   * removeNode call it is undoing. Omitted, this re-appends to the END of
   * featureOrder(), unchanged from every pre-UI-12-R1 caller (additive).
   */
  restoreNode(snapshot: DagNodeSnapshot, atIndex?: number): void {
    // WO SKC-15C: the undo-restore path refuses a reserved genesis id for the same reason insertNode
    // does. In practice a genesis node is never removed (removeNode throws it), so no RemoveNodeCommand
    // ever captures one to restore -- but the audit built the restoreNode masquerade directly
    // (`restoreNode(datum:XY as kind 'feature')`), so the guard is here, not merely assumed unreachable.
    if (isGenesisNodeId(snapshot.id)) throw new GenesisIngressError(snapshot.id, 'restoreNode')
    if (this.nodes.has(snapshot.id)) {
      throw new Error(`FeatureDag.restoreNode: node '${snapshot.id}' already exists.`)
    }
    this.nodes.set(snapshot.id, cloneSnapshot(snapshot))
    if (!this.timeline.includes(snapshot.id)) {
      if (atIndex === undefined) this.timeline.push(snapshot.id)
      else this.timeline.splice(this.clampTimelineIndex(snapshot.id, atIndex), 0, snapshot.id)
    }
  }

  /**
   * WO SKC-15C: THE ONE controlled genesis-construction path. The generic insert/restore paths refuse
   * reserved ids; this is where they legitimately come into being, and the only place that can
   * force-replace a malformed existing genesis entry (removeNode refuses genesis ids by name, so the
   * ordinary remove+reinsert repair is impossible for them).
   *
   * It validates its own input is the canonical shape (belt and braces -- even the sanctioned path
   * cannot mint a fake), then INSTALLS it: replacing any existing node under that id, and splicing it
   * into the timeline. `reseatGenesis()` is the caller's job afterwards, once every genesis node
   * exists, so partial-seed order is fixed in one pass rather than guessed here.
   *
   * Never touches CommandHistory: a genesis node has no creation event to undo (basePlanes.ts's
   * seedGenesisNodes doc). It is idempotent on the canonical shape -- re-installing the same canonical
   * Origin over itself is a no-op replace.
   */
  installGenesisNode(input: DagNodeInput): void {
    if (!isCanonicalGenesisShape(input.id, input.kind, input.payload)) {
      throw new GenesisShapeError(input.id, input.kind)
    }
    // Replace in place if a (necessarily canonical, since this is the only writer) node already sits
    // there; otherwise create it. Timeline position is not decided here -- reseatGenesis pins it.
    const existedInTimeline = this.timeline.includes(input.id)
    this.nodes.set(input.id, freshNode(input))
    if (!existedInTimeline) this.timeline.push(input.id)
  }

  /**
   * WO SKC-15C: reorder the genesis nodes that exist to the FRONT, in canonical GENESIS_NODE_IDS
   * order, preserving the relative order of every non-genesis node. This is the "repair order" the
   * audit's partial-seed case needs: seeding an existing `[datum:YZ, datum:XY, F1]` timeline used to
   * leave the genesis rows scrambled ahead of F1; now they land as `[origin, datum:XY, datum:XZ,
   * datum:YZ, F1]` regardless of the order they were inserted or restored in.
   *
   * A no-op when the genesis nodes are already canonically seated (the common case -- a fresh
   * document), so seedGenesisNodes can call it unconditionally.
   */
  reseatGenesis(): void {
    const genesisFront = GENESIS_NODE_IDS.filter((id) => this.nodes.has(id))
    const rest = this.timeline.filter((id) => !isGenesisNodeId(id))
    this.timeline = [...genesisFront, ...rest]
  }

  /**
   * Rewires which upstream nodes `id` consumes -- the "reorder" mutation
   * (e.g. moving a feature to depend on a different/additional upstream node
   * changes its position in the derived topological order). Returns the
   * PRIOR consumes list so a command can undo by calling this again with it.
   */
  setConsumes(id: string, consumes: string[]): string[] {
    const node = this.requireNode(id)
    for (const producer of consumes) {
      if (producer === id) {
        throw new DagCycleError({ code: 'DAG_CYCLE', severity: 'error', params: { consumer: id, producer } })
      }
      this.assertNoCycle(id, producer)
    }
    const prior = node.consumes
    node.consumes = [...consumes]
    return prior
  }

  /**
   * Replaces a node's opaque `payload` wholesale (WO DOC-4: a parameter
   * node's evaluated value/expression/AST lives here -- there is no second,
   * parallel place parameter state is stored, per the Architect ruling that
   * parameters are ordinary DAG nodes). Returns the PRIOR payload so a
   * command can undo by calling this again with it -- mirrors setConsumes's
   * prior-return pattern exactly. Never touches consumes/refs/degraded/
   * diagnostics; payload is the only caller-owned opaque slice.
   */
  setPayload(id: string, payload: Record<string, unknown>): Record<string, unknown> {
    const node = this.requireNode(id)
    const prior = node.payload
    node.payload = { ...payload }
    return prior
  }

  /**
   * WO SKC-5: replaces a node's `refs` (its stable-ID element-set references,
   * resolved through ElementMap on regenerate()) wholesale. Additive: no
   * existing caller depended on refs being immutable after insertNode --
   * this is the same "wholesale replace, return PRIOR" shape setPayload
   * already established for payload, needed here so a degraded reference
   * (e.g. a face-plane datum whose parent face was deleted) can be REPAIRED
   * by re-pointing at a newly-picked element without removing/reinserting
   * the node (which would lose its id-stability for anything consuming it).
   * Never touches consumes/payload/degraded/diagnostics -- callers that also
   * need to re-dirty the node still call RegenScheduler.markDirty separately,
   * same as every other mutator here.
   */
  setRefs(id: string, refs: FeatureRef[]): FeatureRef[] {
    const node = this.requireNode(id)
    const prior = node.refs
    node.refs = cloneRefs(refs)
    return prior
  }

  /**
   * WO UI-6 (BK-39): sets a node's OWN suppress flag -- root suppression.
   * Cascade suppression (a downstream consumer inheriting a suppressed
   * upstream node's state) is NEVER stored; it is always derived live by
   * isEffectivelySuppressed, so flipping this flag automatically un/cascades
   * every dependent too with no separate bookkeeping. Returns the PRIOR
   * value so a command can undo by calling this again with it (mirrors
   * setConsumes/setPayload's prior-return pattern exactly).
   */
  setSuppressed(id: string, suppressed: boolean): boolean {
    // WO SKC-15: a genesis node has no feature to skip -- suppressing Origin or a base plane would
    // only strand every sketch that consumes it. Refused by name (both the row button and the
    // folder-suppress composite reach this).
    if (isGenesisNodeId(id)) throw new GenesisNodeError(id, 'suppressed')
    const node = this.requireNode(id)
    const prior = node.suppressed
    node.suppressed = suppressed
    return prior
  }

  /**
   * WO UI-53: sets a node's persisted display-only hidden flag. Unlike
   * suppression, this has no cascade helper and never affects regeneration;
   * the workbench reads it only when deciding whether to paint a finished
   * sketch outline. Returns the prior value for undo/redo symmetry.
   */
  setHidden(id: string, hidden: boolean): boolean {
    const node = this.requireNode(id)
    const prior = node.hidden
    node.hidden = hidden
    return prior
  }

  // ---------------------------------------------------------------------
  // WO UI-9 (BK-41): drag-reorder within featureOrder() + its dependency
  // guard. topoOrder() (regen's own execution order) is UNCHANGED by any of
  // this -- it stays the pure, insertion-order-independent function of
  // nodes+edges the file header's determinism note describes; reorderNode
  // only ever permutes `timeline` (the SAME UI-7 field the rollback marker
  // already reads), never `consumes`. The guard exists because featureOrder()
  // -- unlike topoOrder() -- has no automatic "producer before consumer"
  // property: it is an explicit, caller-controlled permutation, so a drag
  // that would place a consumer ahead of a producer it depends on (or a
  // producer behind a consumer of its own output) must be refused rather
  // than silently accepted into an order that lies about the dependency.
  // ---------------------------------------------------------------------

  /**
   * Read-only legality check: would moving `id` to `targetIndex` (a position
   * in the POST-move timeline, i.e. 0..featureOrder().length-1, the same
   * "array move" convention Array.prototype.splice's insertion index uses)
   * violate the producer-before-consumer invariant against any edge touching
   * `id`? Returns the blocking node + direction, or null if legal. Never
   * mutates -- this is the single source of truth both reorderNode's own
   * guard and a live drag-over indicator call, so the two can never disagree
   * about what is legal.
   */
  checkReorder(id: string, targetIndex: number): ReorderBlocked | null {
    const node = this.requireNode(id)
    if (!this.timeline.includes(id)) {
      throw new Error(`FeatureDag.checkReorder: '${id}' is not in the feature timeline.`)
    }
    // WO SKC-15: the genesis floor, checked BEFORE the dependency cases so a drag-over indicator
    // gets a truthful reason. Read-only, like the rest of this method -- reorderNode does the
    // throwing. Two distinct refusals: dragging a genesis node at all, and dragging anything else
    // into the slots they occupy.
    if (isGenesisNodeId(id)) return { blockingId: id, direction: 'above', reason: 'genesis' }
    const genesisFloor = leadingGenesisCount(this.timeline)
    if (genesisFloor > 0 && targetIndex < genesisFloor) {
      return { blockingId: this.timeline[genesisFloor - 1], direction: 'above', reason: 'genesis' }
    }
    const withoutId = this.timeline.filter((nid) => nid !== id)
    const clamped = Math.max(0, Math.min(targetIndex, withoutId.length))
    const simulated = [...withoutId.slice(0, clamped), id, ...withoutId.slice(clamped)]
    const position = new Map(simulated.map((nid, i) => [nid, i] as const))
    const idPos = position.get(id) as number

    // Case A: `id` would sit above (before) a producer it consumes.
    for (const producer of node.consumes) {
      const producerPos = position.get(producer)
      if (producerPos !== undefined && producerPos > idPos) {
        return { blockingId: producer, direction: 'above' }
      }
    }
    // Case B: `id` would sit below (after) a node that consumes it.
    for (const nid of this.timeline) {
      if (nid === id) continue
      const consumer = this.nodes.get(nid)
      if (consumer === undefined || !consumer.consumes.includes(id)) continue
      const consumerPos = position.get(nid)
      if (consumerPos !== undefined && consumerPos < idPos) {
        return { blockingId: nid, direction: 'below' }
      }
    }
    return null
  }

  /**
   * Moves `id` to `targetIndex` within featureOrder() (see checkReorder's own
   * comment for the index convention). Returns the PRIOR index so a command
   * can undo by calling this again with it (mirrors setConsumes/setSuppressed/
   * setRollbackMarker's prior-return pattern). Throws ReorderBlockedError
   * (mutating nothing) rather than silently clamping into an illegal
   * position -- checkReorder is the exact same check, exposed read-only.
   */
  reorderNode(id: string, targetIndex: number): number {
    const blocked = this.checkReorder(id, targetIndex)
    if (blocked) throw new ReorderBlockedError(id, blocked)

    const priorIndex = this.timeline.indexOf(id)
    const withoutId = this.timeline.filter((nid) => nid !== id)
    const clamped = Math.max(leadingGenesisCount(withoutId), Math.min(targetIndex, withoutId.length))
    this.timeline = [...withoutId.slice(0, clamped), id, ...withoutId.slice(clamped)]
    return priorIndex
  }

  // ---------------------------------------------------------------------
  // Queries.
  // ---------------------------------------------------------------------

  /** WO UI-6: `id`'s own suppress flag ("root" suppression), distinct from cascade -- see isEffectivelySuppressed. */
  isSuppressed(id: string): boolean {
    return this.requireNode(id).suppressed
  }

  /**
   * WO UI-6 (BK-39 mission #1, competitor convention): true if `id` itself
   * is suppressed, OR any node it transitively consumes (its upstream
   * chain) is suppressed -- suppressing a feature cascades to everything
   * downstream of it (everything that consumes it, directly or
   * transitively), exactly like standard parametric feature histories. Mirrors
   * RegenScheduler.firstFailedUpstream's upstream-walk shape. A node whose
   * OWN flag is false but this returns true is "cascade-suppressed" -- the
   * tree renders that as its own distinct state, never conflated with root
   * suppression (mission #1).
   */
  isEffectivelySuppressed(id: string): boolean {
    const node = this.requireNode(id)
    if (node.suppressed) return true
    const visited = new Set<string>()
    const stack = [...node.consumes]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      const upstream = this.nodes.get(cur)
      if (!upstream) continue
      if (upstream.suppressed) return true
      for (const p of upstream.consumes) stack.push(p)
    }
    return false
  }

  /**
   * WO UI-12 (BK-73): every node that transitively consumes `id` -- id's full
   * downstream consumer closure, NEVER including `id` itself. Read-only,
   * additive: the same consumer-graph walk RegenScheduler.downstreamClosure
   * (regen/scheduler.ts) already performs privately for dirty-marking,
   * exposed here as a stable public query so a delete guard can name every
   * feature that would be removed alongside `id` (or a sketch's consuming
   * feature) without duplicating that walk a second time and without
   * RegenScheduler having to grow a delete-specific public method of its own.
   * No behavior change to regen -- purely a read over the existing consumes
   * edges. Sorted by compareIds, same determinism convention as nodeIds().
   */
  transitiveConsumersOf(id: string): string[] {
    this.requireNode(id)
    const consumers = new Map<string, string[]>()
    for (const nid of this.nodeIds()) {
      const node = this.nodes.get(nid) as DagNodeSnapshot
      for (const producer of node.consumes) {
        const list = consumers.get(producer)
        if (list) list.push(nid)
        else consumers.set(producer, [nid])
      }
    }
    const out = new Set<string>()
    const stack = [...(consumers.get(id) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (out.has(cur)) continue
      out.add(cur)
      for (const c of consumers.get(cur) ?? []) stack.push(c)
    }
    return [...out].sort(compareIds)
  }

  // ---------------------------------------------------------------------
  // WO UI-7 (BK-40): rollback marker + explicit feature-timeline order.
  // Distinct mechanism from UI-6's suppress flag -- see RollbackMarker's doc
  // comment for why this is never folded into serialize()/restore().
  // ---------------------------------------------------------------------

  /** The explicit feature-timeline order (a permutation of nodeIds(), in actual insertion/insert-at-marker sequence). */
  featureOrder(): string[] {
    return [...this.timeline]
  }

  /** Current rollback marker (a copy -- callers cannot mutate dag state through it). */
  getRollbackMarker(): RollbackMarker {
    return this.rollbackMarker.kind === 'after' ? { kind: 'after', nodeId: this.rollbackMarker.nodeId } : { kind: this.rollbackMarker.kind }
  }

  /**
   * Sets the rollback marker. Returns the PRIOR marker so a command can undo
   * by calling this again with it (mirrors setSuppressed/setConsumes's
   * prior-return pattern). Throws if `marker.kind === 'after'` names a node
   * that does not exist.
   */
  setRollbackMarker(marker: RollbackMarker): RollbackMarker {
    if (marker.kind === 'after' && !this.nodes.has(marker.nodeId)) {
      throw new Error(`FeatureDag.setRollbackMarker: no such node '${marker.nodeId}'.`)
    }
    const prior = this.getRollbackMarker()
    this.rollbackMarker = marker.kind === 'after' ? { kind: 'after', nodeId: marker.nodeId } : { kind: marker.kind }
    return prior
  }

  /**
   * WO UI-7 (BK-40 mission #1): true if `id` sits at or after the rollback
   * marker in featureOrder() -- "rollback-suppressed", a state DISTINCT from
   * UI-6's isEffectivelySuppressed (which is cascade/consumes-derived): a
   * user-suppressed feature stays suppressed when the marker moves past it
   * (this method says nothing about that -- callers combine both), and a
   * rolled-back feature that was never individually suppressed is restored
   * the instant the marker moves back past it, with zero stored per-node
   * state (exactly like isEffectivelySuppressed's cascade, derived live).
   * Fails OPEN (returns false) if the marker's `after` node no longer exists
   * (e.g. removed out from under the marker) rather than crashing the whole
   * document on a dangling marker reference.
   */
  isRolledBack(id: string): boolean {
    this.requireNode(id)
    // WO SKC-15: Origin and the base planes are never rolled back -- not even by a 'start' marker,
    // which means "every FEATURE rolled back". Rolling back the plane a rolled-back sketch sits on
    // would be meaningless, and insertNode's own rolled-back-producer refusal would then reject
    // every new sketch on a base plane.
    if (isGenesisNodeId(id)) return false
    const marker = this.rollbackMarker
    if (marker.kind === 'end') return false
    if (marker.kind === 'start') return true
    const markerIdx = this.timeline.indexOf(marker.nodeId)
    if (markerIdx === -1) return false
    return this.timeline.indexOf(id) > markerIdx
  }

  /** Every currently rolled-back node id, in featureOrder() sequence. */
  rolledBackIds(): string[] {
    return this.timeline.filter((id) => this.isRolledBack(id))
  }

  /**
   * Seeds featureOrder()/the rollback marker from persisted state (WO UI-7;
   * src/doc/persist/format.ts's separate `document.rollback` field -- see
   * RollbackMarker's doc comment for why this is not part of restore()).
   * `input` absent/partial (a pre-UI-7 archive, or one that never touched
   * rollback) defaults to an id-sorted timeline with the marker at 'end' --
   * nothing rolled back, byte-for-byte the pre-UI-7 behavior. A declared
   * featureOrder missing some live node (or naming one that no longer
   * exists) is reconciled rather than trusted blindly: known ids not listed
   * are appended (sorted) at the end; listed ids that no longer exist are
   * dropped.
   */
  restoreRollbackState(input?: { featureOrder?: string[]; marker?: RollbackMarker }): void {
    const declared = (input?.featureOrder ?? []).filter((id) => this.nodes.has(id))
    const missing = this.nodeIds().filter((id) => !declared.includes(id))
    const reconciled = [...declared, ...missing]
    // WO SKC-15: genesis nodes are pinned to the front regardless of what the archive declared.
    // `document.rollback.featureOrder` is untrusted input reconciled rather than obeyed (see this
    // method's own doc comment); an archive that lists Origin below a feature -- hand-edited, or
    // written by a future version -- must not be able to unpin it. GENESIS_NODE_IDS' declaration
    // order wins over the archive's.
    const genesis = GENESIS_NODE_IDS.filter((id) => this.nodes.has(id))
    this.timeline = [...genesis, ...reconciled.filter((id) => !isGenesisNodeId(id))]

    const marker = input?.marker
    if (marker && marker.kind === 'after' && typeof marker.nodeId === 'string' && this.nodes.has(marker.nodeId)) {
      this.rollbackMarker = { kind: 'after', nodeId: marker.nodeId }
    } else if (marker && (marker.kind === 'start' || marker.kind === 'end')) {
      this.rollbackMarker = { kind: marker.kind }
    } else {
      this.rollbackMarker = { kind: 'end' }
    }
  }

  has(id: string): boolean {
    return this.nodes.has(id)
  }

  getNode(id: string): DagNodeSnapshot | undefined {
    const node = this.nodes.get(id)
    return node ? cloneSnapshot(node) : undefined
  }

  /** Sorted node ids -- never Map iteration/insertion order (see determinism note at top of file). */
  nodeIds(): string[] {
    return [...this.nodes.keys()].sort(compareIds)
  }

  /**
   * Deterministic topological order (Kahn's algorithm). At every step the set
   * of "ready" nodes (every existing-node consumes-dependency already placed)
   * is sorted by compareIds and the SMALLEST is placed next -- never the one
   * that happened to be inserted first or sits at the lowest array/Map index.
   * This is what makes the same graph, built via any call order, serialize
   * byte-identically (AC #1's golden test). A consumes-edge whose target node
   * no longer exists (deleted) is treated as already-satisfied (see
   * removeNode), never as a permanent block.
   */
  topoOrder(): string[] {
    const remaining = new Set(this.nodeIds())
    const out: string[] = []
    while (remaining.size > 0) {
      const ready: string[] = []
      for (const id of remaining) {
        const node = this.nodes.get(id) as DagNodeSnapshot
        const blocked = node.consumes.some((p) => remaining.has(p))
        if (!blocked) ready.push(id)
      }
      if (ready.length === 0) {
        // Cannot happen when insertNode/setConsumes always refuse cycles up
        // front -- fail loud rather than infinite-loop if that guard is ever
        // bypassed.
        throw new Error(
          `FeatureDag.topoOrder: no ready node among [${[...remaining].sort(compareIds).join(', ')}] -- unreachable cycle.`,
        )
      }
      ready.sort(compareIds)
      const next = ready[0]
      out.push(next)
      remaining.delete(next)
    }
    return out
  }

  // ---------------------------------------------------------------------
  // Regeneration seam (DOC-5 builds the dirty-marking/chunked/cancellable
  // scheduler on top of this; here we just resolve each node's refs honestly
  // and mark degraded state per plan §3.4's "downstream features still
  // evaluate against the last-good body" rule).
  // ---------------------------------------------------------------------

  /**
   * Walks the DAG in topological order and resolves every node's declared
   * refs through the given ElementMap, updating degraded/diagnostics/
   * lastGoodBoundTo. Never halts early on a degraded node: downstream nodes
   * are always evaluated in the same pass (a lost reference degrades ONLY the
   * node that owns it, never anything downstream of it).
   */
  regenerate(map: ElementMap): void {
    for (const id of this.topoOrder()) {
      const node = this.nodes.get(id) as DagNodeSnapshot
      const diagnostics: Diag[] = []
      let degraded = false
      for (const ref of node.refs) {
        const res: Resolution = map.resolve(ref.id, ref.kind)
        diagnostics.push(...res.diagnostics)
        if (res.status === 'lost') {
          degraded = true
          // Deliberately do NOT touch lastGoodBoundTo here -- retain the last
          // good binding so downstream evaluation has something real to use.
        } else {
          node.lastGoodBoundTo[ref.id] = res.boundTo
        }
      }
      node.degraded = degraded
      node.diagnostics = diagnostics
    }
  }

  // ---------------------------------------------------------------------
  // Serialization (docs/3d-modeling-plan.md §3.4; DOC-3 wraps this in the
  // zip persistence format -- this is the structural-identity surface).
  // ---------------------------------------------------------------------

  /**
   * Canonical, sort-stable serialization: two DAGs with the same nodes/edges
   * (built via any call order) produce a byte-identical string. Includes the
   * derived topoOrder so the golden test also exercises AC #1's determinism
   * directly, not just the raw node/edge set.
   */
  serialize(): string {
    const nodes = this.nodeIds().map((id) => {
      const n = this.nodes.get(id) as DagNodeSnapshot
      return {
        id: n.id,
        kind: n.kind,
        consumes: [...n.consumes].sort(compareIds),
        refs: cloneRefs(n.refs).sort((a, b) =>
          compareIds(a.id, b.id) ||
          compareIds(a.kind, b.kind) ||
          compareIds(a.role ?? '', b.role ?? '') ||
          compareIds(a.elementType ?? '', b.elementType ?? ''),
        ),
        payload: canonicalizeJsonKeys(n.payload),
        degraded: n.degraded,
        diagnostics: canonicalizeJsonKeys(n.diagnostics),
        lastGoodBoundTo: sortRecord(n.lastGoodBoundTo),
        suppressed: n.suppressed,
        hidden: n.hidden,
      }
    })
    return JSON.stringify({ nodes, order: this.topoOrder() })
  }

  /**
   * Parses a FeatureDag back from serialize()'s output (structural round-trip; DOC-3's zip-format
   * loader is the intended future caller).
   *
   * WO SKC-15C (audit major: fail-closed genesis ingress). An archive is UNTRUSTED input -- hand-
   * edited, or written by a future/older version. A reserved genesis id whose serialized shape is not
   * canonical (the audit's "restored archive retained origin as kind 'feature' and datum:XY as kind
   * 'body'") is DROPPED here rather than materialized: a fake genesis node would be immortal, because
   * removeNode/setSuppressed refuse reserved ids by name. Dropping is fail-closed and self-sufficient
   * -- seedGenesisNodes (run by the workbench right after load) re-installs the canonical genesis in
   * its true shape and reseats it. A CANONICAL genesis node in the archive is kept as-is; the
   * following seed re-installs it idempotently. `restoredDroppedGenesisIds()` exposes what was dropped
   * for a loader that wants to surface "your file's Origin was corrupt and has been rebuilt".
   */
  static restore(json: string): FeatureDag {
    const parsed = JSON.parse(json) as { nodes: DagNodeSnapshot[] }
    const dag = new FeatureDag()
    for (const n of parsed.nodes) {
      if (isGenesisNodeId(n.id) && !isCanonicalGenesisShape(n.id, n.kind, n.payload)) {
        dag.droppedGenesisIds.push(n.id)
        continue
      }
      dag.nodes.set(n.id, cloneSnapshot(n))
    }
    return dag
  }

  /** WO SKC-15C: reserved genesis ids that `FeatureDag.restore` dropped as non-canonical (a corrupt/
   *  hostile archive). Empty for a clean document. A loader reads it to warn the user their file's
   *  genesis fixtures were rebuilt; the workbench's seedGenesisNodes has already replaced them. */
  restoredDroppedGenesisIds(): string[] {
    return [...this.droppedGenesisIds]
  }

  // ---------------------------------------------------------------------
  // Internals.
  // ---------------------------------------------------------------------

  private requireNode(id: string): DagNodeSnapshot {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`FeatureDag: no such node '${id}'.`)
    return node
  }

  /**
   * Throws DagCycleError if `consumer` consuming `producer` would create a
   * cycle, i.e. if `producer`'s own (transitive, existing-node-only) consumes
   * chain already reaches `consumer`. A producer that isn't currently a node
   * (dangling reference, e.g. to something not yet inserted or already
   * removed) cannot be part of a cycle by definition.
   */
  private assertNoCycle(consumer: string, producer: string): void {
    if (!this.nodes.has(producer)) return
    const visited = new Set<string>()
    const stack = [producer]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (cur === consumer) {
        throw new DagCycleError({ code: 'DAG_CYCLE', severity: 'error', params: { consumer, producer } })
      }
      if (visited.has(cur)) continue
      visited.add(cur)
      const node = this.nodes.get(cur)
      if (!node) continue
      for (const next of node.consumes) stack.push(next)
    }
  }
}
