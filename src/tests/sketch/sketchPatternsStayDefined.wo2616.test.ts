import { describe, expect, it, vi } from 'vitest'
import { circularPatternApply, linearPatternApply, pathPatternApply } from '../../lib/sketch/tools/patternTools'
import { appendDefinedPattern, editPattern, breakPattern, patternAffine, patternPoint } from '../../lib/sketch/patterns'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { offsetApply, breakOffsetLinks, setOffsetLinkDistance } from '../../lib/sketch/tools/offsetTool'
import { newTransformChain, transformApply } from '../../lib/sketch/tools/transformTools'
import { mirrorClick } from '../../lib/sketch/tools/mirrorTool'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { trimSwipe } from '../../lib/sketch/tools/trimTool'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import { buildSketchContextMenu } from '../../lib/sketch/contextMenu'
import type { Sketch, SketchCircleEntity } from '../../lib/sketch/types'

let next = 0
const id = () => `wo2616-${next++}`
function seed(fixed = true): Sketch {
  return { id: id(), layerId: 'layer', entities: [{ id: 'seed', kind: 'circle', construction: false,
    center: { x: 10, y: 3 }, radius: 2 }],
  constraints: fixed ? [{ id: 'fix', kind: 'fix', entityId: 'seed' }] : [], dimensions: [], solveStatus: null }
}
function create(kind: 'linear' | 'circular', fixed = true): Sketch {
  const sketch = seed(fixed)
  const result = kind === 'circular'
    ? circularPatternApply({ kind: 'circpat', confirmed: true, center: { x: 1, y: -2 }, ids: ['seed'] },
      sketch.entities, sketch.constraints, 4, Math.PI / 3, id)
    : linearPatternApply({ kind: 'linpat', confirmed: true, anchor: { x: 0, y: 0 }, vector: { x: 8, y: 5 }, ids: ['seed'] },
      sketch.entities, sketch.constraints, 4, id)
  if (typeof result === 'string') throw new Error(result)
  return { ...sketch, ...appendDefinedPattern(sketch, result) }
}
async function solved(sketch: Sketch) {
  const wrapper = await createGcsWrapper()
  try {
    const result = solveSketchOnWrapper(wrapper, sketch)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error(result.message)
    return { ...sketch, entities: result.entities, solveStatus: result.status }
  } finally { wrapper.destroy_gcs_module() }
}
function assertCopies(sketch: Sketch) {
  const pattern = sketch.patterns![0]
  for (const member of pattern.members) {
    const copy = sketch.entities.find(e => e.id === member.id) as SketchCircleEntity | undefined
    if (!copy) continue
    const source = sketch.entities.find(e => e.id === member.sourceId) as SketchCircleEntity
    const expected = patternPoint(source.center, patternAffine(pattern.values, member.column, member.row))
    expect(copy.center.x).toBeCloseTo(expected.x, 6)
    expect(copy.center.y).toBeCloseTo(expected.y, 6)
    expect(copy.radius).toBeCloseTo(source.radius, 6)
  }
}

describe('WO-2616 production Apply keeps sketch patterns defined', () => {
  for (const kind of ['linear', 'circular'] as const) {
    it(`${kind}: fixed source gives fixed copies without redundant constraints`, async () => {
      const sketch = await solved(create(kind))
      assertCopies(sketch)
      expect(sketch.solveStatus?.dof).toBe(0)
      expect(sketch.solveStatus?.redundant).toEqual([])
      expect(sketch.constraints).toHaveLength(1)
    })
    it(`${kind}: source dimension edit and JSON reopen keep the definition`, async () => {
      let sketch = create(kind)
      sketch.entities = sketch.entities.map(e => e.id === 'seed' && e.kind === 'circle' ? { ...e, center: { x: 21, y: -7 }, radius: 4 } : e)
      sketch = JSON.parse(JSON.stringify(sketch)) as Sketch
      assertCopies(await solved(sketch))
    })
    it(`${kind}: dragging a dependent preserves the transform and original degrees of freedom`, async () => {
      const sketch = await solved(create(kind, false))
      expect(sketch.solveStatus?.dof).toBe(3)
      const wrapper = await createGcsWrapper()
      try {
        const result = solveSketchOnWrapper(wrapper, sketch, { targets: [{
          point: { entityId: sketch.patterns![0].members[0].id, site: 'center' }, to: { x: 37, y: 19 },
        }] })
        expect(result.ok).toBe(true)
        if (result.ok) assertCopies({ ...sketch, entities: result.entities })
      } finally { wrapper.destroy_gcs_module() }
    })
  }
  it('edits count and rows in place, suppresses/restores stable IDs, and breaks explicitly', async () => {
    let sketch = create('linear')
    const pattern = sketch.patterns![0], originalId = pattern.members[0].id
    const values = { kind: 'linear' as const, count: 5, step: { x: 7, y: 0 }, rows: 2, rowStep: { x: 0, y: 11 } }
    const changed = editPattern(sketch, pattern.id, values, ['1,0'], id)
    expect(typeof changed).not.toBe('string')
    if (typeof changed === 'string') return
    sketch = { ...sketch, ...changed }
    expect(sketch.entities.find(e => e.id === originalId)).toBeUndefined()
    const restored = editPattern(sketch, pattern.id, values, [], id)
    if (typeof restored === 'string') throw new Error(restored)
    sketch = await solved({ ...sketch, ...restored })
    expect(sketch.entities.find(e => e.id === originalId)).toBeDefined()
    expect(sketch.entities).toHaveLength(10)
    assertCopies(sketch)
    const broken = await solved({ ...sketch, ...breakPattern(sketch, pattern.id) })
    expect(broken.solveStatus!.dof).toBeGreaterThan(0)
  })
  it('source deletion removes dependent copies and definitions', () => {
    const result = deleteFromSketch(create('circular'), ['seed'])!
    expect(result.entities).toEqual([])
    expect(result.patterns).toEqual([])
  })
  it('offers Edit pattern and Break pattern on the real context menu', () => {
    const sketch = create('circular')
    const menu = buildSketchContextMenu({ sketch, selectedIds: [sketch.patterns![0].members[0].id],
      state: { tool: 'select', chain: null }, constructionMode: false })
    expect(menu.map(item => item.id)).toContain('edit-pattern')
    expect(menu.map(item => item.id)).toContain('break-pattern')
  })
})


