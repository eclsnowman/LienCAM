// @vitest-environment jsdom
//
// WO-2516: a Drill's Break through starts the way the hole needs it - on (0.5 mm)
// for a hole that runs through, off for a hole with a floor, and for a 2D circle
// from its Target End against the stock bottom. The operator's own setting wins
// and is kept through recompute, save and reopen.
//
//   production New Operation (real Drill height resolvers) -> Create
//   -> store.computeOperationToolpath -> REAL toolpathWorker.ts -> postProject(UCCNC)
//
// The only stand-in is the Worker thread (node has none): the stub hands each
// request to the real worker module in-process (same harness as WO-2514's test).
//
// Fixtures: a 10 mm plate with work zero on its top (WCS origin machine Z 10),
// a 5 mm 118 deg drill (point length 2.5 / tan 59 deg = 1.50 mm).
//   3D model holes: a through hole (floor at the plate bottom, WCS -10) and a
//   blind hole (floor at WCS -6), from the model's own hole detection.
//   2D circle (DXF): explicit Target End at the stock bottom (-10) or above (-8).

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { ImportedGeometry, Operation, PhysicalStock, Setup, Tool } from '../../types'

// Save and reopen goes through the store's file open; the model caches have no
// IndexedDB here (same stand-ins as adaptiveFloorFinishWithStock.wo2051).
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { UCCNC_CONFIG } = await import('../../lib/post')
const { postProject } = await import('../../lib/post/postProject')
const {
  DRILL_BREAK_THROUGH_DEFAULT_MM, drillBreakThroughDefault, drillPickedHolesThrough,
} = await import('../../lib/cam/smartHeights/drillBore')

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
  location: Location
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
// Vite builds the store's worker URL from self.location, so the scope keeps it.
const workerSelf: WorkerSelf = {
  postMessage: (msg) => { deliver?.(msg) }, onmessage: null, location: window.location,
}

class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

const POINT = 2.5 / Math.tan(59 * Math.PI / 180)
const PLATE = 10

const tool = {
  id: 'drill-5', name: '5 mm Drill', toolNumber: 1, type: 'drill', diameter: 5, tipDiameter: 0, angleFromAxisDeg: 59,
  fluteLength: 30, shankDiameter: 5, overallLength: 70, numberOfFlutes: 2, material: 'hss', coating: 'none',
  notes: '', feedsAndSpeeds: { default: { rpm: 3000, feedRate: 300, plungeRate: 150, depthOfCut: 2, stepover: 1 } },
} as unknown as Tool

const stock = {
  id: 'stock-1', name: 'Plate', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: PLATE },
    size: { x: 60, y: 40, z: PLATE }, center: { x: 30, y: 20, z: PLATE / 2 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

function circle(cx: number, cy: number, r: number) {
  return Array.from({ length: 48 }, (_, k) => ({
    x: cx + r * Math.cos((2 * Math.PI * k) / 48), y: cy + r * Math.sin((2 * Math.PI * k) / 48),
  }))
}

interface HoleSpec { id: string; cx: number; cy: number; floorZ: number; through: boolean }
const THRU: HoleSpec = { id: 'hole-thru', cx: 15, cy: 20, floorZ: 0, through: true }
const BLIND: HoleSpec = { id: 'hole-blind', cx: 45, cy: 20, floorZ: 4, through: false }

/** A 3D part whose hole detection found these holes (Model-body layer). */
function modelPart(id: string, holes: HoleSpec[]): ImportedGeometry {
  return {
    id, name: `${id}.step`, filename: `${id}.step`, type: 'brep', format: 'step',
    loaded: true, stockId: stock.id,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: PLATE },
      size: { x: 60, y: 40, z: PLATE }, center: { x: 30, y: 20, z: PLATE / 2 },
    },
    loops: holes.map(hole => ({
      id: hole.id, layerId: 'holes', closed: true, type: 'contour', area: Math.PI * 2.5 * 2.5,
      points: circle(hole.cx, hole.cy, 2.5),
    })),
    layers2d: [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
      holes: holes.map(hole => ({
        center: [hole.cx, hole.cy], diameter: 5, topZ: PLATE, bottomZ: hole.floorZ,
        through: hole.through, loopId: hole.id,
      })),
    }],
  } as unknown as ImportedGeometry
}

