// CAM-1 (D2) — pure re-resolution mapping. One test per enumerated outcome path,
// INCLUDING the fail-loud data-validation refusals (unknown status, missing id,
// NaN/absent fields) and the stickiness transitions. This file is the mutation
// proof target: breaking the lost->degraded arm (map lost->outdated) must make a
// NAMED test here fail (see the gate log / report).

import { describe, it, expect } from 'vitest'
import type { Operation, OperationStatus, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'
import type { ModelReference } from '../../lib/cam/types'
import {
  classifyOperation,
  applyVerdictToOp,
  reresolveModelReferences,
  indexBodies,
  referenceStableIds,
  ModelReferenceResolutionError,
  type BodyResolution,
  type RawResolution,
} from '../../lib/cam/modelReferenceResolution'

// ── minimal but type-complete fixtures ───────────────────────────────────────
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const MOVE: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 5 } as ToolpathMove

function ref(bodyId: string, stableIds: string[], role: ModelReference['role'] = 'machining-boundary'): ModelReference {
  return { bodyId, stableIds, role }
}

function makeOp(over: Partial<Operation> = {}): Operation {
  return {
    id: 'op-1', name: 'Contour', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    modelReferences: [ref('B1', ['f1'])],
    heights, passes, linking, params: {},
    toolpathMoves: [MOVE],
    ...over,
  }
}

function body(bodyId: string, changed: boolean, resolutions: RawResolution[]): BodyResolution {
  return { bodyId, changed, resolutions }
}
function res(id: string, status: string, extra: Partial<RawResolution> = {}): RawResolution {
  return { id, status, ...extra }
}

// ── classifyOperation: the four outcome arms + precedence ─────────────────────
describe('classifyOperation outcome mapping (exhaustive over exact/fallback/lost)', () => {
  it('all ids exact AND body unchanged -> untouched', () => {
    const byBody = indexBodies([body('B1', false, [res('f1', 'exact')])])
    expect(classifyOperation(makeOp(), byBody)?.outcome).toBe('untouched')
  })

  it('all ids exact BUT body regenerated -> stale-changed', () => {
    const byBody = indexBodies([body('B1', true, [res('f1', 'exact')])])
    expect(classifyOperation(makeOp(), byBody)?.outcome).toBe('stale-changed')
  })

  it('any id fallback -> stale-fallback, records which ids fell back', () => {
    const op = makeOp({ modelReferences: [ref('B1', ['f1', 'f2'])] })
    const byBody = indexBodies([body('B1', false, [res('f1', 'exact'), res('f2', 'fallback')])])
    const v = classifyOperation(op, byBody)
    expect(v?.outcome).toBe('stale-fallback')
    expect(v?.fallbackIds).toEqual(['f2'])
  })

  it('any id lost -> degraded, records lost ids + degraded body', () => {
    const op = makeOp({ modelReferences: [ref('B1', ['f1', 'f2'])] })
    const byBody = indexBodies([body('B1', false, [res('f1', 'exact'), res('f2', 'lost')])])
    const v = classifyOperation(op, byBody)
    expect(v?.outcome).toBe('degraded')
    expect(v?.lostIds).toEqual(['f2'])
    expect(v?.degradedBodies).toEqual(['B1'])
  })

  it('lost DOMINATES fallback and body-change (precedence: lost > fallback > changed)', () => {
    const op = makeOp({ modelReferences: [ref('B1', ['a', 'b', 'c'])] })
    const byBody = indexBodies([body('B1', true, [res('a', 'exact'), res('b', 'fallback'), res('c', 'lost')])])
    expect(classifyOperation(op, byBody)?.outcome).toBe('degraded')
  })

  it('fallback dominates a mere body-change (fallback > changed)', () => {
    const op = makeOp({ modelReferences: [ref('B1', ['a', 'b'])] })
    const byBody = indexBodies([body('B1', true, [res('a', 'exact'), res('b', 'fallback')])])
    expect(classifyOperation(op, byBody)?.outcome).toBe('stale-fallback')
  })

  it('an op with no modelReferences is skipped (null verdict) -> only referencing ops change', () => {
    const byBody = indexBodies([body('B1', true, [res('f1', 'exact')])])
    expect(classifyOperation(makeOp({ modelReferences: undefined }), byBody)).toBeNull()
    expect(classifyOperation(makeOp({ modelReferences: [] }), byBody)).toBeNull()
  })

  it('aggregates across multiple refs on one op (a lost on ANY body degrades)', () => {
    const op = makeOp({ modelReferences: [ref('B1', ['f1']), ref('B2', ['g1'])] })
    const byBody = indexBodies([
      body('B1', false, [res('f1', 'exact')]),
      body('B2', false, [res('g1', 'lost')]),
    ])
    const v = classifyOperation(op, byBody)
    expect(v?.outcome).toBe('degraded')
    expect(v?.degradedBodies).toEqual(['B2'])
  })
})

