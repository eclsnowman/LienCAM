// @vitest-environment jsdom
//
// WO-337: "show me where the zero will land, before I confirm it" - a point
// marker in the viewport at the exact confirmed origin. WO-366 supersedes the
// old face-hover default: a cylinder click now presents Top/Bottom in the
// workspace and the operator explicitly confirms one.
//
// Attempt 1 shipped this by adding a 4th `onHover` parameter to
// setBrepPickMode - but the app's REAL viewport class
// (src/components/viewport/CNCViewport.ts) overrides setBrepPickMode with a
// 3-parameter signature and forwards only 3 args to super, so that argument
// was silently dropped and the hover preview never fired in the shipped app
// (audit finding, both rounds: EVIDENCE src/components/viewport/CNCViewport.ts:109).
// TypeScript cannot catch a narrower override, and the attempt's own test
// double implemented the 4-arg signature itself, so the slice could not fail
// on the defect either.
//
// This round closes the wiring a different way: setBrepPickHoverCallback is
// a BRAND NEW method on the base viewport (src/lib/viewport/CNCViewport.ts),
// set separately from setBrepPickMode rather than as a positional argument
// on it. The app's subclass has no override of this new method to drop
// anything from - it is inherited untouched. Two things prove that below:
// (1) the SetupModal-level behaviour tests drive a double whose
// setBrepPickMode has the REAL 3-parameter shape (matching the production
// override, not a fictional 4-arg one), so hover wiring can only reach the
// double through the separate method; (2) the last test constructs the REAL
// production subclass itself (not a hand-written double of it) and proves
// the callback reaches the base class's field through actual prototype
// resolution.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelItemPlacementRecord, Vec3 } from '../../types'
import { deriveModelBodyCircularOrigin } from '../../lib/cam/modelBodyDerive'
import {
  setModelBodyFaceSnapshotReader,
  setModelBodyHoleRecognizer,
} from '../../lib/cam/modelBodyHoleRecognition'
import { CNCViewport as ProductionCNCViewport } from '../../components/viewport/CNCViewport'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memStorage,
  configurable: true,
})

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')

// -- Fixtures (mirrors boreOriginBinding.wo294.test.ts's own known-good bore) --

const geo = {
  id: 'modelbody:F1', name: 'Plate', filename: '', type: 'model', format: 'model',
  loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
  modelItemId: 'legacy',
  modelBody: {
    ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 },
    // WO-337: the ONE extra fact SetupModal's own resolveBoreFaceOwner needs
    // that resolveSetupBoreOriginPick itself never reads directly - the
    // index -> stable-id map a real viewport pick reports through.
    display: { faceIds: ['F1:wall'] },
  },
} as unknown as ImportedGeometry

const placements: ModelItemPlacementRecord[] = [{
  modelItemId: 'legacy',
  position: { x: 5, y: -2, z: 7 },
  rotation: { x: 0, y: 0, z: 0 },
}]

function hole(): FeatureVerdict {
  return {
    featureKey: 'hole:10:12:10:0:0:1:4',
    featureClass: 'blindHole', removable: true, effect: 'add',
    faceIds: ['F1:wall'], neighbourIds: [],
    params: {
      diameter: 8, depth: 6,
      axisX: 0, axisY: 0, axisZ: 1,
      centerX: 10, centerY: 12, centerZ: 10,
    },
  }
}

function snapshot(): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: [10, 12, 7], normal: [1, 0, 0], area: 150,
    axis: [0, 0, 1], axisPoint: [10, 12, 0], radius: 4,
  }
}

// The real derive, called directly here only to PROVE the expected numbers -
// production code (SetupModal) calls this exact function too, so a change to
// either drifts this test rather than silently agreeing with itself.
const expectedEnds = deriveModelBodyCircularOrigin(geo, placements, 'F1:wall', snapshot(), [hole()])
const TOP: Vec3 = { x: expectedEnds.center[0], y: expectedEnds.center[1], z: expectedEnds.topZ }
const BOTTOM: Vec3 = { x: expectedEnds.center[0], y: expectedEnds.center[1], z: expectedEnds.bottomZ }

type Sel = { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean }
const FACE_SEL: Sel = { geoId: 'modelbody:F1', kind: 'face', index: 0, isModelFace: true }

let pickCallback: ((sel: Sel, nowSelected: boolean) => void) | null = null
let hoverCallback: ((sel: Sel | null) => void) | null = null
let choiceCallback: ((id: string) => void) | null = null
let zeroPointPreview: ReturnType<typeof vi.fn>
let zeroPointChoices: ReturnType<typeof vi.fn>
let setWCSOrigin: ReturnType<typeof vi.fn>

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function openBorePicker() {
  render(<SetupModal />)
  act(() => { useCamStore.getState().openModal('new-setup') })
  fireEvent.click(screen.getByTestId('setup-origin-mode-bore'))
  fireEvent.click(screen.getByRole('button', { name: /pick circle \/ cylinder/i }))
  await flush()
}

