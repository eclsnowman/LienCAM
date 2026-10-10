// @vitest-environment jsdom
//
// WO SKC-49-R2 (R2.2, tooltip gate 1/4): SketchToolbox.tsx:152's Finish-button
// tooltip used raw `activeSketch.entities.length` to decide "has geometry" vs
// "empty" -- since WO SKC-49 origin/axis anchors are always present, that raw
// count is never 0 anymore, so a dimension-only sketch (zero user entities,
// one dimension against an axis) and a truly blank sketch would have painted
// the SAME "Bake this sketch..." tooltip either way, which happened to still
// read correctly for the blank case only because entities.length included
// the anchors as "content" -- display-only, but wrong the moment a genuinely
// blank sketch is compared against a dimension-only one on the SAME raw
// count. Routed through the shared `sketchHasUserContent` predicate (entities
// OR dimensions OR constraints, after strip) instead.

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

const { SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox')
const { useCamStore } = await import('../../store')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')
const {
  injectSketchAnchors, SKETCH_ORIGIN_ENTITY_ID, SKETCH_AXIS_X_ENTITY_ID,
} = await import('../../lib/sketch/sketchAnchors')

afterEach(cleanup)

function anchoredSketch() {
  return injectSketchAnchors(createBlankSketch('layer-1'), { x: 0, y: 0 })
}

describe('WO SKC-49-R2: SketchToolbox Finish tooltip is empty-after-strip, not raw entities.length', () => {
  it('a truly blank sketch (three anchors, zero user content) shows the empty-exit tooltip', () => {
    act(() => { useCamStore.setState({ activeSketch: anchoredSketch() }) })
    render(<SketchToolbox />)
    const finish = document.querySelector('.sketch-finish-btn')!
    expect(finish.getAttribute('data-tooltip')).toBe('Exit sketch mode (empty sketch is discarded)')
  })

  it('a dimension-only sketch (zero user entities, one axis dim) shows the bake tooltip', () => {
    const sk = anchoredSketch()
    act(() => {
      useCamStore.setState({
        activeSketch: {
          ...sk,
          dimensions: [{
            id: 'axis-only-dim', kind: 'distancePL', driving: true, value: 5,
            point: { entityId: SKETCH_ORIGIN_ENTITY_ID, site: 'self' },
            line: SKETCH_AXIS_X_ENTITY_ID,
          }],
        },
      })
    })
    render(<SketchToolbox />)
    const finish = document.querySelector('.sketch-finish-btn')!
    expect(finish.getAttribute('data-tooltip')).toBe('Bake this sketch to its geometry layer and exit sketch mode')
  })
})