// ── fail-loud data validation (fail-closed rule): every refusal is BY NAME ────
describe('classifyOperation refuses malformed resolver data (never a silent skip)', () => {
  const opB1 = () => makeOp({ modelReferences: [ref('B1', ['f1'])] })

  it('unknown status string -> ModelReferenceResolutionError', () => {
    const byBody = indexBodies([body('B1', false, [res('f1', 'moved')])])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(ModelReferenceResolutionError)
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/unknown resolver status "moved"/)
  })

  it('a requested id missing from the reply -> refusal (not treated as exact)', () => {
    const byBody = indexBodies([body('B1', false, [res('other', 'exact')])])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/missing requested id "f1"/)
  })

  it('NaN localIndex -> refusal (NaN must be admitted nowhere)', () => {
    const byBody = indexBodies([body('B1', false, [res('f1', 'exact', { localIndex: NaN })])])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/non-finite\/negative localIndex/)
  })

  it('Infinity / negative / fractional localIndex -> refusal', () => {
    for (const bad of [Infinity, -1, 2.5]) {
      const byBody = indexBodies([body('B1', false, [res('f1', 'exact', { localIndex: bad })])])
      expect(() => classifyOperation(opB1(), byBody)).toThrow(ModelReferenceResolutionError)
    }
  })

  it('unknown subshape type -> refusal', () => {
    const byBody = indexBodies([body('B1', false, [res('f1', 'exact', { type: 'solid' })])])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/unknown subshape type "solid"/)
  })

  it('a referenced body absent from the batch -> refusal (caller must resolve every body)', () => {
    const byBody = indexBodies([body('OTHER', false, [res('x', 'exact')])])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/missing body "B1"/)
  })

  it('non-boolean changed field -> refusal', () => {
    const bad = { bodyId: 'B1', changed: 'yes' as unknown as boolean, resolutions: [res('f1', 'exact')] }
    const byBody = indexBodies([bad])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/non-boolean "changed"/)
  })

  it('duplicate id in the reply -> refusal (ambiguous resolution)', () => {
    const byBody = indexBodies([body('B1', false, [res('f1', 'exact'), res('f1', 'lost')])])
    expect(() => classifyOperation(opB1(), byBody)).toThrow(/returned id "f1" more than once/)
  })

  it('a ref with empty stableIds -> refusal', () => {
    const op = makeOp({ modelReferences: [ref('B1', [])] })
    const byBody = indexBodies([body('B1', false, [])])
    expect(() => classifyOperation(op, byBody)).toThrow(/no stableIds/)
  })

  it('indexBodies refuses a duplicate body in the batch', () => {
    expect(() => indexBodies([body('B1', false, []), body('B1', true, [])])).toThrow(/listed body "B1" twice/)
  })
})

