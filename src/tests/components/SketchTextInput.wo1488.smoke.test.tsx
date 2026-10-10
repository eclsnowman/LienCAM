// @vitest-environment jsdom
//
// WO-1488: the text-edit hint says what Escape will actually do.
//
// SketchToolbox showed one hardcoded hint for every in-progress text edit, but
// cancelSketchTextEdit treats three cases differently: a fresh placement with
// typed text COMMITS on Escape (typed work is never silently destroyed), a
// fresh EMPTY placement is discarded with a notice, and an edit of EXISTING
// text reverts to its pre-edit value. This renders the real toolbox for each
// case, asserts the hint matches the behaviour, then exercises the behaviour
// through the public actions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags;
// install an in-memory Storage shim BEFORE importing the persist() store.
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

const { SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox')
const { useCamStore, camSketchDocumentPort } = await import('../../store')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: createBlankSketch('layer-wo1488', () => 'wo1488'),
      sketchTextEditId: null,
      sketchTextEditIsNew: false,
    } as never)
  })
})

const hint = () => screen.getByTestId('sketch-text-edit-hint').textContent ?? ''
const entities = () => useCamStore.getState().activeSketch!.entities

describe('WO-1488 text-edit hint matches Escape behaviour', () => {
  it('fresh placement with typed text: hint promises Escape keeps it, and it does', () => {
    act(() => {
      camSketchDocumentPort.placeText({ x: 0, y: 0 }, null, 0, 'free', false)
      useCamStore.getState().setSketchTextValue('LC-12')
    })
    // The exposed reactive flag tracks the fresh placement.
    expect(useCamStore.getState().sketchTextEditIsNew).toBe(true)
    render(<SketchToolbox />)
    expect(hint()).toContain('keep the typed text')
    act(() => { useCamStore.getState().cancelSketchTextEdit() })
    const texts = entities().filter((e) => e.kind === 'text') as Array<{ text: string }>
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe('LC-12')
  })

  it('fresh empty placement: hint promises Escape discards it, and it does', () => {
    act(() => {
      camSketchDocumentPort.placeText({ x: 0, y: 0 }, null, 0, 'free', false)
    })
    render(<SketchToolbox />)
    expect(hint()).toContain('discard it')
    act(() => { useCamStore.getState().cancelSketchTextEdit() })
    expect(entities()).toHaveLength(0)
  })

  it('existing text edit: hint promises Escape reverts, and it does', () => {
    act(() => {
      useCamStore.setState({
        activeSketch: {
          ...useCamStore.getState().activeSketch!,
          entities: [{
            id: 'tx', kind: 'text', construction: false,
            at: { x: 0, y: 0 }, text: 'LC-12', height: 5, rotation: 0,
            fontStyle: 'single-line',
          }],
        },
      } as never)
      useCamStore.getState().beginSketchTextEdit('tx')
      useCamStore.getState().setSketchTextValue('LC-99')
    })
    expect(useCamStore.getState().sketchTextEditIsNew).toBe(false)
    render(<SketchToolbox />)
    expect(hint()).toContain('revert to the original text')
    act(() => { useCamStore.getState().cancelSketchTextEdit() })
    expect((entities()[0] as { text: string }).text).toBe('LC-12')
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
  })
})
