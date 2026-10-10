// Form: Grow, Shrink, Select all, and Loop on points (WO-2506).

import { describe, expect, it } from 'vitest'
import { edgeKey } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { growSelection, pointLoop, selectAll, shrinkSelection } from '../../form/topoTools'
import { useFormStore } from '../../form/formStore'

const none = { points: [], edges: [], faces: [] }
// a 6 x 6 sheet of 10 mm faces, 7 x 7 points (a 3 x 3 block round an inner face stays clear of its border)
const sheet = () => planeCage({ size: { x: 60, y: 60, z: 0 }, segments: { x: 6, y: 6, z: 1 } })
const faceAt = (c: ReturnType<typeof sheet>, x: number, y: number) =>
  c.faces.findIndex((f) => { const cx = f.reduce((s, p) => s + c.positions[p][0], 0) / 4, cy = f.reduce((s, p) => s + c.positions[p][1], 0) / 4; return Math.abs(cx - x) < 1e-9 && Math.abs(cy - y) < 1e-9 })
const pointAt = (c: ReturnType<typeof sheet>, x: number, y: number) => c.positions.findIndex((p) => Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9)

describe('grow and shrink', () => {
  it('a face grows to the 3 x 3 block round it (faces sharing a corner), and that block shrinks back to it', () => {
    const c = sheet()
    const f = faceAt(c, -5, -5)
    const grown = growSelection(c, { ...none, faces: [f] })
    expect(grown.faces).toHaveLength(9)
    expect(shrinkSelection(c, grown).faces).toEqual([f])
  })

  it('a point grows to its neighbours along edges; shrink keeps only points whose every neighbour is selected', () => {
    const c = sheet()
    const p = pointAt(c, 0, 0)
    const grown = growSelection(c, { ...none, points: [p] })
    expect(grown.points).toHaveLength(5)
    expect(shrinkSelection(c, grown).points).toEqual([p])
  })

  it('an edge grows to the edges sharing its ends; shrink brings it back', () => {
    const c = sheet()
    const e = edgeKey(pointAt(c, 0, 0), pointAt(c, 10, 0))
    const grown = growSelection(c, { ...none, edges: [e] })
    // 4 edges at each interior end, the edge itself counted once: 7
    expect(grown.edges).toHaveLength(7)
    expect(shrinkSelection(c, grown).edges).toEqual([e])
  })

  it('shrinking a selection with no inside empties it; growing a whole closed form changes nothing', () => {
    const c = sheet()
    expect(shrinkSelection(c, { ...none, faces: [faceAt(c, -5, -5)] }).faces).toEqual([])
    const box = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const all = box.faces.map((_, i) => i)
    expect(growSelection(box, { ...none, faces: all }).faces).toEqual(all)
    expect(shrinkSelection(box, { ...none, faces: all }).faces).toEqual(all)
  })
})

describe('select all', () => {
  it('every face by default; every edge or every point when that is what is selected', () => {
    const c = boxCage({ segments: { x: 1, y: 1, z: 1 } })
    expect(selectAll(c, none).faces).toHaveLength(6)
    expect(selectAll(c, { ...none, edges: [edgeKey(c.faces[0][0], c.faces[0][1])] }).edges).toHaveLength(12)
    expect(selectAll(c, { ...none, points: [0] }).points).toHaveLength(8)
  })
})

describe('Loop on points (WO-2506)', () => {
  it('on an open sheet a row of points is an open run: two neighbours in a row give the whole row of 7', () => {
    const c = sheet()
    const row = pointLoop(c, [pointAt(c, 0, 10), pointAt(c, 10, 10)])!
    expect(row).toHaveLength(7)
    expect(row.every((p) => Math.abs(c.positions[p][1] - 10) < 1e-9)).toBe(true)
  })

  it('one inner point of the sheet lies on a row and a column: no one answer', () => {
    const c = sheet()
    expect(pointLoop(c, [pointAt(c, 0, 10)])).toBeNull()
  })

  it('a point on the sheet border lies on the border run and an inward run: a neighbour along the border picks the border', () => {
    const c = sheet()
    // a border point's only straight runs: along the border (7 points) and inward (7 points); two answers
    expect(pointLoop(c, [pointAt(c, 0, -30)])).toBeNull()
    expect(pointLoop(c, [pointAt(c, 0, -30), pointAt(c, 10, -30)])).toHaveLength(7)
  })
})

describe('the store', () => {
  it('Grow, Shrink and All replace the selection and say what is selected', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: sheet() })
    const c = useFormStore.getState().cage
    useFormStore.getState().setSelection({ ...none, faces: [faceAt(c, 5, 5)] })
    useFormStore.getState().growSelection()
    expect(useFormStore.getState().selection.faces).toHaveLength(9)
    expect(useFormStore.getState().notice).toBe('Grown to 9 faces')
    useFormStore.getState().shrinkSelection()
    expect(useFormStore.getState().selection.faces).toHaveLength(1)
    useFormStore.getState().selectAll()
    expect(useFormStore.getState().selection.faces).toHaveLength(36)
    expect(useFormStore.getState().notice).toBe('Selected all: 36 faces')
  })
})
