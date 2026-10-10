// WO SKC-4 acceptance #1 (driving dimension literal + expression), #2
// (reactive rebind through the DOC scheduler), #3 (expression errors degrade
// honestly). Real planegcs solve (Sketch3dSolveService) + a real
// FeatureDag/RegenScheduler/ParameterTable (DOC-4/DOC-5) driving a real
// makeSketch3dExecutor -- no mocked solve, no bespoke regen side channel.
import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../doc'
import {
  bindDimensionExpression,
  commitSketch3dDocument,
  createSketch3dSolveService,
  makeSketch3dExecutor,
  sketch3dNodeId,
  sketch3dPayloadOf,
} from '../../sketch3d'
import type {
  Sketch3dDistanceConstraint,
  Sketch3dDocument,
  Sketch3dPointEntity,
  Sketch3dPointRef,
  Sketch3dSolveService,
} from '../../sketch3d'

const openServices: Sketch3dSolveService[] = []
afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function build() {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  const dag = new FeatureDag()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  const table = new ParameterTable(dag, scheduler, makeSketch3dExecutor(dag, service, scheduler))
  return { service, dag, scheduler, table }
}

function ref(entityId: string, site: Sketch3dPointRef['site']): Sketch3dPointRef {
  return { entityId, site }
}

/** p1 fixed at the origin, p2 free but held horizontal to p1 -- a single
 *  distance dimension ('d1') is the only remaining DOF, so a driving value
 *  fully constrains the sketch (dof 0) and lands p2 at exactly that distance
 *  along +x. */
function makeDoc(sketchId: string, distanceValue: number, expression?: string): Sketch3dDocument {
  const distance: Sketch3dDistanceConstraint = {
    id: 'd1',
    kind: 'distance',
    a: ref('p1', 'self'),
    b: ref('p2', 'self'),
    value: distanceValue,
    ...(expression !== undefined ? { expression } : {}),
  }
  return {
    id: sketchId,
    entities: [
      { id: 'p1', kind: 'point', at: { x: 0, y: 0 } },
      { id: 'p2', kind: 'point', at: { x: distanceValue || 1, y: 0 } },
    ],
    constraints: [
      { id: 'fix1', kind: 'fixed', point: ref('p1', 'self') },
      { id: 'horiz', kind: 'horizontal', points: [ref('p1', 'self'), ref('p2', 'self')] },
      distance,
    ],
  }
}

function p2Of(document: Sketch3dDocument): Sketch3dPointEntity {
  const e = document.entities.find((entity) => entity.id === 'p2')
  if (!e || e.kind !== 'point') throw new Error('missing p2 point entity')
  return e
}

function d1Of(document: Sketch3dDocument): Sketch3dDistanceConstraint {
  const c = document.constraints.find((constraint) => constraint.id === 'd1')
  if (!c || c.kind !== 'distance') throw new Error('missing d1 distance constraint')
  return c
}

describe('SKC-4 AC #1: driving dimensions', () => {
  it('a literal distance value drives the solve: entity lands at 25mm, DOF drops to 0', async () => {
    const { service } = await build()
    const result = service.solve(makeDoc('sk-literal', 25))
    expect(result.status).toBe('success')
    expect(result.dof).toBe(0)
    const p2 = result.entities.find((e) => e.id === 'p2')
    if (!p2 || p2.kind !== 'point') throw new Error('missing p2')
    expect(p2.at.x).toBeCloseTo(25, 6)
    expect(p2.at.y).toBeCloseTo(0, 6)
  })

  it('an expression-bound dimension ("2*base+3", base=10) solves to 23mm through the parameter table', async () => {
    const { dag, scheduler, table } = await build()
    await table.setExpression('base', '10')

    const doc = makeDoc('sk-expr', 0)
    const bound = bindDimensionExpression(doc, 'd1', '2*base+3')
    if (!bound.ok) throw new Error('bind rejected: ' + JSON.stringify(bound.diag))

    const pass = await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)
    expect(pass.executed).toContain(sketch3dNodeId('sk-expr'))
    expect(scheduler.statusOf(sketch3dNodeId('sk-expr'))).toBe('ok')

    const payload = sketch3dPayloadOf(dag, 'sk-expr')
    if (!payload) throw new Error('missing sketch3d payload')
    expect(d1Of(payload.document).value).toBeCloseTo(23, 6)
    expect(p2Of(payload.document).at.x).toBeCloseTo(23, 6)
    expect(payload.solveResult?.dof).toBe(0)
  })
})

describe('SKC-4 AC #2: reactive rebind', () => {
  it('editing base 10 -> 12 re-solves the sketch to 27mm WITHOUT recreating the dimension, through the DOC scheduler', async () => {
    const { dag, scheduler, table } = await build()
    await table.setExpression('base', '10')
    const bound = bindDimensionExpression(makeDoc('sk-rebind', 0), 'd1', '2*base+3')
    if (!bound.ok) throw new Error('bind rejected')
    await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)
    expect(p2Of(sketch3dPayloadOf(dag, 'sk-rebind')!.document).at.x).toBeCloseTo(23, 6)

    const outcome = await table.setExpression('base', '12')

    // Order-log proof (AC #2): the regen/dirty path is the DOC scheduler's own
    // markDirty/run pass -- no bespoke side channel. Exactly the parameter
    // then the sketch node executed, in topological order, in ONE pass.
    expect(outcome.pass?.executed).toEqual([paramNodeId('base'), sketch3dNodeId('sk-rebind')])
    expect(outcome.pass?.cancelled).toBe(false)

    const payload = sketch3dPayloadOf(dag, 'sk-rebind')!
    expect(d1Of(payload.document).value).toBeCloseTo(27, 6)
    expect(p2Of(payload.document).at.x).toBeCloseTo(27, 6)
    // the SAME dimension, same id, same expression -- never recreated.
    expect(d1Of(payload.document).expression).toBe('2*base+3')
    expect(scheduler.statusOf(sketch3dNodeId('sk-rebind'))).toBe('ok')
  })
})

