// WO SKC-59-R1 (blocker C1): editing an angle dimension's VALUE must store the
// correctly SIGNED value so the geometry lands on the sector/side the user is
// looking at -- never the mirror branch.
//
// Operator's exact bug: a line directed +37deg carries a far/obtuse-sector angle
// dim reading 143 (SKC-58B convention: stored value=-143deg, reverseB=true). He
// types 120 into the value box. Both host accept paths WROTE the raw typed
// magnitude (+120) while retaining reverseB=true; the reversed-operand
// constraint then drove the line to directed -60 (the MIRROR of the intended
// +60) -- the dim still read 120, but the line jumped to the wrong side of the
// reference. (Compounded pre-b-fix by a length collapse, fixed separately.)
//
// THE FIX: signedAngleEditValue (dimTool.ts) is the SINGLE point of truth that
// normalizes a typed magnitude into the dim's existing signed convention. BOTH
// host accept paths (CAM store.commitDimensionValue and the workbench
// workbenchOverlaysPort.commitDimensionValue) call it, so they cannot diverge.
//
// This file proves the CAM half END-TO-END through the REAL store accept path
// (commitDimensionValue on the real useCamStore, real planegcs via a loopback
// worker), plus the pure-helper unit contract. The accept-path CENSUS lives in
// signedAngleAcceptPathCensus.ts/.test.ts (see the note below). The workbench
// half is proven through the real workbench mount in
// src/tests/model3d/workbenchSketchMount.test.ts.

type RecordedDispatch = { type: 'SOLVE_SKETCH' | 'DRAG_SOLVE'; requestId: string; sketch: Sketch }
type RecordedResponse = { requestId: string; ok: boolean }
const solveDispatches: RecordedDispatch[] = []
const solveResponses: RecordedResponse[] = []

class LoopbackWorker {
  onmessage: ((e: { data: import('../../lib/sketch/solver/protocol').SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: import('../../lib/sketch/solver/protocol').SketchWorkerRequestMsg): void {
    solveDispatches.push({ type: msg.type, requestId: msg.payload.requestId, sketch: msg.payload.sketch })
    void (async () => {
      const { createGcsWrapper } = await import('../../lib/planegcs/planegcsLoader')
      const { solveSketchOnWrapper } = await import('../../lib/sketch/solver/gcsMapping')
      const wrapper = await ensureWrapper(createGcsWrapper)
      const { requestId, sketch } = msg.payload
      const out = msg.type === 'DRAG_SOLVE'
        ? solveSketchOnWrapper(wrapper, sketch, msg.payload.drag)
        : solveSketchOnWrapper(wrapper, sketch)
      const data = out.ok
        ? { type: 'SKETCH_SOLVE_COMPLETE' as const, requestId,
            entities: out.entities, status: out.status, computeTimeMs: 0 }
        : { type: 'SKETCH_SOLVE_FAILED' as const, requestId,
            reason: out.reason, message: out.message, status: out.status }
      solveResponses.push({ requestId, ok: out.ok })
      this.onmessage?.({ data })
    })()
  }
  terminate(): void {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapperPromise: Promise<any> | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureWrapper(createGcsWrapper: () => Promise<any>): Promise<any> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Sketch, SketchDimension, SketchLineEntity } from '../../lib/sketch/types'
import { signedAngleEditValue } from '../../lib/sketch/tools/dimTool'

vi.stubGlobal('Worker', LoopbackWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let SKETCH_AXIS_X_ENTITY_ID: string

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ SKETCH_AXIS_X_ENTITY_ID } = await import('../../lib/sketch/sketchAnchors'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: { ...s.project, geometry: [] },
  }))
  solveDispatches.length = 0
  solveResponses.length = 0
})