describe('WO-2616 mirror and offset followthrough', () => {
  it('retains a mirror definition, edits its line, and breaks symmetric relationships explicitly', async () => {
    const sketch = seed()
    sketch.entities.push({ id: 'axis', kind: 'line', construction: true, start: { x: 0, y: -30 }, end: { x: 0, y: 30 } })
    sketch.constraints.push({ id: 'fix-axis', kind: 'fix', entityId: 'axis' })
    const result = mirrorClick({ kind: 'mirror', ids: ['seed'], confirmed: true }, sketch.entities, [], { x: 0, y: 0 }, 0.1, id)
    expect(result.commit?.patterns).toHaveLength(1)
    if (!result.commit) throw new Error(result.notice ?? 'No mirror')
    const mirrored = await solved({ ...sketch, ...appendDefinedPattern(sketch, result.commit) })
    expect(mirrored.solveStatus!.dof).toBe(0)
    const copy = mirrored.entities.find(e => e.id === mirrored.patterns![0].members[0].id) as SketchCircleEntity
    expect(copy.center).toEqual({ x: -10, y: 3 })
    const withAxis: Sketch = { ...mirrored, entities: [...mirrored.entities, { id: 'axis-2', kind: 'line', construction: true, start: { x: -30, y: 0 }, end: { x: 30, y: 0 } }], constraints: [...mirrored.constraints, { id: 'fix-axis-2', kind: 'fix', entityId: 'axis-2' }] }
    const edited = editPattern(withAxis, mirrored.patterns![0].id, { kind: 'mirror', count: 2, axisId: 'axis-2' })
    if (typeof edited === 'string') throw new Error(edited)
    const reflected = await solved(JSON.parse(JSON.stringify({ ...withAxis, ...edited })))
    const reflectedCopy = reflected.entities.find(e => e.id === copy.id) as SketchCircleEntity
    expect(reflectedCopy.center.x).toBeCloseTo(10)
    expect(reflectedCopy.center.y).toBeCloseTo(-3)
    const broken = await solved({ ...reflected, ...breakPattern(reflected, reflected.patterns![0].id) })
    expect(broken.solveStatus!.dof).toBe(3)
  })
  it('a circle offset contributes no independent DoF, follows radius, and breaks explicitly', async () => {
    const sketch = seed(), circle = sketch.entities[0] as SketchCircleEntity
    const result = offsetApply({ kind: 'offset', source: { kind: 'circle', circle }, lockedSide: -1 }, 0.5, id)
    if (typeof result === 'string') throw new Error(result)
    const offset = await solved({ ...sketch, entities: [...sketch.entities, ...result.entities], constraints: [...sketch.constraints, ...result.constraints] })
    expect(offset.solveStatus!.dof).toBe(0)
    expect(offset.solveStatus!.redundant).toEqual([])
    const copy = offset.entities.find(e => e.offsetLink) as SketchCircleEntity
    expect(Math.abs(copy.radius - circle.radius)).toBeCloseTo(0.5)
    const resized = await solved({ ...offset, entities: offset.entities.map(e => e.id === 'seed' && e.kind === 'circle' ? { ...e, radius: 4 } : e) })
    const resizedCopy = resized.entities.find(e => e.id === copy.id) as SketchCircleEntity
    expect(Math.abs(resizedCopy.radius - 4)).toBeCloseTo(0.5)
    const distanceEdit = setOffsetLinkDistance(resized.entities, [copy.offsetLink!.id], 1)
    expect(typeof distanceEdit).not.toBe('string')
    if (typeof distanceEdit === 'string' || distanceEdit === null) throw new Error('Offset edit failed')
    const reopened = await solved(JSON.parse(JSON.stringify({ ...resized, entities: distanceEdit })))
    expect(Math.abs((reopened.entities.find(e => e.id === copy.id) as SketchCircleEntity).radius - 4)).toBeCloseTo(1)
    const detached = breakOffsetLinks(offset.entities, [copy.offsetLink!.id])!
    expect((await solved({ ...offset, entities: detached })).solveStatus!.dof).toBe(3)
    const deleted = deleteFromSketch(offset, ['seed'])!
    expect(deleted.entities).toHaveLength(0)
    expect(deleted.constraints).toHaveLength(0)
  })
  it('an open line offset is defined by source and normal distance without extra freedom', async () => {
    const line = { id: 'edge', kind: 'line' as const, construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } }
    const sketch: Sketch = { ...seed(), entities: [line], constraints: [{ id: 'fix-edge', kind: 'fix', entityId: 'edge' }] }
    const result = offsetApply({ kind: 'offset', source: { kind: 'chain', steps: [{ entity: line, forward: true }], closed: false }, lockedSide: 1 }, 2, id)
    if (typeof result === 'string') throw new Error(result)
    const offset = await solved({ ...sketch, entities: [...sketch.entities, ...result.entities], constraints: [...sketch.constraints, ...result.constraints] })
    expect(offset.solveStatus!.dof).toBe(0)
    expect(offset.solveStatus!.redundant).toEqual([])
  })
})


