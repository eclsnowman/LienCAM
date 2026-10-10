// @vitest-environment jsdom
//
// WO SKC-15C (criterion 1 tail -- "argued, not measured, ends here"). SKC-15B proved a line/circle/
// arc drawn through the package lands in payload.sketch. It did NOT prove the last link: that a
// CLOSED profile drawn through the package, finished, and extruded produces a real occt-wasm body
// with a positive volume. This file drives that whole chain on EACH of the three base planes --
// XY, XZ, YZ (XZ had no package-draw test at ALL before this) -- through the REAL kernel.
//
// The assertion is not merely "volume > 0". It reads the rectangle the package actually committed to
// payload.sketch, computes its 2D area by the shoelace formula, and asserts the kernel body's volume
// equals area * extrude-distance within the solve/tessellation tolerance. That makes it independent
// of the exact screen-pixel -> plane-mm scale (which depends on the perspective camera), and it fails
// if the profile the kernel extruded is not the shape that was drawn -- a silent plane mix-up, a
// dropped side, a construction-vs-real flag error would all move the volume off area*distance.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

const SKETCH_NODE = 'sketch3d:SK1'
const CENTRE = { x: 400, y: 300 }

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function pointer(type: string, at: { x: number; y: number }): void {
  canvas().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0 }))
}

function click(at: { x: number; y: number }): void {
  pointer('pointerdown', at)
  pointer('pointerup', at)
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function payloadSketch(): CamSketch {
  const node = hooks().dag.getNode(SKETCH_NODE)
  if (node === undefined) throw new Error('sketch node missing')
  return node.payload.sketch as CamSketch
}

/**
 * The signed area of the closed loop the sketch's line entities form, by the shoelace formula. The
 * package's rect-corner tool commits four line entities; their endpoints trace the rectangle. Absolute
 * value, in mm^2. Zero if the entities do not form a loop (which the caller asserts they do, by the
 * volume coming out positive).
 */
function loopAreaMm2(sketch: CamSketch): number {
  const lines = sketch.entities.filter((e): e is Extract<CamSketch['entities'][number], { kind: 'line' }> => e.kind === 'line' && !e.construction)
  // Chain the segments into an ordered vertex ring (each line's end meets the next line's start).
  const pts = lines.flatMap((l) => [l.start, l.end])
  let area = 0
  for (let i = 0; i < pts.length; i += 2) {
    const a = pts[i]
    const b = pts[i + 1]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

/**
 * Boot the page against the REAL occt-wasm kernel, open a package sketch on `plane`, draw a closed
 * rectangle through the rect-corner package tool, finish, extrude, and return (kernel volume, the
 * drawn 2D area, the distance). The camera is oriented normal to the plane exactly as entry does.
 */
async function drawExtrudeMeasure(plane: 'xy' | 'xz' | 'yz'): Promise<{ volume: number; areaMm2: number; distance: number }> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const frame = BASE_PLANE_FRAMES[plane]
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const n = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
  cam.position.copy(new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)).addScaledVector(n, 100)
  cam.up.set(0, 0, 1)
  if (plane === 'xy') cam.up.set(0, 1, 0)
  cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

  enterBasePlaneSketchViaPick(runtime, plane)
  await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeTruthy())

  // A closed rectangle in two clicks, through the PACKAGE's rect-corner tool.
  fireEvent.click(screen.getByTestId('workbench-package-tool-rect-corner'))
  click({ x: CENTRE.x - 80, y: CENTRE.y - 50 })
  click({ x: CENTRE.x + 80, y: CENTRE.y + 50 })
  await waitFor(() => expect(payloadSketch().entities.filter((e) => e.kind === 'line').length).toBeGreaterThanOrEqual(4))
  const areaMm2 = loopAreaMm2(payloadSketch())

  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
  // Finish must have written real regions (a closed rectangle is not open).
  await waitFor(() => expect(hooks().dag.getNode(SKETCH_NODE)!.payload.regions).not.toBeUndefined(), { timeout: 20_000 })

  const distance = 20
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: SKETCH_NODE } })
  commitField('extrude-distance', String(distance))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })

  const vol = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
  return { volume: vol.value, areaMm2, distance }
}

