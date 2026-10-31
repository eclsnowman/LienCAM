// @vitest-environment jsdom
//
// WO-1942: a Thread Mill follows a picked modeled-body cylinder - a hole
// (internal thread) or a boss (external thread) - through the SAME
// 'bore-target' reference and compute-time replay Bore uses.
//
// Hole case: a real Model-kernel plate (60 x 40 x 10) with a 6 mm through-hole,
// replayed headlessly by the store's own compute (readModelBodyFaceFacts), and
// the captured worker payload run through the real Thread Mill engine.
// Boss case: injected face facts (the kernel seam modelBodyHoleRecognition
// exposes for this) because a boss's rim is read off the body's display
// tessellation, which only the Model workspace produces.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { NewOperationModal } from '../../components/modals/NewOperationModal'
import { createLocalGeomService } from '../../geom'
import type { GeometrySnapshot } from '../../geom'
import type { FeatureVerdict } from '../../geom/geom-service'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  readModelBodyFaceFacts,
  recognizeModelBodyHoles,
  setModelBodyFaceSnapshotReader,
  setModelBodyHoleRecognizer,
} from '../../lib/cam/modelBodyHoleRecognition'
import { buildThreadMillSmartHeightIntent, deriveThreadMillFeatureBindings } from '../../lib/cam/smartHeights'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import { findThreadByBore, findThreadByMajor } from '../../lib/cam/threadPresets'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { evidenceOutDir } from '../helpers/evidenceScratch'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveModelThreadMillTarget, useCamStore } from '../../store'
import type {
  BoundingBox, HeightIntentV1, HeightParams, ImportedGeometry, ModelItemPlacementRecord, Operation,
  PhysicalStock, Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'
import type { ThreadMillParams } from '../../lib/cam/types'

// ── Model: a plate with one 6 mm through-hole ─────────────────────────────

const PLATE_BODY = 'PLATE-HOLE-CUT'
const HOLE_CENTER_LOCAL = { x: 15, y: 20 }
// The Model Item is placed away from the world origin so a helix that lands
// on the hole proves the placement is honoured, not merely the local sketch.
const PLACEMENT: ModelItemPlacementRecord = {
  modelItemId: 'legacy', position: { x: 10, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
}
const HOLE_CENTER_WORLD = { x: HOLE_CENTER_LOCAL.x + 10, y: HOLE_CENTER_LOCAL.y + 5 }

function sketch(id: string, entities: SketchEntity[]): Sketch {
  return { id, layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}

function rectangle(width: number, height: number): SketchEntity[] {
  return [
    { id: 'plate-0', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: width, y: 0 } },
    { id: 'plate-1', kind: 'line', construction: false, start: { x: width, y: 0 }, end: { x: width, y: height } },
    { id: 'plate-2', kind: 'line', construction: false, start: { x: width, y: height }, end: { x: 0, y: height } },
    { id: 'plate-3', kind: 'line', construction: false, start: { x: 0, y: height }, end: { x: 0, y: 0 } },
  ]
}

function stashPlateWithHole(): void {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: 'sketch3d:PLATE', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: { sketch: sketch('PLATE', rectangle(60, 40)), planeNodeId: BASE_PLANE_XY_NODE_ID },
  })
  dag.insertNode({
    id: 'PLATE-EXTRUDE', kind: 'feature', consumes: ['sketch3d:PLATE'], refs: [],
    payload: {
      opType: 'extrude', sketchId: 'sketch3d:PLATE', profileSelector: { kind: 'whole-sketch' },
      distance: 10, direction: 'up', boolMode: 'newBody',
    },
  })
  dag.insertNode({
    id: 'sketch3d:HOLE', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: {
      sketch: sketch('HOLE', [{
        id: 'hole-1', kind: 'circle', construction: false, center: { ...HOLE_CENTER_LOCAL }, radius: 3,
      }]),
      planeNodeId: BASE_PLANE_XY_NODE_ID,
    },
  })
  dag.insertNode({
    id: PLATE_BODY, kind: 'feature', consumes: ['sketch3d:HOLE', 'PLATE-EXTRUDE'], refs: [],
    payload: {
      opType: 'extrude', sketchId: 'sketch3d:HOLE', profileSelector: { kind: 'whole-sketch' },
      distance: 12, direction: 'up', boolMode: 'remove', targetFeatureId: 'PLATE-EXTRUDE',
    },
  })
  stashLoadedDocument(finalizeSeedArchive(dag))
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock: PhysicalStock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 80, z: 30 }),
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

