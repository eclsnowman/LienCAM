// @vitest-environment jsdom
//
// WO-2172 (workholding assemblies, slice 2): make a vise and set its opening
// through the RENDERED screens - the Properties panel's Make vise form and
// Opening field, the design tree's vise item - and the viewport draw step
// (applyViseDrawPoses) the Viewport runs, against a recording viewport. The
// drawn jaw must sit exactly where the one resolver puts it.
//
// jsdom's localStorage is broken under vitest's node flags and the store
// persists on every set(): install an in-memory Storage first (same shim as
// workholdingTreeAndProperties.wo1573.test.tsx).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3 } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { applyViseDrawPoses } = await import('../../components/workholding/viseViewport')
const { resolveWorkholding, resolveWorkholdingPlacements } = await import('../../lib/workholding/resolveWorkholding')
const { poseToMat4 } = await import('../../lib/workholding/pose')

afterEach(cleanup)

const ZERO = { x: 0, y: 0, z: 0 }

function body(id: string, name: string, position: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -50, y: -10, z: 0 }, max: { x: 50, y: 10, z: 40 },
      size: { x: 100, y: 20, z: 40 }, center: { x: 0, y: 0, z: 20 },
    },
    position, rotation: ZERO, loaded: true, workholding: true,
  } as ImportedGeometry
}

function state() { return useCamStore.getState() }
function instance() { return state().project.workholding?.instances[0] }

/** World bounds of the jaw from the one resolver (its shape is the row's bounding box here). */
async function jawBounds(): Promise<number[]> {
  const { bodies } = await resolveWorkholding(state().project, state().project.activeSetupId)
  const jaw = bodies.find((b) => b.geometryId === 'geo-jaw')!
  const p = jaw.mesh.positions
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity
  for (let i = 0; i + 2 < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i])
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1])
  }
  return [minX, maxX, minY, maxY].map((n) => Math.round(n * 1000) / 1000)
}

