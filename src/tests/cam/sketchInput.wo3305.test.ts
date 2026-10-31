// WO-3305 (UI M2 W2-12): a sketch drawn in the Model workspace is a toolpath input.
//
// Everything runs through the application's own seams: the New UI's addSketchInput /
// syncSketchInputs (what the Sketch input window and its sync call), the store's addGeometry,
// updateOperation and computeOperationToolpath (the real toolpathWorker in-process, as the
// WO-3220 journey runs it), the real DXF importer for "the same shape imported as a 2D layer
// today", and buildProjectFileSnapshot -> loadProjectFromFile for the saved link.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProjectFileSnapshot, useCamStore } from '../../store'
import { importGeometryFile } from '../../lib/import/importGeometryFile'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { newSeededModelDag } from '../../doc/seedModelArchive'
import { FeatureDag } from '../../doc/dag'
import { bakeSketch } from '../../lib/sketch/bake'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'
import { rotationMatrixXYZ } from '../../lib/geometry/rotationMatrixXYZ'
import {
  addSketchInput, listSketchInputs, syncSketchInputs, type ModelDocumentOf,
} from '../../ui2/sketch-input/actions'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Loop2D, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

const STOCK_DEPTH = 10

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// ── the model: one sketch on a plane ─────────────────────────────────────────

type P = { x: number; y: number }

function rectLines(prefix: string, x0: number, y0: number, x1: number, y1: number): SketchEntity[] {
  const c: P[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  return c.map((p, i) => ({
    id: `${prefix}${i}`, kind: 'line', construction: false, start: { ...p }, end: { ...c[(i + 1) % 4] },
  }) as SketchEntity)
}

/** A 60 x 30 plate outline with a 20 x 10 window, drawn on the sketch plane. */
function plateSketch(width = 60): Sketch {
  return {
    id: 'sk1', layerId: 'sk1-layer',
    entities: [...rectLines('o', -width / 2, -15, width / 2, 15), ...rectLines('w', -10, -5, 10, 5)],
    constraints: [], dimensions: [], solveStatus: null,
  } as unknown as Sketch
}

const SKETCH_NODE = 'sketch3d:sk1'
const OFFSET_PLANE = 'datum:offset-1'

interface ModelPlane { planeNodeId: string; offsetZ?: number; normal?: Vec3; xDir?: Vec3 }

function modelWithSketch(sketch: Sketch, plane: ModelPlane): FeatureDag {
  const dag = newSeededModelDag()
  if (plane.planeNodeId === OFFSET_PLANE) {
    dag.insertNode({
      id: OFFSET_PLANE, kind: 'datum', consumes: ['datum:XY'],
      payload: {
        datumType: 'plane', planeKind: 'offset-plane', name: 'Plane 1',
        lastGoodFrame: {
          origin: { x: 0, y: 0, z: plane.offsetZ ?? 0 },
          normal: plane.normal ?? { x: 0, y: 0, z: 1 }, xDir: plane.xDir ?? { x: 1, y: 0, z: 0 },
        },
      },
    })
  }
  dag.insertNode({
    id: SKETCH_NODE, kind: 'sketch', consumes: [plane.planeNodeId],
    payload: { sketch, planeNodeId: plane.planeNodeId, externalRefs: [], dimensionDiagnostics: [], name: 'Plate sketch' },
  })
  return dag
}

let liveDag: FeatureDag | undefined
const documentOf: ModelDocumentOf = (id) => (id === 'legacy' ? liveDag : undefined)

// ── the CAM project around it ────────────────────────────────────────────────

function mill(): Tool {
  return {
    id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill',
    diameter: 6, fluteLength: 30, shankDiameter: 6, overallLength: 80,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  } as unknown as Tool
}

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function contourOp(geometryId: string, loopIds: string[]): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: STOCK_DEPTH - 6, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
  }
  const params = { geometryId, loopIds, side: 'outer', direction: 'climb', tabs: false }
  const passes: PassParams = { stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  return {
    id: 'op-1', name: 'Plate outline', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [...loopIds], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: [geometryId] }),
  } as unknown as Operation
}

