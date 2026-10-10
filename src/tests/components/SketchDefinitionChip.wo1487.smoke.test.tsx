// @vitest-environment jsdom
//
// WO-1487: a sketch that has not been solved YET is not a broken solver.
//
// SketchDefinitionChip's null-status branch covers the completely ordinary
// case of a freshly-created / not-yet-solved sketch (an empty sketch, or one
// whose first entity has not triggered a solve pass yet). That is a missing
// definition VERDICT, not a solver-availability problem: the CAM store
// exposes no availability signal to this component, and drawing one ordinary
// line immediately yields a DoF verdict with no solver error at any point.
// The chip label must read as "no verdict yet"; only a genuine solveFailed
// verdict may render as a failure.

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
const { useCamStore } = await import('../../store')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: createBlankSketch('layer-wo1487', () => 'wo1487'),
      sketchSolveStatus: null,
    })
  })
})

describe('WO-1487 SketchDefinitionChip null-status wording', () => {
  it('renders the neutral no-verdict-yet label, never a solver-availability problem', () => {
    render(<SketchToolbox />)
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(chip.textContent).toContain('Not solved')
    // The old wording implied the SOLVER was unavailable/broken.
    expect(chip.textContent).not.toContain('Solver not ready')
    expect(chip.textContent).not.toContain('Solver unavailable')
    // Still not a green "defined" signal (fail-closed).
    expect(chip.className).not.toContain('sketch-def-chip-defined')
    expect(chip.getAttribute('data-tooltip'))
      .toContain('not produced a definition verdict')
  })

  it('keeps a genuine solve failure as its own distinct "Solve failed" chip', () => {
    act(() => {
      useCamStore.setState({
        sketchSolveStatus: {
          dof: 0, conflicting: [], redundant: [],
          solveFailed: true,
          failureMessage: 'non-convergence',
        },
      })
    })
    render(<SketchToolbox />)
    const chip = screen.getByTestId('cam-sketch-dof-chip')
    expect(chip.textContent).toContain('Solve failed')
    expect(chip.textContent).not.toContain('Not solved')
    expect(chip.className).toContain('sketch-def-chip-failed')
  })
})
