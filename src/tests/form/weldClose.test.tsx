// @vitest-environment jsdom
//
// Form: Weld close (weld by distance) - points closer than the palette's Weld
// distance become one, among the selection or across the whole form.

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { weldByDistance } from '../../form/topoTools'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'
import { FormPanel } from '../../components/model3d/form/FormPanel'

const openEdges = (c: Cage) => {
  const count = new Map<string, number>()
  for (const loop of c.faces) for (let i = 0; i < loop.length; i++) { const k = edgeKey(loop[i], loop[(i + 1) % loop.length]); count.set(k, (count.get(k) ?? 0) + 1) }
  return [...count.values()].filter((n) => n === 1).length
}
const shift = (c: Cage, dx: number): Cage => ({ ...c, positions: c.positions.map((p) => [p[0] + dx, p[1], p[2]]) })
/** two 20 mm sheets side by side, their facing sides 1 mm apart (x = -0.5 and x = 0.5) */
function twoSheets(): Cage {
  const sheet = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 1, y: 2, z: 1 } })
  const a = shift(sheet, -10.5), b = shift(sheet, 10.5)
  return { positions: [...a.positions, ...b.positions], faces: [...a.faces, ...b.faces.map((f) => f.map((p) => p + a.positions.length))], creases: [] }
}
const at = (c: Cage, x: number, y: number) => c.positions.findIndex((p) => Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9)

describe('weldByDistance', () => {
  it('across the whole form: every facing pair within the distance welds, stitching two sheets into one in one step', () => {
    const c = twoSheets()
    expect(c.positions).toHaveLength(12)
    expect(openEdges(c)).toBe(12)
    const r = weldByDistance(c, [], 1.5)!
    expect(r.groups).toBe(3)
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.cage.positions).toHaveLength(9)
    expect(openEdges(r.cage)).toBe(8)
    // each merged point sits at its pair's centroid, on the seam
    for (const p of r.points) expect(r.cage.positions[p][0]).toBeCloseTo(0, 12)
    expect(r.points.map((p) => r.cage.positions[p][1]).sort((a, b) => a - b)).toEqual([-10, 0, 10])
  })

  it('points farther apart than the distance stay; nothing that close gives null', () => {
    expect(weldByDistance(twoSheets(), [], 0.99)).toBeNull()
    expect(weldByDistance(boxCage({ segments: { x: 2, y: 2, z: 2 } }), [], 5)).toBeNull()
  })

  it('only the candidates weld when some are given', () => {
    const c = twoSheets()
    const r = weldByDistance(c, [at(c, -0.5, -10), at(c, 0.5, -10), at(c, -0.5, 10)], 1.5)!
    expect(r.groups).toBe(1)
    expect(r.cage.positions).toHaveLength(11)
    expect(r.cage.positions[r.points[0]]).toEqual([0, -10, 0])
  })

  it('points joined through a chain weld as one group, even when the chain\'s ends are farther apart than the distance', () => {
    // a row at x = -0.8, 0, 0.8: neighbours 0.8 apart, the ends 1.6 apart
    const c = planeCage({ size: { x: 1.6, y: 40, z: 0 }, segments: { x: 2, y: 1, z: 1 } })
    const row = c.positions.map((p, i) => [p, i] as const).filter(([p]) => p[1] < 0).map(([, i]) => i)
    expect(row).toHaveLength(3)
    const r = weldByDistance(c, row, 1)!
    expect(r.groups).toBe(1)
    expect(r.cage.positions).toHaveLength(4)
    expect(r.cage.positions[r.points[0]].map((v) => Math.abs(v) < 1e-12 ? 0 : v)).toEqual([0, -20, 0])
    // the two quads keep their far sides and become triangles
    expect(r.cage.faces.map((f) => f.length)).toEqual([3, 3])
  })
})

describe('the store and the palette', () => {
  const session = {
    active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
    canUndo: false, canRedo: false, railSections: [],
  }
  beforeEach(() => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: twoSheets() })
    useFormStore.getState().setWeldDistance(1)
  })

  it('with nothing selected Weld close stitches the form, selects the merged points and undoes in one step', () => {
    const st = useFormStore.getState()
    st.weldCloseSelection()
    const after = useFormStore.getState()
    expect(after.cage.positions).toHaveLength(9)
    expect(after.selection.points).toHaveLength(3)
    expect(after.notice).toBe('Welded 3 groups of close points in the form (3 points fewer)')
    after.undo()
    expect(useFormStore.getState().cage.positions).toHaveLength(12)
  })

  it('with points selected only those weld', () => {
    const c = useFormStore.getState().cage
    const picks = [at(c, -0.5, -10), at(c, 0.5, -10), at(c, -0.5, 0), at(c, 0.5, 0), at(c, 0.5, 10)]
    picks.forEach((index, i) => useFormStore.getState().select({ kind: 'point', index }, i > 0))
    useFormStore.getState().weldCloseSelection()
    const after = useFormStore.getState()
    // the two selected pairs stitch one edge; the lone (0.5, 10) and the unselected (-0.5, 10) stay apart
    expect(after.cage.positions).toHaveLength(10)
    expect(openEdges(after.cage)).toBe(10)
    expect(after.notice).toBe('Welded 2 groups of close points among the selected points (2 points fewer)')
    expect(after.selection.points.map((p) => after.cage.positions[p][1]).sort((a, b) => a - b)).toEqual([-10, 0])
  })

  it('a distance too small says so and leaves the cage alone', () => {
    const st = useFormStore.getState()
    st.setWeldDistance(0.5)
    const before = st.cage
    st.weldCloseSelection()
    expect(useFormStore.getState().cage).toBe(before)
    expect(useFormStore.getState().notice).toMatch(/No two points in the form are within 0\.5 mm/)
  })

  it('the palette\'s Weld row sets the distance Weld close uses', () => {
    render(<FormPanel session={session} />)
    expect(screen.getByTestId('form-weld-distance')).toBeTruthy()
    const input = screen.getByLabelText('Weld close distance') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0.25' } })
    fireEvent.blur(input)
    expect(useFormStore.getState().weldDistance).toBeCloseTo(0.25, 9)
    useFormStore.getState().weldCloseSelection()
    expect(useFormStore.getState().cage.positions).toHaveLength(12)
  })
})
