// @vitest-environment jsdom
//
// React-render SMOKE test for the N1a "nest as a folder-like node INSIDE the
// Geometry section" change. The repo's vitest env is 'node' by default
// (vite.config.ts); the directive above flips THIS file to jsdom so a real React
// tree can mount.
//
// WHY THIS GATE EXISTS: a hooks-order bug ("Rendered more hooks than during the
// previous render") shipped once in a modal because a hook sat below an early
// return and tsc + the pure-logic vitest suite did not catch it. The render-gate
// rule (feedback_render_gate_ui_changes) requires a React MOUNT test for UI
// changes. This file mounts the DesignTree with a nest present, exercising the
// renderNestFolderRow path that tsc cannot see, and locks the structural moves:
// the New Nest launcher now lives in the Geometry header (tree-new-nest-geo) and
// the old standalone Nests section (tree-new-nest) is gone.
// Harness copied from DesignTreeAutoStock.smoke.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Pure test
// scaffolding; no app change.
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

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

// The store is a process singleton; reset to a clean project before each test so
// the tests are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
  })
})

// Seed one geometry (so its name resolves as a nest source child) plus one
// NestRecord with one source and one placement (so the summary renders). The
// record is pushed straight into project.nests via setState — no worker, no
// dispatch — which is the already-ready first-render path.
function seedGeometryAndNest() {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g-nest', name: 'NestPart', filename: 'p.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [
          ...(s.project.nests ?? []),
          {
            id: 'nest-1',
            name: 'Nest A',
            sheet: { width: 100, height: 100 },
            style: 'ninety',
            spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
            seed: 1,
            sources: [{ geometryId: 'g-nest', quantity: 3 }],
            placements: [
              { partId: 'g-nest', instanceId: 'g-nest#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
            ],
            unplaced: [],
            utilization: 0.42,
            computeTimeMs: 12,
          },
        ],
      },
    }))
  })
}

describe('DesignTree nest-as-folder-node render smoke (N1a)', () => {
  it('mounts without throwing when a nest is present (hooks-order guard)', () => {
    seedGeometryAndNest()
    // The render path includes renderNestFolderRow; a hooks-order regression
    // would throw here. The plain mount is the gate tsc cannot provide.
    expect(() => render(<DesignTree />)).not.toThrow()
  })

  it('shows the New Nest launcher in the Geometry header (tree-new-nest-geo)', () => {
    render(<DesignTree />)
    expect(screen.getByTestId('tree-new-nest-geo')).not.toBeNull()
  })

  it('renders the nest node by name inside the tree', () => {
    seedGeometryAndNest()
    render(<DesignTree />)
    expect(screen.getByText('Nest A')).not.toBeNull()
  })

  it('no longer renders the standalone Nests section add button (tree-new-nest)', () => {
    render(<DesignTree />)
    // The old standalone "Nests" section header + its add button are gone; the
    // launcher moved into the Geometry header.
    expect(screen.queryByTestId('tree-new-nest')).toBeNull()
  })

  it('renders the Explode (Ungroup) action button on the nest row (nest-explode)', () => {
    seedGeometryAndNest()
    render(<DesignTree />)
    // N1c: the nest row carries an Explode action before the Trash button.
    expect(screen.getByTestId('nest-explode')).not.toBeNull()
  })

  it('row Explode removes the nest without prompting and Undo restores it', () => {
    seedGeometryAndNest()
    render(<DesignTree />)
    fireEvent.click(screen.getByTestId('nest-explode'))
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(0)
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.map((nest) => nest.id)).toEqual(['nest-1'])
  })

  it('row Delete removes the nest without prompting and Undo restores it', () => {
    seedGeometryAndNest()
    const { container } = render(<DesignTree />)
    const deleteButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('data-tooltip') === 'Remove nest')
    expect(deleteButton).toBeDefined()
    fireEvent.click(deleteButton!)
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(0)
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.map((nest) => nest.id)).toEqual(['nest-1'])
  })

  it('reveals a source child (part name) after expanding the nest node', () => {
    seedGeometryAndNest()
    render(<DesignTree />)
    // Default-expanded, so the source child name should be present immediately.
    // Both the nest node and the source child can surface "NestPart" — use a
    // getAllBy to assert at least the source-child row rendered.
    expect(screen.getAllByText('NestPart').length).toBeGreaterThanOrEqual(1)
    // The quantity badge for the source.
    expect(screen.getByText('x3')).not.toBeNull()
  })
})

