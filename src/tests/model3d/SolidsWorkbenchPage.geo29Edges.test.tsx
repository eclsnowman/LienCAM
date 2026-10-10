// @vitest-environment jsdom
//
// GEO-29: the Model workspace's non-classic LineSegments2 edge overlay must
// win the coincident visible-edge depth contest without disabling occlusion.
// These tests inspect the actual scene objects produced by
// SolidsWorkbenchPage. Every theme now uses the same screen-space topology
// technique so wireframe width is real even under Classic.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import {
  MODELED_BODY_REST_EDGE_HEX,
  MODELED_BODY_EDGE_RENDER_ORDER,
  MODELED_BODY_WIREFRAME_EDGE_HEX,
  MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX,
} from '../../lib/viewport/lighting/bodyVisualStyle'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { makeFilletedStepEdgeFixture } from '../../viewport3d/fixtures'

// WO-270 removed the Viewport theme setting, so there is no theme left to pin
// or restore here. Nothing in this suite asserted a theme-dependent value: the
// resting edge colour (MODELED_BODY_REST_EDGE_HEX) and the thin/fat technique
// are chosen by SHADING MODE, not by theme (bodyVisualStyle.ts --
// modeledBodyEdgeOverlayOptions already ignores its theme argument), so every
// assertion below is unchanged.
afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function mountBox(
  createClient: () => GeomClient = createLocalGeomService,
): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={() => runtime} />)
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    { timeout: 20_000 },
  )
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  return runtime
}

function createFilletedStepGeomService(): GeomClient {
  const client = createLocalGeomService()
  const fixture = makeFilletedStepEdgeFixture()
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'tessellate') return async () => fixture.buffers
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function bodyMesh(runtime: FakeSceneRuntime): THREE.Mesh {
  const mesh = runtime.addedObjects.find(
    (object): object is THREE.Mesh =>
      object.userData.workbenchFeatureId === 'F1' &&
      (object as LineSegments2 & { isLineSegments2?: boolean }).isLineSegments2 !== true,
  )
  if (mesh === undefined) throw new Error('modeled body mesh not found')
  return mesh
}

function nativeEdgeOverlay(runtime: FakeSceneRuntime): THREE.LineSegments {
  const edgeLines = runtime.scene.children.find(
    (object): object is THREE.LineSegments =>
      object.userData.workbenchFeatureId === 'F1' &&
      object instanceof THREE.LineSegments,
  )
  if (edgeLines === undefined) throw new Error('native modeled-body edge overlay not found')
  return edgeLines
}

function fatEdgeOverlay(runtime: FakeSceneRuntime): LineSegments2 {
  const edgeLines = runtime.scene.children.find(
    (object): object is LineSegments2 =>
      object.userData.workbenchFeatureId === 'F1' &&
      (object as LineSegments2 & { isLineSegments2?: boolean }).isLineSegments2 === true,
  )
  if (edgeLines === undefined) throw new Error('fat modeled-body edge overlay not found')
  return edgeLines
}

function segmentEndpoints(overlay: LineSegments2): number[] {
  const geometry = overlay.geometry as LineSegmentsGeometry
  const starts = geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
  const ends = geometry.getAttribute('instanceEnd') as THREE.InterleavedBufferAttribute
  const points: number[] = []
  for (let i = 0; i < starts.count; i += 1) {
    points.push(
      starts.getX(i), starts.getY(i), starts.getZ(i),
      ends.getX(i), ends.getY(i), ends.getZ(i),
    )
  }
  return points
}

function nativeSegmentEndpoints(overlay: THREE.LineSegments): number[] {
  return Array.from(overlay.geometry.getAttribute('position').array as ArrayLike<number>)
}

