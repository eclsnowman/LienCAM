// @vitest-environment jsdom
//
// WO-2211: a NEW 3D operation's stepover starts at the chosen tool's library
// stepover (tool.feedsAndSpeeds.default.stepover) when the tool record has one,
// through the production New Operation modal. The 3D ops that carry a stepover
// field: Parallel Finish (mm), Steep and Shallow (shallow stepover, mm) and
// Adaptive Rough 3D (fraction of tool diameter). A tool without a library
// stepover keeps today's flat default; editing a saved operation keeps its
// saved value; 2D auto-stepovers are unchanged.
//
// WO-2206 measured why: the dialog's flat 1 mm on a 1.6 mm ball sent all 100
// portrait links up; the ball's library 0.16 mm kept 629 of 633 down.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

// jsdom localStorage shim BEFORE importing the persisted store (mirrors the
// other NewOperationModal dialog tests).
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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { buildParallel3dSmartIntent } = await import('../../lib/cam/smartHeights')

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'

const feeds = (stepover?: number) => ({
  default: {
    rpm: 18000, feedRate: 1000, plungeRate: 300, depthOfCut: 0.5,
    ...(stepover === undefined ? {} : { stepover }),
  },
})

// Operator's 1.6 mm ball with its library stepover of 0.16 mm.
const ball16 = {
  id: 'tool-ball-1p6', name: 'Ball 1.6mm', type: 'ball_end_mill', diameter: 1.6,
  fluteLength: 6, shankDiameter: 4, overallLength: 50, numberOfFlutes: 2,
  cornerRadius: 0.8, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: feeds(0.16),
} as unknown as Tool
// A tool record with no library stepover.
const flatNoStepover = {
  id: 'tool-flat-bare', name: 'Flat 6mm bare', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: feeds(undefined),
} as unknown as Tool
// A 6 mm flat whose library stepover is 1.8 mm (0.3 of the diameter).
const flat6 = {
  id: 'tool-flat-6', name: 'Flat 6mm lib', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: feeds(1.8),
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  intent: defaultHeightIntent(),
  dependencyIds: [GEO_ID],
}

function seed(operations: Operation[] = []): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations, notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [ball16, flatNoStepover, flat6],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, snapshot)),
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// A saved op must carry Smart Height V2 authority or the edit loader resets it
// to the defaults (ADR-0040: no legacy before 1.0).
const savedSmartHeight = () => ({
  kind: 'smart_v2' as const,
  intent: buildParallel3dSmartIntent({
    setupId: SETUP_ID, geometryIds: [GEO_ID], safetyIntent: defaultHeightIntent(),
  }),
})

/** The rendered value of the modal field with this exact label. */
function fieldValue(label: string): string {
  const labelEl = screen.getAllByText(label).find(el => el.classList.contains('op-field-label'))
  const input = labelEl?.closest('.op-field-row')?.querySelector('input') as HTMLInputElement | null
  if (!input) throw new Error(`no field labelled "${label}"`)
  return input.value
}