// ── N1b: seed badge (ADR 0025 §2) ────────────────────────────────────────────
// A geometry referenced by a nest is a SEED; its geometry row carries a seed
// badge and the nest's source-child row carries one too. A geometry NOT
// referenced by any nest must NOT carry a seed badge.

describe('DesignTree seed badge render smoke (N1b)', () => {
  it('shows a seed badge on the geometry row of a nest-referenced part', () => {
    seedGeometryAndNest()
    render(<DesignTree />)
    // The geometry-row badge (renderGeoBlock). g-nest is a nest source -> seed.
    expect(screen.getAllByTestId('seed-badge-geo').length).toBeGreaterThanOrEqual(1)
  })

  it('shows a seed badge on the nest source-child row', () => {
    seedGeometryAndNest()
    render(<DesignTree />)
    // The nest folder is default-expanded, so the source child row renders.
    expect(screen.getAllByTestId('seed-badge-nest-child').length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT show a seed badge for a geometry no nest references', () => {
    act(() => {
      // A standalone part with no nest referencing it -> not a seed.
      useCamStore.getState().addGeometry({
        id: 'g-free', name: 'FreePart', filename: 'f.stl', type: 'mesh', format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
          size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      })
    })
    render(<DesignTree />)
    // No nests at all -> no seed badge anywhere.
    expect(screen.queryByTestId('seed-badge-geo')).toBeNull()
    expect(screen.queryByTestId('seed-badge-nest-child')).toBeNull()
  })
})

// ── Deep-copy seed model: owned-seed suppression (ADR 0025 §2) ───────────────
// Under the deep-copy model the nest references an OWNED SEED copy (a geometry
// with ownerNestId set), NOT the original. That copy lives ONLY inside the nest:
// suppressed from every standalone root/folder row, surfaced ONLY as the nest's
// child row. A pre-existing workspace original carries NO ownerNestId and is no
// longer a nest source -> it is an ordinary root row with NO seed badge (P5a).

function seedPreExistingAndOwned() {
  act(() => {
    // Pre-existing workspace part, NOT referenced by any nest (the nest references
    // its own deep copy). It must render as a plain root row with NO seed badge.
    useCamStore.getState().addGeometry({
      id: 'g-pre', name: 'PreExistingPart', filename: 'pre.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    // The nest's OWNED SEED copy (ownerNestId set). A geometry entry, but it must
    // NOT surface as a standalone root row — only as the nest child.
    useCamStore.getState().addGeometry({
      id: 'g-owned', name: 'OwnedSeed', filename: 'owned.stl', type: 'mesh', format: 'stl',
      ownerNestId: 'nest-seed',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [
          ...(s.project.nests ?? []),
          {
            id: 'nest-seed',
            name: 'Seed Nest',
            sheet: { width: 100, height: 100 },
            style: 'ninety' as const,
            spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
            seed: 1,
            // The nest references the OWNED SEED copy only.
            sources: [
              { geometryId: 'g-owned', quantity: 2 },
            ],
            placements: [
              { partId: 'g-owned', instanceId: 'g-owned#0', x: 20, y: 0, rotationDeg: 0, depth: 0 },
            ],
            unplaced: [],
            utilization: 0.5,
            computeTimeMs: 10,
          },
        ],
      },
    }))
  })
}

describe('DesignTree owned-seed suppression render smoke (deep-copy seed model)', () => {
  it('renders the PRE-EXISTING part as a root row with NO seed badge (P5a)', () => {
    seedPreExistingAndOwned()
    render(<DesignTree />)
    // The pre-existing part is no longer a nest source, so it carries no seed
    // badge — it is a plain root row.
    expect(screen.getAllByText('PreExistingPart').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByTestId('seed-badge-geo')).toBeNull()
  })

  it('does NOT render the OWNED SEED copy as a standalone root row', () => {
    seedPreExistingAndOwned()
    render(<DesignTree />)
    // The owned seed is suppressed from standalone rendering: it never gets a
    // standalone seed badge. The only place its name appears is the nest child.
    expect(screen.queryByTestId('seed-badge-geo')).toBeNull()
  })

  it('renders the OWNED SEED as a nest child row', () => {
    seedPreExistingAndOwned()
    render(<DesignTree />)
    // Nest is default-expanded: the owned seed surfaces as a child row with a
    // nest-child seed badge.
    expect(screen.getAllByTestId('seed-badge-nest-child').length).toBe(1)
    expect(screen.getAllByText('OwnedSeed').length).toBeGreaterThanOrEqual(1)
  })
})

// ── Seed selectable + layer eyes (this pass) ─────────────────────────────────
// The nest seed child row (the owned-seed geometry) is SELECTABLE (clicking it
// sets viewer.selectedGeometryId to the seed id) and EXPANDABLE to per-layer
// VISIBILITY rows. Clicking a layer eye flips that layer's visible flag via
// updateGeometryLayer/toggleGeometryLayer (store truth). The owned seed here is a
// 2D geometry with ownerNestId + layers2d + loops so the layer rows render.

function seedOwnedWithLayers() {
  act(() => {
    // Owned-seed copy: a 2D (dxf) geometry with two layers + one loop each, so
    // the seed child expands to two layer rows with visibility eyes.
    useCamStore.getState().addGeometry({
      id: 'g-seed2d', name: 'SeedSketch', filename: 'seed.dxf', type: 'curves_2d', format: 'dxf',
      ownerNestId: 'nest-lyr',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      layers2d: [
        { id: 'lyr-a', name: 'Outline', color: '#ff0000', visible: true },
        { id: 'lyr-b', name: 'Holes', color: '#00ff00', visible: true },
      ],
      loops: [
        { id: 'lp-a', layerId: 'lyr-a', closed: true, type: 'contour', area: 50,
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        { id: 'lp-b', layerId: 'lyr-b', closed: true, type: 'hole', area: 0.5,
          points: [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 4 }] },
      ],
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [
          ...(s.project.nests ?? []),
          {
            id: 'nest-lyr',
            name: 'Layer Nest',
            sheet: { width: 100, height: 100 },
            style: 'ninety' as const,
            spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
            seed: 1,
            sources: [{ geometryId: 'g-seed2d', quantity: 2 }],
            placements: [
              { partId: 'g-seed2d', instanceId: 'g-seed2d#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
            ],
            unplaced: [],
            utilization: 0.5,
            computeTimeMs: 10,
          },
        ],
      },
    }))
  })
}

