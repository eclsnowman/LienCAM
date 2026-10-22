// @vitest-environment jsdom
//
// WO-2955: the cage's symmetry reference lives and dies with the cage - copied
// by every snapshot, restored by Undo/Redo, retired by a new topology, written
// by Finish and read back by Edit (a saved project round trip too). A form
// saved before it existed opens exactly as saved and keeps today's pairing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Matrix4 } from 'three'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { cloneCage, edgeKey, type Cage, type Vec3 } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { useFormStore } from '../../form/formStore'

const st = () => useFormStore.getState()
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const D1: Vec3 = [6, 3, 0]
const D2: Vec3 = [3, 2, 2]

function move(points: number[], d: Vec3): void {
  act(() => {
    st().setSelection({ points, edges: [], faces: [] })
    st().beginMove({ extrude: false })
    st().moveBy(new Matrix4().makeTranslation(d[0], d[1], d[2]).elements)
    st().endDrag()
  })
}

function open(cage: Cage): void {
  st().openSession({ featureId: null, name: 'Form', cage })
  st().setSoftRadius(0)
}

function mount(dag = new FeatureDag()) {
  const history = new CommandHistory(dag)
  const onApplied = vi.fn<(featureId: string) => void>()
  const deps = { runtime: null, canvasRef: { current: null }, dag, history, onApplied, showBody: vi.fn() }
  const { result } = renderHook(() => useFormSession(deps))
  return { result, dag, history, onApplied }
}

afterEach(() => {
  act(() => { st().closeSession(); st().setSymmetry(null) })
  cleanup()
})

describe('WO-2955: the symmetry reference in snapshots and history', () => {
  it('reference clone isolation: a copy shares no arrays, and a stale reference is not copied', () => {
    const cage: Cage = { ...boxCage(), symmetryReference: { positions: boxCage().positions, faces: boxCage().faces } }
    const twin = cloneCage(cage)
    expect(twin.symmetryReference).toEqual(cage.symmetryReference)
    twin.symmetryReference!.positions[0][0] = 99
    twin.symmetryReference!.faces[0][0] = 7
    expect(cage.symmetryReference!.positions[0][0]).toBe(-20)
    expect(cage.symmetryReference!.faces[0]).toEqual(boxCage().faces[0])
    const stale: Cage = { ...boxCage(), symmetryReference: { positions: boxCage().positions, faces: boxCage().faces.slice(1) } }
    expect(cloneCage(stale).symmetryReference).toBeUndefined()
  })

  it('an unedited form carries no reference: it opens and copies exactly as before', () => {
    const cage = boxCage()
    open(cage)
    expect(st().cage).toEqual(cage)
    expect(st().cage.symmetryReference).toBeUndefined()
    act(() => st().setSymmetry('x'))
    expect(st().cage).toEqual(cage)
  })

  it('undo restores asymmetric geometry and its correspondence; redo restores the later edit', () => {
    open(boxCage())
    move([17], D1)
    const first = copy(st().cage)
    expect(first.symmetryReference?.positions).toEqual(boxCage().positions)
    act(() => st().setSymmetry('x'))
    move([17], D2)
    const second = copy(st().cage)
    expect(second.positions[15]).toEqual([-23, 22, 42])
    act(() => st().undo())
    expect(st().cage).toEqual(first)
    act(() => st().redo())
    expect(st().cage).toEqual(second)
    act(() => st().undo())
    move([17], D2)
    expect(st().cage.positions[15]).toEqual([-23, 22, 42])
  })

  it('same-count topology changes invalidate correspondence; undo after invalidation restores it', () => {
    open(boxCage())
    move([17], D1)
    // the same points on the same faces listed in another order: a new topology all the same
    const renumbered = { ...copy(st().cage), faces: copy(st().cage.faces).reverse() }
    act(() => { st().applyCage(renumbered, { topology: true, record: true }) })
    expect(st().cage.positions).toHaveLength(26)
    expect(st().cage.symmetryReference).toBeUndefined()
    act(() => st().setSymmetry('x'))
    expect(st().notice).toMatch(/2 points have no mirror partner and move alone/)
    move([17], D2)
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    act(() => { st().undo(); st().undo() })
    expect(st().cage.symmetryReference?.positions).toEqual(boxCage().positions)
    move([17], D2)
    expect(st().cage.positions[15]).toEqual([-23, 22, 42])
  })

  it('a crease keeps the faces, so it keeps the reference', () => {
    open(boxCage())
    move([17], D1)
    act(() => { st().setSelection({ points: [], edges: [edgeKey(16, 17)], faces: [] }); st().crease(true) })
    expect(st().cage.creases.length).toBeGreaterThan(0)
    expect(st().cage.symmetryReference?.positions).toEqual(boxCage().positions)
  })

  it('off, plane and count changes re-pair for that plane and never carry an old map across it', () => {
    open(boxCage())
    move([17], D1)
    act(() => { st().setSymmetry('x'); st().setSymmetry(null) })
    move([17], [1, 0, 0])
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    act(() => { st().setSymmetry('x'); st().setSymmetryAt(5) })
    move([17], [0, 0, 1])
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    act(() => st().setSymmetryAt(0))
    move([17], [0, 0, 1])
    expect(st().cage.positions[17]).toEqual([27, 23, 42])
    expect(st().cage.positions[15]).toEqual([-20, 20, 41])
  })
})

