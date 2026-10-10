// @vitest-environment jsdom
//
// WO-1501 (BUG-501, family K10b): the on-path control group was one implicit
// <label> wrapping the "On path" caption AND both the Detach and Flip side
// buttons. An implicit <label> with no single labeled control hands its whole
// computed text to every focusable descendant, so both buttons announced as
// the group ("On path ... Detach ... Flip side") instead of their own names.
//
// Tier 2 desk evidence: rendered-component accessibility-tree assertions.
// No visual change. The test proves (1) each button resolves by its OWN role
// name and to a DISTINCT element, and (2) the click wiring is unchanged.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sketch, SketchEntity, SketchTextEntity } from '../../lib/sketch/types'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

let useCamStore: typeof import('../../store').useCamStore
let SketchToolbox: typeof import('../../components/panels/sketch/SketchToolbox').SketchToolbox
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

function curve(id: string): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } }
}

function textOnPath(id: string, pathId: string): SketchTextEntity {
  return {
    id,
    kind: 'text',
    construction: false,
    at: { x: 0, y: 0 },
    text: 'HELLO',
    height: 5,
    rotation: 0,
    fontStyle: 'single-line',
    fontFamily: 'Rounded Mplus 1c',
    mirrored: false,
    pathId,
    pathOffsetMm: 0,
    pathFlip: false,
    pathAlign: 'free',
  }
}

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox'))
  ;({ sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

function seedBoundText() {
  const activeSketch = {
    id: 'sketch-wo1501',
    solveStatus: null,
    constraints: [],
    dimensions: [],
    entities: [curve('curve-1'), textOnPath('text-1', 'curve-1')],
  } as unknown as Sketch
  useCamStore.setState({
    activeSketch,
    sketchSelectedIds: [],
    sketchTextEditId: 'text-1',
    sketchTextValue: 'HELLO',
    sketchTextPathId: 'curve-1',
    sketchTextPathOffsetMm: 0,
    sketchTextPathFlip: false,
    sketchTextPathAlign: 'free',
    sketchPickPathForTextId: null,
  } as never)
}

beforeEach(() => {
  useCamStore.setState({ sketchTextEditId: null, sketchTextPathId: null } as never)
  sketcherToolStore.setState({ tool: 'select' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WO-1501: on-path Detach / Flip side own accessible names', () => {
  it('Detach and Flip side each resolve by their own role name to distinct buttons', () => {
    seedBoundText()
    render(<SketchToolbox />)

    const detach = screen.getByRole('button', { name: 'Detach' })
    const flip = screen.getByRole('button', { name: 'Flip side' })

    expect(detach).not.toBe(flip)
    expect(detach.textContent).toBe('Detach')
    expect(flip.textContent).toBe('Flip side')
    // The caption no longer contributes to either button's name.
    expect(detach.getAttribute('aria-label')).toBeNull()
    expect(flip.getAttribute('aria-label')).toBeNull()
  })

  it('clicking Detach unbinds the editing text; clicking Flip side toggles pathFlip', () => {
    seedBoundText()
    const unbind = vi.spyOn(useCamStore.getState(), 'unbindSketchTextPath')
    const setFlip = vi.spyOn(useCamStore.getState(), 'setSketchTextPathFlip')
    render(<SketchToolbox />)

    const flip = screen.getByRole('button', { name: 'Flip side' })
    expect(flip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(flip)
    expect(setFlip).toHaveBeenCalledWith(true)
    expect(useCamStore.getState().sketchTextPathFlip).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Detach' }))
    expect(unbind).toHaveBeenCalledWith('text-1')
    expect(useCamStore.getState().sketchTextPathId).toBeNull()
  })
})