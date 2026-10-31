// @vitest-environment jsdom
//
// WO SKC-14C, the ACCEPTANCE KEYSTONE for rows 10-17.
//
// SKC-14B's keystone (sketcherLifecycle.test.ts) proved a store-free mount can run the full TOOL
// LOOP: arm a tool, draw a line, draw an arc, all through a fake host that implements only
// `SketchDocumentPort`. It could not prove the same for the sketch CHROME, because the chrome still
// lived in `src/components/viewport/` and read `useCamStore` directly. Its report said so plainly
// and deferred it here.
//
// This file is the missing half. It renders `<SketcherOverlays port={fakePort}/>` -- all eight
// overlays -- against a host that is NOT CAM: a hand-rolled reactive store, ~40 lines, implementing
// the 23 members of `SketcherOverlaysPort`. Nothing in this file imports `src/store` (asserted
// below, against its own bytes). Through it the suite:
//
//   * renders every one of the eight, and asserts each is ABSENT at rest (nothing new at rest),
//   * drives a real DOM gesture on a moved overlay -- typing a length into the draw-value box and
//     pressing Enter -- and pins that it opens EXACTLY ONE undo step and appends EXACTLY ONE
//     entity, through the real tool machine and a real `SketchDocumentPort`,
//   * pins that the context-menu ANCHOR is package state: `sketcherMenuPort.open()` mounts the
//     menu, an item dispatches through the port, and `close()` unmounts it. No host `useState`.
//
// WHY IT IS THE KILL SHOT: an S3 workbench can now mount the sketch UI. There is no longer a file
// in which a second version of the dimension label, the prompt bar, the confirm overlay or the
// context menu could be written -- which is the critic's law (docs/3d/SKETCH-CRITIC-REPORT.md)
// extended from behavior to pixels.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { useSyncExternalStore } from 'react'
import * as THREE from 'three'
import {
  Sketcher, SketcherOverlays, sketcherMenuPort, sketcherMenuStore, sketcherTools, sketcherToolStore,
  bindSketcherDocument,
} from '../../lib/sketch/sketcher'
import type {
  SketcherHost, SketcherOverlaysPort, SketcherOverlaySurface, SketchDimEditorState,
} from '../../lib/sketch/sketcher'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchConstraintKind, SketchEntity, TextPathAlign } from '../../lib/sketch/types'
import { getByTooltip } from '../support/tooltipQuery'
import { __resetSketchClipboardForTest } from '../../lib/sketch/sketcher/toolController'

// ---- the document ------------------------------------------------------------------------------

const LINE: SketchEntity = {
  id: 'l1', kind: 'line', construction: false,
  start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
}
/** Shares the corner (10,0) with LINE, so a fillet corner can actually be staged there. */
const LINE2: SketchEntity = {
  id: 'l2', kind: 'line', construction: false,
  start: { x: 10, y: 0 }, end: { x: 10, y: 10 },
}
const TEXT_ON_PATH: SketchEntity = {
  id: 't1', kind: 'text', construction: false, text: 'HELLO',
  at: { x: 0, y: 0 }, height: 5, rotation: 0, fontStyle: 'single-line',
  pathId: 'l1', pathAlign: 'center', pathFlip: false,
}

function freshSketch(): Sketch {
  return {
    id: 's', layerId: 'l', entities: [LINE], constraints: [],
    dimensions: [{
      id: 'd1', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'l1', site: 'start' }, b: { entityId: 'l1', site: 'end' },
      labelAnchor: { x: 5, y: -5 },
    }],
    solveStatus: null,
  }
}

// ---- the fake HOST: a reactive store that is not zustand and is not CAM ------------------------

interface HostState {
  isSketchActive: boolean
  sketch: Sketch | null
  displayUnits: 'mm' | 'inch'
  selectedIds: string[]
  dimEditor: SketchDimEditorState | null
  textEditId: string | null
}

interface FakeHost {
  port: SketcherOverlaysPort
  set(patch: Partial<HostState>): void
  state(): HostState
  /** Every COMMAND the overlays sent, in order. The port is the only way out of the package. */
  calls: string[]
  /** Undo steps opened by the real tool controller through the real document port. */
  beginStepCalls: number
  appendCalls: number
  replaceCalls: number
  doc: SketchDocumentPort
}