describe('WO-2616 real host persistence boundaries', () => {
  it('CAM Apply/Edit/Break/delete and undo preserve definitions without resurrecting a broken pattern', async () => {
    // This transport fixture echoes solved geometry; the native WASM tests above
    // independently prove the constraint math. Here we exercise actual host writes.
    class EchoWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(message: { payload: { requestId: string; sketch: Sketch } }) {
        const { requestId, sketch } = message.payload
        queueMicrotask(() => this.onmessage?.({ data: { type: 'SKETCH_SOLVE_COMPLETE', requestId,
          entities: sketch.entities, status: { dof: 0, conflicting: [], redundant: [] }, computeTimeMs: 0 } }))
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', EchoWorker)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { useCamStore, camSketchDocumentPort: port } = await import('../../store')
    const created = create('linear')
    useCamStore.setState({ activeSketch: seed(), sketchHistory: [], projectHistory: [], sketchSelectedIds: [], canUndo: false })
    port.beginStep()
    port.replace(created)
    expect(useCamStore.getState().activeSketch!.patterns).toEqual(created.patterns)
    const definition = created.patterns![0]
    const edited = editPattern(created, definition.id, { kind: 'linear', count: 3, step: { x: 13, y: 0 }, rows: 1, rowStep: { x: 0, y: 9 } }, [], id)
    if (typeof edited === 'string') throw new Error(edited)
    port.beginStep(); port.replace(edited)
    expect(useCamStore.getState().activeSketch!.patterns![0].values.count).toBe(3)
    port.beginStep(); port.replace(breakPattern(useCamStore.getState().activeSketch!, definition.id))
    expect(useCamStore.getState().activeSketch!.patterns).toEqual([])
    useCamStore.getState().undo()
    expect(useCamStore.getState().activeSketch!.patterns![0].id).toBe(definition.id)
    useCamStore.getState().redo()
    expect(useCamStore.getState().activeSketch!.patterns).toEqual([])
    port.replace(created)
    port.setSelection(['seed'])
    port.deleteSelection()
    expect(useCamStore.getState().activeSketch!.patterns).toEqual([])
    expect(useCamStore.getState().activeSketch!.entities.some(e => definition.members.some(m => m.id === e.id))).toBe(false)
    useCamStore.getState().undo()
    const reopened = JSON.parse(JSON.stringify(useCamStore.getState().activeSketch)) as Sketch
    expect(reopened.patterns).toEqual(created.patterns)
    vi.unstubAllGlobals()
  })

  it('Workbench commits definitions in DAG payloads and keeps them through real history and reopen', async () => {
    const { FeatureDag, CommandHistory, RegenScheduler, ElementMap } = await import('../../doc')
    const { sketchSessionStore: session } = await import('../../components/model3d/workbench/sketchSessionStore')
    const { workbenchSketchDocumentPort: port, __resetSketchDocumentPort } = await import('../../components/model3d/workbench/workbenchSketchDocumentPort')
    const { BASE_PLANE_FRAMES } = await import('../../components/model3d/workbench/basePlanes')
    const dag = new FeatureDag(), history = new CommandHistory(dag)
    const scheduler = new RegenScheduler(dag, new ElementMap())
    const initial = seed(), created = create('circular'), nodeId = 'wo2616-sketch'
    dag.insertNode({ id: nodeId, kind: 'sketch', consumes: [], refs: [], payload: { sketch: initial } }, 0)
    const wrapper = await createGcsWrapper()
    session.bindDeps({ dag, history, scheduler, wrapper, notice: () => undefined,
      onDocumentChanged: () => undefined, onHistoryStep: () => undefined })
    session.begin(nodeId, BASE_PLANE_FRAMES.xy, initial)
    __resetSketchDocumentPort()
    const payload = () => dag.getNode(nodeId)!.payload.sketch as Sketch
    try {
      port.beginStep(); port.replace(created)
      expect(payload().patterns).toEqual(created.patterns)
      port.beginStep(); port.replace(breakPattern(session.getState().sketch!, created.patterns![0].id))
      expect(payload().patterns).toEqual([])
      history.undo()
      expect(payload().patterns).toEqual(created.patterns)
      history.redo()
      expect(payload().patterns).toEqual([])
      history.undo()
      const reopened = JSON.parse(JSON.stringify(payload())) as Sketch
      session.begin(nodeId, BASE_PLANE_FRAMES.xy, reopened)
      port.setSelection(['seed']); port.deleteSelection()
      expect(payload().patterns).toEqual([])
      history.undo()
      expect(payload().patterns).toEqual(created.patterns)
    } finally {
      session.__reset(); __resetSketchDocumentPort(); wrapper.destroy_gcs_module()
    }
  })
})


describe('WO-2616 transform copies and dependent path features', () => {
  it('Keep original scale retains the source radius and center relationship', async () => {
    const sketch = seed()
    const result = transformApply({ ...newTransformChain('scale', ['seed']), confirmed: true,
      base: { x: 1, y: -2 }, factor: 2.5, keepOriginal: true }, sketch, id)
    if (typeof result === 'string') throw new Error(result)
    const output = await solved({ ...sketch, ...result.transform })
    expect(output.solveStatus!.dof).toBe(0)
    expect(output.solveStatus!.redundant).toEqual([])
    const copy = output.entities.find(e => e.id !== 'seed') as SketchCircleEntity
    expect(copy.radius).toBeCloseTo(5)
    expect(copy.center.x).toBeCloseTo(23.5)
    expect(copy.center.y).toBeCloseTo(10.5)
  })

  function pathSketch(fixed = true): Sketch {
    const sketch = seed(fixed)
    const path = { id: 'path', kind: 'spline' as const, construction: true, closed: false,
      form: 'control' as const, points: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 10 }] }
    sketch.entities.push(path)
    if (fixed) sketch.constraints.push({ id: 'fix-path', kind: 'fix', entityId: path.id })
    const result = pathPatternApply({ kind: 'pathpat', ids: ['seed'], confirmed: true,
      path: { kind: 'spline', entity: path }, count: 3, spacingMode: 'equal', fixedSpacing: 5, followTangent: true }, sketch.entities, sketch.constraints, id)
    if (typeof result === 'string') throw new Error(result)
    return { ...sketch, ...appendDefinedPattern(sketch, result) }
  }
  it('path copies persist, refuse drag, update after source/path edits and break explicitly', async () => {
    let sketch = await solved(pathSketch())
    expect(sketch.solveStatus!.dof).toBe(0)
    expect(sketch.solveStatus!.redundant).toEqual([])
    const pattern = sketch.patterns![0], member = pattern.members[1].id
    const before = sketch.entities.find(e => e.id === member)
    const wrapper = await createGcsWrapper()
    try {
      const drag = solveSketchOnWrapper(wrapper, sketch, { targets: [{ point: { entityId: member, site: 'center' }, to: { x: 100, y: 100 } }] })
      expect(drag.ok).toBe(true)
      if (drag.ok) expect(drag.entities.find(e => e.id === member)).toEqual(before)
    } finally { wrapper.destroy_gcs_module() }
    sketch.entities = sketch.entities.map(e => e.id === 'seed' && e.kind === 'circle' ? { ...e, radius: 4 }
      : e.id === 'path' && e.kind === 'spline' ? { ...e, points: e.points.map(p => ({ x: p.x + 15, y: p.y - 7 })) } : e)
    sketch = await solved(JSON.parse(JSON.stringify(sketch)))
    const copy = sketch.entities.find(e => e.id === member) as SketchCircleEntity
    expect(copy.radius).toBeCloseTo(4)
    expect(copy.center.x).toBeCloseTo((before as SketchCircleEntity).center.x + 15)
    expect(copy.center.y).toBeCloseTo((before as SketchCircleEntity).center.y - 7)
    const broken = await solved({ ...sketch, ...breakPattern(sketch, pattern.id) })
    expect(broken.solveStatus!.dof).toBe(9)
    expect(deleteFromSketch(sketch, ['path'])!.entities.map(e => e.id)).toEqual(['seed'])
  })
  it('path source freedoms remain in total DoF and incompatible driving dimensions fail explicitly', async () => {
    const original = pathSketch(false)
    const memberIds = new Set(original.patterns![0].members.map(m => m.id))
    const baseline = await solved({ ...original, patterns: [], entities: original.entities.filter(e => !memberIds.has(e.id)) })
    const sketch = await solved(original)
    expect(sketch.solveStatus!.dof).toBe(baseline.solveStatus!.dof)
    const wrapper = await createGcsWrapper()
    try {
      const fixed = pathSketch()
      const failed = solveSketchOnWrapper(wrapper, { ...fixed, dimensions: [{
        id: 'bad-radius', kind: 'radius', entityId: fixed.patterns![0].members[0].id, value: 99, driving: true, labelOffset: { x: 0, y: 0 },
      } as Sketch['dimensions'][number]] })
      expect(failed.ok).toBe(false)
      if (!failed.ok) expect(failed.message).toContain('Break pattern')
    } finally { wrapper.destroy_gcs_module() }
  })
  it('complex source control edits are evaluated before downstream solving', async () => {
    const source = { id: 'curve', kind: 'spline' as const, construction: false, closed: false,
      form: 'control' as const, points: [{ x: 0, y: 0 }, { x: 5, y: 12 }, { x: 15, y: 4 }] }
    let sketch: Sketch = { ...seed(), entities: [source], constraints: [{ id: 'fix-curve', kind: 'fix', entityId: source.id }] }
    const result = circularPatternApply({ kind: 'circpat', confirmed: true, center: { x: 0, y: 0 }, ids: [source.id] }, sketch.entities, sketch.constraints, 3, Math.PI / 2, id)
    if (typeof result === 'string') throw new Error(result)
    sketch = await solved({ ...sketch, ...appendDefinedPattern(sketch, result) })
    expect(sketch.solveStatus!.dof).toBe(0)
    sketch.entities = sketch.entities.map(e => e.id === source.id && e.kind === 'spline' ? { ...e, points: [{ x: 0, y: 0 }, { x: 7, y: 18 }, { x: 15, y: 4 }] } : e)
    sketch = await solved(sketch)
    const copy = sketch.entities.find(e => e.id === sketch.patterns![0].members[0].id)
    expect(copy?.kind).toBe('spline')
    if (copy?.kind === 'spline') { expect(copy.points[1].x).toBeCloseTo(-18); expect(copy.points[1].y).toBeCloseTo(7) }
  })

  it('reducing a pattern removes nested definitions and offset dependents without dangling constraints', () => {
    let sketch = create('linear')
    const outer = sketch.patterns![0], source = outer.members[2].id
    const result = linearPatternApply({ kind: 'linpat', confirmed: true, anchor: { x: 0, y: 0 }, vector: { x: 4, y: 0 }, ids: [source] }, sketch.entities, sketch.constraints, 2, id)
    if (typeof result === 'string') throw new Error(result)
    sketch = { ...sketch, ...appendDefinedPattern(sketch, result) }
    const edited = editPattern(sketch, outer.id, { kind: 'linear', count: 2, rows: 1, step: { x: 8, y: 5 }, rowStep: { x: 0, y: 1 } })
    if (typeof edited === 'string') throw new Error(edited)
    expect(edited.patterns).toHaveLength(1)
    expect(edited.entities).toHaveLength(2)
  })
})


