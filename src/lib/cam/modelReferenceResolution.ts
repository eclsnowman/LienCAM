// CAM-1 (docs/3d-modeling-plan.md §3.8) — the CAM-op re-resolution MAPPING.
//
// This is the pure, kernel-free heart of the "toolpath notices the model
// changed" hook. It CONSUMES the plain output of the FROZEN geom-service
// resolve() (src/geom/geom-service.ts:513, status 'exact'|'fallback'|'lost')
// and decides, per CAM op, whether the op is untouched, stale ('outdated') or
// degraded. The async resolve() calls and the store mutation live elsewhere
// (SolidsWorkbenchPage.fullResync does the resolving; the store action applies
// the result) — everything here is a deterministic Setup[] -> Setup[] transform
// so it is exhaustively unit-testable without a live kernel.
//
// Exhaustive over the resolver's CLOSED status set (fail-closed rule): every
// accept point validates the DATA (status is a known member, every requested id
// came back, numeric fields are finite) and REFUSES BY NAME on anything it did
// not enumerate — a NaN or an unknown status string never sails through a
// comparison silently.

import type { Operation, Setup } from '../../types'
import type { ModelReference } from './types'

/** Named, greppable refusal for anything the resolver returned that this mapping
 *  did not enumerate. Thrown (never swallowed) so a malformed resolve() reply is
 *  loud, not a silent skip that would leave an op falsely 'ready'. */
export class ModelReferenceResolutionError extends Error {
  constructor(message: string) {
    super(`ModelReferenceResolutionError: ${message}`)
    this.name = 'ModelReferenceResolutionError'
  }
}

/** The CLOSED status set of the frozen resolve(). Mirrored here (not imported
 *  from the frozen module) so this mapping owns its own accepted set. */
const RESOLVE_STATUSES = ['exact', 'fallback', 'lost'] as const
export type ResolveStatus = (typeof RESOLVE_STATUSES)[number]

const SUBSHAPE_TYPES = ['face', 'edge', 'vertex'] as const

/** One UNTRUSTED entry as returned by resolve(). Every field is validated before
 *  use — do not assume `status` is a ResolveStatus or that numbers are finite. */
export interface RawResolution {
  id: string
  status: string
  localIndex?: number
  type?: string
}

/** The re-resolution result for ONE B-rep body, as gathered by the caller that
 *  owns the GeomClient + BodyHandle. The caller MUST include an entry for every
 *  body referenced by any op being evaluated (a missing body is a refusal, not a
 *  silent skip), and MUST resolve every stableId the op requested. */
export interface BodyResolution {
  bodyId: string
  /** Did this body's geometry regenerate in the pass that triggered this
   *  re-resolution? Drives the "all ids exact but body changed -> stale" arm.
   *  When the body handle no longer exists at all, the caller supplies a
   *  BodyResolution whose entries are all `lost` (-> degraded). */
  changed: boolean
  resolutions: RawResolution[]
}

/** Per-op aggregate verdict. Precedence: degraded (any lost) > stale-fallback
 *  (any geometric fallback) > stale-changed (all exact, body regenerated) >
 *  untouched (all exact, unchanged). */
export type OpReresolveOutcome =
  | 'untouched'
  | 'stale-changed'
  | 'stale-fallback'
  | 'degraded'

export interface OpReresolveVerdict {
  outcome: OpReresolveOutcome
  /** ids that came back 'fallback' (populated for stale-fallback). */
  fallbackIds: string[]
  /** ids that came back 'lost' (populated for degraded). */
  lostIds: string[]
  /** bodyIds whose lost ids drove a degrade (for the note). */
  degradedBodies: string[]
}

// ---------------------------------------------------------------------------
// Data validation (fail-loud at every accept point)
// ---------------------------------------------------------------------------

function assertResolveStatus(value: string, bodyId: string, id: string): ResolveStatus {
  if ((RESOLVE_STATUSES as readonly string[]).includes(value)) return value as ResolveStatus
  throw new ModelReferenceResolutionError(
    `unknown resolver status "${value}" for id "${id}" on body "${bodyId}" ` +
      `(expected one of ${RESOLVE_STATUSES.join('/')})`,
  )
}

