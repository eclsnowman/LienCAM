// @vitest-environment jsdom
//
// WO-1865: a pierce constraint -- a sketch point held where a 3D model edge crosses the sketch
// plane, following the model.
//
// Real planegcs throughout. The model side is a GeometryCache built from real tessellation buffers
// (the same shape a regenerated body hands the cache: new coordinates, the SAME persistent edge
// ids). The pick runs through the real resolver (projectGeometry.resolveProjectGeometry, pierce
// mode) and the real command path (toolController beginPierce -> Project/Use click) against a
// minimal document port whose writes solve exactly as the workbench port does
// (solveRelinkedSketch = inject origin -> solveSketchOnWrapper -> strip). The regen side is the
// page's relinkProjectedSketches in miniature: relinkPierceConstraints over
// projectGeometry.resolvePierceCrossing, then the same solve.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { EDGE_JOIN } from '../../doc/stable-id'
import type { TessBuffers } from '../../geom/geom-service'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import type { EdgePickHit } from '../../viewport3d/types'
import {
  resolvePierceCrossing,
  resolveProjectGeometry,
  type ProjectGeometryVisibility,
} from '../../components/model3d/workbench/projectGeometry'
import { solveRelinkedSketch } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import type { ProjectCandidate, ProjectResolveResult } from '../../lib/sketch/projectUse'
import {
  edgePlaneCrossing,
  pierceUnresolvedSentence,
  relinkPierceConstraints,
  type PierceResolver,
} from '../../lib/sketch/projectLink'
import { buildBrowserModel } from '../../lib/sketch/browserModel'
import { captureSketchClipboard, instantiateSketchClipboard } from '../../lib/sketch/clipboard'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { encodeEndpointSelectionRef } from '../../lib/sketch/centerReferences'
import { piercePointForSelection, planConstraintForSelection } from '../../lib/sketch/constraintActions'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { injectWorkbenchOrigin } from '../../components/model3d/workbench/workbenchOriginAnchor'
import { bindSketcherDocument, sketcherTools } from '../../lib/sketch/sketcher/toolController'
import { sketcherToolStore } from '../../lib/sketch/sketcher/toolStore'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import type {
  PierceConstraint, Sketch, SketchConstraint, SketchEntity, SketchLineEntity, Vec2,
} from '../../lib/sketch/types'

// ---- Fixture -------------------------------------------------------------------------------------

const BODY = 'F1'
const edgeId = (a: string, b: string): string => `(${a}${EDGE_JOIN}${b})`
/** A straight model edge square to the XY sketch plane (seen end-on from above). */
const E_AXIS = edgeId('F1:FACE:a', 'F1:FACE:b')
/** A straight slanted edge. */
const E_SLANT = edgeId('F1:FACE:c', 'F1:FACE:d')

/** The XY base plane: local (x, y) = world (x, y), height = world z. */
const XY = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

type Seg = [number, number, number, number, number, number]

/** A body whose two edges are given; the ids never change with the coordinates. */
function bodyBuffers(axis: Seg, slant: Seg = [0, 0, -10, 20, 10, 10]): TessBuffers {
  const edges: Array<[string, Seg]> = [[E_AXIS, axis], [E_SLANT, slant]]
  return {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: ['F1:FACE:a'],
    edgePositions: new Float32Array(edges.flatMap(([, points]) => points)),
    edgeOffsets: new Uint32Array(edges.map((_, index) => index * 2).concat(edges.length * 2)),
    edgeIds: edges.map(([id]) => id),
  }
}

/** The axis edge as built, crossing the plane at (x, y). */
const axisAt = (x: number, y: number): Seg => [x, y, -10, x, y, 20]

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

