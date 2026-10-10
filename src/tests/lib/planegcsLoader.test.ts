// SKC-6A: the shared loader that both sketch stacks (src/lib/sketch/solver
// and src/sketch3d) now import. Pins the two behaviors the unification had
// to preserve byte-for-byte: (1) createGcsWrapper (2D) instantiates a usable
// solver and does NOT touch the sketch3d construct-count instrumentation;
// (2) createSketch3dGcsWrapper increments gcsSystemConstructCount exactly
// once per call, independent of createGcsWrapper calls.

import { describe, it, expect } from 'vitest'
import { Algorithm, SolveStatus } from '@salusoft89/planegcs'
import {
  createGcsWrapper,
  createSketch3dGcsWrapper,
  resetSketch3dGcsSystemConstructCountForTest,
  sketch3dGcsSystemConstructCountForTest,
} from '../../lib/planegcs/planegcsLoader'

describe('shared planegcs loader (SKC-6A)', () => {
  it('createGcsWrapper instantiates the WASM module and solves a trivial system', async () => {
    const gcs = await createGcsWrapper()

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
    expect(gcs.gcs.dof()).toBe(2)

    gcs.destroy_gcs_module()
  })

  it('createSketch3dGcsWrapper increments the construct-count instrumentation once per call', async () => {
    resetSketch3dGcsSystemConstructCountForTest()
    expect(sketch3dGcsSystemConstructCountForTest()).toBe(0)

    const first = await createSketch3dGcsWrapper()
    expect(sketch3dGcsSystemConstructCountForTest()).toBe(1)

    const second = await createSketch3dGcsWrapper()
    expect(sketch3dGcsSystemConstructCountForTest()).toBe(2)

    first.destroy_gcs_module()
    second.destroy_gcs_module()
  })

  it('createGcsWrapper (2D entry point) does not increment the sketch3d construct-count counter', async () => {
    resetSketch3dGcsSystemConstructCountForTest()

    const gcs = await createGcsWrapper()
    expect(sketch3dGcsSystemConstructCountForTest()).toBe(0)

    gcs.destroy_gcs_module()
  })
})
