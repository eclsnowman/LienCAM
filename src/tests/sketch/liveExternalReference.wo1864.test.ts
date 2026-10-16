// @vitest-environment jsdom
//
// WO-1864: sketch geometry projected from a model face/edge/vertex stays tied to it.
//
// Tier A (fast, real planegcs): a cached body built from real tessellation buffers, the real
// Project pick resolver, the real commit builder + link stamp, the real re-resolution
// (projectGeometry.resolveProjectionLinkSource over the persistent ids) and the real regen solve
// (workbenchSketchDocumentPort.solveRelinkedSketch). The body is re-ingested with moved geometry
// and the SAME persistent ids -- exactly what a regenerated body hands the cache.
//
// Tier B (real SolidsWorkbenchPage + real occt-wasm kernel): Project an edge of a real extrude,
// constrain a drawn line to it, change the extrude and let the page's own fullResync carry both.
// That is the stage-1 proof the order asks for: the stored identity survives a real model edit.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { EDGE_JOIN } from '../../doc/stable-id'
import { FeatureDag } from '../../doc'
import type { TessBuffers } from '../../geom/geom-service'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import type { EdgePickHit, FacePickHit, PickHit, VertexPickHit } from '../../viewport3d/types'
import {
  resolveProjectGeometry,
  resolveProjectionLinkSource,
  type ProjectGeometryVisibility,
} from '../../components/model3d/workbench/projectGeometry'
import { solveRelinkedSketch } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { buildProjectCommit, type ProjectCandidate } from '../../lib/sketch/projectUse'
import {
  breakProjectionLinks,
  linkProjectedEntities,
  relinkProjectedEntities,
  unresolvedReferenceSentence,
  type ProjectionSourceResolver,
} from '../../lib/sketch/projectLink'
import { detachProjectedFixes, markProjectedGeometryDetached } from '../../lib/sketch/projectedEdit'
import { buildReferenceRows } from '../../lib/sketch/browserModel'
import { captureSketchClipboard, instantiateSketchClipboard } from '../../lib/sketch/clipboard'
import { bakeSketch } from '../../lib/sketch/bake'
import type {
  Sketch, SketchConstraint, SketchEntity, SketchLineEntity, SketchPointEntity,
} from '../../lib/sketch/types'

// ---- Tier A fixture ------------------------------------------------------------------------------

const BODY = 'F1'
const FRONT = 'F1:FACE:front'
const TOP = 'F1:FACE:top'
const edgeId = (a: string, b: string): string => `(${a}${EDGE_JOIN}${b})`
const E_TOP = edgeId(FRONT, TOP)
const E_RIGHT = edgeId(FRONT, 'F1:FACE:right')
const E_BOTTOM = edgeId(FRONT, 'F1:FACE:bottom')
const E_LEFT = edgeId(FRONT, 'F1:FACE:left')

/** The XZ base plane: local x = world x, local y = world z. */
const XZ = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: -1, z: 0 },
  xDir: { x: 1, y: 0, z: 0 },
}

/** The front face (world y = 0) of a block `length` long and `top` high, with its four edges. The
 *  ids never change with the dimensions -- the persistent-naming contract a real regen keeps. */
function blockBuffers(top: number, length: number): TessBuffers {
  const edges: Array<[string, number[]]> = [
    [E_BOTTOM, [0, 0, 0, length, 0, 0]],
    [E_RIGHT, [length, 0, 0, length, 0, top]],
    [E_TOP, [length, 0, top, 0, 0, top]],
    [E_LEFT, [0, 0, top, 0, 0, 0]],
  ]
  return {
    position: new Float32Array([0, 0, 0, length, 0, 0, length, 0, top]),
    normal: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: [FRONT],
    edgePositions: new Float32Array(edges.flatMap(([, points]) => points)),
    edgeOffsets: new Uint32Array(edges.map((_, index) => index * 2).concat(edges.length * 2)),
    edgeIds: edges.map(([id]) => id),
  }
}

