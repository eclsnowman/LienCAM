// WO SKC-4 acceptance #4: interleaving invariant (ruling 4, standing rule) --
// no solve may apply a parameter value staler than the newest committed table
// state. One test per invariant, driven entirely through table.setExpression
// (never raw scheduler.markDirty/run), using the SAME deterministic slow-op
// mock-gate seam DOC-4's own interleaving test used
// (src/tests/doc/regen/_helpers.ts's makeGate) -- no wall-clock sleep
// anywhere. Real planegcs solve (Sketch3dSolveService) drives the actual
// re-solve each pass; only the OP's timing is gated, never its result.
import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../doc'
import type { FeatureOp } from '../../doc'
import {
  bindDimensionExpression,
  commitSketch3dDocument,
  createSketch3dSolveService,
  makeSketch3dExecutor,
  sketch3dNodeId,
  sketch3dPayloadOf,
} from '../../sketch3d'
import type { Sketch3dDistanceConstraint, Sketch3dDocument, Sketch3dPointRef, Sketch3dSolveService } from '../../sketch3d'
import { makeGate } from '../doc/regen/_helpers'

const openServices: Sketch3dSolveService[] = []
afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver(): Promise<Sketch3dSolveService> {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

function ref(entityId: string, site: Sketch3dPointRef['site']): Sketch3dPointRef {
  return { entityId, site }
}

function makeDoc(sketchId: string): Sketch3dDocument {
  const distance: Sketch3dDistanceConstraint = { id: 'd1', kind: 'distance', a: ref('p1', 'self'), b: ref('p2', 'self'), value: 1 }
  return {
    id: sketchId,
    entities: [
      { id: 'p1', kind: 'point', at: { x: 0, y: 0 } },
      { id: 'p2', kind: 'point', at: { x: 1, y: 0 } },
    ],
    constraints: [
      { id: 'fix1', kind: 'fixed', point: ref('p1', 'self') },
      { id: 'horiz', kind: 'horizontal', points: [ref('p1', 'self'), ref('p2', 'self')] },
      distance,
    ],
  }
}

function d1Value(document: Sketch3dDocument): number {
  const c = document.constraints.find((constraint) => constraint.id === 'd1')
  if (!c || c.kind !== 'distance') throw new Error('missing d1')
  return c.value
}

describe('ruling 4(a): a parameter edit committed while the sketch is mid-solve cancels that pass; the final solve uses the newest value', () => {
  it('never finishes "ok" against the stale in-flight value', async () => {
    const service = await solver()
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const sketchId = sketch3dNodeId('sk')
    const seenWidths: number[] = []
    const gate = makeGate()
    let armed = false
    const sketchExecutor: FeatureOp = async (node) => {
      if (node.id !== sketchId) return makeSketch3dExecutor(dag, service, scheduler)(node)
      if (armed) {
        gate.signalReached()
        await gate.gate
      }
      seenWidths.push(dag.getNode(paramNodeId('width'))?.payload.value as number)
      return makeSketch3dExecutor(dag, service, scheduler)(node)
    }
    const table = new ParameterTable(dag, scheduler, sketchExecutor)

    await table.setExpression('base', '10')
    await table.setExpression('width', '2*base+3')
    const bound = bindDimensionExpression(makeDoc('sk'), 'd1', 'width')
    if (!bound.ok) throw new Error('bind rejected')
    await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)
    expect(seenWidths).toEqual([23])
    expect(scheduler.statusOf(sketchId)).toBe('ok')

    // Arm the gate, then commit an edit whose pass will get the sketch in flight.
    armed = true
    const p1 = table.setExpression('base', '11')
    await gate.reached // the sketch's op is parked, having not yet read 'width'
    expect(scheduler.statusOf(sketchId)).toBe('running')
    expect(dag.getNode(paramNodeId('width'))?.payload.value).toBe(25) // recomputed earlier in THIS pass

    // A SECOND edit commits while the sketch's op for pass 1 is still in flight.
    const p2 = table.setExpression('base', '12')

    gate.release() // let pass 1's parked op resume; it reads whatever 'width' IS right now
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.pass?.cancelled).toBe(true)
    expect(r2.pass?.cancelled).toBe(false)

    // Final, committed state reflects ONLY the latest edit.
    expect(dag.getNode(paramNodeId('base'))?.payload.value).toBe(12)
    expect(dag.getNode(paramNodeId('width'))?.payload.value).toBe(27)
    const finalPayload = sketch3dPayloadOf(dag, 'sk')!
    expect(d1Value(finalPayload.document)).toBeCloseTo(27, 6)
    expect(finalPayload.solveResult?.status).toBe('success')
    expect(scheduler.statusOf(sketchId)).toBe('ok')
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])

    // The sketch's op WAS invoked for the cancelled pass too (already called
    // before cancellation was detected) -- but the scheduler never lets that
    // invocation's result commit as 'ok'. Exactly two 'ok' transitions exist
    // for the sketch node in the whole test: the initial build (23) and the
    // final committed pass (27); the discarded in-flight attempt (25, read
    // while base=11 was current but before pass 1 was cancelled) shows up in
    // seenWidths (proving it really ran) but never as a completed transition.
    expect(seenWidths).toEqual([23, 25, 27])
    const okTransitions = scheduler.transitions().filter((t) => t.id === sketchId && t.to === 'ok')
    expect(okTransitions.length).toBe(2)
  })
})

