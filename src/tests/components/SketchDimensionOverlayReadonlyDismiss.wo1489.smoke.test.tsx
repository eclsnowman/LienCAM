// @vitest-environment jsdom
//
// WO-1489: a REFERENCE d1xd2 chamfer-setback pair has no dismissal lifecycle of its own -- both
// its value boxes are disabled, so neither can take focus or fire a blur, unlike a driving
// dimension's live <input>, which closes on Escape (direct call) and on losing focus. (WO-1858
// made the pair drivable and turned its two readouts into real disabled inputs; the REFERENCE
// state this file covers still has nothing focusable inside it, so the wiring below still binds.)
// This locks in that
// SketchDimensionOverlay's popover container (`.sketch-dim-editor`) picks up that same
// closeDimensionEditor() wiring for the readout case: Escape closes it directly, and a real
// pointerdown outside the container closes it independent of blur -- a canvas click never blurs
// this container (sketchInteraction.ts preventDefaults the native focus-shift and only explicitly
// blurs a focused `.sketch-dim-input`), so the outside-click path is its own listener, not a reuse
// of the editable input's blur-to-close. Neither dismissal touches the stored setbacks, and
// dismissing it leaves a nearby driving dimension's label reachable. FAILS ON MAIN: the d1xd2
// container carries no tabIndex, keydown, or outside-pointerdown handling at all, so neither
// Escape nor a real outside click ever closes it.

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { RefObject } from 'react'
import type { SketchDimension, SketchEntity } from '../../lib/sketch/types'
import type { CNCViewport } from '../../lib/viewport/CNCViewport'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(). Install an in-memory Storage shim BEFORE importing
// the store (same scaffolding as the other *.smoke.test.tsx files).
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

const { SketchDimensionOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchDimensionOverlay')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')

afterEach(cleanup)

const fakeViewport = {
  getLastSketchCursor: () => ({ x: 0, y: 0 }),
  worldToScreen: () => ({ x: 0, y: 0 }),
  getWorldPerPixel: () => 1,
} as unknown as CNCViewport
const viewportRef: RefObject<CNCViewport | null> = { current: fakeViewport }