/** A flat 2D circle (DXF): no floor of its own. */
function circlePart(): ImportedGeometry {
  return {
    id: 'circles', name: 'Circles.dxf', filename: 'Circles.dxf', type: 'curves_2d', format: 'dxf',
    loaded: true, stockId: stock.id,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 0 },
      size: { x: 60, y: 40, z: 0 }, center: { x: 30, y: 20, z: 0 },
    },
    loops: [{ id: 'circle', layerId: 'L1', closed: true, type: 'contour', area: Math.PI * 6.25, points: circle(30, 20, 2.5) }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const GEOMETRY = [
  modelPart('thru-part', [THRU]), modelPart('blind-part', [BLIND]), modelPart('mixed-part', [THRU, BLIND]),
  circlePart(),
]

function seed(): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: PLATE },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    toolpathBatch: null,
    project: {
      ...state.project, setups: [setup], activeSetupId: setup.id, activeOperationId: undefined,
      stocks: [stock], geometry: GEOMETRY, toolLibrary: [tool],
    },
  } as never)
}

const breakthroughInput = () => screen.getByText('Breakthrough past floor')
  .closest('.op-field-row')!.querySelector('input') as HTMLInputElement
const note = () => screen.getByTestId('drill-break-through-default-note').textContent
const type = (input: HTMLInputElement, value: string) => {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

/** Production New Operation: Drill, the 5 mm drill, every loop of one part, Heights. */
async function newDrillOn(geometryId: string): Promise<void> {
  render(createElement(NewOperationModal))
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('Drill'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: geometryId } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('drill-bore-height-policy')).not.toBeNull())
}

async function createdDrill(): Promise<Operation> {
  await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
  const before = useCamStore.getState().project.setups[0].operations.length
  fireEvent.click(screen.getByTestId('op-create'))
  const operations = useCamStore.getState().project.setups[0].operations
  expect(operations.length, screen.queryByTestId('drill-bore-height-preflight')?.textContent ?? '').toBe(before + 1)
  return operations.at(-1)!
}

/** Recompute through the real worker and post; the deepest posted Z and the G81 line. */
async function recomputeAndPost(opId: string): Promise<{ tipZ: number; drillLines: string[] }> {
  await useCamStore.getState().computeOperationToolpath('setup-1', opId)
  const project = useCamStore.getState().project
  const done = project.setups[0].operations.find(op => op.id === opId)!
  expect(done.status, done.errorMessage).toBe('ready')
  const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2516', ext: 'nc',
    selectedOpIds: { 'setup-1': [opId] },
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const span = result.operationSpans!.find(s => s.opId === opId)!
  const gcode = result.gcode.split('\n').slice(span.startLine - 1, span.endLine)
  const zs = gcode.flatMap(line => {
    const m = /\bZ(-?[\d.]+)/.exec(line.replace(/\(.*?\)/g, ''))
    return m ? [Number(m[1])] : []
  })
  return { tipZ: Math.min(...zs), drillLines: gcode.filter(line => /\bG8[1-3]\b/.test(line)) }
}

const posted: Record<string, { tipZ: number; drillLines: string[] }> = {}
const ORIGINAL_WORKER = globalThis.Worker
const ORIGINAL_SELF = globalThis.self

beforeAll(async () => {
  ;(globalThis as { Worker: unknown }).Worker = InProcessToolpathWorker
  ;(globalThis as { self: unknown }).self = workerSelf
  await import('../../lib/cam/toolpathWorker')
}, 120_000)
afterAll(() => {
  ;(globalThis as { Worker: unknown }).Worker = ORIGINAL_WORKER
  ;(globalThis as { self: unknown }).self = ORIGINAL_SELF
  console.info('[WO-2516] posted tips', JSON.stringify(posted))
})
beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(cleanup)

describe('WO-2516: the default follows the hole (rule)', () => {
  it('model holes: on only when every picked hole runs through', () => {
    const geos = [GEOMETRY[2]]
    expect(drillPickedHolesThrough(geos, ['hole-thru', 'hole-blind'])).toEqual([true, false])
    expect(drillBreakThroughDefault({ mode: 'detected_features', holesThrough: [true] }))
      .toEqual({ breakthroughMm: DRILL_BREAK_THROUGH_DEFAULT_MM, reason: 'through_holes', throughHoles: 1, holes: 1 })
    expect(drillBreakThroughDefault({ mode: 'detected_features', holesThrough: [false] }))
      .toMatchObject({ breakthroughMm: 0, reason: 'blind_holes' })
    expect(drillBreakThroughDefault({ mode: 'detected_features', holesThrough: [true, false] }))
      .toEqual({ breakthroughMm: 0, reason: 'mixed_holes', throughHoles: 1, holes: 2 })
    // A flat circle has no hole of its own: no default from holes.
    expect(drillPickedHolesThrough([GEOMETRY[3]], ['circle'])).toBeUndefined()
    expect(drillBreakThroughDefault({ mode: 'detected_features', holesThrough: undefined })).toBeUndefined()
  })

  it('explicit depth: on at or below the stock bottom, off above it, unknown without a stock', () => {
    expect(drillBreakThroughDefault({ mode: 'explicit_depth', bottomWcsMm: -10, stockBottomWcsMm: -10 }))
      .toMatchObject({ breakthroughMm: 0.5, reason: 'bottom_at_stock_bottom' })
    expect(drillBreakThroughDefault({ mode: 'explicit_depth', bottomWcsMm: -10.3, stockBottomWcsMm: -10 }))
      .toMatchObject({ breakthroughMm: 0.5, reason: 'bottom_at_stock_bottom' })
    expect(drillBreakThroughDefault({ mode: 'explicit_depth', bottomWcsMm: -8, stockBottomWcsMm: -10 }))
      .toMatchObject({ breakthroughMm: 0, reason: 'bottom_above_stock_bottom' })
    expect(drillBreakThroughDefault({ mode: 'explicit_depth', bottomWcsMm: -8, stockBottomWcsMm: undefined }))
      .toBeUndefined()
  })
})

