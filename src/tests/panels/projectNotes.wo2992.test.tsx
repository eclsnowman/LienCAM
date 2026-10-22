// @vitest-environment jsdom
//
// WO-2992: clicking the project row at the top of the design tree opens the
// project's notes in Properties; typing writes project.notes through the
// existing updateProjectMeta; any other selection takes Properties back.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const { DesignTree } = await import('../../components/panels/DesignTree')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null })
  })
})

function renderBoth() {
  render(<><DesignTree /><PropertiesPanel /></>)
}

describe('WO-2992 project notes in Properties', () => {
  it('shows nothing of the notes until the project row is clicked', () => {
    renderBoth()
    expect(screen.queryByTestId('project-notes')).toBeNull()
  })

  it('click the project row, type, and project.notes changes', () => {
    renderBoth()
    fireEvent.click(screen.getByTestId('tree-project-row'))
    const box = screen.getByTestId('project-notes') as HTMLTextAreaElement
    expect(box.value).toBe(useCamStore.getState().project.notes ?? '')
    fireEvent.change(box, { target: { value: 'Use the 3/8 clamp\nFace first' } })
    expect(useCamStore.getState().project.notes).toBe('Use the 3/8 clamp\nFace first')
    expect((screen.getByTestId('project-notes') as HTMLTextAreaElement).value).toBe('Use the 3/8 clamp\nFace first')
  })

  it('shows the notes a project already carries', () => {
    act(() => { useCamStore.getState().updateProjectMeta({ notes: 'shipped note' }) })
    renderBoth()
    fireEvent.click(screen.getByTestId('tree-project-row'))
    expect((screen.getByTestId('project-notes') as HTMLTextAreaElement).value).toBe('shipped note')
  })

  it('another selection takes Properties back (selection rules unchanged)', () => {
    renderBoth()
    fireEvent.click(screen.getByTestId('tree-project-row'))
    expect(screen.getByTestId('project-notes')).toBeTruthy()
    act(() => { useCamStore.getState().setSelectedStock('no-such-stock') })
    expect(screen.queryByTestId('project-notes')).toBeNull()
  })

  it('re-clicking the row that was already selected takes Properties back to that row', () => {
    act(() => {
      useCamStore.getState().addGeometry({
        id: 'g1', name: 'Fixture Plate', filename: 'p.dxf', type: 'curves_2d', format: 'dxf',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
          size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        layers2d: [], loops: [],
      })
    })
    renderBoth()
    const row = screen.getByTestId('tree-name-geometry')
    fireEvent.click(row)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('g1')
    const props = () => document.querySelector('.properties-panel')!
    expect(props().textContent).toContain('Fixture Plate')
    fireEvent.click(screen.getByTestId('tree-project-row'))
    expect(screen.getByTestId('project-notes')).toBeTruthy()
    fireEvent.click(row)
    expect(screen.queryByTestId('project-notes')).toBeNull()
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('g1')
    expect(props().textContent).toContain('Fixture Plate')
  })

  it('deselecting afterwards does not bring the notes back', () => {
    renderBoth()
    fireEvent.click(screen.getByTestId('tree-project-row'))
    act(() => { useCamStore.getState().setSelectedStock('s1') })
    act(() => { useCamStore.getState().setSelectedStock(null) })
    expect(screen.queryByTestId('project-notes')).toBeNull()
  })

  it('double-clicking the name renames the project and the notes view stays right', () => {
    renderBoth()
    fireEvent.click(screen.getByTestId('tree-project-row'))
    fireEvent.doubleClick(screen.getByTestId('tree-name-project'))
    const input = screen.getByTestId('tree-project-row').querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'Renamed Plate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useCamStore.getState().project.name).toBe('Renamed Plate')
    expect(screen.getByTestId('project-notes-name').textContent).toBe('Renamed Plate')
    expect(screen.getByTestId('project-notes')).toBeTruthy()
  })
})