function openNew(typeCard: string, toolName: string): void {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(typeCard))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(toolName))
  fireEvent.click(screen.getByText('Passes'))
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-2211 new 3D operation stepover starts at the tool library stepover', () => {
  it('Parallel Finish with the 1.6 mm ball shows 0.16 and creates the op at 0.16', async () => {
    seed()
    openNew('Parallel Finish (3D)', 'Ball 1.6mm')
    expect(Number(fieldValue('Stepover'))).toBe(0.16)

    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.type).toBe('parallel_3d')
    expect((op.params as { stepover: number }).stepover).toBe(0.16)
  })

  it('Parallel Finish with a tool that has no library stepover keeps the 1 mm default', () => {
    seed()
    openNew('Parallel Finish (3D)', 'Flat 6mm bare')
    expect(Number(fieldValue('Stepover'))).toBe(1)
  })

  it('switching from a library tool to one without a stepover returns to the default', () => {
    seed()
    openNew('Parallel Finish (3D)', 'Ball 1.6mm')
    expect(Number(fieldValue('Stepover'))).toBe(0.16)
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm bare'))
    fireEvent.click(screen.getByText('Passes'))
    expect(Number(fieldValue('Stepover'))).toBe(1)
  })

  it('the operator can still type a different stepover after the tool seeds it', () => {
    seed()
    openNew('Parallel Finish (3D)', 'Ball 1.6mm')
    const labelEl = screen.getAllByText('Stepover').find(el => el.classList.contains('op-field-label'))
    const input = labelEl!.closest('.op-field-row')!.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.3' } })
    fireEvent.blur(input)
    expect(Number(fieldValue('Stepover'))).toBe(0.3)
  })

  it('choosing the op type after the tool also seeds the library stepover', () => {
    seed()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Ball 1.6mm'))
    fireEvent.click(screen.getByText('Type & Name'))
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Passes'))
    expect(Number(fieldValue('Stepover'))).toBe(0.16)
  })

  it('Steep and Shallow takes the shallow stepover from the tool', () => {
    seed()
    openNew('Steep and Shallow (3D)', 'Ball 1.6mm')
    expect(Number(fieldValue('Shallow stepover'))).toBe(0.16)
  })

  it('Steep and Shallow with no library stepover keeps the 1 mm default', () => {
    seed()
    openNew('Steep and Shallow (3D)', 'Flat 6mm bare')
    expect(Number(fieldValue('Shallow stepover'))).toBe(1)
  })

  it('Adaptive Rough 3D takes the library stepover as a fraction of the diameter', () => {
    seed()
    openNew('Adaptive Rough (3D)', 'Flat 6mm lib')
    // 1.8 mm on a 6 mm cutter = 0.3 of the diameter.
    expect(Number(fieldValue('Stepover (fraction of tool dia)'))).toBe(0.3)
  })

  it('Adaptive Rough 3D with no library stepover keeps the 0.4 default', () => {
    seed()
    openNew('Adaptive Rough (3D)', 'Flat 6mm bare')
    expect(Number(fieldValue('Stepover (fraction of tool dia)'))).toBe(0.4)
  })

  it('editing a saved Parallel Finish keeps its saved stepover, even on a tool change', () => {
    const saved = {
      id: 'op-p3d-1', name: '3D Finish 1', type: 'parallel_3d', toolId: ball16.id,
      enabled: true, status: 'ready', geometrySelections: [GEO_ID],
      passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
      linking: {},
      heights: {
        clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
        feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
        bottomHeight: -5, bottomHeightMode: 'absolute', heightIntent: defaultHeightIntent(),
      },
      params: { stepover: 0.5, angleDeg: 0, tolerance: 0.05, useStockBoundary: false },
      smartHeight: savedSmartHeight(),
    } as unknown as Operation
    seed([saved])
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-p3d-1') })
    fireEvent.click(screen.getByText('Passes'))
    expect(Number(fieldValue('Stepover'))).toBe(0.5)
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm lib'))
    fireEvent.click(screen.getByText('Passes'))
    expect(Number(fieldValue('Stepover'))).toBe(0.5)
  })

  it('a new operation opened straight from an edit takes the tool stepover, not the reset default', () => {
    const saved = {
      id: 'op-p3d-1', name: '3D Finish 1', type: 'parallel_3d', toolId: ball16.id,
      enabled: true, status: 'ready', geometrySelections: [GEO_ID],
      passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
      linking: {},
      heights: {
        clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
        feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
        bottomHeight: -5, bottomHeightMode: 'absolute', heightIntent: defaultHeightIntent(),
      },
      params: { stepover: 0.5, angleDeg: 0, tolerance: 0.05, useStockBoundary: false },
      smartHeight: savedSmartHeight(),
    } as unknown as Operation
    seed([saved])
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-p3d-1') })
    // Replace the edit with a new operation without closing: same type, same tool.
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Passes'))
    expect(Number(fieldValue('Stepover'))).toBe(0.16)
  })

  it('2D pocket stepover is unchanged: still 35% of the diameter, not the library value', () => {
    seed()
    openNew('2D Pocket', 'Flat 6mm lib')
    expect(Number(fieldValue('Stepover'))).toBe(2.1)
  })
})
