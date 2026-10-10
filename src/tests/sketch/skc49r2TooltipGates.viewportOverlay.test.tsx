// @vitest-environment jsdom
//
// WO SKC-49-R2 (R2.2, tooltip gate 3/4): ViewportOverlay.tsx:40's blank-sketch
// hint used raw `activeSketch.entities.length === 0` to decide "truly empty".
// WO SKC-49 origin/axis anchors are always present, so that raw count is
// never 0 anymore -- the hint would never show for a genuinely blank sketch.
// Routed through `!sketchHasUserContent` (empty-after-strip) instead: the
// hint shows for a truly blank sketch and stays hidden for a dimension-only
// one (real user work, not blank).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => mem.get(k) ?? null,
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
const { useCamStore } = await import('../../store')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')
const {
  injectSketchAnchors, SKETCH_ORIGIN_ENTITY_ID, SKETCH_AXIS_X_ENTITY_ID,
} = await import('../../lib/sketch/sketchAnchors')

afterEach(cleanup)

function anchoredSketch() {
  return injectSketchAnchors(createBlankSketch('layer-1'), { x: 0, y: 0 })
}

describe('WO SKC-49-R2: ViewportOverlay blank-sketch hint is empty-after-strip, not raw entities.length', () => {
  it('a truly blank sketch (three anchors, zero user content) shows the hint', () => {
    act(() => {
      useCamStore.setState((s) => ({
        activeSketch: anchoredSketch(),
        viewer: { ...s.viewer, mode: 'sketch' as const },
      }))
    })
    const { container } = render(<ViewportOverlay interactionMode="normal" />)
    expect(container.querySelector('.sketch-empty-hint')).not.toBeNull()
  })

  it('a dimension-only sketch (zero user entities, one axis dim) hides the hint', () => {
    const sk = anchoredSketch()
    act(() => {
      useCamStore.setState((s) => ({
        activeSketch: {
          ...sk,
          dimensions: [{
            id: 'axis-only-dim', kind: 'distancePL', driving: true, value: 5,
            point: { entityId: SKETCH_ORIGIN_ENTITY_ID, site: 'self' },
            line: SKETCH_AXIS_X_ENTITY_ID,
          }],
        },
        viewer: { ...s.viewer, mode: 'sketch' as const },
      }))
    })
    const { container } = render(<ViewportOverlay interactionMode="normal" />)
    expect(container.querySelector('.sketch-empty-hint')).toBeNull()
  })
})