function visibility(): ProjectGeometryVisibility {
  return {
    bodyIds: [BODY],
    liveBodyIds: new Set([BODY]),
    treeVisible: new Map(),
    hiddenBodyIds: new Set(),
    hiddenFaceIds: new Set(),
    isolate: null,
  }
}

const RAY = { origin: { x: 20, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } }

function pickCandidate(cache: GeometryCache, hit: PickHit): ProjectCandidate {
  const result = resolveProjectGeometry({
    frame: XZ,
    cache,
    picker: {
      pick: (_bodyId, _ray, filter) => (hit.kind === filter ? hit : null),
      pickVertex: () => (hit.kind === 'vertex' ? hit : null),
    },
    ray: RAY,
    visibility: visibility(),
  })
  if (!result.ok) throw new Error(result.message)
  return result.candidate
}

const edgeHit = (id = E_TOP): EdgePickHit => ({ kind: 'edge', bodyId: BODY, id, distance: 100, point: { x: 20, y: 0, z: 20 } })
const faceHit = (): FacePickHit => ({ kind: 'face', bodyId: BODY, id: FRONT, distance: 100, point: { x: 20, y: 0, z: 10 } })
const vertexHit = (): VertexPickHit => ({
  kind: 'vertex', bodyId: BODY, distance: 100, point: { x: 40, y: 0, z: 20 },
  id: { adjacentEdgeIds: [E_TOP, E_RIGHT] },
} as unknown as VertexPickHit)

let seq = 0
const newId = (): string => `id-${seq++}`

/** Commit exactly as toolController.click does: build, then stamp the live link. */
function commitProjection(candidate: ProjectCandidate): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const built = buildProjectCommit(candidate, false, newId)
  if (!built.ok) throw new Error(built.message)
  return { entities: linkProjectedEntities(built.commit.entities, candidate), constraints: built.commit.constraints }
}

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return { id: 'wo1864', layerId: 'workbench', entities, constraints, dimensions: [], solveStatus: null }
}

/** The model-side resolver a regen pass hands relinkProjectedEntities (body found live). */
function resolverFor(cache: GeometryCache, live = true): ProjectionSourceResolver {
  return (link) => resolveProjectionLinkSource({
    link, frame: XZ, cache,
    body: live ? { ok: true, bodyId: BODY } : { ok: false, reason: 'body-lost' },
  })
}

function lineById(sketch: Sketch, id: string): SketchLineEntity {
  const found = sketch.entities.find((entity) => entity.id === id)
  if (found?.kind !== 'line') throw new Error(`line ${id} missing`)
  return found
}

/** A native line whose start is coincident with the projected edge's start and whose end is free. */
function drawnLineOn(projected: SketchLineEntity): { line: SketchLineEntity; tie: SketchConstraint } {
  const line: SketchLineEntity = {
    id: 'drawn', kind: 'line', construction: false,
    start: { ...projected.start }, end: { x: projected.start.x + 5, y: projected.start.y - 15 },
  }
  const tie: SketchConstraint = {
    id: 'tie', kind: 'coincident',
    a: { entityId: 'drawn', site: 'start' }, b: { entityId: projected.id, site: 'start' },
  }
  return { line, tie }
}

let wrapper: GcsWrapper
beforeAll(async () => {
  wrapper = await createGcsWrapper()
})
beforeEach(() => { seq = 0 })

/** One regen pass for one sketch, the page's relinkProjectedSketches in miniature. */
function regen(sketch: Sketch, cache: GeometryCache, live = true): { sketch: Sketch; newlyUnresolved: number } {
  const relinked = relinkProjectedEntities(sketch.entities, resolverFor(cache, live))
  if (!relinked.changed) return { sketch, newlyUnresolved: relinked.newlyUnresolved.length }
  return {
    sketch: solveRelinkedSketch({ ...sketch, entities: relinked.entities }, XZ, wrapper),
    newlyUnresolved: relinked.newlyUnresolved.length,
  }
}

