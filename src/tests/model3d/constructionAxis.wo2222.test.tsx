// @vitest-environment jsdom
//
// WO-2222: Construct Axis through the real workbench page and the real (in-process) kernel. A block
// with a drilled hole; an axis through the hole (a click on its wall), one along an edge, one
// through two vertices; each lands as a datum with the line in the right place. Revolve turns a
// profile about one, Plane at angle turns about one, Flip edits one, and a reload keeps them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const { stepStore } = vi.hoisted(() => ({ stepStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepStore.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepStore.delete(id) }),
}))
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: vi.fn(async () => ({ name: 'Imported fixture', partCount: 1 })),
}))

import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { FeatureDag } from '../../doc'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import { datumAxisLine, isAxisDatumPayload, isOffsetPlaneDatumPayload, type AxisDatumPayload, type AxisLine, type OffsetPlaneDatumPayload } from '../../sketch3d'
import type { Vec3 } from '../../geom/geom-service'
import { useCamStore } from '../../store'

let restoreCanvas: (() => void) | null = null

beforeEach(() => {
  restoreCanvas = stubCanvas2d()
  stepStore.clear()
  useCamStore.setState({ consoleEvents: [] })
})
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  restoreCanvas = null
})

function hooks(): SolidsWorkbenchHooks {
  if (window.__solidsWorkbenchHooks === undefined) throw new Error('workbench hooks unavailable')
  return window.__solidsWorkbenchHooks
}

async function boot(createClient: () => GeomClient): Promise<FakeSceneRuntime> {
  let runtime: FakeSceneRuntime | null = null
  const createRuntime: CreateSceneRuntime = () => {
    runtime = createFakeSceneRuntime()
    return runtime
  }
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={createRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  const canvas = screen.getByTestId('solids-workbench-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect)
  return runtime as unknown as FakeSceneRuntime
}

function setDialogNumber(testId: string, value: string): void {
  const root = screen.getByTestId(testId)
  const input = root instanceof HTMLInputElement ? root : root.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`${testId} has no input`)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}
const select = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } })
async function waitForApplyEnabled(): Promise<void> {
  await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
}
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l } }
const axisOf = (id: string): AxisLine => {
  const node = hooks().dag.getNode(id)
  if (node === undefined || !isAxisDatumPayload(node.payload)) throw new Error(`${id} is not an axis datum`)
  const line = datumAxisLine(node.payload as AxisDatumPayload)
  if (line === undefined) throw new Error(`${id} has no line`)
  return line
}
/** distance from p to the infinite line */
const offLine = (line: AxisLine, p: Vec3): number => {
  const d = { x: p.x - line.origin.x, y: p.y - line.origin.y, z: p.z - line.origin.z }
  const t = d.x * line.dir.x + d.y * line.dir.y + d.z * line.dir.z
  return Math.hypot(d.x - t * line.dir.x, d.y - t * line.dir.y, d.z - t * line.dir.z)
}

