// @vitest-environment jsdom
//
// PP-SWATCH (POST-MERGE-WORKPLAN.md PP-SELECTION-UTILITY, corrected
// 2026-07-26): the imported-part GeometryProperties action row (data-testid=
// "geo-action-row", shipped PP-UTILITY-S1) was missing the color swatch
// DesignTree.tsx already has for the same imported-part row. This ports the
// existing handleSwatchClick pattern into a SHARED component
// (GeometryColorSwatch.tsx) so both hosts mount the identical control (same
// popup -- the native <input type="color"> picker -- same handlers), not two
// copies of the same click-through-to-hidden-input logic.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (same
// scaffolding as DesignTreeAutoStock.smoke.test.tsx).
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

function seedMeshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-part-1', name: 'Imported Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

function seedAndSelect(over: Partial<ImportedGeometry> = {}) {
  const geo = seedMeshGeo(over)
  act(() => {
    useCamStore.getState().addGeometry(geo)
    useCamStore.getState().setSelectedGeometry(geo.id)
  })
  return geo
}

describe('PP-SWATCH: PropertiesPanel imported-part action row carries the shared color swatch', () => {
  it('renders the swatch on the geo-action-row, alongside Duplicate/Delete', () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    const row = screen.getByTestId('geo-action-row')
    expect(row.querySelector('[data-testid="geo-color-swatch"]')).not.toBeNull()
    // Sanity: it sits in the SAME row as the existing action buttons, not a
    // separate new row (additive, no layout rework).
    expect(row.querySelector('[data-testid="geo-duplicate-btn"]')).not.toBeNull()
  })

  it('clicking the swatch opens the SAME native color-input popup the design tree swatch uses (both click through to a hidden <input type="color">)', () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    const swatch = screen.getByTestId('geo-action-row').querySelector('[data-testid="geo-color-swatch"]') as HTMLElement
    const hiddenInput = screen.getByTestId('geo-action-row').querySelector('[data-testid="geo-color-swatch-input"]') as HTMLInputElement
    expect(hiddenInput.type).toBe('color')
    let clicked = false
    hiddenInput.addEventListener('click', () => { clicked = true })
    fireEvent.click(swatch)
    expect(clicked, 'clicking the swatch must forward the click to the native color-input picker').toBe(true)
  })

  it('changing the color updates the SAME store action (updateGeometryColor) the tree swatch calls', () => {
    const geo = seedAndSelect()
    render(<PropertiesPanel />)
    const hiddenInput = screen.getByTestId('geo-action-row').querySelector('[data-testid="geo-color-swatch-input"]') as HTMLInputElement
    fireEvent.change(hiddenInput, { target: { value: '#ff0000' } })
    const updated = useCamStore.getState().project.geometry.find((g) => g.id === geo.id)
    expect(updated?.color).toBe('#ff0000')
  })

  it('the tree row and the PP row read the SAME store color after either one changes it (shared, not two independent copies)', () => {
    const geo = seedAndSelect()
    render(
      <div>
        <DesignTree />
        <PropertiesPanel />
      </div>,
    )
    // Change via the PP swatch's hidden input.
    const ppInput = screen.getByTestId('geo-action-row').querySelector('[data-testid="geo-color-swatch-input"]') as HTMLInputElement
    fireEvent.change(ppInput, { target: { value: '#00ff00' } })
    const afterPP = useCamStore.getState().project.geometry.find((g) => g.id === geo.id)
    expect(afterPP?.color).toBe('#00ff00')
    // The tree's own swatch for the SAME geometry row reflects the new color
    // too (same store field, same GeometryColorSwatch component -- proving
    // one source of truth, not a PP-local copy). document order: tree first.
    const swatches = document.querySelectorAll('[data-testid="geo-color-swatch"]')
    expect(swatches.length).toBe(2) // one in the tree row, one in the PP row
    for (const s of Array.from(swatches)) {
      expect((s as HTMLElement).style.background).toBe('rgb(0, 255, 0)')
    }
  })
})
