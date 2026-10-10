// @vitest-environment jsdom
//
// WO-1406: a completed zero-fit nest was stuck reading "computing..." forever.
// renderNestFolderRow (DesignTree.tsx) derived `computing` from a placed===0 &&
// left>0 heuristic OR nest.status==='computing' — but that heuristic ALSO
// matched a SETTLED 'ready' result that legitimately placed zero pieces (a
// deliberate Accept of a reported shortfall). Fix: prefer nest.status once it
// is populated; the heuristic covers only the narrow pre-dispatch window where
// status itself is not yet set.
//
// These tests drive the real store write paths (createNest = Calculate's
// dispatch, applyNestResult = the pack landing that Accept then keeps as-is)
// rather than hand-building a NestRecord, per the WO's Tier 2 evidence.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Pure test
// scaffolding; no app change. Copied from DesignTreeNest.smoke.test.tsx.
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

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
  })
})

const NEST_PARAMS_BASE = {
  sheet: { width: 200, height: 200 },
  style: 'ninety' as const,
  spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
  seed: 1,
}

// A sourceable part: one closed square loop, so createNest resolves it into a
// real NestPart (createNest silently skips sources with no closed loops).
function addSourceGeometry(id: string, side = 10) {
  useCamStore.getState().addGeometry({
    id, name: `Part-${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: side, y: side, z: 0 },
      size: { x: side, y: side, z: 0 }, center: { x: side / 2, y: side / 2, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [
      { id: `${id}-outer`, layerId: 'L', closed: true, type: 'contour', area: side * side,
        points: [{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side }] },
    ],
    layers2d: [{ id: 'L', name: 'L', color: '#ffffff', visible: true }],
  })
}

describe('DesignTree nest row status label (WO-1406)', () => {
  it('a deliberately Accepted zero-fit result reads as done, never stuck "computing..." (acceptance 1)', () => {
    let nestId = ''
    act(() => {
      addSourceGeometry('g1')
      nestId = useCamStore.getState().createNest({
        ...NEST_PARAMS_BASE,
        sources: [{ geometryId: 'g1', quantity: 4 }],
      })
    })
    const seedPartId = useCamStore.getState().project.nests!.find((n) => n.id === nestId)!.sources[0].geometryId
    act(() => {
      // The real Calculate landing (applyNestResult): a settled pack that placed
      // NOTHING and reports the whole shortfall explicitly (ADR 0003) — the
      // scenario Operator deliberately Accepts rather than re-running.
      useCamStore.getState().applyNestResult(nestId, {
        placements: [],
        unplaced: [{ partId: seedPartId, count: 4 }],
        utilization: 0,
        sheetUsed: { width: 200, height: 200 },
      })
    })
    // handleAccept (NestModal) makes no further change to the record itself — it
    // keeps the provisional and closes — so the landed result above IS the
    // Accepted state. It must never read "computing...", not just on first
    // render but indefinitely (no timer/effect flips it later).
    render(<DesignTree />)
    expect(screen.queryByText('computing...')).toBeNull()
    expect(useCamStore.getState().project.nests!.find((n) => n.id === nestId)!.status).toBe('ready')
  })

  it('a freshly dispatched nest with no status yet and no placements still shows "computing..." (acceptance 2)', () => {
    act(() => {
      addSourceGeometry('g2')
      useCamStore.getState().createNest({
        ...NEST_PARAMS_BASE,
        sources: [{ geometryId: 'g2', quantity: 2 }],
      })
    })
    // jsdom has no Worker global, so createNest never dispatches and the record
    // carries no status field at all yet — the narrow pre-dispatch window the
    // fallback heuristic must still cover.
    const nest = useCamStore.getState().project.nests![0]
    expect(nest.status).toBeUndefined()
    render(<DesignTree />)
    expect(screen.getByText('computing...')).not.toBeNull()
  })

  it('an explicit in-flight recompute (status computing) shows "computing..." regardless of placement counts (acceptance 3)', () => {
    let nestId = ''
    act(() => {
      addSourceGeometry('g3')
      nestId = useCamStore.getState().createNest({
        ...NEST_PARAMS_BASE,
        sources: [{ geometryId: 'g3', quantity: 1 }],
      })
      const seedPartId = useCamStore.getState().project.nests!.find((n) => n.id === nestId)!.sources[0].geometryId
      useCamStore.getState().applyNestResult(nestId, {
        placements: [{ partId: seedPartId, instanceId: `${seedPartId}#0`, x: 0, y: 0, rotationDeg: 0, depth: 0 }],
        unplaced: [],
        utilization: 0.8,
        sheetUsed: { width: 200, height: 200 },
      })
    })
    // Flip to an in-flight recompute. recomputeNest itself early-returns without
    // a Worker in jsdom (DesignTreeNest.smoke.test.tsx), so drive the transient
    // status directly — the same seam that file's status-driven case uses — to
    // assert a recompute that KEEPS prior placements still reads "computing...".
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          nests: (s.project.nests ?? []).map((n) =>
            n.id === nestId ? { ...n, status: 'computing' as const } : n),
        },
      }))
    })
    render(<DesignTree />)
    expect(screen.getByText('computing...')).not.toBeNull()
  })
})
