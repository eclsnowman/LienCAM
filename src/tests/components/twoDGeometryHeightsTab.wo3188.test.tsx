// @vitest-environment jsdom
// WO-3188: where an operation's outline is plain 2D and a height is assumed,
// the Heights tab says so in one plain line - what it assumed and where to
// change it - in every shipped language. Never a refusal (rule 11).

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import type { OperationHeightIntentV2 } from '../../lib/cam/smartHeights/types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { applyLanguage } = await import('../../i18n')
const { HeightlessOutlineNote } = await import('../../components/modals/newOperationModalParts')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

afterEach(async () => {
  cleanup()
  await act(async () => { await applyLanguage('en') })
})

describe('WO-3188 Heights tab: the heightless-outline line', () => {
  it('Chamfer: says it starts at the material top and names the choices that move it', () => {
    render(<HeightlessOutlineNote kind="chamfer" units="mm" />)
    const note = screen.getByTestId('heightless-outline-note')
    expect(note.textContent).toBe(
      'This outline has no height of its own: the chamfer starts at the top of the material at this spot. ' +
      'Pick Stock top, Stock bottom or an offset here to place it.',
    )
  })

  it('Geometry plane: names the assumed Z in the operator units', () => {
    render(<HeightlessOutlineNote kind="geometry" planeWcsZ={-12} units="mm" />)
    const text = screen.getByTestId('heightless-outline-note').textContent ?? ''
    expect(text).toContain('Geometry is the plane it lies on, Z -12')
    expect(text).toContain('Pick Stock top, Stock bottom or an offset here to place the cut.')
  })

  it.each([
    ['de', 'Rohteil oben'],
    ['es', 'Parte superior del material en bruto'],
    ['fr', 'Dessus du brut'],
  ])('%s: the line is translated and uses the reference-list words', async (language, stockTop) => {
    await act(async () => { await applyLanguage(language as 'de' | 'es' | 'fr') })
    render(<HeightlessOutlineNote kind="chamfer" units="mm" />)
    const text = screen.getByTestId('heightless-outline-note').textContent ?? ''
    expect(text).toContain(stockTop)
    expect(text).not.toContain('This outline')
  })
})

// WO-3188 audit F1: the dialog records whether the operator chose the Chamfer
// datum. Nothing chosen -> the datum is policy-owned and the store may start a
// heightless outline's chamfer at the material top. A chosen reference -
// Geometry included, at + 0 - is user-owned and keeps meaning what it says,
// through Create, reopen and save. (The store side, with the real worker and a
// project save/reload, is src/tests/cam/twoDGeometryHeights.wo3188.test.ts.)
describe('WO-3188 New Operation dialog: a chosen Chamfer datum is recorded as chosen', () => {
  const tool = {
    id: 'chamfer-tool-1', name: '90 degree V-bit', type: 'chamfer_mill', diameter: 10,
    fluteLength: 12, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, angleFromAxisDeg: 45,
  } as unknown as Tool
  const snapshot: ResolvedHeightSnapshotV1 = {
    version: 1,
    wcs: { clearance: 15, retract: 5, feed: 2, top: 0, bottom: -1 },
    machine: { clearance: 15, retract: 5, feed: 2, top: 0, bottom: -1 },
    intent: {
      version: 1,
      clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
      retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
      feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
      top: { reference: 'wcs_plane', offset: 0, provenance: 'inferred' },
      bottom: { reference: 'wcs_plane', offset: -1, provenance: 'inferred' },
    },
    dependencyIds: ['part-1', tool.id],
  }
  // A plain DXF outline: no projection plane, no chain Z - it carries no height.
  const dxf = {
    id: 'part-1', name: 'Outline.dxf', filename: 'Outline.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true, loopsVersion: 1,
    position: { x: 0, y: 0, z: 6 }, rotation: { x: 0, y: 0, z: 0 },
    loops: [{
      id: 'outline', layerId: 'L', closed: true, type: 'contour', area: 400,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    }],
    layers2d: [{ id: 'L', name: 'L', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
  } as unknown as Setup

  beforeEach(() => {
    act(() => useCamStore.getState().newProject())
    act(() => useCamStore.getState().closeModal())
    const state = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool], computeOperationToolpath: vi.fn(),
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, snapshot)),
      previewChamferSmartHeights: vi.fn(() => snapshot),
      project: {
        ...state.project, setups: [setup], activeSetupId: setup.id, activeOperationId: undefined,
        geometry: [dxf],
      },
    } as never)
  })

  const datumOf = (operation: Operation) => {
    const end = (operation.smartHeight as { intent: OperationHeightIntentV2 }).intent.machining.end.value
    if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'chamfer_edge') throw new Error('no chamfer formula')
    return end.formula.datumPlane
  }
  const savedChamfer = () => useCamStore.getState().project.setups[0].operations.at(-1)!

  async function authorChamfer(): Promise<void> {
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Chamfer'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(tool.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('chamfer-ref-plane')).not.toBeNull())
  }
  async function create(): Promise<void> {
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
  }
  async function reopenAndSave(operationId: string): Promise<void> {
    act(() => useCamStore.getState().openEditOperation('setup-1', operationId))
    fireEvent.click(screen.getByText('Heights'))
    await create()
  }

  it('nothing chosen: Geometry + 0 is saved as the policy default and says it starts at the material top', async () => {
    await authorChamfer()
    expect((screen.getByTestId('chamfer-ref-plane') as HTMLSelectElement).value).toBe('geometry_face')
    expect(screen.getByTestId('heightless-outline-note').textContent).toContain('starts at the top of the material')
    await create()
    const created = savedChamfer()
    expect(datumOf(created)).toEqual({ reference: 'geometry_plane', offsetMm: 0, owner: { kind: 'operation_policy' } })
    await reopenAndSave(created.id)
    expect(datumOf(savedChamfer()).owner, 'reopen + save keeps it unchosen').toEqual({ kind: 'operation_policy' })
  })

  it('Geometry picked: saved as the operator\'s choice, the note goes, and reopen + save keeps it', async () => {
    await authorChamfer()
    const select = screen.getByTestId('chamfer-ref-plane')
    fireEvent.change(select, { target: { value: 'stock_top' } })
    fireEvent.change(select, { target: { value: 'geometry_face' } })
    expect(screen.queryByTestId('heightless-outline-note')).toBeNull()
    await create()
    const created = savedChamfer()
    expect(datumOf(created)).toEqual({ reference: 'geometry_plane', offsetMm: 0, owner: { kind: 'user_override' } })
    await reopenAndSave(created.id)
    expect(datumOf(savedChamfer())).toEqual({ reference: 'geometry_plane', offsetMm: 0, owner: { kind: 'user_override' } })
  })

  it('an offset typed on Geometry is a choice too', async () => {
    await authorChamfer()
    const row = screen.getAllByText('Z offset from plane')
      .map(label => label.closest('.op-field-row'))
      .find(candidate => candidate?.parentElement?.contains(screen.getByTestId('chamfer-ref-plane')))!
    const offset = row.querySelector('input') as HTMLInputElement
    fireEvent.change(offset, { target: { value: '0.1' } })
    fireEvent.blur(offset)
    expect(screen.queryByTestId('heightless-outline-note')).toBeNull()
    await create()
    expect(datumOf(savedChamfer())).toEqual({ reference: 'geometry_plane', offsetMm: 0.1, owner: { kind: 'user_override' } })
  })
})