describe('GEO-29 modeled-body edge depth reliability', () => {
  // WO-270: this used to be TWO tests with byte-identical assertions, split
  // only by which viewport theme they mounted under ('classic' vs
  // 'brand-blue'). With one shipped theme there is one case, so the pair is
  // merged here rather than left as a duplicate; both bodies' assertions are
  // carried over intact.
  it('renders all 12 native edges after the body with occlusion-safe depth state', async () => {
    const runtime = await mountBox()
    const mesh = bodyMesh(runtime)
    const edgeLines = nativeEdgeOverlay(runtime)
    const material = edgeLines.material as THREE.LineBasicMaterial

    expect(edgeLines).toBeInstanceOf(THREE.LineSegments)
    expect(edgeLines).not.toBeInstanceOf(LineSegments2)
    expect(material).toBeInstanceOf(THREE.LineBasicMaterial)
    expect(material.vertexColors).toBe(false)
    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.polygonOffset).toBe(false)
    expect(edgeLines.renderOrder).toBeGreaterThan(mesh.renderOrder)
    expect(edgeLines.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)

    const position = edgeLines.geometry.getAttribute('position') as THREE.BufferAttribute
    expect(position.count).toBe(24)
  }, 60_000)

  it('preserves all 141 segments through native-shaded -> fat-wire -> native-shaded', async () => {
    const runtime = await mountBox(createFilletedStepGeomService)
    const shadedEdge = nativeEdgeOverlay(runtime)
    const shadedMaterial = shadedEdge.material as THREE.LineBasicMaterial
    const originalEndpoints = nativeSegmentEndpoints(shadedEdge)
    const cacheOwnedGeometry = shadedEdge.geometry
    const cacheGeometryDispose = vi.spyOn(cacheOwnedGeometry, 'dispose')
    const shadedMaterialDispose = vi.spyOn(shadedMaterial, 'dispose')

    expect(originalEndpoints).toHaveLength(141 * 6)
    expect(shadedMaterial.color.getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
    expect(shadedMaterial.depthTest).toBe(true)

    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    fireEvent.click(screen.getByTestId('workbench-shading-unshaded'))
    await waitFor(() => expect(runtime.removedObjects).toContain(shadedEdge))
    const wireEdge = fatEdgeOverlay(runtime)
    const wireMaterial = wireEdge.material as LineMaterial
    expect(cacheGeometryDispose).not.toHaveBeenCalled()
    expect(shadedMaterialDispose).toHaveBeenCalledOnce()
    expect(segmentEndpoints(wireEdge)).toEqual(originalEndpoints)
    expect(wireMaterial.color.getHexString()).toBe(MODELED_BODY_WIREFRAME_EDGE_HEX.slice(1))
    expect(wireMaterial.linewidth).toBe(MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX)
    expect(wireMaterial.depthTest).toBe(false)
    const wireGeometryDispose = vi.spyOn(wireEdge.geometry, 'dispose')
    const wireMaterialDispose = vi.spyOn(wireMaterial, 'dispose')

    fireEvent.click(screen.getByTestId('workbench-shading-shaded-no-edges'))
    await waitFor(() => expect(runtime.removedObjects).toContain(wireEdge))
    const restoredEdge = nativeEdgeOverlay(runtime)
    const restoredMaterial = restoredEdge.material as THREE.LineBasicMaterial
    expect(wireGeometryDispose).toHaveBeenCalledOnce()
    expect(wireMaterialDispose).toHaveBeenCalledOnce()
    expect(restoredEdge).not.toBe(shadedEdge)
    expect(restoredEdge.geometry).toBe(cacheOwnedGeometry)
    expect(restoredEdge.visible).toBe(false)
    expect(nativeSegmentEndpoints(restoredEdge)).toEqual(originalEndpoints)
    expect(restoredMaterial.color.getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
    expect(restoredMaterial.depthTest).toBe(true)
    expect(restoredEdge.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)

    fireEvent.click(screen.getByTestId('workbench-shading-translucent'))
    await waitFor(() => expect(restoredEdge.visible).toBe(true))
    expect(nativeEdgeOverlay(runtime)).toBe(restoredEdge)
    expect(restoredEdge.renderOrder).toBeGreaterThan(bodyMesh(runtime).renderOrder)
  }, 60_000)
})
