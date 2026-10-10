// @vitest-environment jsdom
//
// UI-EDIT-MODEL-FROM-BODY (Operator navigation-law addendum): when the current
// Design Tree/CAM selection is a model-origin geometry row (has a
// modelItemId resolving to a REAL Model Item), clicking the mode strip's
// "Model" tab opens THAT item's editor (openModelItem) instead of whatever
// was last edited. A non-model selection or no selection keeps today's
// unchanged behavior (setWorkspace('part') alone, activeModelItemId untouched).
//
// Same App-level mock harness as tabStripModelDefault.ui77.test.tsx (Viewport
// stubbed — no WebGL in jsdom; SolidsWorkbenchPage a thin mount stub) so the
// real ModeTabStrip + real store wiring is exercised end to end.
//
// WO-2707 repin (WO-2700 154b13a79, owner 10-09 'Keep it'): the plain Model tab
// now always opens the New Model dialog and never acts on the selection or the
// last-edited item. Opening the SELECTED body's own item is the operator's
// explicit Edit Model on that body's setup-tree row (model-edit-btn-<item>),
// which calls the same openModelItem. The "selection ignored / stale id" cases
// now pin that the tab leaves workspace, active item and selection untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

vi.mock('../../components/model3d/SolidsWorkbenchPage', () => typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
  SolidsWorkbenchPage: () => <div data-testid="solids-workbench-status">Ready</div>,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
type ImportedGeometry = import('../../types').ImportedGeometry

const st = () => useCamStore.getState()

function modelGeo(id: string, modelItemId: string, name: string): ImportedGeometry {
  return {
    id, name, filename: name, type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    },
  }
}

beforeEach(() => {
  window.history.pushState(null, '', '/')
  act(() => {
    st().newProject()
    useCamStore.setState({ workspace: 'cam' })
  })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('UI-EDIT-MODEL-FROM-BODY: Edit Model opens the SELECTED model body\'s own item; the plain tab offers New Model', () => {
  it('a selected model-origin row (real modelItemId) -> its Edit Model opens THAT item', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('gA1', 'item-a', 'Bracket'), modelGeo('gB1', 'item-b', 'Gusset')],
          modelItems: [
            { id: 'item-a', name: 'Item A', documentState: 'empty' },
            { id: 'item-b', name: 'Item B', documentState: 'empty' },
          ],
        },
      }))
      // item-b was the last-edited item (simulates a prior editing session).
      st().openModelItem('item-b')
      st().finishModelItem()
      st().setSelectedGeometry('gA1')
    })
    render(<App />)

    // The plain tab does not act on the selection: New Model dialog only.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    expect(st().activeModelItemId).toBe('item-b')
    fireEvent.click(screen.getByText('Cancel'))

    fireEvent.click(screen.getByTestId('model-edit-btn-item-a'))

    expect(st().workspace).toBe('part')
    // Opens the SELECTED body's item (item-a), not the last-edited one (item-b).
    expect(st().activeModelItemId).toBe('item-a')
  })

  it('no selection -> Model tab offers New Model and keeps the last-edited item', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('gA1', 'item-a', 'Bracket')],
          modelItems: [{ id: 'item-a', name: 'Item A', documentState: 'empty' }],
        },
      }))
      st().openModelItem('item-a')
      st().finishModelItem()
      st().setSelectedGeometry(null)
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-part'))

    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    // Unchanged: activeModelItemId stays whatever it already was (item-a, the
    // last-edited item) — the dialog alone does not touch it.
    expect(st().activeModelItemId).toBe('item-a')
  })

  it('a selected NON-model row -> Model tab offers New Model (selection ignored)', () => {
    act(() => {
      useCamStore.getState().addGeometry({
        id: 'g1', name: 'PartOne', filename: 'p.dxf', type: 'curves_2d', format: 'dxf',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
          size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      })
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          modelItems: [{ id: 'item-a', name: 'Item A', documentState: 'empty' }],
        },
      }))
      st().openModelItem('item-a')
      st().finishModelItem()
      st().setSelectedGeometry('g1')
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-part'))

    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    expect(st().activeModelItemId).toBe('item-a')
    expect(st().viewer.selectedGeometryId).toBe('g1')
  })

  it('a selected model-origin row with a STALE modelItemId (no matching record) -> Model tab offers New Model', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('gA1', 'ghost-item', 'Bracket')],
          modelItems: [{ id: 'item-a', name: 'Item A', documentState: 'empty' }],
        },
      }))
      st().openModelItem('item-a')
      st().finishModelItem()
      st().setSelectedGeometry('gA1')
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-part'))

    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    // ghost-item resolves to no record; the tab ignores the selection anyway.
    expect(st().activeModelItemId).toBe('item-a')
    expect(st().viewer.selectedGeometryId).toBe('gA1')
  })
})