/** A 40 x 20 x 10 block (extruded from a rectangle sketch) with a 4 mm hole 2 deep drilled at (15, 5). */
async function blockWithHole(runtime: FakeSceneRuntime): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  setDialogNumber('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined(), { timeout: 20_000 })
  fireEvent.click(screen.getByTestId('workbench-hole'))
  runtime.rayOverride = { origin: { x: 15, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  setDialogNumber('hole-diameter', '4')
  setDialogNumber('hole-blind-distance', '2')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeDefined(), { timeout: 20_000 })
}

async function clickAt(runtime: FakeSceneRuntime, origin: Vec3, direction: Vec3): Promise<void> {
  runtime.rayOverride = { origin, direction: unit(direction) }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

describe('Construct: Axis', () => {
  it('the Construct group has Axis; its palette offers the three kinds and waits for a pick', async () => {
    await boot(createFakeGeomClient)
    const construct = screen.getByTestId('workbench-rail-section-construct')
    expect(construct.querySelector('[data-testid="workbench-axis"]')).not.toBeNull()
    fireEvent.click(screen.getByTestId('workbench-axis'))
    const types = [...(screen.getByTestId('axis-type') as HTMLSelectElement).options].map((o) => o.textContent)
    expect(types).toEqual(['Through a cylinder or hole', 'Along an edge', 'Through two points'])
    expect(screen.getByTestId('axis-picked').textContent).toBe('Nothing picked yet.')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  it('through the hole, along an edge, through two points; Revolve and Plane at angle about an axis; flip; reload', async () => {
    // the kernel's own revolve requests, to see the axis it was actually handed
    const revolveAxes: Array<{ origin: Vec3; dir: Vec3 }> = []
    const runtime = await boot(() => {
      const client = createLocalGeomService()
      const makeRevolve = client.makeRevolve.bind(client)
      client.makeRevolve = (req) => {
        revolveAxes.push(req.axis)
        return makeRevolve(req)
      }
      return client
    })
    await blockWithHole(runtime)
    const map = hooks().map
    const faces = hooks().getBodyFaceIds('F2') ?? []
    const wall = faces.find((id) => map.snapshotOf(id)?.surfaceType === 'cylinder')
    expect(wall).toBeDefined()
    const planar = faces.map((id) => map.snapshotOf(id)).filter((s) => s?.surfaceType === 'plane')
    const top = Math.max(...planar.filter((s) => (s!.normal?.z ?? 0) > 0.9).map((s) => s!.centroid.z))
    const front = Math.min(...planar.filter((s) => (s!.normal?.y ?? 0) < -0.9).map((s) => s!.centroid.y))
    const left = Math.min(...planar.filter((s) => (s!.normal?.x ?? 0) < -0.9).map((s) => s!.centroid.x))
    const right = Math.max(...planar.filter((s) => (s!.normal?.x ?? 0) > 0.9).map((s) => s!.centroid.x))
    const back = Math.max(...planar.filter((s) => (s!.normal?.y ?? 0) > 0.9).map((s) => s!.centroid.y))

    // 1. through the hole: a ray down into the opening that meets the far wall
    fireEvent.click(screen.getByTestId('workbench-axis'))
    await clickAt(runtime, { x: 15, y: 3.5, z: top + 0.5 }, { x: 0, y: 1, z: -0.5 })
    await waitFor(() => expect(screen.getByTestId('axis-picked').textContent).toContain('cylinder or hole'), { timeout: 20_000 })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:AX1')).toBeDefined(), { timeout: 20_000 })
    const hole = axisOf('datum:AX1')
    expect(Math.abs(hole.dir.z)).toBeCloseTo(1, 6)
    expect(offLine(hole, { x: 15, y: 5, z: 0 })).toBeLessThan(1e-4)
    expect(hooks().dag.getNode('datum:AX1')!.consumes).toEqual(['F2'])
    expect(hooks().dag.getNode('datum:AX1')!.refs).toEqual([{ id: wall, kind: 'single-face', role: 'axisFace', elementType: 'face' }])

    // 2. along the front top edge (y = front, z = top)
    fireEvent.click(screen.getByTestId('workbench-axis'))
    select('axis-type', 'edge')
    // (the fake camera looks down -Z, so the ray comes from above, as a real one would)
    await clickAt(runtime, { x: 30, y: front - 50, z: top + 50 }, { x: 0, y: 1, z: -1 })
    await waitFor(() => expect(screen.getByTestId('axis-picked').textContent).toContain('along the edge'), { timeout: 20_000 })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:AX2')).toBeDefined(), { timeout: 20_000 })
    const edge = axisOf('datum:AX2')
    expect(Math.abs(edge.dir.x)).toBeCloseTo(1, 6)
    expect(offLine(edge, { x: -50, y: front, z: top })).toBeLessThan(1e-4)
    expect(hooks().dag.getNode('datum:AX2')!.refs.map((r) => r.role)).toEqual(['edgeFace', 'edgeFace'])

    // 3. through two top corners: front-left then back-right
    fireEvent.click(screen.getByTestId('workbench-axis'))
    select('axis-type', 'two-points')
    await clickAt(runtime, { x: left - 50, y: front - 50, z: top + 50 }, { x: 50, y: 50, z: -50 })
    await waitFor(() => expect(screen.getByTestId('axis-picked').textContent).toContain('now the second'), { timeout: 20_000 })
    await clickAt(runtime, { x: right + 50, y: back + 50, z: top + 50 }, { x: -50, y: -50, z: -50 })
    await waitFor(() => expect(screen.getByTestId('axis-picked').textContent).toContain('two points'), { timeout: 20_000 })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:AX3')).toBeDefined(), { timeout: 20_000 })
    const diagonal = axisOf('datum:AX3')
    expect(diagonal.origin.x).toBeCloseTo(left, 4)
    expect(diagonal.origin.y).toBeCloseTo(front, 4)
    expect(diagonal.origin.z).toBeCloseTo(top, 4)
    expect(diagonal.length).toBeCloseTo(Math.hypot(right - left, back - front), 4)

    // 4. Revolve the sketch rectangle 90 deg about the edge axis
    fireEvent.click(screen.getByTestId('workbench-revolve'))
    select('revolve-axis', 'datum:AX2')
    setDialogNumber('revolve-angle', '90')
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).toBeDefined(), { timeout: 30_000 })
    const revolve = hooks().dag.getNode('F3')!
    expect(revolve.payload).toMatchObject({ opType: 'revolve', axisDatumId: 'datum:AX2', angleDeg: 90 })
    expect(revolve.consumes).toContain('datum:AX2')
    const handed = revolveAxes[revolveAxes.length - 1]
    expect(Math.abs(handed.dir.x)).toBeCloseTo(1, 6)
    expect(offLine({ origin: handed.origin, dir: unit(handed.dir), length: 1 }, { x: 0, y: front, z: top })).toBeLessThan(1e-4)


    // 5. Plane at angle: XY turned 90 deg about the edge axis stands up through that edge
    fireEvent.click(screen.getByTestId('workbench-angle-plane'))
    select('offset-plane-source', 'datum:XY')
    select('construction-plane-hinge', 'axis:datum:AX2')
    fireEvent.change(screen.getByTestId('construction-plane-angle'), { target: { value: '90' } })
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('datum:RP1')).toBeDefined(), { timeout: 20_000 })
    const rp = hooks().dag.getNode('datum:RP1')!
    expect(isOffsetPlaneDatumPayload(rp.payload)).toBe(true)
    expect([...rp.consumes].sort()).toEqual(['datum:AX2', 'datum:XY'])
    const frame = (rp.payload as OffsetPlaneDatumPayload).lastGoodFrame!
    expect(Math.abs(frame.normal.y)).toBeCloseTo(1, 6)
    expect(frame.origin.y).toBeCloseTo(front, 4)
    expect(frame.origin.z).toBeCloseTo(top, 4)

    // 6. Flip edits the hole axis from its tree row
    fireEvent.click(screen.getByTestId('feature-row-datum:AX1'))
    await waitFor(() => expect((screen.getByTestId('workbench-edit-feature') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    expect(screen.getByTestId('dialog-shell').textContent).toContain('Edit axis')
    fireEvent.click(screen.getByTestId('axis-flip'))
    await waitForApplyEnabled()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(axisOf('datum:AX1').dir.z).toBeCloseTo(-hole.dir.z, 6), { timeout: 20_000 })
    expect(offLine(axisOf('datum:AX1'), { x: 15, y: 5, z: 0 })).toBeLessThan(1e-4)

    // 7. the saved document restores every axis and what consumes them
    const restored = FeatureDag.restore(hooks().dag.serialize())
    for (const id of ['datum:AX1', 'datum:AX2', 'datum:AX3']) expect(isAxisDatumPayload(restored.getNode(id)!.payload)).toBe(true)
    expect(restored.getNode('F3')!.consumes).toContain('datum:AX2')
    expect([...restored.getNode('datum:RP1')!.consumes].sort()).toEqual(['datum:AX2', 'datum:XY'])
  }, 120_000)
})
