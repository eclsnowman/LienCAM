// @vitest-environment jsdom
//
// UI-50C-R2 carried minor (preflight-required edit 7a, survived TWO audits
// unfixed): ConstraintBrowser's DIM_BADGE_TEXT rendered d1xd2 as the
// misleading 'd1x2' -- pins the REAL rendered badge text ('d1xd2') so a
// future regression fails a render test, not just a code-review re-read.
// Harness copied from BottomConsole.smoke.test.tsx (localStorage shim,
// dynamic import, store reset pattern).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { Sketch, SketchDimension } from '../../lib/sketch/types'

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

const { ConstraintBrowser } = await import('../../components/panels/sketch/ConstraintBrowser')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

function d1xd2Sketch(): Sketch {
  const dim: SketchDimension = {
    id: 'badge-test-dim', kind: 'd1xd2', entityId: 'chamfer-line',
    driving: false, value: 3.5, d2: 4.25,
  }
  return {
    id: 'badge-test-sketch', layerId: 'layer-1',
    entities: [{
      id: 'chamfer-line', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 3.5, y: 4.25 },
    }],
    constraints: [],
    dimensions: [dim],
    solveStatus: null,
  }
}

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: d1xd2Sketch(),
      sketchSolveStatus: null,
      sketchSelectedIds: [],
    })
  })
})

describe('ConstraintBrowser d1xd2 badge text (UI-50C-R2 carried minor)', () => {
  it('renders the badge as "d1xd2", never the "d1x2" typo', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<ConstraintBrowser />)).not.toThrow()
      expect(screen.getByText('d1xd2')).toBeTruthy()
      expect(screen.queryByText('d1x2')).toBeNull()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