function projectedEdgeSketch(cache: GeometryCache): { sketch: Sketch; projectedId: string } {
  const commit = commitProjection(pickCandidate(cache, edgeHit()))
  const projected = commit.entities[0] as SketchLineEntity
  const { line, tie } = drawnLineOn(projected)
  const sketch = solveRelinkedSketch(sketchOf([...commit.entities, line], [...commit.constraints, tie]), XZ, wrapper)
  expect(sketch.solveStatus?.solveFailed).not.toBe(true)
  return { sketch, projectedId: projected.id }
}

describe('WO-1864 tier A: a projected model reference follows the model', () => {
  it('stamps a model edge commit with its source and leaves a CAM layer loop a static copy', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const candidate = pickCandidate(cache, edgeHit())
    const { entities } = commitProjection(candidate)
    expect(entities).toHaveLength(1)
    expect(entities[0].projectionLink).toMatchObject({
      sourceKind: 'model-edge', bodyId: BODY, stableId: E_TOP, path: 0, piece: 0, pathPieces: 1,
    })
    const camLoop: ProjectCandidate = { ...candidate, sourceKind: 'cam-layer-loop', sourceIdentity: undefined }
    expect(commitProjection(camLoop).entities.every((entity) => entity.projectionLink === undefined)).toBe(true)
  })

  it('move the face 10 mm: the projected edge AND the line constrained to it follow in the same solve', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const { sketch, projectedId } = projectedEdgeSketch(cache)
    const before = lineById(sketch, projectedId)
    expect([before.start.y, before.end.y]).toEqual([20, 20])

    cache.ingest(BODY, blockBuffers(30, 40)) // the top face rises 10 mm; ids unchanged
    const after = regen(sketch, cache).sketch
    const edge = lineById(after, projectedId)
    const drawn = lineById(after, 'drawn')
    expect(edge.start.y).toBeCloseTo(30, 6)
    expect(edge.end.y).toBeCloseTo(30, 6)
    expect(drawn.start.x).toBeCloseTo(edge.start.x, 6)
    expect(drawn.start.y).toBeCloseTo(edge.start.y, 6)
    expect(after.solveStatus?.solveFailed).not.toBe(true)
    // Idempotent: the next pass over an unchanged model rewrites nothing (no payload churn, no
    // follow-up regen on every resync).
    expect(relinkProjectedEntities(after.entities, resolverFor(cache)).changed).toBe(false)
    expect(relinkProjectedEntities(sketch.entities, resolverFor((() => {
      const same = new GeometryCache()
      same.ingest(BODY, blockBuffers(20, 40))
      return same
    })())).changed).toBe(false)

    // CONTROL: the same model change WITHOUT the re-resolution leaves both behind -- the follow is
    // the relink's doing, not the solve's.
    const unrelinked = solveRelinkedSketch(sketch, XZ, wrapper)
    expect(lineById(unrelinked, projectedId).start.y).toBeCloseTo(20, 6)
    expect(lineById(unrelinked, 'drawn').start.y).toBeCloseTo(20, 6)
  })

  it('a shorter edge: the projection follows the new extent and the sketch stays solvable', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const { sketch, projectedId } = projectedEdgeSketch(cache)
    cache.ingest(BODY, blockBuffers(20, 25))
    const after = regen(sketch, cache).sketch
    const edge = lineById(after, projectedId)
    const xs = [edge.start.x, edge.end.x].sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 6)
    expect(xs[1]).toBeCloseTo(25, 6)
    expect(lineById(after, 'drawn').start).toEqual(edge.start)
    expect(after.solveStatus?.solveFailed).not.toBe(true)
    expect(after.solveStatus?.conflicting ?? []).toEqual([])
  })

  it('break the link on one piece: it stays put, its siblings follow, WO-058 editing still holds', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const commit = commitProjection(pickCandidate(cache, faceHit()))
    expect(commit.entities).toHaveLength(4)
    const brokenId = commit.entities.find((entity) =>
      entity.kind === 'line' && entity.start.y === 20 && entity.end.y === 20)!.id
    const broken = breakProjectionLinks(commit.entities, [brokenId])!
    const brokenBefore = broken.find((entity) => entity.id === brokenId) as SketchLineEntity
    expect(brokenBefore.projectionLink).toBeUndefined()
    expect(brokenBefore.provenance).toBe('projected')
    const sketch = solveRelinkedSketch(sketchOf(broken, commit.constraints), XZ, wrapper)

    cache.ingest(BODY, blockBuffers(20, 50)) // the right face moves 10 mm
    const after = regen(sketch, cache).sketch
    expect(lineById(after, brokenId).start).toEqual(brokenBefore.start)
    expect(lineById(after, brokenId).end).toEqual(brokenBefore.end)
    const followers = after.entities.filter((entity) => entity.projectionLink !== undefined) as SketchLineEntity[]
    expect(followers).toHaveLength(3)
    expect(followers.some((entity) => entity.start.x === 50 || entity.end.x === 50)).toBe(true)
    expect(buildReferenceRows(after.entities).find((row) => row.entityId === brokenId)?.status).toBe('not-linked')

    // WO-058: a geometric edit on the broken piece releases its projection grounding, keeps the
    // provenance colour, and a linked piece's edit also drops its link (an edited piece that kept
    // following the model would undo the edit).
    const linkedId = followers[0].id
    const edited = markProjectedGeometryDetached(after.entities, after.entities, [brokenId, linkedId])
    const constraints = detachProjectedFixes(after.entities, after.constraints, [brokenId, linkedId])
    for (const id of [brokenId, linkedId]) {
      const entity = edited.find((e) => e.id === id)!
      expect(entity.provenance).toBe('projected')
      expect(entity.projectionDetached).toBe(true)
      expect(entity.projectionLink).toBeUndefined()
      expect(constraints.some((c) => c.kind === 'fix' && c.entityId === id)).toBe(false)
    }
  })

  it('delete the referenced feature: geometry stays, the reference is named unresolved, it still solves and bakes', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const commit = commitProjection(pickCandidate(cache, faceHit()))
    const sketch = solveRelinkedSketch(sketchOf(commit.entities, commit.constraints), XZ, wrapper)

    const gone = regen(sketch, cache, false)
    expect(gone.newlyUnresolved).toBe(1)
    const kept = gone.sketch
    for (const entity of kept.entities) {
      const was = sketch.entities.find((e) => e.id === entity.id)!
      expect((entity as SketchLineEntity).start).toEqual((was as SketchLineEntity).start)
      expect(entity.projectionLink?.unresolved).toBe(true)
    }
    expect(kept.solveStatus?.solveFailed).not.toBe(true)
    const baked = bakeSketch(kept)
    expect(baked.loops.length).toBe(1)
    const rows = buildReferenceRows(kept.entities)
    // WO-2858: the reference reads "Face"; the link keeps the face's stable key.
    expect(rows.every((row) => row.status === 'unresolved' && row.sourceLabel === 'Face')).toBe(true)
    expect(rows[0].detail).toContain('"Face" could not be found')
    expect(rows[0].detail).not.toContain(FRONT)
    const links = kept.entities.map((entity) => entity.projectionLink!)
    expect(links.every((link) => link.stableId === FRONT)).toBe(true)
    expect(unresolvedReferenceSentence('Sketch 2', links))
      .toBe('Sketch 2: the projected reference "Face" could not be found in the model; ' +
        'its geometry stays where it last stood.')
    // Reported once: the next pass with the source still gone says nothing new.
    expect(regen(kept, cache, false).newlyUnresolved).toBe(0)
    // The source comes back (undo): the mark clears and the pieces follow again.
    const back = regen(kept, cache, true).sketch
    expect(back.entities.every((entity) => entity.projectionLink?.unresolved === undefined)).toBe(true)
  })

  it('a changed shape (an edge that now tessellates differently) is kept, not mangled', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const { sketch, projectedId } = projectedEdgeSketch(cache)
    const bent = blockBuffers(20, 40)
    // Same id, but the edge now has three points (two pieces) where one piece was committed.
    const top = bent.edgeIds.indexOf(E_TOP)
    const positions = [...bent.edgePositions]
    positions.splice((top + 1) * 6 - 3, 0, 20, 0, 25)
    const offsets = [...bent.edgeOffsets].map((offset, index) => (index > top ? offset + 1 : offset))
    cache.ingest(BODY, { ...bent, edgePositions: new Float32Array(positions), edgeOffsets: new Uint32Array(offsets) })
    const result = regen(sketch, cache)
    expect(result.newlyUnresolved).toBe(1)
    expect(lineById(result.sketch, projectedId).start).toEqual(lineById(sketch, projectedId).start)
  })

  it('a projected vertex follows the corner its adjacent edges share', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const commit = commitProjection(pickCandidate(cache, vertexHit()))
    const point = commit.entities[0] as SketchPointEntity
    expect(point.at).toEqual({ x: 40, y: 20 })
    cache.ingest(BODY, blockBuffers(30, 45))
    const after = regen(sketchOf(commit.entities, commit.constraints), cache).sketch
    const moved = after.entities.find((entity) => entity.id === point.id) as SketchPointEntity
    expect(moved.at.x).toBeCloseTo(45, 5)
    expect(moved.at.y).toBeCloseTo(30, 5)
  })

  it('the link survives save/reload through the FeatureDag document', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const { sketch, projectedId } = projectedEdgeSketch(cache)
    const dag = new FeatureDag()
    dag.insertNode({ id: 'sketch3d:SK2', kind: 'sketch', payload: { sketch } })
    const reloaded = FeatureDag.restore(dag.serialize()).getNode('sketch3d:SK2')!.payload.sketch as Sketch
    expect(reloaded.entities.find((entity) => entity.id === projectedId)?.projectionLink)
      .toEqual(sketch.entities.find((entity) => entity.id === projectedId)?.projectionLink)
    cache.ingest(BODY, blockBuffers(30, 40))
    const after = regen(reloaded, cache).sketch
    expect(lineById(after, projectedId).start.y).toBeCloseTo(30, 6)
    expect(lineById(after, 'drawn').start.y).toBeCloseTo(30, 6)
  })

  it('copy/paste makes a detached copy: no link, provenance kept, shown not linked, never snapped back', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const { sketch, projectedId } = projectedEdgeSketch(cache)
    const payload = captureSketchClipboard(sketch, [projectedId])!
    const pasted = instantiateSketchClipboard(payload, { x: payload.anchor.x + 7, y: payload.anchor.y - 3 }, newId)
    expect(pasted.entities).toHaveLength(1)
    expect(pasted.entities[0].projectionLink).toBeUndefined()
    expect(pasted.entities[0].provenance).toBe('projected')
    const withPaste = { ...sketch, entities: [...sketch.entities, ...pasted.entities] }
    expect(buildReferenceRows(withPaste.entities).find((row) => row.entityId === pasted.entities[0].id)?.status)
      .toBe('not-linked')
    cache.ingest(BODY, blockBuffers(30, 40))
    const after = regen(withPaste, cache).sketch
    const copy = lineById(after, pasted.entities[0].id)
    expect(copy.start).toEqual((pasted.entities[0] as SketchLineEntity).start)
    expect(lineById(after, projectedId).start.y).toBeCloseTo(30, 6)
  })

  it('a moved-in-place or spread copy of a linked piece follows nothing (its stale link is dropped)', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const { sketch, projectedId } = projectedEdgeSketch(cache)
    const original = lineById(sketch, projectedId)
    // transformTools' copy keeps every other field of the source entity (it drops provenance).
    const { provenance: _p, ...spread } = { ...original, id: 'spread-copy', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }
    const moved = { ...original, id: 'moved', projectionDetached: true as const, start: { x: 3, y: 3 }, end: { x: 4, y: 4 } }
    const withCopies = { ...sketch, entities: [...sketch.entities, spread as SketchEntity, moved] }
    cache.ingest(BODY, blockBuffers(30, 40))
    const after = regen(withCopies, cache).sketch
    expect(lineById(after, 'spread-copy').start).toEqual({ x: 1, y: 1 })
    expect(lineById(after, 'spread-copy').projectionLink).toBeUndefined()
    expect(lineById(after, 'moved').start).toEqual({ x: 3, y: 3 })
    expect(lineById(after, 'moved').projectionLink).toBeUndefined()
    expect(lineById(after, projectedId).start.y).toBeCloseTo(30, 6)
  })
})

