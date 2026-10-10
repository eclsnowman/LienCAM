// @vitest-environment jsdom
//
// WO-1602 - the Clearance, Retract, Feed and Top rows say what is in effect.
// - The 3D surface finishes keep the untouched default "Stock top + 5" Retract
//   over a proven stock (WO-1616); the row names the reference in effect.
// - Before a plan resolves, a safety row's number is its own formula resolved,
//   never the legacy scalar the formula does not govern.
// - Choosing another reference on a safety row keeps the value in effect.
// - Waterline's Top and Bottom rows set the planes its plan uses, like every
//   other operation's (WO-1544), instead of editing a formula nothing reads.
// Fixtures are WO-1601's.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeightPlaneName, ImportedGeometry, Operation, PhysicalStock, Setup, Tool } from '../../types'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  bindUnprovenStockTopSafety,
  buildParallel3dEvidenceContext,
  buildWaterline3dEvidenceContext,
  resolveSmartHeightPlan,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const endMill = {
  id: 'tool-flat', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
} as unknown as Tool
const faceMill = {
  id: 'tool-face', name: 'Face mill 12mm', type: 'flat_end_mill', diameter: 12,
  fluteLength: 25, shankDiameter: 12, overallLength: 60, numberOfFlutes: 3,
} as unknown as Tool

const bbox = (maxX: number, maxY: number, maxZ: number) => ({
  min: { x: 0, y: 0, z: 0 }, max: { x: maxX, y: maxY, z: maxZ },
  size: { x: maxX, y: maxY, z: maxZ }, center: { x: maxX / 2, y: maxY / 2, z: maxZ / 2 },
})

const contourPart = {
  id: 'contour-part', name: 'Boss.step', filename: 'Boss.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id, loopsVersion: 2,
  position: { x: 30, y: 30, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(20, 20, 10),
  loops: [{
    id: 'boss-loop', layerId: 'boss-layer', closed: true, type: 'contour', area: 100,
    points: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
  }],
  layers2d: [{ id: 'boss-layer', name: 'Profile', color: '#fff', visible: true, frame: 'geometry_local' }],
} as unknown as ImportedGeometry

// A 10 mm tall model in 20 mm stock: model Top and Stock top differ by 10.
const solid = {
  id: 'solid-1', name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(20, 20, 10),
} as unknown as ImportedGeometry

function seed(geometry: ImportedGeometry[], tools: Tool[], withStock = true): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      ...(withStock ? {
        stockId: stock.id,
        originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 0 },
      } : {}),
    },
    stock: null,
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: tools,
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id,
      stocks: withStock ? [stock] : [], geometry,
    },
  } as never)
}

const rowNumber = (plane: HeightPlaneName): number => {
  const text = screen.getByTestId(`standard-height-${plane}-resolved`).textContent ?? ''
  const match = text.match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}
const rowWords = (plane: HeightPlaneName) => screen.getByTestId(`standard-height-${plane}-source`).textContent ?? ''
const rowAuthority = (plane: HeightPlaneName) => screen.getByTestId(`standard-height-${plane}-authority`).textContent ?? ''

const diagramLegend = () => Array.from(
  // WO-1974 moved the always-visible diagram outside the hidden policy controls.
  screen.getByTestId('operation-height-diagram').querySelectorAll('svg text'),
).map(node => node.textContent ?? '').join(' | ')

function expandRow(plane: HeightPlaneName): void {
  if (screen.getByTestId(`standard-height-${plane}`).getAttribute('data-expanded') === 'true') return
  fireEvent.click(within(screen.getByTestId(`standard-height-${plane}`)).getByRole('button'))
}
function setReference(plane: HeightPlaneName, reference: string): void {
  expandRow(plane)
  fireEvent.change(screen.getByTestId(`standard-height-${plane}-source-control`), { target: { value: reference } })
}
function setOffset(plane: HeightPlaneName, value: number): void {
  expandRow(plane)
  const input = screen.getByTestId(`standard-height-${plane}-offset-control`).querySelector('input') as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(Math.abs(value)) } })
  fireEvent.blur(input)
  const operator = screen.getByTestId(`standard-height-${plane}-operator-control`) as HTMLSelectElement
  if ((value < 0) !== (operator.value === '-')) {
    fireEvent.change(operator, { target: { value: value < 0 ? '-' : '+' } })
  }
}

type SurfaceFinish = 'parallel_3d' | 'waterline_3d'

/** A surface finish whose plan resolves against real Smart Height evidence,
 * through the same no-stock bind the production resolvers apply. */
