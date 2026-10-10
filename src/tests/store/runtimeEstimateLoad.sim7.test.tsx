// @vitest-environment jsdom
//
// SIM-7-R1 load-boundary + last-consumer regression gate. This file drives the
// real `.camproject` action and Zustand persist rehydrate, then mounts the real
// PropertiesPanel/DesignTree consumers. A stale pre-SIM-7 numeric estimate must
// never survive either boundary as a plausible duration.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { Operation, Project, Setup, ToolpathMove } from '../../types'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../../store/migrations/projectMigrations'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { DesignTree } = await import('../../components/panels/DesignTree')

const STORAGE_KEY = 'cnc-cam-project'

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op-legacy-estimate',
    name: 'Legacy Feedless Cut',
    type: 'contour_2d',
    enabled: true,
    status: 'ready',
    toolId: 'tool-legacy',
    geometrySelections: [],
    heights: {
      clearanceHeight: 10,
      clearanceHeightMode: 'absolute',
      retractHeight: 5,
      feedHeight: 1,
      topHeight: 0,
      topHeightMode: 'absolute',
      bottomHeight: -1,
      bottomHeightMode: 'absolute',
    },
    passes: {
      stepdown: 1,
      stepover: 1,
      stockToLeave: 0,
      finishPasses: 0,
      springPasses: 0,
    },
    linking: {
      entryType: 'plunge',
      rampAngle: 3,
      rampLength: 5,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params: {},
    ...overrides,
  }
}

function makeSetup(operations: Operation[]): Setup {
  return {
    id: 'setup-legacy-estimate',
    name: 'Legacy Setup',
    wcs: {
      id: 'wcs-legacy-estimate',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      originBinding: { kind: 'manual' },
    },
    stock: {
      type: 'rectangular',
      width: 100,
      height: 100,
      depth: 10,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations,
    notes: '',
  }
}

function makeLegacyProject(operations: Operation[]): Project {
  const base = JSON.parse(JSON.stringify(useCamStore.getState().project)) as Project
  const setup = makeSetup(operations)
  return {
    ...base,
    id: 'project-legacy-estimate',
    name: 'Legacy Runtime Estimate',
    schemaVersion: 6,
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: operations[0]?.id ?? null,
  }
}

function loadedOperation(): Operation {
  const op = useCamStore.getState().project.setups[0]?.operations[0]
  if (!op) throw new Error('constructed legacy operation did not reach the store')
  return op
}

beforeEach(() => {
  vi.stubGlobal('alert', vi.fn())
  act(() => { useCamStore.getState().newProject() })
  mem.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SIM-7-R1 runtime estimate load truth', () => {
  it('file-load: feedless legacy moves become outdated under the generation fingerprint contract', () => {
    const feedlessMoves: ToolpathMove[] = [
      { type: 'feed', x: 0, y: 0, z: 0 },
      { type: 'feed', x: 100, y: 0, z: 0 },
    ]
    const legacy = makeLegacyProject([
      makeOperation({ toolpathMoves: feedlessMoves, estimatedCutTimeMs: 123_000 }),
    ])

    act(() => { useCamStore.getState().loadProjectFromFile(JSON.stringify(legacy)) })

    const op = loadedOperation()
    expect(op.status).toBe('outdated')
    expect(op.toolpathMoves).toBeUndefined()
    expect(op.estimatedCutTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMsError).toBeUndefined()

    render(<PropertiesPanel />)
    expect(screen.queryByText('Cut time')).toBeNull()
    expect(screen.queryByText('2m 03s')).toBeNull()
  })

  it('file-load: usable legacy moves still require regeneration because inputs are unverifiable', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 0, y: 0, z: 0, feed: 1000 },
      { type: 'feed', x: 100, y: 0, z: 0, feed: 1000 },
    ]
    const legacy = makeLegacyProject([
      makeOperation({ toolpathMoves: moves, estimatedCutTimeMs: 999_999 }),
    ])

    act(() => { useCamStore.getState().loadProjectFromFile(JSON.stringify(legacy)) })

    const op = loadedOperation()
    expect(op.status).toBe('outdated')
    expect(op.toolpathMoves).toBeUndefined()
    expect(op.estimatedCutTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMsError).toBeUndefined()
  })

  it('persisted-state: a v2 root runs the nested v6 project transition on rehydrate', async () => {
    const current = useCamStore.getState()
    const legacy = makeLegacyProject([
      makeOperation({ toolpathMoves: undefined, estimatedCutTimeMs: 321_000 }),
    ])
    mem.set(STORAGE_KEY, JSON.stringify({
      version: 2,
      state: {
        project: legacy,
        machineLibrary: current.machineLibrary,
        toolLibrary: current.toolLibrary,
        toolLibraries: current.toolLibraries,
        holders: current.holders,
        appSettings: current.appSettings,
        importedFonts: [],
      },
    }))

    await act(async () => { await useCamStore.persist.rehydrate() })

    const op = loadedOperation()
    // UI-50C-R6 renumbering: rehydrate now runs the full chain to CURRENT.
    // Merge-seam note (INT-14): CURRENT was v8 when this comment was written;
    // INT-14 added its own migration step, bumping CURRENT to
    // CURRENT_PROJECT_SCHEMA_VERSION (9). Pinned to the canonical exported
    // constant rather than a bare literal so a future migration cannot make
    // this comment (or the pin) go stale silently.
    expect(useCamStore.getState().project.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(op.status).toBe('outdated')
    expect(op.toolpathMoves).toBeUndefined()
    expect(op.estimatedCutTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMsError).toBeUndefined()
  })

  it('operation card gives a refusal precedence when malformed state carries both fields', () => {
    const diagnostic = 'estimateRuntimeMs refused move 1 (cut): expected a finite positive feed.'
    const project = makeLegacyProject([
      makeOperation({
        estimatedCutTimeMs: 123_000,
        estimatedCutTimeMsError: diagnostic,
      }),
    ])
    project.schemaVersion = 8 // CURRENT post-UI-50C-R6 renumbering; this test bypasses migration entirely
    act(() => { useCamStore.setState((state) => ({ project: { ...state.project, ...project } })) })

    render(<PropertiesPanel />)
    expect(screen.getAllByText('Cut time')).toHaveLength(1)
    const refusal = screen.getByText('Unavailable (recompute to fix)')
    expect(refusal.getAttribute('data-tooltip')).toBe(diagnostic)
    expect(screen.queryByText('2m 03s')).toBeNull()
  })

  it('setup badge refuses a plausible partial sum when any ready op estimate refused', () => {
    const diagnostic = 'Legacy Feedless Cut requires recompute.'
    const project = makeLegacyProject([
      makeOperation({ id: 'op-timed', name: 'Timed Cut', estimatedCutTimeMs: 60_000 }),
      makeOperation({
        id: 'op-refused',
        name: 'Refused Cut',
        estimatedCutTimeMs: undefined,
        estimatedCutTimeMsError: diagnostic,
      }),
    ])
    project.schemaVersion = 8 // CURRENT post-UI-50C-R6 renumbering; this test bypasses migration entirely
    act(() => { useCamStore.setState((state) => ({ project: { ...state.project, ...project } })) })

    render(<DesignTree />)
    const badge = screen.getByTestId('setup-cuttime-unavailable')
    expect(badge.textContent).toBe('Unavailable')
    expect(badge.getAttribute('data-tooltip')).toBe(diagnostic)
    expect(screen.queryByText('1m 00s')).toBeNull()
  })
})
