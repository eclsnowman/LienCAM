// @vitest-environment jsdom
//
// WO SKC-51: Operator's literal repro -- "the ellipse does not display after exiting the sketch ...
// It does extrude, but you must still have it hidden when in part workspace outside of the sketch."
// `drawCamSketchOutline` (SolidsWorkbenchPage.tsx) painted the at-rest outline of a finished sketch,
// but only branched on line/circle/arc; SKC-47/48 added ellipse/elliptical-arc entities to the CAM
// `Sketch` model and this loop never grew a matching branch, so a finished ellipse silently
// contributed zero vertices to the painted outline (it still baked/extruded fine -- sketchProfile.ts's
// own `adaptEntities` already tessellated it for the kernel; only the OUTSIDE-of-session paint path
// was blind to it).
//
// A finished sketch node is injected directly as `payload.sketch` (the same document-of-record shape
// `beginPackageSketch` writes, and the technique UI-50C-R1's capture-workbench.mjs uses) and resynced,
// WITHOUT ever opening an edit session -- this exercises the at-rest render path exactly as Operator's
// repro does (draw, Finish, look at the model with the sketch no longer open).
//
// SKC-51 premise correction (recorded here, not just in the report): the WO's recon named BOTH
// `drawCamSketchOutline` and `drawSketch3dOutline` as needing an ellipse branch. `drawSketch3dOutline`
// reads `payload.document`, a `Sketch3dDocument` (sketch3d/types.ts) whose `Sketch3dEntity` union has
// never had an 'ellipse' / 'elliptical-arc' member and nothing anywhere constructs one -- CAM's
// `Sketch` is the documented SUPERSET (workbenchSketchDocumentPort.ts:16-18) and every workbench sketch
// node has carried `payload.sketch` since SKC-15C. Only the CAM path (below) is reachable for Operator's
// repro, so only it gets a functional test; SolidsWorkbenchPage.tsx carries an inline citation at the
// `payload.document` loop explaining the same thing for the next reader.

import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { tessellateEllipse, tessellateEllipticalArc, type EllipseShape } from '../../lib/sketch/ellipse'
import type { Sketch as CamSketch, SketchEntity as CamSketchEntity } from '../../lib/sketch/sketcher'

afterEach(cleanup)

const SKETCH_NODE = 'sketch3d:SKC51'
const PLANE_NODE = 'datum:XY'

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

/** Boot the page only far enough to reach 'ready' -- no sketch session is ever opened. The at-rest
 *  outline this WO fixes is painted for a sketch that is NOT being edited. */
async function bootPage(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  return captured as unknown as FakeSceneRuntime
}

