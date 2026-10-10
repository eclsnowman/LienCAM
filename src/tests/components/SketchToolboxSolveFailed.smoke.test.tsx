// @vitest-environment jsdom
//
// React-render SMOKE test for the sketch definition chip's FAILED-solve
// state (ADR 0003 fail loud). The repo's vitest env is 'node' by default
// (vite.config.ts); the directive above flips THIS file to jsdom so a real
// React tree can mount.
//
// Bug locked out: a solve that failed to MAP returned a status with a
// placeholder dof of 0; the chip rendered dof === 0 as a GREEN "Fully
// defined" — a false-positive safety signal. The status now carries an
// explicit solveFailed marker and the chip renders a distinct red
// "Solve failed" chip whose title carries the failure reason. This is the
// hard UI render gate (tsc + pure-logic vitest miss JSX-wiring bugs).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Install
// a minimal in-memory Storage shim BEFORE importing the store.
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

// The store is a process singleton; reset the fields this test touches so
// the cases are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: createBlankSketch('layer-chip-test', () => 'chip-test'),
      sketchSolveStatus: null,
    })
  })
})

describe('SketchDefinitionChip failed-solve state', () => {
  it('renders "Solve failed" (never "Fully defined" / "N DoF") for a solveFailed status', () => {
    act(() => {
      useCamStore.setState({
        sketchSolveStatus: {
          // The exact false-positive shape: placeholder dof 0, no conflicts.
          dof: 0, conflicting: [], redundant: [],
          solveFailed: true,
          failureMessage: "fix 'dangling': unknown entity id 'GHOST'",
        },
      })
    })
    render(<SketchToolbox />)
    const chip = screen.getByText('Solve failed')
    expect(chip).not.toBeNull()
    // Tooltip/title carries the reason.
    expect(chip.closest('.sketch-def-chip')!.getAttribute('data-tooltip'))
      .toContain("unknown entity id 'GHOST'")
    // Visually distinct (error/red token class), and NEVER the green state.
    expect(chip.closest('.sketch-def-chip-failed')).not.toBeNull()
    expect(screen.queryByText('Fully defined')).toBeNull()
    expect(screen.queryByText(/\d+ DoF/)).toBeNull()
  })

  it('control: an unmarked dof-0 status still renders "Fully defined"', () => {
    act(() => {
      useCamStore.setState({
        sketchSolveStatus: { dof: 0, conflicting: [], redundant: [] },
      })
    })
    render(<SketchToolbox />)
    expect(screen.getByText('Fully defined')).not.toBeNull()
    expect(screen.queryByText('Solve failed')).toBeNull()
  })

  it('control: an unmarked under-defined status still renders the DoF count', () => {
    act(() => {
      useCamStore.setState({
        sketchSolveStatus: { dof: 3, conflicting: [], redundant: [] },
      })
    })
    render(<SketchToolbox />)
    expect(screen.getByText('3 DoF')).not.toBeNull()
    expect(screen.queryByText('Solve failed')).toBeNull()
  })

  it('a blank null status is neutral and never "Fully defined"', () => {
    act(() => {
      useCamStore.setState({
        activeSketch: createBlankSketch('layer-chip-test', () => 'chip-test'),
        sketchSolveStatus: null,
      })
    })
    render(<SketchToolbox />)
    expect(screen.getByText('Not solved')).not.toBeNull()
    expect(screen.queryByText('Fully defined')).toBeNull()
    expect(screen.getByTestId('cam-sketch-dof-chip').className)
      .not.toContain('sketch-def-chip-defined')
  })
})
