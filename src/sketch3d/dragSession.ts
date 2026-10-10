import type { Sketch3dSolveService } from './solveService'
import type {
  Sketch3dCoincidentConstraint,
  Sketch3dDocument,
  Sketch3dEntity,
  Sketch3dPointEntity,
  Sketch3dPointRef,
  Sketch3dSolveResult,
  Sketch3dVec2,
} from './types'

// Architect ruling (WO SKC-2): 16ms/frame is the throttle policy's budget constant. A solve
// that takes longer than this marks the session "throttled" until the next tick() flush -
// intermediate move() calls in that window coalesce (latest-cursor-wins) instead of each
// triggering a solve. Do not tune without re-measuring the perf ladder in dragPerfLadder.test.ts.
export const SKETCH3D_DRAG_FRAME_BUDGET_MS = 16

const DRAG_CURSOR_ENTITY_ID = '__sketch3d_drag_cursor__'
const DRAG_CONSTRAINT_ID = '__sketch3d_drag_constraint__'

export interface Sketch3dDragMoveResult extends Sketch3dSolveResult {
  // true when this move() call did not trigger a solve (frame budget was still charged from
  // a prior slow solve) - entities/updatedPositions reflect the last solved state, not this cursor.
  coalesced: boolean
  // wall-clock duration of the solve performed by this call, or null when coalesced.
  solveMs: number | null
}

export interface Sketch3dDragSessionOptions {
  frameBudgetMs?: number
  // clock injection for deterministic scheduler tests; defaults to performance.now.
  now?: () => number
}

function cloneEntity(entity: Sketch3dEntity): Sketch3dEntity {
  return { ...entity }
}

function cursorEntity(at: Sketch3dVec2): Sketch3dPointEntity {
  return { id: DRAG_CURSOR_ENTITY_ID, kind: 'point', at, fixed: true }
}

function dragConstraint(point: Sketch3dPointRef): Sketch3dCoincidentConstraint {
  return {
    id: DRAG_CONSTRAINT_ID,
    kind: 'coincident',
    a: point,
    b: { entityId: DRAG_CURSOR_ENTITY_ID, site: 'self' },
    // NOT planegcs's `temporary` flag: measured behavior is that `temporary` constraints are
    // excluded from BOTH the dof() count and the conflicting-constraints report, so a drag
    // onto an already-fully-constrained point would solve as a silent no-op 'success' instead
    // of surfacing a conflict (criterion 3 requires the conflict report here). "Temporary" in
    // this module means session-scoped - the constraint is never written into the persisted
    // document and is dropped before end()'s final solve, which is what keeps DOF/constraint
    // state identical to pre-begin() (criterion 1) without needing the wasm-level flag.
    //
    // Because this IS a real, driving constraint, it necessarily consumes the dragged point's
    // free DOF for the duration of the solve that pins it to the cursor - that is how the
    // conflict surfacing above works at all. To honor "temporary constraints must not consume
    // DOF" from the caller's perspective (architect ruling / 3d-modeling-plan.md:41), solveAt()
    // reports the pre-drag base sketch's DOF count for every non-conflicting move, not this
    // constraint's own reduced count - see baseDof below.
    driving: true,
  }
}

function assertNoReservedIds(document: Sketch3dDocument): void {
  if (document.entities.some((entity) => entity.id === DRAG_CURSOR_ENTITY_ID)) {
    throw new Error(`sketch3d drag session: entity id '${DRAG_CURSOR_ENTITY_ID}' is reserved`)
  }
  if (document.constraints.some((constraint) => constraint.id === DRAG_CONSTRAINT_ID)) {
    throw new Error(`sketch3d drag session: constraint id '${DRAG_CONSTRAINT_ID}' is reserved`)
  }
}

function stripDragArtifacts(result: Sketch3dSolveResult): Sketch3dSolveResult {
  return {
    ...result,
    entities: result.entities.filter((entity) => entity.id !== DRAG_CURSOR_ENTITY_ID),
    updatedPositions: result.updatedPositions.filter((position) => position.entityId !== DRAG_CURSOR_ENTITY_ID),
    handles: result.handles.filter((handle) => handle.entityId !== DRAG_CURSOR_ENTITY_ID),
  }
}

// Interactive drag-solve loop on top of SKC-1's Sketch3dSolveService (WO SKC-2).
//
// Interaction pattern (validated, per 3d-modeling-plan.md Sec 3.6 and the Architect
// ruling): begin() adds a temporary fixed cursor point + a temporary driving coincident
// constraint pinning the dragged point to it; move() re-solves with the latest cursor;
// end() drops both temporaries and does one final solve of the LAST solved drag geometry
// against the original constraint set, committing the released position - so the
// CONSTRAINT SET and DOF are identical to before begin() (criterion 1), while the entity
// positions reflect where the drag left them, not a revert to the pre-drag document.
//
// The service instance is supplied by the caller and reused for the whole session - the
// underlying wasm GcsSystem is therefore constructed at most once per drag (never rebuilt
// per move), satisfying the heap-pressure and latency requirements from SKC-1's dispose
// contract.
//
// "entityId/point" in the WO text is generalized here to a full Sketch3dPointRef
// (entityId + site) so any draggable point - a bare point entity, a line endpoint, a
// circle/arc center, an arc endpoint - can be the drag target, not just point entities.
export class Sketch3dDragSession {
  private readonly service: Sketch3dSolveService
  private readonly baseDocument: Sketch3dDocument
  private readonly frameBudgetMs: number
  private readonly now: () => number