function blankSketch(entities: CamSketchEntity[]): CamSketch {
  return {
    id: 'skc51-sketch', layerId: 'workbench',
    entities, constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

/** Insert a FINISHED sketch node (never entered) and resync -- the same `payload.sketch` shape
 *  `beginPackageSketch` writes (UI-50C-R1 capture-workbench.mjs precedent). */
async function paintFinishedSketch(entities: CamSketchEntity[]): Promise<void> {
  hooks().dag.insertNode({
    id: SKETCH_NODE, kind: 'sketch', consumes: [PLANE_NODE], refs: [],
    payload: { sketch: blankSketch(entities), planeNodeId: PLANE_NODE, externalRefs: [], dimensionDiagnostics: [] },
  })
  await hooks().fullResync([SKETCH_NODE])
}

function lastOutline(runtime: FakeSceneRuntime): THREE.LineSegments {
  const segments = runtime.addedObjects.filter(
    (o): o is THREE.LineSegments => (o as THREE.LineSegments).isLineSegments === true,
  )
  const last = segments.at(-1)
  if (last === undefined) throw new Error('test: no outline LineSegments was painted')
  return last
}

function outlineVertexCount(runtime: FakeSceneRuntime): number {
  const pos = lastOutline(runtime).geometry.getAttribute('position')
  return pos === undefined ? 0 : pos.count
}

function outlineVertex(runtime: FakeSceneRuntime, index: number): THREE.Vector3 {
  const pos = lastOutline(runtime).geometry.getAttribute('position')
  return new THREE.Vector3().fromBufferAttribute(pos, index)
}

const SHAPE: EllipseShape = { center: { x: 0, y: 0 }, majorRadius: 12, minorRadius: 6, rotation: 0 }

describe('SolidsWorkbenchPage: finished-sketch ellipse outline (WO SKC-51, Operator invisible-ellipse bug)', () => {
  it('FAILS-IF: a finished FULL ELLIPSE contributes zero rendered vertices, and the count matches the shared sampler', async () => {
    const runtime = await bootPage()
    const entity: CamSketchEntity = { id: 'E1', kind: 'ellipse', construction: false, ...SHAPE }
    await paintFinishedSketch([entity])

    // Independent oracle: the SAME shared sampler the fix must call (ellipse.ts, frozen/not owned).
    // A closed ring of n points renders as n LineSegments pairs -> 2n vertices; the sampler's own
    // duplicate closing point is dropped first (matches sketchProfile.ts's tessellatedLineEntities).
    const ring = tessellateEllipse(SHAPE)
    const expectedVerts = (ring.length - 1) * 2
    expect(expectedVerts).toBeGreaterThan(2) // non-vacuous: a degenerate expectation could not fail below

    await waitFor(() => expect(outlineVertexCount(runtime)).toBe(expectedVerts))
  }, 40_000)

  it('FAILS-IF: a finished ELLIPTICAL ARC renders as an OPEN chain -- no fabricated closing segment', async () => {
    const runtime = await bootPage()
    const entity: CamSketchEntity = {
      id: 'A1', kind: 'elliptical-arc', construction: false, ...SHAPE, startParam: 0, endParam: Math.PI,
    }
    await paintFinishedSketch([entity])

    const pts = tessellateEllipticalArc(SHAPE, 0, Math.PI)
    const openVerts = (pts.length - 1) * 2
    const closedVerts = pts.length * 2 // what a wrongly-closed chain would render instead
    expect(openVerts).not.toBe(closedVerts)

    await waitFor(() => expect(outlineVertexCount(runtime)).toBe(openVerts))
    // The rendered chain's two ends must be the arc's true (distinct) endpoints, not wrapped together.
    const first = outlineVertex(runtime, 0)
    const last = outlineVertex(runtime, outlineVertexCount(runtime) - 1)
    expect(first.distanceTo(last)).toBeGreaterThan(1) // half-sweep endpoints are 12mm apart, not coincident
  }, 40_000)

  it('a CONSTRUCTION ellipse lands in the construction geometry group, not the normal one', async () => {
    const runtime = await bootPage()
    const line: CamSketchEntity = {
      id: 'L1', kind: 'line', construction: false, start: { x: -20, y: -20 }, end: { x: -10, y: -20 },
    }
    const ellipse: CamSketchEntity = { id: 'E2', kind: 'ellipse', construction: true, ...SHAPE }
    await paintFinishedSketch([line, ellipse])

    const ring = tessellateEllipse(SHAPE)
    const expectedEllipseVerts = (ring.length - 1) * 2

    await waitFor(() => expect(outlineVertexCount(runtime)).toBe(2 + expectedEllipseVerts))
    const groups = lastOutline(runtime).geometry.groups
    expect(groups).toEqual([
      { start: 0, count: 2, materialIndex: 0 }, // the normal line
      { start: 2, count: expectedEllipseVerts, materialIndex: 1 }, // the construction ellipse
    ])
  }, 40_000)

  it('FAILS-IF: a non-finite ellipse field poisons the whole outline instead of skipping only that entity', async () => {
    const runtime = await bootPage()
    const line: CamSketchEntity = {
      id: 'L2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 },
    }
    const nanEllipse: CamSketchEntity = {
      id: 'E3', kind: 'ellipse', construction: false,
      center: { x: Number.NaN, y: 0 }, majorRadius: 12, minorRadius: 6, rotation: 0,
    }
    await paintFinishedSketch([line, nanEllipse])

    // Only the finite line entity's 2 vertices should render; the NaN entity is skipped, not the outline.
    await waitFor(() => expect(outlineVertexCount(runtime)).toBe(2))
  }, 40_000)

  it('FAILS-IF: a non-finite elliptical-arc field poisons the whole outline instead of skipping only that entity', async () => {
    const runtime = await bootPage()
    const line: CamSketchEntity = {
      id: 'L3', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 },
    }
    const nanArc: CamSketchEntity = {
      id: 'A2', kind: 'elliptical-arc', construction: false,
      ...SHAPE, startParam: Number.NaN, endParam: Math.PI,
    }
    await paintFinishedSketch([line, nanArc])

    await waitFor(() => expect(outlineVertexCount(runtime)).toBe(2))
  }, 40_000)
})
