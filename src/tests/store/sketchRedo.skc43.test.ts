// @vitest-environment jsdom

import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

class StubWorker {
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}

vi.stubGlobal('Worker', StubWorker)
Object.defineProperty(globalThis, 'localStorage', {
  value: memoryStorage,
  configurable: true,
})

let useCamStore: typeof import('../../store').useCamStore
let TopToolbar: typeof import('../../components/toolbar/TopToolbar').TopToolbar
let originalUndo: () => void
let originalRedo: () => void
let projectTemplate: ReturnType<typeof projectSnapshot>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function projectSnapshot() {
  return useCamStore.getState().project
}

function namedProject(name: string) {
  return { ...clone(projectTemplate), name, notes: `project:${name}` }
}

function line(id: string, y: number): SketchEntity {
  return {
    id,
    kind: 'line',
    construction: false,
    start: { x: 0, y },
    end: { x: 10, y },
  }
}

function sketchWith(...entities: SketchEntity[]): Sketch {
  return { ...createBlankSketch('skc43-layer'), entities }
}

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ TopToolbar } = await import('../../components/toolbar/TopToolbar'))
  originalUndo = useCamStore.getState().undo
  originalRedo = useCamStore.getState().redo
  projectTemplate = clone(projectSnapshot())
})

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      project: namedProject('base'),
      activeSketch: sketchWith(line('base-line', 0)),
      projectHistory: [],
      sketchHistory: [],
      projectFuture: [],
      sketchFuture: [],
      canUndo: false,
      canRedo: false,
      viewportRefreshTrigger: 0,
      undo: originalUndo,
      redo: originalRedo,
    })
  })
})

afterEach(() => cleanup())

describe('SKC-43 CAM sketch redo', () => {
  it('redo restores the exact pre-undo project and sketch snapshots', () => {
    const state = () => useCamStore.getState()
    state().pushHistory()
    useCamStore.setState({
      project: namedProject('edited'),
      activeSketch: sketchWith(line('base-line', 0), line('edited-line', 5)),
    })
    const editedProject = clone(state().project)
    const editedSketch = clone(state().activeSketch)

    state().undo()
    expect(state().canRedo).toBe(true)
    state().redo()

    expect(state().project).toEqual(editedProject)
    expect(state().activeSketch).toEqual(editedSketch)
    expect(state().canRedo).toBe(false)
  })

  it('redo keeps interleaved project and sketch edits in lockstep', () => {
    const state = () => useCamStore.getState()
    const baseProject = clone(state().project)
    const baseSketch = clone(state().activeSketch)

    state().pushHistory()
    const sketchEdited = sketchWith(line('base-line', 0), line('sketch-edit', 4))
    useCamStore.setState({ activeSketch: sketchEdited })

    state().pushHistory()
    const projectEdited = namedProject('project-edit')
    useCamStore.setState({ project: projectEdited })

    state().undo()
    expect(state().project).toEqual(baseProject)
    expect(state().activeSketch).toEqual(sketchEdited)
    state().undo()
    expect(state().project).toEqual(baseProject)
    expect(state().activeSketch).toEqual(baseSketch)

    state().redo()
    expect(state().project).toEqual(baseProject)
    expect(state().activeSketch).toEqual(sketchEdited)
    state().redo()
    expect(state().project).toEqual(projectEdited)
    expect(state().activeSketch).toEqual(sketchEdited)
  })

  it('restores sketch-only history in place without requesting a scene reload', () => {
    const state = () => useCamStore.getState()
    state().pushHistory()
    useCamStore.setState({
      activeSketch: sketchWith(line('base-line', 0), line('sketch-only', 6)),
    })

    state().undo()
    expect(state().viewportRefreshTrigger).toBe(0)
    expect(state().activeSketch?.entities.map((entity) => entity.id)).toEqual(['base-line'])

    state().redo()
    expect(state().viewportRefreshTrigger).toBe(0)
    expect(state().activeSketch?.entities.map((entity) => entity.id)).toEqual([
      'base-line',
      'sketch-only',
    ])
  })

  it('still requests a scene reload when history changes the project', () => {
    const state = () => useCamStore.getState()
    state().pushHistory()
    useCamStore.setState({ project: namedProject('project-scene-edit') })

    state().undo()
    expect(state().viewportRefreshTrigger).toBe(1)

    state().redo()
    expect(state().viewportRefreshTrigger).toBe(2)
  })

  it('a fresh edit clears the redo branch for project and sketch', () => {
    const state = () => useCamStore.getState()
    state().pushHistory()
    useCamStore.setState({
      project: namedProject('abandoned-branch'),
      activeSketch: sketchWith(line('abandoned-line', 3)),
    })
    state().undo()
    expect(state().canRedo).toBe(true)

    state().pushHistory()
    const freshProject = namedProject('fresh-branch')
    const freshSketch = sketchWith(line('fresh-line', 8))
    useCamStore.setState({ project: freshProject, activeSketch: freshSketch })

    expect(state().canRedo).toBe(false)
    expect(state().projectFuture).toEqual([])
    expect(state().sketchFuture).toEqual([])
    state().redo()
    expect(state().project).toEqual(freshProject)
    expect(state().activeSketch).toEqual(freshSketch)
  })

  it('defaultPrevented redo chord is ignored while unclaimed Ctrl+Shift+Z is handled', () => {
    const redo = vi.fn()
    act(() => { useCamStore.setState({ redo, canRedo: true }) })
    render(createElement(TopToolbar))

    const claimed = new KeyboardEvent('keydown', {
      key: 'Z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    claimed.preventDefault()
    window.dispatchEvent(claimed)
    expect(redo).not.toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }))
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Y also invokes redo', () => {
    const redo = vi.fn()
    act(() => { useCamStore.setState({ redo, canRedo: true }) })
    render(createElement(TopToolbar))

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'y',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
    expect(redo).toHaveBeenCalledTimes(1)
  })
})
