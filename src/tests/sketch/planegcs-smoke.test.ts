// Smoke test: @salusoft89/planegcs instantiates under vitest (node) through
// our loader. This existing-first gate is what makes the rest of the sketch
// solver testable headless — if WASM loading breaks (package update, vite
// asset handling change), this fails before any mapping/worker test confuses
// the diagnosis.

import { describe, it, expect } from 'vitest'
import { Algorithm, SolveStatus } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'

describe('planegcs loading (node)', () => {
  it('instantiates the WASM module and solves a trivial system', async () => {
    const gcs = await createGcsWrapper()

    // Two free points + a coincident constraint: the smallest system that
    // exercises push -> solve -> apply -> pull end to end.
    gcs.push_primitives_and_params([
      { id: 'p1', type: 'point', x: 0, y: 0, fixed: false },
      { id: 'p2', type: 'point', x: 10, y: 5, fixed: false },
      { id: 'c1', type: 'p2p_coincident', p1_id: 'p1', p2_id: 'p2' },
    ])

    const status = gcs.solve(Algorithm.DogLeg)
    expect(status).toBe(SolveStatus.Success)

    gcs.apply_solution()
    const p1 = gcs.sketch_index.get_sketch_point('p1')
    const p2 = gcs.sketch_index.get_sketch_point('p2')
    expect(p1.x).toBeCloseTo(p2.x, 9)
    expect(p1.y).toBeCloseTo(p2.y, 9)

    // DoF diagnosis is the core of the fully/under/over-defined UX —
    // assert it is wired, not just that solve() returned.
    expect(gcs.gcs.dof()).toBe(2) // two coincident free points = one free point
    expect(gcs.has_gcs_conflicting_constraints()).toBe(false)

    gcs.destroy_gcs_module()
  })
})
