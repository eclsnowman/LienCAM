// @vitest-environment jsdom
//
// React-render SMOKE test for the smart-dimension CURSOR PREVIEW mode readout.
//
// WHY THIS EXISTS (feedback_render_gate_ui_changes): tsc + the pure-logic
// vitest suite never mount React, so a hooks-order or effect regression in
// SketchDimensionOverlay would ship undetected. This file mounts the overlay
// with the smart-dim tool armed and a forced-HORIZONTAL orientation, then
// asserts the on-screen preview shows BOTH the value AND the mode label
// ("Horizontal") for the resolved orientation — the change under test
// (no blind interactive op: live feedback names the mode + matches the value).

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { RefObject } from 'react'
import type { SketchEntity } from '../../lib/sketch/types'
import type { CNCViewport } from '../../lib/viewport/CNCViewport'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(). Install an in-memory Storage shim BEFORE importing
// the store (same scaffolding as the other *.smoke.test.tsx files). No app change.
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

const { SketchDimensionOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchDimensionOverlay')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
// WO SKC-14B: the armed tool + chain live in the sketcher package now, behind a store-free
// reactive store. The overlay reads them through useSyncExternalStore, so the seed must land there.
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

afterEach(cleanup)

// Fixtures: pa(0,20) -> pb(3,24) is a 3-4-5 point pair (dx=3, dy=4); ar is an
// arc of radius 6. A fake viewport supplies only what the overlay reads: the
// live cursor (getLastSketchCursor) plus no-op world<->screen helpers.
const pa: SketchEntity = { id: 'pa', kind: 'point', construction: false, at: { x: 0, y: 20 } }
const pb: SketchEntity = { id: 'pb', kind: 'point', construction: false, at: { x: 3, y: 24 } }
const ar: SketchEntity = {
  id: 'ar', kind: 'arc', construction: false,
  center: { x: 60, y: 0 }, radius: 6, startAngle: 0.2, endAngle: 2.0,
}

const fakeViewport = {
  getLastSketchCursor: () => ({ x: 1.5, y: 30 }),
  worldToScreen: () => ({ x: 0, y: 0 }),
  getWorldPerPixel: () => 1,
} as unknown as CNCViewport
const viewportRef: RefObject<CNCViewport | null> = { current: fakeViewport }

function armDim(entities: SketchEntity[], operandIds: string[], forceMode: 'aligned' | 'x' | 'y' | null) {
  act(() => {
    useCamStore.setState({
      activeSketch: {
        id: 's1', layerId: 'L1', entities,
        constraints: [], dimensions: [],
        solveStatus: { dof: 0, conflicting: [], redundant: [] },
      },
      sketchSelectedIds: [],
      sketchDimEditor: null,
    } as never)
    useCamStore.getState().setDisplayUnits('mm')
    useCamStore.getState().setViewerMode('sketch')
    // AFTER the mode switch: entering sketch mode switches the document, and a document switch
    // resets the armed tool (setActiveSketch -> resetForDocumentSwitch).
    sketcherToolStore.setState({
      tool: 'smart-dimension',
      chain: (forceMode
        ? { kind: 'dim', operandIds, forceMode }
        : { kind: 'dim', operandIds }) as never,
    })
  })
}

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: null,
      sketchSelectedIds: [], sketchDimEditor: null,
    } as never)
    sketcherToolStore.__reset()
  })
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('SketchDimensionOverlay: cursor MODE readout', () => {
  it('forced-horizontal linear dim shows the value AND the "Horizontal" mode + Tab hint', () => {
    armDim([pa, pb], ['pa', 'pb'], 'x')
    const { container } = render(<SketchDimensionOverlay port={port} />)

    const value = container.querySelector('.sketch-dim-preview-value')
    const modeEl = container.querySelector('.sketch-dim-preview-mode')
    const tab = container.querySelector('.sketch-dim-preview-tabhint')

    expect(value).not.toBeNull()
    expect(modeEl).not.toBeNull()
    // dx = 3 -> horizontal-measuring value (mm, 2 decimals).
    expect(value!.textContent).toBe('3.00')
    // The resolved orientation is named on screen (no blind interactive op).
    expect(modeEl!.textContent).toBe('Horizontal')
    // Tab affordance shows for the linear family only.
    expect(tab).not.toBeNull()
    expect(tab!.textContent).toContain('Tab')
  })

  it('arc radius pick shows the "Radius" mode AND the Radius/Arc-length Tab hint (UI-50B)', () => {
    armDim([ar], ['ar'], null)
    const { container } = render(<SketchDimensionOverlay port={port} />)

    const modeEl = container.querySelector('.sketch-dim-preview-mode')
    const value = container.querySelector('.sketch-dim-preview-value')
    const tab = container.querySelector('.sketch-dim-preview-tabhint')

    expect(modeEl!.textContent).toBe('Radius')
    expect(value!.textContent).toBe('R6.00')
    // UI-50B: a TRUE circular arc gains the Radius <-> Arc length Tab cycle,
    // so the hint must show here (the pre-UI-50B contract asserted null).
    expect(tab).not.toBeNull()
    expect(tab!.textContent).toBe('Tab: Radius / Arc length')
  })

  it('mounts without a hooks/render crash when no tool is armed', () => {
    act(() => {
      useCamStore.setState({
        activeSketch: {
          id: 's1', layerId: 'L1', entities: [pa, pb],
          constraints: [], dimensions: [],
          solveStatus: { dof: 0, conflicting: [], redundant: [] },
        },
      } as never)
      useCamStore.getState().setViewerMode('sketch')
      sketcherToolStore.setState({ tool: 'select', chain: null })
    })
    const { container } = render(<SketchDimensionOverlay port={port} />)
    expect(container.querySelector('.sketch-dim-preview')).toBeNull()
  })
})