// ── applyVerdictToOp: status transitions + D3 stickiness ──────────────────────
describe('applyVerdictToOp transitions', () => {
  it('degraded verdict flags degraded AND RETAINS the toolpath (never silently recomputes)', () => {
    const op = makeOp({ status: 'ready', toolpathMoves: [MOVE] })
    const next = applyVerdictToOp(op, { outcome: 'degraded', fallbackIds: [], lostIds: ['f1'], degradedBodies: ['B1'] })
    expect(next.status).toBe('degraded')
    expect(next.toolpathMoves).toEqual([MOVE]) // retained
    expect(next.modelReferenceNote).toMatch(/removed/)
  })

  it('stale-changed on a ready op -> outdated, toolpath RETAINED (S5 audit DEFECT 1 ruling 2026-07-22: charter wins over this frozen table)', () => {
    const op = makeOp({ status: 'ready', toolpathMoves: [MOVE] })
    const next = applyVerdictToOp(op, { outcome: 'stale-changed', fallbackIds: [], lostIds: [], degradedBodies: [] })
    expect(next.status).toBe('outdated')
    expect(next.toolpathMoves).toEqual([MOVE])
  })

  it('stale-fallback on a ready op -> outdated + note listing the fallback ids', () => {
    const op = makeOp({ status: 'ready' })
    const next = applyVerdictToOp(op, { outcome: 'stale-fallback', fallbackIds: ['f2'], lostIds: [], degradedBodies: [] })
    expect(next.status).toBe('outdated')
    expect(next.modelReferenceNote).toMatch(/f2/)
  })

  it('untouched on a ready op -> unchanged reference (no churn)', () => {
    const op = makeOp({ status: 'ready', modelReferenceNote: undefined })
    const next = applyVerdictToOp(op, { outcome: 'untouched', fallbackIds: [], lostIds: [], degradedBodies: [] })
    expect(next).toBe(op)
  })

  it('STICKY: a degraded op stays degraded under a stale-fallback verdict (not a clean success)', () => {
    const op = makeOp({ status: 'degraded', toolpathMoves: [MOVE], modelReferenceNote: 'gone' })
    const next = applyVerdictToOp(op, { outcome: 'stale-fallback', fallbackIds: ['f2'], lostIds: [], degradedBodies: [] })
    expect(next.status).toBe('degraded')
    expect(next.toolpathMoves).toEqual([MOVE])
  })

  it('STICKY CLEAR: a degraded op clears to outdated on a fully-exact unchanged re-resolution', () => {
    const op = makeOp({ status: 'degraded', modelReferenceNote: 'gone' })
    const next = applyVerdictToOp(op, { outcome: 'untouched', fallbackIds: [], lostIds: [], degradedBodies: [] })
    expect(next.status).toBe('outdated')
    expect(next.modelReferenceNote).toBeUndefined()
  })

  it('STICKY CLEAR: a degraded op clears to outdated on stale-changed (all exact, geometry moved)', () => {
    const op = makeOp({ status: 'degraded', modelReferenceNote: 'gone' })
    const next = applyVerdictToOp(op, { outcome: 'stale-changed', fallbackIds: [], lostIds: [], degradedBodies: [] })
    expect(next.status).toBe('outdated')
  })

  it('an already-degraded op with the SAME note is returned by identity (idempotent)', () => {
    const verdict = { outcome: 'degraded' as const, fallbackIds: [], lostIds: ['f1'], degradedBodies: ['B1'] }
    const first = applyVerdictToOp(makeOp({ status: 'ready' }), verdict)
    const again = applyVerdictToOp(first, verdict)
    expect(again).toBe(first)
  })
})