describe('DesignTree seed selectable + layer eyes (this pass)', () => {
  it('selects the owned-seed geometry when the seed child row is clicked', () => {
    seedOwnedWithLayers()
    render(<DesignTree />)
    const row = screen.getByTestId('nest-seed-row')
    act(() => { row.click() })
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('g-seed2d')
  })

  it('expands the seed child to its per-layer rows on chevron click', () => {
    seedOwnedWithLayers()
    // expandedSeedIds lives in the persisted uiPrefs store (NOT reset by
    // newProject), so force a known collapsed start for this assertion.
    act(() => { useUiPrefs.setState({ expandedSeedIds: [] }) })
    render(<DesignTree />)
    // Collapsed by default: no layer rows yet.
    expect(screen.queryAllByTestId('seed-layer-row').length).toBe(0)
    const chevron = screen.getByTestId('nest-seed-chevron')
    act(() => { chevron.click() })
    // Two layers -> two layer rows.
    expect(screen.getAllByTestId('seed-layer-row').length).toBe(2)
  })

  it('flips a seed layer visible flag when its visibility eye is clicked', () => {
    seedOwnedWithLayers()
    // Force expanded so the layer rows render regardless of prior test state.
    act(() => { useUiPrefs.setState({ expandedSeedIds: ['g-seed2d'] }) })
    render(<DesignTree />)
    // Both layers start visible.
    const before = useCamStore.getState().project.geometry
      .find(g => g.id === 'g-seed2d')!.layers2d!.map(l => l.visible)
    expect(before).toEqual([true, true])
    // Click the first layer's eye.
    const eyes = screen.getAllByTestId('seed-layer-vis')
    expect(eyes.length).toBe(2)
    act(() => { eyes[0].click() })
    const after = useCamStore.getState().project.geometry
      .find(g => g.id === 'g-seed2d')!.layers2d!.map(l => l.visible)
    // The first layer flipped to hidden; the second is untouched.
    expect(after).toEqual([false, true])
  })

  it('does not add a whole-seed hide eyeball on the seed row itself', () => {
    seedOwnedWithLayers()
    render(<DesignTree />)
    // The seed ROW carries no visibility toggle (per-layer eyes only). Only the
    // expanded layer rows do, and they are absent until expanded.
    const row = screen.getByTestId('nest-seed-row')
    expect(row.querySelectorAll('[data-testid="seed-layer-vis"]').length).toBe(0)
  })
})