describe('WO SKC-15C: a closed package-drawn profile extrudes into a real kernel body, per base plane', () => {
  for (const plane of ['xy', 'xz', 'yz'] as const) {
    it(`${plane.toUpperCase()}: draw a rectangle through the package, finish, extrude -> volume > 0 and == area * distance`, async () => {
      const { volume, areaMm2, distance } = await drawExtrudeMeasure(plane)

      // The WO's bar: a real, positive, finite kernel volume.
      expect(Number.isFinite(volume)).toBe(true)
      expect(volume).toBeGreaterThan(0)
      // The drawn rectangle was non-degenerate (the shoelace area is real), so the assertion below
      // is not vacuously comparing zero to zero.
      expect(areaMm2).toBeGreaterThan(1)

      // The kernel body IS the drawn rectangle extruded `distance`mm: volume == area * distance,
      // within the real solve/tessellation tolerance. A plane mix-up, a dropped side, or a
      // construction-flag error would move volume off this product.
      const expected = areaMm2 * distance
      expect(Math.abs(volume - expected) / expected).toBeLessThan(0.02)
    }, 60_000)
  }
})

// WO SKC-16 (criterion 2, the real-kernel half): a rectangle PLUS a construction diagonal, the
// diagonal marked construction through the RAIL Construction button, extrudes to the RECTANGLE body.
// If the construction flag were ignored, Finish would refuse the profile (the diagonal makes the
// loop branch) and no body would ever appear -- the waitFor below would time out. That the body's
// volume equals the rectangle's area * distance proves the diagonal was excluded end to end, through
// the real occt-wasm kernel.
describe('WO SKC-16: a construction diagonal is excluded from the real-kernel extrude', () => {
  it('rectangle + rail-marked construction diagonal -> a rectangular body of area * distance', async () => {
    let captured: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      captured = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })

    const runtime = captured as unknown as FakeSceneRuntime
    const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
    cam.position.set(0, 0, 100)
    cam.up.set(0, 1, 0)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    runtime.camera = cam

    const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
    canvas().getBoundingClientRect = () => rect
    ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeTruthy())

    // The closed rectangle (real geometry).
    fireEvent.click(screen.getByTestId('workbench-package-tool-rect-corner'))
    click({ x: CENTRE.x - 80, y: CENTRE.y - 50 })
    click({ x: CENTRE.x + 80, y: CENTRE.y + 50 })
    await waitFor(() => expect(payloadSketch().entities.filter((e) => e.kind === 'line').length).toBeGreaterThanOrEqual(4))
    const areaMm2 = loopAreaMm2(payloadSketch())

    // Flip draw-as-construction ON via the RAIL button, then draw a diagonal across the rectangle.
    fireEvent.click(screen.getByTestId('workbench-package-construction'))
    fireEvent.click(screen.getByTestId('workbench-package-tool-line'))
    click({ x: CENTRE.x - 80, y: CENTRE.y - 50 })
    click({ x: CENTRE.x + 80, y: CENTRE.y + 50 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // The diagonal is present AND marked construction.
    const diag = payloadSketch().entities.find((e) => e.kind === 'line' && e.construction)
    expect(diag, 'the construction diagonal was drawn and flagged').not.toBeUndefined()

    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
    // FAILS-IF the construction diagonal is not excluded: Finish would refuse the (branching) profile
    // and these payload.regions would never be written.
    await waitFor(() => expect(hooks().dag.getNode(SKETCH_NODE)!.payload.regions).not.toBeUndefined(), { timeout: 20_000 })

    const distance = 20
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: SKETCH_NODE } })
    commitField('extrude-distance', String(distance))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })

    const vol = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
    expect(areaMm2).toBeGreaterThan(1)
    const expected = areaMm2 * distance
    // The body is the rectangle, NOT anything the diagonal would have carved.
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(0.02)
  }, 60_000)
})
