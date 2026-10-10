import { describe, expect, it } from 'vitest'
import { EDGE_JOIN, parseStableId } from '../../doc/stable-id'
import type { TessBuffers } from '../../geom/geom-service'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import type { EdgePickHit, FacePickHit, PickHit, RayLike } from '../../viewport3d/types'
import {
  PROJECT_INPUT_VALIDATION_CLASSES,
  PROJECT_VISIBILITY_SOURCES,
  resolveProjectGeometry,
  type ProjectInputValidationClass,
  type ProjectGeometryPicker,
  type ProjectGeometryVisibility,
  type ProjectVisibilitySource,
  type ResolveProjectGeometryInput,
} from '../../components/model3d/workbench/projectGeometry'
import { buildProjectCommit } from '../../lib/sketch/projectUse'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'

const BODY_ID = 'body-A'
const FACE_ID = 'F1:FACE:face#0'

function faceWithHoleBuffers(feature = 'F1'): { buffers: TessBuffers; faceId: string; edgeId: string } {
  const faceId = `${feature}:FACE:face#0`
  const outer = [
    [-10, -10, 0, 10, -10, 0],
    [10, -10, 0, 10, 10, 0],
    [10, 10, 0, -10, 10, 0],
    [-10, 10, 0, -10, -10, 0],
  ]
  const inner = [
    [-2, -2, 0, 2, -2, 0],
    [2, -2, 0, 2, 2, 0],
    [2, 2, 0, -2, 2, 0],
    [-2, 2, 0, -2, -2, 0],
  ]
  const edges = [...outer, ...inner]
  const edgeIds = edges.map((_, index) => `(${faceId}${EDGE_JOIN}${feature}:FACE:face#${index + 1})`)
  return {
    faceId,
    edgeId: edgeIds[0],
    buffers: {
      position: new Float32Array([-10, -10, 0, 10, -10, 0, 10, 10, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      index: new Uint32Array([0, 1, 2]),
      triFace: new Uint32Array([0]),
      faceIds: [faceId],
      edgePositions: new Float32Array(edges.flat()),
      edgeOffsets: new Uint32Array(edges.map((_, index) => index * 2).concat(edges.length * 2)),
      edgeIds,
    },
  }
}

function duplicateFirstEdge(buffers: TessBuffers): TessBuffers {
  const start = buffers.edgeOffsets[0]
  const end = buffers.edgeOffsets[1]
  const duplicatePoints = buffers.edgePositions.slice(start * 3, end * 3)
  const edgePositions = new Float32Array(buffers.edgePositions.length + duplicatePoints.length)
  edgePositions.set(buffers.edgePositions)
  edgePositions.set(duplicatePoints, buffers.edgePositions.length)
  const edgeOffsets = new Uint32Array(buffers.edgeOffsets.length + 1)
  edgeOffsets.set(buffers.edgeOffsets)
  edgeOffsets[edgeOffsets.length - 1] = buffers.edgeOffsets[buffers.edgeOffsets.length - 1] + (end - start)
  return {
    ...buffers,
    edgePositions,
    edgeOffsets,
    edgeIds: [...buffers.edgeIds, buffers.edgeIds[0]],
  }
}

const frame = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

const ray: RayLike = {
  origin: { x: 0, y: 0, z: 20 },
  direction: { x: 0, y: 0, z: -1 },
}

function hitPicker(hits: Partial<Record<'edge' | 'face', PickHit>>): ProjectGeometryPicker {
  return {
    pick: (_bodyId, _ray, filter) => hits[filter] ?? null,
  }
}

function faceHit(bodyId: string, id: string, distance = 5): FacePickHit {
  return { kind: 'face', bodyId, id, distance, point: { x: 0, y: 0, z: 0 } }
}

function edgeHit(bodyId: string, id: string, distance = 5): EdgePickHit {
  return { kind: 'edge', bodyId, id, distance, point: { x: 0, y: -10, z: 0 } }
}

function visible(bodyId = BODY_ID): ProjectGeometryVisibility {
  return {
    bodyIds: [bodyId],
    liveBodyIds: new Set([bodyId]),
    treeVisible: new Map(),
    hiddenBodyIds: new Set(),
    hiddenFaceIds: new Set(),
    isolate: null,
  }
}

function resolveFixture(options: {
  faceDistance?: number
  edgeDistance?: number | null
  visibility?: ProjectGeometryVisibility
} = {}) {
  const fixture = faceWithHoleBuffers()
  const cache = new GeometryCache()
  cache.ingest(BODY_ID, fixture.buffers)
  const picker = hitPicker({
    face: faceHit(BODY_ID, fixture.faceId, options.faceDistance ?? 5),
    ...(options.edgeDistance === null ? {} : { edge: edgeHit(BODY_ID, fixture.edgeId, options.edgeDistance ?? 5) }),
  })
  return {
    fixture,
    cache,
    result: resolveProjectGeometry({
      frame,
      cache,
      picker,
      ray,
      visibility: options.visibility ?? visible(),
    }),
  }
}

type InvalidProjectInputFixture = {
  input: ResolveProjectGeometryInput
  pickCalls: () => number
}

function invalidInputFixture(overrides: Partial<ResolveProjectGeometryInput>): InvalidProjectInputFixture {
  let calls = 0
  return {
    input: {
      frame,
      cache: new GeometryCache(),
      picker: {
        pick: () => {
          calls += 1
          return null
        },
      },
      ray,
      visibility: visible(),
      ...overrides,
    },
    pickCalls: () => calls,
  }
}

const invalidProjectInputFixtures = {
  'plane-non-finite': () => invalidInputFixture({
    frame: { ...frame, normal: { ...frame.normal, x: Number.NaN } },
  }),
  'plane-degenerate': () => invalidInputFixture({
    frame: { ...frame, xDir: { ...frame.normal } },
  }),
  'edge-threshold': () => invalidInputFixture({
    thresholds: { edge: Number.NaN, vertex: 0.4 },
  }),
  'vertex-threshold': () => invalidInputFixture({
    thresholds: { edge: 0.25, vertex: 0 },
  }),
  'visibility-body-ids': () => invalidInputFixture({
    visibility: { ...visible(), bodyIds: {} as unknown as string[] },
  }),
  'visibility-live-body-ids': () => invalidInputFixture({
    visibility: { ...visible(), liveBodyIds: [] as unknown as ReadonlySet<string> },
  }),
  'visibility-tree-visible': () => invalidInputFixture({
    visibility: { ...visible(), treeVisible: new Set() as unknown as ReadonlyMap<string, boolean> },
  }),
  'visibility-hidden-body-ids': () => invalidInputFixture({
    visibility: { ...visible(), hiddenBodyIds: [] as unknown as ReadonlySet<string> },
  }),
  'visibility-hidden-face-ids': () => invalidInputFixture({
    visibility: { ...visible(), hiddenFaceIds: [] as unknown as ReadonlySet<string> },
  }),
  'visibility-isolate-body-ids': () => invalidInputFixture({
    visibility: {
      ...visible(),
      isolate: { bodyIds: [] as unknown as ReadonlySet<string>, faceIds: new Set() },
    },
  }),
  'visibility-isolate-face-ids': () => invalidInputFixture({
    visibility: {
      ...visible(),
      isolate: { bodyIds: new Set([BODY_ID]), faceIds: [] as unknown as ReadonlySet<string> },
    },
  }),
} satisfies Record<ProjectInputValidationClass, () => InvalidProjectInputFixture>

describe('resolveProjectGeometry accept-boundary validation', () => {
  it('the invalid-input fixture table exactly matches the production validation domain', () => {
    expect(Object.keys(invalidProjectInputFixtures).sort()).toEqual([...PROJECT_INPUT_VALIDATION_CLASSES].sort())
  })

  it.each(PROJECT_INPUT_VALIDATION_CLASSES)('%s refuses before picker or projection work', (inputClass) => {
    const fixture = invalidProjectInputFixtures[inputClass]()
    const result = resolveProjectGeometry(fixture.input)
    expect(result).toMatchObject({ ok: false, reason: 'invalid-project-input' })
    if (result.ok) throw new Error(`expected ${inputClass} to refuse`)
    expect(result.message).toContain(inputClass)
    expect(fixture.pickCalls()).toBe(0)
  })
})

describe('resolveProjectGeometry pick precedence', () => {
  it('a visible front edge wins at a face rim and remains one open path', () => {
    const { result } = resolveFixture({ faceDistance: 5, edgeDistance: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.candidate.sourceKind).toBe('model-edge')
    expect(result.candidate.paths).toHaveLength(1)
    expect(result.candidate.paths[0]).toMatchObject({ closed: false, type: 'open' })
    expect(result.candidate.paths[0].points).toHaveLength(2)
  })

  it('a back edge behind the nearest face is occluded', () => {
    const { result } = resolveFixture({ faceDistance: 5, edgeDistance: 6 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.candidate.sourceKind).toBe('model-face')
    expect(result.candidate.paths.map((path) => path.type)).toEqual(['contour', 'hole'])
  })

  it('a face interior resolves the grouped outer and hole loops', () => {
    const { result } = resolveFixture({ edgeDistance: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.candidate.paths).toHaveLength(2)
    expect(result.candidate.paths.every((path) => path.closed)).toBe(true)
  })

  it('a miss is named and returns no candidate', () => {
    const cache = new GeometryCache()
    const result = resolveProjectGeometry({
      frame,
      cache,
      picker: hitPicker({}),
      ray,
      visibility: visible(),
    })
    expect(result).toMatchObject({ ok: false, reason: 'miss' })
  })

  it('an edge-id collision refusal preserves the colliding id and count', () => {
    const fixture = faceWithHoleBuffers()
    const cache = new GeometryCache()
    cache.ingest(BODY_ID, duplicateFirstEdge(fixture.buffers))
    const result = resolveProjectGeometry({
      frame,
      cache,
      picker: hitPicker({ edge: edgeHit(BODY_ID, fixture.edgeId) }),
      ray,
      visibility: visible(),
    })

    expect(result).toMatchObject({ ok: false, reason: 'edge-id-collision' })
    if (result.ok) throw new Error('expected edge-id-collision refusal')
    expect(result.message).toContain(fixture.edgeId)
    expect(result.message).toContain('(2 distinct edges share this stable id)')
    expect(result.message).toContain('GEO-16')
  })
})

describe('resolved model face through Project commit and profile extraction', () => {
  it('face projection commit preserves the inner loop as a profile void', async () => {
    const { result } = resolveFixture({ edgeDistance: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)

    let nextId = 0
    const built = buildProjectCommit(result.candidate, false, () => `project-${nextId++}`)
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error(built.reason)
    const sketch = {
      ...createBlankSketch('model-projection', () => 'face-with-hole'),
      entities: built.commit.entities,
      constraints: built.commit.constraints,
    }
    const extracted = await extractSketchProfile(sketch, frame, sketch.id)
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) throw new Error(extracted.refusal.message)

    // ProfileRegion's contract is [outer, ...holes]. Prove both the retained
    // inner loop and the resulting void area, not merely two disconnected paths.
    expect(extracted.regions[0].loops).toHaveLength(2)
    const absoluteAreas = extracted.regions[0].loops.map((loop) => Math.abs(loop.reduce((sum, segment) => {
      if (segment.kind !== 'line') throw new Error('fixture unexpectedly emitted a curved segment')
      return sum + segment.a[0] * segment.b[1] - segment.b[0] * segment.a[1]
    }, 0) / 2))
    expect(absoluteAreas[0]).toBeCloseTo(400, 8)
    expect(absoluteAreas[1]).toBeCloseTo(16, 8)
    expect(absoluteAreas[0] - absoluteAreas[1]).toBeCloseTo(384, 8)
  })
})

const visibilityExclusions = {
  'live-body': (base: ProjectGeometryVisibility) => ({ ...base, liveBodyIds: new Set<string>() }),
  'tree-eye': (base: ProjectGeometryVisibility) => ({ ...base, treeVisible: new Map([[BODY_ID, false]]) }),
  'hidden-body': (base: ProjectGeometryVisibility) => ({ ...base, hiddenBodyIds: new Set([BODY_ID]) }),
  'isolate-body': (base: ProjectGeometryVisibility) => ({
    ...base,
    isolate: { bodyIds: new Set(['another-body']), faceIds: new Set<string>() },
  }),
  'hidden-face': (base: ProjectGeometryVisibility) => ({ ...base, hiddenFaceIds: new Set([FACE_ID]) }),
  'isolate-face': (base: ProjectGeometryVisibility) => ({
    ...base,
    isolate: { bodyIds: new Set([BODY_ID]), faceIds: new Set(['another-face']) },
  }),
} satisfies Record<ProjectVisibilitySource, (base: ProjectGeometryVisibility) => ProjectGeometryVisibility>

type EdgeAdjacencyVisibilitySource = Extract<ProjectVisibilitySource, 'tree-eye' | `${string}-face`>

/**
 * Derive the required edge x visibility matrix from the production census.
 * Tree eye is body-level in the runtime contract, so its one-visible case is
 * the shown body (all of that body's adjacent faces become eligible together).
 */
const EDGE_ADJACENCY_VISIBILITY_SOURCES = PROJECT_VISIBILITY_SOURCES.filter(
  (source): source is EdgeAdjacencyVisibilitySource => source === 'tree-eye' || source.endsWith('-face'),
)
const EDGE_ADJACENCY_VISIBILITY_MODES = ['all-excluded', 'one-visible'] as const

function realAdjacentFaceIds(edgeId: string): string[] {
  const parsed = parseStableId(edgeId)
  if (parsed.kind !== 'edge') throw new Error(`fixture edge '${edgeId}' did not parse as an edge`)
  const adjacent = parsed.operands
    .filter((operand) => !operand.isOrphan && !operand.isSeam)
    .map((operand) => operand.raw)
  if (adjacent.length < 2) throw new Error(`fixture edge '${edgeId}' needs two real adjacent faces`)
  return adjacent
}

function faceVisibilityForEdge(
  source: EdgeAdjacencyVisibilitySource,
  adjacent: readonly string[],
  mode: 'all-excluded' | 'one-visible',
): ProjectGeometryVisibility {
  const base = visible()
  switch (source) {
    case 'tree-eye':
      return { ...base, treeVisible: new Map([[BODY_ID, mode === 'one-visible']]) }
    case 'hidden-face':
      return {
        ...base,
        hiddenFaceIds: new Set(mode === 'all-excluded' ? adjacent : adjacent.slice(1)),
      }
    case 'isolate-face':
      return {
        ...base,
        isolate: {
          bodyIds: new Set([BODY_ID]),
          faceIds: new Set(mode === 'all-excluded' ? ['not-an-adjacent-face'] : [adjacent[0]]),
        },
      }
    default: {
      const exhaustive: never = source
      throw new Error(`unhandled face visibility source: ${exhaustive}`)
    }
  }
}

function resolveEdgeOnly(visibility: ProjectGeometryVisibility) {
  const fixture = faceWithHoleBuffers()
  const cache = new GeometryCache()
  cache.ingest(BODY_ID, fixture.buffers)
  return {
    fixture,
    result: resolveProjectGeometry({
      frame,
      cache,
      picker: hitPicker({ edge: edgeHit(BODY_ID, fixture.edgeId) }),
      ray,
      visibility,
    }),
  }
}

describe('derived project visibility census', () => {
  it('the runtime source list and can-fail fixture table are exhaustive', () => {
    expect(Object.keys(visibilityExclusions).sort()).toEqual([...PROJECT_VISIBILITY_SOURCES].sort())
  })

  it.each(PROJECT_VISIBILITY_SOURCES)('%s independently excludes its hit', (source) => {
    const fixture = faceWithHoleBuffers()
    const cache = new GeometryCache()
    cache.ingest(BODY_ID, fixture.buffers)
    const result = resolveProjectGeometry({
      frame,
      cache,
      picker: hitPicker({ face: faceHit(BODY_ID, fixture.faceId) }),
      ray,
      visibility: visibilityExclusions[source](visible()),
    })
    expect(result).toMatchObject({ ok: false, reason: 'miss' })
  })

  it('the visible control remains pickable', () => {
    const { result } = resolveFixture({ edgeDistance: null })
    expect(result.ok).toBe(true)
  })

  it('derives the complete required edge-adjacency visibility subset', () => {
    expect(EDGE_ADJACENCY_VISIBILITY_SOURCES).toEqual(
      PROJECT_VISIBILITY_SOURCES.filter((source) => source === 'tree-eye' || source.endsWith('-face')),
    )
    expect(EDGE_ADJACENCY_VISIBILITY_SOURCES).toEqual(['tree-eye', 'hidden-face', 'isolate-face'])
  })

  it.each(EDGE_ADJACENCY_VISIBILITY_SOURCES.flatMap((source) => (
    EDGE_ADJACENCY_VISIBILITY_MODES.map((mode) => [source, mode] as const)
  )))(
    '%s x %s produces the required edge visibility outcome',
    (source, mode) => {
      const fixture = faceWithHoleBuffers()
      const adjacent = realAdjacentFaceIds(fixture.edgeId)
      const { result } = resolveEdgeOnly(faceVisibilityForEdge(source, adjacent, mode))
      if (mode === 'all-excluded') {
        expect(result).toMatchObject({ ok: false, reason: 'miss' })
        return
      }
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.reason)
      expect(result.candidate.sourceKind).toBe('model-edge')
      expect(result.candidate.sourceIdentity?.stableId).toBe(fixture.edgeId)
    },
  )
})

describe('project source revision identity', () => {
  it('carries body id, cache version and stable pick key', () => {
    const { result } = resolveFixture({ edgeDistance: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.candidate.sourceIdentity).toMatchObject({
      bodyId: BODY_ID,
      cacheVersion: 1,
      stableId: FACE_ID,
    })
    expect(result.candidate.stablePickKey).toContain(`${BODY_ID}:${FACE_ID}`)
  })

  it('refuses a held hover after the same body is re-ingested', () => {
    const fixture = faceWithHoleBuffers()
    const cache = new GeometryCache()
    cache.ingest(BODY_ID, fixture.buffers)
    const picker = hitPicker({ face: faceHit(BODY_ID, fixture.faceId) })
    const first = resolveProjectGeometry({ frame, cache, picker, ray, visibility: visible() })
    expect(first.ok).toBe(true)
    if (!first.ok || first.candidate.sourceIdentity === undefined) throw new Error('expected model identity')
    cache.ingest(BODY_ID, fixture.buffers)
    const second = resolveProjectGeometry({
      frame,
      cache,
      picker,
      ray,
      visibility: visible(),
      expectedSource: {
        stablePickKey: first.candidate.stablePickKey,
        sourceIdentity: first.candidate.sourceIdentity,
      },
    })
    expect(second).toMatchObject({ ok: false, reason: 'stale-source-version' })
  })

  it('refuses when the expected stable pick key changes', () => {
    const fixture = faceWithHoleBuffers()
    const cache = new GeometryCache()
    const body = cache.ingest(BODY_ID, fixture.buffers)
    const result = resolveProjectGeometry({
      frame,
      cache,
      picker: hitPicker({ face: faceHit(BODY_ID, fixture.faceId) }),
      ray,
      visibility: visible(),
      expectedSource: {
        stablePickKey: 'model-face:body-A:different-face',
        sourceIdentity: { bodyId: BODY_ID, cacheVersion: body.version, stableId: fixture.faceId },
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'source-key-changed' })
  })
})
