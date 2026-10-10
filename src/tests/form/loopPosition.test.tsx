// @vitest-environment jsdom
//
// Form stage 18: Insert loop at a chosen position - the palette's "Loop at"
// fraction, measured from one side of the ring all the way round.

import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { insertEdgeLoop } from '../../form/edgeLoop'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'
import { findPairs, unpairedCount } from '../../form/symmetry'
import { FormPanel } from '../../components/model3d/form/FormPanel'

/** the same cage with its points renumbered by a fixed shuffle (so "lower-numbered end" means nothing) */
function shuffled(c: Cage): Cage {
  const n = c.positions.length
  const order = Array.from({ length: n }, (_, i) => i)
  let seed = 7
  for (let i = n - 1; i > 0; i--) { seed = (seed * 16807) % 2147483647; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]] }
  const newOf = new Map(order.map((old, i) => [old, i]))
  return { positions: order.map((old) => c.positions[old]), faces: c.faces.map((f) => f.map((p) => newOf.get(p)!)), creases: c.creases }
}
const at = (c: Cage, x: number, y: number, z: number) => c.positions.findIndex((p) => p[0] === x && p[1] === y && p[2] === z)

describe('insertEdgeLoop at a position', () => {
  it('a quarter of the way up a ring round the box: every new point at the same height, whatever the numbering', () => {
    const c = shuffled(boxCage({ segments: { x: 2, y: 2, z: 2 } }))
    const a = at(c, 0, -20, 0), b = at(c, 0, -20, 20)
    for (const from of [a, b]) {
      const r = insertEdgeLoop(c, edgeKey(a, b), 0.25, from)!
      expect(validateCage(r.cage, true).problems).toEqual([])
      expect(r.newPoints).toHaveLength(8)
      const z = r.newPoints.map((p) => r.cage.positions[p][2])
      expect(new Set(z)).toEqual(new Set([from === a ? 5 : 15]))
    }
  })

  it('without a position it is the middle, as before', () => {
    const c = shuffled(boxCage({ segments: { x: 2, y: 2, z: 2 } }))
    const r = insertEdgeLoop(c, edgeKey(at(c, 0, -20, 0), at(c, 0, -20, 20)))!
    expect(new Set(r.newPoints.map((p) => r.cage.positions[p][2]))).toEqual(new Set([10]))
  })
})