describe('WO-2516: New Operation starts Break through from the hole', () => {
  it('a through hole from a 3D model opens with Break through on, 0.50 mm, and posts the full diameter through', async () => {
    await newDrillOn('thru-part')
    expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value).toBe('detected_features')
    await waitFor(() => expect(breakthroughInput().value).toBe('0.5'))
    expect(note()).toBe('Through hole - Break through on by default: full diameter 0.50 mm below the bottom.')
    const op = (await createdDrill())
    expect(op.params).toMatchObject({ breakthroughMm: 0.5 })
    posted.through = await recomputeAndPost(op.id)
    // Floor at the plate bottom (WCS -10), 0.5 mm break through, the point added.
    expect(posted.through.tipZ).toBeCloseTo(-PLATE - 0.5 - POINT, 2)
  }, 60_000)

  it('a blind hole from a 3D model opens with Break through off and stops at its floor', async () => {
    await newDrillOn('blind-part')
    await waitFor(() => expect(note())
      .toBe('Hole with a floor - Break through off by default: the drill stops at the floor.'))
    expect(breakthroughInput().value).toBe('0')
    const op = (await createdDrill())
    expect(op.params).toMatchObject({ breakthroughMm: 0 })
    posted.blind = await recomputeAndPost(op.id)
    // Floor at WCS 4 - 10 = -6; WO-2678: a blind floor takes no drill point.
    expect(posted.blind.tipZ).toBeCloseTo(BLIND.floorZ - PLATE, 2)
  }, 60_000)

  it('a through and a blind hole in one Drill: off, and the panel says why', async () => {
    await newDrillOn('mixed-part')
    await waitFor(() => expect(note()).toContain('1 of 2 holes run through - Break through off by default'))
    expect(breakthroughInput().value).toBe('0')
    expect((await createdDrill()).params).toMatchObject({ breakthroughMm: 0 })
  })

  it('a 2D circle follows its Target End: at the stock bottom on, above it off', async () => {
    await newDrillOn('circles')
    await waitFor(() => expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('explicit_depth'))
    const inputs = () => screen.getByTestId('drill-bore-explicit-depth').querySelectorAll('input')
    type(inputs()[0] as HTMLInputElement, '0')
    type(inputs()[1] as HTMLInputElement, '-10')
    await waitFor(() => expect(breakthroughInput().value).toBe('0.5'))
    expect(note()).toBe('Bottom at the stock bottom - Break through on by default: full diameter 0.50 mm below the bottom.')
    type(inputs()[1] as HTMLInputElement, '-8')
    await waitFor(() => expect(breakthroughInput().value).toBe('0'))
    expect(note()).toBe('Bottom above the stock bottom - Break through off by default: the drill stops at the bottom.')
    const above = (await createdDrill())
    expect(above.params).toMatchObject({ breakthroughMm: 0 })
    posted.circleAbove = await recomputeAndPost(above.id)
    expect(posted.circleAbove.tipZ).toBeCloseTo(-8, 3)
    cleanup()

    await newDrillOn('circles')
    await waitFor(() => expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('explicit_depth'))
    type(inputs()[0] as HTMLInputElement, '0')
    type(inputs()[1] as HTMLInputElement, '-10')
    await waitFor(() => expect(breakthroughInput().value).toBe('0.5'))
    const at = (await createdDrill())
    expect(at.params).toMatchObject({ breakthroughMm: 0.5 })
    posted.circleAtBottom = await recomputeAndPost(at.id)
    expect(posted.circleAtBottom.tipZ).toBeCloseTo(-PLATE - 0.5 - POINT, 2)
  }, 60_000)
})

