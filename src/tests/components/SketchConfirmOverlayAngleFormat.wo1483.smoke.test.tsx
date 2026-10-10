// @vitest-environment jsdom
//
// WO-1483: the confirm overlay's non-length numeric fields (the
// circular-pattern step-angle) bypassed the shared editable-number
// formatter and rendered the raw stored float. A 30-degree pattern that
// round-trips through radians displays 29.999999999999996 in the field
// while the sidebar (which formats it) shows "30". This locks the Step
// field to the same noise-stripped display every other editable field
// already gets.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// In-memory Storage shim BEFORE importing the store (same scaffolding as the
// other *.smoke.test.tsx files).
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

const { SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

afterEach(cleanup)

// The exact float a 30-degree step produces after a radians round-trip
// (30 * Math.PI / 180) * (180 / Math.PI) — reproduces the bug report's
// 29.999999999999996 without hand-typing a magic literal.
const NOISY_30 = (30 * Math.PI / 180) * (180 / Math.PI)

const port = createCamOverlaysPort(() => null)

function armCircularPattern(angleDeg: number) {
  sketcherToolStore.__reset()
  useCamStore.setState({
    activeSketch: {
      id: 's1', layerId: 'L1', entities: [],
      constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    },
  } as never)
  sketcherToolStore.setState({
    tool: 'pattern-circular',
    chain: {
      kind: 'circpat', ids: ['e1'], confirmed: true,
      center: { x: 0, y: 0 }, seeded: false,
    },
    circularPatternCount: 12,
    circularPatternAngleDeg: angleDeg,
  } as never)
  useCamStore.getState().setDisplayUnits('mm')
  useCamStore.getState().setViewerMode('sketch')
}

function renderStepInput(): HTMLInputElement {
  const { container } = render(<SketchConfirmOverlay port={port} />)
  const inputs = container.querySelectorAll('.sketch-confirm-field input')
  // Circular pattern fields are [Count, Step] in that order (confirmOverlay.ts).
  return inputs[1] as HTMLInputElement
}

describe('WO-1483: SketchConfirmOverlay circular-pattern Step field formatting', () => {
  it('confirms the round-trip actually produces float noise (guards the fixture)', () => {
    expect(NOISY_30).not.toBe(30)
    expect(String(NOISY_30)).toBe('29.999999999999996')
  })

  it('strips float noise from the Step field: shows "30", not "29.999999999999996"', () => {
    armCircularPattern(NOISY_30)
    const input = renderStepInput()
    expect(input.value).toBe('30')
  })

  it('still shows a clean non-integer step exactly (display-only fix, no rounding)', () => {
    armCircularPattern(22.5)
    const input = renderStepInput()
    expect(input.value).toBe('22.5')
  })
})