/** The surface. `worldToScreen` is 10x with no offset, so assertions stay arithmetic. */
const surface: SketcherOverlaySurface = {
  worldToScreen: (x, y) => ({ x: x * 10, y: y * 10 }),
  getLastSketchCursor: () => ({ x: 4, y: 0 }),
}

function makeHost(): FakeHost {
  let state: HostState = {
    isSketchActive: false, sketch: freshSketch(), displayUnits: 'mm',
    selectedIds: [], dimEditor: null, textEditId: null,
  }
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
  const notify = () => { for (const l of [...listeners]) l() }
  const calls: string[] = []
  const h = { calls, beginStepCalls: 0, appendCalls: 0, replaceCalls: 0 } as FakeHost

  /** The package's hooks, supplied by the host. A real mount hands over its own reactivity; this
   *  one hands over `useSyncExternalStore` because that is the cheapest correct thing a host with
   *  no framework can do. Every selector returns a reference-stable value.
   *
   *  Named `useHostValue`, not `sel`: it IS a custom hook, and `rules-of-hooks` says so. */
  const useHostValue = <T,>(f: (s: HostState) => T): T =>
    useSyncExternalStore(subscribe, () => f(state), () => f(state))

  const port: SketcherOverlaysPort = {
    useIsSketchActive: () => useHostValue((s) => s.isSketchActive),
    useSketch: () => useHostValue((s) => s.sketch),
    useDisplayUnits: () => useHostValue((s) => s.displayUnits),
    useSelectedIds: () => useHostValue((s) => s.selectedIds),
    useDimEditor: () => useHostValue((s) => s.dimEditor),
    useTextEditId: () => useHostValue((s) => s.textEditId),
    useTextDraft: () => useHostValue((s) => {
      const id = s.textEditId
      if (!id) return ''
      const e = s.sketch?.entities.find((x) => x.id === id)
      return e && e.kind === 'text' ? e.text : ''
    }),

    getSketch: () => state.sketch,
    getDisplayUnits: () => state.displayUnits,
    getTextEditId: () => state.textEditId,
    getSurface: () => surface,

    toggleDimensionDriving: (id) => calls.push(`toggleDimensionDriving:${id}`),
    commitDimensionValue: (id, v) => calls.push(`commitDimensionValue:${id}:${v}`),
    closeDimensionEditor: () => calls.push('closeDimensionEditor'),

    setTextValue: (v) => calls.push(`setTextValue:${v}`),
    setTextCaretIndex: (i) => calls.push(`setTextCaretIndex:${i}`),
    commitTextEdit: () => calls.push('commitTextEdit'),
    cancelTextEdit: () => calls.push('cancelTextEdit'),
    setTextPathAlignById: (id, a: TextPathAlign) => calls.push(`setTextPathAlignById:${id}:${a}`),
    setTextPathFlipById: (id, f) => calls.push(`setTextPathFlipById:${id}:${f}`),
    setTextMirrorById: (id, m) => calls.push(`setTextMirrorById:${id}:${m}`),

    applyConstraint: (k: SketchConstraintKind) => calls.push(`applyConstraint:${k}`),
    deleteSelection: () => calls.push('deleteSelection'),
    groupSelectionIntoBlock: () => calls.push('groupSelectionIntoBlock'),
    explodeSelectedBlock: () => calls.push('explodeSelectedBlock'),
    insertInstance: () => calls.push('insertInstance'),
    setBlockScale: (id, scale) => calls.push(`setBlockScale:${id}:${scale}`),
    setBlockRotationDeg: (id, deg) => calls.push(`setBlockRotationDeg:${id}:${deg}`),
  }

  // The REAL document port the tool controller commits through: this is what makes the undo-step
  // assertion below a measurement of the machine rather than of a stub.
  const doc: SketchDocumentPort = {
    getSketch: () => state.sketch,
    ensureSketch: () => state.sketch!,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10,
    getProjectCandidates: () => [],
    getSelection: () => state.selectedIds,
    setSelection: (ids) => { state = { ...state, selectedIds: ids }; notify() },
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: (m) => calls.push(`notice:${m}`),
    beginStep: () => { h.beginStepCalls++ },
    append: (commit, inferred) => {
      h.appendCalls++
      state = {
        ...state,
        sketch: {
          ...state.sketch!,
          entities: [...state.sketch!.entities, ...commit.entities],
          constraints: [...state.sketch!.constraints, ...commit.constraints, ...inferred],
          dimensions: [...state.sketch!.dimensions, ...(commit.dimensions ?? [])],
        },
      }
      notify()
    },
    replace: (next) => {
      h.replaceCalls++
      state = { ...state, sketch: { ...state.sketch!, ...next } }
      notify()
    },
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => state.textEditId,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }

  return Object.assign(h, {
    port, doc,
    set: (patch: Partial<HostState>) => { state = { ...state, ...patch }; notify() },
    state: () => state,
  })
}