// ── Seed layer edit affordances (this pass) ──────────────────────────────────
// Wiring the previously-deferred root-row affordances onto the seed layer rows,
// reusing the EXACT root handlers + gating (the owned seed is a deep copy, so its
// format/locked/projection gating applies unchanged). An svg/dxf seed now shows,
// per expanded layer: edit-sketch (gated non-locked) + lock + delete; and a
// "New layer" button on the seed header. A LOCKED layer hides the edit-sketch
// button (gating). Still NO whole-seed hide icon (per-layer only).

describe('DesignTree seed layer edit affordances (this pass)', () => {
  it('renders edit-sketch + lock + delete per layer and a New layer button', () => {
    seedOwnedWithLayers()
    // Force expanded so the layer rows render regardless of prior test state.
    act(() => { useUiPrefs.setState({ expandedSeedIds: ['g-seed2d'] }) })
    render(<DesignTree />)
    // Two unlocked dxf layers -> two of each per-layer affordance.
    expect(screen.getAllByTestId('seed-layer-edit').length).toBe(2)
    expect(screen.getAllByTestId('seed-layer-lock').length).toBe(2)
    expect(screen.getAllByTestId('seed-layer-delete').length).toBe(2)
    // One "New layer" button on the seed header (dxf format).
    expect(screen.getByTestId('seed-layer-add')).not.toBeNull()
  })

  it('hides the edit-sketch button on a LOCKED layer (gating)', () => {
    seedOwnedWithLayers()
    // Lock the first layer in store truth.
    act(() => {
      useCamStore.getState().updateGeometryLayer('g-seed2d', 'lyr-a', { locked: true })
      useUiPrefs.setState({ expandedSeedIds: ['g-seed2d'] })
    })
    render(<DesignTree />)
    // One layer locked -> only the unlocked layer shows edit-sketch.
    expect(screen.getAllByTestId('seed-layer-edit').length).toBe(1)
    // Lock + delete stay on BOTH rows (locking does not remove them).
    expect(screen.getAllByTestId('seed-layer-lock').length).toBe(2)
    expect(screen.getAllByTestId('seed-layer-delete').length).toBe(2)
  })

  it('removes the layer from store truth when its delete button is clicked', () => {
    seedOwnedWithLayers()
    act(() => { useUiPrefs.setState({ expandedSeedIds: ['g-seed2d'] }) })
    render(<DesignTree />)
    const before = useCamStore.getState().project.geometry
      .find(g => g.id === 'g-seed2d')!.layers2d!.map(l => l.id)
    expect(before).toEqual(['lyr-a', 'lyr-b'])
    // Click the first layer's delete; same handleDeleteLayer the root rows use.
    const dels = screen.getAllByTestId('seed-layer-delete')
    expect(dels.length).toBe(2)
    act(() => { dels[0].click() })
    const after = useCamStore.getState().project.geometry
      .find(g => g.id === 'g-seed2d')!.layers2d!.map(l => l.id)
    // The first layer is gone; the second remains.
    expect(after).toEqual(['lyr-b'])
  })
})

