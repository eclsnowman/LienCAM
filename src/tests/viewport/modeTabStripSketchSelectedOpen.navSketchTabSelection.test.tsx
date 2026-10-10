// @vitest-environment jsdom
//
// NAV-SKETCH-TAB-SELECTION (GEO-UNIFY Stage 5, NAV-PARITY-AUDIT Gap 1): the
// sketch-side mirror of UI-EDIT-MODEL-FROM-BODY (see
// modeTabStripSelectedModelOpen.uiEditModelFromBody.test.tsx for the Model
// tab's own version of this suite). When the current CAM selection is a
// sketchable Geometry row, clicking the mode strip's Sketch tab opens THAT
// part's sketch instead of a generic project-wide chooser or whatever was
// last open:
//   - exactly one sketch-editable layer on the selected part -> auto-open it
//   - 2+ sketch-editable layers -> the existing SketchEntryModal opens,
//     PRE-FILTERED to just that part's layers
//   - no usable selection -> today's unchanged behavior
//
// Same App-level mock harness as the Model-tab suite (Viewport stubbed — no
// WebGL in jsdom; SolidsWorkbenchPage a thin mount stub) so the real
// ModeTabStrip + real store wiring is exercised end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

// The Design Tree panel ALSO renders every geometry row's name, so a bare
// screen.getByText('bracket.dxf') is ambiguous once both the tree and the
// chooser are mounted — scope chooser-list assertions to its own modal.
const chooserModal = () =>
  within(document.querySelector('.sketch-entry-modal') as HTMLElement)

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

const BBOX = {
  min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
  size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
}

function dxfGeo(id: string, name: string, layers2d: ImportedGeometry['layers2d']): ImportedGeometry {
  return {
    id, name, filename: name, type: 'curves_2d', format: 'dxf',
    boundingBox: BBOX,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d,
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

describe('NAV-SKETCH-TAB-SELECTION: Sketch tab opens the SELECTED part\'s own sketch', () => {
  it('a selected part with exactly ONE sketch-editable layer -> Sketch tab opens it directly', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [dxfGeo('gA', 'bracket.dxf', [
            { id: 'L1', name: '0', color: '#fff', visible: true },
          ])],
        },
      }))
      st().setSelectedGeometry('gA')
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-sketch'))

    expect(st().viewer.mode).toBe('sketch')
    expect(st().activeSketch).not.toBeNull()
    expect(st().activeSketch!.layerId).toBe('L1')
    // No chooser needed — unambiguous.
    expect(screen.queryByTestId('sketch-entry-pick-existing')).toBeNull()
  })

  it('a selected part with 2+ sketch-editable layers -> chooser opens PRE-FILTERED to it', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [
            dxfGeo('gA', 'bracket.dxf', [
              { id: 'L1', name: 'outline', color: '#fff', visible: true },
              { id: 'L2', name: 'holes', color: '#fff', visible: true },
            ]),
            dxfGeo('gB', 'gusset.dxf', [
              { id: 'L3', name: '0', color: '#fff', visible: true },
            ]),
          ],
        },
      }))
      st().setSelectedGeometry('gA')
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-sketch'))

    // Chooser is open, but no document was guessed.
    expect(st().activeSketch).toBeNull()
    expect(screen.getByTestId('sketch-entry-pick-existing')).toBeTruthy()
    // Pre-filtered: only bracket.dxf's own group/layers are listed, not gusset.dxf's.
    const modal = chooserModal()
    expect(modal.getByText('bracket.dxf')).toBeTruthy()
    expect(modal.queryByText('gusset.dxf')).toBeNull()
    expect(modal.getByText('outline')).toBeTruthy()
    expect(modal.getByText('holes')).toBeTruthy()
  })

  it('no selection -> Sketch tab keeps today\'s behavior (unfiltered chooser)', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [dxfGeo('gA', 'bracket.dxf', [
            { id: 'L1', name: '0', color: '#fff', visible: true },
          ])],
        },
      }))
      st().setSelectedGeometry(null)
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-sketch'))

    expect(st().activeSketch).toBeNull()
    expect(screen.getByTestId('sketch-entry-pick-existing')).toBeTruthy()
    // Unfiltered: bracket.dxf is listed (there is only one part, but the
    // list is the WHOLE-project one, not narrowed by a Stage 5 pre-filter).
    expect(chooserModal().getByText('bracket.dxf')).toBeTruthy()
  })

  it('a selected NON-sketchable row (zero sketch-editable layers) -> Sketch tab keeps today\'s behavior', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [dxfGeo('locked1', 'frozen.dxf', [
            { id: 'L1', name: '0', color: '#fff', visible: true, locked: true },
          ])],
        },
      }))
      st().setSelectedGeometry('locked1')
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-sketch'))

    // Falls through exactly like "no selection" — the generic chooser.
    expect(st().activeSketch).toBeNull()
    expect(screen.getByTestId('sketch-entry-pick-existing')).toBeTruthy()
  })
})
