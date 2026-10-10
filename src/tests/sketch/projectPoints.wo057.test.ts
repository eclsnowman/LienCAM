import { describe, expect, it } from 'vitest'
import { resolveProjectGeometry, type ProjectGeometryPicker } from '../../components/model3d/workbench/projectGeometry'
import {
  buildProjectCommit,
  projectPreviewPaths,
  type ProjectCandidate,
} from '../../lib/sketch/projectUse'
import { findSnap } from '../../lib/sketch/snap'
import { planDimension } from '../../lib/sketch/tools/dimTool'
import { toolStepSequence } from '../../lib/sketch/tools/toolSteps'
import type { SketchEntity, SketchPointEntity } from '../../lib/sketch/types'
import { makeBridgeVertexRef, type PickHit } from '../../viewport3d/types'

const BODY_ID = 'body-point-source'
const EDGE_ID = 'edge-endpoint-source'

function vertexCandidate(at = { x: 4, y: 6 }): ProjectCandidate {
  return {
    paths: [],
    points: [at],
    sourceKind: 'model-vertex',
    sourceLabel: 'Model vertex',
    stablePickKey: 'model-vertex:fixture',
    sourceIdentity: {
      bodyId: BODY_ID,
      cacheVersion: 1,
      stableId: 'vertex:fixture',
    },
  }
}

function resolveVertex(hits: Partial<Record<'face' | 'edge' | 'vertex', PickHit>>) {
  const cachedBody = { bodyId: BODY_ID, version: 1 }
  const picker: ProjectGeometryPicker = {
    pick: (_bodyId, _ray, filter) => hits[filter] ?? null,
    pickVertex: () => hits.vertex ?? null,
  }
  return resolveProjectGeometry({
    frame: {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      xDir: { x: 1, y: 0, z: 0 },
    },
    cache: { get: () => cachedBody as never },
    picker,
    ray: {
      origin: { x: 4, y: 6, z: 20 },
      direction: { x: 0, y: 0, z: -1 },
    },
    visibility: {
      bodyIds: [BODY_ID],
      liveBodyIds: new Set([BODY_ID]),
      treeVisible: new Map(),
      hiddenBodyIds: new Set(),
      hiddenFaceIds: new Set(),
      isolate: null,
    },
  })
}

describe('WO-057 Project/Use model points', () => {
  it('advertises point sources in the non-blocking Project/Use prompt', () => {
    expect(toolStepSequence('project')?.[0].prompt).toBe(
      'Click a point, edge, face, or loop to project it',
    )
  })

  it('resolves an edge-endpoint vertex ahead of coincident edge and face hits', () => {
    const point = { x: 4, y: 6, z: 0 }
    const result = resolveVertex({
      vertex: {
        kind: 'vertex',
        bodyId: BODY_ID,
        id: makeBridgeVertexRef([EDGE_ID]),
        distance: 20,
        point,
      },
      edge: { kind: 'edge', bodyId: BODY_ID, id: EDGE_ID, distance: 20, point },
      face: { kind: 'face', bodyId: BODY_ID, id: 'face-source', distance: 20, point },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.candidate).toMatchObject({
      sourceKind: 'model-vertex',
      paths: [],
      points: [{ x: 4, y: 6 }],
    })
    expect(result.candidate.sourceIdentity?.stableId).toContain(EDGE_ID)
  })

  it('commits one fixed projected sketch point and honors both construction states', () => {
    for (const construction of [false, true]) {
      let nextId = 0
      const result = buildProjectCommit(vertexCandidate(), construction, () => `point-${nextId++}`)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)

      expect(result.commit.entities).toEqual([{
        id: 'point-0',
        kind: 'point',
        construction,
        provenance: 'projected',
        at: { x: 4, y: 6 },
      }])
      expect(result.commit.constraints).toEqual([{
        id: 'point-1',
        kind: 'fix',
        entityId: 'point-0',
        projectionGrounding: true,
      }])
    }
  })

  it('uses the projected point as a normal snap target and dimension anchor', () => {
    const result = buildProjectCommit(vertexCandidate(), false, (() => {
      let nextId = 0
      return () => `projected-${nextId++}`
    })())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    const projected = result.commit.entities[0] as SketchPointEntity

    const snap = findSnap({
      cursor: { x: 4.2, y: 5.9 },
      entities: [projected],
      gridSpacing: 10,
      worldPerPixel: 0.1,
      flags: { entity: true, grid: false, inference: true },
    })
    expect(snap).toMatchObject({
      kind: 'endpoint',
      point: { x: 4, y: 6 },
      inferences: [{ kind: 'coincident', to: { entityId: projected.id, site: 'self' } }],
    })

    const native: SketchEntity = {
      id: 'native-point',
      kind: 'point',
      construction: false,
      at: { x: 7, y: 10 },
    }
    const dimension = planDimension([projected, native], [projected.id, native.id])
    expect(dimension.ok).toBe(true)
    if (!dimension.ok) throw new Error(dimension.reason)
    expect(dimension.plan).toMatchObject({
      kind: 'distance',
      a: { entityId: projected.id, site: 'self' },
      b: { entityId: native.id, site: 'self' },
      value: 5,
    })
  })

  it('previews a picked point as a screen-scaled cross in the projected-curve preview channel', () => {
    expect(projectPreviewPaths(vertexCandidate(), 2)).toEqual([
      [{ x: 2, y: 6 }, { x: 6, y: 6 }],
      [{ x: 4, y: 4 }, { x: 4, y: 8 }],
    ])
  })
})