// ── N1a: folder + nest drag-to-reorder ──────────────────────────────────────
// Seeds 2 folders and 2 nests so the reorder affordance turns on (handle gutter
// is always reserved; dragging is enabled only when there is more than one of a
// kind). Asserts the render mounts, every folder/nest row carries a drag handle,
// and the store reorder actions actually permute the backing arrays.

function makeNest(id: string, name: string) {
  return {
    id, name,
    sheet: { width: 100, height: 100 },
    style: 'ninety' as const,
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources: [{ geometryId: 'g-nest', quantity: 1 }],
    placements: [],
    unplaced: [{ partId: 'g-nest', count: 0 }],
    utilization: 0,
    computeTimeMs: 0,
  }
}

function seedTwoFoldersTwoNests() {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g-nest', name: 'NestPart', filename: 'p.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    useCamStore.getState().addGeometryFolder('Folder One', null)
    useCamStore.getState().addGeometryFolder('Folder Two', null)
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [makeNest('nest-1', 'Nest A'), makeNest('nest-2', 'Nest B')],
      },
    }))
  })
}

describe('DesignTree folder/nest reorder handles (N1a)', () => {
  it('mounts with 2 folders + 2 nests without throwing (hooks-order guard)', () => {
    seedTwoFoldersTwoNests()
    expect(() => render(<DesignTree />)).not.toThrow()
  })

  it('renders a drag handle on every folder row and every nest row', () => {
    seedTwoFoldersTwoNests()
    render(<DesignTree />)
    // Two folders -> two folder handles; two nests -> two nest handles. The
    // gutter is reserved on every row (data-testid present even if a single row
    // would render it disabled).
    expect(screen.getAllByTestId('folder-drag-handle').length).toBe(2)
    expect(screen.getAllByTestId('nest-drag-handle').length).toBe(2)
  })

  it('reserves the handle gutter even with a single folder / single nest', () => {
    act(() => {
      useCamStore.getState().addGeometryFolder('Solo Folder', null)
      useCamStore.setState((s) => ({
        project: { ...s.project, nests: [makeNest('nest-solo', 'Solo Nest')] },
      }))
    })
    render(<DesignTree />)
    // One of each — the handle is still rendered (gutter reserved), just inert.
    expect(screen.getAllByTestId('folder-drag-handle').length).toBe(1)
    expect(screen.getAllByTestId('nest-drag-handle').length).toBe(1)
  })

  it('reorderGeometryFolder permutes the ROOT folder ordering', () => {
    seedTwoFoldersTwoNests()
    const before = (useCamStore.getState().project.geometryFolders ?? [])
      .filter(f => f.parentId == null).map(f => f.name)
    expect(before).toEqual(['Folder One', 'Folder Two'])
    act(() => { useCamStore.getState().reorderGeometryFolder(0, 1) })
    const after = (useCamStore.getState().project.geometryFolders ?? [])
      .filter(f => f.parentId == null).map(f => f.name)
    expect(after).toEqual(['Folder Two', 'Folder One'])
  })

  it('reorderNest permutes project.nests ordering', () => {
    seedTwoFoldersTwoNests()
    const before = (useCamStore.getState().project.nests ?? []).map(n => n.name)
    expect(before).toEqual(['Nest A', 'Nest B'])
    act(() => { useCamStore.getState().reorderNest(0, 1) })
    const after = (useCamStore.getState().project.nests ?? []).map(n => n.name)
    expect(after).toEqual(['Nest B', 'Nest A'])
  })
})

