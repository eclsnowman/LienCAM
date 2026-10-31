// @vitest-environment jsdom
// WO-3250 (WO-3177 Slot brief): the New Operation type grid offers
// "Slot (centerline)". It is the existing Engrave, preset to Trace on the line,
// an explicit depth and the Plain style, named "Slot" on a fresh operation. It
// adds no operation type: Create saves an ordinary Engrave, the same record a
// hand-authored Engrave with the same inputs saves.
//
// Route: the REAL NewOperationModal (type card, Tool, Geometry, Passes,
// Heights, Create) and the REAL store addOperation. Only the Smart Height
// preview is stood in for, as in engraveDepthEmpty.wo3109.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size }, clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const END_MILL = {
  id: 'end-mill', name: '6 mm flat end mill', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 3 } },
} as unknown as Tool
const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 0, bottom: -6 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 0, bottom: -6 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 0, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: -6, provenance: 'inferred' },
  },
  dependencyIds: ['slot-line', END_MILL.id],
}

function seed() {
  const geometry = {
    id: 'slot-line', name: 'Slot.dxf', filename: 'Slot.dxf', type: 'curves_2d', format: 'dxf', loaded: true,
    loopsVersion: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 0, z: 0 }, size: { x: 40, y: 0, z: 0 }, center: { x: 20, y: 0, z: 0 } },
    loops: [{ id: 'line', layerId: 'L1', closed: false, type: 'open', area: 0, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [], stock: { type: 'auto' },
    wcs: { id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [END_MILL], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
      smartHeightPlanFixture(operation, SNAPSHOT)),
    project: { ...current.project, geometry: [geometry], setups: [setup], activeSetupId: setup.id },
  } as never)
}

const ops = () => useCamStore.getState().project.setups[0].operations
const activeCards = () => Array.from(document.querySelectorAll('.op-type-card-active'))
  .map(card => card.querySelector('.op-type-name')?.textContent)
const nameInput = () => screen.getByText('Operation name').nextElementSibling as HTMLInputElement
const slotCard = () => screen.queryByTestId('op-type-slot')

function openNew() {
  act(() => useCamStore.getState().openModal('new-operation'))
}

/** The Engrave form's Mode buttons on the Passes tab: which one is pressed. */
function passesMode(): string | undefined {
  fireEvent.click(screen.getByText('Passes'))
  return ['Trace', 'V-engrave'].find(label => screen.getByText(label).className.includes('op-toggle-active'))
}

/** Tool, Geometry and an explicit 6 mm depth, the same clicks for any Engrave. */
async function toolGeometryDepth() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(END_MILL.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'slot-line' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Passes'))
  const stepdown = screen.getByText('Stepdown').closest('.op-field-row')!.querySelector('input')!
  fireEvent.focus(stepdown)
  fireEvent.change(stepdown, { target: { value: '2' } })
  fireEvent.blur(stepdown)
  fireEvent.click(screen.getByText('Heights'))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Top Height height' }))
  await waitFor(() => expect(screen.getByTestId('engrave-height-policy')).not.toBeNull())
  const depth = screen.getByText('Engraving depth').closest('.op-field-row')!.querySelector('input')!
  fireEvent.focus(depth)
  fireEvent.change(depth, { target: { value: '6' } })
  fireEvent.blur(depth)
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
}