async function pickBore(end: 'top' | 'bottom' = 'top') {
  await openBorePicker()
  act(() => { pickCallback?.(FACE_SEL, true) })
  await flush()
  act(() => { choiceCallback?.(end) })
  await flush()
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  pickCallback = null
  hoverCallback = null
  choiceCallback = null
  zeroPointPreview = vi.fn()
  setWCSOrigin = vi.fn()
  zeroPointChoices = vi.fn((
    choices: readonly { id: string; label: string; position: Vec3 }[] | null,
    onSelect?: ((id: string) => void) | null,
  ) => {
    choiceCallback = choices ? (onSelect ?? null) : null
  })
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 50, z: 12 } }),
    setWCSOrigin,
    exitStockCornerPickMode: vi.fn(),
    exitWCSGizmoMode: vi.fn(),
    exitVertexPickMode: vi.fn(),
    // Matches the REAL production signature (3 params, no onHover argument) -
    // the exact shape src/components/viewport/CNCViewport.ts's override
    // forwards to its base class. A double with a 4th argument here could
    // not have failed on the attempt-1 defect; this one cannot make that
    // mistake because there is nothing to add a 4th argument to.
    setBrepPickMode: (
      kind: 'face' | 'edge' | 'face-or-edge' | null,
      callback?: ((sel: Sel, nowSelected: boolean) => void) | null,
      _allowedGeoId?: string | null,
    ) => {
      if (kind) {
        pickCallback = callback ?? null
      } else {
        pickCallback = null
        hoverCallback = null
      }
    },
    // The separate seam hover wiring travels through - unaffected by any
    // setBrepPickMode override, real or double.
    setBrepPickHoverCallback: (onHover: ((sel: Sel | null) => void) | null) => {
      hoverCallback = onHover
    },
    setZeroPointPreview: zeroPointPreview,
    setZeroPointChoices: zeroPointChoices,
  }
  useCamStore.setState((state) => ({
    activeModal: null,
    editingSetupId: null,
    project: {
      ...state.project,
      stocks: [],
      geometry: [geo],
      setups: [],
      modelItemPlacements: placements,
    },
  }))
  setModelBodyFaceSnapshotReader(async () => snapshot())
  setModelBodyHoleRecognizer(async () => [hole()])
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  setModelBodyFaceSnapshotReader(null)
  setModelBodyHoleRecognizer(null)
})