function install(placement = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }): void {
  const stocks = [{
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -80, y: -40, z: 0 }, { x: 80, y: 40, z: STOCK_DEPTH }),
    position: { x: -80, y: -40, z: 0 },
  } as unknown as PhysicalStock]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -80, y: -40, z: STOCK_DEPTH },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [], notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 160, fixedHeight: 80, fixedDepth: 10, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [mill()],
    toolpathBatch: null,
    consoleEvents: [],
    projectHistory: [],
    projectFuture: [],
    project: {
      ...s.project, geometry: [], stocks, setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: null,
      modelItems: [],
      modelItemPlacements: [{ modelItemId: 'legacy', position: placement.position, rotation: placement.rotation }],
    } as unknown as Project,
  }))
}

// ── the worker wire: real toolpathWorker.ts, in-process ─────────────────────

let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  activeShim = null
  liveDag = undefined
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the worker reply goes to this instance
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const store = () => useCamStore.getState()
const geo = (id: string) => store().project.geometry.find((g) => g.id === id)!
const op = () => store().project.setups[0].operations.find((o) => o.id === 'op-1')!

/** The outline loop of a part (the larger closed contour). */
function outlineId(g: ImportedGeometry): string {
  const contours = (g.loops ?? []).filter((l) => l.closed && l.type === 'contour')
  return contours.sort((a, b) => b.area - a.area)[0].id
}

async function contourMovesOn(geometryId: string): Promise<ToolpathMove[]> {
  const others = store().project.setups[0].operations.filter((o) => o.id !== 'op-1')
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      setups: [{ ...s.project.setups[0], operations: [...others, contourOp(geometryId, [outlineId(geo(geometryId))])] }],
    },
  }))
  await store().computeOperationToolpath('setup-1', 'op-1')
  expect(op().status, op().errorMessage).toBe('ready')
  return op().toolpathMoves as ToolpathMove[]
}

function addFromSketch(): string {
  const result = addSketchInput('legacy', SKETCH_NODE, documentOf, () => 'sketch-part')
  expect(result).toEqual({ ok: true, geoId: 'sketch-part' })
  return 'sketch-part'
}

