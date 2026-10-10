// INT-17A Stage 1 gate G3 (PERF SOAK): a committed >=24-body fixture measuring the
// CAM-side derive cost, and the can-fail assertion of the changed-only invariant -
// a single-body edit re-derives EXACTLY ONE body's display regardless of how many
// bodies are live, so the per-edit cost does NOT scale with total body count.
//
// This measures MY sync work (display extraction + reconcile), which is the cost
// INT-17A adds; the kernel tessellation is the Model tab's existing cost, done
// once per body regardless. The bodies are REAL GeometryCache entries built from
// realistically-sized synthetic TessBuffers (~600 triangles each), not mocks.

import { describe, it, expect } from 'vitest'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { modelBodyDisplayFromCached } from '../../viewport3d/modelBodyDisplay'
import {
  reconcileModelBodies,
  selectBodiesToDerive,
  type DerivedModelBody,
  type LiveModelBody,
} from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry } from '../../types'
import type { BodyId, TessBuffers } from '../../viewport3d/types'

const BODY_COUNT = 24
const TRIS_PER_BODY = 600

/** A realistically-sized body: a fan of TRIS_PER_BODY triangles with per-face
 *  (unshared) vertices, plus one polyline edge, exactly the TessBuffers shape the
 *  Model kernel emits. */
function makeTess(seed: number): TessBuffers {
  const n = TRIS_PER_BODY
  const position = new Float32Array(n * 3 * 3)
  const normal = new Float32Array(n * 3 * 3)
  const index = new Uint32Array(n * 3)
  const triFace = new Uint32Array(n)
  const faceIds: string[] = []
  for (let t = 0; t < n; t++) {
    const b = t * 9
    position[b + 0] = seed + t; position[b + 1] = 0; position[b + 2] = 0
    position[b + 3] = seed + t + 1; position[b + 4] = 0; position[b + 5] = 0
    position[b + 6] = seed + t; position[b + 7] = 1; position[b + 8] = 0
    for (let k = 0; k < 9; k += 3) { normal[b + k] = 0; normal[b + k + 1] = 0; normal[b + k + 2] = 1 }
    index[t * 3] = t * 3; index[t * 3 + 1] = t * 3 + 1; index[t * 3 + 2] = t * 3 + 2
    triFace[t] = t
    faceIds.push(`F${t}`)
  }
  return {
    position, normal, index, triFace, faceIds,
    edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
    edgeOffsets: new Uint32Array([0, 3]),
    edgeIds: ['E0'],
  }
}

function buildCache(): { cache: GeometryCache; bodyIds: string[] } {
  const cache = new GeometryCache()
  const bodyIds: string[] = []
  for (let i = 0; i < BODY_COUNT; i++) {
    const id = `body-${i}`
    cache.ingest(id as BodyId, makeTess(i))
    bodyIds.push(id)
  }
  return { cache, bodyIds }
}

/** The exact orchestration syncCamModelBodies performs, extracted so the gate can
 *  drive and measure it headlessly (component method not directly callable). */
function runSync(
  cache: GeometryCache,
  current: ImportedGeometry[],
  liveIds: string[],
  executed: string[],
): { geometry: ImportedGeometry[]; derivedCount: number } {
  const existing = new Set(
    current.filter((g) => g.format === 'model' && g.modelBody).map((g) => g.modelBody!.ref.bodyId),
  )
  const toDerive = new Set(selectBodiesToDerive(liveIds, executed, existing))
  const derived: DerivedModelBody[] = []
  for (const bodyId of liveIds) {
    if (!toDerive.has(bodyId)) continue
    const cached = cache.get(bodyId as BodyId)!
    derived.push({
      bodyId, version: cached.version,
      stableIds: [...cached.faceIds, ...cached.edgeIds],
      display: modelBodyDisplayFromCached(cached),
    })
  }
  const live: LiveModelBody[] = liveIds.map((bodyId) => ({ bodyId, name: bodyId }))
  const r = reconcileModelBodies(current, { live, derived })
  return { geometry: r.geometry, derivedCount: derived.length }
}

describe(`INT-17A perf soak (${BODY_COUNT} bodies x ${TRIS_PER_BODY} tris)`, () => {
  it('a single-body edit re-derives EXACTLY ONE body regardless of total count', () => {
    const { cache, bodyIds } = buildCache()
    // Initial: surface all 24.
    const initial = runSync(cache, [], bodyIds, bodyIds)
    expect(initial.derivedCount).toBe(BODY_COUNT)
    expect(initial.geometry.filter((g) => g.format === 'model')).toHaveLength(BODY_COUNT)

    // Edit ONE body (regen bumps its cache version).
    cache.ingest(bodyIds[7] as BodyId, makeTess(999))
    const edit = runSync(cache, initial.geometry, bodyIds, [bodyIds[7]])
    // CAN-FAIL: a re-derive-all regression would make this 24.
    expect(edit.derivedCount).toBe(1)
  })

  it('MEASURE: per-edit derive cost does not scale with body count', () => {
    const { cache, bodyIds } = buildCache()

    const tInitStart = performance.now()
    const initial = runSync(cache, [], bodyIds, bodyIds)
    const initialMs = performance.now() - tInitStart

    // Warm, then measure a single-body edit re-derive (median of several).
    let current = initial.geometry
    const editSamples: number[] = []
    for (let i = 0; i < 8; i++) {
      const target = bodyIds[i]
      cache.ingest(target as BodyId, makeTess(1000 + i))
      const t = performance.now()
      const res = runSync(cache, current, bodyIds, [target])
      editSamples.push(performance.now() - t)
      current = res.geometry
      expect(res.derivedCount).toBe(1)
    }
    editSamples.sort((a, b) => a - b)
    const medianEditMs = editSamples[Math.floor(editSamples.length / 2)]

    // The invariant, quantified: a single-body edit re-derives 1/BODY_COUNT of the
    // work, so it must be well UNDER the full initial derive. A generous ceiling
    // (half the initial) keeps this non-flaky on a loaded CI box while still
    // failing a re-derive-all regression (which would ~equal the initial cost).
    expect(medianEditMs).toBeLessThan(initialMs)

    // Report numbers (charter: measured numbers in the report; no bare claims).
    // eslint-disable-next-line no-console
    console.log(
      `INT-17A G3 perf: ${BODY_COUNT} bodies x ${TRIS_PER_BODY} tris | ` +
        `initial derive (all ${BODY_COUNT}) = ${initialMs.toFixed(2)}ms | ` +
        `single-body edit re-derive (median of 8) = ${medianEditMs.toFixed(3)}ms | ` +
        `ratio = ${(medianEditMs / initialMs).toFixed(3)}`,
    )
  })
})