describe('the store and the palette', () => {
  const session = {
    active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
    canUndo: false, canRedo: false, railSections: [],
  }
  beforeEach(() => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: shuffled(boxCage({ segments: { x: 2, y: 2, z: 2 } })) })
    useFormStore.getState().setLoopPosition(0.5)
  })

  it('the palette row sets the position; the loop lands there, measured from the selected edge\'s lower end', () => {
    render(<FormPanel session={session} />)
    const input = screen.getByLabelText('Insert loop position') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0.2' } })
    fireEvent.blur(input)
    expect(useFormStore.getState().loopPosition).toBeCloseTo(0.2, 9)
    const c = useFormStore.getState().cage
    // a vertical edge picked with its upper end first in the key order does not matter
    useFormStore.getState().setSelection({ points: [], edges: [edgeKey(at(c, 20, 0, 20), at(c, 20, 0, 0))], faces: [] })
    useFormStore.getState().insertLoop()
    const st = useFormStore.getState()
    expect(st.notice).toBe('Inserted an edge loop (8 edges) at 0.2 of each edge from the selected edge\'s lower end; the Loop slider moves it until the next change')
    const zs = new Set(st.cage.positions.slice(c.positions.length).map((p) => p[2]))
    expect(zs).toEqual(new Set([4]))
  })

  it('with Mirror X the mirrored loop is measured from the mirror of that end, so the two stay mirror images', () => {
    const st = useFormStore.getState()
    st.setSymmetry('x')
    st.setLoopPosition(0.25)
    const c = useFormStore.getState().cage
    // an X-direction edge on top at +X: its ring runs round the box in the x = 0..20 band; the mirror ring in -20..0
    useFormStore.getState().setSelection({ points: [], edges: [edgeKey(at(c, 0, 0, 40), at(c, 20, 0, 40))], faces: [] })
    useFormStore.getState().insertLoop()
    const after = useFormStore.getState()
    const xs = [...new Set(after.cage.positions.slice(c.positions.length).map((p) => p[0]))].sort((a, b) => a - b)
    expect(xs).toEqual([-5, 5])
    expect(after.cage.positions.length - c.positions.length).toBe(16)
  })

  it('Mirror X on an edge that crosses the mirror plane (its own image, ends swapped): two loops at t and 1 - t, still symmetric (WO-2163 audit)', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 3, y: 2, z: 2 } }) })
    const st = useFormStore.getState()
    st.setSymmetry('x')
    st.setLoopPosition(0.25)
    const c = useFormStore.getState().cage
    const near = (x: number, y: number, z: number) => c.positions.findIndex((p) => Math.abs(p[0] - x) < 1e-9 && p[1] === y && p[2] === z)
    const edge = edgeKey(near(-20 / 3, 0, 40), near(20 / 3, 0, 40))
    useFormStore.getState().setSelection({ points: [], edges: [edge], faces: [] })
    useFormStore.getState().insertLoop()
    const after = useFormStore.getState()
    const xs = [...new Set(after.cage.positions.slice(c.positions.length).map((p) => Math.round(p[0] * 1e6) / 1e6))].sort((a, b) => a - b)
    expect(xs).toEqual([-3.333333, 3.333333])
    expect(after.cage.positions.length - c.positions.length).toBe(16)
    expect(unpairedCount(findPairs(after.cage, 'x', 0))).toBe(0)
    expect(validateCage(after.cage, true).problems).toEqual([])
    // at 0.5 the two are one loop, on the plane
    useFormStore.getState().undo()
    useFormStore.getState().setLoopPosition(0.5)
    useFormStore.getState().setSelection({ points: [], edges: [edge], faces: [] })
    useFormStore.getState().insertLoop()
    const mid = useFormStore.getState()
    expect(mid.cage.positions.length - c.positions.length).toBe(8)
    expect(new Set(mid.cage.positions.slice(c.positions.length).map((p) => Math.abs(p[0]) < 1e-9))).toEqual(new Set([true]))
  })

  it('keeps the position inside the edge', () => {
    useFormStore.getState().setLoopPosition(0)
    expect(useFormStore.getState().loopPosition).toBe(0.01)
    useFormStore.getState().setLoopPosition(1)
    expect(useFormStore.getState().loopPosition).toBe(0.99)
    useFormStore.getState().setLoopPosition(Number.NaN)
    expect(useFormStore.getState().loopPosition).toBe(0.5)
  })
})

describe('the live Loop slider', () => {
  const st = () => useFormStore.getState()
  const setup = () => {
    st().openSession({ featureId: null, name: 'F', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
    const c = st().cage
    st().setLoopPosition(0.5)
    st().setSelection({ points: [], edges: [edgeKey(at(c, 0, -20, 0), at(c, 0, -20, 20))], faces: [] })
    st().insertLoop()
    return c
  }
  const heights = () => { const c = st().cage; return [...new Set(c.positions.filter((p) => p[2] > 0 && p[2] < 20).map((p) => p[2]))] }

  it('right after Insert loop, moving the slider moves that loop (no second loop), one undo step in all', () => {
    const before = setup()
    expect(heights()).toEqual([10])
    const n = st().cage.positions.length
    st().setLoopPosition(0.25)
    expect(heights()).toEqual([5])
    st().setLoopPosition(0.8)
    expect(heights()).toEqual([16])
    expect(st().cage.positions).toHaveLength(n)
    expect(st().selection.edges).toHaveLength(8)
    st().undo()
    expect(st().cage.positions).toEqual(before.positions)
  })

  it('after any other change the slider only sets the position for the next Insert loop', () => {
    setup()
    st().setSelection({ points: [0], edges: [], faces: [] })
    st().beginMove({ extrude: false })
    st().moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1])
    st().endDrag()
    const moved = st().cage
    st().setLoopPosition(0.25)
    expect(st().cage).toBe(moved)
    expect(st().loopPosition).toBe(0.25)
  })

  it('the palette slider drives it', () => {
    cleanup()
    setup()
    const session = {
      active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
      canUndo: false, canRedo: false, railSections: [],
    }
    render(<FormPanel session={session} />)
    fireEvent.change(screen.getByLabelText('Loop position slider'), { target: { value: '0.3' } })
    expect(heights()).toEqual([6])
  })
})
