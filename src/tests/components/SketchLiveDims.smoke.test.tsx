// @vitest-environment jsdom
//
// React-render SMOKE test for SketchLiveDimsOverlay (live W/H + a/b labels
// while rubber-band drawing). Same harness pattern as
// NestModal.smoke.test.tsx / SketchTextInput.smoke.test.tsx: jsdom + the real
// singleton store + a minimal viewport stub. Pins that a mocked MID-DRAG chain
// renders its live labels OUTSIDE the shape on screen (Operator's placement
// verdict), an ellipse minor phase renders a and b, that the overlay is ABSENT
// when idle (no chain), and that an AXIS rectangle carries NO duplicate pair -
// WO-3116 gave it one shared W/H editor instead.

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

// jsdom's localStorage is broken under vitest's node flags and the store uses
// persist(); install an in-memory shim BEFORE importing the store.
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
// The overlay runs a per-frame rAF sync; keep it single-shot in jsdom — the
// assertions below run against the INITIAL render, which computes the same
// labels from the same pure helper.
vi.stubGlobal('requestAnimationFrame', () => 0)
vi.stubGlobal('cancelAnimationFrame', () => undefined)

const { SketchLiveDimsOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchLiveDimsOverlay')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
// WO SKC-14B: the armed tool + chain live in the sketcher package now, behind a store-free
// reactive store. The overlay reads them through useSyncExternalStore, so the seed must land there.
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')
import type { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ToolChainState } from '../../lib/sketch/tools/toolMachine'

// Minimal viewport stub: the overlay needs the last sketch cursor (the live
// rubber-band point) and worldToScreen for label placement. The stub flips y
// (screen y grows DOWN) like the real projection, so the outside-the-shape
// assertions below exercise the real world->screen outward-offset path.
let cursor: { x: number; y: number } | null = null
const fakeViewport = {
  getLastSketchCursor: () => cursor,
  worldToScreen: (x: number, y: number) => ({ x: 100 + x, y: 100 - y }),
} as unknown as CNCViewport
const viewportRef = { current: fakeViewport }

/** Screen position of a label element from its transform string. */
function screenPos(el: HTMLElement): { x: number; y: number } {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)
  expect(m).not.toBeNull()
  return { x: parseFloat(m![1]), y: parseFloat(m![2]) }
}

afterEach(cleanup)

function setSketchState(chain: ToolChainState | null, tool = 'rect-corner') {
  act(() => {
    useCamStore.setState({
      viewer: { ...useCamStore.getState().viewer, mode: 'sketch' },
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [], constraints: [], dimensions: [], solveStatus: null,
      },
    } as never)
    sketcherToolStore.setState({ tool, chain } as never)
  })
}

beforeEach(() => {
  cursor = null
  setSketchState(null)
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('SketchLiveDimsOverlay (live draw dimensions)', () => {
  it('renders NOTHING when idle (no in-progress chain)', () => {
    cursor = { x: 40, y: -30 }
    render(<SketchLiveDimsOverlay port={port} />)
    expect(document.querySelector('.sketch-live-dim-layer')).toBeNull()
    expect(screen.queryByText('40')).toBeNull()
  })

  it('mid-drag AXIS rect chain leaves W and H to the one shared size editor', () => {
    // Anchor (0,0), cursor (40,-30): a 40 x 30 rubber-band rectangle. WO-3116
    // suppresses this duplicate pair - the shared W/H editor owns the dimensions
    // of an axis rectangle, and two contradictory pairs is the defect it fixed.
    setSketchState({ kind: 'rect', mode: 'corner', anchor: { x: 0, y: 0 } })
    cursor = { x: 40, y: -30 }
    render(<SketchLiveDimsOverlay port={port} />)
    expect(document.querySelector('.sketch-live-dim-layer')).toBeNull()
    expect(screen.queryByText('40')).toBeNull()
    expect(screen.queryByText('30')).toBeNull()
  })

  it('mid-drag ROTATED rect chain renders its live edge length outside the shape', () => {
    // WO-3116 keeps the live labels for the routes the shared editor does not
    // cover. First edge only, anchor (0,0) -> cursor (40,0): the 40 mm length
    // sits at the edge midpoint, a constant screen gap off the segment.
    setSketchState({ kind: 'rect', mode: 'corner', anchor: { x: 0, y: 0 }, rotated: true })
    cursor = { x: 40, y: 0 }
    render(<SketchLiveDimsOverlay port={port} />)
    const edge = screenPos(screen.getByText('40'))
    expect(edge.x).toBeCloseTo(120, 6) // world x 20 -> screen 120, midpoint
    expect(Math.abs(edge.y - 100)).toBeCloseTo(18, 6) // 18 px off the segment
    // Display-only: the labels are never click targets or inputs.
    expect(document.querySelectorAll('.sketch-live-dim input')).toHaveLength(0)
  })

  it('ellipse minor phase renders live a and b labels', () => {
    setSketchState(
      { kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 10, y: 0 } },
      'ellipse',
    )
    cursor = { x: 0, y: 3 }
    render(<SketchLiveDimsOverlay port={port} />)
    expect(screen.getByText('10')).not.toBeNull() // a (major radius)
    expect(screen.getByText('3')).not.toBeNull()  // b (minor radius)
  })

  it('labels VANISH when the chain commits/cancels (chain -> null)', () => {
    // Ellipse route: the live-label route WO-3116 kept (an axis rect has none).
    setSketchState(
      { kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 10, y: 0 } },
      'ellipse',
    )
    cursor = { x: 0, y: 3 }
    render(<SketchLiveDimsOverlay port={port} />)
    expect(screen.getByText('10')).not.toBeNull()
    act(() => { sketcherToolStore.setState({ chain: null }) })
    expect(screen.queryByText('10')).toBeNull()
    expect(document.querySelector('.sketch-live-dim-layer')).toBeNull()
  })
})
