// GEO-UNIFY Stage 3: the HEADLESS seed builder (buildPromotedSketchModelArchive)
// unit-tested against the LIVE document shapes — no React, no canvas, no kernel.
//
// The gate (plan sec 3.2 step 6): the promoted sketch must be extrude-eligible
// on first mount. `profilePickCandidates` (SolidsWorkbenchPage) admits a sketch
// node iff `payload.profile.loops.length > 0`, so decoding the seed archive and
// asserting that condition IS that gate, headlessly. This proves the
// profile-at-seed decision (extractSketchProfile is headless) end to end: the
// archive round-trips through the real loadDocumentArchive loader.

import { describe, it, expect } from 'vitest'
import { buildPromotedSketchModelArchive } from '../../doc/promoteSketchModel'
import { loadDocumentArchive } from '../../doc/persist'
import { sketch3dNodeId } from '../../sketch3d'
import {
  ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID,
} from '../../doc/genesis'
import type { Sketch } from '../../lib/sketch/types'
import type { ProfileRegion } from '../../geom/geom-service'

function squareSketch(id = 'sk-1'): Sketch {
  return {
    id, layerId: 'lay-1',
    entities: [
      { id: 'e1', construction: false, kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'e2', construction: false, kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { id: 'e3', construction: false, kind: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
      { id: 'e4', construction: false, kind: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
    ],
    constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

/** An OPEN sketch (only two sides) — no closed profile, so extractSketchProfile
 *  refuses by name and the builder seeds WITHOUT a profile (mount-time recompute
 *  fallback owns producing one once it closes). */
function openSketch(id = 'sk-open'): Sketch {
  return {
    id, layerId: 'lay-1',
    entities: [
      { id: 'e1', construction: false, kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'e2', construction: false, kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ],
    constraints: [], dimensions: [],
    solveStatus: { dof: 4, conflicting: [], redundant: [] },
  }
}

describe('GEO-UNIFY Stage 3: buildPromotedSketchModelArchive', () => {
  it('seeds genesis + one sketch node in the EXACT create-shape, with a profile (extrude-eligible on first open)', async () => {
    const sketch = squareSketch()
    const seed = await buildPromotedSketchModelArchive(sketch)
    expect(seed.hadProfile).toBe(true)
    expect(seed.profileRefusal).toBeUndefined()

    const loaded = loadDocumentArchive(seed.bytes)
    const dag = loaded.dag

    // Genesis fixtures present (Origin + XY/XZ/YZ), at the front.
    for (const id of [ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID]) {
      expect(dag.getNode(id)).toBeDefined()
    }

    const nodeId = sketch3dNodeId('sk-1')
    const node = dag.getNode(nodeId)
    expect(node).toBeDefined()
    expect(node!.kind).toBe('sketch')
    expect(node!.consumes).toContain(BASE_PLANE_XY_NODE_ID)

    const payload = node!.payload as {
      sketch?: Sketch
      planeNodeId?: string
      externalRefs?: unknown[]
      dimensionDiagnostics?: unknown[]
      profile?: ProfileRegion
      regions?: ProfileRegion[]
    }
    // The CAM Sketch rides VERBATIM in payload.sketch (no Sketch3dDocument round trip).
    expect(payload.sketch?.id).toBe('sk-1')
    expect(payload.sketch?.entities.length).toBe(4)
    expect(payload.planeNodeId).toBe(BASE_PLANE_XY_NODE_ID)
    expect(payload.externalRefs).toEqual([])
    expect(payload.dimensionDiagnostics).toEqual([])

    // THE GATE: profile present with >=1 closed loop -> profilePickCandidates hit.
    expect(payload.profile).toBeDefined()
    expect(payload.profile!.loops.length).toBeGreaterThan(0)
    expect(payload.regions).toHaveLength(1)
    expect(payload.profile).toEqual(payload.regions![0])
  })

  it('open sketch: seeds the node WITHOUT a profile and reports the named refusal (mount-time recompute fallback)', async () => {
    const seed = await buildPromotedSketchModelArchive(openSketch())
    expect(seed.hadProfile).toBe(false)
    expect(seed.profileRefusal).toBeTruthy()

    const loaded = loadDocumentArchive(seed.bytes)
    const node = loaded.dag.getNode(sketch3dNodeId('sk-open'))
    expect(node).toBeDefined()
    expect(node!.kind).toBe('sketch')
    // No profile field yet — the workbench's recomputeSketchProfileInDag owns
    // producing one on mount once the sketch closes.
    expect((node!.payload as { profile?: ProfileRegion }).profile).toBeUndefined()
    expect((node!.payload as { regions?: ProfileRegion[] }).regions).toBeUndefined()
    // The sketch itself is still carried verbatim (nothing lost).
    expect((node!.payload as { sketch?: Sketch }).sketch?.id).toBe('sk-open')
  })
})