describe('WO-2516: Tab from Target End into Break through', () => {
  it('a default that flips while Break through has the focus shows in the field and is not committed as the old value', async () => {
    await newDrillOn('circles')
    await waitFor(() => expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('explicit_depth'))
    const inputs = () => screen.getByTestId('drill-bore-explicit-depth').querySelectorAll('input')
    type(inputs()[1] as HTMLInputElement, '-10')
    await waitFor(() => expect(breakthroughInput().value).toBe('0.5'))
    // Keyboard order: the Break through field has the focus when Target End commits.
    const targetEnd = inputs()[1] as HTMLInputElement
    breakthroughInput().focus()
    fireEvent.focus(breakthroughInput())
    fireEvent.change(targetEnd, { target: { value: '-8' } })
    fireEvent.blur(targetEnd)
    await waitFor(() => expect(breakthroughInput().value).toBe('0'))
    expect(document.activeElement).toBe(breakthroughInput())
    fireEvent.blur(breakthroughInput())
    expect(note()).toBe('Bottom above the stock bottom - Break through off by default: the drill stops at the bottom.')
    const op = await createdDrill()
    expect(op.params).toMatchObject({ breakthroughMm: 0 })
  })
})

describe("WO-2516: the operator's choice wins", () => {
  it('turned off on a through hole: stays off as the picks change, after recompute, save and reopen', async () => {
    await newDrillOn('thru-part')
    await waitFor(() => expect(breakthroughInput().value).toBe('0.5'))
    type(breakthroughInput(), '0')
    // A different pick no longer moves the operator's setting.
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'blind-part' } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'thru-part' } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(note()).toContain('Through hole'))
    expect(breakthroughInput().value).toBe('0')
    const op = (await createdDrill())
    expect(op.params).toMatchObject({ breakthroughMm: 0 })
    posted.throughTurnedOff = await recomputeAndPost(op.id)
    expect(posted.throughTurnedOff.tipZ).toBeCloseTo(-PLATE - POINT, 2)
    cleanup()

    // Save and reopen the project file, then the operation.
    const saved = JSON.stringify(useCamStore.getState().project)
    act(() => useCamStore.getState().newProject())
    await act(() => useCamStore.getState().loadProjectFromFile(saved))
    const reopened = useCamStore.getState().project.setups[0].operations.find(o => o.id === op.id)!
    expect(reopened.params).toMatchObject({ breakthroughMm: 0 })
    useCamStore.setState({ toolLibrary: [tool] } as never)
    render(createElement(NewOperationModal))
    act(() => useCamStore.getState().openEditOperation('setup-1', op.id))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(note()).toContain('Through hole'))
    // Edit mode keeps the saved value; the default never flips it.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(breakthroughInput().value).toBe('0')
    fireEvent.click(screen.getByTestId('op-create'))
    const resaved = useCamStore.getState().project.setups[0].operations.find(o => o.id === op.id)!
    expect(resaved.params).toMatchObject({ breakthroughMm: 0 })
    posted.throughReopened = await recomputeAndPost(op.id)
    expect(posted.throughReopened.tipZ).toBeCloseTo(-PLATE - POINT, 2)
  }, 90_000)

  it('turned on on a blind hole: kept, and Properties says why without changing it', async () => {
    await newDrillOn('blind-part')
    await waitFor(() => expect(note()).toContain('Hole with a floor'))
    type(breakthroughInput(), '0.5')
    const op = (await createdDrill())
    expect(op.params).toMatchObject({ breakthroughMm: 0.5 })
    posted.blindTurnedOn = await recomputeAndPost(op.id)
    // WO-2678: the operator's Break through is kept; the blind floor takes no point.
    expect(posted.blindTurnedOn.tipZ).toBeCloseTo(BLIND.floorZ - PLATE - 0.5, 2)
    cleanup()

    act(() => useCamStore.setState(s => ({ project: { ...s.project, activeOperationId: op.id } })))
    render(createElement(PropertiesPanel))
    await waitFor(() => expect(screen.getByTestId('props-drill-break-through-default-note').textContent)
      .toBe('Hole with a floor - Break through off by default: the drill stops at the floor.'))
    expect((screen.getByTestId('props-drill-bore-breakthrough').querySelector('input') as HTMLInputElement).value)
      .toBe('0.5')
    expect(useCamStore.getState().project.setups[0].operations.find(o => o.id === op.id)!.params)
      .toMatchObject({ breakthroughMm: 0.5 })
  }, 60_000)
})
