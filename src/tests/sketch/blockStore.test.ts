// SKC-BLOCKS Stage 1: CAM store actions group/explode a block as ONE undo step,
// select the result, and refuse by name. Worker + localStorage are stubbed (node
// env) -- solve dispatch is exercised but its response is not (block solver
// correctness lives in blocks.test.ts against a real GcsWrapper).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Sketch, SketchBlockEntity } from '../../lib/sketch/types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

// Two lines joined at a corner by one coincident constraint (wholly internal).
function twoLineSketch(): Sketch {
  return {
    id: 'sk', layerId: 'L',
    entities: [
      { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'l2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 8 } },
    ],
    constraints: [
      { id: 'c12', kind: 'coincident', a: { entityId: 'l1', site: 'end' }, b: { entityId: 'l2', site: 'start' } },
    ],
    dimensions: [],
    solveStatus: null,
  }
}

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null, sketchSolveStatus: null, sketchSelectedIds: [],
    sketchHistory: [], projectHistory: [], canUndo: false,
    sketchBlockEditId: null, sketchBlockEditOuterIds: null,
  })
})

describe('groupSketchSelectionIntoBlock / explodeSketchSelectedBlock', () => {
  it('groups the selection into a block, selects it, absorbs the internal constraint', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()

    const after = useCamStore.getState()
    const sk = after.activeSketch!
    expect(sk.entities.map((e) => e.id)).not.toContain('l1')
    expect(sk.entities.map((e) => e.id)).not.toContain('l2')
    const block = sk.entities.find((e) => e.kind === 'block') as SketchBlockEntity
    expect(block).toBeTruthy()
    expect(block.members.entities.length).toBe(2)
    expect(block.members.constraints.map((c) => c.id)).toEqual(['c12'])
    expect(sk.constraints).toEqual([]) // absorbed
    expect(after.sketchSelectedIds).toEqual([block.id])
  })

  it('explode restores the two lines + constraint, selects the members', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    // selection is now [blockId]
    useCamStore.getState().explodeSketchSelectedBlock()

    const sk = useCamStore.getState().activeSketch!
    expect(sk.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2'])
    expect(sk.constraints.map((c) => c.id)).toEqual(['c12'])
    expect(useCamStore.getState().sketchSelectedIds.sort()).toEqual(['l1', 'l2'])
  })

  it('group then undo restores the loose lines (ONE undo step)', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.kind === 'block')).toBe(true)

    useCamStore.getState().undo()
    const sk = useCamStore.getState().activeSketch!
    expect(sk.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2'])
    expect(sk.entities.some((e) => e.kind === 'block')).toBe(false)
  })

  it('refuses a cross-boundary constraint WITHOUT mutating the document', () => {
    const sk = twoLineSketch()
    sk.entities.push({ id: 'l3', kind: 'line', construction: false, start: { x: 10, y: 8 }, end: { x: 0, y: 8 } })
    sk.constraints.push({ id: 'cross', kind: 'coincident', a: { entityId: 'l2', site: 'end' }, b: { entityId: 'l3', site: 'start' } })
    useCamStore.setState({ activeSketch: sk, sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()

    // Refused: no block created, document unchanged.
    const out = useCamStore.getState().activeSketch!
    expect(out.entities.some((e) => e.kind === 'block')).toBe(false)
    expect(out.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2', 'l3'])
  })

  it('no-ops cleanly with nothing selected or no sketch', () => {
    useCamStore.getState().groupSketchSelectionIntoBlock() // no sketch: no throw
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: [] })
    useCamStore.getState().groupSketchSelectionIntoBlock() // empty selection
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.kind === 'block')).toBe(false)
  })
})