describe('WO-2955: Finish, Edit and a saved project', () => {
  it('Finish Edit reload keeps reference and earlier edits', () => {
    const first = mount()
    act(() => { st().setStarterKind('box'); first.result.current.open() })
    act(() => st().setSoftRadius(0))
    move([17], D1)
    act(() => st().setSymmetry('x'))
    const finished = copy(st().cage)
    act(() => first.result.current.finish())
    const id = first.onApplied.mock.calls[0][0]
    const payload = first.dag.getNode(id)!.payload as Record<string, unknown> & { cage: Cage }
    expect(payload.symmetry).toBe('x')
    expect(payload.cage).toEqual(finished)
    expect(payload.cage.symmetryReference?.positions).toEqual(boxCage().positions)
    cleanup()

    // the project saved and opened again: the payload as JSON, in a new document
    const dag = new FeatureDag()
    new CommandHistory(dag).execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [], payload: JSON.parse(JSON.stringify(payload)) }))
    const second = mount(dag)
    act(() => second.result.current.open(id))
    act(() => st().setSoftRadius(0))
    expect(st().cage).toEqual(finished)
    expect(st().symmetry).toBe('x')
    move([17], D2)
    expect(st().cage.positions[17]).toEqual([29, 25, 42])
    expect(st().cage.positions[15]).toEqual([-23, 22, 42])
  })

  it('a legacy asymmetric file is not guessed or reshaped', () => {
    // saved before WO-2955: corner 17 off its partner, Mirror X on, no reference
    const cage = boxCage()
    cage.positions[17] = add(cage.positions[17], D1)
    const dag = new FeatureDag()
    new CommandHistory(dag).execute(createFeatureCommand(dag, { id: 'FRM1', kind: 'feature', consumes: [], payload: { opType: 'form', name: 'Old', cage: copy(cage), tolerance: 0.01, symmetry: 'x' } }))
    const { result } = mount(dag)
    act(() => result.current.open('FRM1'))
    act(() => st().setSoftRadius(0))
    expect(st().cage).toEqual(cage)
    expect(st().symmetry).toBe('x')
    act(() => st().setSymmetry('x'))
    expect(st().notice).toMatch(/2 points have no mirror partner and move alone/)
    expect(st().cage).toEqual(cage)
    move([17], D2)
    expect(st().cage.positions[15]).toEqual([-20, 20, 40])
    st().cage.positions.forEach((p, i) => { if (i !== 17) expect(p).toEqual(cage.positions[i]) })
  })
})