/** Validate one raw entry and return its id + narrowed status. Refuses on a
 *  non-string id, an unknown status, a non-finite/negative/non-integer
 *  localIndex, or an unknown subshape type. */
function validateEntry(entry: RawResolution, bodyId: string): { id: string; status: ResolveStatus } {
  if (typeof entry?.id !== 'string' || entry.id.length === 0) {
    throw new ModelReferenceResolutionError(
      `resolver reply for body "${bodyId}" carried an entry with a missing/empty id`,
    )
  }
  const status = assertResolveStatus(entry.status, bodyId, entry.id)
  if (entry.localIndex !== undefined) {
    if (!Number.isInteger(entry.localIndex) || entry.localIndex < 0) {
      throw new ModelReferenceResolutionError(
        `non-finite/negative localIndex ${String(entry.localIndex)} for id "${entry.id}" on body "${bodyId}"`,
      )
    }
  }
  if (entry.type !== undefined && !(SUBSHAPE_TYPES as readonly string[]).includes(entry.type)) {
    throw new ModelReferenceResolutionError(
      `unknown subshape type "${entry.type}" for id "${entry.id}" on body "${bodyId}"`,
    )
  }
  return { id: entry.id, status }
}

/** Build a validated id -> status map for one body. Refuses on a duplicate id in
 *  the reply (an ambiguous resolution the mapping cannot honor). */