describe('WO-1864: the constraint browser names every projected reference', () => {
  afterEach(cleanup)

  it('renders linked, unresolved (named) and not-linked rows; only live links offer Break', async () => {
    const { ProjectionReferenceSection } = await import('../../components/panels/sketch/ConstraintBrowser')
    const cache = new GeometryCache()
    cache.ingest(BODY, blockBuffers(20, 40))
    const commit = commitProjection(pickCandidate(cache, faceHit()))
    const [linked, gone, copy, ...rest] = commit.entities
    const entities: SketchEntity[] = [
      linked,
      { ...gone, projectionLink: { ...gone.projectionLink!, unresolved: true } },
      { ...copy, projectionLink: undefined },
      ...rest,
    ]
    const selected: string[][] = []
    render(createElement(ProjectionReferenceSection, {
      sketch: sketchOf(entities, []), selectedIds: [], onSelect: (ids: string[]) => { selected.push(ids) },
    }))
    const row = (id: string) => screen.getByTestId(`sketch-browser-reference-${id}`)
    expect(row(linked.id).getAttribute('data-reference-status')).toBe('linked')
    expect(row(gone.id).getAttribute('data-reference-status')).toBe('unresolved')
    expect(row(gone.id).getAttribute('data-tooltip')).toContain('"Face" could not be found in the model')
    expect(row(gone.id).getAttribute('data-tooltip')).not.toContain(FRONT)
    expect(row(copy.id).getAttribute('data-reference-status')).toBe('not-linked')
    expect(row(copy.id).textContent).toContain('not linked')
    expect(screen.getByTestId('sketch-browser-references').textContent).toContain('References (4) - 1 unresolved')
    expect(row(copy.id).querySelector('button')).toBeNull()
    fireEvent.click(row(linked.id).querySelector('button')!)
    expect(selected.at(-1)).toEqual([linked.id])
  })
})

