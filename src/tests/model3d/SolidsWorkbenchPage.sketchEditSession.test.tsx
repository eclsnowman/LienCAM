// @vitest-environment jsdom
//
// WO SKC-8 (BK-71, AC #1-#4): the workbench sketch session -- entry, drawing, re-entry, and the
// rendered 3D outline of what was drawn.
//
// ---------------------------------------------------------------------------------------------
// WO SKC-15C -- WHY THIS FILE WAS REWRITTEN, DESCRIBE BLOCK BY DESCRIBE BLOCK.
//
// The original drove the page's INLINE sketch draw machine, which this WO deletes. Its five blocks
// each had a different fate, and none of them is silently dropped:
//
//   'sketch edit re-entry (BK-71, AC #1)'      KEPT, retargeted. Edit now re-opens THE Sketcher on the
//                                              node's own `payload.sketch`. Same claims: the session
//                                              opens, round-trips preserve newly-drawn entities, and a
//                                              rectangle-payload sketch is still excluded.
//   'draw tools in the editing session'        KEPT, retargeted. The clicks now go through the package
//                                              tool launcher and the package's own native canvas
//                                              listeners, and land in `payload.sketch`. Escape still
//                                              cancels the draft without ending the session.
//   'Blocker 1: circle/arc actually RENDER'    KEPT, and it is the reason this file still exists. The
//                                              SKC-8-R1 defect was that only `line` entities reached
//                                              the outline loop, so a committed circle/arc was
//                                              INVISIBLE. That loop moved to `drawCamSketchOutline`,
//                                              and the defect is reintroducible there verbatim: delete
//                                              its circle/arc branches and this block goes red.
//   'select-tool grab-anywhere drag'           MOVED DOWN, not deleted. Entity dragging is now the
//                                              package's SketchInteraction + SketchDocumentPort,
//                                              covered by workbenchSketchMount.test.ts (real package,
//                                              real DAG, real CommandHistory: one undo step per
//                                              gesture, undo lands at pre-gesture) and by the CAM
//                                              sketcher's own suites. What is PAGE-specific about a
//                                              drag -- that it never orbits -- is
//                                              SolidsWorkbenchPage.dragOrbitSuppress.test.tsx.
//                                              Re-asserting CAM's drag semantics here would be testing
//                                              the package through two layers of page.
//   'hover feedback (A3/A7)'                   DELETED WITH ITS SUBJECT. It asserted the page's
//                                              `workbench-sketch-hover-grabbable` divs, which mirrored
//                                              page-held hover state. The page holds no hover state
//                                              now; `sketchLayer.setHover` does, inside the package.
//                                              Nothing at this layer is left to assert, and
//                                              oneWorkbenchSketchPointerOwner.test.ts keeps it so.
//
// The real occt-wasm kernel is no longer booted here: every claim below is about pointers, payloads
// and painted vertices, none of which touch the geometry kernel. The kernel-backed end-to-end claim
// (draw through the package -> extrude -> a real body with a measured volume) is
// src/tests/model3d/workbenchKernelVolume.test.ts.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'
import { SKETCH_COLORS } from '../../lib/sketch/sketcher/sketchLayer'
import { mintRectangleSketch } from './mintRectangleSketch'

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

/** jsdom has no PointerEvent; the package reads only MouseEvent fields. React is NOT in this path --
 *  the package attaches native listeners to the canvas in `Sketcher.enter()`. That is the point. */
function pointer(type: string, at: { x: number; y: number }): void {
  canvas().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0 }))
}

/** A tool CLICK is a press+release in place (no drag). */
function click(at: { x: number; y: number }): void {
  pointer('pointerdown', at)
  pointer('pointerup', at)
}

