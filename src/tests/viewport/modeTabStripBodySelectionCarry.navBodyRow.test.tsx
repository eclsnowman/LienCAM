// @vitest-environment jsdom
//
// NAV-BODY-ROW path 3 (select-then-mode-switch): while in the Model
// workspace with a body selected in the tree/body-list, clicking any CAM-side
// mode tab (Setup/Sketch/Toolpath/Simulate) resolves that body to its CAM
// Geometry-list row (via the SAME forward lookup the context-menu/inline-icon
// paths use, findModelBodyGeometryRow) and carries it into
// viewer.selectedGeometryId on switch -- the reverse leg of
// UI-EDIT-MODEL-FROM-BODY's own selection-aware Model tab.
//
// SolidsWorkbenchPage's own `selectedId` is component-local React state
// (invisible outside its subtree), so the real cross-component signal is the
// modelSelectionBridge store (src/store/modelSelectionBridge.ts) that page
// writes to on every selection change. SolidsWorkbenchPage is stubbed here
// (no WebGL in jsdom) -- these tests drive the bridge directly, exactly as
// that page's own sync effect would, so ModeTabStrip's consumption of it is
// exercised end to end without needing a real 3D workbench mount.
//
// Same App-level mock harness as modeTabStripSelectedModelOpen.uiEditModelFromBody.test.tsx.

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
const { useModelSelectionBridge } = await import('../../store/modelSelectionBridge')
type ImportedGeometry = import('../../types').ImportedGeometry

const st = () => useCamStore.getState()

function modelGeo(id: string, bodyId: string, name: string, modelItemId?: string): ImportedGeometry {
  return {
    id, name, filename: name, type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...(modelItemId !== undefined ? { modelItemId } : {}),
    modelBody: {
      ref: { bodyId, stableIds: [`${bodyId}:F0`], version: 1 },
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
    useCamStore.setState({ workspace: 'part' })
  })
  useModelSelectionBridge.setState({ selectedBodyId: null, selectedBodyModelItemId: undefined })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
  useModelSelectionBridge.setState({ selectedBodyId: null, selectedBodyModelItemId: undefined })
})

describe('NAV-BODY-ROW path 3: CAM-tab click carries a selected body over', () => {
  it('a body selected in the Model workspace -> Setup tab carries its CAM row id + switches workspace', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [modelGeo('gA1', 'leaf-1', 'Bracket')] },
      }))
      useModelSelectionBridge.getState().setModelSelection('leaf-1', undefined)
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-setup'))

    expect(st().workspace).toBe('cam')
    expect(st().viewer.selectedGeometryId).toBe('gA1')
  })

  it('no body selected -> tab click still switches workspace, leaves selectedGeometryId untouched', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [modelGeo('gA1', 'leaf-1', 'Bracket')] },
        viewer: { ...s.viewer, selectedGeometryId: 'pre-existing' },
      }))
      // Bridge left at its beforeEach default: no selection.
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-toolpath'))

    expect(st().workspace).toBe('cam')
    expect(st().viewer.selectedGeometryId).toBe('pre-existing')
  })

  it('a selected body with NO CAM row yet (unsynced) -> never dead-ends, leaves existing selection alone', () => {
    act(() => {
      useCamStore.setState((s) => ({
        viewer: { ...s.viewer, selectedGeometryId: 'pre-existing' },
      }))
      useModelSelectionBridge.getState().setModelSelection('never-synced-leaf', undefined)
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-simulation'))

    expect(st().workspace).toBe('cam')
    expect(st().viewer.selectedGeometryId).toBe('pre-existing')
  })

  it('scopes by modelItemId exactly like the store\'s own reconciliation -- two items sharing a raw bodyId resolve independently', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [
            modelGeo('gA1', 'leaf-1', 'Item A body', 'item-a'),
            modelGeo('gB1', 'leaf-1', 'Item B body', 'item-b'),
          ],
        },
      }))
      useModelSelectionBridge.getState().setModelSelection('leaf-1', 'item-b')
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-setup'))

    expect(st().viewer.selectedGeometryId).toBe('gB1')
  })

  it('clicking a CAM tab while ALREADY in the CAM workspace never consults the Model-workspace bridge', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [modelGeo('gA1', 'leaf-1', 'Bracket')] },
        workspace: 'cam',
        viewer: { ...s.viewer, selectedGeometryId: 'pre-existing' },
      }))
      // A stale/left-over bridge value from an earlier Model-workspace visit --
      // must NOT clobber an unrelated CAM selection on a plain CAM-tab-to-
      // CAM-tab click.
      useModelSelectionBridge.getState().setModelSelection('leaf-1', undefined)
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-toolpath'))

    expect(st().viewer.selectedGeometryId).toBe('pre-existing')
  })
})
