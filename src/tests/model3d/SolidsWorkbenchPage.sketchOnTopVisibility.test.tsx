// @vitest-environment jsdom
//
// Q-77 (Operator ruling 2026-07-26): a promoted sketch whose edges lie on the world X/Y axes rendered
// INVISIBLE at the isometric landing camera in the Model workspace. Root cause (confirmed): the
// finished-sketch outline painted at renderOrder 0, opaque, depthTest/depthWrite default-true, while
// the coincident world axes / datum-plane genesis glyphs paint at renderOrder 1..2 -- so with the
// equal-depth LEQUAL tie the furniture overpainted the outline. Operator's ruling: "render the sketch
// geometry on top ... over the top of the axes in the rendering order ... layer ordering would take
// care of this." makeFinishedSketchOutline now draws the outline last (renderOrder above the glyphs)
// with depthTest/Write off, so an on-axis edge stays visible.
//
// These pins assert the render-ordering CONTRACT on the real scene object produced by the at-rest
// paint path (no edit session), using Operator's exact degenerate case (a square with two edges on the
// world axes). Harness mirrors SolidsWorkbenchPage.ellipseOutline.test.tsx.

import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { Sketch as CamSketch, SketchEntity as CamSketchEntity } from '../../lib/sketch/sketcher'
import { workbenchSketchDocumentPort } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { mintRectangleSketch } from './mintRectangleSketch'
import { stubCanvas2d } from './stubCanvas2d'

afterEach(cleanup)

const SKETCH_NODE = 'sketch3d:Q77'
const PLANE_NODE = 'datum:XY'

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

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
    id: 'q77-sketch', layerId: 'workbench',
    entities, constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

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

