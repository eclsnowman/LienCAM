// @vitest-environment jsdom
//
// WO-1425: switching the Snap-origin tab used to read `origin.x/y/z` (a draft
// value carried over from whatever mode was active before Snap) as evidence a
// pick had happened. An inherited nonzero corner/manual origin made the panel
// claim "Picked (no tracking)" the instant Snap was selected, before
// handleStartVertexPick ever ran. These tests drive the rendered SetupModal
// through Snap-tab switching and real picks to prove the panel now tracks an
// actual pick, not leftover coordinates.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoundingBox, PhysicalStock, Setup, Vec3 } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock: PhysicalStock = {
  id: 'stock-a',
  name: 'Stock A',
  mode: 'explicit',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }),
  position: { x: 0, y: 0, z: 0 },
}

// A setup whose ORIGIN MODE is 'corner' but whose stored origin is nonzero -
// the exact leftover-coordinate shape BUG-468 misread as a Snap pick.
const cornerSetup: Setup = {
  id: 'setup-corner',
  name: 'Setup corner',
  wcs: {
    id: 'wcs-setup-corner',
    label: 'G54',
    fixtureOffset: 54,
    origin: { x: -30, y: -30, z: 25 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    stockId: 'stock-a',
    cornerRow: 2,
    cornerCol: 0,
    cornerFace: 'top',
    originBinding: {
      kind: 'stock_corner',
      stockId: 'stock-a',
      cornerRow: 2,
      cornerCol: 0,
      cornerFace: 'top',
    },
  },
  stock: {
    type: 'rectangular',
    offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0,
    material: 'wood',
  },
  operations: [],
  notes: '',
}

let vertexPickCallback: ((result: { pos: Vec3; geoId?: string; localPt?: Vec3 }) => void) | null = null

beforeEach(() => {
  vertexPickCallback = null
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 12 } }),
    setWCSOrigin: () => {},
    exitWCSGizmoMode: () => {},
    exitStockCornerPickMode: () => {},
    enterVertexPickMode: (cb: NonNullable<typeof vertexPickCallback>) => { vertexPickCallback = cb },
    exitVertexPickMode: () => { vertexPickCallback = null },
  }
  useCamStore.setState((state) => ({
    activeModal: null,
    editingSetupId: null,
    project: {
      ...state.project,
      stocks: [stock],
      geometry: [{ id: 'geo-tracked', name: 'Boss A', stockId: 'stock-a' }] as unknown as typeof state.project.geometry,
      setups: [cornerSetup],
    },
  }))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-1425 snap-origin pick provenance', () => {
  it('shows no picked-point message when Snap is selected with only an inherited origin', () => {
    render(<SetupModal />)
    act(() => {
      useCamStore.setState({ activeModal: 'edit-setup', editingSetupId: 'setup-corner' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))

    expect(document.querySelector('.wcs-snap-picked')).toBeNull()
  })

  it('shows Tracking: <name> after a real pick resolves to live geometry', () => {
    render(<SetupModal />)
    act(() => {
      useCamStore.setState({ activeModal: 'edit-setup', editingSetupId: 'setup-corner' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))
    fireEvent.click(screen.getByRole('button', { name: /Pick Vertex/ }))

    act(() => {
      vertexPickCallback?.({ pos: { x: 10, y: 20, z: 5 }, geoId: 'geo-tracked', localPt: { x: 0, y: 0, z: 0 } })
    })

    // WO-1427: a plain vertex pick captures no sketch-entity identity, so it is disclosed as a fixed point
    // on its part (follows placement, not later shape edits) - never as live tracking.
    expect(screen.getByText(/Fixed point on Boss A/)).not.toBeNull()
    expect(document.querySelectorAll('.wcs-snap-picked')).toHaveLength(1)
  })

  it('shows Picked (no tracking) with coordinates after a real pick resolves to no live geometry', () => {
    render(<SetupModal />)
    act(() => {
      useCamStore.setState({ activeModal: 'edit-setup', editingSetupId: 'setup-corner' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))
    fireEvent.click(screen.getByRole('button', { name: /Pick Vertex/ }))

    act(() => {
      vertexPickCallback?.({ pos: { x: 11, y: 22, z: 3 }, geoId: undefined, localPt: undefined })
    })

    expect(screen.getByText(/Picked \(no tracking\)/)).not.toBeNull()
    expect(document.querySelectorAll('.wcs-snap-picked')).toHaveLength(1)
  })
})
