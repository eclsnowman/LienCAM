// @vitest-environment jsdom
//
// WO UI-4 acceptance #4/#5 end-to-end through the real UI4Demo harness:
// picking a face with the appearance tool and applying a color actually
// paints the mesh; isolating a selection hides everything else (collapses
// non-isolated face triangles to zero area) and "show all" restores it.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { UI4Demo } from '../../components/model3d/demo'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

function boxMesh(runtime: ReturnType<typeof createFakeSceneRuntime>): THREE.Mesh {
  const mesh = runtime.addedObjects.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)
  if (mesh === undefined) throw new Error('box mesh not yet added')
  return mesh
}

function liveCachedBody(): { triFace: Uint32Array; faceIds: readonly string[]; edgeIds: readonly string[] } {
  const hooks = window.__ui4Hooks
  if (hooks === undefined) throw new Error('__ui4Hooks not yet installed')
  return hooks.cachedBody
}

function edgeLines(runtime: ReturnType<typeof createFakeSceneRuntime>): THREE.LineSegments {
  const lines = runtime.addedObjects.find((o): o is THREE.LineSegments => o instanceof THREE.LineSegments)
  if (lines === undefined) throw new Error('edge overlay not yet added')
  return lines
}

/** Count of non-degenerate (still visible) edge segments, box-fixture
 *  invariant: every edge is exactly one straight segment at line-vertex
 *  pair [e*2, e*2+1] (fixtures.ts's makeBoxTessBuffers pushEdge -- same
 *  convention geometryVisibility.test.ts's isolate test relies on). */
function visibleEdgeCount(lines: THREE.LineSegments): number {
  const { edgeIds } = liveCachedBody()
  const position = lines.geometry.getAttribute('position')
  let count = 0
  for (let e = 0; e < edgeIds.length; e++) {
    const p0 = new THREE.Vector3().fromBufferAttribute(position, e * 2)
    const p1 = new THREE.Vector3().fromBufferAttribute(position, e * 2 + 1)
    if (p0.distanceTo(p1) > 1) count++
  }
  return count
}

function faceArea(mesh: THREE.Mesh, faceId: string): number {
  const { triFace, faceIds } = liveCachedBody()
  const index = mesh.geometry.getIndex()!
  const position = mesh.geometry.getAttribute('position')
  const p0 = new THREE.Vector3()
  const p1 = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  let total = 0
  for (let t = 0; t < triFace.length; t++) {
    if (faceIds[triFace[t]] !== faceId) continue
    p0.fromBufferAttribute(position, index.getX(t * 3))
    p1.fromBufferAttribute(position, index.getX(t * 3 + 1))
    p2.fromBufferAttribute(position, index.getX(t * 3 + 2))
    total += p1.clone().sub(p0).cross(p2.clone().sub(p0)).length() * 0.5
  }
  return total
}

describe('UI4Demo appearance tool paints the real mesh', () => {
  it('picking a face with the appearance tool and choosing a color paints that face', async () => {
    const runtime = createFakeSceneRuntime()
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    fireEvent.click(screen.getByTestId('ui4-tool-appearance'))
    fireEvent.pointerDown(screen.getByTestId('ui4-canvas')) // fixed ray hits the +Z face

    await waitFor(() => expect(screen.getByTestId('appearance-target-label')).toBeTruthy())
    const colorInput = screen.getByTestId('appearance-color-input') as HTMLInputElement
    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    const mesh = boxMesh(runtime)
    const colorAttr = mesh.geometry.getAttribute('color')
    // Vertex 20 is the top (+Z) face's first vertex (fixtures.ts's box face
    // order, per-face-unique vertices -- same convention as
    // UI4DemoHoverSelect.test.tsx) -- now painted red instead of the default base.
    expect(colorAttr.getX(20)).toBeCloseTo(1, 1)
    expect(colorAttr.getY(20)).toBeCloseTo(0, 1)
    expect(colorAttr.getZ(20)).toBeCloseTo(0, 1)
  })
})

describe('UI4Demo isolate / show-all end-to-end', () => {
  it('isolating a selected face hides every other face; show-all restores them', async () => {
    const runtime = createFakeSceneRuntime()
    render(<UI4Demo createClient={createFakeGeomClient} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('ui4-status').textContent).toMatch(/ready/i))

    // Measure tool, face filter (default), pick the +Z face.
    fireEvent.pointerDown(screen.getByTestId('ui4-canvas'))
    await waitFor(() => expect(screen.getByTestId('measure-outcome')).toBeTruthy())

    const mesh = boxMesh(runtime)
    const lines = edgeLines(runtime)
    const OTHER_FACE = 'FAKEDISPLAY:BOX:face#0' // -X face, definitely not the picked +Z face
    expect(faceArea(mesh, OTHER_FACE)).toBeGreaterThan(1e-6)
    expect(visibleEdgeCount(lines)).toBe(12)

    fireEvent.click(screen.getByTestId('visibility-isolate'))
    await waitFor(() => expect(faceArea(mesh, OTHER_FACE)).toBeLessThan(1e-9))
    // R1.2 rework (UI4.audit.json): isolating the +Z face must ALSO collapse
    // the edge overlay for every hidden face -- only its own 4 boundary
    // edges survive, not the full 12-edge hidden-body wireframe.
    expect(visibleEdgeCount(lines)).toBe(4)

    fireEvent.click(screen.getByTestId('visibility-show-all'))
    await waitFor(() => expect(faceArea(mesh, OTHER_FACE)).toBeGreaterThan(1e-6))
    expect(visibleEdgeCount(lines)).toBe(12)
  })
})