async function openSurfaceFinishHeights(type: SurfaceFinish, withStock = true): Promise<void> {
  const evidenceInput = (operationId: string) => ({
    revision: { projectRevision: 'p', setupRevision: 's', operationRevision: `o-${operationId}` },
    wcsOriginMachineMm: 0,
    operationId,
    geometryIds: [solid.id],
    ...(withStock ? {
      owningStock: {
        stockId: stock.id, artifactId: 'stock-box', representation: 'box', fingerprint: 'stock-fp',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 80, maxZ: 20 },
      },
    } : {}),
    target: {
      geometryId: solid.id, artifactId: 'widget-mesh', representation: 'mesh', fingerprint: 'widget-fp',
      boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 10 },
    },
  })
  seed([solid], [endMill], withStock)
  useCamStore.setState({
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) => {
      const validated = validatePersistedSmartHeightState(operation.smartHeight)
      if (!validated.ok) throw new Error(validated.message)
      const evidence = type === 'waterline_3d'
        ? buildWaterline3dEvidenceContext(evidenceInput(operation.id))
        : buildParallel3dEvidenceContext(evidenceInput(operation.id))
      const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(validated.state.intent, evidence), evidence)
      if (!result.ok) throw new Error(result.refusal.message)
      return result.plan
    }),
  } as never)
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText(type === 'waterline_3d' ? 'Waterline Finish (3D)' : 'Parallel Finish (3D)'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(endMill.name))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(rowNumber('top')).toBeCloseTo(10, 3))
}

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 } }),
  }
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-1602 the safety height rows say what is in effect', () => {
  it.each(['parallel_3d', 'waterline_3d'] as const)(
    '%s: over a proven stock the default Retract row names the Stock top its plan measures from', async type => {
      await openSurfaceFinishHeights(type)
      await waitFor(() => expect(rowNumber('retract')).toBeCloseTo(25, 3))
      expect(rowWords('retract')).toBe('Stock top + 5.000 mm')
      expect(rowAuthority('retract')).toBe('Smart')
      expect(rowWords('clearance')).toBe('Retract + 10.000 mm')
      expect(rowNumber('clearance')).toBeCloseTo(35, 3)
      expect(rowWords('feed')).toBe('Stock top + 5.000 mm')
      expect(rowNumber('feed')).toBeCloseTo(25, 3)

      // Typing an offset keeps the reference the row showed.
      setOffset('retract', 7)
      await waitFor(() => {
        expect(rowWords('retract')).toBe('Stock top + 7.000 mm')
        expect(rowNumber('retract')).toBeCloseTo(27, 3)
        expect(rowAuthority('retract')).toBe('User Override')
      })
      // Choosing the model Top keeps the height in effect.
      setReference('retract', 'top')
      await waitFor(() => {
        expect(rowWords('retract')).toBe('Top + 17.000 mm')
        expect(rowNumber('retract')).toBeCloseTo(27, 3)
      })
    }, 30000)

  it.each(['parallel_3d', 'waterline_3d'] as const)(
    '%s: with no stock proven the default Retract and Feed rows name the model Top their plan measures from', async type => {
      await openSurfaceFinishHeights(type, false)
      await waitFor(() => expect(rowNumber('retract')).toBeCloseTo(15, 3))
      expect(rowWords('retract')).toBe('Top + 5.000 mm')
      expect(rowAuthority('retract')).toBe('Smart')
      expect(rowWords('clearance')).toBe('Retract + 10.000 mm')
      expect(rowNumber('clearance')).toBeCloseTo(25, 3)
      expect(rowWords('feed')).toBe('Top + 5.000 mm')
      expect(rowNumber('feed')).toBeCloseTo(15, 3)
    }, 30000)

  it('Contour before its plan resolves: the safety numbers are their formulas, not stored scalars', async () => {
    seed([contourPart], [endMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Heights'))
    expect(screen.queryByTestId('resolved-height-plan')).toBeNull()
    expect(rowWords('retract')).toBe('Stock top + 5.000 mm')
    expect(rowNumber('retract')).toBeCloseTo(25, 3)
    expect(rowWords('clearance')).toBe('Retract + 10.000 mm')
    expect(rowNumber('clearance')).toBeCloseTo(35, 3)
    expect(rowWords('feed')).toBe('Top + 5.000 mm')
    expect(rowNumber('feed')).toBeCloseTo(rowNumber('top') + 5, 3)

    // The diagram draws what the rows state, and follows a typed Retract.
    setOffset('retract', 12)
    await waitFor(() => expect(rowNumber('clearance')).toBeCloseTo(42, 3))
    expect(rowNumber('retract')).toBeCloseTo(32, 3)
    expect(diagramLegend()).toContain('Clearance+42 mm')
    expect(diagramLegend()).toContain('Retract+32 mm')
  })

  it('Face: choosing another reference on Retract keeps the height in effect', async () => {
    seed([], [faceMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Face'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(faceMill.name))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(rowNumber('retract')).toBeCloseTo(25, 3))

    setReference('retract', 'wcs_plane')
    await waitFor(() => {
      expect(rowWords('retract')).toBe('WCS Z (absolute) + 25.000 mm')
      expect(rowNumber('retract')).toBeCloseTo(25, 3)
      expect(rowAuthority('retract')).toBe('User Override')
    })
    // Clearance follows Retract, so it did not move either.
    expect(rowNumber('clearance')).toBeCloseTo(35, 3)
  }, 30000)

  it('Waterline: the Top and Bottom rows set the planes the plan uses, and Save keeps them', async () => {
    await openSurfaceFinishHeights('waterline_3d')
    setReference('top', 'stock_top')
    setOffset('top', -2)
    await waitFor(() => {
      expect(rowWords('top')).toBe('Stock top - 2.000 mm')
      expect(rowNumber('top')).toBeCloseTo(18, 3)
      expect(rowAuthority('top')).toBe('User Override')
    })
    setReference('bottom', 'stock_bottom')
    setOffset('bottom', 3)
    await waitFor(() => {
      expect(rowWords('bottom')).toBe('Stock bottom + 3.000 mm')
      expect(rowNumber('bottom')).toBeCloseTo(3, 3)
    })
    // Nothing below the rows offers a top the Waterline plan never reads.
    expect(screen.queryByText('Top of stock (Z)')).toBeNull()
    expect(diagramLegend()).toContain('Top of cut+18 mm')
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    const saved = useCamStore.getState().project.setups[0].operations.at(-1)!
    const validated = validatePersistedSmartHeightState(saved.smartHeight)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.state.intent.planeOverrides?.top).toMatchObject({ reference: 'stock_top', offsetMm: -2 })
    expect(validated.state.intent.planeOverrides?.bottom).toMatchObject({ reference: 'stock_bottom', offsetMm: 3 })
  }, 30000)
})