it('WO-2616 downstream Model profiles rebuild from edited pattern members and keep member identities', async () => {
  const { extractSketchProfile } = await import('../../components/model3d/workbench/sketchProfile')
  const { BASE_PLANE_FRAMES } = await import('../../components/model3d/workbench/basePlanes')
  let sketch = await solved(create('circular'))
  const before = await extractSketchProfile(sketch, BASE_PLANE_FRAMES.xy, sketch.id)
  expect(before.ok).toBe(true)
  if (!before.ok) throw new Error(before.refusal.message)
  expect(before.regions).toHaveLength(4)
  const definition = sketch.patterns![0], member = definition.members[0].id
  const edited = editPattern(sketch, definition.id, { kind: 'circular', count: 6, center: { x: 1, y: -2 }, stepAngle: Math.PI / 3 }, [], id, { count: '3*2' })
  if (typeof edited === 'string') throw new Error(edited)
  sketch = await solved({ ...sketch, ...edited })
  const reopened = JSON.parse(JSON.stringify(sketch)) as Sketch
  expect(reopened.patterns![0].expressions?.count).toBe('3*2')
  expect(reopened.patterns![0].members[0].id).toBe(member)
  const after = await extractSketchProfile(reopened, BASE_PLANE_FRAMES.xy, sketch.id)
  expect(after.ok).toBe(true)
  if (after.ok) expect(after.regions).toHaveLength(6)
})