  private active = false
  private point: Sketch3dPointRef | null = null
  private currentEntities: Sketch3dEntity[]
  private pendingCursor: Sketch3dVec2 | null = null
  private throttled = false
  private lastResult: Sketch3dDragMoveResult | null = null
  // The base sketch's DOF (constraints only, no drag artifacts), captured fresh at begin().
  // Reported in place of the raw per-solve dof for every non-conflicting move so the temporary
  // drag pin never appears to consume DOF from the caller's point of view.
  private baseDof: number | null = null

  solveCount = 0
  coalescedCount = 0

  constructor(service: Sketch3dSolveService, document: Sketch3dDocument, options: Sketch3dDragSessionOptions = {}) {
    assertNoReservedIds(document)
    this.service = service
    this.baseDocument = document
    this.currentEntities = document.entities.map(cloneEntity)
    this.frameBudgetMs = options.frameBudgetMs ?? SKETCH3D_DRAG_FRAME_BUDGET_MS
    this.now = options.now ?? (() => performance.now())
  }

  get isActive(): boolean {
    return this.active
  }

  // 0 or 1, always - move() overwrites a single slot rather than queuing, so this never
  // grows regardless of burst size (criterion 4).
  get pendingDepth(): 0 | 1 {
    return this.pendingCursor ? 1 : 0
  }

  begin(point: Sketch3dPointRef, cursor: Sketch3dVec2): Sketch3dDragMoveResult {
    if (this.active) throw new Error('sketch3d drag session: begin() called while already active')
    this.active = true
    this.point = point
    this.throttled = false
    this.pendingCursor = null
    this.solveCount = 0
    this.coalescedCount = 0
    this.baseDof = this.computeBaseDof()
    return this.solveAt(cursor)
  }

  move(cursor: Sketch3dVec2): Sketch3dDragMoveResult {
    this.assertActive()
    if (this.throttled) {
      this.pendingCursor = cursor
      this.coalescedCount++
      return { ...this.requireLastResult(), coalesced: true, solveMs: null }
    }
    return this.solveAt(cursor)
  }

  // Flushes a coalesced cursor (if any) as one solve consuming the newest pending value.
  // A real UI drives this once per animation frame; returns null if nothing is pending.
  tick(): Sketch3dDragMoveResult | null {
    this.assertActive()
    if (this.pendingCursor === null) return null
    const cursor = this.pendingCursor
    this.pendingCursor = null
    return this.solveAt(cursor)
  }

  end(): Sketch3dSolveResult {
    this.assertActive()
    // Final solve commits the LAST solved drag geometry against the base (temporary-free)
    // constraint set - dropping the cursor pin and its constraint without discarding the
    // dragged position, per the validated pattern ("drop temporaries -> final solve",
    // not "revert to pre-drag document"). currentEntities is only ever updated from a
    // successful/redundant solveAt(), so on an over-constrained drag (never solved) it still
    // holds the untouched original positions, reproducing the pre-drag baseline exactly.
    const finalDocument: Sketch3dDocument = {
      id: this.baseDocument.id,
      entities: this.currentEntities,
      constraints: this.baseDocument.constraints,
    }
    const result = this.service.solve(finalDocument)
    this.active = false
    this.point = null
    this.pendingCursor = null
    this.throttled = false
    this.lastResult = null
    this.baseDof = null
    if (result.status === 'success' || result.status === 'redundant') {
      this.currentEntities = result.entities.map(cloneEntity)
    }
    return result
  }

  private computeBaseDof(): number | null {
    const baseline = this.service.solve(this.baseDocument)
    return baseline.status === 'success' || baseline.status === 'redundant' ? baseline.dof : null
  }

  private solveAt(cursor: Sketch3dVec2): Sketch3dDragMoveResult {
    if (!this.point) throw new Error('sketch3d drag session: no drag point set')
    const workingDocument: Sketch3dDocument = {
      id: this.baseDocument.id,
      entities: [...this.currentEntities, cursorEntity(cursor)],
      constraints: [...this.baseDocument.constraints, dragConstraint(this.point)],
    }

    const start = this.now()
    const rawResult = this.service.solve(workingDocument)
    const solveMs = this.now() - start
    this.solveCount++
    this.throttled = solveMs > this.frameBudgetMs

    if (rawResult.status === 'success' || rawResult.status === 'redundant') {
      this.currentEntities = rawResult.entities
        .filter((entity) => entity.id !== DRAG_CURSOR_ENTITY_ID)
        .map(cloneEntity)
    }

    // Report the base sketch's DOF while the temporary pin is active/successful, not the
    // (necessarily lower) DOF of the pinned working document - see dragConstraint()'s comment
    // and baseDof's field doc. A conflicting solve keeps its raw dof: that value is part of
    // the genuine conflict signal, not a temporary-constraint artifact to mask.
    const reportedDof =
      (rawResult.status === 'success' || rawResult.status === 'redundant') && this.baseDof !== null
        ? this.baseDof
        : rawResult.dof

    const result: Sketch3dDragMoveResult = {
      ...stripDragArtifacts(rawResult),
      dof: reportedDof,
      coalesced: false,
      solveMs,
    }
    this.lastResult = result
    return result
  }

  private assertActive(): void {
    if (!this.active) throw new Error('sketch3d drag session: call begin() before move()/tick()/end()')
  }

  private requireLastResult(): Sketch3dDragMoveResult {
    if (!this.lastResult) throw new Error('sketch3d drag session: no solve has run yet')
    return this.lastResult
  }
}