// ── Recompute affordance (stale nest) ────────────────────────────────────────
// When a nest's needsRecompute flag is set (an owned seed was edited), the nest
// row shows a Recompute icon button (nest-recompute) that calls recomputeNest.
// A FRESH nest (no flag) hides it. The store's recomputeNest early-returns
// without a Worker in jsdom, so click is asserted via a spy on the action.

function seedNestWithStaleFlag(stale: boolean) {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g-nest', name: 'NestPart', filename: 'p.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [
          {
            id: 'nest-1', name: 'Nest A',
            sheet: { width: 100, height: 100 }, style: 'ninety' as const,
            spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 }, seed: 1,
            sources: [{ geometryId: 'g-nest', quantity: 1 }],
            placements: [
              { partId: 'g-nest', instanceId: 'g-nest#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
            ],
            unplaced: [], utilization: 0.4, computeTimeMs: 10,
            ...(stale ? { needsRecompute: true } : {}),
          },
        ],
      },
    }))
  })
}

describe('DesignTree nest Recompute affordance (stale flag)', () => {
  it('shows the Recompute button on a STALE nest row (nest-recompute)', () => {
    seedNestWithStaleFlag(true)
    render(<DesignTree />)
    expect(screen.getByTestId('nest-recompute')).not.toBeNull()
  })

  it('does NOT show the Recompute button on a FRESH nest row', () => {
    seedNestWithStaleFlag(false)
    render(<DesignTree />)
    expect(screen.queryByTestId('nest-recompute')).toBeNull()
  })

  it('clicking Recompute calls recomputeNest with the nest id', () => {
    seedNestWithStaleFlag(true)
    const spy = vi.fn()
    // Replace the store action with a spy (recomputeNest early-returns without a
    // Worker in jsdom, so assert the wiring via the action call, not status).
    act(() => { useCamStore.setState({ recomputeNest: spy }) })
    render(<DesignTree />)
    act(() => { screen.getByTestId('nest-recompute').click() })
    expect(spy).toHaveBeenCalledWith('nest-1')
  })
})

// ── Computing indicator during a recompute (status-driven) ───────────────────
// The nest row's "computing..." meta must also show when nest.status ===
// 'computing' (an in-flight recompute KEEPS prior placements, so the old
// placed===0 flag would never fire). A row with placements but status 'computing'
// must still render the computing meta.

describe('DesignTree nest row computing indicator (status-driven)', () => {
  it('shows "computing..." for a nest with placements + status computing', () => {
    act(() => {
      useCamStore.getState().addGeometry({
        id: 'g-nest', name: 'NestPart', filename: 'p.stl', type: 'mesh', format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
          size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      })
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          nests: [
            {
              id: 'nest-1', name: 'Nest A',
              sheet: { width: 100, height: 100 }, style: 'ninety' as const,
              spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 }, seed: 1,
              sources: [{ geometryId: 'g-nest', quantity: 1 }],
              // Placements PRESENT (a recompute does not clear them), yet computing.
              placements: [
                { partId: 'g-nest', instanceId: 'g-nest#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
              ],
              unplaced: [], utilization: 0.4, computeTimeMs: 10,
              status: 'computing' as const, computeStartedAt: Date.now(),
            },
          ],
        },
      }))
    })
    render(<DesignTree />)
    expect(screen.getByText('computing...')).not.toBeNull()
  })
})