function modelRow(bodyId: string, display?: unknown): ImportedGeometry {
  return {
    id: `modelbody:${bodyId}`, name: 'Plate', filename: '', type: 'model', format: 'model',
    loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 60, y: 40, z: 10 }),
    stockId: stock.id,
    modelBody: { ref: { bodyId, stableIds: [], version: 1 }, ...(display ? { display } : {}) },
  } as unknown as ImportedGeometry
}

const threadTool: Tool = {
  id: 'wo1942-thread-tool', name: 'Thread mill 3', type: 'thread_mill', diameter: 3,
  fluteLength: 12, shankDiameter: 3, overallLength: 50, numberOfFlutes: 3,
  neckDiameter: 2, shoulderLength: 20,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 8000, feedRate: 300, plungeRate: 120, depthOfCut: 2, stepover: 1 } },
} as Tool

const boreTool: Tool = {
  id: 'wo1942-bore-tool', name: 'EM3', type: 'flat_end_mill', diameter: 3,
  fluteLength: 20, shankDiameter: 3, overallLength: 50, numberOfFlutes: 2,
} as Tool

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 40, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 35, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 32, provenance: 'user' },
}

// Mirrors the wizard's pick: derive the target from the live face facts, then
// author the Smart Height band from the same derived loop + cylinder.
async function threadMillOp(geo: ImportedGeometry, faceStableId: string, threadDepth: number): Promise<Operation> {
  const bodyId = geo.modelBody!.ref.bodyId
  const { snapshot, verdicts } = await readModelBodyFaceFacts(bodyId, faceStableId, 'legacy')
  const derived = deriveModelThreadMillTarget(geo, [PLACEMENT], faceStableId, snapshot, verdicts)
  const authoring: ImportedGeometry = {
    ...geo,
    loops: [derived.loop],
    layers2d: [{
      id: derived.loop.layerId, name: 'Selected model cylinder', color: '#4ea1ff', visible: true,
      derived: true, cylinders: [derived.cylinder],
    }],
  }
  const kind: ThreadMillParams['threadKind'] = derived.cylinder.kind === 'bore' ? 'internal' : 'external'
  // The wizard's snap (a 6 mm hole has no table entry within tolerance, so the
  // operator names the thread: M7 x 1, whose tap drill is exactly 6.0 mm).
  const snap = kind === 'internal'
    ? findThreadByBore(derived.cylinder.diameter) ?? { majorDiameter: 7, pitch: 1 }
    : findThreadByMajor(derived.cylinder.diameter)
  const bindings = deriveThreadMillFeatureBindings([authoring], [derived.loop.id])
  if (!bindings.ok) throw new Error(bindings.refusals[0].message)
  const params: ThreadMillParams = {
    geometryId: geo.id, loopIds: [derived.loop.id], geometrySource: 'cylinder',
    threadKind: kind, externalReference: 'top',
    majorDiameter: snap ? snap.majorDiameter : derived.cylinder.diameter,
    pitch: snap ? snap.pitch : 1, handedness: 'right', cutDirection: 'climb',
    roughingPasses: 1, radialStepover: 0.2, springPasses: 0,
    leadInOut: 'arc', compensation: 'computer',
    heightReference: 'geometry_face', planeOffset: 0, threadDepth,
  }
  return {
    id: 'wo1942-thread', name: 'Thread Mill 1', type: 'thread_mill', enabled: true, status: 'pending',
    toolId: threadTool.id, geometrySelections: [derived.loop.id],
    modelReferences: [{ bodyId, stableIds: [faceStableId], role: 'bore-target' }],
    heights: {
      clearanceHeight: 40, clearanceHeightMode: 'absolute', retractHeight: 35, feedHeight: 32,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: 0, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildThreadMillSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
        threadKind: kind, externalReference: 'top', threadDepthMm: threadDepth,
        features: bindings.bindings.map(binding => ({
          loopId: binding.loopId,
          featureKind: binding.featureKind,
          feature: { ...binding.feature },
          topMachineMm: binding.topMm,
          floorMachineMm: binding.floorMm,
          fingerprint: binding.evidenceFingerprint,
        })),
      }),
    },
    passes: {
      stepdown: 2, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: params as unknown as Record<string, unknown>,
  } as unknown as Operation
}

