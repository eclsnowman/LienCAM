// @vitest-environment jsdom
//
// React-render SMOKE test for the PropertiesPanel NEST summary branch (P-N1a
// commit 4/4). The repo's vitest env is 'node' by default (vite.config.ts); the
// directive above flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS GATE EXISTS: a hooks-order bug ("Rendered more hooks than during the
// previous render") shipped once in a modal because a hook sat below an early
// return and tsc + the pure-logic vitest suite did not catch it
// (feedback_render_gate_ui_changes). This file seeds a selected nest and mounts
// PropertiesPanel, exercising the NestProperties render path (which itself calls
// a useCamStore hook) that tsc cannot see. The branch lives high in the returned
// cascade and the selectedNest lookup sits with the other consts (before any
// return), so no hook ordering can shift — this mount guards exactly that.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { NestRecord } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Pure test
// scaffolding; no app change. (Mirrors DesignTreeAutoStock.smoke.test.tsx.)
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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

// The store is a process singleton; reset to a clean project before each test so
// the tests are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
  })
})

// A minimal, type-valid NestRecord with one source and >=1 placement so the
// summary renders the placed/requested + utilization + the source row.
function seedNest(): NestRecord {
  const nest: NestRecord = {
    id: 'nest-pp-1',
    name: 'Test Nest',
    sheet: { width: 300, height: 200 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 2, windowGap: 0 },
    solver: { kind: 'fixSheet' },
    seed: 42,
    sources: [{ geometryId: 'g-src', quantity: 4 }],
    placements: [
      { partId: 'g-src', instanceId: 'i-0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'g-src', instanceId: 'i-1', x: 50, y: 0, rotationDeg: 0, depth: 0 },
    ],
    unplaced: [{ partId: 'g-src', count: 2 }],
    utilization: 0.625,
    computeTimeMs: 1234,
  }
  act(() => {
    // Seed one geometry so the source row resolves a NAME (not the raw id).
    useCamStore.getState().addGeometry({
      id: 'g-src', name: 'WidgetPart', filename: 'w.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    useCamStore.setState((s) => ({ project: { ...s.project, nests: [nest] } }))
    useCamStore.getState().setSelectedNest(nest.id)
  })
  return nest
}

// P6 Item 3b / ADR 0024 Amd 1: inject a setup whose operation is a SEED op for
// the nest source (op.params.geometryId === source.geometryId) carrying a
// computed seed-local toolpath. estimateNestCutTimeMs now TIMES the full
// expanded multi-copy stream (all copies + inter-copy travel), so the op must
// carry toolpathMoves for the expansion to be non-empty. A simple two-point
// feed cut at a known feed makes the per-copy cut deterministic.
function seedSeedOp(geometryId: string, _perCopyMs: number): void {
  const op = {
    id: 'op-seed-1',
    name: 'Seed Pocket',
    toolId: 't1',
    // e3927c6cd ("fix(cam): gate stale paths...") made collectToolpathSections /
    // buildNestExpansion skip any operation whose status is not
    // ready/outdated/degraded. Without it the expansion is empty and the panel
    // truthfully reports "pending seed toolpaths" -- so a COMPUTED seed op,
    // which is what these cases are about, has to say it is computed.
    status: 'ready',
    params: { geometryId },
    estimatedCutTimeMs: _perCopyMs,
    toolpathMoves: [
      { type: 'feed', x: 0, y: 0, z: 1, feed: 1000 },
      { type: 'feed', x: 100, y: 0, z: 1, feed: 1000 },
    ],
  } as unknown as import('../../types').Operation
  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    operations: [op],
  } as unknown as import('../../types').Setup
  act(() => {
    useCamStore.setState((s) => ({
      project: { ...s.project, setups: [setup] },
    }))
  })
}

describe('PropertiesPanel nest summary render smoke', () => {
  it('mounts the nest summary without throwing (guards hooks-order)', () => {
    seedNest()
    // A throw here (e.g. a hooks-order crash) fails the test.
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
  })

  it('renders the nest name', () => {
    seedNest()
    render(<PropertiesPanel />)
    expect(screen.getByText('Test Nest')).not.toBeNull()
  })

  it('renders the source quantity and the utilization %', () => {
    seedNest()
    render(<PropertiesPanel />)
    // Source row shows the resolved geometry name + xN quantity.
    expect(screen.getByText('WidgetPart')).not.toBeNull()
    expect(screen.getByText(/x4/)).not.toBeNull()
    // Utilization 0.625 -> "62.5%".
    expect(screen.getByText('62.5%')).not.toBeNull()
  })

  it('renders the first-class editable "Thickness (Z)" field (N1d Item 5)', () => {
    seedNest()
    render(<PropertiesPanel />)
    // The label renders, and an editable NumericInput sits in its row (not just
    // a read-only summary value). Find the label, then assert a text input
    // exists within the panel (NumericInput renders an <input>).
    expect(screen.getByText('Thickness (Z)')).not.toBeNull()
    const inputs = document.querySelectorAll('input')
    expect(inputs.length).toBeGreaterThan(0)
  })

  it('renders the "Cut order" toggle defaulting to by-operation (P7)', () => {
    seedNest()
    render(<PropertiesPanel />)
    expect(screen.getByText('Cut order')).not.toBeNull()
    const select = screen.getByTestId('nest-machining-order') as HTMLSelectElement
    // undefined machiningOrder displays as the default.
    expect(select.value).toBe('by-operation')
  })

  it('changing the Cut order toggle writes setNestMachiningOrder (P7)', () => {
    const nest = seedNest()
    render(<PropertiesPanel />)
    const select = screen.getByTestId('nest-machining-order') as HTMLSelectElement
    act(() => {
      select.value = 'by-part'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const stored = useCamStore.getState().project.nests?.find((n) => n.id === nest.id)
    expect(stored?.machiningOrder).toBe('by-part')
    // and the control reflects the new value
    expect((screen.getByTestId('nest-machining-order') as HTMLSelectElement).value).toBe('by-part')
  })

  it('a READY nest shows "Computed in" (not the computing indicator)', () => {
    seedNest()
    render(<PropertiesPanel />)
    // computeTimeMs 1234 -> "1.2 s"; the live computing row is absent.
    expect(screen.getByText('Computed in')).not.toBeNull()
    expect(screen.queryByTestId('nest-computing-props')).toBeNull()
  })

  it('a COMPUTING nest shows the live "Computing..." indicator', () => {
    const nest = seedNest()
    // Flip the seeded record to the in-flight state with a known start.
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          nests: (s.project.nests ?? []).map((n) =>
            n.id === nest.id
              ? { ...n, status: 'computing' as const, computeStartedAt: Date.now() }
              : n,
          ),
        },
      }))
    })
    render(<PropertiesPanel />)
    const el = screen.getByTestId('nest-computing-props')
    expect(el).not.toBeNull()
    expect(el.textContent).toContain('Computing...')
    // While computing, the diagnostic "Computed in" row is replaced.
    expect(screen.queryByText('Computed in')).toBeNull()
  })

  it('shows the instance-expanded "Est. cut time" line when seed ops are computed', () => {
    seedNest()
    // A computed seed op over 2 placements -> the timed expanded stream (cut +
    // inter-copy travel) renders as "~<time>".
    seedSeedOp('g-src', 30000)
    render(<PropertiesPanel />)
    expect(screen.getByText('Est. cut time')).not.toBeNull()
    const el = screen.getByTestId('nest-cut-estimate')
    // Expanded total (~time), the copy count, and the honest disclaimer that
    // inter-copy travel is now INCLUDED.
    expect(el.textContent).toMatch(/~/)
    expect(el.textContent).toContain('2 copies')
    expect(el.textContent).toContain('incl. inter-copy travel')
  })

  it('BK-137: shows a named refusal (never throws, never a silent number) when a seed move lacks a feed', () => {
    seedNest()
    // A legacy/degraded seed op whose cutting move never got a baked feed.
    // estimateNestCutTimeMs must catch estimateRuntimeMs's refusal and render
    // it, not let the throw crash this component (render-gate: a useMemo throw
    // during render is a hard crash, not a caught error-boundary case here).
    const op = {
      id: 'op-seed-1',
      name: 'Seed Pocket',
      toolId: 't1',
      // e3927c6cd's status gate: the expansion only walks ready/outdated/
      // degraded ops. 'degraded' is exactly what this fixture describes -- a
      // legacy seed op that computed but carries an unusable move -- and it is
      // what makes the run reach the feed refusal instead of reporting the op
      // as simply not computed yet.
      status: 'degraded',
      params: { geometryId: 'g-src' },
      toolpathMoves: [
        { type: 'feed', x: 0, y: 0, z: 1 },
        { type: 'feed', x: 100, y: 0, z: 1 },
      ],
    } as unknown as import('../../types').Operation
    const setup = {
      id: 'setup-1',
      name: 'Setup 1',
      operations: [op],
    } as unknown as import('../../types').Setup
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, setups: [setup] } }))
    })

    render(<PropertiesPanel />)
    expect(screen.getByText('Est. cut time')).not.toBeNull()
    const el = screen.getByTestId('nest-cut-estimate')
    expect(el.textContent).toBe('Unavailable (recompute to fix)')
    expect(el.getAttribute('data-tooltip')).toMatch(/finite positive feed/i)
  })

  it('shows the neutral "pending seed toolpaths" state when no seed ops exist', () => {
    seedNest()
    // No setups/ops seeded -> totalMs 0 -> neutral state, not "~0s".
    render(<PropertiesPanel />)
    expect(screen.getByText('Est. cut time')).not.toBeNull()
    const el = screen.getByTestId('nest-cut-estimate')
    expect(el.textContent).toContain('pending seed toolpaths')
    expect(el.textContent).not.toMatch(/~/)
  })

  it('a COMPUTING nest with NO start shows "Computing..." without NaN', () => {
    const nest = seedNest()
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          nests: (s.project.nests ?? []).map((n) =>
            n.id === nest.id ? { ...n, status: 'computing' as const, computeStartedAt: undefined } : n,
          ),
        },
      }))
    })
    render(<PropertiesPanel />)
    const el = screen.getByTestId('nest-computing-props')
    expect(el.textContent).toContain('Computing...')
    expect(el.textContent).not.toMatch(/NaN/)
  })
})