function materialsOf(line: THREE.LineSegments): THREE.Material[] {
  return Array.isArray(line.material) ? line.material : [line.material]
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

// Operator's exact degenerate case: two edges (bottom, left) lie exactly on the world X and Y axes.
const ON_AXIS_SQUARE: CamSketchEntity[] = [
  { id: 'e1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
  { id: 'e2', kind: 'line', construction: false, start: { x: 40, y: 0 }, end: { x: 40, y: 40 } },
  { id: 'e3', kind: 'line', construction: false, start: { x: 40, y: 40 }, end: { x: 0, y: 40 } },
  { id: 'e4', kind: 'line', construction: false, start: { x: 0, y: 40 }, end: { x: 0, y: 0 } },
]

describe('SolidsWorkbenchPage: finished-sketch outline draws ON TOP of world furniture (Q-77)', () => {
  it('FAILS-IF: the outline object does not sort after the genesis glyphs (renderOrder <= 2)', async () => {
    const runtime = await bootPage()
    await paintFinishedSketch(ON_AXIS_SQUARE)
    // Genesis glyphs paint at renderOrder 1 (ambient), 1.5 (label), 2 (emphasis). The outline must be
    // strictly greater so it is painted last -- otherwise the coincident axis/plane overpaints it.
    await waitFor(() => expect(lastOutline(runtime).renderOrder).toBeGreaterThan(2))
    // Pin the exact contract value so a silent drop back to the default 0 is caught.
    expect(lastOutline(runtime).renderOrder).toBe(10)
  }, 40_000)

  it('FAILS-IF: any outline material still depth-tests or depth-writes (would lose the equal-depth tie)', async () => {
    const runtime = await bootPage()
    await paintFinishedSketch(ON_AXIS_SQUARE)
    await waitFor(() => expect(lastOutline(runtime).renderOrder).toBe(10))
    const mats = materialsOf(lastOutline(runtime))
    expect(mats.length).toBeGreaterThan(0)
    for (const m of mats) {
      expect(m.depthTest, `material ${m.type} depthTest must be false`).toBe(false)
      expect(m.depthWrite, `material ${m.type} depthWrite must be false`).toBe(false)
    }
  }, 40_000)

  it('uses a no-offset screen-space underlay so normal geometry reads on light and dark faces', async () => {
    const runtime = await bootPage()
    await paintFinishedSketch([
      { id: 'normal', kind: 'line', construction: false, start: { x: 20, y: 20 }, end: { x: 60, y: 20 } },
      { id: 'construction', kind: 'line', construction: true, start: { x: 20, y: 30 }, end: { x: 60, y: 30 } },
    ])
    const outline = await waitFor(() => lastOutline(runtime))
    const underlay = outline.children.find(
      (child): child is LineSegments2 =>
        child instanceof LineSegments2 &&
        child.userData.finishedSketchContrastUnderlay === true,
    )
    expect(underlay).toBeDefined()
    expect(underlay!.position.toArray(), 'contrast must not move sketch geometry').toEqual([0, 0, 0])
    expect(underlay!.renderOrder).toBeLessThan(outline.renderOrder)
    expect(underlay!.frustumCulled).toBe(false)
    const underlayMaterial = underlay!.material as LineMaterial
    expect(underlayMaterial.linewidth).toBe(3.25)
    expect(underlayMaterial.depthTest).toBe(false)
    expect(underlayMaterial.depthWrite).toBe(false)
    expect(underlayMaterial.opacity).toBeCloseTo(0.96)

    const materials = materialsOf(outline) as Array<THREE.LineBasicMaterial | THREE.LineDashedMaterial>
    expect(materials[0].color.getHex()).toBe(0x32e6a1)
    expect(materials[1]).toBeInstanceOf(THREE.LineDashedMaterial)
    expect(materials[1].color.getHex()).not.toBe(materials[0].color.getHex())
  }, 40_000)
})

describe('SolidsWorkbenchPage: a finished face-bound sketch is a view-independent overlay', () => {
  it('keeps a real finished top-face sketch visible from both camera sides', async () => {
    const restoreCanvas = stubCanvas2d()
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const runtime = createFakeSceneRuntime()
      capturedRuntime = runtime
      return runtime
    }

    try {
      render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
      await waitFor(
        () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
        { timeout: 20_000 },
      )

      // Build a real kernel body, then drive New Sketch against its actual top
      // face. This is the corrected SK3 acceptance path, not an off-body datum.
      // Occupy both raw sketch IDs so the shared allocator must create the
      // face-bound acceptance sketch as sketch3d:SK3.
      await mintRectangleSketch({ id: 'SK1', width: 8, height: 8, offset: 80 })
      await mintRectangleSketch({ id: 'SK2', width: 40, height: 20, offset: 10 })
      await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
      fireEvent.click(screen.getByTestId('feature-row-SK2'))
      fireEvent.click(screen.getByTestId('workbench-extrude'))
      await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
      commitField('extrude-distance', '20')
      fireEvent.click(screen.getByTestId('dialog-shell-apply'))
      await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined(), { timeout: 20_000 })

      const runtime = capturedRuntime as unknown as FakeSceneRuntime
      runtime.rayOverride = {
        origin: { x: 30, y: 10, z: 1000 },
        direction: { x: 0, y: 0, z: -1 },
      }
      fireEvent.click(screen.getByTestId('workbench-new-sketch'))
      fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK3')).toBeTruthy(), { timeout: 20_000 })

      // Add native geometry through the real workbench document port, then
      // finish the live session so the at-rest outline painter owns it.
      workbenchSketchDocumentPort.beginStep()
      workbenchSketchDocumentPort.append({
        entities: [
          { id: 'face-a', kind: 'line', construction: false, start: { x: -6, y: -4 }, end: { x: 6, y: -4 } },
          { id: 'face-b', kind: 'line', construction: false, start: { x: 6, y: -4 }, end: { x: 6, y: 4 } },
          { id: 'face-c', kind: 'line', construction: false, start: { x: 6, y: 4 }, end: { x: -6, y: 4 } },
          { id: 'face-d', kind: 'line', construction: false, start: { x: -6, y: 4 }, end: { x: -6, y: -4 } },
        ],
        constraints: [],
      }, [])
      fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))

      const outline = await waitFor(() => {
        const found = runtime.addedObjects.find(
          (object): object is THREE.LineSegments =>
            object.userData.workbenchSketchNodeId === 'sketch3d:SK3' &&
            (object as THREE.LineSegments).isLineSegments === true,
        )
        expect(found).toBeDefined()
        return found!
      })
      // Derive both camera sides from the exact world transform handed to
      // Three.js. This catches a bad face frame or object transform as well as
      // a material/order regression.
      outline.updateMatrixWorld(true)
      const origin = outline.getWorldPosition(new THREE.Vector3())
      const normal = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(outline.getWorldQuaternion(new THREE.Quaternion()))
        .normalize()
      for (const side of [1, -1]) {
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
        camera.position.copy(origin).addScaledVector(normal, side * 100)
        camera.up.set(0, Math.abs(normal.z) > 0.99 ? 1 : 0, Math.abs(normal.z) > 0.99 ? 0 : 1)
        camera.lookAt(origin)
        camera.updateMatrixWorld(true)
        const viewDirection = camera.getWorldDirection(new THREE.Vector3())
        expect(Math.sign(viewDirection.dot(normal))).toBe(-side)
        expect(outline.visible).toBe(true)
        expect(outline.frustumCulled).toBe(false)
      }

      // Transparent-pass + depth-disabled is the GPU ordering contract that
      // makes the overlay camera-side independent. Opaque renderOrder alone
      // was insufficient in the real Model workspace.
      for (const material of materialsOf(outline)) {
        expect(material.transparent).toBe(true)
        expect(material.opacity).toBe(1)
        expect(material.depthTest).toBe(false)
        expect(material.depthWrite).toBe(false)
      }
    } finally {
      restoreCanvas()
    }
  }, 60_000)
})

