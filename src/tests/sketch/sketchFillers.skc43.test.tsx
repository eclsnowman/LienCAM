// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
let SketchToolbox: typeof import('../../components/panels/sketch/SketchToolbox').SketchToolbox
let WorkbenchToolRail: typeof import('../../components/model3d/workbench/WorkbenchToolRail').WorkbenchToolRail
let sketchSessionStore: typeof import('../../components/model3d/workbench/sketchSessionStore').sketchSessionStore
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
let createBlankSketch: typeof import('../../lib/sketch/blankSketch').createBlankSketch

function line(id: string): SketchEntity {
  return {
    id,
    kind: 'line',
    construction: false,
    start: { x: 0, y: 0 },
    end: { x: 10, y: 0 },
  }
}

function sketchWith(...entities: SketchEntity[]): Sketch {
  return { ...createBlankSketch('skc43-filler-layer'), entities }
}

function renderWorkbench(sketch: Sketch) {
  act(() => {
    sketchSessionStore.setState({
      active: true,
      sketch,
      sketchNodeId: 'sketch3d:SKC43',
      selectedIds: [],
    })
  })
  return render(
    <WorkbenchToolRail
      sketchActive
      modelingSections={[]}
      sketchHistoryTools={[]}
      onFinishSketch={vi.fn()}
    />,
  )
}

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox'))
  ;({ WorkbenchToolRail } = await import('../../components/model3d/workbench/WorkbenchToolRail'))
  ;({ sketchSessionStore } = await import('../../components/model3d/workbench/sketchSessionStore'))
  ;({ sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  ;({ createBlankSketch } = await import('../../lib/sketch/blankSketch'))
})

beforeEach(() => {
  sketchSessionStore.__reset()
  sketcherToolStore.__reset()
  act(() => {
    useCamStore.setState({
      activeSketch: sketchWith(line('selected-line')),
      sketchSelectedIds: ['selected-line'],
      sketchNotice: null,
      projectHistory: [],
      sketchHistory: [],
      projectFuture: [],
      sketchFuture: [],
      canUndo: false,
      canRedo: false,
    })
  })
})

afterEach(() => {
  cleanup()
  sketchSessionStore.__reset()
})

describe('SKC-43 sketch filler parity', () => {
  it('Construction selection action surfaces its entity flip in the notice', () => {
    render(<SketchToolbox />)
    fireEvent.click(screen.getByRole('button', { name: 'Construction' }))

    const state = useCamStore.getState()
    expect(state.activeSketch?.entities[0]?.construction).toBe(true)
    expect(state.sketchNotice).toBe('Toggled construction on 1 entity')
  })

  it('workbench Finish uses the CAM state-aware tooltip for filled and empty sketches', () => {
    renderWorkbench(sketchWith(line('filled-line')))
    const finish = screen.getByTestId('workbench-finish-package-sketch')
    expect(finish.getAttribute('data-tooltip'))
      .toBe('Bake this sketch to its geometry layer and exit sketch mode')

    act(() => { sketchSessionStore.setState({ sketch: sketchWith() }) })
    expect(finish.getAttribute('data-tooltip'))
      .toBe('Exit sketch mode (empty sketch is discarded)')
  })

  it('both sketchers render the shared glyph-toggle component and hit target', () => {
    render(<SketchToolbox />)
    const camToggle = screen.getByTestId('cam-sketch-glyph-toggle')
    const camContract = {
      marker: camToggle.getAttribute('data-sketch-header-toggle'),
      className: camToggle.className,
      title: camToggle.getAttribute('data-tooltip'),
      text: camToggle.textContent,
    }
    cleanup()

    renderWorkbench(sketchWith(line('workbench-line')))
    const workbenchToggle = screen.getByTestId('workbench-package-glyph-toggle')
    expect({
      marker: workbenchToggle.getAttribute('data-sketch-header-toggle'),
      className: workbenchToggle.className,
      title: workbenchToggle.getAttribute('data-tooltip'),
      text: workbenchToggle.textContent,
    }).toEqual(camContract)
    expect(camContract.marker).toBe('glyphs')

    const camSource = readFileSync(
      resolve(process.cwd(), 'src/components/panels/sketch/SketchToolbox.tsx'),
      'utf8',
    )
    const workbenchSource = readFileSync(
      resolve(process.cwd(), 'src/components/model3d/workbench/WorkbenchToolRail.tsx'),
      'utf8',
    )
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    expect(camSource.match(/<SketchGlyphToggle/g)).toHaveLength(1)
    expect(workbenchSource.match(/<SketchGlyphToggle/g)).toHaveLength(1)
    expect(css).toMatch(/\.sketch-header-toggle\s*\{[^}]*min-height:\s*var\(--hit-target-min\)/s)
  })
})