const RAY = { origin: { x: 10, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
const edgeHit = (id = E_AXIS): EdgePickHit => ({ kind: 'edge', bodyId: BODY, id, distance: 100, point: { x: 10, y: 5, z: 0 } })

function pick(cache: GeometryCache, id = E_AXIS, pierce = true): ProjectResolveResult {
  return resolveProjectGeometry({
    frame: XY,
    cache,
    picker: {
      pick: (_bodyId, _ray, filter) => (filter === 'edge' ? edgeHit(id) : null),
      pickVertex: () => null,
    },
    ray: RAY,
    visibility: visibility(),
    pierce,
  })
}

function candidateOf(result: ProjectResolveResult): ProjectCandidate {
  if (!result.ok) throw new Error(result.message)
  return result.candidate
}

/** A drawn line whose START will be pierced, plus a second line tied to that start. */
function sketchOf(): Sketch {
  const a: SketchLineEntity = { id: 'a', kind: 'line', construction: false, start: { x: 2, y: 1 }, end: { x: -20, y: -8 } }
  const b: SketchLineEntity = { id: 'b', kind: 'line', construction: false, start: { x: 2, y: 1 }, end: { x: 15, y: -12 } }
  const tie: SketchConstraint = { id: 'tie', kind: 'coincident', a: { entityId: 'b', site: 'start' }, b: { entityId: 'a', site: 'start' } }
  return { id: 'wo1865', layerId: 'workbench', entities: [a, b], constraints: [tie], dimensions: [], solveStatus: null }
}

function line(sketch: Sketch, id: string): SketchLineEntity {
  const found = sketch.entities.find((entity) => entity.id === id)
  if (found?.kind !== 'line') throw new Error(`line ${id} missing`)
  return found
}

function pierceOf(sketch: Sketch): PierceConstraint {
  const found = sketch.constraints.find((c) => c.kind === 'pierce')
  if (found?.kind !== 'pierce') throw new Error('no pierce')
  return found
}

const dist = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y)

function solvedEntities(outcome: ReturnType<typeof solveSketchOnWrapper>): SketchEntity[] {
  if (!outcome.ok) throw new Error(`solve failed: ${outcome.message}`)
  return outcome.entities
}

let wrapper: GcsWrapper
beforeAll(async () => {
  wrapper = await createGcsWrapper()
})

// ---- The real command path, against a minimal document port -------------------------------------

let current: Sketch
let selection: string[]
const notices: string[] = []

/** Every member the tool controller does not reach for pierce is a no-op; the ones it does are real:
 *  reads return the live document/selection, `replace` writes and SOLVES like the workbench port. */
function bindPort(): void {
  const members: Partial<SketchDocumentPort> = {
    getSketch: () => current,
    getSelection: () => selection,
    setSelection: (ids: string[]) => { selection = ids },
    ensureSketch: () => current,
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    notice: (message: string) => { notices.push(message) },
    replace: (next) => {
      current = solveRelinkedSketch({ ...current, ...next }, XY, wrapper)
    },
  }
  const port = new Proxy(members, {
    get: (target, key) => (key in target ? target[key as keyof SketchDocumentPort] : () => undefined),
  }) as SketchDocumentPort
  bindSketcherDocument(port)
}

beforeEach(() => {
  current = solveRelinkedSketch(sketchOf(), XY, wrapper)
  selection = []
  notices.length = 0
  bindPort()
  sketcherTools.resetForDocumentSwitch()
})
afterEach(() => {
  bindSketcherDocument(null)
})

/** Operator: select line a's start, click Pierce, click the model edge. */
function applyPierce(cache: GeometryCache, id = E_AXIS): void {
  selection = [encodeEndpointSelectionRef({ entityId: 'a', site: 'start' })]
  sketcherTools.beginPierce()
  expect(sketcherToolStore.getState().tool).toBe('project')
  expect(sketcherTools.piercePending()).toEqual({ entityId: 'a', site: 'start' })
  sketcherTools.click({ x: 10, y: 5 }, 0.5, null, false, undefined, pick(cache, id))
}

/** One regen pass for this sketch -- the page's relinkProjectedSketches in miniature. */
function resolver(cache: GeometryCache, live = true): PierceResolver {
  return (source, near) => resolvePierceCrossing({
    source, frame: XY, cache, near,
    body: live ? { ok: true, bodyId: BODY } : { ok: false, reason: 'body-lost' },
  })
}
function regen(sketch: Sketch, cache: GeometryCache, live = true): { sketch: Sketch; newlyUnresolved: number; sentence: string } {
  const pierced = relinkPierceConstraints(sketch.constraints, resolver(cache, live))
  const sentence = pierceUnresolvedSentence('Sketch on XY', pierced.newlyUnresolved)
  if (!pierced.changed) return { sketch, newlyUnresolved: pierced.newlyUnresolved.length, sentence }
  return {
    sketch: solveRelinkedSketch({ ...sketch, constraints: pierced.constraints }, XY, wrapper),
    newlyUnresolved: pierced.newlyUnresolved.length,
    sentence,
  }
}

// ---- Tests ---------------------------------------------------------------------------------------

describe('WO-1865 the crossing itself (pure geometry)', () => {
  it('a straight edge is its infinite line; parallel and in-plane edges have no crossing', () => {
    const square = edgePlaneCrossing([{ x: 10, y: 5, z: -10 }, { x: 10, y: 5, z: 20 }], { x: 0, y: 0 })
    expect(square).toEqual({ ok: true, at: { x: 10, y: 5 } })
    // Ends short of the plane: still pierced (a sketch on an offset plane).
    expect(edgePlaneCrossing([{ x: 0, y: 0, z: 5 }, { x: 10, y: 10, z: 15 }], { x: 0, y: 0 }))
      .toEqual({ ok: true, at: { x: -5, y: -5 } })
    expect(edgePlaneCrossing([{ x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: 5 }], { x: 0, y: 0 }))
      .toEqual({ ok: false, reason: 'parallel' })
    expect(edgePlaneCrossing([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], { x: 0, y: 0 }))
      .toEqual({ ok: false, reason: 'in-plane' })
  })

  it('a curved edge crosses within its span; of several crossings the nearest to the point wins', () => {
    // A tessellated half-circle of radius 10 in the XZ plane, centred at z = 0: crosses z = 0 at
    // x = +10 and x = -10.
    const arc = Array.from({ length: 13 }, (_, i) => {
      const t = -Math.PI / 2 + (i * Math.PI) / 12
      return { x: 10 * Math.sin(t), y: 0, z: 10 * Math.cos(t) - 5 }
    })
    const near = edgePlaneCrossing(arc, { x: 9, y: 0 })
    const far = edgePlaneCrossing(arc, { x: -9, y: 0 })
    expect(near.ok && near.at.x).toBeGreaterThan(8)
    expect(far.ok && far.at.x).toBeLessThan(-8)
    const lifted = arc.map((p) => ({ ...p, z: p.z + 20 }))
    expect(edgePlaneCrossing(lifted, { x: 0, y: 0 })).toEqual({ ok: false, reason: 'no-crossing' })
  })
})

describe('WO-1865 pierce through the real pick and command path', () => {
  it('Project/Use alone refuses an end-on edge; Pierce picks it (only edges, 3D polyline carried)', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    const project = pick(cache, E_AXIS, false)
    expect(project.ok).toBe(false)
    const pierce = candidateOf(pick(cache, E_AXIS, true))
    expect(pierce.sourceKind).toBe('model-edge')
    expect(pierce.sourceIdentity?.stableId).toBe(E_AXIS)
    expect(pierce.paths).toEqual([])
    expect(pierce.pierceEdge).toHaveLength(2)
    // Pierce is never a selection-only constraint; the sketch half is one point.
    expect(planConstraintForSelection(current, ['a'], 'pierce').ok).toBe(false)
    expect(piercePointForSelection(current, ['a']).ok).toBe(false)
    expect(piercePointForSelection(current, [encodeEndpointSelectionRef({ entityId: 'a', site: 'end' })]))
      .toEqual({ ok: true, point: { entityId: 'a', site: 'end' } })
  })

  it('applying pierce moves the endpoint exactly onto the crossing and removes two DoF', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    const dofBefore = current.solveStatus!.dof
    applyPierce(cache)
    const a = line(current, 'a')
    expect(dist(a.start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
    expect(dist(line(current, 'b').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
    expect(current.solveStatus!.dof).toBe(dofBefore - 2)
    expect(current.solveStatus?.solveFailed).not.toBe(true)
    expect(current.solveStatus?.conflicting ?? []).toEqual([])
    expect(current.solveStatus?.redundant ?? []).toEqual([])
    expect(pierceOf(current)).toMatchObject({
      point: { entityId: 'a', site: 'start' }, at: { x: 10, y: 5 },
      source: { bodyId: BODY, stableId: E_AXIS },
    })
    expect(pierceOf(current).unresolved).toBeUndefined()
    expect(sketcherTools.piercePending()).toBeNull()
    expect(sketcherToolStore.getState().tool).toBe('select')
    // WO-2858: a projected model edge reads "Edge"; its key stays in the source above.
    expect(notices.at(-1)).toMatch(/^Pierce: Line \d+ now sits where "Edge" crosses the sketch plane/)
    expect(notices.at(-1)).not.toContain(E_AXIS)

    // Shown in the browser like every other constraint, naming its edge.
    const group = buildBrowserModel(current, current.solveStatus).groups.find((g) => g.kind === 'pierce')
    expect(group?.title).toBe('Pierce')
    expect(group?.rows[0].operands).toContain('"Edge"')
    expect(group?.rows[0].operands).not.toContain(E_AXIS)
    expect(group?.rows[0].unresolved).toBeUndefined()
  })

  it('a slanted edge pierces where it crosses, not where it projects', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    applyPierce(cache, E_SLANT)
    // (0,0,-10) -> (20,10,10) crosses z = 0 at (10, 5).
    expect(dist(line(current, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
  })

  it('dragging the rest of the sketch cannot move the pierced point off the crossing', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    applyPierce(cache)
    const injected = injectWorkbenchOrigin(current, XY)
    // Drag line b rigidly (both ends) and line a's free end far away.
    for (const drag of [
      { targets: [{ point: { entityId: 'b', site: 'start' as const }, to: { x: 40, y: 40 } },
        { point: { entityId: 'b', site: 'end' as const }, to: { x: 53, y: 27 } }] },
      { targets: [{ point: { entityId: 'a', site: 'end' as const }, to: { x: -60, y: 70 } }] },
      { targets: [{ point: { entityId: 'a', site: 'start' as const }, to: { x: 0, y: 0 } }] },
    ]) {
      const outcome = solvedEntities(solveSketchOnWrapper(wrapper, injected, drag))
      const a = outcome.find((e) => e.id === 'a') as SketchLineEntity
      const b = outcome.find((e) => e.id === 'b') as SketchLineEntity
      expect(dist(a.start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
      expect(dist(b.start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
    }
  })

  it('model moves 10 mm: the pierced point follows in the same solve, carrying what is tied to it', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    applyPierce(cache)
    const pierced = current

    cache.ingest(BODY, bodyBuffers(axisAt(20, 5))) // the edge now crosses 10 mm away; id unchanged
    const after = regen(pierced, cache).sketch
    expect(dist(line(after, 'a').start, { x: 20, y: 5 })).toBeLessThanOrEqual(1e-9)
    expect(dist(line(after, 'b').start, { x: 20, y: 5 })).toBeLessThanOrEqual(1e-9)
    expect(pierceOf(after).at).toEqual({ x: 20, y: 5 })
    expect(after.solveStatus?.solveFailed).not.toBe(true)
    // Idempotent: an unchanged model rewrites nothing on the next pass.
    expect(relinkPierceConstraints(after.constraints, resolver(cache)).changed).toBe(false)

    // CONTROL (the negative control the order names): resolve once at creation and skip the
    // re-resolution on solve -- the point does NOT follow. The follow is the relink's doing.
    const skipped = solveRelinkedSketch(pierced, XY, wrapper)
    expect(dist(line(skipped, 'a').start, { x: 20, y: 5 })).toBeGreaterThan(9)
    expect(dist(line(skipped, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
  })

  it('edge tilted parallel to the plane: point stays where it was, sketch solvable, unresolved and named', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    applyPierce(cache)
    const pierced = current

    cache.ingest(BODY, bodyBuffers([10, 5, 7, 30, 5, 7])) // tilted flat: no crossing exists
    const { sketch: after, newlyUnresolved, sentence } = regen(pierced, cache)
    expect(newlyUnresolved).toBe(1)
    expect(sentence).toBe(
      'Sketch on XY: the model edge "Edge" runs parallel to the sketch plane, so it does not ' +
      'presently cross it; its pierced point stays where it last was.')
    expect(dist(line(after, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
    expect(after.solveStatus?.solveFailed).not.toBe(true)
    expect(after.solveStatus?.conflicting ?? []).toEqual([])
    // Nothing deleted.
    expect(after.entities.map((e) => e.id)).toEqual(['a', 'b'])
    expect(after.constraints.map((c) => c.id)).toEqual(pierced.constraints.map((c) => c.id))
    expect(pierceOf(after).unresolved).toBe('parallel')
    const row = buildBrowserModel(after, after.solveStatus).groups.find((g) => g.kind === 'pierce')!.rows[0]
    expect(row.unresolved).toMatch(/runs parallel to the sketch plane/)
    expect(row.unresolved).toContain('"Edge"')
    expect(row.unresolved).not.toContain(E_AXIS)
    // A second pass says nothing new; tilting back clears the mark and the point follows again.
    expect(regen(after, cache).newlyUnresolved).toBe(0)
    cache.ingest(BODY, bodyBuffers(axisAt(12, 6)))
    const back = regen(after, cache).sketch
    expect(pierceOf(back).unresolved).toBeUndefined()
    expect(dist(line(back, 'a').start, { x: 12, y: 6 })).toBeLessThanOrEqual(1e-9)
  })

  it('an edge that is gone keeps the point where it was, marked unresolved', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    applyPierce(cache)
    const { sketch: after, sentence } = regen(current, cache, false)
    expect(pierceOf(after).unresolved).toBe('body-lost')
    expect(sentence).toMatch(/could not be found in the model; its pierced point stays where it last was\.$/)
    expect(dist(line(after, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
  })

  it('an edge that does not cross at pick time is still pierced, never refused', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers([0, 20, 7, 30, 20, 7]))
    const startBefore = { ...line(current, 'a').start }
    applyPierce(cache)
    expect(pierceOf(current).unresolved).toBe('parallel')
    expect(dist(line(current, 'a').start, startBefore)).toBeLessThanOrEqual(1e-9)
    expect(notices.at(-1)).toMatch(/does not presently cross it; Line \d+ stays where it is/)
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    expect(dist(line(regen(current, cache).sketch, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
  })

  it('survives save/reload and copy/paste; deleting it releases the point cleanly', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))
    applyPierce(cache)
    const dofPierced = current.solveStatus!.dof

    // Save/reload: plain JSON, the same constraint, and it still drives the re-solve and follows.
    const reloaded = JSON.parse(JSON.stringify(current)) as Sketch
    expect(pierceOf(reloaded)).toEqual(pierceOf(current))
    const resolved = solveRelinkedSketch(reloaded, XY, wrapper)
    expect(dist(line(resolved, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
    cache.ingest(BODY, bodyBuffers(axisAt(20, 5)))
    expect(dist(line(regen(reloaded, cache).sketch, 'a').start, { x: 20, y: 5 })).toBeLessThanOrEqual(1e-9)
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5)))

    // Copy/paste: the copy's point is pierced by the same edge.
    const payload = captureSketchClipboard(current, ['a'])!
    let n = 0
    const pasted = instantiateSketchClipboard(payload, { x: payload.anchor.x + 30, y: payload.anchor.y }, () => `p${n++}`)
    const pastedPierce = pasted.constraints.find((c) => c.kind === 'pierce') as PierceConstraint
    const copyId = pasted.entities[0].id
    expect(pastedPierce).toMatchObject({ point: { entityId: copyId, site: 'start' }, source: pierceOf(current).source })
    const withPaste = solveRelinkedSketch({
      ...current, entities: [...current.entities, ...pasted.entities], constraints: [...current.constraints, ...pasted.constraints],
    }, XY, wrapper)
    expect(dist(line(withPaste, copyId).start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)

    // Delete: the constraint goes, the geometry stays where it was, two DoF come back, and the point
    // drags freely.
    const deleted = deleteFromSketch(current, [pierceOf(current).id])!
    const released = solveRelinkedSketch({ ...current, ...deleted }, XY, wrapper)
    expect(released.constraints.some((c) => c.kind === 'pierce')).toBe(false)
    expect(released.entities.map((e) => e.id)).toEqual(['a', 'b'])
    expect(dist(line(released, 'a').start, { x: 10, y: 5 })).toBeLessThanOrEqual(1e-9)
    expect(released.solveStatus!.dof).toBe(dofPierced + 2)
    const dragged = solveSketchOnWrapper(wrapper, injectWorkbenchOrigin(released, XY), {
      targets: [{ point: { entityId: 'a', site: 'start' }, to: { x: 0, y: 0 } }],
    })
    const a = solvedEntities(dragged).find((e) => e.id === 'a') as SketchLineEntity
    expect(dist(a.start, { x: 0, y: 0 })).toBeLessThan(1e-6)
  })

  it('re-piercing a point replaces its old pierce; Esc cancels a waiting pierce', () => {
    const cache = new GeometryCache()
    cache.ingest(BODY, bodyBuffers(axisAt(10, 5), [0, 0, -10, 40, 20, 10]))
    applyPierce(cache)
    applyPierce(cache, E_SLANT) // (0,0,-10) -> (40,20,10) crosses at (20, 10)
    expect(current.constraints.filter((c) => c.kind === 'pierce')).toHaveLength(1)
    expect(pierceOf(current).source.stableId).toBe(E_SLANT)
    expect(dist(line(current, 'a').start, { x: 20, y: 10 })).toBeLessThanOrEqual(1e-9)

    selection = [encodeEndpointSelectionRef({ entityId: 'b', site: 'end' })]
    sketcherTools.beginPierce()
    expect(sketcherTools.piercePending()).not.toBeNull()
    sketcherTools.escape()
    expect(sketcherTools.piercePending()).toBeNull()
  })
})