// ---- Tier B: the real workbench -------------------------------------------------------------------

describe('WO-1864 tier B: real SolidsWorkbenchPage + occt-wasm kernel', () => {
  let restoreCanvas2d: (() => void) | null = null
  beforeEach(async () => {
    const { stubCanvas2d } = await import('../model3d/stubCanvas2d')
    restoreCanvas2d = stubCanvas2d()
  })
  afterEach(() => {
    cleanup()
    restoreCanvas2d?.()
    restoreCanvas2d = null
  })

  it('an edge projected into a YZ sketch, and a line tied to it, follow a real extrude edit and a Push/Pull; deleting the body leaves it named unresolved', async () => {
    const { SolidsWorkbenchPage } = await import('../../components/model3d')
    const { createLocalGeomService } = await import('../../geom')
    const { createFakeSceneRuntime } = await import('../model3d/fakeSceneRuntime')
    const { waitForLoadedModel3d: waitFor } = await import('../model3d/loadTolerantWaitFor')
    const { mintRectangleSketch } = await import('../model3d/mintRectangleSketch')
    const { workbenchSketchDocumentPort } = await import('../../components/model3d/workbench/workbenchSketchDocumentPort')
    const { sketchSessionStore } = await import('../../components/model3d/workbench/sketchSessionStore')
    const { sketcherTools } = await import('../../lib/sketch/sketcher')
    const { useCamStore } = await import('../../store')
    const { BASE_PLANE_FRAMES } = await import('../../components/model3d/workbench/basePlanes')
    type Runtime = ReturnType<typeof createFakeSceneRuntime>

    let runtime: Runtime | null = null
    render(createElement(SolidsWorkbenchPage, {
      createClient: createLocalGeomService,
      createSceneRuntime: () => { runtime = createFakeSceneRuntime(); return runtime },
    }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
    const hooks = () => window.__solidsWorkbenchHooks!

    // A 40 x 15 footprint at x 10..50, y 0..15, extruded 20: its top +X edge runs y 0..15 at x 50, z 20.
    await mintRectangleSketch({ width: '40', height: '15', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    const distance = screen.getByTestId('extrude-distance').querySelector('input') as HTMLInputElement
    fireEvent.change(distance, { target: { value: '20' } })
    fireEvent.blur(distance)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })

    // A package sketch on the YZ base plane (local x = world y, local y = world z), picked from the
    // -X side so the ray meets the plane before the body.
    const rt = runtime as unknown as Runtime
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    rt.rayOverride = { origin: { x: -100, y: 25, z: 25 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy(), { timeout: 20_000 })
    const nodeId = sketchSessionStore.getState().sketchNodeId!
    const planeNodeId = hooks().dag.getNode(nodeId)!.payload.planeNodeId as string
    const frame = (hooks().dag.getNode(planeNodeId)!.payload as { lastGoodFrame: typeof BASE_PLANE_FRAMES.yz }).lastGoodFrame
    expect(frame.normal.x).toBeCloseTo(1, 9)

    // Project the edge through the page's own resolver (the pointer path's resolve step).
    const canvas = screen.getByTestId('solids-workbench-canvas')
    const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
    canvas.getBoundingClientRect = () => rect
    // The +X edge of the cap the extrude distance MOVES (capEnd), whichever side of z = 0 the kernel
    // extruded to. A 45 deg ray aimed just outside that edge passes 20 mm from the fixed cap's edge.
    const pickEdge = (capZ: number) => {
      const k = 100
      rt.rayOverride = {
        origin: { x: 50.2 + k, y: 7.5, z: capZ + Math.sign(capZ) * k },
        direction: { x: -Math.SQRT1_2, y: 0, z: -Math.sign(capZ) * Math.SQRT1_2 },
      }
      return workbenchSketchDocumentPort.resolveProjectSource!({
        clientX: 400, clientY: 300, local: { x: 7.5, y: capZ }, tolerance: 0.5,
      })
    }
    let resolved = pickEdge(20)
    // WO-2858: the label reads "Edge"; the cap is told apart by the stable source identity.
    if (!resolved.ok || !resolved.candidate.sourceIdentity?.stableId.includes('capEnd')) resolved = pickEdge(-20)
    expect(resolved.ok, resolved.ok ? '' : resolved.message).toBe(true)
    if (!resolved.ok) return
    expect(resolved.candidate.sourceKind).toBe('model-edge')
    expect(resolved.candidate.sourceIdentity?.stableId).toContain('capEnd')
    expect(resolved.candidate.sourceLabel).toBe('Edge')
    const capZ = resolved.candidate.paths[0].points[0].y // YZ frame: local y is world z
    expect(Math.abs(capZ)).toBeCloseTo(20, 4)
    const side = Math.sign(capZ)

    sketcherTools.armTool('project')
    sketcherTools.click({ x: 7.5, y: capZ }, 0.5, null, false, undefined, resolved)
    const session = sketchSessionStore.getState().sketch!
    const projected = session.entities.find((entity) => entity.projectionLink !== undefined) as SketchLineEntity
    expect(projected).toBeDefined()
    expect(projected.projectionLink).toMatchObject({ sourceKind: 'model-edge', bodyId: 'F1' })

    // Draw a line tied to the projected edge's start (the port's own commit + solve), then Finish.
    const { line, tie } = drawnLineOn(projected)
    workbenchSketchDocumentPort.append({ entities: [line], constraints: [tie] }, [])
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull())

    const stored = (): Sketch => hooks().dag.getNode(nodeId)!.payload.sketch as Sketch
    expect(lineById(stored(), projected.id).start.y).toBeCloseTo(capZ, 4)
    expect(lineById(stored(), 'drawn').start.y).toBeCloseTo(capZ, 4)

    // MOVE THE FACE 10 mm: extrude 20 -> 30 through the page's own regen pass.
    const f1 = hooks().dag.getNode('F1')!
    hooks().dag.setPayload('F1', { ...f1.payload, distance: 30 })
    await hooks().fullResync(['F1'])
    const moved = stored()
    const movedEdge = lineById(moved, projected.id)
    expect(movedEdge.start.y).toBeCloseTo(side * 30, 4)
    expect(movedEdge.end.y).toBeCloseTo(side * 30, 4)
    expect(movedEdge.projectionLink?.unresolved).toBeUndefined()
    expect(lineById(moved, 'drawn').start.x).toBeCloseTo(movedEdge.start.x, 6)
    expect(lineById(moved, 'drawn').start.y).toBeCloseTo(side * 30, 4)
    expect(moved.solveStatus?.solveFailed).not.toBe(true)

    // PUSH/PULL the same cap face another 10 mm: a commit route that publishes the new body WITHOUT a
    // fullResync. The link's body F1 now lives on as the pushPull leaf F2 (followed by lineage).
    rt.rayOverride = { origin: { x: 30, y: 7.5, z: side * 1000 }, direction: { x: 0, y: 0, z: -side } }
    rt.projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })
    const deltaInput = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(deltaInput, { target: { value: '10' } })
    fireEvent.keyDown(deltaInput, { key: 'Enter' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    fireEvent.keyDown(deltaInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().dag.getNode('F2')?.payload.opType).toBe('pushPull')
    await waitFor(() => expect(lineById(stored(), projected.id).start.y).toBeCloseTo(side * 40, 4), { timeout: 20_000 })
    const pushed = stored()
    expect(lineById(pushed, projected.id).end.y).toBeCloseTo(side * 40, 4)
    expect(lineById(pushed, 'drawn').start.y).toBeCloseTo(side * 40, 4)
    expect(lineById(pushed, projected.id).projectionLink?.unresolved).toBeUndefined()

    // A SHORTER edge: footprint height 15 -> 10, so the edge now runs y 0..10.
    const { rectangleProfile } = await import('../../components/model3d/workbench/profileGeometry')
    const sk1 = hooks().dag.getNode('SK1')!
    const profile = rectangleProfile({ sketchId: 'SK1', plane: 'xy', width: 40, height: 10, offset: 10 })
    hooks().dag.setPayload('SK1', { ...sk1.payload, height: 10, profile, regions: [profile] })
    await hooks().fullResync(['SK1'])
    const shorter = lineById(stored(), projected.id)
    const span = [shorter.start.x, shorter.end.x].sort((a, b) => a - b)
    expect(span[0]).toBeCloseTo(0, 4)
    expect(span[1]).toBeCloseTo(10, 4)
    expect(shorter.start.y).toBeCloseTo(side * 40, 4)
    expect(lineById(stored(), 'drawn').start).toEqual(shorter.start)
    expect(stored().solveStatus?.solveFailed).not.toBe(true)

    // DELETE the body: the sketch keeps its geometry, names the reference, still solves.
    const lastStart = { ...shorter.start }
    const lastEnd = { ...shorter.end }
    hooks().dag.removeNode('F2')
    hooks().dag.removeNode('F1')
    await hooks().fullResync([])
    const orphan = stored()
    expect(lineById(orphan, projected.id).start).toEqual(lastStart)
    expect(lineById(orphan, projected.id).end).toEqual(lastEnd)
    expect(lineById(orphan, projected.id).projectionLink?.unresolved).toBe(true)
    expect(lineById(orphan, 'drawn').start).toEqual(lastStart)
    expect(orphan.solveStatus?.solveFailed).not.toBe(true)
    expect(buildReferenceRows(orphan.entities).find((row) => row.entityId === projected.id)?.status).toBe('unresolved')
    const messages = useCamStore.getState().consoleEvents.map((event) => event.message)
    expect(messages.filter((message) => message.includes('could not be found in the model')
      && message.includes(projected.projectionLink!.sourceLabel))).toHaveLength(1)
  }, 120_000)
})
