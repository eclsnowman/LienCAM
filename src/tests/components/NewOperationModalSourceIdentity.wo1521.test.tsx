// @vitest-environment jsdom
//
// WO-1521 / BUG-427 (family K12b): the flat "Source geometry" dropdown in
// NewOperationModalBody listed a nest's owned seed copy and the workspace
// original it was deep-copied from as unlabeled twins. `deepCopySeedGeometry`
// (src/store/index.ts) spreads the source row and never touches `name`, so the
// seed and the original share a name and geometry; the dropdown label builder
// never read `ImportedGeometry.ownerNestId`, so the two rows rendered
// byte-identical text and differed only in the invisible `value` uuid.
//
// This mounts the REAL NewOperationModal against the REAL store (Tier 2 desk
// evidence per the work order), seeds one original + its owned seed + the
// NestRecord they belong to, then reads the option labels off
// `op-geometry-select`. No mocks of the label path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() middleware needs a working backend. Install an in-memory
// shim BEFORE the store import (same pattern as NestModal / NewOperationModal
// smoke tests). Pure test scaffolding; no app change.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => mem.set(k, String(v)),
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const ORIGINAL_ID = 'geo-original'
const SEED_ID = 'geo-seed'
const NEST_ID = 'nest-1'
const NEST_NAME = 'Bracket Nest'
const SETUP_ID = 'setup-wo1521'

// A closed-loop profile shared byte-for-byte by the original and the seed --
// exactly the shape deepCopySeedGeometry produces.
function loops() {
  return [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
    { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
    { id: 'loop-c', points: [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
  ]
}

function baseGeometry(id: string, extra: Record<string, unknown> = {}): ImportedGeometry {
  return {
    id,
    name: 'bracket.svg',
    type: 'curves_2d',
    format: 'svg',
    loaded: true,
    loops: loops(),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
    ...extra,
  } as ImportedGeometry
}

function nestRecord() {
  return {
    id: NEST_ID,
    name: NEST_NAME,
    sheet: { width: 600, height: 400 },
    style: 'ninety' as const,
    spacing: { partGap: 2, sheetMargin: 5, windowGap: 2 },
    seed: 1,
    sources: [{ geometryId: ORIGINAL_ID, quantity: 1 }],
    placements: [],
    unplaced: [],
    utilization: 0,
    visible: true,
  }
}

function setupRecord() {
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  return { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
}

// Seed: one workspace original plus its owned seed copy (ownerNestId set) plus
// the NestRecord that owns it. The two geometry rows are the "twins".
function seedProjectWithSeedAndOriginal() {
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [],
      computeOperationToolpath: vi.fn(),
      project: {
        ...s.project,
        geometry: [
          baseGeometry(ORIGINAL_ID),
          baseGeometry(SEED_ID, { ownerNestId: NEST_ID }),
        ],
        nests: [nestRecord()],
        setups: [setupRecord()],
        activeSetupId: SETUP_ID,
      },
    } as never)
  })
}

// Open a brand-new operation and land on the Geometry tab, where the flat
// Source geometry dropdown renders (default op type is contour_2d).
function openGeometryTab() {
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
}

function selectEl(): HTMLSelectElement {
  return screen.getByTestId('op-geometry-select') as HTMLSelectElement
}

function optionText(value: string): string {
  const option = Array.from(selectEl().querySelectorAll('option'))
    .find(o => o.value === value)
  if (!option) throw new Error(`no option for value ${value}`)
  return option.textContent ?? ''
}

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-1521: nest seed identity in the source geometry dropdown', () => {
  it('labels the owned seed with its nest name and leaves the original unlabeled', () => {
    seedProjectWithSeedAndOriginal()
    render(<NewOperationModal />)
    openGeometryTab()

    const originalText = optionText(ORIGINAL_ID)
    const seedText = optionText(SEED_ID)

    // Acceptance 1: the two twins are visibly distinct; the nest name appears
    // on the seed's row.
    expect(seedText).toContain(NEST_NAME)
    expect(seedText).toContain('seed of')
    expect(originalText).not.toContain(NEST_NAME)

    // Acceptance 2: the unowned original renders exactly as today.
    expect(originalText).toBe('bracket.svg (3 closed loops)')

    // The two rows now read as distinct text (the bug was byte-identical).
    expect(seedText).not.toBe(originalText)

    // The value uuids remain the seat of identity: picking each selects it.
    fireEvent.change(selectEl(), { target: { value: SEED_ID } })
    expect(selectEl().value).toBe(SEED_ID)
    fireEvent.change(selectEl(), { target: { value: ORIGINAL_ID } })
    expect(selectEl().value).toBe(ORIGINAL_ID)
  })

  it('annotates a nest-owned seed on the STL-chain label branch too', () => {
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({
        project: {
          ...s.project,
          geometry: [
            { ...baseGeometry('stl-original'), type: 'mesh', format: 'stl', name: 'part.stl' },
            { ...baseGeometry(SEED_ID), type: 'mesh', format: 'stl', name: 'part.stl', ownerNestId: NEST_ID },
          ],
          nests: [nestRecord()],
          setups: [setupRecord()],
          activeSetupId: SETUP_ID,
        },
      } as never)
    })
    render(<NewOperationModal />)
    openGeometryTab()

    expect(optionText('stl-original')).not.toContain(NEST_NAME)
    expect(optionText(SEED_ID)).toContain(NEST_NAME)
  })

  it('annotates a nest-owned seed on the modeled-body label branch too', () => {
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({
        project: {
          ...s.project,
          geometry: [
            { ...baseGeometry('model-original'), type: 'model', format: 'model', name: 'Body' },
            { ...baseGeometry(SEED_ID), type: 'model', format: 'model', name: 'Body', ownerNestId: NEST_ID },
          ],
          nests: [nestRecord()],
          setups: [setupRecord()],
          activeSetupId: SETUP_ID,
        },
      } as never)
    })
    render(<NewOperationModal />)
    openGeometryTab()

    expect(optionText('model-original')).not.toContain(NEST_NAME)
    expect(optionText(SEED_ID)).toContain(NEST_NAME)
  })
})