// ── EXHAUSTIVE transition TABLE (WO CAM-1-R1 finding 4) ───────────────────────
// The derived-completeness domain: every OperationStatus x OpReresolveOutcome
// cell is asserted, so the fallback note now attaches from EVERY starting status
// (finding 4's outdated-drops-note bug is cell [outdated x stale-fallback]) and
// degraded stickiness is enumerated, not implied. A new OperationStatus member
// must extend both this table AND the compiler-enforced `never` guards in
// applyVerdictToOp; ALL_STATUSES below is asserted equal to the type's members.
describe('applyVerdictToOp: exhaustive OperationStatus x outcome table', () => {
  const ALL_STATUSES: OperationStatus[] = ['pending', 'computing', 'ready', 'error', 'outdated', 'degraded']

  const verdicts = {
    degraded: { outcome: 'degraded' as const, fallbackIds: [], lostIds: ['f1'], degradedBodies: ['B1'] },
    'stale-fallback': { outcome: 'stale-fallback' as const, fallbackIds: ['f2'], lostIds: [], degradedBodies: [] },
    'stale-changed': { outcome: 'stale-changed' as const, fallbackIds: [], lostIds: [], degradedBodies: [] },
    untouched: { outcome: 'untouched' as const, fallbackIds: [], lostIds: [], degradedBodies: [] },
  }

  type NoteExp = 'degraded' | 'fallback' | 'cleared' | 'identity'
  type ToolpathExp = 'kept' | 'cleared'
  interface Cell { status: OperationStatus; expStatus: OperationStatus; note: NoteExp; tp: ToolpathExp }

  // Each op starts with a PRE-EXISTING note + a toolpath so a 'cleared' expectation
  // proves the arm actually dropped the note (vs never having one).
  const PRE = 'PRE-EXISTING NOTE'

  const TABLE: Record<keyof typeof verdicts, Cell[]> = {
    degraded: [
      // Geometry GONE -> degrade from ANY status, retain toolpath, set the note.
      { status: 'pending', expStatus: 'degraded', note: 'degraded', tp: 'kept' },
      { status: 'computing', expStatus: 'degraded', note: 'degraded', tp: 'kept' },
      { status: 'ready', expStatus: 'degraded', note: 'degraded', tp: 'kept' },
      { status: 'error', expStatus: 'degraded', note: 'degraded', tp: 'kept' },
      { status: 'outdated', expStatus: 'degraded', note: 'degraded', tp: 'kept' },
      { status: 'degraded', expStatus: 'degraded', note: 'degraded', tp: 'kept' },
    ],
    'stale-fallback': [
      // D2: any fallback yields a note naming the fallback ids, from EVERY status.
      { status: 'pending', expStatus: 'pending', note: 'fallback', tp: 'kept' },
      { status: 'computing', expStatus: 'computing', note: 'fallback', tp: 'kept' },
      // S5 audit DEFECT 1 ruling 2026-07-22 (coordinator amendment to this frozen
      // table): ready->outdated now RETAINS the toolpath, was 'cleared'.
      { status: 'ready', expStatus: 'outdated', note: 'fallback', tp: 'kept' },
      { status: 'error', expStatus: 'error', note: 'fallback', tp: 'kept' },
      // FINDING-4 CELL: an already-outdated op previously dropped the note.
      { status: 'outdated', expStatus: 'outdated', note: 'fallback', tp: 'kept' },
      // Sticky: degraded is not lifted by a fallback (identity, keeps its note).
      { status: 'degraded', expStatus: 'degraded', note: 'identity', tp: 'kept' },
    ],
    'stale-changed': [
      // All ids exact but body regenerated: clean (no note), drop stale notes.
      { status: 'pending', expStatus: 'pending', note: 'cleared', tp: 'kept' },
      { status: 'computing', expStatus: 'computing', note: 'cleared', tp: 'kept' },
      // S5 audit DEFECT 1 ruling 2026-07-22 (coordinator amendment to this frozen
      // table): ready->outdated now RETAINS the toolpath, was 'cleared'.
      { status: 'ready', expStatus: 'outdated', note: 'cleared', tp: 'kept' },
      { status: 'error', expStatus: 'error', note: 'cleared', tp: 'kept' },
      { status: 'outdated', expStatus: 'outdated', note: 'cleared', tp: 'kept' },
      // NOT covered by the S5 ruling (scoped to 'ready'-origin transitions only):
      // the degraded->outdated lift still clears the toolpath.
      { status: 'degraded', expStatus: 'outdated', note: 'cleared', tp: 'cleared' }, // sticky lifts
    ],
    untouched: [
      // Geometry identical: a ready op stays ready; degraded lifts (tp kept).
      { status: 'pending', expStatus: 'pending', note: 'cleared', tp: 'kept' },
      { status: 'computing', expStatus: 'computing', note: 'cleared', tp: 'kept' },
      { status: 'ready', expStatus: 'ready', note: 'cleared', tp: 'kept' },
      { status: 'error', expStatus: 'error', note: 'cleared', tp: 'kept' },
      { status: 'outdated', expStatus: 'outdated', note: 'cleared', tp: 'kept' },
      { status: 'degraded', expStatus: 'outdated', note: 'cleared', tp: 'kept' }, // sticky lifts, tp kept
    ],
  }

  it('the table covers every OperationStatus (no status omitted from the domain)', () => {
    for (const outcome of Object.keys(TABLE) as (keyof typeof verdicts)[]) {
      expect(TABLE[outcome].map((c) => c.status).sort()).toEqual([...ALL_STATUSES].sort())
    }
  })

  for (const outcome of Object.keys(TABLE) as (keyof typeof verdicts)[]) {
    for (const cell of TABLE[outcome]) {
      it(`[${cell.status} x ${outcome}] -> ${cell.expStatus} (note:${cell.note}, tp:${cell.tp})`, () => {
        const op = makeOp({ status: cell.status, toolpathMoves: [MOVE], modelReferenceNote: PRE })
        const next = applyVerdictToOp(op, verdicts[outcome])

        expect(next.status).toBe(cell.expStatus)

        if (cell.tp === 'kept') expect(next.toolpathMoves).toEqual([MOVE])
        else expect(next.toolpathMoves).toBeUndefined()

        switch (cell.note) {
          case 'degraded':
            expect(next.modelReferenceNote).toMatch(/removed/)
            break
          case 'fallback':
            expect(next.modelReferenceNote).toMatch(/re-bound approximately/)
            expect(next.modelReferenceNote).toContain('f2')
            break
          case 'cleared':
            expect(next.modelReferenceNote).toBeUndefined()
            break
          case 'identity':
            expect(next).toBe(op) // returned by reference, its prior note intact
            expect(next.modelReferenceNote).toBe(PRE)
            break
        }
      })
    }
  }

  it('the clean-outcome note-clear arms are IDENTITY when there is nothing to clear', () => {
    // pending/computing/error/outdated with no pre-existing note under a clean
    // outcome must return the SAME reference (no churn), the counterpart to the
    // note-attach idempotency proven above.
    for (const status of ['pending', 'computing', 'error', 'outdated'] as OperationStatus[]) {
      const op = makeOp({ status, modelReferenceNote: undefined })
      expect(applyVerdictToOp(op, verdicts.untouched)).toBe(op)
      expect(applyVerdictToOp(op, verdicts['stale-changed'])).toBe(op)
    }
  })

  it('the fallback note-attach arms are IDENTITY when the same note is already set', () => {
    for (const status of ['pending', 'computing', 'error', 'outdated'] as OperationStatus[]) {
      const first = applyVerdictToOp(makeOp({ status, modelReferenceNote: undefined }), verdicts['stale-fallback'])
      const again = applyVerdictToOp(first, verdicts['stale-fallback'])
      expect(again).toBe(first)
    }
  })
})