function statusMapForBody(body: BodyResolution): Map<string, ResolveStatus> {
  if (typeof body?.bodyId !== 'string' || body.bodyId.length === 0) {
    throw new ModelReferenceResolutionError('a BodyResolution carried a missing/empty bodyId')
  }
  if (typeof body.changed !== 'boolean') {
    throw new ModelReferenceResolutionError(
      `BodyResolution for "${body.bodyId}" has a non-boolean "changed" field`,
    )
  }
  if (!Array.isArray(body.resolutions)) {
    throw new ModelReferenceResolutionError(
      `BodyResolution for "${body.bodyId}" has a non-array "resolutions" field`,
    )
  }
  const map = new Map<string, ResolveStatus>()
  for (const entry of body.resolutions) {
    const { id, status } = validateEntry(entry, body.bodyId)
    if (map.has(id)) {
      throw new ModelReferenceResolutionError(
        `resolver reply for body "${body.bodyId}" returned id "${id}" more than once`,
      )
    }
    map.set(id, status)
  }
  return map
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Index a BodyResolution batch by bodyId. Refuses on a duplicate body. */
export function indexBodies(bodies: BodyResolution[]): Map<string, BodyResolution> {
  if (!Array.isArray(bodies)) {
    throw new ModelReferenceResolutionError('reresolve input is not an array of BodyResolution')
  }
  const byId = new Map<string, BodyResolution>()
  for (const body of bodies) {
    if (typeof body?.bodyId !== 'string' || body.bodyId.length === 0) {
      throw new ModelReferenceResolutionError('a BodyResolution carried a missing/empty bodyId')
    }
    if (byId.has(body.bodyId)) {
      throw new ModelReferenceResolutionError(`re-resolution batch listed body "${body.bodyId}" twice`)
    }
    byId.set(body.bodyId, body)
  }
  return byId
}

/** Classify a single op against the batch. Every referenced body MUST be present
 *  in the batch and every referenced id MUST appear in that body's reply, else a
 *  named refusal. Returns null for an op that carries no modelReferences (it is
 *  untouched by construction and skipped without allocation). */
export function classifyOperation(
  op: Pick<Operation, 'id' | 'modelReferences'>,
  byBody: Map<string, BodyResolution>,
  bodyStatusCache?: Map<string, Map<string, ResolveStatus>>,
): OpReresolveVerdict | null {
  const refs = op.modelReferences
  if (!refs || refs.length === 0) return null

  const fallbackIds: string[] = []
  const lostIds: string[] = []
  const degradedBodies = new Set<string>()
  let anyChanged = false

  for (const ref of refs) {
    validateReferenceShape(ref, op.id)
    const body = byBody.get(ref.bodyId)
    if (body === undefined) {
      throw new ModelReferenceResolutionError(
        `re-resolution batch is missing body "${ref.bodyId}" referenced by op "${op.id}" ` +
          `(caller must resolve every referenced body; supply an all-lost entry for a gone body)`,
      )
    }
    // Validate/cache the body's reply map once per body across the whole pass.
    let statusMap = bodyStatusCache?.get(ref.bodyId)
    if (statusMap === undefined) {
      statusMap = statusMapForBody(body)
      bodyStatusCache?.set(ref.bodyId, statusMap)
    }
    if (body.changed) anyChanged = true

    for (const stableId of ref.stableIds) {
      const status = statusMap.get(stableId)
      if (status === undefined) {
        throw new ModelReferenceResolutionError(
          `resolver reply for body "${ref.bodyId}" is missing requested id "${stableId}" ` +
            `(op "${op.id}")`,
        )
      }
      switch (status) {
        case 'exact':
          break
        case 'fallback':
          fallbackIds.push(stableId)
          break
        case 'lost':
          lostIds.push(stableId)
          degradedBodies.add(ref.bodyId)
          break
        default: {
          // Unreachable: assertResolveStatus already narrowed to the closed set.
          // The exhaustiveness guard makes a future status member a build error.
          const _exhaustive: never = status
          throw new ModelReferenceResolutionError(`unhandled status ${String(_exhaustive)}`)
        }
      }
    }
  }

  let outcome: OpReresolveOutcome
  if (lostIds.length > 0) outcome = 'degraded'
  else if (fallbackIds.length > 0) outcome = 'stale-fallback'
  else if (anyChanged) outcome = 'stale-changed'
  else outcome = 'untouched'

  return { outcome, fallbackIds, lostIds, degradedBodies: [...degradedBodies] }
}

function validateReferenceShape(ref: ModelReference, opId: string): void {
  if (typeof ref?.bodyId !== 'string' || ref.bodyId.length === 0) {
    throw new ModelReferenceResolutionError(`op "${opId}" has a ModelReference with a missing/empty bodyId`)
  }
  if (!Array.isArray(ref.stableIds) || ref.stableIds.length === 0) {
    throw new ModelReferenceResolutionError(
      `op "${opId}" ModelReference on body "${ref.bodyId}" has no stableIds`,
    )
  }
  for (const id of ref.stableIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ModelReferenceResolutionError(
        `op "${opId}" ModelReference on body "${ref.bodyId}" has a missing/empty stableId`,
      )
    }
  }
}

/**
 * STABLEIDS-GUARD-RERESOLVE (MODEL-ROW-CITIZEN batch 1): validate and return a
 * ModelReference's `stableIds`, refusing BY NAME (never a raw "not iterable"
 * TypeError) when the field is missing / not an array / empty, or carries a
 * non-string id. This is the guard the async re-resolution GATHER path in
 * SolidsWorkbenchPage.reresolveCamModelRefs must use before it iterates
 * `ref.stableIds` to build the resolve() request. That path previously did a
 * bare `for (const id of ref.stableIds)`; a malformed reference threw a cryptic
 * "not iterable" surfaced as a misleading red banner. Mirrors
 * validateReferenceShape's guard (the sibling classify path) so both entry
 * points refuse the same malformed data the same, named way (ADR-0003: a loud,
 * greppable refusal, not a silent skip or a cryptic crash).
 *
 * `context` is folded into the message (e.g. an op id) for a greppable locus.
 * The field is typed `string[]` on ModelReference, so this cannot fire for
 * well-formed ops built by the real UI today — it hardens the boundary against a
 * corrupt project or a future stage that hands over an under-populated reference.
 */