// The same shape as a DXF: one closed LWPOLYLINE per baked loop, vertex for vertex.
type Pairs = Array<[number | string, string]>
function dxfOf(sketch: Sketch): string {
  const loops = bakeSketch(sketch).loops
  const pairs: Pairs = loops.flatMap((l): Pairs => [
    [0, 'LWPOLYLINE'], [8, 'Cut'], [90, `${l.points.length}`], [70, '1'],
    ...l.points.flatMap((p): Pairs => [[10, `${p.x}`], [20, `${p.y}`]]),
  ])
  return [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']]
    .map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}

async function importDxf(text: string): Promise<ImportedGeometry> {
  const before = new Set(store().project.geometry.map((g) => g.id))
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  if (!hadWindow) g.window = {}
  try {
    const done = importGeometryFile(new File([text], 'plate.dxf', { type: 'application/dxf' }),
      { importBrepGeometry: async () => {}, addGeometry: (row) => store().addGeometry(row) })
    for (let i = 0; i < 200 && !store().importStockChoice; i++) await new Promise((r) => setTimeout(r, 0))
    if (store().importStockChoice) store().resolveImportStockChoice({ kind: 'stock', stockId: DERIVED_STOCK_ID })
    await done
  } finally {
    if (!hadWindow) delete g.window
  }
  const added = store().project.geometry.filter((row) => !before.has(row.id))
  expect(added).toHaveLength(1)
  return added[0]
}

/** Place the imported DXF where the operator would: on the sketch's plane, at the model's pose. */
function placeLike(id: string, position: Vec3, rotation: Vec3): void {
  store().updateGeometryTransform(id, position, rotation)
}

const strip = (moves: ToolpathMove[]) => moves.map((m) => ({ ...m }))

// ── where a curve lands in the world ─────────────────────────────────────────

/** A circle, an open arc and a 30 x 20 frame: arcs that bulge one way only, in both loop kinds. */
function arcSketch(): Sketch {
  return {
    id: 'sk1', layerId: 'sk1-layer',
    entities: [
      { id: 'c', kind: 'circle', construction: false, center: { x: 10, y: 5 }, radius: 8 },
      { id: 'a', kind: 'arc', construction: false, center: { x: -12, y: -6 }, radius: 6, startAngle: 0.3, endAngle: 2.2 },
      ...rectLines('r', -40, -30, -10, -10),
    ],
    constraints: [], dimensions: [], solveStatus: null,
  } as unknown as Sketch
}

type V3 = { x: number; y: number; z: number }
function turn(rotation: V3, v: V3): V3 {
  const m = rotationMatrixXYZ(rotation)
  return {
    x: m.col1.x * v.x + m.col2.x * v.y + m.col3.x * v.z,
    y: m.col1.y * v.x + m.col2.y * v.y + m.col3.y * v.z,
    z: m.col1.z * v.x + m.col2.z * v.y + m.col3.z * v.z,
  }
}

/** The middle of every arc segment of some loops, and every vertex, in loop-local 2D. */
function arcMiddles(loops: readonly Loop2D[]): P[] {
  const out: P[] = []
  for (const l of loops) {
    l.segments?.forEach((s, i) => {
      if (s.type !== 'arc') return
      const from = i === 0 ? l.points[0] : l.segments![i - 1].to
      const a0 = Math.atan2(from.y - s.center.y, from.x - s.center.x)
      const a1 = Math.atan2(s.to.y - s.center.y, s.to.x - s.center.x)
      const ccw = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI
      const sweep = s.clockwise ? ccw - 2 * Math.PI : ccw
      const m = a0 + sweep / 2
      out.push({ x: s.center.x + s.radius * Math.cos(m), y: s.center.y + s.radius * Math.sin(m) })
    })
  }
  return out
}

const key = (v: V3) => [v.x, v.y, v.z].map((n) => (Math.round(n * 1e6) / 1e6 || 0).toFixed(6)).join(',')
const keys = (vs: V3[]) => vs.map(key).sort()

interface Frame { origin: V3; normal: V3; xDir: V3 }
/** Where the drawn sketch's arc middles and vertices are in the world: plane, then model pose. */
function expectedWorld(sketch: Sketch, plane: Frame, pose: { position: V3; rotation: V3 }) {
  const loops = bakeSketch(sketch).loops
  const y = { x: plane.normal.y * plane.xDir.z - plane.normal.z * plane.xDir.y, y: plane.normal.z * plane.xDir.x - plane.normal.x * plane.xDir.z, z: plane.normal.x * plane.xDir.y - plane.normal.y * plane.xDir.x }
  const world = (p: P) => {
    const m = { x: plane.origin.x + p.x * plane.xDir.x + p.y * y.x, y: plane.origin.y + p.x * plane.xDir.y + p.y * y.y, z: plane.origin.z + p.x * plane.xDir.z + p.y * y.z }
    const r = turn(pose.rotation, m)
    return { x: r.x + pose.position.x, y: r.y + pose.position.y, z: r.z + pose.position.z }
  }
  return { arcs: keys(arcMiddles(loops).map(world)), points: keys(loops.flatMap((l) => l.points).map(world)) }
}

/** The same, read off the sketch part the way dispatch places it: layer plane Z, then the part pose. */
function partWorld(g: ImportedGeometry) {
  const z = g.layers2d![0].projectionPlane!.origin.z
  const world = (p: P) => {
    const r = turn(g.rotation, { x: p.x, y: p.y, z })
    return { x: r.x + g.position.x, y: r.y + g.position.y, z: r.z + g.position.z }
  }
  const loops = g.loops ?? []
  return { arcs: keys(arcMiddles(loops).map(world)), points: keys(loops.flatMap((l) => l.points).map(world)) }
}

describe('WO-3305 a model sketch is a toolpath input', () => {
  it('lists the sketch and makes it operation geometry in one undo step', () => {
    install()
    liveDag = modelWithSketch(plateSketch(), { planeNodeId: 'datum:XY' })
    expect(listSketchInputs(store(), documentOf).map((e) => [e.nodeId, e.status])).toEqual([[SKETCH_NODE, 'available']])
    const historyBefore = store().projectHistory.length
    const id = addFromSketch()
    expect(store().projectHistory.length).toBe(historyBefore + 1)
    const part = geo(id)
    expect(part.format).toBe('sketch')
    expect(part.loops?.filter((l) => l.closed)).toHaveLength(2)
    expect(listSketchInputs(store(), documentOf).map((e) => [e.status, e.geoId])).toEqual([['in-use', id]])
    // A second Use returns the same part and adds nothing.
    expect(addSketchInput('legacy', SKETCH_NODE, documentOf)).toEqual({ ok: true, geoId: id })
    expect(store().project.geometry).toHaveLength(1)
  })

  it('a profile on the model XY plane cuts the same moves as the same shape imported as a DXF layer', async () => {
    install()
    const sketch = plateSketch()
    liveDag = modelWithSketch(sketch, { planeNodeId: 'datum:XY' })
    const fromSketch = await contourMovesOn(addFromSketch())
    const dxf = await importDxf(dxfOf(sketch))
    const fromDxf = await contourMovesOn(dxf.id)
    expect(fromSketch.length).toBeGreaterThan(10)
    expect(strip(fromSketch)).toEqual(strip(fromDxf))
  })

  it('a profile on a face plane, with the model placed and turned, cuts the same moves as that DXF placed there', async () => {
    const placement = { position: { x: 12, y: -4, z: 0 }, rotation: { x: 0, y: 0, z: 30 } }
    install(placement)
    const sketch = plateSketch()
    liveDag = modelWithSketch(sketch, { planeNodeId: OFFSET_PLANE, offsetZ: 4 })
    const id = addFromSketch()
    expect(geo(id).layers2d?.[0].projectionPlane?.origin.z).toBe(4)
    const fromSketch = await contourMovesOn(id)
    const dxf = await importDxf(dxfOf(sketch))
    placeLike(dxf.id, { ...placement.position, z: 4 }, placement.rotation)
    const fromDxf = await contourMovesOn(dxf.id)
    expect(fromSketch.length).toBeGreaterThan(10)
    expect(strip(fromSketch)).toEqual(strip(fromDxf))
  })

  it('a sketch on a plane the setup cannot reach is refused with the app reason and adds nothing', () => {
    install()
    liveDag = modelWithSketch(plateSketch(), { planeNodeId: 'datum:XZ' })
    const [entry] = listSketchInputs(store(), documentOf)
    expect(entry?.status).toBe('refused')
    expect(entry.reason).toEqual({
      key: 'console-and-operator-messages:modelEdgeChainBinding19',
      params: { value1: 'Plate sketch', value2: '30' },
    })
    expect(addSketchInput('legacy', SKETCH_NODE, documentOf)).toEqual({ ok: false, reason: entry.reason })
    expect(store().project.geometry).toHaveLength(0)
  })

  it('editing the sketch outdates the operation and the next compute follows the edit', async () => {
    install()
    liveDag = modelWithSketch(plateSketch(60), { planeNodeId: 'datum:XY' })
    const id = addFromSketch()
    const before = await contourMovesOn(id)
    const maxX = (moves: ToolpathMove[]) => Math.max(...moves.filter((m) => m.type !== 'rapid').map((m) => m.x))
    expect(maxX(before)).toBeCloseTo(30 + 3, 6)
    expect(syncSketchInputs(documentOf)).toBe(0)

    const node = liveDag.getNode(SKETCH_NODE)!
    liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: plateSketch(80) })
    expect(syncSketchInputs(documentOf)).toBe(1)
    expect(op().status).toBe('outdated')
    expect((op().params as { loopIds: string[] }).loopIds).toEqual([outlineId(geo(id))])

    await store().computeOperationToolpath('setup-1', 'op-1')
    expect(op().status, op().errorMessage).toBe('ready')
    expect(maxX(op().toolpathMoves as ToolpathMove[])).toBeCloseTo(40 + 3, 6)
  })

  it('a saved and reopened project keeps the link and still follows the sketch', async () => {
    install()
    liveDag = modelWithSketch(plateSketch(60), { planeNodeId: 'datum:XY' })
    const id = addFromSketch()
    await contourMovesOn(id)
    const st = store()
    const file = buildProjectFileSnapshot(st.project, st.toolLibrary, st.toolLibraries, st.holders)
    await st.loadProjectFromFile(JSON.stringify(file))
    expect(listSketchInputs(store(), documentOf).map((e) => [e.status, e.geoId])).toEqual([['in-use', id]])
    expect(syncSketchInputs(documentOf)).toBe(0)
    const node = liveDag.getNode(SKETCH_NODE)!
    liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: plateSketch(70) })
    expect(syncSketchInputs(documentOf)).toBe(1)
    await store().computeOperationToolpath(store().project.setups[0].id, 'op-1')
    expect(op().status, op().errorMessage).toBe('ready')
  })

  // Pre-audit: the arc direction and the loop winding must follow the points the part actually
  // holds, for a plane facing down in the model and for a model placed upside down or on its side.
  const PLACED_CASES: Array<[string, Frame, { position: V3; rotation: V3 }]> = [
    ['a face plane facing down in the model', { origin: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } }, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    ['the top plane of a model placed upside down', { origin: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }, { position: { x: 3, y: -2, z: 10 }, rotation: { x: 180, y: 0, z: 0 } }],
    ['a down-facing plane of a model turned over about Y', { origin: { x: 0, y: 0, z: -4 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } }, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 180, z: 0 } }],
    ['a side plane of a model placed on its side', { origin: { x: 0, y: -7, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }, { position: { x: 5, y: 0, z: 0 }, rotation: { x: 90, y: 0, z: 0 } }],
  ]
  for (const [label, plane, pose] of PLACED_CASES) {
    it(`arcs and vertices land where the sketch is drawn: ${label}`, () => {
      install({ position: pose.position, rotation: pose.rotation })
      const sketch = arcSketch()
      liveDag = modelWithSketch(sketch, { planeNodeId: OFFSET_PLANE, offsetZ: plane.origin.z, normal: plane.normal, xDir: plane.xDir })
      liveDag.setPayload(OFFSET_PLANE, { ...liveDag.getNode(OFFSET_PLANE)!.payload, lastGoodFrame: plane })
      const id = addFromSketch()
      const want = expectedWorld(sketch, plane, pose)
      const got = partWorld(geo(id))
      expect(want.arcs.length).toBeGreaterThan(1)
      expect(got.arcs).toEqual(want.arcs)
      expect(got.points).toEqual(want.points)
    })
  }

  it('an edit that changes the picked outline and adds a loop keeps the pick on the outline', () => {
    install()
    liveDag = modelWithSketch(plateSketch(60), { planeNodeId: 'datum:XY' })
    const id = addFromSketch()
    const outline = outlineId(geo(id))
    useCamStore.setState((s) => ({
      project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [contourOp(id, [outline])] }] },
    }))
    const node = liveDag.getNode(SKETCH_NODE)!
    const wider = plateSketch(80)
    liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: { ...wider, entities: [...wider.entities, ...rectLines('v', 15, -5, 25, 5)] } })
    expect(syncSketchInputs(documentOf)).toBe(1)
    expect(geo(id).loops?.filter((l) => l.closed)).toHaveLength(3)
    expect((op().params as { loopIds: string[] }).loopIds).toEqual([outlineId(geo(id))])
    expect(op().geometrySelections).toEqual([outlineId(geo(id))])
  })

  // Audit fix 1: an explicit pick is never turned into "every loop" (loopIds []), even when the
  // only picked profile is deleted from the sketch: the operation keeps its pick and shows the
  // existing missing-source state instead of cutting the other profile.
  it('deleting the only picked profile keeps the explicit pick; the other profile is not cut', async () => {
    install()
    const two = (withA: boolean) => ({
      ...plateSketch(),
      entities: [...(withA ? rectLines('a', -40, -10, -15, 10) : []), ...rectLines('b', 15, -10, 40, 10)],
    }) as Sketch
    liveDag = modelWithSketch(two(true), { planeNodeId: 'datum:XY' })
    const id = addFromSketch()
    const loopA = geo(id).loops!.find((l) => l.closed && Math.max(...l.points.map((p) => p.x)) < 0)!.id
    useCamStore.setState((s) => ({
      project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [contourOp(id, [loopA])] }] },
    }))
    const node = liveDag.getNode(SKETCH_NODE)!
    liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: two(false) })
    expect(syncSketchInputs(documentOf)).toBe(1)
    expect((op().params as { loopIds: string[] }).loopIds).toEqual([loopA])
    expect(op().geometrySelections).toEqual([loopA])
    await store().computeOperationToolpath('setup-1', 'op-1')
    expect(op().status).toBe('error')
    expect(op().toolpathMoves ?? []).toHaveLength(0)
  })

  // Audit fix 2: an operation on every part ('__all__') picks geometry-namespaced loop ids; an
  // edit of the sketch moves its pick to the edited loop as it does for a one-part operation.
  it('an edit follows the pick of an operation on every part', () => {
    install()
    liveDag = modelWithSketch(plateSketch(60), { planeNodeId: 'datum:XY' })
    const id = addFromSketch()
    const outline = outlineId(geo(id))
    useCamStore.setState((s) => ({
      project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [contourOp('__all__', [outline])] }] },
    }))
    const node = liveDag.getNode(SKETCH_NODE)!
    liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: plateSketch(80) })
    expect(syncSketchInputs(documentOf)).toBe(1)
    expect(outlineId(geo(id))).not.toBe(outline)
    expect((op().params as { loopIds: string[] }).loopIds).toEqual([outlineId(geo(id))])
    expect(op().geometrySelections).toEqual([outlineId(geo(id))])
  })
  // Fix round 2: a deleted loop passes its pick on only to a loop that shares its sketch entities
  // (a resize or a move). An unrelated loop drawn in the same edit never inherits the pick.
  const twoRects = (a: 'a' | 'a-wide' | 'none', c: boolean) => ({
    ...plateSketch(),
    entities: [
      ...(a === 'a' ? rectLines('a', -40, -10, -15, 10) : a === 'a-wide' ? rectLines('a', -42, -12, -13, 12) : []),
      ...rectLines('b', 15, -10, 40, 10),
      // Drawn where A was, the nearest-box guess for A's replacement.
      ...(c ? rectLines('c', -38, -8, -17, 8) : []),
    ],
  }) as Sketch
  const loopLeftOfCentre = (g: ImportedGeometry) =>
    g.loops!.find((l) => l.closed && Math.max(...l.points.map((p) => p.x)) < 0)!.id

  for (const geometryId of ['sketch-part', '__all__']) {
    it(`deleting A and drawing an unrelated C keeps A as the missing pick and leaves C unpicked (${geometryId})`, async () => {
      install()
      liveDag = modelWithSketch(twoRects('a', false), { planeNodeId: 'datum:XY' })
      const id = addFromSketch()
      const loopA = loopLeftOfCentre(geo(id))
      useCamStore.setState((s) => ({
        project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [contourOp(geometryId, [loopA])] }] },
      }))
      const node = liveDag.getNode(SKETCH_NODE)!
      liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: twoRects('none', true) })
      expect(syncSketchInputs(documentOf)).toBe(1)
      const loopC = loopLeftOfCentre(geo(id))
      expect(loopC).not.toBe(loopA)
      expect((op().params as { loopIds: string[] }).loopIds).toEqual([loopA])
      expect(op().geometrySelections).toEqual([loopA])
      await store().computeOperationToolpath('setup-1', 'op-1')
      expect(op().status).toBe('error')
      expect(op().toolpathMoves ?? []).toHaveLength(0)
    })

    it(`resizing A still moves its pick to the resized loop (${geometryId})`, () => {
      install()
      liveDag = modelWithSketch(twoRects('a', false), { planeNodeId: 'datum:XY' })
      const id = addFromSketch()
      const loopA = loopLeftOfCentre(geo(id))
      useCamStore.setState((s) => ({
        project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [contourOp(geometryId, [loopA])] }] },
      }))
      const node = liveDag.getNode(SKETCH_NODE)!
      liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: twoRects('a-wide', true) })
      expect(syncSketchInputs(documentOf)).toBe(1)
      const resized = geo(id).loops!.find((l) => l.closed && Math.min(...l.points.map((p) => p.x)) === -42)!.id
      expect((op().params as { loopIds: string[] }).loopIds).toEqual([resized])
      expect(op().geometrySelections).toEqual([resized])
    })
  }
  // A hole inside a rectangle is re-typed (its winding turns) when the rectangle goes; that alone
  // does not make the rectangle's lines the hole's entities.
  it('deleting a picked hole while its outline is resized does not hand the pick to the outline', () => {
    install()
    const withHole = (hole: boolean, width: number) => ({
      ...plateSketch(),
      entities: [
        ...rectLines('o', -width / 2, -15, width / 2, 15),
        ...(hole ? [{ id: 'h', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 } as unknown as SketchEntity] : []),
      ],
    }) as Sketch
    liveDag = modelWithSketch(withHole(true, 60), { planeNodeId: 'datum:XY' })
    const id = addFromSketch()
    const hole = geo(id).loops!.find((l) => l.closed && l.type === 'hole')!.id
    useCamStore.setState((s) => ({
      project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [contourOp(id, [hole])] }] },
    }))
    const node = liveDag.getNode(SKETCH_NODE)!
    liveDag.setPayload(SKETCH_NODE, { ...node.payload, sketch: withHole(false, 80) })
    expect(syncSketchInputs(documentOf)).toBe(1)
    expect((op().params as { loopIds: string[] }).loopIds).toEqual([hole])
  })
})
