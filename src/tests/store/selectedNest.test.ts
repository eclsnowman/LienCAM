// N1a (commit 2 of 4): transient "nest is selected" store state, mutually
// exclusive with geometry selection (viewer.selectedGeometryId) and operation
// selection (project.activeOperationId). At most one of {geometry, op, nest} is
// selected at a time; selecting any one clears the other two. Pure store tests
// (no React render): they exercise the store actions directly via getState().
//
// Coverage:
//  (a) setSelectedNest sets selectedNestId and clears selectedGeometryId;
//  (b) setSelectedNest clears the active operation (activeOperationId);
//  (c) setSelectedGeometry clears selectedNestId;
//  (d) selecting an operation (setActiveOperation / addOperation) clears selectedNestId;
//  (e) removeNest on the selected nest clears selectedNestId (and is left alone
//      when a DIFFERENT nest is removed);
//  (f) selectedNestId is TRANSIENT (lives in the non-persisted viewer slice).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, persistPartialize } from '../../store'
import type { Operation } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

// Reset the viewer + project selection state before each test so cases don't
// bleed into one another. selectedNestId/selectedGeometryId live in viewer;
// activeOperationId/activeSetupId live in project.
beforeEach(() => {
  useCamStore.setState((s) => ({
    viewer: { ...s.viewer, selectedGeometryId: null, selectedNestId: null },
    project: { ...s.project, activeOperationId: null, activeSetupId: null, setups: [] },
  }))
})

describe('setSelectedNest — mutual exclusion', () => {
  it('(a) sets selectedNestId and clears selectedGeometryId', () => {
    // Pre-select a geometry, then select a nest -> geometry selection drops.
    useCamStore.getState().setSelectedGeometry('geo-1')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')

    useCamStore.getState().setSelectedNest('nest-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBe('nest-1')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()
  })

  it('(b) clears the active operation (activeOperationId)', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, activeOperationId: 'op-1' },
    }))
    useCamStore.getState().setSelectedNest('nest-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBe('nest-1')
    expect(useCamStore.getState().project.activeOperationId).toBeNull()
  })

  it('clearing the nest (null) leaves competing selections untouched', () => {
    useCamStore.getState().setSelectedNest('nest-1')
    useCamStore.getState().setSelectedNest(null)
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
    // selecting a geometry, then clearing nest with null, must not wipe it.
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedNest(null)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')
  })
})

describe('setSelectedGeometry clears selectedNestId', () => {
  it('(c) selecting a geometry drops the selected nest', () => {
    useCamStore.getState().setSelectedNest('nest-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBe('nest-1')

    useCamStore.getState().setSelectedGeometry('geo-1')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })

  it('clearing geometry (null) does not touch an already-null nest', () => {
    useCamStore.getState().setSelectedGeometry(null)
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })
})

describe('selecting an operation clears selectedNestId', () => {
  it('(d1) setActiveOperation(non-null) clears the selected nest', () => {
    useCamStore.getState().setSelectedNest('nest-1')
    useCamStore.getState().setActiveOperation('op-1')
    expect(useCamStore.getState().project.activeOperationId).toBe('op-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })

  it('setActiveOperation(null) leaves an already-null nest alone', () => {
    useCamStore.getState().setActiveOperation(null)
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })

  it('(d2) addOperation clears the selected nest', () => {
    // Need a setup to add the op into.
    useCamStore.getState().addSetup({
      id: 'setup-1', name: 'S1', operations: [],
    } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
    useCamStore.getState().setSelectedNest('nest-1')

    const op = {
      id: 'op-1', name: 'Op 1', type: 'contour_2d',
      smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1' }),
    } as unknown as Operation
    useCamStore.getState().addOperation('setup-1', op)
    expect(useCamStore.getState().project.activeOperationId).toBe('op-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })
})

describe('removeNest clears the selected nest', () => {
  it('(e1) removing the SELECTED nest clears selectedNestId', () => {
    // Install a nest record so removeNest passes its existence guard.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [{ id: 'nest-1', name: 'Nest 1' } as never],
      },
    }))
    useCamStore.getState().setSelectedNest('nest-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBe('nest-1')

    useCamStore.getState().removeNest('nest-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })

  it('(e2) removing a DIFFERENT nest leaves the selection intact', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [
          { id: 'nest-1', name: 'Nest 1' } as never,
          { id: 'nest-2', name: 'Nest 2' } as never,
        ],
      },
    }))
    useCamStore.getState().setSelectedNest('nest-1')
    useCamStore.getState().removeNest('nest-2')
    expect(useCamStore.getState().viewer.selectedNestId).toBe('nest-1')
  })
})

describe('selectedNestId is transient', () => {
  it('(f) is NOT in the persisted partialize slice', () => {
    useCamStore.getState().setSelectedNest('nest-1')
    const slice = persistPartialize(useCamStore.getState())
    // viewer is not persisted at all -> no selectedNestId leaks into the blob.
    expect('viewer' in slice).toBe(false)
    expect(JSON.stringify(slice)).not.toContain('selectedNestId')
  })
})