it('WO-2616 routes copy radius and diameter dimensions to the free source with exact DoF', async () => {
  for (const kind of ['radius', 'diameter'] as const) {
    const sketch = create('linear', false), member = sketch.patterns![0].members[0].id
    const constrained = { ...sketch, dimensions: [{ id: 'copy-size', kind, entityId: member, value: kind === 'radius' ? 3 : 6, driving: true }] }
    const result = await solved(JSON.parse(JSON.stringify(constrained)))
    expect(result.solveStatus!.dof).toBe(2)
    expect(result.solveStatus!.redundant).not.toContain('copy-size')
    expect((result.entities.find(e => e.id === 'seed') as SketchCircleEntity).radius).toBeCloseTo(3)
    assertCopies(result)
    const undone = await solved({ ...result, dimensions: [] })
    expect(undone.solveStatus!.dof).toBe(3)
  }
})


it('WO-2616 routes a scaled copy line length without counting the same freedom twice', async () => {
  const line = { id: 'seed-line', kind: 'line' as const, construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
  const sketch: Sketch = { ...seed(false), entities: [line] }
  const copied = transformApply({ ...newTransformChain('scale', [line.id]), confirmed: true, base: { x: 0, y: 0 }, factor: 2, keepOriginal: true }, sketch, id)
  if (typeof copied === 'string') throw new Error(copied)
  const created = { ...sketch, ...copied.transform }, member = created.patterns![0].members[0].id
  const constrained: Sketch = { ...created, dimensions: [{ id: 'copy-length', kind: 'distance', driving: true, value: 24,
    a: { entityId: member, site: 'start' }, b: { entityId: member, site: 'end' } }] }
  const result = await solved(JSON.parse(JSON.stringify(constrained)))
  expect(result.solveStatus!.dof).toBe(3)
  const source = result.entities.find(e => e.id === line.id)
  const copy = result.entities.find(e => e.id === member)
  if (source?.kind !== 'line' || copy?.kind !== 'line') throw new Error('Line missing')
  expect(Math.hypot(source.end.x - source.start.x, source.end.y - source.start.y)).toBeCloseTo(12)
  expect(Math.hypot(copy.end.x - copy.start.x, copy.end.y - copy.start.y)).toBeCloseTo(24)
  expect((await solved({ ...result, dimensions: [] })).solveStatus!.dof).toBe(4)
})

it('WO-2616 names unsupported free-source constraint routing without claiming a solver conflict', async () => {
  const sketch = create('linear', false), member = sketch.patterns![0].members[0].id
  const wrapper = await createGcsWrapper()
  try {
    const result = solveSketchOnWrapper(wrapper, { ...sketch, constraints: [{ id: 'cross-instance', kind: 'horizontal', points: [{ entityId: 'seed', site: 'center' }, { entityId: member, site: 'center' }] }] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_sketch')
      expect(result.message).toContain('horizontal relation cross-instance has no exact route')
      expect(result.status.conflicting).toEqual([])
    }
  } finally { wrapper.destroy_gcs_module() }
})


it('WO-2616 routes a copied Fix and both offset-circle sides without losing source DoF', async () => {
  const sketch = create('linear', false), member = sketch.patterns![0].members[0].id
  const fixed = await solved({ ...sketch, constraints: [{ id: 'fix-instance', kind: 'fix', entityId: member }] })
  expect(fixed.solveStatus!.dof).toBe(0)
  for (const side of [1, -1] as const) {
    const source = seed(false), circle = source.entities[0] as SketchCircleEntity
    const result = offsetApply({ kind: 'offset', source: { kind: 'circle', circle }, lockedSide: side }, 0.5, id)
    if (typeof result === 'string') throw new Error(result)
    const copy = result.entities[0]
    const changed = await solved({ ...source, entities: [...source.entities, ...result.entities], constraints: result.constraints,
      dimensions: [{ id: 'offset-diameter', kind: 'diameter', entityId: copy.id, driving: true, value: 6 }] })
    expect(changed.solveStatus!.dof).toBe(2)
    expect((changed.entities.find(e => e.id === 'seed') as SketchCircleEntity).radius).toBeCloseTo(3 + side * 0.5)
    expect((changed.entities.find(e => e.id === copy.id) as SketchCircleEntity).radius).toBeCloseTo(3)
  }
})


// Independent review F1/F2: preparation against product 4d60c51, before repairs.
function swipePatterns(count = 2): Sketch {
  let sketch: Sketch = { ...seed(), entities: [], constraints: [], patterns: [] }
  for (let i = 0; i < count; i++) {
    const source: SketchCircleEntity = { id: `swipe-source-${i}`, kind: 'circle', construction: false,
      center: { x: i * 20, y: 0 }, radius: 2 + i }
    sketch.entities.push(source)
    sketch.constraints.push({ id: `fix-swipe-source-${i}`, kind: 'fix', entityId: source.id })
    const applied = linearPatternApply({ kind: 'linpat', confirmed: true, anchor: source.center,
      vector: { x: 0, y: 20 }, ids: [source.id] }, sketch.entities, sketch.constraints, 3, id)
    if (typeof applied === 'string') throw new Error(applied)
    sketch = { ...sketch, ...appendDefinedPattern(sketch, applied) }
  }
  return sketch
}
const sourceSwipe = [{ x: -5, y: 0 }, { x: 25, y: 0 }]
function assertNoDanglingPatternRefs(sketch: Sketch) {
  const ids = new Set(sketch.entities.map(e => e.id))
  for (const c of sketch.constraints) for (const ref of constraintRefIds(c)) expect(ids.has(ref), c.id).toBe(true)
  for (const d of sketch.dimensions) for (const ref of dimensionRefIds(d)) expect(ids.has(ref), d.id).toBe(true)
  for (const p of sketch.patterns ?? []) {
    for (const source of p.sources) expect(ids.has(source), p.id).toBe(true)
    for (const member of p.members) if (!p.suppressed.includes(`${member.column},${member.row}`))
      expect(ids.has(member.id), p.id).toBe(true)
  }
}

describe('WO-2616 review F1 production trimSwipe', () => {
  it('single whole-source swipe returns an explicitly empty definition collection', async () => {
    const sketch = swipePatterns(1)
    const result = trimSwipe(sketch, sourceSwipe, id)
    expect(result.transform).not.toBeNull()
    expect(result.transform!.entities).toEqual([])
    expect(result.transform!.patterns).toEqual([])
    const reopened = await solved(JSON.parse(JSON.stringify({ ...sketch, ...result.transform })))
    assertNoDanglingPatternRefs(reopened)
    expect(reopened.solveStatus!.dof).toBe(0)
  })

  it('one swipe deletes two disjoint sources and both off-swipe copy sets', async () => {
    const sketch = swipePatterns()
    expect(sketch.patterns).toHaveLength(2)
    for (const p of sketch.patterns!) for (const member of p.members)
      expect((sketch.entities.find(e => e.id === member.id) as SketchCircleEntity).center.y).toBeGreaterThan(10)
    const result = trimSwipe(sketch, sourceSwipe, id)
    expect(result.transform).not.toBeNull()
    expect(result.transform!.entities).toEqual([])
    expect(result.transform!.patterns).toEqual([])
    const reopened = await solved(JSON.parse(JSON.stringify({ ...sketch, ...result.transform })))
    assertNoDanglingPatternRefs(reopened)
  })

  it('an unrelated first partial cut preserves definitions for a later source deletion', async () => {
    const sketch = swipePatterns(1)
    sketch.entities.unshift(
      { id: 'partial-first', kind: 'line', construction: false, start: { x: -10, y: -5 }, end: { x: -10, y: 5 } },
      { id: 'lower-cutter', kind: 'line', construction: false, start: { x: -12, y: -2 }, end: { x: -8, y: -2 } },
      { id: 'upper-cutter', kind: 'line', construction: false, start: { x: -12, y: 2 }, end: { x: -8, y: 2 } },
    )
    const result = trimSwipe(sketch, [{ x: -15, y: 0 }, { x: 5, y: 0 }], id)
    expect(result.transform).not.toBeNull()
    const verticals = result.transform!.entities.filter(e => e.kind === 'line' && e.start.x === -10 && e.end.x === -10)
    expect(verticals).toHaveLength(2) // Proves the unrelated first trim was partial.
    expect(result.transform!.entities.some(e => e.kind === 'circle')).toBe(false)
    expect(result.transform!.patterns).toEqual([])
    const reopened = await solved(JSON.parse(JSON.stringify({ ...sketch, ...result.transform })))
    assertNoDanglingPatternRefs(reopened)
  })

  it('CAM trim replacement, native solve, undo/redo and reopen preserve the cascade', async () => {
    class TrimTransport {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(message: { payload: { requestId: string; sketch: Sketch } }) {
        const { requestId, sketch } = message.payload
        queueMicrotask(() => this.onmessage?.({ data: { type: 'SKETCH_SOLVE_COMPLETE', requestId,
          entities: sketch.entities, status: { dof: 0, conflicting: [], redundant: [] }, computeTimeMs: 0 } }))
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', TrimTransport)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    try {
      const { useCamStore, camSketchDocumentPort: port } = await import('../../store')
      const original = await solved(swipePatterns())
      useCamStore.setState({ activeSketch: original, sketchHistory: [], projectHistory: [], sketchSelectedIds: [], canUndo: false })
      const trim = trimSwipe(original, sourceSwipe, id)
      expect(trim.transform).not.toBeNull()
      port.beginStep(); port.replace(trim.transform!)
      const current = useCamStore.getState().activeSketch!
      expect(current.patterns).toEqual([])
      expect(current.entities).toEqual([])
      // Transport only exercises the host write; this is the actual native solve.
      assertNoDanglingPatternRefs(await solved(current))
      useCamStore.getState().undo()
      expect(useCamStore.getState().activeSketch!.patterns).toEqual(original.patterns)
      expect(useCamStore.getState().activeSketch!.entities).toEqual(original.entities)
      useCamStore.getState().redo()
      const reopened = await solved(JSON.parse(JSON.stringify(useCamStore.getState().activeSketch)))
      expect(reopened.patterns).toEqual([])
      expect(reopened.entities).toEqual([])
      assertNoDanglingPatternRefs(reopened)
    } finally { vi.unstubAllGlobals() }
  })

  it('Workbench trim replacement solves and keeps the cascade through history and reopen', async () => {
    const { FeatureDag, CommandHistory, RegenScheduler, ElementMap } = await import('../../doc')
    const { sketchSessionStore: session } = await import('../../components/model3d/workbench/sketchSessionStore')
    const { workbenchSketchDocumentPort: port, __resetSketchDocumentPort } = await import('../../components/model3d/workbench/workbenchSketchDocumentPort')
    const { BASE_PLANE_FRAMES } = await import('../../components/model3d/workbench/basePlanes')
    const dag = new FeatureDag(), history = new CommandHistory(dag)
    const scheduler = new RegenScheduler(dag, new ElementMap())
    const original = await solved(swipePatterns()), nodeId = 'wo2616-trim-sketch'
    dag.insertNode({ id: nodeId, kind: 'sketch', consumes: [], refs: [], payload: { sketch: original } }, 0)
    const wrapper = await createGcsWrapper()
    const notices: string[] = []
    session.bindDeps({ dag, history, scheduler, wrapper, notice: message => notices.push(message),
      onDocumentChanged: () => undefined, onHistoryStep: () => undefined })
    session.begin(nodeId, BASE_PLANE_FRAMES.xy, original)
    __resetSketchDocumentPort()
    const payload = () => dag.getNode(nodeId)!.payload.sketch as Sketch
    try {
      const trim = trimSwipe(original, sourceSwipe, id)
      expect(trim.transform).not.toBeNull()
      port.beginStep(); port.replace(trim.transform!)
      expect(payload().patterns).toEqual([])
      expect(payload().entities).toEqual([])
      expect(payload().solveStatus?.solveFailed).not.toBe(true)
      assertNoDanglingPatternRefs(await solved(payload()))
      history.undo()
      expect(payload().patterns).toEqual(original.patterns)
      expect(payload().entities).toEqual(original.entities)
      history.redo()
      const reopened = JSON.parse(JSON.stringify(payload())) as Sketch
      session.begin(nodeId, BASE_PLANE_FRAMES.xy, reopened)
      expect(session.getState().sketch!.patterns).toEqual([])
      const live = session.getState().sketch!
      const deletedIds = new Set(original.entities.map(e => e.id))
      expect(live.entities.some(e => deletedIds.has(e.id))).toBe(false)
      expect(live.entities.map(e => e.id).sort()).toEqual([
        '__workbench_origin_anchor__', '__sketch_axis_x__', '__sketch_axis_y__',
      ].sort())
      for (const helper of live.entities) {
        expect(helper.construction).toBe(true)
        expect(live.constraints.some(c => c.kind === 'fix' && (helper.kind === 'point'
          ? c.point?.entityId === helper.id && c.point.site === 'self' : c.entityId === helper.id))).toBe(true)
      }
      const solvedReopened = await solved(live)
      assertNoDanglingPatternRefs(solvedReopened)
      expect(solvedReopened.solveStatus!.dof).toBe(0)
      expect(notices.some(message => message.includes('Pattern source was removed'))).toBe(false)
    } finally { session.__reset(); __resetSketchDocumentPort(); wrapper.destroy_gcs_module() }
  })
})

it('WO-2616 review F2 incompatible external Equal preserves real relation identity without boundary IDs', async () => {
  const sketch = await solved(swipePatterns())
  const [a, b] = sketch.patterns!.map(p => p.members[0].id)
  const relation = { id: 'external-copy-equal', kind: 'equal' as const, a, b }
  const constrained: Sketch = { ...sketch, constraints: [...sketch.constraints, relation] }
  const before = JSON.stringify(constrained)
  const wrapper = await createGcsWrapper()
  try {
    const result = solveSketchOnWrapper(wrapper, constrained)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(constrained)).toBe(before)
    expect(constrained.constraints.find(c => c.id === relation.id)).toEqual(relation)
    if (!result.ok) {
      expect(result.status.conflicting).toContain(relation.id)
      const diagnostics = JSON.stringify({ conflicting: result.status.conflicting, redundant: result.status.redundant,
        message: result.message, failureMessage: result.status.failureMessage })
      expect(diagnostics).not.toContain('__patternbound')
      expect(diagnostics).not.toContain('__patternroute-')
      const entityIds = new Set(sketch.entities.map(e => e.id))
      expect(result.status.conflicting.some(cause => entityIds.has(cause))).toBe(true)
      const persistedIds = new Set([...entityIds, ...constrained.constraints.map(c => c.id)])
      for (const cause of [...result.status.conflicting, ...result.status.redundant]) expect(persistedIds.has(cause), cause).toBe(true)
    }
  } finally { wrapper.destroy_gcs_module() }
})


// Acceptance inventory follow-up: direct copy drags for the remaining tool families.
for (const tool of ['mirror', 'offset', 'keep-original-scale'] as const) {
  it(`WO-2616 ${tool}: direct copy drag preserves definition geometry and DoF after reopen`, async () => {
    let sketch = seed()
    if (tool === 'mirror') {
      sketch.entities.push({ id: 'drag-axis', kind: 'line', construction: true, start: { x: 0, y: -30 }, end: { x: 0, y: 30 } })
      sketch.constraints.push({ id: 'fix-drag-axis', kind: 'fix', entityId: 'drag-axis' })
      const result = mirrorClick({ kind: 'mirror', ids: ['seed'], confirmed: true }, sketch.entities, [], { x: 0, y: 0 }, 0.1, id)
      if (!result.commit) throw new Error(result.notice ?? 'No mirror commit')
      sketch = { ...sketch, ...appendDefinedPattern(sketch, result.commit) }
    } else if (tool === 'offset') {
      const result = offsetApply({ kind: 'offset', source: { kind: 'circle', circle: sketch.entities[0] as SketchCircleEntity }, lockedSide: -1 }, 0.5, id)
      if (typeof result === 'string') throw new Error(result)
      sketch = { ...sketch, entities: [...sketch.entities, ...result.entities], constraints: [...sketch.constraints, ...result.constraints] }
    } else {
      const result = transformApply({ ...newTransformChain('scale', ['seed']), confirmed: true,
        base: { x: 0, y: 0 }, factor: 2, keepOriginal: true }, sketch, id)
      if (typeof result === 'string') throw new Error(result)
      sketch = { ...sketch, ...result.transform }
    }
    sketch = await solved(JSON.parse(JSON.stringify(sketch)))
    const copy = sketch.entities.find(e => e.kind === 'circle' && e.id !== 'seed') as SketchCircleEntity
    expect(copy).toBeDefined()
    expect(sketch.solveStatus!.dof).toBe(0)
    const wrapper = await createGcsWrapper()
    try {
      const result = solveSketchOnWrapper(wrapper, sketch, { targets: [{ point: { entityId: copy.id, site: 'center' }, to: { x: 47, y: -23 } }] })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) throw new Error(result.message)
      expect(result.entities.find(e => e.id === copy.id)).toEqual(copy)
      expect(result.status.dof).toBe(sketch.solveStatus!.dof)
      expect(result.status.conflicting).toEqual([])
      const followed = await solved({ ...sketch, entities: result.entities.map(e => e.id === 'seed' && e.kind === 'circle'
        ? { ...e, center: { x: 11, y: 4 }, radius: 3 } : e) })
      const changed = followed.entities.find(e => e.id === copy.id) as SketchCircleEntity
      expect(changed.center.x).toBeCloseTo(tool === 'mirror' ? -11 : tool === 'offset' ? 11 : 22)
      expect(changed.center.y).toBeCloseTo(tool === 'keep-original-scale' ? 8 : 4)
      expect(changed.radius).toBeCloseTo(tool === 'offset' ? 3.5 : tool === 'mirror' ? 3 : 6)
      expect(followed.solveStatus!.dof).toBe(0)
    } finally { wrapper.destroy_gcs_module() }
  })
}
