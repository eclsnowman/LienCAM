// WO-1541: a nest that needs recompute still shows its operations as ready
//
// WO-1388 downgraded a nest's stale seed op to 'outdated' only at POST time
// (buildPostInput). The STORE itself never changed the operation's own
// status, so the design tree (reads op.status directly) and the status bar
// (App.tsx statusLabel, also op.status directly) kept reading the operation
// as ready while Post would refuse it as outdated. Store-level fix: a 'ready'
// operation expanded through a nest whose needsRecompute is true reads
// 'outdated' in the store itself, so the tree, the status bar and Post all
// agree — no new nest-specific label, badge or refusal.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { makeMachine, makeOp, makeWcs, move } from '../post/helpers'
import type { ImportedGeometry, NestRecord, Project, Setup } from '../../types'

const NEST_ID = 'nest-wo1541'
const SEED_GEO_ID = 'seed-wo1541'
const OTHER_GEO_ID = 'other-wo1541'

function bbox() {
  return {
    min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
    size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
  }
}

/** An owned-seed geometry: the integrated copy a nest packs (ownerNestId set). */
function seedGeometry(): ImportedGeometry {
  return {
    id: SEED_GEO_ID,
    name: 'Seed Part',
    filename: '',
    type: 'imported',
    format: 'dxf',
    boundingBox: bbox(),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ownerNestId: NEST_ID,
  } as unknown as ImportedGeometry
}

/** A workspace part with no nest involvement at all. */
function otherGeometry(): ImportedGeometry {
  return {
    id: OTHER_GEO_ID,
    name: 'Unrelated Part',
    filename: '',
    type: 'imported',
    format: 'dxf',
    boundingBox: bbox(),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  } as unknown as ImportedGeometry
}

function makeNest(overrides: Partial<NestRecord> = {}): NestRecord {
  return {
    id: NEST_ID,
    name: 'Nest 1',
    sheet: { width: 200, height: 200 },
    style: 'ninety',
    spacing: {} as NestRecord['spacing'],
    seed: 1,
    sources: [{ geometryId: SEED_GEO_ID, quantity: 2 }],
    placements: [
      { partId: SEED_GEO_ID, instanceId: 'i0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ],
    unplaced: [],
    utilization: 0.5,
    origin: { x: 0, y: 0 },
    needsRecompute: false,
    ...overrides,
  } as unknown as NestRecord
}

function makeSetup(): Setup {
  return {
    id: 's1',
    name: 'Setup 1',
    wcs: makeWcs(),
    stock: {} as Setup['stock'],
    operations: [
      makeOp({ id: 'seed-op', name: 'Seed Contour', type: 'contour_2d', params: { geometryId: SEED_GEO_ID } }),
      makeOp({ id: 'other-op', name: 'Other Op', type: 'contour_2d', params: { geometryId: OTHER_GEO_ID } }),
    ],
    notes: '',
  }
}

function makeProject(setup: Setup, nests: NestRecord[]): Project {
  return {
    id: 'p1',
    name: 'P',
    version: '1',
    machine: makeMachine(),
    toolLibrary: [],
    geometry: [seedGeometry(), otherGeometry()],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    nests,
    notes: '',
  } as unknown as Project
}

function installProject(project: Project): void {
  useCamStore.setState((s) => ({
    project,
    projectHistory: [],
    canUndo: false,
    viewer: { ...s.viewer, selectedNestId: null },
  }))
}

function operationById(id: string) {
  const op = useCamStore.getState().project.setups[0].operations.find((o) => o.id === id)
  if (!op) throw new Error(`missing operation ${id}`)
  return op
}

function setNestNeedsRecompute(needsRecompute: boolean): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      nests: (s.project.nests ?? []).map((n) =>
        n.id === NEST_ID ? { ...n, needsRecompute } : n,
      ),
    },
  }))
}

beforeEach(() => {
  installProject(makeProject(makeSetup(), [makeNest()]))
})

describe('WO-1541 a nest needing recompute outdates its operations in the store', () => {
  it('a freshly computed nest leaves its operations ready', () => {
    expect(operationById('seed-op').status).toBe('ready')
    expect(operationById('other-op').status).toBe('ready')
  })

  it('marks an operation expanded through the nest outdated when the nest needs recompute; an unrelated operation stays ready', () => {
    // Mirrors PropertiesPanel's commitPackInputs (gap/solver/style/seed edit):
    // it never calls a store action, it writes needsRecompute:true directly.
    setNestNeedsRecompute(true)

    expect(operationById('seed-op').status).toBe('outdated')
    expect(operationById('other-op').status).toBe('ready')
  })

  it('recomputing the nest lets its operations generate back to ready', () => {
    setNestNeedsRecompute(true)
    expect(operationById('seed-op').status).toBe('outdated')

    // applyNestResult is the worker-completion / node-testable seam a real
    // Recompute click writes through; it clears needsRecompute on a fresh pack.
    useCamStore.getState().applyNestResult(NEST_ID, {
      sheetUsed: { width: 200, height: 200 },
      placements: [{ partId: SEED_GEO_ID, instanceId: 'i0', x: 0, y: 0, rotationDeg: 0, depth: 0 }],
      unplaced: [],
      utilization: 0.5,
    })
    expect(
      useCamStore.getState().project.nests!.find((n) => n.id === NEST_ID)!.needsRecompute,
    ).toBe(false)

    // The op itself still needs its own recompute (still 'outdated' here) —
    // but it is no longer FORCED outdated by the nest, so a normal toolpath
    // recompute can reach 'ready' again.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: s.project.setups.map((setup) => ({
          ...setup,
          operations: setup.operations.map((op) =>
            op.id === 'seed-op' ? { ...op, status: 'ready' as const, toolpathMoves: [move()] } : op,
          ),
        })),
      },
    }))
    expect(operationById('seed-op').status).toBe('ready')
  })
})