function escape(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

function tool(id: 'select' | 'line' | 'point' | 'circle-center' | 'arc-3pt'): void {
  fireEvent.click(screen.getByTestId(`workbench-package-tool-${id}`))
}

function payloadSketch(nodeId = SKETCH_NODE): CamSketch {
  const node = hooks().dag.getNode(nodeId)
  if (node === undefined) throw new Error(`test: node '${nodeId}' not found`)
  const sketch = node.payload.sketch as CamSketch | undefined
  if (sketch === undefined) throw new Error(`test: node '${nodeId}' has no CAM sketch payload`)
  return sketch
}

function sessionOpen(): boolean {
  return screen.queryByTestId('workbench-package-sketch-toolbar') !== null
}

/**
 * Boot the page and open a package sketch session on the XY base plane. The fake runtime's default
 * camera sits at the world origin, so a raycast onto a plane through the origin is degenerate; it is
 * replaced BEFORE the session opens, because the host captures `runtime.camera` for picking when it
 * is constructed.
 */
async function bootSketch(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

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
  await waitFor(() => expect(sessionOpen()).toBe(true))
  return runtime
}

async function finish(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  await waitFor(() => expect(sessionOpen()).toBe(false))
}

/** Re-enter via the toolbar's Edit button -- what a user presses. */
async function editSelected(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-edit-feature'))
  await waitFor(() => expect(sessionOpen()).toBe(true))
}

/** Vertices in the most recently painted outline `LineSegments`. `addedObjects` is the fake runtime's
 *  own record of `runtime.addObject(...)`, so this reads what the SCENE got, not what the DAG holds. */
function outlineVertexCount(runtime: FakeSceneRuntime): number {
  const segments = runtime.addedObjects.filter(
    (o): o is THREE.LineSegments => (o as THREE.LineSegments).isLineSegments === true,
  )
  const last = segments.at(-1)
  if (last === undefined) return 0
  const pos = last.geometry.getAttribute('position')
  return pos === undefined ? 0 : pos.count
}

function liveSketchLayer(runtime: FakeSceneRuntime): THREE.Group {
  for (const root of [...runtime.addedObjects].reverse()) {
    const layer = root.getObjectByName('__sketch_layer__')
    if (layer instanceof THREE.Group) return layer
  }
  throw new Error('test: live __sketch_layer__ not found')
}

function paintedLineColor(runtime: FakeSceneRuntime, entityId: string): number {
  const line = liveSketchLayer(runtime).children.find((child) => child.name === entityId)
  if (!(line instanceof THREE.Line)) throw new Error(`test: painted line '${entityId}' not found`)
  const material = Array.isArray(line.material) ? line.material[0] : line.material
  if (!(material instanceof THREE.LineBasicMaterial)) {
    throw new Error(`test: painted line '${entityId}' does not use LineBasicMaterial`)
  }
  return material.color.getHex()
}

function paintedPointColor(runtime: FakeSceneRuntime): THREE.Color {
  const cloud = liveSketchLayer(runtime).children.find(
    (child): child is THREE.Points => child instanceof THREE.Points && child.name === '__sketch_points__',
  )
  if (cloud === undefined) throw new Error('test: painted point cloud not found')
  const colors = cloud.geometry.getAttribute('color')
  if (colors === undefined || colors.count !== 1) {
    throw new Error(`test: expected one painted point color, got ${colors?.count ?? 0}`)
  }
  return new THREE.Color(colors.getX(0), colors.getY(0), colors.getZ(0))
}

describe('SolidsWorkbenchPage: the package sketch session (WO SKC-8 AC #2, retargeted by SKC-15C)', () => {
  it('the LINE tool commits a line entity into payload.sketch, through the package', async () => {
    await bootSketch()
    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })

    const lines = payloadSketch().entities.filter((e) => e.kind === 'line')
    // FAILS-IF the mount is not routing: nothing would ever reach payload.sketch.
    expect(lines).toHaveLength(1)
    const line = lines[0] as Extract<CamSketch['entities'][number], { kind: 'line' }>
    // Charter item 3: a NaN sails through every `> tol` comparison in BOTH directions.
    for (const v of [line.start.x, line.start.y, line.end.x, line.end.y]) expect(Number.isFinite(v)).toBe(true)
    expect(line.end.x).toBeGreaterThan(line.start.x)
  }, 40_000)

  it('the CIRCLE tool commits a circle with a real, finite radius', async () => {
    await bootSketch()
    tool('circle-center') // the tool id is 'circle-center'; arming 'circle' silently arms nothing
    click(CENTRE)
    click({ x: CENTRE.x + 60, y: CENTRE.y })

    const circles = payloadSketch().entities.filter((e) => e.kind === 'circle')
    expect(circles).toHaveLength(1)
    const c = circles[0] as Extract<CamSketch['entities'][number], { kind: 'circle' }>
    expect(c.radius).toBeGreaterThan(0)
    expect(Number.isFinite(c.radius)).toBe(true)
  }, 40_000)

  it('the 3-POINT ARC tool commits an arc through three clicked points', async () => {
    await bootSketch()
    tool('arc-3pt')
    click({ x: CENTRE.x - 20, y: CENTRE.y })
    click({ x: CENTRE.x + 60, y: CENTRE.y })
    click({ x: CENTRE.x + 20, y: CENTRE.y - 40 })

    const arcs = payloadSketch().entities.filter((e) => e.kind === 'arc')
    expect(arcs).toHaveLength(1)
    const a = arcs[0] as Extract<CamSketch['entities'][number], { kind: 'arc' }>
    expect(a.radius).toBeGreaterThan(0)
    expect(Number.isFinite(a.startAngle)).toBe(true)
    expect(Number.isFinite(a.endAngle)).toBe(true)
  }, 40_000)

  it('Escape cancels the in-progress draft: no entity is committed, and the SESSION stays open', async () => {
    await bootSketch()
    tool('line')
    click(CENTRE) // first click of a chain: tool state only, no document write
    expect(payloadSketch().entities).toHaveLength(0)

    escape()
    click({ x: CENTRE.x + 100, y: CENTRE.y }) // would have CLOSED the line, had the draft survived
    expect(payloadSketch().entities).toHaveLength(0)
    // FAILS-IF Escape tears the session down: it cancels the draw, never the sketch. (The page's old
    // Escape handler is gone; this is the package's `handleKeyDown` -> `sketcherTools.escape()`.)
    expect(sessionOpen()).toBe(true)
  }, 40_000)
})