export function referenceStableIds(
  ref: Pick<ModelReference, 'bodyId'> & { stableIds?: unknown },
  context?: string,
): string[] {
  const where = context ? ` (${context})` : ''
  if (typeof ref?.bodyId !== 'string' || ref.bodyId.length === 0) {
    throw new ModelReferenceResolutionError(
      `a ModelReference has a missing/empty bodyId${where}`,
    )
  }
  if (!Array.isArray(ref.stableIds) || ref.stableIds.length === 0) {
    throw new ModelReferenceResolutionError(
      `ModelReference on body "${ref.bodyId}" has no stableIds${where}`,
    )
  }
  for (const id of ref.stableIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ModelReferenceResolutionError(
        `ModelReference on body "${ref.bodyId}" has a missing/empty stableId${where}`,
      )
    }
  }
  return ref.stableIds as string[]
}

// ---------------------------------------------------------------------------
// Applying the verdict to an op
// ---------------------------------------------------------------------------

function noteForVerdict(verdict: OpReresolveVerdict): string | undefined {
  switch (verdict.outcome) {
    case 'degraded':
      return `Referenced model geometry was removed: ${verdict.lostIds.length} ` +
        `reference${verdict.lostIds.length === 1 ? '' : 's'} lost on ` +
        `${verdict.degradedBodies.join(', ')}.`
    case 'stale-fallback':
      return `Referenced model geometry moved; ${verdict.fallbackIds.length} ` +
        `reference${verdict.fallbackIds.length === 1 ? '' : 's'} re-bound approximately ` +
        `(${verdict.fallbackIds.join(', ')}). Recompute to confirm.`
    case 'stale-changed':
    case 'untouched':
      return undefined
    default: {
      const _exhaustive: never = verdict.outcome
      throw new ModelReferenceResolutionError(`unhandled outcome ${String(_exhaustive)}`)
    }
  }
}

/** Named refusal for an OperationStatus this table did not enumerate. Reached
 *  only if OperationStatus gains a member without this file's inner switches
 *  being extended — the `never` guards make that a compile error first, so this
 *  is the run-time backstop for a hand-cast status that slipped past the types. */
function unhandledStatus(status: never): never {
  throw new ModelReferenceResolutionError(`unhandled op status ${String(status)}`)
}

/**
 * Apply a verdict to an op, returning a NEW op (or the SAME reference when
 * nothing changed). This is the DERIVED-COMPLETENESS domain: the full
 * OperationStatus x OpReresolveOutcome transition TABLE, enumerated cell by cell
 * with a compiler-enforced `never` guard per outcome so a future OperationStatus
 * member is a BUILD error, not a silent fall-through (WO CAM-1-R1 finding 4).
 *
 * The invariant across every cell: re-resolution only ever makes an op MORE
 * stale or degrades it; it NEVER greens an op up (never invents a toolpath or
 * lifts to 'ready'). The one stickiness exception — a 'degraded' op lifting to
 * 'outdated' — still lands on a NON-ready status that forces a recompute.
 *
 * Columns (outcome), rows (starting status). 'note' = the fallback/degraded
 * diagnostic (noteForVerdict); undefined for the two clean outcomes.
 *
 * AMENDED by the S5 audit DEFECT 1 ruling (2026-07-22, coordinator-ruled
 * amendment to this frozen table — charter wins over the original table):
 * the two 'ready'-origin cells that reach 'outdated' (stale-fallback and
 * stale-changed) now RETAIN toolpathMoves instead of clearing them. The
 * amber badge plus the ADR-0026 post-refusal gate already carry "do not
 * trust this"; blanking the viewport did not add safety, only lost the
 * pre-edit reference geometry. This also makes 'ready'->outdated consistent
 * with 'degraded', which already retained. The 'degraded'->outdated lift
 * cell under stale-changed is OUT of this ruling's scope (still clears) —
 * see its inline comment.
 *
 *                | degraded          | stale-fallback         | stale-changed        | untouched
 *   pending      | degraded, tp kept | +note                  | -note                | -note
 *   computing    | degraded, tp kept | +note                  | -note                | -note
 *   ready        | degraded, tp kept | outdated, tp KEPT,+note| outdated, tp KEPT,-note | -note (stays ready)
 *   error        | degraded, tp kept | +note                  | -note                | -note
 *   outdated     | degraded, tp kept | +note (FINDING-4 FIX)  | -note                | -note
 *   degraded     | (sticky, idemp.)  | sticky (stays degraded)| lift->outdated, -tp  | lift->outdated, tp kept
 *
 * "+note" attaches/updates the fallback note while KEEPING the (already non-ready)
 * status; "-note" drops any stale model-reference note on a clean resolution.
 * Both are idempotent (they return the same reference when nothing actually
 * changes). D3 stickiness: 'degraded' clears ONLY on a fully-exact re-resolution
 * (untouched/stale-changed), never on a fallback.
 */
