// PP-MOVE-PICK: viewer.selectedMove is the toolpath MOVE/SEGMENT picked in the
// Toolpath viewport. Unlike the other selections, a move BELONGS TO an operation,
// so selecting one ACTIVATES its owning operation (rather than clearing the op),
// while still being mutually exclusive with geometry/nest/stock/layer/folder.
// Pure store tests (no React render): exercise the store actions directly.
//
// Coverage:
//  (a) setSelectedMove(sel) stores it and clears geometry/nest/stock/layer/folder
//      WITHOUT touching activeOperationId (it is an overlay, not a re-render);
//  (b) clearing (null) leaves the other selections + active op untouched;
//  (c) competing selectors (geometry/nest/stock/layer/folder/op) clear a move;
//  (d) selectedMove is TRANSIENT (non-persisted viewer slice).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, persistPartialize } from '../../store'
import type { SelectedMove } from '../../types'

function move(over: Partial<SelectedMove> = {}): SelectedMove {
  return {
    operationId: 'op-1',
    moveIndex: 3,
    moveCount: 20,
    moveType: 'feed',
    role: 'cut',
    from: { x: 0, y: 0, z: 0 },
    to: { x: 10, y: 0, z: -1 },
    lengthMm: 10.05,
    feed: 800,
    ...over,
  }
}

beforeEach(() => {
  useCamStore.setState((s) => ({
    viewer: {
      ...s.viewer,
      selectedGeometryId: null,
      selectedNestId: null,
      selectedStockId: null,
      selectedLayerId: null,
      selectedLayerGeoId: null,
      selectedFolderId: null,
      selectedFolderKind: null,
      selectedFolderSetupId: null,
      selectedMove: null,
    },
    project: { ...s.project, activeOperationId: null, activeSetupId: null, setups: [] },
  }))
})

describe('setSelectedMove — selection is an overlay, not a re-render', () => {
  it('(a) stores the move, clears competing selections, leaves active op alone', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op-7' } }))
    useCamStore.getState().setSelectedGeometry('geo-1') // clears active op via its own rule
    useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op-7' } }))
    useCamStore.getState().setSelectedMove(move({ operationId: 'op-7' }))

    const st = useCamStore.getState()
    expect(st.viewer.selectedMove?.operationId).toBe('op-7')
    expect(st.viewer.selectedMove?.moveIndex).toBe(3)
    expect(st.viewer.selectedGeometryId).toBeNull()
    // Picking a move does NOT re-render the toolpath: activeOperationId untouched.
    expect(st.project.activeOperationId).toBe('op-7')
  })

  it('(b) clearing the move (null) leaves active op + other selection untouched', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op-7' } }))
    useCamStore.getState().setSelectedMove(move({ operationId: 'op-7' }))
    useCamStore.getState().setSelectedMove(null)
    const st = useCamStore.getState()
    expect(st.viewer.selectedMove).toBeNull()
    // Falls back to the owning operation's properties: activeOperationId stays.
    expect(st.project.activeOperationId).toBe('op-7')
  })
})

describe('competing selectors clear selectedMove', () => {
  const arm = () => useCamStore.getState().setSelectedMove(move())

  it('(c1) setSelectedGeometry clears the move', () => {
    arm(); useCamStore.getState().setSelectedGeometry('geo-1')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
  })
  it('(c2) setSelectedNest clears the move', () => {
    arm(); useCamStore.getState().setSelectedNest('nest-1')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
  })
  it('(c3) setSelectedStock clears the move', () => {
    arm(); useCamStore.getState().setSelectedStock('stk-1')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
  })
  it('(c4) setSelectedLayer clears the move', () => {
    arm(); useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
  })
  it('(c5) setSelectedFolder clears the move', () => {
    arm(); useCamStore.getState().setSelectedFolder('folder-1', 'geometry')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
  })
  it('(c6) setActiveOperation(non-null) clears a stale move from another op', () => {
    arm(); useCamStore.getState().setActiveOperation('op-other')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
    expect(useCamStore.getState().project.activeOperationId).toBe('op-other')
  })
})

describe('selectedMove is transient', () => {
  it('(d) is NOT in the persisted partialize slice', () => {
    useCamStore.getState().setSelectedMove(move())
    const slice = persistPartialize(useCamStore.getState())
    expect('viewer' in slice).toBe(false)
    expect(JSON.stringify(slice)).not.toContain('selectedMove')
  })
})