function setupWith(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 80, depth: 30,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [op], notes: '',
  } as Setup
}

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 100, fixedHeight: 80, fixedDepth: 30, fixedStocks: [],
} as SceneStock

function load(geo: ImportedGeometry, op: Operation): void {
  useCamStore.setState(state => ({
    toolLibrary: [threadTool, boreTool],
    project: {
      ...state.project,
      geometry: [geo], stocks: [stock], sceneStock,
      modelItemPlacements: [PLACEMENT],
      setups: [setupWith(op)], activeSetupId: 'setup-1',
    } as Project,
  }))
}

// The Worker runs the REAL toolpath builders for the requests it receives.
interface Request { type: string; payload: Record<string, unknown> & { opId: string } }
let requests: Request[] = []
let moves: ToolpathMove[] = []
let originalWorker: typeof Worker | undefined

function currentOp(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

async function holeWallFaceId(): Promise<string> {
  const verdicts = await recognizeModelBodyHoles(PLATE_BODY, 'legacy')
  const holes = verdicts.filter(v => v.featureClass === 'throughHole' || v.featureClass === 'blindHole')
  expect(holes).toHaveLength(1)
  expect(Number(holes[0].params.diameter)).toBeCloseTo(6, 3)
  for (const faceId of holes[0].faceIds ?? []) {
    const { snapshot } = await readModelBodyFaceFacts(PLATE_BODY, String(faceId), 'legacy')
    if (snapshot.type === 'cylinder') return String(faceId)
  }
  throw new Error('the 6 mm hole has no cylindrical wall face')
}

/** The thread helix moves (leads and plunges excluded): their XY centre,
 *  each move's radius about it, and their Z.
 *  WO-3168 emits the helix as native arcs of at most half a turn, so the
 *  endpoints need not reach the circle's extreme points (and a half-turn
 *  chord fixes no centre on its own). The centre is the arcs' shared centre,
 *  held to the geometry: every arc starts and ends the same distance from it. */
function orbit(path: ToolpathMove[]): { cx: number; cy: number; radii: number[]; zs: number[] } {
  const helix = path.filter(m => m.role === 'helix')
  expect(helix.length).toBeGreaterThan(0)
  const arc = helix.find(m => m.cx !== undefined && m.cy !== undefined)
  expect(arc, 'the helix carries arc centres').toBeDefined()
  const cx = arc!.cx!
  const cy = arc!.cy!
  for (let i = 1; i < helix.length; i++) {
    const a = helix[i - 1], b = helix[i]
    if (b.cx === undefined || b.cy === undefined) continue
    expect(Math.hypot(a.x - cx, a.y - cy)).toBeCloseTo(Math.hypot(b.x - cx, b.y - cy), 3)
  }
  for (const m of helix) {
    if (m.cx !== undefined) expect(m.cx).toBeCloseTo(cx, 2)
    if (m.cy !== undefined) expect(m.cy).toBeCloseTo(cy, 2)
  }
  return {
    cx, cy,
    radii: helix.map(m => Math.hypot(m.x - cx, m.y - cy)),
    zs: helix.map(m => m.z),
  }
}

/** Record what the store computed, for the WO-1942 capture (render.mjs).
 *  Scratch tree unless WRITE_EVIDENCE=1 (WO-1902). */
function recordEvidence(name: string, data: unknown): void {
  const dir = evidenceOutDir('src/tests/evidence/WO-1942')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(data, null, 1)}
`)
}

beforeEach(() => {
  resetDocumentHolder()
  __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  requests = []
  moves = []
  originalWorker = globalThis.Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage(data: Request | { request: unknown }): void {
      // The off-page post-process worker (store/toolpathPostprocess.ts): report
      // "cannot start a module worker" so it runs its own in-page fallback.
      if ('request' in data) {
        queueMicrotask(() => this.onerror?.({ preventDefault() {} } as unknown as ErrorEvent))
        return
      }
      requests.push(data)
      const built = data.type === 'COMPUTE_THREAD_MILL'
        ? buildThreadMillToolpath(data.payload as never)
        : [{ type: 'feed', x: 0, y: 0, z: -1 } as ToolpathMove]
      moves = built
      queueMicrotask(() => this.onmessage?.({
        data: { type: 'TOOLPATH_COMPLETE', opId: data.payload.opId, moves: built, computeTimeMs: 1 },
      } as MessageEvent))
    }
    terminate(): void { /* no-op */ }
    addEventListener(): void { /* no-op */ }
    removeEventListener(): void { /* no-op */ }
  }
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 30 } }),
  }
})

afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = originalWorker
  delete (window as unknown as Record<string, unknown>).__cncViewport
  setModelBodyFaceSnapshotReader(null)
  setModelBodyHoleRecognizer(null)
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
})

describe('WO-1942: Thread Mill from a picked modeled-body hole', () => {
  it('threads the 6 mm through-hole on a modelled plate: helix on the hole axis at the thread diameter, status ready', async () => {
    stashPlateWithHole()
    const geo = modelRow(PLATE_BODY)
    const faceId = await holeWallFaceId()
    const op = await threadMillOp(geo, faceId, 8)
    expect((op.params as unknown as ThreadMillParams).threadKind).toBe('internal')
    load(geo, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    const computed = currentOp()
    expect(computed.status, `errorMessage: ${computed.errorMessage}`).toBe('ready')
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_THREAD_MILL')
    const payload = requests[0].payload as unknown as { params: ThreadMillParams; heights: HeightParams }
    expect(payload.params.threadKind).toBe('internal')
    // Thread band: the hole's top (Z 10) down the authored 8 mm.
    expect(payload.heights).toMatchObject({ topHeight: 10, bottomHeight: 2 })

    const { cx, cy, radii, zs } = orbit(moves)
    expect(cx).toBeCloseTo(HOLE_CENTER_WORLD.x, 2)
    expect(cy).toBeCloseTo(HOLE_CENTER_WORLD.y, 2)
    // Final orbit = major diameter / 2 - tool radius (internal thread).
    const finalRadius = payload.params.majorDiameter / 2 - threadTool.diameter / 2
    expect(payload.params.majorDiameter).toBe(7)
    expect(Math.max(...radii)).toBeCloseTo(finalRadius, 2)
    // Every helix move clears the 6 mm pre-drilled wall's tool-centre circle.
    expect(Math.min(...radii)).toBeGreaterThan(3 - threadTool.diameter / 2)
    expect(Math.min(...zs)).toBeCloseTo(2, 2)
    // The engine threads up through the band and orbits on out of the hole.
    expect(Math.max(...zs)).toBeGreaterThanOrEqual(10)
    expect(computed.toolpathMoves?.length).toBe(moves.length)
    recordEvidence('hole-internal', {
      title: 'Thread Mill on the picked 6 mm through-hole (internal M7 x 1)',
      plate: { min: [10, 5, 0], max: [70, 45, 10] },
      cylinder: { kind: 'hole', center: [HOLE_CENTER_WORLD.x, HOLE_CENTER_WORLD.y], diameter: 6, topZ: 10, bottomZ: 0 },
      band: { top: payload.heights.topHeight, bottom: payload.heights.bottomHeight },
      params: { threadKind: payload.params.threadKind, majorDiameter: payload.params.majorDiameter, pitch: payload.params.pitch },
      toolDiameter: threadTool.diameter,
      status: computed.status,
      moves: computed.toolpathMoves!.map(m => [m.type, m.role ?? '', +m.x.toFixed(4), +m.y.toFixed(4), +m.z.toFixed(4)]),
    })
  }, 60_000)

  it('refuses by name, before any worker dispatch, when the bound face no longer reads as a cylinder', async () => {
    stashPlateWithHole()
    const geo = modelRow(PLATE_BODY)
    const faceId = await holeWallFaceId()
    const op = await threadMillOp(geo, faceId, 8)
    load(geo, op)
    // The model was edited: the bound face now resolves to a plane. Hole
    // recognition still runs through the real headless kernel.
    setModelBodyFaceSnapshotReader(async () => ({
      type: 'plane', centroid: [25, 25, 10], normal: [0, 0, 1], area: 2400,
    }))

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(0)
    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage).toMatch(
      /selected thread cylinder could not be derived: Thread Mill: selected Model face .* is not cylindrical/,
    )
  }, 60_000)
})

describe('WO-1942: Thread Mill from a picked modeled-body boss', () => {
  // A boss wall face spanning local Z 10..18 (min/max Z is all the boss
  // derive reads off the mesh; the XY layout is irrelevant to it).
  const bossDisplay = {
    positions: [44, 20, 10, 36, 20, 10, 44, 20, 18, 36, 20, 18],
    normals: [], indices: [0, 1, 2, 1, 2, 3], edgePositions: [], edgeOffsets: [],
    bbox: { min: [0, 0, 0], max: [60, 40, 18] }, faceIds: ['F1:boss-wall'], triFace: [0, 0],
  }
  const bossVerdict: FeatureVerdict = {
    featureKey: 'loop:40:20:10', featureClass: 'boss', removable: true, effect: 'remove',
    faceIds: ['F1:boss-wall'], neighbourIds: [],
    params: { centerX: 40, centerY: 20, centerZ: 10, spanX: 8, spanY: 8, depth: 8, faceCount: 2 },
  } as FeatureVerdict
  const bossSnapshot: GeometrySnapshot = {
    type: 'cylinder', centroid: [44, 20, 14], normal: [1, 0, 0], area: 200,
    axis: [0, 0, 1], axisPoint: [40, 20, 10], radius: 4,
  }

  it('cuts an external thread around the picked boss', async () => {
    setModelBodyHoleRecognizer(async () => [bossVerdict])
    setModelBodyFaceSnapshotReader(async (_bodyId, faceId) => (faceId === 'F1:boss-wall' ? bossSnapshot : undefined))
    const geo = modelRow('F1', bossDisplay)
    const op = await threadMillOp(geo, 'F1:boss-wall', 6)
    expect((op.params as unknown as ThreadMillParams).threadKind).toBe('external')
    load(geo, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    const computed = currentOp()
    expect(computed.status, `errorMessage: ${computed.errorMessage}`).toBe('ready')
    const payload = requests[0].payload as unknown as { params: ThreadMillParams; heights: HeightParams }
    expect(payload.params.threadKind).toBe('external')
    // Boss top: local Z 18 on a placement at Z 0; thread runs 6 mm down it.
    expect(payload.heights).toMatchObject({ topHeight: 18, bottomHeight: 12 })
    const { cx, cy, radii } = orbit(moves)
    expect(cx).toBeCloseTo(40 + 10, 2)
    expect(cy).toBeCloseTo(20 + 5, 2)
    // External: every orbit move stays OUTSIDE the 8 mm boss wall.
    expect(Math.min(...radii)).toBeGreaterThan(4)
    recordEvidence('boss-external', {
      title: 'Thread Mill on the picked 8 mm boss (external M8 x 1.25)',
      plate: { min: [10, 5, 0], max: [70, 45, 10] },
      cylinder: { kind: 'boss', center: [50, 25], diameter: 8, topZ: 18, bottomZ: 10 },
      band: { top: payload.heights.topHeight, bottom: payload.heights.bottomHeight },
      params: { threadKind: payload.params.threadKind, majorDiameter: payload.params.majorDiameter, pitch: payload.params.pitch },
      toolDiameter: threadTool.diameter,
      status: computed.status,
      moves: computed.toolpathMoves!.map(m => [m.type, m.role ?? '', +m.x.toFixed(4), +m.y.toFixed(4), +m.z.toFixed(4)]),
    })
  }, 60_000)
})

describe('WO-1942: Bore from a picked modeled-body cylinder is unchanged', () => {
  it('Bore on the same 6 mm hole still binds the mbore loop and computes ready', async () => {
    stashPlateWithHole()
    const geo = modelRow(PLATE_BODY)
    const faceId = await holeWallFaceId()
    const loopId = `mbore:${faceId}`
    const heights = {
      clearanceHeight: 40, clearanceHeightMode: 'absolute', retractHeight: 35, feedHeight: 32,
      topHeight: 0, topHeightMode: 'stock_top',
      bottomHeight: 0, bottomHeightMode: 'selected_face', selectedFaceZ: 0, bottomManual: false,
    }
    const params = {
      geometryId: geo.id, loopIds: [loopId], direction: 'climb', sortStrategy: 'nearest_neighbor',
      geometrySource: 'cylinder', targetDiameter: 6, perBoreDepth: true, perBoreDepthOverrides: {},
      heightReference: 'stock_top', planeOffset: -5,
    }
    const op = {
      id: 'wo1942-bore', name: 'Bore 1', type: 'bore', enabled: true, status: 'pending',
      toolId: boreTool.id, geometrySelections: [loopId],
      modelReferences: [{ bodyId: PLATE_BODY, stableIds: [faceId], role: 'bore-target' }],
      heights,
      passes: {
        stepdown: 2, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
      },
      linking: {
        entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
        retractType: 'full', transitionType: 'safe_height',
      },
      params,
      smartHeight: smartHeightAuthorityFixture('bore', {
        setupId: 'setup-1', heights: heights as HeightParams, params, geometryIds: [geo.id],
        stockId: stock.id, explicitDepthMm: 5,
      }),
    } as unknown as Operation
    load(geo, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    const computed = currentOp()
    expect(computed.status, `errorMessage: ${computed.errorMessage}`).toBe('ready')
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_BORE')
    const loops = (requests[0].payload as unknown as { loops: Array<{ id: string }> }).loops
    expect(loops.map(l => l.id)).toEqual([loopId])
  }, 60_000)
})

describe('WO-1942: the operation wizard binds a Thread Mill to a picked model hole', () => {
  type PickCallback = (sel: { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean }) => void

  afterEach(() => {
    cleanup()
    act(() => { useCamStore.getState().closeModal() })
  })

  it('Pick face on the hole wall -> internal thread, bore-target reference, computed ready', async () => {
    stashPlateWithHole()
    const faceId = await holeWallFaceId()
    // The viewport reports a model-face hit by its index into display.faceIds.
    const geo = modelRow(PLATE_BODY, {
      positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
      bbox: { min: [0, 0, 0], max: [60, 40, 10] }, faceIds: [faceId], triFace: [],
    })
    useCamStore.setState(state => ({
      toolLibrary: [threadTool, boreTool],
      project: {
        ...state.project,
        geometry: [geo], stocks: [stock], sceneStock,
        modelItemPlacements: [PLACEMENT],
        setups: [{ ...setupWith({} as Operation), operations: [] }], activeSetupId: 'setup-1',
      } as Project,
    }))
    let pick: PickCallback | null = null
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 30 } }),
      setBrepPickMode: (kind: 'face' | 'edge' | null, cb?: PickCallback | null) => {
        pick = kind === null ? null : (cb ?? null)
      },
    }

    render(createElement(NewOperationModal))
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Thread Mill'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: geo.id } })
    fireEvent.click(screen.getByTestId('brep-pick-face'))
    await waitFor(() => expect(pick).not.toBeNull())
    act(() => { pick!({ geoId: geo.id, kind: 'face', index: 0, isModelFace: true }) })
    await waitFor(() => expect(screen.queryByTestId('model-bore-pick-status')).toBeNull(), { timeout: 15_000 })
    expect(screen.queryByTestId('brep-derive-error')).toBeNull()

    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(threadTool.name))
    await waitFor(
      () => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false),
      { timeout: 15_000 },
    )
    fireEvent.click(screen.getByTestId('op-create'))

    const saved = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(saved.type).toBe('thread_mill')
    expect(saved.modelReferences?.find(ref => ref.role === 'bore-target')?.stableIds).toEqual([faceId])
    const params = saved.params as unknown as ThreadMillParams
    expect(params).toMatchObject({
      geometryId: geo.id, loopIds: [`mthread:${faceId}`], threadKind: 'internal', geometrySource: 'cylinder',
    })
    await waitFor(() => {
      const op = useCamStore.getState().project.setups[0].operations.find(o => o.id === saved.id)!
      expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    }, { timeout: 15_000 })
    const { cx, cy } = orbit(moves)
    expect(cx).toBeCloseTo(HOLE_CENTER_WORLD.x, 2)
    expect(cy).toBeCloseTo(HOLE_CENTER_WORLD.y, 2)
  }, 60_000)
})