const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI
function lineOf(sk: Sketch, id: string): SketchLineEntity {
  return sk.entities.find((e) => e.id === id) as SketchLineEntity
}
function lenOf(l: SketchLineEntity): number { return Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) }
function directedDeg(l1: SketchLineEntity, l2: SketchLineEntity): number {
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return deg(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))
}
async function waitForCorrelatedSolve(
  dispatchesBefore: number, matchSketch: (sketch: Sketch) => boolean,
): Promise<void> {
  const t0 = Date.now()
  const correlated = await new Promise<RecordedDispatch>((resolveP, reject) => {
    const poll = (): void => {
      const match = solveDispatches.slice(dispatchesBefore)
        .find((d) => d.type === 'SOLVE_SKETCH' && matchSketch(d.sketch))
      if (match) return resolveP(match)
      if (Date.now() - t0 > 10000) return reject(new Error('timeout: no correlated SOLVE_SKETCH dispatch'))
      setTimeout(poll, 10)
    }
    poll()
  })
  await new Promise<void>((resolveP, reject) => {
    const poll = (): void => {
      const response = solveResponses.find((r) => r.requestId === correlated.requestId)
      if (response) {
        if (!response.ok) return reject(new Error('correlated SOLVE_SKETCH resolved as a failed solve'))
        return resolveP()
      }
      if (Date.now() - t0 > 10000) return reject(new Error('timeout waiting for the correlated solve response'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

// ============================================================================
// UNIT: the shared single-point-of-truth (signedAngleEditValue)
// ============================================================================
describe('SKC-59-R1 C1: signedAngleEditValue is the shared signed convention', () => {
  const mkAngle = (value: number, reverseB: boolean): SketchDimension => ({
    id: 'a', kind: 'angle', driving: true, value, a: 'l1', b: 'l2',
    ...(reverseB ? { reverseB: true } : {}),
  })

  it('far/obtuse (reverseB=true, value=-143): a typed +120 magnitude stores -120 (same negative sector)', () => {
    expect(deg(signedAngleEditValue(mkAngle(rad(-143), true), rad(120)))).toBeCloseTo(-120, 9)
  })
  it('far below axis (reverseB=true, value=+143): a typed +120 stores +120 (same positive sector)', () => {
    expect(deg(signedAngleEditValue(mkAngle(rad(143), true), rad(120)))).toBeCloseTo(120, 9)
  })
  it('near positive (reverseB=false, value=+35): a typed +50 stays +50', () => {
    expect(deg(signedAngleEditValue(mkAngle(rad(35), false), rad(50)))).toBeCloseTo(50, 9)
  })
  it('near negative (reverseB=false, value=-35): a typed +50 stores -50 (same negative side)', () => {
    expect(deg(signedAngleEditValue(mkAngle(rad(-35), false), rad(50)))).toBeCloseTo(-50, 9)
  })
  it('is idempotent: a value already carrying the correct sign is unchanged', () => {
    const dim = mkAngle(rad(-143), true)
    expect(signedAngleEditValue(dim, rad(-120))).toBeCloseTo(rad(-120), 12) // sign(-143)*|-120| = -120
  })
  it('a typed magnitude that already carries the WRONG sign is normalized to the sector sign', () => {
    // The overlay always passes +mag, but prove the helper is sign-agnostic on input.
    expect(deg(signedAngleEditValue(mkAngle(rad(-143), true), rad(-120)))).toBeCloseTo(-120, 9)
  })
  it('non-angle dims are unsigned magnitudes -> returned unchanged', () => {
    const dist: SketchDimension = { id: 'd', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'l', site: 'start' }, b: { entityId: 'l', site: 'end' } }
    expect(signedAngleEditValue(dist, 25)).toBe(25)
    expect(signedAngleEditValue(dist, -25)).toBe(-25) // no angle sign logic applied
  })
})

// ============================================================================
// BEHAVIORAL (CAM host): Operator's exact far-sector edit through the REAL store
// accept path -- a POSITIVE typed magnitude lands the line on the SAME side.
// ============================================================================
describe('SKC-59-R1 C1/C3: CAM store.commitDimensionValue signs a far-sector edit correctly', () => {
  async function sampleMachineFarSketch(): Promise<string> {
    useCamStore.getState().setViewerMode('sketch') // injects the fixed axis X (operand a)
    // A free-length line directed +37deg, start fixed at origin, end free (Operator's collapse surface).
    useCamStore.getState().addEntity({
      id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
      end: { x: 40 * Math.cos(rad(37)), y: 40 * Math.sin(rad(37)) },
    })
    useCamStore.getState().addConstraint({ id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } })
    // The far/obtuse dim as a far label-drag stores it: value=-143 signed, reverseB=true.
    useCamStore.getState().addDimension({
      id: 'ang', kind: 'angle', driving: true, value: rad(-143), a: SKETCH_AXIS_X_ENTITY_ID, b: 'l2',
      reverseB: true, labelAnchor: { x: 3, y: 4 },
    })
    return useCamStore.getState().activeSketch!.layerId
  }

  it("typed 120 (positive) on Operator's -143/reverseB=true dim stores -120, rotates the line to +60 at full length (no mirror flip)", async () => {
    const layerId = await sampleMachineFarSketch()
    const dispatchesBefore = solveDispatches.length
    // THE REAL ACCEPT PATH: the overlay passes the POSITIVE typed magnitude.
    useCamStore.getState().commitDimensionValue('ang', rad(120))
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && Math.abs((sketch.dimensions.find((d) => d.id === 'ang')?.value ?? 0) - rad(-120)) < 1e-9)
    const sk = useCamStore.getState().activeSketch!
    const ang = sk.dimensions.find((d) => d.id === 'ang')!
    const axisX = lineOf(sk, SKETCH_AXIS_X_ENTITY_ID)
    const l2 = lineOf(sk, 'l2')
    const directed = directedDeg(axisX, l2)
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][CAM-ACCEPT] storedDeg=${deg(ang.value).toFixed(3)} ` +
      `reverseB=${(ang as SketchDimension & { reverseB?: boolean }).reverseB} ` +
      `directedDeg=${directed.toFixed(3)} lenMm=${lenOf(l2).toFixed(4)}`)
    expect(deg(ang.value)).toBeCloseTo(-120, 3)                                    // SIGNED store (was +120 = the bug)
    expect((ang as SketchDimension & { reverseB?: boolean }).reverseB).toBe(true)  // reverseB retained
    expect(Math.abs(deg(ang.value))).toBeCloseTo(120, 3)                           // label still reads 120
    expect(directed).toBeCloseTo(60, 2)                                            // SAME side -- NOT the -60 mirror
    expect(lenOf(l2)).toBeCloseTo(40, 2)                                           // length preserved (Operator's bar)
  })

  it("a NEAR-sector dim is unaffected: typed 120 on a +35/reverseB=false dim stores +120 and rotates to +120", async () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
      end: { x: 40 * Math.cos(rad(35)), y: 40 * Math.sin(rad(35)) },
    })
    useCamStore.getState().addConstraint({ id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } })
    useCamStore.getState().addDimension({
      id: 'ang', kind: 'angle', driving: true, value: rad(35), a: SKETCH_AXIS_X_ENTITY_ID, b: 'l2',
      labelAnchor: { x: 3, y: 2 },
    })
    const layerId = useCamStore.getState().activeSketch!.layerId
    const dispatchesBefore = solveDispatches.length
    useCamStore.getState().commitDimensionValue('ang', rad(120))
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && Math.abs((sketch.dimensions.find((d) => d.id === 'ang')?.value ?? 0) - rad(120)) < 1e-9)
    const sk = useCamStore.getState().activeSketch!
    const ang = sk.dimensions.find((d) => d.id === 'ang')!
    const directed = directedDeg(lineOf(sk, SKETCH_AXIS_X_ENTITY_ID), lineOf(sk, 'l2'))
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][CAM-ACCEPT-NEAR] storedDeg=${deg(ang.value).toFixed(3)} directedDeg=${directed.toFixed(3)} lenMm=${lenOf(lineOf(sk, 'l2')).toFixed(4)}`)
    expect(deg(ang.value)).toBeCloseTo(120, 3)   // near sector: positive typed == positive stored
    expect(directed).toBeCloseTo(120, 2)
    expect(lenOf(lineOf(sk, 'l2'))).toBeCloseTo(40, 2)
  })
})

// ============================================================================
// CENSUS (can-fail): the DERIVED accept-path set moved to its own file.
//
// WO SKC-59-R3 (audit MAJOR): the census that used to live here hand-anchored
// on two named function SIGNATURES (`commitDimensionValue:\s*\(dimId,\s*value\)`)
// plus a regex over the overlay file -- it proved those two specific spots
// still contained a specific substring, but had no mechanism to notice a NEW
// value-write site, and never classified the raw `setDimensionValue` sink at
// all (the audit's exact named gap). It is replaced by
// `signedAngleAcceptPathCensus.ts` + `.test.ts`, which mechanically derives
// EVERY `value:` write onto a SketchDimension across the AST (recursing into
// indirection via a named intermediate variable), requires each to be either
// SIGNED (verified by dataflow) or carry a human-reviewed NAMED reason, and
// names the one remaining disclosed gap explicitly rather than hiding it.
// See that file's header for the full derivation + exhaustiveness argument.
// ============================================================================