describe('WO-337: zero-point preview marker', () => {
  it('proves the fixture: the bore resolves to a real top rim above a real bottom', () => {
    // Sanity on the fixture itself, not the feature under test - if this ever
    // fails, the TOP/BOTTOM constants below are meaningless.
    expect(TOP.z).toBeGreaterThan(BOTTOM.z)
    expect(TOP.x).toBe(BOTTOM.x)
    expect(TOP.y).toBe(BOTTOM.y)
  })

  it('hovering a cylinder does not silently preselect either end', async () => {
    await openBorePicker()
    expect(hoverCallback).not.toBeNull()

    act(() => { hoverCallback?.(FACE_SEL) })
    await flush()

    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
  })

  it('a cylinder click presents both workspace points before either end is confirmed', async () => {
    await openBorePicker()
    act(() => { pickCallback?.(FACE_SEL, true) })
    await flush()

    expect(zeroPointChoices).toHaveBeenLastCalledWith([
      { id: 'top', label: 'TOP', position: TOP },
      { id: 'bottom', label: 'BOTTOM', position: BOTTOM },
    ], expect.any(Function))
    expect(screen.getByTestId('setup-bore-pick-status').textContent).toMatch(/Choose TOP or BOTTOM/i)
    expect(screen.queryByTestId('setup-bore-picked')).toBeNull()
  })

  it('clicking the TOP workspace target confirms that exact point', async () => {
    await pickBore('top')
    expect(screen.getByTestId('setup-bore-picked')).not.toBeNull()
    expect(setWCSOrigin).toHaveBeenLastCalledWith(TOP, 'G54')
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
  })

  it('clicking the BOTTOM workspace target confirms the bottom without a modal correction', async () => {
    await pickBore('bottom')
    expect(screen.getByTestId('setup-bore-end-bottom').className).toMatch(/wcs-face-active/)
    expect(setWCSOrigin).toHaveBeenLastCalledWith(BOTTOM, 'G54')
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId('setup-bore-picked').textContent).toMatch(
      new RegExp(`Z ${BOTTOM.z.toFixed(3)}`),
    )
  })

  it('switching Top/Bottom moves the shared WCS marker without restoring the temporary preview', async () => {
    await pickBore()
    zeroPointPreview.mockClear()
    setWCSOrigin.mockClear()

    fireEvent.click(screen.getByTestId('setup-bore-end-bottom'))
    expect(setWCSOrigin).toHaveBeenLastCalledWith(BOTTOM, 'G54')
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId('setup-bore-picked').textContent).toMatch(
      new RegExp(`Z ${BOTTOM.z.toFixed(3)}`),
    )

    zeroPointPreview.mockClear()
    setWCSOrigin.mockClear()
    fireEvent.click(screen.getByTestId('setup-bore-end-top'))
    expect(setWCSOrigin).toHaveBeenLastCalledWith(TOP, 'G54')
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId('setup-bore-picked').textContent).toMatch(
      new RegExp(`Z ${TOP.z.toFixed(3)}`),
    )
  })

  it('the explicitly selected Top remains active and the modal override stays available', async () => {
    await pickBore('top')
    expect(screen.getByTestId('setup-bore-end-top').className).toMatch(/wcs-face-active/)
    expect(screen.getByTestId('setup-bore-end-bottom').className).not.toMatch(/wcs-face-active/)
    expect(screen.getByTestId('setup-bore-picked').textContent).toMatch(/Z0 top/)
  })

  it('cancelling a re-pick reverts the marker to the last CONFIRMED end, not the hover it interrupted', async () => {
    await pickBore()
    fireEvent.click(screen.getByTestId('setup-bore-end-bottom'))
    expect(setWCSOrigin).toHaveBeenLastCalledWith(BOTTOM, 'G54')

    // Re-pick the cylinder, reach the Top/Bottom choice stage, then cancel.
    fireEvent.click(screen.getByRole('button', { name: /re-pick circle \/ cylinder/i }))
    await flush()
    act(() => { pickCallback?.(FACE_SEL, true) })
    await flush()
    expect(screen.getByTestId('setup-bore-pick-status').textContent).toMatch(/Choose TOP or BOTTOM/i)

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('setup-bore-pick-banner')).toBeNull()
    // The WCS remains at the confirmed BOTTOM while temporary hover guidance clears.
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
  })

  it('clears the marker when the origin mode tab switches away from Circular Center', async () => {
    await pickBore()
    zeroPointPreview.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
  })

  it('hovering a non-bore face stays silent (no error banner) and does not strand a stale marker', async () => {
    await openBorePicker()
    act(() => { hoverCallback?.({ geoId: 'modelbody:F1', kind: 'face', index: 0, isModelFace: false }) })
    await flush()
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
    expect(screen.queryByTestId('setup-bore-pick-error')).toBeNull()
  })

  it('clears the marker when the modal is closed without saving', async () => {
    await pickBore()
    zeroPointPreview.mockClear()

    const closeBtn = document.querySelector('.modal-close-btn') as HTMLElement
    expect(closeBtn).not.toBeNull()
    fireEvent.click(closeBtn)
    expect(zeroPointPreview).toHaveBeenLastCalledWith(null)
  })
})

// The exact seam attempt 1 broke: setBrepPickMode's app-side override
// (src/components/viewport/CNCViewport.ts) has a fixed 3-parameter
// signature and forwards exactly 3 args to super, so ANYTHING passed as a
// 4th positional argument is silently discarded there - a defect
// TypeScript's structural typing cannot see (a narrower override is
// assignable to a wider base method). This suite drives the REAL subclass
// (not a hand-written double of it, which is what let the attempt-1 defect
// through both gates) to prove the fix's actual seam - a method the
// subclass never touches - is not subject to that trap.
describe('WO-337: setBrepPickHoverCallback reaches the real production CNCViewport subclass', () => {
  it('is inherited untouched by the subclass and stores the callback on the base class field, unlike a 4th setBrepPickMode argument would have been', () => {
    // Object.create(prototype) skips the constructor (no WebGL/renderer
    // needed) while keeping the REAL prototype chain - same technique
    // src/tests/components/CNCViewportModelEdgePick.wo113.test.ts already
    // uses to drive this exact subclass's real methods.
    const viewport = Object.create(ProductionCNCViewport.prototype) as ProductionCNCViewport
    Object.assign(viewport, {
      renderer: {
        domElement: {
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      },
    })
    const hoverCb = vi.fn()

    // Exercises the subclass's REAL setBrepPickMode override (3 params,
    // forwards 3 to super) - unchanged by this WO, on purpose.
    viewport.setBrepPickMode('face', () => undefined, null)
    // setBrepPickHoverCallback exists ONLY on the base class - the subclass
    // has no override of it, so this call resolves straight through the
    // prototype chain to src/lib/viewport/CNCViewport.ts's real method.
    viewport.setBrepPickHoverCallback(hoverCb)

    expect((viewport as unknown as { brepPickHoverCallback: unknown }).brepPickHoverCallback).toBe(hoverCb)
  })
})
