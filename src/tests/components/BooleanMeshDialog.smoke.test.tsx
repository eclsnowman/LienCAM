// @vitest-environment jsdom
// MSH-4-BOOLEAN-EDIT: React render smoke for the boolean-mesh dialog (render-gate
// rule: modal changes need a real render, not just tsc/vitest of logic).
import { describe, expect, it, beforeEach } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { BooleanMeshDialog } from '../../components/modals/BooleanMeshDialog'
import { useCamStore } from '../../store'
import type { ImportedGeometry, ModelBodyDisplay } from '../../types'

function planarBoxDisplay(): ModelBodyDisplay {
  return {
    positions: [0, 0, 0, 5, 0, 0, 5, 5, 0, 0, 5, 0, 0, 0, 5, 5, 0, 5, 5, 5, 5, 0, 5, 5],
    normals: new Array(24).fill(0),
    indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
    edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [5, 5, 5] },
    faceIds: ['a', 'b', 'c', 'd', 'e', 'f'], triFace: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
  }
}

const meshGeo: ImportedGeometry = {
  id: 'm1', name: 'scan', filename: 'scan.stl', type: 'mesh', format: 'stl',
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
}
const modelGeo: ImportedGeometry = {
  id: 'b1', name: 'Block', filename: 'Block', type: 'model', format: 'model',
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 5 }, size: { x: 5, y: 5, z: 5 }, center: { x: 2.5, y: 2.5, z: 2.5 } },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  modelItemId: 'legacy', modelBody: { ref: { bodyId: 'B1', stableIds: [], version: 1 }, display: planarBoxDisplay() },
}

beforeEach(() => {
  cleanup()
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [meshGeo, modelGeo] } }))
  })
})

describe('BooleanMeshDialog render smoke', () => {
  it('renders nothing when closed', () => {
    const { queryByTestId } = render(<BooleanMeshDialog />)
    expect(queryByTestId('boolean-mesh-dialog')).toBeNull()
  })

  it('renders the operands, op select, Run and the honest fidelity preview when open', () => {
    const { getByTestId } = render(<BooleanMeshDialog />)
    act(() => { useCamStore.getState().openBooleanMeshDialog() })
    expect(getByTestId('boolean-mesh-dialog')).toBeTruthy()
    expect(getByTestId('boolean-mesh-pick-mesh')).toBeTruthy()
    expect(getByTestId('boolean-mesh-pick-model')).toBeTruthy()
    expect(getByTestId('boolean-mesh-op')).toBeTruthy()
    expect(getByTestId('boolean-mesh-run')).toBeTruthy()
    // planar model body => the preview must say EXACT, never a false "approximate".
    const fidelity = getByTestId('boolean-mesh-fidelity')
    expect(fidelity.textContent).toMatch(/EXACT/)
    // default op is Subtract (D2).
    expect((getByTestId('boolean-mesh-op') as HTMLSelectElement).value).toBe('difference')
  })

  it('preselecting a mesh row shows it as the mesh operand', () => {
    const { getByTestId } = render(<BooleanMeshDialog />)
    act(() => { useCamStore.getState().openBooleanMeshDialog('m1') })
    expect(getByTestId('boolean-mesh-pick-mesh-value').textContent).toBe('scan')
  })
})