// Fixtures: a driving distance dim (pa/pb) sits alongside the chamfer's reference readout, the
// same way a real corner would -- criterion 4 needs it still reachable once the readout is
// dismissed. `chamferLine` is the chamfer cut entity (dimensionDisplay's d1xd2 case requires a
// real 'line' entity to anchor the label).
const pa: SketchEntity = { id: 'pa', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const pb: SketchEntity = { id: 'pb', kind: 'point', construction: false, at: { x: 25, y: 0 } }
const chamferLine: SketchEntity = {
  id: 'chamferLine', kind: 'line', construction: false,
  start: { x: 10, y: 10 }, end: { x: 15, y: 10 },
}
const drivingDim: SketchDimension = {
  id: 'driving-1', kind: 'distance', driving: true, value: 25,
  a: { entityId: 'pa', site: 'self' }, b: { entityId: 'pb', site: 'self' },
  labelAnchor: { x: 12.5, y: 5 },
}
const chamferDim: SketchDimension = {
  id: 'chamfer-1', kind: 'd1xd2', driving: false, value: 3, d2: 4,
  entityId: 'chamferLine', labelAnchor: { x: 12.5, y: 12 },
}

function openChamferReadout() {
  act(() => {
    useCamStore.setState({
      activeSketch: {
        id: 's1', layerId: 'L1', entities: [pa, pb, chamferLine],
        constraints: [], dimensions: [drivingDim, chamferDim],
        solveStatus: { dof: 0, conflicting: [], redundant: [] },
      },
      sketchTool: 'select', sketchToolChain: null,
      sketchSelectedIds: [],
      sketchDimEditor: { dimId: 'chamfer-1', isNew: false },
    } as never)
    useCamStore.getState().setDisplayUnits('mm')
    useCamStore.getState().setViewerMode('sketch')
  })
}

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: null, sketchTool: 'select', sketchToolChain: null,
      sketchSelectedIds: [], sketchDimEditor: null,
    } as never)
  })
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('SketchDimensionOverlay: read-only chamfer readout dismissal (WO-1489)', () => {
  it('opens focused, and Escape closes it via the same closeDimensionEditor() the editable path calls', () => {
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const editor = container.querySelector('.sketch-dim-editor') as HTMLElement
    expect(editor).not.toBeNull()
    expect(document.activeElement).toBe(editor)

    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(useCamStore.getState().sketchDimEditor).toBeNull()
  })

  it('a real canvas click closes it: a pointerdown outside the editor, with no blur ever fired (WO-1489 audit)', () => {
    // The real canvas press never blurs this container -- sketchInteraction.ts's
    // handlePointerDown preventDefaults the native focus-shift and only explicitly blurs a focused
    // `.sketch-dim-input`, a class this readonly container never carries. So this drives the actual
    // mechanism (a pointerdown landing outside the editor, `document.body` standing in for the
    // canvas element) instead of `fireEvent.blur`, which a real click never produces here.
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const editor = container.querySelector('.sketch-dim-editor') as HTMLElement
    expect(document.activeElement).toBe(editor)

    fireEvent.pointerDown(document.body)

    expect(useCamStore.getState().sketchDimEditor).toBeNull()
  })

  it('a pointerdown inside the editor (on one of its own value boxes) does not close it', () => {
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const box = container.querySelector('.sketch-dim-editor input.sketch-dim-input') as HTMLElement

    fireEvent.pointerDown(box)

    expect(useCamStore.getState().sketchDimEditor).not.toBeNull()
  })

  it('losing focus without any pointerdown (Tab away) still closes it via onBlur', () => {
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const editor = container.querySelector('.sketch-dim-editor') as HTMLElement

    fireEvent.blur(editor)

    expect(useCamStore.getState().sketchDimEditor).toBeNull()
  })

  it('neither dismissal path mutates the reference-only setback values', () => {
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const editor = container.querySelector('.sketch-dim-editor') as HTMLElement

    fireEvent.keyDown(editor, { key: 'Escape' })

    const dim = useCamStore.getState().activeSketch!.dimensions
      .find((d) => d.id === 'chamfer-1') as typeof chamferDim
    expect(dim.driving).toBe(false)
    expect(dim.value).toBe(3)
    expect(dim.d2).toBe(4)
  })

  it('a REFERENCE pair shows BOTH setbacks in disabled value boxes, beside a LIVE driving toggle', () => {
    // WO-1858: the old assertion here was that neither value could ever be a form control, because
    // neither was ever editable. Both are editable now -- the toggle beside them unlocks them --
    // so the honest pin is the reference STATE: two boxes, disabled, showing both numbers, with the
    // toggle that unlocks them enabled. That is exactly how a reference distance dim reads, which
    // is what stops this from being the dead control DESIGN-REVIEW-CHECKLIST item 11 bans.
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const boxes = container.querySelectorAll<HTMLInputElement>('.sketch-dim-editor input.sketch-dim-input')
    expect(boxes.length).toBe(2)
    expect(boxes[0].value).toBe('3')
    expect(boxes[1].value).toBe('4')
    expect(boxes[0].disabled).toBe(true)
    expect(boxes[1].disabled).toBe(true)
    const toggle = container.querySelector<HTMLButtonElement>('.sketch-dim-editor .sketch-dim-drive-toggle')
    expect(toggle).not.toBeNull()
    expect(toggle!.disabled).toBe(false)
  })

  it('dismissing the readout leaves a nearby driving dim label in the DOM, reachable for its own gesture', () => {
    openChamferReadout()
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const editor = container.querySelector('.sketch-dim-editor') as HTMLElement

    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(container.querySelector('.sketch-dim-editor')).toBeNull()
    expect(container.querySelector('[data-dim-id="driving-1"]')).not.toBeNull()
  })

  it('the editable (drivable) editor is untouched: no tabIndex/blur-close added to its own container behavior', () => {
    openChamferReadout()
    act(() => {
      useCamStore.setState({ sketchDimEditor: { dimId: 'driving-1', isNew: false } } as never)
    })
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const editor = container.querySelector('.sketch-dim-editor') as HTMLElement
    // The editable path's dismissal still lives on the <input> itself, not the container.
    expect(editor.getAttribute('tabindex')).toBeNull()
    expect(container.querySelector('input.sketch-dim-input')).not.toBeNull()
  })
})
