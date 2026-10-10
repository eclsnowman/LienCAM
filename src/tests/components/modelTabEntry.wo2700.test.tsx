// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModeTabStrip } from '../../components/toolbar/ModeTabStrip'
import { ModelEntryModal } from '../../components/modals/ModelEntryModal'
import { DesignTree } from '../../components/panels/DesignTree'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import type { ImportedGeometry } from '../../types'

const state = () => useCamStore.getState()
function mount() {
  return render(<><ModeTabStrip showPartTab /><DesignTree /><ModelEntryModal /></>)
}
function seedItems(count = 1) {
  act(() => useCamStore.setState(s => ({ project: {
    ...s.project, modelItems: Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`, name: `Model ${i}`, documentState: 'empty' as const,
    })),
  } })))
}
function expectNewDialog() {
  expect(screen.getByText('New Model', { selector: '.modal-title' })).toBeTruthy()
  expect(state().activeModal).toBe('new-model')
  expect(screen.queryByTestId('model-entry-list')).toBeNull()
}
function seedModelGeometry() {
  seedItems(2)
  const geometry: ImportedGeometry = {
    id: 'body-row', name: 'Body', filename: 'Body', type: 'brep', format: 'model',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'item-0',
    modelBody: { ref: { bodyId: 'body', stableIds: [], version: 1 },
      display: { positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] } } },
  }
  act(() => useCamStore.setState(s => ({
    project: { ...s.project, geometry: [geometry] }, activeModelItemId: 'item-1',
    viewer: { ...s.viewer, selectedGeometryId: geometry.id },
  })))
}
beforeEach(() => {
  act(() => {
    state().newProject()
    useCamStore.setState({ workspace: 'cam', activeModal: null })
    useUiPrefs.setState({ treeGeometryExpanded: true, collapsedPartIds: [], collapsedFolderIds: [] })
  })
})
afterEach(cleanup)

describe('WO-2700: plain Model tab means New Model', () => {
  it('offers a new model on a fresh project without claiming or creating a model', () => {
    mount()
    const before = state().project
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()
    expect(state().project).toBe(before)
  })
  it.each(['setup', 'control', 'sketch', 'toolpath', 'simulation', 'postprocess'])('opens New Model from %s with a retained active item', source => {
    seedItems(2)
    act(() => useCamStore.setState({ activeModelItemId: 'item-1' }))
    mount()
    fireEvent.click(screen.getByTestId(`mode-tab-${source}`))
    const before = state()
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    expect(state().workspace).toBe(before.workspace)
    expect(state().activeModelItemId).toBe('item-1')
    expect(state().project).toBe(before.project)
  })
  it.each(['Cancel', 'Escape', 'backdrop', 'close'])('%s dismisses without losing models or changing the source workspace', dismissal => {
    seedItems(2)
    act(() => useCamStore.setState({ workspace: 'control', activeModelItemId: 'item-1' }))
    mount()
    const before = state().project
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    if (dismissal === 'Cancel') fireEvent.click(screen.getByText('Cancel'))
    else if (dismissal === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else if (dismissal === 'backdrop') fireEvent.mouseDown(document.querySelector('.modal-backdrop')!)
    else fireEvent.click(document.querySelector('.model-entry-modal .modal-close-btn')!)
    expect(state().activeModal).toBeNull()
    expect(state().workspace).toBe('control')
    expect(state().activeModelItemId).toBe('item-1')
    expect(state().project).toBe(before)
  })
  it('creates only on confirmation; leaving and re-entering offers another new model', () => {
    seedItems()
    mount()
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    fireEvent.click(screen.getByTestId('model-entry-new'))
    expect(state().project.modelItems).toHaveLength(2)
    expect(state().workspace).toBe('part')
    const created = state().activeModelItemId
    expect(created).not.toBe('item-0')
    expect(state().activeModal).toBeNull()
    fireEvent.click(screen.getByTestId('mode-tab-setup'))
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    expect(state().activeModelItemId).toBe(created)
    expect(state().project.modelItems).toHaveLength(2)
  })
  it('explicit tree Edit Model still opens the chosen item and subsequent tab entry offers New Model', () => {
    seedItems(2)
    act(() => useCamStore.setState({ activeModelItemId: 'item-1' }))
    mount()
    fireEvent.click(screen.getByTestId('model-placeholder-edit-btn-item-0'))
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-0')
    expect(state().activeModal).toBeNull()
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-0')
  })
  it('selected model geometry does not override plain tab intent or selection', () => {
    seedModelGeometry()
    mount()
    const before = state().project
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expectNewDialog()
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBe('item-1')
    expect(state().viewer.selectedGeometryId).toBe('body-row')
    expect(state().project).toBe(before)
  })
  it.each(['inline', 'context'])('real geometry %s Edit Model opens its owner, irrespective of retained model', action => {
    seedModelGeometry()
    mount()
    if (action === 'inline') fireEvent.click(screen.getByTestId('model-edit-btn-item-0'))
    else {
      fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
      fireEvent.click(screen.getByTestId('tree-context-menu').querySelector('[data-action="geo-edit-model"]')!)
    }
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-0')
    expect(state().activeModal).toBeNull()
  })
  it('preserves the existing chooser for programmatic model-entry consumers', () => {
    seedItems(2)
    mount()
    act(() => state().enterModelWorkspace())
    expect(screen.getByText('Choose a Model Item')).toBeTruthy()
    fireEvent.click(screen.getByTestId('model-entry-row-item-1'))
    expect(state().activeModelItemId).toBe('item-1')
    expect(state().workspace).toBe('part')
  })
})