describe('setSketchBlockScale / setSketchBlockRotation (SKC-BLOCKS Stage 2)', () => {
  it('setSketchBlockScale rewrites the block field as ONE undo step', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    const blockId = useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id

    useCamStore.getState().setSketchBlockScale(blockId, 3)
    const block = useCamStore.getState().activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block.scale).toBe(3)

    useCamStore.getState().undo()
    const reverted = useCamStore.getState().activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(reverted.scale).toBe(1) // back to the grouped default
  })

  it('setSketchBlockRotation rewrites the block field (deg -> rad) as ONE undo step', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    const blockId = useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id

    useCamStore.getState().setSketchBlockRotation(blockId, 90)
    const block = useCamStore.getState().activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block.rotation).toBeCloseTo(Math.PI / 2, 9)

    useCamStore.getState().undo()
    const reverted = useCamStore.getState().activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(reverted.rotation).toBe(0) // back to the grouped default
  })

  it('refuses an invalid scale by name, leaving the document untouched', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    const blockId = useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id

    useCamStore.getState().setSketchBlockScale(blockId, -5)
    const block = useCamStore.getState().activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block.scale).toBe(1) // unchanged
  })

  it('no-ops cleanly (no throw) with no sketch or an unknown block id', () => {
    useCamStore.getState().setSketchBlockScale('nope', 2) // no sketch: no throw
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: [] })
    useCamStore.getState().setSketchBlockScale('nope', 2) // no matching block
    useCamStore.getState().setSketchBlockRotation('nope', 45)
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.kind === 'block')).toBe(false)
  })
})

describe('beginSketchBlockEdit / finishSketchBlockEdit / cancelSketchBlockEdit (SKC-BLOCKS Stage 4)', () => {
  it('begin -> finish (no edit) round-trips: same block id, members restored, session cleared', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    const blockId = useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id

    useCamStore.getState().beginSketchBlockEdit(blockId)
    let s = useCamStore.getState()
    expect(s.sketchBlockEditId).toBe(blockId)
    expect(s.sketchBlockEditOuterIds).toEqual([])
    expect(s.activeSketch!.entities.some((e) => e.kind === 'block')).toBe(false)
    expect(s.activeSketch!.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2'])
    expect(s.sketchSelectedIds.sort()).toEqual(['l1', 'l2'])

    useCamStore.getState().finishSketchBlockEdit()
    s = useCamStore.getState()
    expect(s.sketchBlockEditId).toBeNull()
    expect(s.sketchBlockEditOuterIds).toBeNull()
    const block = s.activeSketch!.entities.find((e) => e.kind === 'block') as SketchBlockEntity
    expect(block).toBeTruthy()
    expect(block.id).toBe(blockId) // SAME id -- no identity loss
    expect(s.sketchSelectedIds).toEqual([blockId])
  })

  it('begin -> edit a member -> finish preserves the block id and folds the edit in', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    const blockId = useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id

    useCamStore.getState().beginSketchBlockEdit(blockId)
    // Simulate an in-session edit: move l1's end point.
    useCamStore.setState((st) => ({
      activeSketch: {
        ...st.activeSketch!,
        entities: st.activeSketch!.entities.map((e) =>
          e.id === 'l1' && e.kind === 'line' ? { ...e, end: { x: 20, y: 0 } } : e,
        ),
      },
    }))
    useCamStore.getState().finishSketchBlockEdit()

    const s = useCamStore.getState()
    expect(s.sketchBlockEditId).toBeNull()
    const block = s.activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block.kind).toBe('block')
    const l1 = block.members.entities.find((e) => e.id === 'l1')
    expect(l1).toBeTruthy()
  })

  it('cancelSketchBlockEdit restores the pre-edit block verbatim as ONE forward undo step', () => {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    const blockId = useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id

    useCamStore.getState().beginSketchBlockEdit(blockId)
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.kind === 'block')).toBe(false)

    useCamStore.getState().cancelSketchBlockEdit()
    const s = useCamStore.getState()
    expect(s.sketchBlockEditId).toBeNull()
    expect(s.sketchBlockEditOuterIds).toBeNull()
    const block = s.activeSketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block).toBeTruthy()
    expect(block.kind).toBe('block')
    expect(s.sketchSelectedIds).toEqual([blockId])

    // Cancel pushed history forward (not popped): Undo steps back INTO the
    // detached-member state, not past the original group.
    useCamStore.getState().undo()
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.kind === 'block')).toBe(false)
  })

  it('no-ops cleanly (no throw) with no sketch, a non-block id, or no open session', () => {
    useCamStore.getState().beginSketchBlockEdit('nope') // no sketch: no throw
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: [] })
    useCamStore.getState().beginSketchBlockEdit('l1') // not a block: refused by name
    expect(useCamStore.getState().sketchBlockEditId).toBeNull()
    useCamStore.getState().finishSketchBlockEdit() // no session open: no-op
    useCamStore.getState().cancelSketchBlockEdit() // no session open: no-op
    expect(useCamStore.getState().activeSketch!.entities.map((e) => e.id).sort()).toEqual(['l1', 'l2'])
  })
})