export function applyVerdictToOp(op: Operation, verdict: OpReresolveVerdict): Operation {
  const note = noteForVerdict(verdict)
  switch (verdict.outcome) {
    case 'degraded': {
      // Geometry GONE -> degrade from ANY status, RETAIN the last-known toolpath
      // (never silently recompute, D2), set the note. Idempotent when already so.
      if (op.status === 'degraded' && op.modelReferenceNote === note) return op
      return { ...op, status: 'degraded', modelReferenceNote: note }
    }
    case 'stale-fallback': {
      // Approximate rebind (D2: any fallback yields a note naming the fallback ids).
      switch (op.status) {
        case 'ready':
          // A toolpath no longer trusted against the moved geometry -> outdated.
          // S5 audit DEFECT 1 ruling 2026-07-22 (coordinator amendment to this
          // frozen table): RETAIN toolpathMoves through ready->outdated. The
          // amber badge + the ADR-0026 post-refusal gate already carry the
          // "do not trust this" signal; blanking the viewport does not. This
          // also makes amber consistent with 'degraded' below, which retains.
          return { ...op, status: 'outdated', modelReferenceNote: note }
        case 'pending':
        case 'computing':
        case 'error':
        case 'outdated':
        // CAM-BINDING Stage 1: 'unsupported' ops never carry a ModelReference
        // yet (Stage 1 creates none - that starts at Stage 5), so this arm is
        // unreachable in practice today; grouped with the other non-ready,
        // no-trusted-toolpath statuses for the same reason they are, and so a
        // future stage that DOES attach a ModelReference to an 'unsupported'
        // op inherits correct behavior instead of a compile error.
        case 'unsupported':
          // Already non-ready: KEEP the status but attach/update the fallback note
          // (finding 4: an already-outdated op previously dropped the note). No
          // toolpath change (these carry no trusted toolpath). Idempotent.
          if (op.modelReferenceNote === note) return op
          return { ...op, modelReferenceNote: note }
        case 'degraded':
          // Sticky: a fallback is NOT a clean recovery, so a degraded op keeps its
          // stronger degraded status + note untouched.
          return op
        default:
          return unhandledStatus(op.status)
      }
    }
    case 'stale-changed': {
      // All ids exact but the body regenerated: a CLEAN resolution (no note), yet
      // the toolpath may no longer match the moved body.
      switch (op.status) {
        case 'ready':
          // S5 audit DEFECT 1 ruling 2026-07-22 (coordinator amendment to this
          // frozen table): RETAIN toolpathMoves through ready->outdated, same
          // rationale as the stale-fallback 'ready' arm above.
          return { ...op, status: 'outdated', modelReferenceNote: undefined }
        case 'degraded':
          // Clean success lifts sticky degraded; geometry moved so recompute.
          // Not covered by the S5 DEFECT 1 ruling (that ruling scopes only to
          // the 'ready'-origin transitions) - keeps its pre-existing clear.
          return { ...op, status: 'outdated', toolpathMoves: undefined, modelReferenceNote: undefined }
        case 'pending':
        case 'computing':
        case 'error':
        case 'outdated':
        case 'unsupported': // CAM-BINDING Stage 1: see stale-fallback's identical case for why.
          // Drop any now-inaccurate model-reference note; keep the status.
          if (op.modelReferenceNote === undefined) return op
          return { ...op, modelReferenceNote: undefined }
        default:
          return unhandledStatus(op.status)
      }
    }
    case 'untouched': {
      // Geometry identical: a 'ready' op's toolpath still matches.
      switch (op.status) {
        case 'degraded':
          // Sticky degraded clears on a fully-exact, unchanged re-resolution; the
          // retained toolpath is kept (geometry is identical) but a recompute is
          // still required to re-validate, so it lands on 'outdated'.
          return { ...op, status: 'outdated', modelReferenceNote: undefined }
        case 'ready':
        case 'pending':
        case 'computing':
        case 'error':
        case 'outdated':
        case 'unsupported': // CAM-BINDING Stage 1: see stale-fallback's identical case for why.
          // Drop any lingering note on an otherwise-current op; keep the status.
          if (op.modelReferenceNote === undefined) return op
          return { ...op, modelReferenceNote: undefined }
        default:
          return unhandledStatus(op.status)
      }
    }
    default: {
      const _exhaustive: never = verdict.outcome
      throw new ModelReferenceResolutionError(`unhandled outcome ${String(_exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level transform
// ---------------------------------------------------------------------------

export interface ReresolveResult {
  setups: Setup[]
  /** ids of ops whose status/note actually changed (for logging + tests). */
  changedOpIds: string[]
}

/**
 * Re-resolve every CAM op's ModelReferences against a batch of body
 * resolutions and return updated setups. Pure and total: it throws (never
 * partially applies) on any malformed input, so a caller that catches the throw
 * knows NOTHING was mutated. Ops without modelReferences are passed through by
 * identity (no allocation), so exactly the referencing ops can change.
 *
 * WO CAM-1-R1 finding 2 -- the POST-AWAIT USER-MUTATION guard. resolve() is
 * async; the caller (SolidsWorkbenchPage.fullResync) awaits it, and a user may
 * recompute/re-select/edit an op DURING that gap. This batch's outcomes were
 * computed against the model as it stood BEFORE the await, so applying them to
 * an op the user changed meanwhile would clobber fresh state (the auditor
 * reproduced exactly this: a seq=1 apply landing on a freshly-recomputed op,
 * flipping ready->outdated and dropping the new toolpath). `expectedOps` is the
 * fingerprint the caller captures BEFORE resolve(): opId -> the exact op
 * reference at capture time. When provided, a referencing op is re-flagged ONLY
 * if its CURRENT reference is byte-identical (===) to the captured one; any op
 * whose identity changed during the await -- or that did not exist at capture
 * (new op, absent from the map) -- is REFUSED (returned by identity), and the
 * NEXT regen re-resolves it cleanly. The store's monotonic-seq guard handles the
 * complementary regen-vs-regen ordering; this handles regen-vs-user-mutation.
 * The check runs BEFORE classifyOperation so a mutated/new op that references a
 * body absent from this (now-stale) batch is skipped, not a fail-loud throw.
 */
export function reresolveModelReferences(
  setups: Setup[],
  bodies: BodyResolution[],
  expectedOps?: ReadonlyMap<string, Operation>,
): ReresolveResult {
  const byBody = indexBodies(bodies)
  const bodyStatusCache = new Map<string, Map<string, ResolveStatus>>()
  const changedOpIds: string[] = []

  const nextSetups = setups.map((setup) => {
    let anyOpChanged = false
    const operations = setup.operations.map((op) => {
      // Fingerprint guard (finding 2): only ops that carry references can be
      // re-flagged; for those, an identity mismatch vs the pre-await capture
      // means a user mutation raced this resolve() -> refuse, keep the fresh op.
      if (
        expectedOps !== undefined &&
        (op.modelReferences?.length ?? 0) > 0 &&
        expectedOps.get(op.id) !== op
      ) {
        return op
      }
      const verdict = classifyOperation(op, byBody, bodyStatusCache)
      if (verdict === null) return op
      const nextOp = applyVerdictToOp(op, verdict)
      if (nextOp !== op) {
        anyOpChanged = true
        changedOpIds.push(op.id)
      }
      return nextOp
    })
    return anyOpChanged ? { ...setup, operations } : setup
  })

  return { setups: nextSetups, changedOpIds }
}
