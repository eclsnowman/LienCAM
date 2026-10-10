// @vitest-environment jsdom
//
// WO-1535 (BUG-455, BUG-461): the Section-at-Z panel used to compute its own
// copy of the Z range (translation-only offset over the body's UNROTATED
// local bbox) and a static "Exact solid cross-section" claim, instead of
// deferring to the same rotation-aware frame resolution deriveModelBodySection
// itself uses. Both facts came from the same block in NewOperationModalBody -
// this file pins the fix: a tilted model item shows an explicit
// unsupported-orientation state (never the old translation-only bounds), an
// upright model item's precision wording says mesh-derived, and the STEP/brep
// path keeps its unchanged exact wording.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ImportedGeometry, Setup } from '../../types'

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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const MODEL_ID = 'modelbody:F1'
const BREP_ID = 'brep:P1'

function baseSetup(): Setup {
  return {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
    operations: [],
    notes: '',
  } as unknown as Setup
}

// The model row's OWN position/rotation stay identity (INT-17C: a model-origin
// row never carries its world pose directly) - the real pose lives in the
// Placement record, matched here to BUG-461's repro (position (40,-15,12),
// rotation (20,0,60) deg - a genuine X/Y tilt, not just an in-plane spin).
function seedTiltedModel() {
  const geometry = [{
    id: MODEL_ID,
    name: 'Model F1',
    type: 'model',
    format: 'model',
    filename: 'Model F1',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 } },
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  }] as unknown as ImportedGeometry[]

  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry,
      setups: [baseSetup()],
      activeSetupId: 'setup-1',
      modelItemPlacements: [{
        modelItemId: 'legacy',
        bodyId: 'F1',
        position: { x: 40, y: -15, z: 12 },
        rotation: { x: 20, y: 0, z: 60 },
      }],
    },
  })
}

// Upright: Z-only rotation. A pure Z rotation never moves a point's Z, so
// deriveModelBodySection would NOT refuse this one - the readout should show
// a real (translation-correct) range, worded as mesh-derived.
function seedUprightModel() {
  const geometry = [{
    id: MODEL_ID,
    name: 'Model F1',
    type: 'model',
    format: 'model',
    filename: 'Model F1',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 } },
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  }] as unknown as ImportedGeometry[]

  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry,
      setups: [baseSetup()],
      activeSetupId: 'setup-1',
      modelItemPlacements: [{
        modelItemId: 'legacy',
        bodyId: 'F1',
        position: { x: 0, y: 0, z: 12 },
        rotation: { x: 0, y: 0, z: 45 },
      }],
    },
  })
}

function seedBrep() {
  const geometry = [{
    id: BREP_ID,
    name: 'Part P1',
    filename: 'P1.step',
    type: 'brep',
    format: 'step',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  }] as unknown as ImportedGeometry[]

  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry,
      setups: [baseSetup()],
      activeSetupId: 'setup-1',
    },
  })
}

afterEach(() => {
  cleanup()
})

function openContourAndSelect(geoId: string) {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('2D Contour'))
  fireEvent.click(screen.getByText('Geometry'))
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: geoId } })
}

describe('WO-1535: Section-at-Z readout matches the derive function it defers to', () => {
  beforeEach(() => {
    act(() => { useCamStore.getState().newProject() })
  })

  it('BUG-461 / WO-1543: a tilted model item shows the placed body\'s real world Z range, not translation-only bounds', () => {
    seedTiltedModel()
    openContourAndSelect(MODEL_ID)

    const hint = screen.getByTestId('brep-section-range-hint')
    // Old bug: local bbox z (0..20) + position.z (12) = "12 .. 32", ignoring
    // the (20,0,60) tilt entirely. That number must never appear again.
    expect(hint.textContent).not.toMatch(/12(\.0+)?\s*\.\.\s*32/)
    // WO-1543: Section at Z no longer refuses a tilted body, so the hint shows
    // the placed range: the 0..20 cube's corners under Rx(20) Ry(0) Rz(60),
    // lifted by 12, span Z 12 .. 12 + 20 * (sin20 sin60 + sin20 cos60 + cos20).
    const s20 = Math.sin(Math.PI / 9), c20 = Math.cos(Math.PI / 9)
    const top = 12 + 20 * (s20 * Math.sin(Math.PI / 3) + s20 * Math.cos(Math.PI / 3) + c20)
    const m = hint.textContent!.match(/Z range:\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeCloseTo(12, 2)
    expect(Number(m![2])).toBeCloseTo(top, 2)
    expect(hint.textContent).not.toMatch(/unavailable|refuse/i)
    expect(hint.textContent).toMatch(/mesh-derived/i)
  })

  it('BUG-455: an upright model-section source shows mesh-derived wording, not "Exact solid cross-section"', () => {
    seedUprightModel()
    openContourAndSelect(MODEL_ID)

    const hint = screen.getByTestId('brep-section-range-hint')
    expect(hint.textContent).toMatch(/mesh-derived/i)
    expect(hint.textContent).not.toMatch(/Exact solid cross-section/)
    // Z-only rotation never moves Z: local 0..20 + position.z (12) = 12..32,
    // and this placement is not tilted, so the real range is still shown.
    expect(hint.textContent).toMatch(/Z range:/)
  })

  it('regression: the STEP/brep Section-at-Z path keeps its "Exact solid cross-section" wording', () => {
    seedBrep()
    openContourAndSelect(BREP_ID)

    const hint = screen.getByTestId('brep-section-range-hint')
    expect(hint.textContent).toMatch(/Exact solid cross-section/)
  })
})