describe('SKC-4 AC #3: expression errors degrade honestly', () => {
  it('binding "2*missing" (a parameter that does not exist) degrades the sketch, retaining the last-good value; fixing the table heals it', async () => {
    const { dag, scheduler, table } = await build()

    // Start solved and healthy with a plain literal.
    await commitSketch3dDocument(dag, scheduler, table.executor, makeDoc('sk-missing', 25))
    expect(scheduler.statusOf(sketch3dNodeId('sk-missing'))).toBe('ok')
    let payload = sketch3dPayloadOf(dag, 'sk-missing')!
    expect(d1Of(payload.document).value).toBeCloseTo(25, 6)

    const bound = bindDimensionExpression(payload.document, 'd1', '2*missing')
    if (!bound.ok) throw new Error('bind rejected: ' + JSON.stringify(bound.diag))
    await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)

    // FAILS-IF guard: never silently 0, never drops the constraint.
    payload = sketch3dPayloadOf(dag, 'sk-missing')!
    const d1 = d1Of(payload.document)
    expect(d1).toBeDefined()
    expect(d1.value).toBeCloseTo(25, 6)
    expect(d1.expression).toBe('2*missing')
    // The sketch is flagged stale (degraded), not silently still 'ok' on an
    // input that doesn't exist -- DOC-4-R1.1's own upstream-missing isolation,
    // reused here for free (no bespoke sketch3d-local mechanism).
    expect(scheduler.statusOf(sketch3dNodeId('sk-missing'))).toBe('degraded')

    // R1.1: the user must see WHICH dimension failed and WHY, not just a
    // sketch-level "degraded" -- makeSketch3dExecutor never got to run (the
    // scheduler skipped it before the kernel op), so this diagnostic MUST
    // come from commitSketch3dDocument's own commit-time evaluation.
    expect(payload.dimensionDiagnostics).toHaveLength(1)
    expect(payload.dimensionDiagnostics[0].constraintId).toBe('d1')
    expect(payload.dimensionDiagnostics[0].diag.code).toBe('PARAM_UNKNOWN_REFERENCE')

    // Fixing the table (creating 'missing') heals it -- the sketch's forward
    // reference resolves and it re-solves automatically.
    await table.setExpression('missing', '5')
    expect(scheduler.statusOf(sketch3dNodeId('sk-missing'))).toBe('ok')
    payload = sketch3dPayloadOf(dag, 'sk-missing')!
    expect(d1Of(payload.document).value).toBeCloseTo(10, 6)
    expect(p2Of(payload.document).at.x).toBeCloseTo(10, 6)
    // Healed through the normal scheduler path (makeSketch3dExecutor ran and
    // recomputed the SAME diagnostic evaluation fresh): the typed diagnostic clears.
    expect(payload.dimensionDiagnostics).toHaveLength(0)
  })

  it('a division-by-zero against an EXISTING parameter keeps the sketch solvable (status ok) with a typed per-dimension diagnostic, last-good value retained', async () => {
    const { dag, scheduler, table } = await build()
    await table.setExpression('divisor', '2')

    const bound = bindDimensionExpression(makeDoc('sk-divzero', 0), 'd1', '50/divisor')
    if (!bound.ok) throw new Error('bind rejected')
    await commitSketch3dDocument(dag, scheduler, table.executor, bound.document)
    expect(d1Of(sketch3dPayloadOf(dag, 'sk-divzero')!.document).value).toBeCloseTo(25, 6)

    await table.setExpression('divisor', '0')

    // The referenced parameter exists and is itself 'ok' (0 is a perfectly
    // valid parameter value) -- only THIS dimension's own division blows up,
    // so the scheduler's upstream-failed/missing isolation never fires; our
    // own evaluateDrivingDimensions path is what catches it.
    expect(scheduler.statusOf(sketch3dNodeId('sk-divzero'))).toBe('ok')
    const payload = sketch3dPayloadOf(dag, 'sk-divzero')!
    expect(d1Of(payload.document).value).toBeCloseTo(25, 6) // never silently 0
    expect(payload.dimensionDiagnostics).toHaveLength(1)
    expect(payload.dimensionDiagnostics[0].constraintId).toBe('d1')
    expect(payload.dimensionDiagnostics[0].diag.code).toBe('PARAM_DIVISION_BY_ZERO')

    // Healing: fix the divisor back to a nonzero value.
    await table.setExpression('divisor', '5')
    expect(scheduler.statusOf(sketch3dNodeId('sk-divzero'))).toBe('ok')
    const healed = sketch3dPayloadOf(dag, 'sk-divzero')!
    expect(d1Of(healed.document).value).toBeCloseTo(10, 6)
    expect(healed.dimensionDiagnostics).toHaveLength(0)
  })
})