function typeInto(input: HTMLElement, text: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

beforeEach(() => {
  act(() => {
    state().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
    state().addGeometry(body('geo-fixed', 'Fixed body', ZERO))
    state().addGeometry(body('geo-jaw', 'Moving jaw', { x: 0, y: 50, z: 0 }))
    state().setSelectedGeometry('geo-fixed')
  })
  delete (window as unknown as { __cncViewport?: unknown }).__cncViewport
})

async function makeViseThroughThePanel() {
  render(<PropertiesPanel />)
  // Before: no vise section, the row's own Position fields show.
  expect(screen.queryByTestId('vise-props')).toBeNull()
  fireEvent.click(screen.getByTestId('geo-make-vise-btn'))
  const form = screen.getByTestId('make-vise-form')
  expect(within(form).getByTestId('make-vise-fixed').textContent).toBe('Fixed body')
  expect((within(form).getByTestId('make-vise-jaw') as HTMLSelectElement).value).toBe('geo-jaw')
  // The jaw sits beside the fixed body along Y, so Jaw Y is offered first.
  expect((within(form).getByTestId('make-vise-axis') as HTMLSelectElement).value).toBe('y')
  typeInto(within(form).getByTestId('make-vise-name'), 'Bench vise')
  const inch = state().appSettings.displayUnits === 'inch'
  typeInto(within(form).getByTestId('make-vise-min'), '0')
  typeInto(within(form).getByTestId('make-vise-max'), inch ? String(60 / 25.4) : '60')
  fireEvent.click(within(form).getByTestId('make-vise-create'))
}

describe('WO-2172: make a vise and set its opening through the screens', () => {
  it('Make vise -> Opening 20 / 5 / 80: the jaw moves by exactly the change; 80 is set to 60 and the field shows 60', async () => {
    const before = await jawBounds()
    expect(before).toEqual([-50, 50, 40, 60])
    const depth = state().projectHistory.length
    await makeViseThroughThePanel()

    expect(state().projectHistory.length).toBe(depth + 1)
    expect(instance()?.jointValuesMm).toEqual({ moving: 0 })
    expect(state().project.workholding?.definitions[0].name).toBe('Bench vise')
    const props = screen.getByTestId('vise-props')
    expect(within(props).getByTestId('vise-travel').textContent).toBe('0 to 60 mm')
    expect(within(props).getByTestId('vise-body-fixed').textContent).toBe('Fixed body')
    expect(within(props).getByTestId('vise-body-moving').textContent).toBe('Moving jaw')
    // The vise places the body: the row's Position fields step aside.
    expect(screen.queryByText(/^Position/)).toBeNull()
    expect(await jawBounds()).toEqual(before) // making it moved nothing

    const field = () => screen.getByTestId('vise-opening-input') as HTMLInputElement
    expect(field().value).toBe('0')
    typeInto(field(), '20')
    expect(instance()?.jointValuesMm.moving).toBe(20)
    expect(field().value).toBe('20')
    expect(await jawBounds()).toEqual([-50, 50, 60, 80])

    typeInto(field(), '5')
    expect(instance()?.jointValuesMm.moving).toBe(5)
    expect(await jawBounds()).toEqual([-50, 50, 45, 65])

    typeInto(field(), '80')
    expect(instance()?.jointValuesMm.moving).toBe(60)
    expect(field().value).toBe('60')
    expect(await jawBounds()).toEqual([-50, 50, 100, 120])
    // At 60 already: typing 80 again uses 60 again, writes nothing, still shows 60.
    const d = state().projectHistory.length
    typeInto(field(), '80')
    expect(field().value).toBe('60')
    expect(state().projectHistory.length).toBe(d)

    // Undo / redo through the store the toolbar calls; the field follows.
    act(() => { state().undo() })
    expect(field().value).toBe('5')
    act(() => { state().redo() })
    expect(field().value).toBe('60')
  })

  it('inch display: the opening is typed in inches and stored in mm', async () => {
    act(() => { state().setDisplayUnits('inch') })
    await makeViseThroughThePanel()
    typeInto(screen.getByTestId('vise-opening-input'), '1')
    expect(instance()?.jointValuesMm.moving).toBeCloseTo(25.4, 9)
    expect(screen.getByTestId('vise-travel').textContent).toBe('0 to 2.3622 in')
    act(() => { state().setDisplayUnits('mm') })
  })

  it('the design tree lists the vise as one item with its two bodies under it; rename and remove', async () => {
    await makeViseThroughThePanel()
    cleanup()
    act(() => { state().setWorkholdingJointValue(instance()!.id, 'moving', 37.5) })
    render(<DesignTree />)
    const group = screen.getByTestId('tree-workholding-group')
    const vise = within(group).getByTestId(`tree-vise-${instance()!.id}`)
    expect(within(vise).getByTestId('tree-name-vise').textContent).toBe('Bench vise')
    expect(within(vise).getByTestId('tree-vise-opening').textContent).toBe('37.5 mm')
    const bodies = within(vise).getByTestId('tree-vise-bodies')
    expect(within(bodies).getByText('Fixed body')).toBeTruthy()
    expect(within(bodies).getByText('Moving jaw')).toBeTruthy()
    // Listed once each: not also flat in the group.
    expect(within(group).getAllByText('Moving jaw')).toHaveLength(1)

    // Selecting the vise selects its fixed body (the panel then shows the vise).
    act(() => { state().setSelectedGeometry(null) })
    fireEvent.click(within(vise).getByTestId('tree-vise-row'))
    expect(state().viewer.selectedGeometryId).toBe('geo-fixed')

    // Rename: double-click the name, type, Enter - one undo step.
    const d = state().projectHistory.length
    fireEvent.doubleClick(within(vise).getByTestId('tree-name-vise'))
    const input = within(screen.getByTestId(`tree-vise-${instance()!.id}`)).getByRole('textbox')
    fireEvent.change(input, { target: { value: '6 inch Kurt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(state().project.workholding?.definitions[0].name).toBe('6 inch Kurt')
    expect(state().projectHistory.length).toBe(d + 1)

    // Remove: the vise goes, both bodies stay as workholding, flat in the group.
    fireEvent.click(screen.getByTestId(`remove-vise-btn-${instance()!.id}`))
    expect(state().project.workholding?.instances).toEqual([])
    expect(screen.queryByTestId('tree-vise-row')).toBeNull()
    const after = screen.getByTestId('tree-workholding-group')
    expect(within(after).getByText('Fixed body')).toBeTruthy()
    expect(within(after).getByText('Moving jaw')).toBeTruthy()
    expect(state().project.geometry.every((g) => g.workholding === true)).toBe(true)
  })

  it('the viewport draws each vise body at the resolver\'s pose, and puts it back at its row pose when the vise is removed', async () => {
    await makeViseThroughThePanel()
    const id = instance()!.id
    act(() => { state().setWorkholdingJointValue(id, 'moving', 25) })
    const calls: Array<[string, Vec3, Vec3]> = []
    const shown: Array<[string, boolean]> = []
    const vp = {
      setPartTransform: (gid: string, p: Vec3, r: Vec3) => { calls.push([gid, p, r]) },
      setSTLVisible: (gid: string, v: boolean) => { shown.push([gid, v]) },
    }
    applyViseDrawPoses(vp)
    const { placements } = resolveWorkholdingPlacements(state().project, state().project.activeSetupId)
    for (const placement of placements) {
      const drawn = calls.filter(([gid]) => gid === placement.geometryId).at(-1)!
      const m = poseToMat4({ position: drawn[1], rotation: drawn[2] })
      m.forEach((v, i) => expect(v).toBeCloseTo(placement.worldFromComponent[i], 9))
    }
    expect(calls.find(([gid]) => gid === 'geo-jaw')![1]).toEqual({ x: 0, y: 75, z: 0 })

    // Removed: the jaw goes back to its row pose (where CAM has it).
    act(() => { state().removeWorkholding(id) })
    calls.length = 0
    applyViseDrawPoses(vp)
    expect(calls.find(([gid]) => gid === 'geo-jaw')![1]).toEqual({ x: 0, y: 50, z: 0 })
    expect(shown.every(([, v]) => v)).toBe(true)
  })
})