let host: FakeHost

beforeEach(() => {
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetSketchClipboardForTest()
  host = makeHost()
  bindSketcherDocument(host.doc)
})

afterEach(() => {
  cleanup()
  bindSketcherDocument(null)
})

const mount = () => render(<SketcherOverlays port={host.port} />)

describe('WO SKC-14C keystone: the package renders the whole sketch UI for a store-free host', () => {
  it('renders NOTHING at rest (no session, no tool)', () => {
    const { container } = mount()
    expect(container.innerHTML).toBe('')
  })

  it('a live session renders the dimension label and the idle prompt bar', () => {
    act(() => host.set({ isSketchActive: true }))
    const { container } = mount()
    // The label text comes from the package's own dimensionDisplay over the fake document.
    expect(container.querySelector('.sketch-dim-label')?.textContent).toContain('10')
    // Idle: no tool armed -> the quiet hint, not a step chip.
    expect(container.querySelector('.sketch-prompt-bar-idle')).not.toBeNull()
  })

  it('the prompt bar narrates the armed tool and its Cancel dispatches into the package', () => {
    act(() => host.set({ isSketchActive: true }))
    mount()
    act(() => sketcherTools.armTool('line'))
    expect(screen.getByText('Line')).toBeTruthy()

    act(() => { fireEvent.click(screen.getByLabelText('Cancel (Esc)')) })
    // Escape with no chain disarms back to select -- package state, no host round-trip.
    expect(sketcherToolStore.getState().tool).toBe('select')
  })

  it('the live-dims overlay appears only while a rect is rubber-banding, with real W/H text', () => {
    act(() => host.set({ isSketchActive: true }))
    const { container } = mount()
    expect(container.querySelector('.sketch-live-dim-layer')).toBeNull()

    // WO-3116 (011daf30a6) gave an AXIS-aligned rectangle the typed W/H editor in the draw
    // bar and suppressed the live-dim labels for it so the two cannot contradict each other.
    // That is the shipped behaviour this repin records; the live labels still own every
    // chain the editor does not describe - a ROTATED rectangle here.
    act(() => {
      sketcherToolStore.setState({
        tool: 'rect-corner',
        chain: { kind: 'rect', mode: 'corner', anchor: { x: 0, y: 0 }, rotated: false },
      })
    })
    expect(container.querySelector('.sketch-live-dim-layer')).toBeNull()

    act(() => {
      sketcherToolStore.setState({
        tool: 'rect-corner',
        chain: { kind: 'rect', mode: 'corner', anchor: { x: 0, y: 0 }, rotated: true },
      })
    })
    expect(container.querySelector('.sketch-live-dim-layer')).not.toBeNull()
    // The surface's cursor is (4,0), so the rubber-banded rect measures W=4, H=0. Asserting the
    // TEXT (not just the layer) is what makes the `anchor` field load-bearing: the first cut of
    // this test named it `first`, rendered an empty layer, and still passed. tsc caught the field;
    // this assertion is what would have caught the emptiness.
    const labels = [...container.querySelectorAll('.sketch-live-dim')]
      .map((el) => el.textContent).filter(Boolean)
    expect(labels).toContain('4')
  })

  it('the confirm overlay appears for a staged fillet batch and Apply commits through the doc port', () => {
    act(() => host.set({
      isSketchActive: true,
      sketch: { ...freshSketch(), entities: [LINE, LINE2] },
    }))
    const { container } = mount()
    // An ARMED fillet with nothing staged shows no overlay: confirmOverlayModel gates on
    // corners.length > 0. (The first cut of this test asserted otherwise and failed -- correctly.)
    act(() => {
      sketcherToolStore.setState({
        tool: 'fillet', chain: { kind: 'fillet', corners: [], pendingLineId: null, pendingClick: null },
      })
    })
    expect(container.querySelector('.sketch-confirm-overlay')).toBeNull()

    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', pendingLineId: null, pendingClick: null,
          corners: [{
            aId: 'l1', bId: 'l2',
            hintA: { x: 5, y: 0 }, hintB: { x: 10, y: 5 }, at: { x: 10, y: 0 },
          }],
        },
      })
    })
    expect(container.querySelector('.sketch-confirm-overlay')).not.toBeNull()
    expect(container.querySelector('.sketch-confirm-title')?.textContent).toBe('Fillet')
    expect(container.querySelector('.sketch-confirm-info')?.textContent).toContain('1 corner staged')

    act(() => { fireEvent.click(getByTooltip('Apply (Enter)')) })
    expect(host.replaceCalls, 'Apply bakes the batch through the document port').toBeGreaterThan(0)
  })

  it('the WYSIWYG text input mounts on an open edit and routes typing to the host', () => {
    act(() => host.set({
      isSketchActive: true,
      sketch: { ...freshSketch(), entities: [LINE, TEXT_ON_PATH] },
    }))
    const { container } = mount()
    expect(container.querySelector('.sketch-text-input')).toBeNull()

    act(() => host.set({ textEditId: 't1' }))
    const input = container.querySelector('.sketch-text-input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('HELLO')

    act(() => { fireEvent.change(input, { target: { value: 'HELLO!' } }) })
    expect(host.calls).toContain('setTextValue:HELLO!')
  })

  it('the anchor pill targets on-path text and its Flip button dispatches to the host', () => {
    act(() => host.set({
      isSketchActive: true,
      sketch: { ...freshSketch(), entities: [LINE, TEXT_ON_PATH] },
      selectedIds: ['t1'],
    }))
    const { container } = mount()
    expect(container.querySelector('.sketch-text-anchor-pill')).not.toBeNull()

    act(() => { fireEvent.click(getByTooltip('Flip the text to the other side of the curve')) })
    expect(host.calls).toContain('setTextPathFlipById:t1:true')
  })

  it('the dimension value editor commits through the host in MILLIMETERS', () => {
    act(() => host.set({ isSketchActive: true, dimEditor: { dimId: 'd1', isNew: false } }))
    const { container } = mount()
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement
    expect(input).not.toBeNull()

    act(() => {
      fireEvent.change(input, { target: { value: '25' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(host.calls).toContain('commitDimensionValue:d1:25')
  })

  // WO UI-26 (A1): the near-geometry popup's Enter-only commit silently
  // discarded a typed value dismissed by clicking away (Operator: "the popup near
  // the fillet doesn't work, only the bottom value area seems to work"). Blur
  // now commits, matching the bottom confirm overlay's live-commit behavior.
  it('the dimension value editor ALSO commits on BLUR (click-away)', () => {
    act(() => host.set({ isSketchActive: true, dimEditor: { dimId: 'd1', isNew: false } }))
    const { container } = mount()
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement
    expect(input).not.toBeNull()

    act(() => {
      fireEvent.change(input, { target: { value: '9' } })
      fireEvent.blur(input)
    })
    expect(host.calls).toContain('commitDimensionValue:d1:9')
  })

  it('Escape then blur cancels: no commit fires, the editor closes exactly once', () => {
    act(() => host.set({ isSketchActive: true, dimEditor: { dimId: 'd1', isNew: false } }))
    const { container } = mount()
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: '9' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)
    })
    expect(host.calls.filter((c) => c.startsWith('commitDimensionValue'))).toEqual([])
    expect(host.calls.filter((c) => c === 'closeDimensionEditor')).toEqual(['closeDimensionEditor'])
  })

  it('a valid Enter commits and self-blurs (no double-commit from its own resolution)', () => {
    act(() => host.set({ isSketchActive: true, dimEditor: { dimId: 'd1', isNew: false } }))
    const { container } = mount()
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: '25' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    // Enter's own explicit inputRef.current?.blur() call (real DOM blur, since
    // the mount effect really focused this input) already ran the onBlur
    // handler once, synchronously, inside this same keydown -- it must not
    // have re-resolved a second time.
    expect(host.calls.filter((c) => c === 'commitDimensionValue:d1:25')).toHaveLength(1)
  })

  // WO UI-26-R1 finding 1 (MAJOR): pre-fix, Enter armed skipBlurCommitRef
  // unconditionally and never blurred itself, so the flag rode into the NEXT
  // real blur -- even one carrying a corrected value -- and swallowed it.
  it('an unparseable Enter leaves the flag UNARMED: the editor stays open and a later corrected click-away commits', () => {
    act(() => host.set({ isSketchActive: true, dimEditor: { dimId: 'd1', isNew: false } }))
    const { container } = mount()
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: 'abc' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(host.calls.filter((c) => c.startsWith('commitDimensionValue'))).toEqual([])

    // The corrected value, typed into the SAME still-open editor, then a
    // genuine click-away.
    act(() => {
      fireEvent.change(input, { target: { value: '12' } })
      fireEvent.blur(input)
    })
    expect(host.calls).toContain('commitDimensionValue:d1:12')
  })

  it('a finite Enter self-blurs even when the host keeps the editor open (rejection shape): the flag resets so a later corrected click-away still commits', () => {
    act(() => host.set({ isSketchActive: true, dimEditor: { dimId: 'd1', isNew: false } }))
    const { container } = mount()
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: '25' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(host.calls.filter((c) => c === 'commitDimensionValue:d1:25')).toHaveLength(1)
    // This fake host never mutates dimEditor/dim.value on commit -- the same
    // shape as a real host REJECTING a finite value while keeping the editor
    // mounted (src/store/index.ts:6147-6163's isFinite/driving/focusDistance
    // guards; workbenchOverlaysPort.ts:221-223's applyWithVerdict returning
    // false). The SAME input stays mounted.
    expect(container.querySelector('input.sketch-dim-input')).toBe(input)

    // Pre-fix, this next block is exactly what a stale-armed flag swallowed:
    // the corrected value's own click-away consumed the LEFTOVER flag from
    // Enter and returned without committing.
    act(() => {
      fireEvent.change(input, { target: { value: '30' } })
      fireEvent.blur(input)
    })
    expect(host.calls).toContain('commitDimensionValue:d1:30')
  })
})

describe('WO SKC-14C keystone: a moved overlay gesture opens EXACTLY ONE undo step', () => {
  // The draw-value box (SketchDrawValueInput) is one of the eight this WO moved. Typing a length
  // mid-draw and pressing Enter runs the REAL tool machine through the REAL document port: it must
  // open one step and append one entity. Two steps here is two Ctrl+Z for one typed value.
  const armLineChain = () => {
    act(() => host.set({ isSketchActive: true }))
    act(() => {
      sketcherToolStore.setState({
        tool: 'line',
        chain: {
          kind: 'line', start: { x: 0, y: 0 }, firstLineId: null,
          prev: { x: 0, y: 0 }, prevLineId: null,
        },
      })
    })
  }

  it('typing a length and pressing Enter opens ONE step and appends ONE entity', () => {
    armLineChain()
    const { container } = mount()
    const input = container.querySelector('.sketch-draw-value input') as HTMLInputElement
    expect(input, 'the draw-value box must be mounted for this to mean anything').not.toBeNull()

    const entitiesBefore = host.state().sketch!.entities.length
    act(() => {
      fireEvent.change(input, { target: { value: '40' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(host.beginStepCalls, 'exactly one undo step per typed value').toBe(1)
    expect(host.appendCalls).toBe(1)
    expect(host.state().sketch!.entities.length).toBe(entitiesBefore + 1)
  })

  // WO UI-26 (A1): the near-cursor draw-value box had the same defect class as
  // the dimension popup -- onBlur only reset flags, never committed. Blur with
  // a valid value now commits, same as Enter.
  it('typing a length and BLURRING (click-away) commits ONE step and ONE entity', () => {
    armLineChain()
    const { container } = mount()
    const input = container.querySelector('.sketch-draw-value input') as HTMLInputElement
    expect(input, 'the draw-value box must be mounted for this to mean anything').not.toBeNull()

    const entitiesBefore = host.state().sketch!.entities.length
    act(() => {
      fireEvent.change(input, { target: { value: '40' } })
      fireEvent.blur(input)
    })

    expect(host.beginStepCalls, 'exactly one undo step per typed value').toBe(1)
    expect(host.appendCalls).toBe(1)
    expect(host.state().sketch!.entities.length).toBe(entitiesBefore + 1)
  })

  it('Escape cancels the draw-value box: the following blur does NOT commit', () => {
    armLineChain()
    const { container } = mount()
    const input = container.querySelector('.sketch-draw-value input') as HTMLInputElement

    const entitiesBefore = host.state().sketch!.entities.length
    act(() => {
      fireEvent.change(input, { target: { value: '40' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)
    })

    expect(host.beginStepCalls).toBe(0)
    expect(host.appendCalls).toBe(0)
    expect(host.state().sketch!.entities.length).toBe(entitiesBefore)
  })

  it('non-vacuity: with no chain the box does not mount, so the test above proves something', () => {
    act(() => host.set({ isSketchActive: true }))
    const { container } = mount()
    expect(container.querySelector('.sketch-draw-value')).toBeNull()
  })
})

describe('WO SKC-14C keystone: the context-menu anchor is PACKAGE state', () => {
  it('sketcherMenuPort.open() mounts the menu; an item dispatches; close() unmounts it', () => {
    act(() => host.set({ isSketchActive: true, selectedIds: ['l1'] }))
    const { container } = mount()
    expect(container.querySelector('.sketch-context-menu')).toBeNull()

    // This is the call the interaction layer makes on a right-click that was not a pan. No mount
    // useState is involved: before this WO, a host held the anchor and rendered the menu itself.
    act(() => sketcherMenuPort.open(10, 20))
    const menu = container.querySelector('.sketch-context-menu') as HTMLElement
    expect(menu).not.toBeNull()
    expect(menu.style.left).toBe('10px')

    const del = screen.queryByText('Delete (Del)')
    expect(del, 'a selection offers Delete').not.toBeNull()
    act(() => { fireEvent.click(del!) })
    expect(host.calls).toContain('deleteSelection')
    // Dispatching an item closes the menu -- through the package's own store.
    expect(container.querySelector('.sketch-context-menu')).toBeNull()

    act(() => sketcherMenuPort.open(10, 20))
    expect(container.querySelector('.sketch-context-menu')).not.toBeNull()
    act(() => sketcherMenuPort.close())
    expect(container.querySelector('.sketch-context-menu')).toBeNull()
  })

  it('a real right-click opens the rendered non-modal menu and Paste lands at that sketch cursor', () => {
    act(() => host.set({ isSketchActive: true, selectedIds: ['l1'] }))
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const sketcherHost: SketcherHost = {
      domElement: canvas,
      container: canvas,
      overlayHost: canvas,
      overlayRoot: new THREE.Group(),
      camera: new THREE.OrthographicCamera(),
      controls: { enableRotate: false },
      clientToPlaneWorld: (x, y) => ({ x, y }),
      worldPerPixel: () => 1,
      saveCameraPose: () => ({}),
      restoreCameraPose: () => {},
      frameNormalToPlane: () => {},
    }
    const sketcher = new Sketcher(sketcherHost)
    sketcher.setDocumentPort(host.doc)
    sketcher.setMenuPort(sketcherMenuPort)
    sketcher.enter()
    sketcher.updateSketch(host.state().sketch)
    sketcherTools.copySelection()
    const { container } = mount()

    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 30, clientY: 40 })
    })
    expect(container.querySelector('.sketch-context-menu')).not.toBeNull()
    const paste = screen.getByText('Paste (Ctrl+V)')
    act(() => { fireEvent.click(paste) })

    expect(container.querySelector('.sketch-context-menu')).toBeNull()
    expect(host.beginStepCalls).toBe(1)
    expect(host.appendCalls).toBe(1)
    const pasted = host.state().sketch?.entities.at(-1)
    if (!pasted || pasted.kind !== 'line') throw new Error('expected pasted line')
    expect({
      x: (pasted.start.x + pasted.end.x) / 2,
      y: (pasted.start.y + pasted.end.y) / 2,
    }).toEqual({ x: 30, y: 40 })
    expect(host.state().selectedIds).toEqual([pasted.id])
    sketcher.dispose()
  })
})

describe('WO SKC-14C keystone: this host is not CAM', () => {
  it('the keystone imports nothing from src/store', () => {
    // The same guarantee sketcherLifecycle.test.ts makes for the tool loop. If this file ever needs
    // the CAM store to render the sketch UI, the extraction did not happen.
    const src = readFileSync(__filename, 'utf8')
    expect(src).not.toMatch(/^\s*import\s[^\n]*\bfrom\s+['"][^'"]*\/store['"]/m)
  })
})