describe('SolidsWorkbenchPage: workbench selection repaints the live sketch layer (WO SKC-21 F2)', () => {
  it('setSelection tints line + point geometry immediately, and deselection clears it', async () => {
    const runtime = await bootSketch()

    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })
    escape()

    tool('point')
    click({ x: CENTRE.x, y: CENTRE.y + 60 })
    escape()

    const line = payloadSketch().entities.find(
      (entity): entity is Extract<CamSketch['entities'][number], { kind: 'line' }> => entity.kind === 'line',
    )
    const point = payloadSketch().entities.find(
      (entity): entity is Extract<CamSketch['entities'][number], { kind: 'point' }> => entity.kind === 'point',
    )
    expect(line).toBeDefined()
    expect(point).toBeDefined()
    if (line === undefined || point === undefined) return

    const selectedPointColor = new THREE.Color(SKETCH_COLORS.selected)
    hooks().setSketchSelectedIds([line.id])

    expect(hooks().getSketchSelectedIds()).toEqual([line.id])
    expect(paintedLineColor(runtime, line.id)).toBe(SKETCH_COLORS.selected)
    expect(paintedPointColor(runtime).getHex()).not.toBe(selectedPointColor.getHex())

    // Click and marquee selection both terminate at this exact document-port seam. The real-browser
    // evidence drives those gestures; this deterministic gate isolates propagation into scene paint.
    hooks().setSketchSelectedIds([line.id, point.id])
    expect(new Set(hooks().getSketchSelectedIds())).toEqual(new Set([line.id, point.id]))
    expect(paintedLineColor(runtime, line.id)).toBe(SKETCH_COLORS.selected)
    const pointPaint = paintedPointColor(runtime)
    expect(pointPaint.r).toBeCloseTo(selectedPointColor.r, 6)
    expect(pointPaint.g).toBeCloseTo(selectedPointColor.g, 6)
    expect(pointPaint.b).toBeCloseTo(selectedPointColor.b, 6)

    hooks().setSketchSelectedIds([])
    expect(hooks().getSketchSelectedIds()).toEqual([])
    expect(paintedLineColor(runtime, line.id)).not.toBe(SKETCH_COLORS.selected)
    expect(paintedPointColor(runtime).getHex()).not.toBe(selectedPointColor.getHex())
  }, 40_000)
})