describe('insertSketchBlockInstance + definition-edit propagation (SKC-BLOCKS Stage 5)', () => {
  // Group the two-line sketch into a block and return the block id.
  function groupAndGetBlockId(): string {
    useCamStore.setState({ activeSketch: twoLineSketch(), sketchSelectedIds: ['l1', 'l2'] })
    useCamStore.getState().groupSketchSelectionIntoBlock()
    return useCamStore.getState().activeSketch!.entities.find((e) => e.kind === 'block')!.id
  }

  it('insertSketchBlockInstance hoists into a shared definition + places a second instance', () => {
    const blockId = groupAndGetBlockId()
    useCamStore.setState({ sketchSelectedIds: [blockId] })
    useCamStore.getState().insertSketchBlockInstance()

    const sk = useCamStore.getState().activeSketch!
    const instances = sk.entities.filter((e): e is SketchBlockEntity => e.kind === 'block')
    expect(instances.length).toBe(2)
    // ONE shared definition; both instances reference it.
    expect(Object.keys(sk.blockDefs ?? {}).length).toBe(1)
    expect(new Set(instances.map((i) => i.defId)).size).toBe(1)
    expect(instances.every((i) => i.defId !== undefined)).toBe(true)
    // The new instance is selected.
    expect(useCamStore.getState().sketchSelectedIds.length).toBe(1)
  })

  it('refuses to insert an instance when no single block is selected', () => {
    const blockId = groupAndGetBlockId()
    useCamStore.setState({ sketchSelectedIds: [] }) // nothing selected
    useCamStore.getState().insertSketchBlockInstance()
    // Still just the one block, no definition created.
    const sk = useCamStore.getState().activeSketch!
    expect(sk.entities.filter((e) => e.kind === 'block').length).toBe(1)
    expect(Object.keys(sk.blockDefs ?? {}).length).toBe(0)
    expect(blockId).toBeTruthy()
  })

  it('editing one instance updates EVERY instance (store-level propagation)', () => {
    const blockId = groupAndGetBlockId()
    useCamStore.setState({ sketchSelectedIds: [blockId] })
    useCamStore.getState().insertSketchBlockInstance()
    const s0 = useCamStore.getState().activeSketch!
    const instB = s0.entities.filter((e): e is SketchBlockEntity => e.kind === 'block')
      .find((e) => e.id !== blockId)!.id

    // Edit instance A (blockId): widen l1 from x-end 10 to x-end 40.
    useCamStore.getState().beginSketchBlockEdit(blockId)
    useCamStore.setState((st) => ({
      activeSketch: {
        ...st.activeSketch!,
        entities: st.activeSketch!.entities.map((e) =>
          e.id === 'l1' && e.kind === 'line' ? { ...e, end: { x: 40, y: 0 } } : e,
        ),
      },
    }))
    useCamStore.getState().finishSketchBlockEdit()

    const s1 = useCamStore.getState().activeSketch!
    // The shared definition carries the widened member. Members are stored in the
    // definition's LOCAL frame (origin-shifted), so assert the frame-invariant
    // WIDTH (end.x - start.x) is now 40, up from the original 10.
    const defId = s1.entities.filter((e): e is SketchBlockEntity => e.kind === 'block')[0].defId!
    const defL1 = s1.blockDefs![defId].members.entities.find((e) => e.id === 'l1') as any
    expect(defL1.end.x - defL1.start.x).toBeCloseTo(40, 6)
    // Instance B still references the same definition -> it renders the change.
    const bAfter = s1.entities.find((e): e is SketchBlockEntity => e.id === instB)!
    expect(bAfter.defId).toBe(defId)
  })
})