describe('ruling 4(b): rapid successive edits coalesce through the scheduler cancel/reschedule path', () => {
  it('three edits fired without awaiting between them collapse to exactly one real re-solve, using only the final value', async () => {
    const service = await solver()
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const sketchId = sketch3dNodeId('sk')
    const seenWidths: number[] = []
    const sketchExecutor: FeatureOp = async (node) => {
      if (node.id === sketchId) seenWidths.push(dag.getNode(paramNodeId('width'))?.payload.value as number)
      return makeSketch3dExecutor(dag, service, scheduler)(node)
    }
    const table = new ParameterTable(dag, scheduler, sketchExecutor)

    await table.setExpression('base', '10')
    await table.setExpression('width', '2*base+3')
    const bound = bindDimensionExpression(makeDoc('sk'), 'd1', 'width')
    if (!bound.ok) throw new Error('bind rejected')
    await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)
    expect(seenWidths).toEqual([23])

    // Fire three edits back-to-back with NO await between them.
    const p1 = table.setExpression('base', '11')
    const p2 = table.setExpression('base', '12')
    const p3 = table.setExpression('base', '13')
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    // Final committed state reflects ONLY the last edit (base=13 -> width=29).
    expect(dag.getNode(paramNodeId('base'))?.payload.value).toBe(13)
    expect(dag.getNode(paramNodeId('width'))?.payload.value).toBe(29)
    expect(scheduler.statusOf(sketchId)).toBe('ok')
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])

    // The sketch's op ran exactly once more (beyond the initial build) -- for
    // the FINAL value only. No pass ever re-solved against an intermediate
    // value (11 -> width 25, or 12 -> width 27): coalescing discarded them
    // before the op was ever called for them.
    expect(seenWidths).toEqual([23, 29])
    const finalPayload = sketch3dPayloadOf(dag, 'sk')!
    expect(d1Value(finalPayload.document)).toBeCloseTo(29, 6)

    // Exactly one of the three passes did the real work; the others found
    // nothing left dirty (the prior pass already drained the combined edit).
    const executedCounts = [r1, r2, r3].map((r) => r.pass?.executed.length ?? -1)
    expect(executedCounts.filter((n) => n > 0)).toEqual([3])
    expect(executedCounts.filter((n) => n === 0).length).toBe(2)
  })
})

describe('WO SKC-4-R1.2: a cancelled solve never writes stale sketch payload', () => {
  it("the stale in-flight solve's dag.setPayload write never lands, even transiently", async () => {
    const service = await solver()
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const sketchId = sketch3dNodeId('sk')
    const gate = makeGate()
    let armed = false
    const sketchExecutor: FeatureOp = async (node) => {
      if (node.id !== sketchId) return makeSketch3dExecutor(dag, service, scheduler)(node)
      if (armed) {
        gate.signalReached()
        await gate.gate
      }
      return makeSketch3dExecutor(dag, service, scheduler)(node)
    }
    const table = new ParameterTable(dag, scheduler, sketchExecutor)

    await table.setExpression('base', '10')
    await table.setExpression('width', '2*base+3')
    const bound = bindDimensionExpression(makeDoc('sk'), 'd1', 'width')
    if (!bound.ok) throw new Error('bind rejected')
    await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)
    expect(d1Value(sketch3dPayloadOf(dag, 'sk')!.document)).toBeCloseTo(23, 6)

    // Spy on every dag.setPayload call for the sketch node and record the
    // committed d1 value directly -- this sidesteps any microtask-ordering
    // fragility in trying to "catch" a stale value mid-flight with a timed
    // read, and instead proves the invariant literally: the cancelled pass's
    // solve (computed against the transiently-current width=25) must never
    // reach the dag at all, not even as a value later overwritten.
    const committedD1Values: number[] = []
    const originalSetPayload = dag.setPayload.bind(dag)
    dag.setPayload = (id: string, payload: Record<string, unknown>) => {
      if (id === sketchId) {
        const doc = (payload as { document?: Sketch3dDocument }).document
        if (doc) committedD1Values.push(d1Value(doc))
      }
      return originalSetPayload(id, payload)
    }

    // Arm the gate, then commit an edit whose pass will get the sketch in flight.
    armed = true
    const p1 = table.setExpression('base', '11')
    await gate.reached // the sketch's op is parked, having not yet read 'width'
    expect(dag.getNode(paramNodeId('width'))?.payload.value).toBe(25) // recomputed earlier in THIS pass

    // A SECOND edit commits while the sketch's op for pass 1 is still in flight.
    const p2 = table.setExpression('base', '12')

    gate.release() // let pass 1's parked op resume; it computes against the stale width=25
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.pass?.cancelled).toBe(true)
    expect(r2.pass?.cancelled).toBe(false)

    // The ONLY committed sketch payload write is the final, correct one
    // (width=27 -> d1=27). The cancelled pass's stale write (d1=25) never
    // landed on the dag -- not even as a value pass 2 later overwrote.
    expect(committedD1Values).toEqual([27])

    const finalPayload = sketch3dPayloadOf(dag, 'sk')!
    expect(d1Value(finalPayload.document)).toBeCloseTo(27, 6)
    expect(scheduler.statusOf(sketchId)).toBe('ok')
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])
  })
})
