// @vitest-environment jsdom
//
// The CAM Sketch toolbox's layout, per viewer: compact (icons only; each hover
// hint starts with the tool's name) and folded groups, both remembered.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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
const { injectSketchAnchors } = await import('../../lib/sketch/sketchAnchors')

const toolbox = () => document.querySelector('.sketch-toolbox')!
const header = (title: string) => [...document.querySelectorAll('.sketch-toolbox .tree-section-header')].find((h) => h.textContent?.startsWith(title)) as HTMLElement

describe('the CAM Sketch toolbox layout', () => {
  beforeEach(() => {
    mem.clear()
    act(() => { useCamStore.setState({ activeSketch: injectSketchAnchors(createBlankSketch('layer-1'), { x: 0, y: 0 }) }) })
  })
  afterEach(cleanup)

  it('compact: the toolbox says so, and a hint that does not name its tool gets the name first', () => {
    render(<SketchToolbox />)
    expect(toolbox().classList.contains('is-compact')).toBe(false)
    expect(screen.getByTestId('cam-sketch-measure').getAttribute('data-tooltip')).toMatch(/^Inspect selected geometry/)
    fireEvent.click(screen.getByTestId('cam-sketch-compact'))
    expect(toolbox().classList.contains('is-compact')).toBe(true)
    expect(screen.getByTestId('cam-sketch-measure').getAttribute('data-tooltip')).toMatch(/^Measure: Inspect selected geometry/)
    // a hint that already starts with its name is left alone
    expect(document.querySelector('.sketch-tool-btn[data-tooltip^="Line"]')?.getAttribute('data-tooltip')).not.toMatch(/^Line: Line/)
  })

  it('folds and compact are remembered for the next visit', () => {
    render(<SketchToolbox />)
    fireEvent.click(screen.getByTestId('cam-sketch-compact'))
    fireEvent.click(header('Utility'))
    expect(screen.queryByTestId('cam-sketch-measure')).toBeNull()
    cleanup()
    render(<SketchToolbox />)
    expect(toolbox().classList.contains('is-compact')).toBe(true)
    expect(screen.queryByTestId('cam-sketch-measure')).toBeNull()
    fireEvent.click(header('Utility'))
    expect(screen.getByTestId('cam-sketch-measure')).toBeTruthy()
  })
})