describe('SolidsWorkbenchPage: on-axis edges get a subtly distinct tint (Q-77 complement)', () => {
  it('FAILS-IF: an edge lying on a world axis is NOT routed to the tinted on-axis material group', async () => {
    const runtime = await bootPage()
    await paintFinishedSketch(ON_AXIS_SQUARE)
    // e1 (bottom, on +X) and e4 (left, on +Y) are on-axis -> the on-axis group (materialIndex 2, 2
    // edges * 2 verts = 4). e2/e3 are off-axis -> the normal group (materialIndex 0, 4 verts).
    await waitFor(() => {
      const groups = lastOutline(runtime).geometry.groups
      expect(groups).toEqual([
        { start: 0, count: 4, materialIndex: 0 }, // e2, e3 (off-axis)
        { start: 4, count: 4, materialIndex: 2 }, // e1, e4 (on-axis)
      ])
    })
  }, 40_000)

  it('FAILS-IF: the on-axis material is the same colour as the ordinary sketch colour (no signal)', async () => {
    const runtime = await bootPage()
    await paintFinishedSketch(ON_AXIS_SQUARE)
    await waitFor(() => expect(lastOutline(runtime).geometry.groups.length).toBe(2))
    const mats = materialsOf(lastOutline(runtime)) as THREE.LineBasicMaterial[]
    const normalHex = mats[0].color.getHex()
    const onAxisHex = mats[2].color.getHex()
    expect(normalHex).toBe(0x32e6a1) // saturated native finished-sketch mint
    expect(onAxisHex, 'on-axis tint must differ from the ordinary sketch colour').not.toBe(normalHex)
  }, 40_000)

  it('an all-off-axis sketch leaves the on-axis group empty (no false positives)', async () => {
    const runtime = await bootPage()
    // Shifted fully into the +X+Y quadrant: no edge touches an axis.
    await paintFinishedSketch([
      { id: 'a', kind: 'line', construction: false, start: { x: 20, y: 20 }, end: { x: 60, y: 20 } },
      { id: 'b', kind: 'line', construction: false, start: { x: 60, y: 20 }, end: { x: 60, y: 60 } },
      { id: 'c', kind: 'line', construction: false, start: { x: 60, y: 60 }, end: { x: 20, y: 60 } },
      { id: 'd', kind: 'line', construction: false, start: { x: 20, y: 60 }, end: { x: 20, y: 20 } },
    ])
    await waitFor(() => {
      const groups = lastOutline(runtime).geometry.groups
      // One normal group only; no materialIndex-2 group.
      expect(groups).toEqual([{ start: 0, count: 8, materialIndex: 0 }])
    })
  }, 40_000)
})

describe('SolidsWorkbenchPage: finished Project/Use geometry keeps reference semantics', () => {
  it('routes projected real and construction entities to distinct violet materials', async () => {
    const runtime = await bootPage()
    await paintFinishedSketch([
      {
        id: 'native', kind: 'line', construction: false,
        start: { x: 20, y: 20 }, end: { x: 40, y: 20 },
      },
      {
        id: 'projected', kind: 'line', construction: false, provenance: 'projected',
        start: { x: 20, y: 30 }, end: { x: 40, y: 30 },
      },
      {
        id: 'projected-construction', kind: 'line', construction: true, provenance: 'projected',
        start: { x: 20, y: 40 }, end: { x: 40, y: 40 },
      },
    ])

    await waitFor(() => {
      expect(lastOutline(runtime).geometry.groups).toEqual([
        { start: 0, count: 2, materialIndex: 0 },
        { start: 2, count: 2, materialIndex: 3 },
        { start: 4, count: 2, materialIndex: 4 },
      ])
    })
    const mats = materialsOf(lastOutline(runtime)) as Array<THREE.LineBasicMaterial | THREE.LineDashedMaterial>
    expect(mats[3].color.getHex()).toBe(0xd58cff)
    expect(mats[3].color.getHex()).not.toBe(mats[0].color.getHex())
    expect(mats[4]).toBeInstanceOf(THREE.LineDashedMaterial)
    expect(mats[4].color.getHex()).not.toBe(mats[0].color.getHex())
  }, 40_000)
})
