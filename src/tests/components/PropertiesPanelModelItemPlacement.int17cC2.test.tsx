// @vitest-environment jsdom
//
// WO INT-17C Stage C2: render-gate + interaction test for the Properties
// Panel's Model Item PLACEMENT branch (ModelItemPlacementProperties). Mounts
// the REAL PropertiesPanel (standing UI-change rule: render, don't just unit-
// test -- tsc + vitest miss hooks-order bugs) with a model-backed geometry
// row selected, proves:
//  (a) the placement branch renders instead of GeometryProperties (which
//      would wire updateGeometryTransform -- refused for model rows).
//  (b) it shows the item's REAL resolved Placement, not the row's own
//      (always-identity) position/rotation.
//  (c) a typed field commit lands in updateModelItemPlacement and is
//      undoable in one step, mirroring undoMove.test.ts's B11 path for the
//      ordinary GeometryProperties panel.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

function modelGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'modelbody:item-a:b1', name: 'Bracket', filename: 'Bracket', type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'item-a',
    modelBody: {
      ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    },
    ...over,
  } as ImportedGeometry
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [modelGeo()],
        modelItems: [{ id: 'item-a', name: 'Bracket Item' }],
        modelItemPlacements: [
          { modelItemId: 'item-a', position: { x: 12, y: -4, z: 0.5 }, rotation: { x: 0, y: 0, z: 30 } },
        ],
      },
    }))
    useCamStore.getState().setSelectedGeometry('modelbody:item-a:b1')
  })
})

describe('INT-17C Stage C2: PropertiesPanel Model Item Placement branch', () => {
  it('mounts without throwing and shows the Model Item name (guards hooks-order)', () => {
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
    expect(screen.getByText('Bracket Item')).not.toBeNull()
    // WO-2007 fix round (CS 21): the 'Type: Model Item' read-out is gone; the Model Item branch is its action row.
    expect(screen.queryByText('Model Item')).toBeNull()
    expect(screen.getByTestId('model-item-action-row')).not.toBeNull()
  })

  it('shows the RESOLVED Placement (12, -4, 0.5 / 0, 0, 30), never the row\'s own identity position/rotation', () => {
    render(<PropertiesPanel />)
    const inputs = Array.from(document.querySelectorAll('input.props-number-input')) as HTMLInputElement[]
    const values = inputs.map((i) => i.value)
    expect(values).toContain('12')
    expect(values).toContain('-4')
    expect(values).toContain('0.5')
    expect(values).toContain('30')
  })

  it('does NOT render the ordinary GeometryProperties file/format block for a model row', () => {
    render(<PropertiesPanel />)
    expect(screen.queryByText('File')).toBeNull()
    expect(screen.queryByText('Format')).toBeNull()
  })

  it('a typed X commit writes updateModelItemPlacement and is undoable in one step; geometry row is untouched', () => {
    render(<PropertiesPanel />)
    // UI-BRAND B2-10: CollapsibleGroup now renders DisclosureSection, whose
    // header + body both live inside one ".disclosure-section" wrapper
    // (previously a bare Fragment, so the group's own container is now the
    // reliable scope instead of the old ".props-group-toggle" header class).
    const positionGroup = screen.getByText(/Position/).closest('.disclosure-section')!
    const xInput = positionGroup.querySelector('input.props-number-input') as HTMLInputElement
    expect(xInput.value).toBe('12')

    fireEvent.focus(xInput)
    fireEvent.change(xInput, { target: { value: '99' } })
    fireEvent.keyDown(xInput, { key: 'Enter' })

    const placement = () => useCamStore.getState().project.modelItemPlacements!.find((p) => p.modelItemId === 'item-a')!
    expect(placement().position.x).toBe(99)
    // The geometry row's own position stays identity -- ISOLATION.
    expect(useCamStore.getState().project.geometry[0].position).toEqual({ x: 0, y: 0, z: 0 })

    act(() => { useCamStore.getState().undo() })
    expect(placement().position.x).toBe(12)
  })
})
