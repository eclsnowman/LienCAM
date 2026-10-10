import { beforeEach, describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { useFormStore } from '../../form/formStore'
import { boxCage } from '../../form/starters'

const st = () => useFormStore.getState()
const duplicateWords = (plane: string) => `Duplicate mirrors half a form: this form already reaches across ${plane}, so the copy would overlap it. Delete the faces on one side first, or move the mirror plane.`
const unchanged = (before: ReturnType<typeof st>) => {
  expect(st().cage).toBe(before.cage)
  expect(st().history).toBe(before.history)
  expect(st().selection).toBe(before.selection)
  expect(st().positionsVersion).toBe(before.positionsVersion)
  expect(st().topologyVersion).toBe(before.topologyVersion)
}

describe('WO-2496 production button store routes', () => {
  beforeEach(() => st().openSession({ featureId: null, name: 'Refusal', cage: boxCage() }))

  it('Duplicate uses X = 0 with no mirror and preserves the session on refusal', () => {
    const before = st()
    st().mirrorDuplicateForm()
    expect(st().notice).toBe(duplicateWords('X = 0'))
    unchanged(before)
  })

  it.each(['x', 'y', 'z'] as const)('Duplicate names the active %s plane, using the status rounding', (mode) => {
    st().setSymmetry(mode)
    st().setSymmetryAt(mode === 'z' ? 20 : 0.00001)
    const before = st()
    st().mirrorDuplicateForm()
    expect(st().notice).toBe(duplicateWords(`${mode.toUpperCase()} = ${mode === 'z' ? 20 : 0}`))
    unchanged(before)
  })

  it('Duplicate names a selection-defined plane', () => {
    useFormStore.setState({ symmetry: 'p', symmetryAt: 0, symmetryNormal: [1, 0, 0] })
    const before = st()
    st().mirrorDuplicateForm()
    expect(st().notice).toBe(duplicateWords('1x + 0y + 0z = 0'))
    unchanged(before)
  })

  it('Duplicate names an offset mirror at X = 20', () => {
    const cage = boxCage()
    st().openSession({ featureId: null, name: 'Offset', cage: { ...cage, positions: cage.positions.map((p) => [p[0] + 20, p[1], p[2]]) } })
    st().setSymmetry('x')
    st().setSymmetryAt(20)
    const before = st()
    st().mirrorDuplicateForm()
    expect(st().notice).toBe(duplicateWords('X = 20'))
    unchanged(before)
  })

  it('Duplicate uses the default plane when circular symmetry is on', () => {
    st().setSymmetry('c4')
    const before = st()
    st().mirrorDuplicateForm()
    expect(st().notice).toBe(duplicateWords('X = 0'))
    expect(st().symmetry).toBe('c4')
    unchanged(before)
  })

  it('Duplicate leaves a successfully validated across-plane copy allowed', () => {
    st().setSymmetry('x')
    st().setSymmetryAt(10)
    st().mirrorDuplicateForm()
    expect(st().notice).toMatch(/^Mirrored a copy across the mirror plane:/)
    expect(st().history.past).toHaveLength(1)
  })

  it('Duplicate still mirrors the findings half form, one face from X = 0 to 40', () => {
    const cage: Cage = { positions: [[0, 0, 0], [40, 0, 0], [40, 0, 40], [0, 0, 40]], faces: [[0, 1, 2, 3]], creases: [] }
    st().openSession({ featureId: null, name: 'Half', cage })
    st().mirrorDuplicateForm()
    expect(st().notice).toBe('Mirrored a copy across the YZ plane (X = 0; no mirror was on): 2 seam points shared')
    expect(st().cage.faces).toHaveLength(2)
    expect(st().cage.positions.map((p) => p[0]).sort((a, b) => a - b)).toEqual([-40, -40, 0, 0, 40, 40])
    expect(st().history.past).toHaveLength(1)
    st().undo()
    expect(st().cage).toEqual(cage)
  })

  const strip = (): Cage => ({ positions: [[0, 0, 0], [10, 5, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]], faces: [[0, 1, 2, 3, 4]], creases: [] })
  const select = (edges: string[], points: number[] = []) => st().setSelection({ edges, points, faces: [] })

  it('Straighten refuses one edge without any geometry or undo change', () => {
    select([edgeKey(0, 1)])
    const before = st()
    st().straightenSelection()
    expect(st().notice).toBe('One edge is already straight - select two or more edges in a row (or three or more points).')
    unchanged(before)
  })

  it('Straighten still moves the middle of a two-edge chain and undoes once', () => {
    st().openSession({ featureId: null, name: 'Chain', cage: strip() })
    select(['0:1', '1:2'])
    const before = st().cage
    st().straightenSelection()
    expect(st().cage.positions[1]).toEqual([10, 0, 0])
    expect(st().notice).toBe('Straightened 1 line, 1 point moved (the farthest was 5.00 mm off)')
    expect(st().history.past).toHaveLength(1)
    st().undo()
    expect(st().cage).toEqual(before)
  })

  it('Straighten treats branching sets as best-fit points, not loops', () => {
    select(['0:1', '0:3', '0:4'])
    st().straightenSelection()
    expect(st().notice).toMatch(/^Straightened 1 line, 4 points moved/)
    expect(st().history.past).toHaveLength(1)
  })

  it('Straighten does not call a loop plus a disconnected single edge loops only', () => {
    st().openSession({ featureId: null, name: 'Mixed', cage: { ...strip(), positions: [...strip().positions, [30, 0, 0], [40, 0, 0]], faces: [[0, 1, 2, 3, 4], [2, 5, 6, 3]] } })
    select(['0:1', '1:2', '2:3', '3:4', '0:4', '5:6'])
    const before = st()
    st().straightenSelection()
    expect(st().notice).toBe('Select a chain of edges (or three or more points) to straighten')
    unchanged(before)
  })

  it('Straighten explains coincident open-chain ends without claiming a loop', () => {
    const cage = strip()
    cage.positions[2] = [...cage.positions[0]]
    st().openSession({ featureId: null, name: 'Coincident', cage })
    select(['0:1', '1:2'])
    const before = st()
    st().straightenSelection()
    expect(st().notice).toBe('The chain ends are in the same place - move an end to define a line to straighten along.')
    unchanged(before)
  })

  it('Straighten can still act on three loose points despite a selected single edge', () => {
    select(['0:1'], [2, 3, 4])
    st().straightenSelection()
    expect(st().notice).toMatch(/^Straightened 1 line, 3 points moved/)
  })
})
