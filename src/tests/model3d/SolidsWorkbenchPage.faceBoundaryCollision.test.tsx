// @vitest-environment jsdom
//
// GEO-16-R1 (auditor finding 4): CALLER-LEVEL proof of Fold 1. The unit test
// (faceBoundary.test.ts) proves faceOuterBoundaryLoop returns the discriminated
// 'edge-id-collision' refusal; this drives the REAL SolidsWorkbenchPage through
// a genuine face-based New Sketch pick and asserts the CALLER (faceBoundarySeed at
// SolidsWorkbenchPage.tsx:2747) surfaces a warning naming the colliding id +
// count BEFORE opening the sketch WITHOUT projected geometry -- the exact caller
// assertion the audit held as missing ("no test drives faceBoundarySeed or
// observes notify before the boundary-less sketch path continues").
//
// GEO-16's grammar makes the real kernel emit collision-free edge ids, so a
// colliding boundary is UNREACHABLE from a real body. This test injects the
// colliding boundary FIXTURE at the tessellate seam: a thin proxy over the real
// createLocalGeomService duplicates one top-rim edge id of the extruded box, so
// the picked top face's boundary carries a stable id shared by two physical
// edges -- exactly the residual collision Fold 1's fail-closed guard refuses.
// Nothing in production is edited; the page's fold-1 branch is exercised as-is.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import type { GeomClient } from '../../geom'
import type { BodyHandle, TessBuffers, TessQuality } from '../../geom/geom-service'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

/** Duplicate ONE top-rim edge id (an edge all of whose polyline points sit at the
 *  body's max Z, i.e. a boundary edge of the +Z top face) so that id acquires
 *  multiplicity 2 in body.edgeIds -- the colliding boundary fixture. Records the
 *  injected id so the caller test can assert the warning NAMES it. Returns the
 *  tess unchanged if no top-rim edge exists (e.g. a non-box body). */
function injectTopRimCollision(tess: TessBuffers, injected: string[]): TessBuffers {
  const { edgeIds, edgeOffsets, edgePositions } = tess
  if (edgeIds.length === 0 || edgeOffsets.length < 2) return tess
  let maxZ = -Infinity
  for (let p = 0; p < edgePositions.length; p += 3) if (edgePositions[p + 2] > maxZ) maxZ = edgePositions[p + 2]
  const TOL = 1e-3
  let e = -1
  for (let i = 0; i < edgeIds.length; i++) {
    const s = edgeOffsets[i], en = edgeOffsets[i + 1]
    if (en <= s) continue
    let allTop = true
    for (let p = s; p < en; p++) if (Math.abs(edgePositions[p * 3 + 2] - maxZ) > TOL) { allTop = false; break }
    if (allTop) { e = i; break }
  }
  if (e === -1) return tess
  const s = edgeOffsets[e], en = edgeOffsets[e + 1]
  const cnt = en - s
  const dupPts = edgePositions.slice(s * 3, en * 3)
  const newEdgePositions = new Float32Array(edgePositions.length + dupPts.length)
  newEdgePositions.set(edgePositions, 0)
  newEdgePositions.set(dupPts, edgePositions.length)
  const total = edgeOffsets[edgeOffsets.length - 1]
  const newEdgeOffsets = new Uint32Array(edgeOffsets.length + 1)
  newEdgeOffsets.set(edgeOffsets, 0)
  newEdgeOffsets[edgeOffsets.length] = total + cnt
  const newEdgeIds = [...edgeIds, edgeIds[e]] // the SAME id twice -> boundary collision
  injected.push(edgeIds[e])
  return { ...tess, edgeIds: newEdgeIds, edgeOffsets: newEdgeOffsets, edgePositions: newEdgePositions }
}

function makeCollidingClientFactory(): { create: () => GeomClient; injected: string[] } {
  const injected: string[] = []
  const create = (): GeomClient => {
    const real = createLocalGeomService()
    return {
      ...real,
      tessellate: async (h: BodyHandle, q: TessQuality): Promise<TessBuffers> =>
        injectTopRimCollision(await real.tessellate(h, q), injected),
    }
  }
  return { create, injected }
}

describe('SolidsWorkbenchPage: Fold 1 caller notification on a colliding face boundary (GEO-16-R1 finding 4)', () => {
  it('blank entry stays quiet; explicit Project warns by name and mutates nothing on a colliding boundary', async () => {
    const { create, injected } = makeCollidingClientFactory()
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }

    render(<SolidsWorkbenchPage createClient={create} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // Build a real box body to pick a face on (same flow as sketchOnFace.test).
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // A downward ray through the footprint center hits the +Z top face, whose
    // boundary now carries the injected colliding id.
    expect(capturedRuntime).not.toBeNull()
    ;(capturedRuntime as unknown as FakeSceneRuntime).rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    expect(injected.length).toBeGreaterThan(0) // the fixture actually fired at tessellate time

    // Face-based New Sketch is blank-by-default and must not inspect the boundary.
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    // The session still opens (the caller never strands the user on a refusal).
    await waitFor(() => expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy(), { timeout: 20_000 })

    const sketchNodeId = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))
    expect(sketchNodeId).toBeDefined()
    const persisted = () => hooks().dag.getNode(sketchNodeId!)!.payload as {
      externalRefs?: Array<{ entityIds: string[] }>
      sketch?: { entities: unknown[]; constraints: unknown[] }
    }
    expect(persisted().externalRefs ?? []).toEqual([])
    expect(persisted().sketch?.entities ?? []).toEqual([])
    expect(persisted().sketch?.constraints ?? []).toEqual([])
    expect(useCamStore.getState().consoleEvents.some(
      (event) => event.severity === 'warning' && event.message.includes('distinct edges share this stable id'),
    )).toBe(false)

    // Only an explicit Project attempt inspects the colliding source.
    const canvas = screen.getByTestId('solids-workbench-canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.click(screen.getByTestId('workbench-package-tool-project'))
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 300, button: 0 })

    // (1) The Project caller WARNED, naming the colliding id + count. edgeIdCollisionMessage's
    //     exact shape: "... <id> (N distinct edges share this stable id) ...".
    let warn: { message: string } | undefined
    await waitFor(() => {
      warn = useCamStore.getState().consoleEvents.find(
        (ev) => ev.severity === 'warning' && ev.source === 'workbench' && ev.message.includes('distinct edges share this stable id'),
      )
      expect(warn).toBeDefined()
    })
    expect(injected.some((id) => warn!.message.includes(id))).toBe(true) // NAMES the colliding id
    expect(warn!.message).toContain('(2 distinct edges share this stable id)') // and its count
    expect(warn!.message).toContain('GEO-16')

    // (2) The sketch opened WITHOUT projected geometry: the sketch3d node exists
    //     but carries NO projected external refs (the empty-seed path). A removed
    //     guard would instead splice a phantom boundary and project it here.
    const payload = persisted()
    const projectedRefCount = (payload.externalRefs ?? []).reduce((n, r) => n + r.entityIds.length, 0)
    expect(projectedRefCount).toBe(0)
    expect((payload.sketch?.entities ?? []).length).toBe(0)
    expect((payload.sketch?.constraints ?? []).length).toBe(0)
  }, 40_000)
})