// ── top-level transform: flips EXACTLY the referencing ops ────────────────────
describe('reresolveModelReferences (Setup[] -> Setup[])', () => {
  it('flips only the referencing op; a non-referencing op is identity-preserved', () => {
    const referencing = makeOp({ id: 'op-ref', status: 'ready', modelReferences: [ref('B1', ['f1'])] })
    const untouched = makeOp({ id: 'op-plain', status: 'ready', modelReferences: undefined })
    const setup = { id: 's1', name: 'S1', wcs: {} as never, stock: {} as never, operations: [referencing, untouched], notes: '' }
    const { setups, changedOpIds } = reresolveModelReferences([setup], [body('B1', false, [res('f1', 'lost')])])
    expect(changedOpIds).toEqual(['op-ref'])
    expect(setups[0].operations[0].status).toBe('degraded')
    expect(setups[0].operations[1]).toBe(untouched) // identity preserved
  })

  it('throws (mutating nothing) on a malformed reply for any op', () => {
    const op = makeOp({ id: 'op-ref', modelReferences: [ref('B1', ['f1'])] })
    const setup = { id: 's1', name: 'S1', wcs: {} as never, stock: {} as never, operations: [op], notes: '' }
    expect(() => reresolveModelReferences([setup], [body('B1', false, [res('f1', 'bogus')])]))
      .toThrow(ModelReferenceResolutionError)
  })
})

// ── STABLEIDS-GUARD-RERESOLVE (MODEL-ROW-CITIZEN batch 1) ────────────────────
// referenceStableIds is the guard the SolidsWorkbenchPage reresolve GATHER path
// uses before iterating ref.stableIds. It must refuse malformed references BY
// NAME (ModelReferenceResolutionError), never let a bare for-of throw a cryptic
// "not iterable". MUTATION proof: replace the guard's throws with `return
// (ref.stableIds as string[]) ?? []` and the four refusal cases below go RED.
describe('referenceStableIds: named refusal, never a raw "not iterable"', () => {
  it('returns the ids for a well-formed reference (with context echoed only on failure)', () => {
    expect(referenceStableIds({ bodyId: 'B1', stableIds: ['f1', 'f2'] }, 'op "op-1"')).toEqual(['f1', 'f2'])
  })

  it('missing stableIds (undefined) -> named refusal, NOT a TypeError', () => {
    let err: unknown
    try { referenceStableIds({ bodyId: 'B1' }, 'op "op-1"') } catch (e) { err = e }
    expect(err).toBeInstanceOf(ModelReferenceResolutionError)
    expect((err as Error).message).toMatch(/no stableIds/)
    expect((err as Error).message).not.toMatch(/not iterable/)
    expect((err as Error).message).toContain('op "op-1"')
  })

  it('non-array stableIds -> named refusal', () => {
    expect(() => referenceStableIds({ bodyId: 'B1', stableIds: 'f1' }))
      .toThrow(ModelReferenceResolutionError)
  })

  it('empty stableIds array -> named refusal', () => {
    expect(() => referenceStableIds({ bodyId: 'B1', stableIds: [] }))
      .toThrow(/no stableIds/)
  })

  it('a non-string id inside stableIds -> named refusal', () => {
    expect(() => referenceStableIds({ bodyId: 'B1', stableIds: ['f1', 42 as unknown as string] }))
      .toThrow(/missing\/empty stableId/)
  })

  it('missing/empty bodyId -> named refusal', () => {
    expect(() => referenceStableIds({ bodyId: '', stableIds: ['f1'] }))
      .toThrow(/missing\/empty bodyId/)
  })
})