describe('SolidsWorkbenchPage: sketch edit re-entry (WO SKC-8 BK-71, AC #1, retargeted by SKC-15C)', () => {
  it('Edit re-opens THE Sketcher on the selected sketch node, and round-trips preserve drawn entities', async () => {
    await bootSketch()
    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })
    expect(payloadSketch().entities).toHaveLength(1)

    await finish()
    // The sketch node stays selected across Finish, which is what makes Edit reachable.
    await editSelected()
    // FAILS-IF re-entry runs the `create` path instead of `reopen`: the line drawn before Finish
    // would be gone, replaced by a blank document.
    expect(payloadSketch().entities).toHaveLength(1)

    // Draw a SECOND line inside the re-entered session and finish again.
    tool('line')
    click({ x: CENTRE.x, y: CENTRE.y + 80 })
    click({ x: CENTRE.x + 100, y: CENTRE.y + 80 })
    expect(payloadSketch().entities).toHaveLength(2)

    await finish()
    await editSelected() // a THIRD round trip works too
    expect(payloadSketch().entities).toHaveLength(2)
  }, 60_000)

  it('a re-entered sketch arms SELECT, not LINE: the first click picks what is already there', async () => {
    await bootSketch()
    // A fresh, EMPTY plane sketch arms LINE -- an empty canvas with no armed tool is dead.
    expect(screen.getByTestId('workbench-package-tool-line').getAttribute('aria-pressed')).toBe('true')
    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })
    await finish()

    await editSelected()
    // FAILS-IF re-entry arms a draw tool: the user's first click on their own geometry would start a
    // new line on top of it instead of selecting it.
    expect(screen.getByTestId('workbench-package-tool-select').getAttribute('aria-pressed')).toBe('true')
  }, 60_000)

  it('a rectangle-payload sketch has no draw session to re-enter: Edit does not open one', async () => {
    await bootSketch()
    await finish()

    // The 'New sketch' dialog's OWN node shape -- no `sketch` field at all.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('feature-row-SK1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    // FAILS-IF `selectedIsPackageSketch` starts matching a rectangle node: `beginPackageSketch` would
    // open a session over a payload with no `sketch`, and the canvas would be inert.
    expect(sessionOpen()).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------------------------
// WO SKC-8-R1, "Blocker 1" -- the one subject in this file that survived the severing intact.
//
// The audit-caught defect: only `line` entities ever reached the outline loop, so a committed circle
// or arc was INVISIBLE in the 3D view (and silently dropped from the rendered outline on re-entry)
// even though it sat in the document. The loop now lives in `drawCamSketchOutline` and reads CAM
// entities instead of sketch3d ones -- but the defect is reintroducible there verbatim, so the test
// stays, pointed at the new code.
//
// It asserts the RENDERED VERTEX COUNT of the painted LineSegments, never the document. A test that
// re-read `payload.sketch` would pass happily over an empty scene.
describe('SolidsWorkbenchPage: Blocker 1 -- committed circle/arc entities actually RENDER (WO SKC-8-R1)', () => {
  it('FAILS-IF: a drawn circle contributes zero rendered vertices', async () => {
    const runtime = await bootSketch()
    tool('circle-center')
    click(CENTRE)
    click({ x: CENTRE.x + 60, y: CENTRE.y })
    expect(payloadSketch().entities.filter((e) => e.kind === 'circle')).toHaveLength(1)

    await finish() // the outline is painted for a sketch that is no longer being edited
    await waitFor(() => expect(outlineVertexCount(runtime)).toBeGreaterThan(2))
  }, 40_000)

  it('FAILS-IF: a drawn arc contributes zero rendered vertices', async () => {
    const runtime = await bootSketch()
    tool('arc-3pt')
    click({ x: CENTRE.x - 20, y: CENTRE.y })
    click({ x: CENTRE.x + 60, y: CENTRE.y })
    click({ x: CENTRE.x + 20, y: CENTRE.y - 40 })
    expect(payloadSketch().entities.filter((e) => e.kind === 'arc')).toHaveLength(1)

    await finish()
    // A single line contributes exactly 2 vertices; a tessellated arc contributes many.
    await waitFor(() => expect(outlineVertexCount(runtime)).toBeGreaterThan(2))
  }, 40_000)

  it('re-entering a sketch with an existing circle renders it AGAIN on exit (not just on first paint)', async () => {
    const runtime = await bootSketch()
    tool('circle-center')
    click(CENTRE)
    click({ x: CENTRE.x + 60, y: CENTRE.y })
    await finish()
    const first = outlineVertexCount(runtime)
    expect(first).toBeGreaterThan(2)

    await editSelected()
    await finish()
    // FAILS-IF the outline is drawn once and cached (the pre-SKC-15C `!sketchLinesRef.has(id)` gate,
    // which never redrew a `payload.sketch` node): a sketch edited after its first Finish would keep
    // rendering as it looked before the edit, forever.
    await waitFor(() => expect(outlineVertexCount(runtime)).toBe(first))
  }, 60_000)
})

describe('SolidsWorkbenchPage: finished construction style (WO UI-27)', () => {
  it('FAILS-IF: construction remains dashed after Finish while normal geometry stays solid', async () => {
    const runtime = await bootSketch()

    tool('line')
    click({ x: CENTRE.x - 100, y: CENTRE.y - 50 })
    click({ x: CENTRE.x + 100, y: CENTRE.y - 50 })
    escape()

    fireEvent.click(screen.getByTestId('workbench-package-construction'))
    expect(screen.getByTestId('workbench-package-construction').getAttribute('aria-pressed')).toBe('true')
    tool('line')
    click({ x: CENTRE.x - 100, y: CENTRE.y + 50 })
    click({ x: CENTRE.x + 100, y: CENTRE.y + 50 })
    escape()

    const lineEntities = payloadSketch().entities.filter(
      (entity): entity is Extract<CamSketch['entities'][number], { kind: 'line' }> => entity.kind === 'line',
    )
    const normalLine = lineEntities.find((entity) => !entity.construction)
    const constructionLine = lineEntities.find((entity) => entity.construction)
    expect(normalLine).toBeDefined()
    expect(constructionLine).toBeDefined()
    if (normalLine === undefined || constructionLine === undefined) return
    for (const coordinate of [
      normalLine.start.x,
      normalLine.start.y,
      normalLine.end.x,
      normalLine.end.y,
      constructionLine.start.x,
      constructionLine.start.y,
      constructionLine.end.x,
      constructionLine.end.y,
    ]) expect(Number.isFinite(coordinate)).toBe(true)
    expect(normalLine.start.y).not.toBe(constructionLine.start.y)

    await finish()
    const outline = runtime.addedObjects.filter(
      (object): object is THREE.LineSegments => (object as THREE.LineSegments).isLineSegments === true,
    ).at(-1)
    expect(outline).toBeDefined()
    const materials = outline!.material
    expect(Array.isArray(materials)).toBe(true)
    const [normalMaterial, constructionMaterial] = materials as THREE.Material[]
    expect(normalMaterial).not.toBeInstanceOf(THREE.LineDashedMaterial)
    expect((normalMaterial as THREE.LineBasicMaterial).color.getHex()).toBe(0x32e6a1)
    expect(normalMaterial.toneMapped).toBe(false)
    expect(constructionMaterial).toBeInstanceOf(THREE.LineDashedMaterial)
    expect((constructionMaterial as THREE.LineDashedMaterial).color.getHex())
      .not.toBe((normalMaterial as THREE.LineBasicMaterial).color.getHex())
    expect(constructionMaterial.toneMapped).toBe(false)
    const geometry = outline!.geometry
    expect(geometry.groups).toEqual([
      { start: 0, count: 2, materialIndex: 0 },
      { start: 2, count: 2, materialIndex: 1 },
    ])
    const positions = geometry.getAttribute('position')
    expect(positions.itemSize).toBe(3)
    expect(positions.count).toBe(4)
    const expectGroupToCoverLine = (
      group: (typeof geometry.groups)[number],
      line: typeof normalLine,
    ): void => {
      expect(group.count).toBe(2)
      const expected = [line.start, line.end]
      for (let offset = 0; offset < group.count; offset += 1) {
        const vertex = group.start + offset
        expect(positions.getX(vertex)).toBeCloseTo(expected[offset].x)
        expect(positions.getY(vertex)).toBeCloseTo(expected[offset].y)
        expect(positions.getZ(vertex)).toBeCloseTo(0)
      }
    }
    expectGroupToCoverLine(geometry.groups[0], normalLine)
    expectGroupToCoverLine(geometry.groups[1], constructionLine)
    expect(geometry.getAttribute('lineDistance')).toBeDefined()

    const dashed = constructionMaterial as THREE.LineDashedMaterial
    expect(dashed.dashSize).toBe(6)
    expect(dashed.gapSize).toBe(4)
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    const renderer = { domElement: { clientHeight: 1000, height: 1000 } } as THREE.WebGLRenderer
    camera.position.set(0, 0, 100)
    outline!.onBeforeRender(renderer, new THREE.Scene(), camera, outline!.geometry, dashed, new THREE.Group())
    const nearScale = dashed.scale
    camera.position.set(0, 0, 200)
    outline!.onBeforeRender(renderer, new THREE.Scene(), camera, outline!.geometry, dashed, new THREE.Group())
    expect(dashed.scale).toBeCloseTo(nearScale / 2)
  }, 60_000)
})

describe('WO SKC-49-R2 (tooltip gate 4/4): fresh-entry tool arming is empty-after-strip', () => {
  // SolidsWorkbenchPage.tsx:3517 armed SELECT/LINE on raw `openSketch.entities.length` -- a
  // dimension-only re-entry (zero entities, one dimension committed against an axis) would arm
  // LINE as if the sketch were genuinely blank, so the user's first click would start drawing on
  // top of their own dimensioned (if invisible) axis reference instead of selecting it. Routed
  // through the shared `sketchHasUserContent` predicate (entities OR dimensions OR constraints).
  it('a dimension-only re-entry (zero entities, one axis dim) arms SELECT, not LINE', async () => {
    await bootSketch()
    await finish() // the fresh empty entry bakes to nothing; the layer/node still exist

    const priorPayload = hooks().dag.getNode(SKETCH_NODE)!.payload as { sketch: CamSketch }
    hooks().dag.setPayload(SKETCH_NODE, {
      ...priorPayload,
      sketch: {
        ...priorPayload.sketch,
        entities: [],
        dimensions: [{
          id: 'lone-axis-dim', kind: 'distancePL', driving: true, value: 5,
          point: { entityId: '__workbench_origin_anchor__', site: 'self' },
          line: '__sketch_axis_x__',
        }],
        constraints: [],
      },
    })

    await editSelected()
    // FAILS-IF the arming gate is raw entities.length: a genuinely blank canvas and this
    // dimension-only re-entry would both read zero entities, wrongly arming LINE for both.
    expect(screen.getByTestId('workbench-package-tool-select').getAttribute('aria-pressed')).toBe('true')
  }, 60_000)
})