/** The fields an Engrave saves, without its own id and name. */
function authored(op: Operation) {
  const { id: _id, name: _name, ...rest } = structuredClone(op) as Operation & Record<string, unknown>
  return JSON.parse(JSON.stringify(rest, (key, value) =>
    key === 'operationId' || key === 'opId' ? '<op>' : value)) as Record<string, unknown>
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(cleanup)

describe('WO-3250 Add operation: Slot (centerline)', () => {
  it('opens the Engrave form preset to Trace / on the line / explicit depth / Plain, named Slot, and saves an ordinary Engrave equal to a hand-authored one', async () => {
    render(<NewOperationModal />)
    openNew()
    expect(slotCard()).not.toBeNull()

    fireEvent.click(slotCard()!)
    expect(activeCards()).toEqual(['Slot (centerline)'])
    expect(nameInput().value).toBe('Slot')
    expect(passesMode()).toBe('Trace')
    expect((screen.getByTestId('engrave-style') as HTMLSelectElement).value).toBe('plain')
    await toolGeometryDepth()
    fireEvent.click(screen.getByText('Passes'))
    expect(screen.getByTestId('slot-width-note').textContent).toBe(
      'Plain cuts a slot exactly one tool wide: 6 mm. Choose Trochoidal for a wider slot.')
    fireEvent.click(screen.getByTestId('op-create'))

    expect(ops()).toHaveLength(1)
    const slot = ops()[0]
    expect(slot.type).toBe('engrave')
    expect(slot.name).toBe('Slot')
    expect(slot.params).toMatchObject({ mode: 'trace', side: 'center', useWidthForDepth: false, loopIds: ['line'] })
    expect((slot.params as { engraveStyle?: string }).engraveStyle).toBeUndefined()
    expect(slot.smartHeight).toMatchObject({
      intent: { machining: { end: { value: { formula: { depth: { kind: 'explicit', depthMm: 6 } } } } } },
    })

    // The same Engrave by hand: Engrave / Trace, Mode Trace, the same tool,
    // line, stepdown and depth, and the same name typed.
    openNew()
    fireEvent.click(screen.getByText('Engrave / Trace'))
    expect(activeCards()).toEqual(['Engrave / Trace'])
    fireEvent.change(nameInput(), { target: { value: 'Slot' } })
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByText('Trace'))
    await toolGeometryDepth()
    fireEvent.click(screen.getByTestId('op-create'))

    expect(ops()).toHaveLength(2)
    const hand = ops()[1]
    expect(hand.name).toBe(slot.name)
    expect(authored(hand)).toEqual(authored(slot))
  })

  it('edit and reopen never re-apply the preset: the saved Engrave opens as Engrave, with its own fields', async () => {
    render(<NewOperationModal />)
    openNew()
    expect(slotCard()).not.toBeNull()
    fireEvent.click(slotCard()!)
    await toolGeometryDepth()
    fireEvent.click(screen.getByTestId('op-create'))
    const created = ops()[0]

    // The operator later renames it and sets it to V-engrave in Properties.
    act(() => useCamStore.getState().updateOperation('setup-1', created.id, {
      name: 'Keyway', params: { ...created.params, mode: 'engrave' },
    } as Partial<Operation>))
    act(() => {
      useCamStore.setState({ editingOpPayload: { setupId: 'setup-1', opId: created.id } } as never)
      useCamStore.getState().openModal('edit-operation')
    })
    await waitFor(() => expect(nameInput().value).toBe('Keyway'))
    expect(slotCard()).toBeNull()
    expect(activeCards()).toEqual(['Engrave / Trace'])
    expect(passesMode()).toBe('V-engrave')
  })

  it('switching type or Cancel clears it: the preset name and Engrave fields go back, and one card is ever active', async () => {
    render(<NewOperationModal />)
    openNew()
    expect(slotCard()).not.toBeNull()
    fireEvent.click(slotCard()!)
    expect(nameInput().value).toBe('Slot')

    fireEvent.click(screen.getByText('2D Contour'))
    expect(activeCards()).toEqual(['2D Contour'])
    expect(nameInput().value).toBe('')

    // Back to plain Engrave: its own default Mode, not the Slot preset.
    fireEvent.click(screen.getByText('Engrave / Trace'))
    expect(activeCards()).toEqual(['Engrave / Trace'])
    expect(passesMode()).toBe('V-engrave')

    // A name the operator typed is theirs: Slot keeps it and leaving keeps it.
    fireEvent.click(screen.getByText('Type & Name'))
    fireEvent.change(nameInput(), { target: { value: 'Keyway' } })
    fireEvent.click(slotCard()!)
    expect(nameInput().value).toBe('Keyway')
    fireEvent.click(screen.getByText('2D Pocket'))
    expect(nameInput().value).toBe('Keyway')

    // Cancel, then a fresh Add operation: nothing of the shortcut is left.
    fireEvent.click(slotCard()!)
    fireEvent.click(screen.getAllByText('Cancel')[0])
    expect(useCamStore.getState().activeModal).toBeNull()
    openNew()
    expect(activeCards()).toEqual(['2D Contour'])
    expect(nameInput().value).toBe('')
    fireEvent.click(screen.getByText('Engrave / Trace'))
    expect(passesMode()).toBe('V-engrave')
    expect(ops()).toHaveLength(0)
  })

  it('says the width each Style really cuts: Plain is the tool width, Trochoidal shows its limits and never claims a clamped width', async () => {
    render(<NewOperationModal />)
    openNew()
    expect(slotCard()).not.toBeNull()
    fireEvent.click(slotCard()!)
    fireEvent.click(screen.getByText('Passes'))
    expect(screen.getByTestId('slot-width-note').textContent).toBe(
      'Plain cuts a slot exactly one tool wide. Pick a tool on the Tool tab to see the width.')
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(END_MILL.name))
    fireEvent.click(screen.getByText('Passes'))
    // W = D is Plain: no Slot width field, the note gives the tool's width.
    expect(screen.queryByText('Slot width')).toBeNull()
    expect(screen.getByTestId('slot-width-note').textContent).toContain('one tool wide: 6 mm')

    fireEvent.change(screen.getByTestId('engrave-style'), { target: { value: 'trochoidal' } })
    expect(screen.getByTestId('slot-width-note').textContent).toBe(
      'Trochoidal cuts a slot from 6.9 to 15 mm wide with this tool. A Slot width typed outside that range is set to the nearest end of it.')
    const width = () => screen.getByText('Slot width').closest('.op-field-row')!.querySelector('input')! as HTMLInputElement
    const typeWidth = async (value: string) => {
      fireEvent.focus(width())
      fireEvent.change(width(), { target: { value } })
      fireEvent.blur(width())
      await waitFor(() => expect(document.activeElement).not.toBe(width()))
    }
    // Just above D and below 1.15 D: the field shows the 1.15 D it will cut.
    for (const typed of ['6.1', '6.5']) {
      await typeWidth(typed)
      expect(Number(width().value)).toBeCloseTo(6.9, 6)
    }
    // Above 2.5 D: the 15 mm it will cut.
    await typeWidth('20')
    expect(Number(width().value)).toBeCloseTo(15, 6)
    // The style stays the one chosen: no silent switch back to Plain.
    expect((screen.getByTestId('engrave-style') as HTMLSelectElement).value).toBe('trochoidal')
    await typeWidth('9')
    expect(Number(width().value)).toBeCloseTo(9, 6)
  })
})
