// DISPOSAL SOAK TEST - the behavioral half of the criterion-7 leak guard
// (companion to the dispose-contract test in solveService.test.ts; design ruling in
// coordination/DECISIONS.md 2026-07-07 "SKC-1 two-bounce root cause").
//
// CALIBRATION, measured 2026-07-07 against planegcs on this build: the wasm heap is a
// fixed 16 MB. A loop that creates+solves 60-line chain documents WITHOUT disposing
// hits "Aborted(OOM)" at iteration ~101 (reproduced; surfaces as result.status
// 'failed'). Therefore 150 iterations WITH disposal below cannot pass if dispose()
// leaks the native system - the loop would OOM before finishing. Do not shrink the
// iteration count or the document below these calibrated values.
//
// Kept in its own file: if this ever fails, the wasm module may be OOM-poisoned for
// anything that runs after it in the same process.
import { describe, expect, it } from 'vitest'
import { createSketch3dSolveService } from '../../sketch3d'
import type { Sketch3dConstraint, Sketch3dDocument, Sketch3dEntity } from '../../sketch3d'

const LINES = 60
const ITERATIONS = 150 // leak-variant OOMs at ~101 (see calibration note)

function chainDocument(lineCount: number): Sketch3dDocument {
  const entities: Sketch3dEntity[] = []
  const constraints: Sketch3dConstraint[] = []
  for (let i = 0; i < lineCount; i++) {
    entities.push({ id: `l${i}`, kind: 'line', start: { x: i, y: 0.1 * i }, end: { x: i + 1, y: 0.1 * i + 0.5 } })
    if (i > 0) {
      constraints.push({
        id: `c${i}`,
        kind: 'coincident',
        a: { entityId: `l${i - 1}`, site: 'end' },
        b: { entityId: `l${i}`, site: 'start' },
      })
    }
  }
  return { id: 'disposal-soak', entities, constraints }
}

describe('sketch3d solver disposal soak', () => {
  it(`survives ${ITERATIONS} heavy create/solve/dispose cycles (leaking dispose provably OOMs at ~101)`, async () => {
    const doc = chainDocument(LINES)
    let referenceDof = -1
    for (let i = 0; i < ITERATIONS; i++) {
      const service = await createSketch3dSolveService()
      try {
        const result = service.solve(doc)
        expect(result.status, `iteration ${i}: ${result.error ?? ''}`).toBe('success')
        if (i === 0) referenceDof = result.dof
        else expect(result.dof, `iteration ${i} dof drifted`).toBe(referenceDof)
      } finally {
        service.dispose()
      }
    }
  }, 120000)
})
