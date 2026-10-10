// WO-1655: Engrave, V-carve, Chamfer, and Thread mill start from earlier material.
//
// Acceptance:
// Each of the four, run after a Face that removed 2 mm on the production compute path:
// the first cut starts at the faced top, not the original stock top; a typed start height
// still wins. A second project with different stock proves it again.

import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightStockBounds } from '../../store'
import {
  buildChamferSmartHeightIntent,
  buildEngraveSmartHeightIntent,
  buildFaceSmartHeightIntent,
  buildThreadMillSmartHeightIntent,
  buildVCarveSmartHeightIntent,
  deriveChamferEdgeBindings,
  type OperationHeightIntentV2,
} from '../../lib/cam/smartHeights'
import { toolBands, writeSideView, type PathPoint } from '../helpers/sideViewEvidence'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox,
  HeightParams,
  ImportedGeometry,
  LinkingParams,
  Operation,
  PassParams,
  PhysicalStock,
  Project,
  Setup,
  Tool,
  ToolHolder,
  ToolpathMove,
  Vec3,
} from '../../types'

const SETUP_ID = 'setup-1'
const LINKING: LinkingParams = {
  entryType: 'plunge',
  rampAngle: 3,
  rampLength: 0,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

const HEIGHTS: HeightParams = {
  clearanceHeight: 15,
  clearanceHeightMode: 'absolute',
  retractHeight: 10,
  feedHeight: 5,
  topHeight: 0,
  topHeightMode: 'absolute',
  bottomHeight: -10,
  bottomHeightMode: 'absolute',
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function sketchRect(id: string, name: string, x0: number, y0: number, x1: number, y1: number): ImportedGeometry {
  return {
    id,
    name,
    filename: `${id}.dxf`,
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: bbox({ x: x0, y: y0, z: 0 }, { x: x1, y: y1, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: DERIVED_STOCK_ID,
    stockIdLocked: true,
    loops: [
      {
        id: `${id}-loop`,
        closed: true,
        type: 'contour',
        layerId: 'L1',
        area: (x1 - x0) * (y1 - y0),
        points: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
      },
    ],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function sketchCircle(id: string, name: string, cx: number, cy: number, r: number): ImportedGeometry {
  const points: { x: number; y: number }[] = []
  const n = 32
  for (let i = 0; i < n; i++) {
    const th = (i * 2 * Math.PI) / n
    points.push({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) })
  }
  return {
    id,
    name,
    filename: `${id}.dxf`,
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: bbox({ x: cx - r, y: cy - r, z: 0 }, { x: cx + r, y: cy + r, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: DERIVED_STOCK_ID,
    stockIdLocked: true,
    loops: [
      {
        id: `${id}-loop`,
        closed: true,
        type: 'hole',
        layerId: 'L1',
        area: Math.PI * r * r,
        points,
      },
    ],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-test',
    name: 'test tool',
    type: 'flat_end_mill',
    diameter: 6,
    fluteLength: 15,
    shankDiameter: 6,
    overallLength: 50,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 600, plungeRate: 200 } },
    ...overrides,
  } as Tool
}

const FACE_TOOL = tool({ id: 'tool-face', name: '10 mm face mill', diameter: 10, shankDiameter: 10 })
const ENGRAVE_TOOL = tool({ id: 'tool-engrave', name: '6 mm V-bit', type: 'v_bit', diameter: 6, angleFromAxisDeg: 45, fluteLength: 10 })
const VCARVE_TOOL = tool({ id: 'tool-vcarve', name: '6 mm 45deg V-bit', type: 'v_bit', diameter: 6, angleFromAxisDeg: 45, fluteLength: 10 })
const CHAMFER_TOOL = tool({ id: 'tool-chamfer', name: '6 mm chamfer mill', type: 'chamfer_mill', diameter: 6, angleFromAxisDeg: 45, fluteLength: 10 })
const THREAD_TOOL = tool({ id: 'tool-thread', name: '4 mm thread mill', type: 'thread_mill', diameter: 4, fluteLength: 12 })

const ALL_TOOLS: Tool[] = [FACE_TOOL, ENGRAVE_TOOL, VCARVE_TOOL, CHAMFER_TOOL, THREAD_TOOL]

const safetyIntent = {
  clearance: { reference: 'retract' as const, offset: 5, provenance: 'inferred' as const },
  retract: { reference: 'stock_top' as const, offset: 5, provenance: 'inferred' as const },
  feed: { reference: 'top' as const, offset: 5, provenance: 'inferred' as const },
}

// ── The worker wire: real toolpathWorker.ts in-process ────────────────────────

let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }

beforeAll(async () => {
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  if (g.window === undefined) g.window = {}
  g.window.__cncViewport = {
    getStockBounds: (stockId?: string) => {
      const project = useCamStore.getState().project
      return smartHeightStockBounds(project, stockId ?? DERIVED_STOCK_ID)
    },
  }
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  delete g.window?.__cncViewport
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void {}
  })
})

function opById(id: string): Operation {
  const op = useCamStore.getState().project.setups
    .find((s) => s.id === SETUP_ID)?.operations.find((o) => o.id === id)
  if (!op) throw new Error(`Operation ${id} not found`)
  return op
}

function topOfPlan(id: string): number {
  const op = opById(id)
  const plan = op.resolvedHeightPlan
  if (!plan) return NaN
  return plan.version === 2 ? plan.machining.materialStart.wcsMm : NaN
}

function makeFaceOp(opts: { id: string; geometryId: string; faceDepthMm: number; toolId?: string }): Operation {
  const params = {
    boundarySource: 'geometry',
    geometryId: opts.geometryId,
    loopIds: [],
    stockOffset: 0,
    boundaryContainment: 'outside',
    avoidanceLoopIds: [],
    pattern: 'zigzag',
    passAngle: 0,
    direction: 'both_ways',
    fromOtherSide: false,
    passExtension: 2,
    chipThinning: false,
    bothSidesPerLevel: false,
    floorStockToLeave: 0,
    finishPass: false,
    entryType: 'plunge',
    leadInRadius: 0,
    leadOutRadius: 0,
    keepToolDown: false,
    maxStayDownDistance: 0,
    extendBeforeRetract: false,
    transition: 'direct',
    tolerance: 0.05,
  }
  const passes: PassParams = { stepdown: opts.faceDepthMm, stepover: 5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: opts.id,
    name: 'Face',
    type: 'face',
    enabled: true,
    status: 'pending',
    toolId: opts.toolId ?? FACE_TOOL.id,
    geometrySelections: [],
    heights: HEIGHTS,
    passes,
    linking: LINKING,
    params,
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildFaceSmartHeightIntent({
        setupId: SETUP_ID,
        safetyIntent,
        mode: 'explicit_depth',
        explicitTargetWcsMm: -opts.faceDepthMm,
        stockId: DERIVED_STOCK_ID,
      }),
    },
  } as unknown as Operation
}

function makeEngraveOp(opts: { id: string; geometryId: string; depthMm?: number }): Operation {
  const depthMm = opts.depthMm ?? 1
  const params = {
    geometryId: opts.geometryId,
    loopIds: [`${opts.geometryId}-loop`],
    includeOpen: true,
    includeClosed: true,
    mode: 'trace',
    depthModel: 'constant',
    side: 'center',
    sideOffset: 0,
    axialOffset: 0,
    targetLineWidth: 0,
    useWidthForDepth: false,
    direction: 'as_drawn',
    tolerance: 0.01,
  }
  const passes: PassParams = { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: opts.id,
    name: 'Engrave',
    type: 'engrave',
    enabled: true,
    status: 'pending',
    toolId: ENGRAVE_TOOL.id,
    geometrySelections: [opts.geometryId],
    heights: HEIGHTS,
    passes,
    linking: LINKING,
    params,
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildEngraveSmartHeightIntent({
        setupId: SETUP_ID,
        safetyIntent,
        datumReference: 'stock_top',
        datumOffsetMm: 0,
        axialOffsetMm: 0,
        depth: { kind: 'explicit', depthMm },
        scope: {
          geometryIds: [opts.geometryId],
          loopIds: [`${opts.geometryId}-loop`],
          includeOpen: true,
          includeClosed: true,
        },
      }),
    },
  } as unknown as Operation
}

function makeVCarveOp(opts: { id: string; geometryId: string; flatDepthMm?: number }): Operation {
  const flatDepthMm = opts.flatDepthMm ?? 1
  const params = {
    geometryId: opts.geometryId,
    loopIds: [`${opts.geometryId}-loop`],
    role: 'carve',
    startDepth: 0,
    startDepthMm: 0,
    flatDepth: flatDepthMm,
    flatDepthMm: flatDepthMm,
    allowanceMm: 0,
    flatClearing: { mode: 'vbit', stepoverMm: 0.5 },
    tolerance: 0.01,
  }
  const passes: PassParams = { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: opts.id,
    name: 'V-carve',
    type: 'vcarve',
    enabled: true,
    status: 'pending',
    toolId: VCARVE_TOOL.id,
    geometrySelections: [opts.geometryId],
    heights: HEIGHTS,
    passes,
    linking: LINKING,
    params,
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildVCarveSmartHeightIntent({
        setupId: SETUP_ID,
        safetyIntent,
        datumReference: 'stock_top',
        datumOffsetMm: 0,
        startDepthMm: 0,
        flatDepth: { kind: 'explicit', depthMm: flatDepthMm },
        scope: {
          geometryIds: [opts.geometryId],
          loopIds: [`${opts.geometryId}-loop`],
        },
      }),
    },
  } as unknown as Operation
}

function makeChamferOp(opts: { id: string; geometry: ImportedGeometry; chamferWidthMm?: number }): Operation {
  const chamferWidthMm = opts.chamferWidthMm ?? 1
  const params = {
    geometryId: opts.geometry.id,
    loopIds: [`${opts.geometry.id}-loop`],
    loopSides: {},
    chamferWidth: chamferWidthMm,
    tipOffset: 0.5,
    overlapMm: 0,
    direction: 'climb',
  }
  const derived = deriveChamferEdgeBindings([opts.geometry], [`${opts.geometry.id}-loop`])
  if (!derived.ok) throw new Error(derived.refusals.map((r) => r.message).join(' '))
  const passes: PassParams = { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: opts.id,
    name: 'Chamfer',
    type: 'chamfer',
    enabled: true,
    status: 'pending',
    toolId: CHAMFER_TOOL.id,
    geometrySelections: [opts.geometry.id],
    heights: HEIGHTS,
    passes,
    linking: LINKING,
    params,
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildChamferSmartHeightIntent({
        setupId: SETUP_ID,
        safetyIntent,
        datumReference: 'stock_top',
        datumOffsetMm: 0,
        chamferWidthMm,
        tipOffsetMm: 0.5,
        features: derived.bindings.map((b) => ({
          loopId: b.loopId,
          feature: { ...b.feature },
          fingerprint: b.evidenceFingerprint,
        })),
      }),
    },
  } as unknown as Operation
}

function makeThreadMillOp(opts: { id: string; geometryId: string; threadDepthMm?: number }): Operation {
  const threadDepthMm = opts.threadDepthMm ?? 6
  const params = {
    geometryId: opts.geometryId,
    loopIds: [`${opts.geometryId}-loop`],
    threadKind: 'internal',
    majorDiameter: 8,
    pitch: 1.25,
    threadDepth: threadDepthMm,
    handedness: 'right',
    cutDirection: 'climb',
    compensation: 'computer',
    leadInOut: 'arc',
    roughingPasses: 1,
    springPasses: 0,
  }
  const passes: PassParams = { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: opts.id,
    name: 'Thread Mill',
    type: 'thread_mill',
    enabled: true,
    status: 'pending',
    toolId: THREAD_TOOL.id,
    geometrySelections: [opts.geometryId],
    heights: HEIGHTS,
    passes,
    linking: LINKING,
    params,
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildThreadMillSmartHeightIntent({
        setupId: SETUP_ID,
        safetyIntent,
        source: 'explicit_band',
        threadKind: 'internal',
        threadDepthMm,
        planeOffsetMm: 0,
        datumReference: 'stock_top',
        geometryIds: [opts.geometryId],
      }),
    },
  } as unknown as Operation
}

function installProject(opts: {
  plateSize: { width: number; height: number; depth: number }
  originZ: number
  geometries: ImportedGeometry[]
  operations: Operation[]
}): void {
  const { plateSize, originZ, geometries, operations } = opts
  const stock = {
    id: DERIVED_STOCK_ID,
    name: 'Stock',
    mode: 'explicit',
    bounds: bbox(
      { x: -plateSize.width / 2, y: -plateSize.height / 2, z: originZ - plateSize.depth },
      { x: plateSize.width / 2, y: plateSize.height / 2, z: originZ },
    ),
    position: { x: -plateSize.width / 2, y: -plateSize.height / 2, z: originZ - plateSize.depth },
  } as unknown as PhysicalStock

  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    stock: {
      mode: 'fixed',
      bounds: { ...stock.bounds },
      margin: { x: 0, y: 0, z: 0 },
      top: 0,
      bottom: -plateSize.depth,
      left: -plateSize.width / 2,
      right: plateSize.width / 2,
      front: -plateSize.height / 2,
      back: plateSize.height / 2,
    },
    wcs: {
      origin: { x: 0, y: 0, z: originZ },
      stockId: DERIVED_STOCK_ID,
      rotation: { x: 0, y: 0, z: 0 },
    },
    operations,
  } as unknown as Setup

  useCamStore.setState(() => ({
    toolLibrary: ALL_TOOLS,
    consoleEvents: [],
    project: {
      schemaVersion: 1,
      name: 'Test Project',
      units: 'mm',
      geometry: geometries,
      stocks: [stock],
      sceneStock: null,
      machine: { id: 'm1', name: 'Machine', limits: { x: [-500, 500], y: [-500, 500], z: [-200, 50] } },
      setups: [setup],
      activeSetupId: SETUP_ID,
      activeOperationId: operations[0]?.id,
      modelItemPlacements: [],
    } as unknown as Project,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT 1: 60 x 40 x 20 mm plate, Face removes 2 mm
// ─────────────────────────────────────────────────────────────────────────────

describe('WO-1655 Project 1: 60 x 40 x 20 mm plate, Face 2 mm', () => {
  const PLATE_TOP_1 = 20
  const FACE_DEPTH_1 = 2

  const faceSketch = sketchRect('dxf-face', 'Face boundary', -30, -20, 30, 20)
  const engraveSketch = sketchRect('dxf-engrave', 'Engrave path', -10, -5, 10, 5)
  const vcarveSketch = sketchRect('dxf-vcarve', 'V-carve outline', -12, -6, 12, 6)
  const chamferSketch = sketchRect('dxf-chamfer', 'Chamfer contour', -15, -10, 15, 10)
  const threadSketch = sketchCircle('dxf-thread', 'Thread hole', 0, 0, 3)

  const allGeos = [faceSketch, engraveSketch, vcarveSketch, chamferSketch, threadSketch]

  it('Engrave: starts at the faced top (-2), not stock top (0); typed start height wins', async () => {
    const face = makeFaceOp({ id: 'op-face', geometryId: 'dxf-face', faceDepthMm: FACE_DEPTH_1 })
    const engrave = makeEngraveOp({ id: 'op-engrave', geometryId: 'dxf-engrave', depthMm: 1 })

    // 1. Without Face: starts at stock top (0), cuts down to -1
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [engrave],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave')
    expect(opById('op-engrave').status).toBe('ready')
    expect(topOfPlan('op-engrave')).toBeCloseTo(0, 3)
    const cutsAlone = (opById('op-engrave').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsAlone[0].z - PLATE_TOP_1, 'first cut without face').toBeCloseTo(-1, 3)

    // 2. With Face: starts at faced top (-2), cuts down to -3
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [face, engrave],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face')
    expect(opById('op-face').status).toBe('ready')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave')
    expect(opById('op-engrave').status).toBe('ready')
    expect(topOfPlan('op-engrave'), 'Engrave top after Face').toBeCloseTo(-FACE_DEPTH_1, 3)
    const cutsAfterFace = (opById('op-engrave').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsAfterFace[0].z - PLATE_TOP_1, 'first cut after face starts at faced top').toBeCloseTo(-FACE_DEPTH_1 - 1, 3)

    // 3. Typed start height wins: operator types top override = 0
    useCamStore.getState().updateOperation(SETUP_ID, 'op-engrave', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-engrave').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave')
    expect(topOfPlan('op-engrave'), 'typed start height wins').toBeCloseTo(0, 3)
    const cutsTyped = (opById('op-engrave').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsTyped[0].z - PLATE_TOP_1, 'first cut with typed override').toBeCloseTo(-1, 3)

    // 4. Disable Face: regenerates against full stock (0)
    useCamStore.getState().updateOperation(SETUP_ID, 'op-engrave', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-engrave').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: undefined,
        },
      },
    })
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', { enabled: false })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave')
    expect(topOfPlan('op-engrave'), 'Face disabled -> back to stock top').toBeCloseTo(0, 3)
  })

  it('V-carve: starts at the faced top (-2), not stock top (0); typed start height wins', async () => {
    const face = makeFaceOp({ id: 'op-face', geometryId: 'dxf-face', faceDepthMm: FACE_DEPTH_1 })
    const vcarve = makeVCarveOp({ id: 'op-vcarve', geometryId: 'dxf-vcarve', flatDepthMm: 1 })

    // 1. Without Face: starts at stock top (0)
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [vcarve],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-vcarve')
    expect(opById('op-vcarve').status).toBe('ready')
    expect(topOfPlan('op-vcarve')).toBeCloseTo(0, 3)

    // 2. With Face: starts at faced top (-2)
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [face, vcarve],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-vcarve')
    expect(opById('op-vcarve').status).toBe('ready')
    expect(topOfPlan('op-vcarve'), 'V-carve top after Face').toBeCloseTo(-FACE_DEPTH_1, 3)
    const cutsAfterFace = (opById('op-vcarve').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsAfterFace[0].z - PLATE_TOP_1, 'first cut after face starts at faced top').toBeCloseTo(-FACE_DEPTH_1 - 1, 3)

    // 3. Typed start height wins
    useCamStore.getState().updateOperation(SETUP_ID, 'op-vcarve', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-vcarve').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-vcarve')
    expect(topOfPlan('op-vcarve'), 'typed start height wins').toBeCloseTo(0, 3)
    const cutsTyped = (opById('op-vcarve').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsTyped[0].z - PLATE_TOP_1).toBeCloseTo(-1, 3)

    // 4. Disable Face: regenerates against full stock (0)
    useCamStore.getState().updateOperation(SETUP_ID, 'op-vcarve', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-vcarve').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: undefined,
        },
      },
    })
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', { enabled: false })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-vcarve')
    expect(topOfPlan('op-vcarve'), 'Face disabled -> back to stock top').toBeCloseTo(0, 3)
  })

  it('Chamfer: starts at the faced top (-2), not stock top (0); typed start height wins', async () => {
    const face = makeFaceOp({ id: 'op-face', geometryId: 'dxf-face', faceDepthMm: FACE_DEPTH_1 })
    const chamfer = makeChamferOp({ id: 'op-chamfer', geometry: chamferSketch, chamferWidthMm: 1 })

    // 1. Without Face: starts at stock top (0)
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [chamfer],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer')
    expect(opById('op-chamfer').status).toBe('ready')
    expect(topOfPlan('op-chamfer')).toBeCloseTo(0, 3)
    const cutsAlone = (opById('op-chamfer').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsAlone[0].z - PLATE_TOP_1, 'chamfer cut depth without face').toBeCloseTo(-1.5, 3) // - chamferWidth(1) - tipOffset(0.5)

    // 2. With Face: starts at faced top (-2)
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [face, chamfer],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer')
    expect(opById('op-chamfer').status).toBe('ready')
    expect(topOfPlan('op-chamfer'), 'Chamfer top after Face').toBeCloseTo(-FACE_DEPTH_1, 3)
    const cutsAfterFace = (opById('op-chamfer').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsAfterFace[0].z - PLATE_TOP_1, 'first cut after face starts at faced top').toBeCloseTo(-FACE_DEPTH_1 - 1.5, 3)

    // 3. Typed start height wins
    useCamStore.getState().updateOperation(SETUP_ID, 'op-chamfer', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-chamfer').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer')
    expect(topOfPlan('op-chamfer'), 'typed start height wins').toBeCloseTo(0, 3)
    const cutsTyped = (opById('op-chamfer').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsTyped[0].z - PLATE_TOP_1).toBeCloseTo(-1.5, 3)

    // 4. Disable Face: back to 0
    useCamStore.getState().updateOperation(SETUP_ID, 'op-chamfer', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-chamfer').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: undefined,
        },
      },
    })
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', { enabled: false })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer')
    expect(topOfPlan('op-chamfer'), 'Face disabled -> back to stock top').toBeCloseTo(0, 3)
  })

  it('Thread mill: starts at the faced top (-2), not stock top (0); typed start height wins', async () => {
    const face = makeFaceOp({ id: 'op-face', geometryId: 'dxf-face', faceDepthMm: FACE_DEPTH_1 })
    const threadMill = makeThreadMillOp({ id: 'op-thread', geometryId: 'dxf-thread', threadDepthMm: 6 })

    // 1. Without Face: starts at stock top (0)
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [threadMill],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-thread')
    expect(opById('op-thread').status).toBe('ready')
    expect(topOfPlan('op-thread')).toBeCloseTo(0, 3)
    const plungeAlone = (opById('op-thread').toolpathMoves ?? []).filter((m) => m.role === 'plunge')
    expect(plungeAlone[0].z - PLATE_TOP_1, 'thread plunge without face').toBeCloseTo(-6, 3) // - threadDepth(6)

    // 2. With Face: starts at faced top (-2)
    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP_1,
      geometries: allGeos,
      operations: [face, threadMill],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-thread')
    expect(opById('op-thread').status).toBe('ready')
    expect(topOfPlan('op-thread'), 'Thread mill top after Face').toBeCloseTo(-FACE_DEPTH_1, 3)
    const plungeAfterFace = (opById('op-thread').toolpathMoves ?? []).filter((m) => m.role === 'plunge')
    expect(plungeAfterFace[0].z - PLATE_TOP_1, 'thread plunge after face starts at faced top').toBeCloseTo(-FACE_DEPTH_1 - 6, 3) // -2 - 6 = -8

    // 3. Typed start height wins
    useCamStore.getState().updateOperation(SETUP_ID, 'op-thread', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-thread').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-thread')
    expect(topOfPlan('op-thread'), 'typed start height wins').toBeCloseTo(0, 3)
    const plungeTyped = (opById('op-thread').toolpathMoves ?? []).filter((m) => m.role === 'plunge')
    expect(plungeTyped[0].z - PLATE_TOP_1).toBeCloseTo(-6, 3)

    // 4. Disable Face: back to 0
    useCamStore.getState().updateOperation(SETUP_ID, 'op-thread', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-thread').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: undefined,
        },
      },
    })
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', { enabled: false })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-thread')
    expect(topOfPlan('op-thread'), 'Face disabled -> back to stock top').toBeCloseTo(0, 3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT 2: 80 x 50 x 30 mm plate, Face removes 3.5 mm
// ─────────────────────────────────────────────────────────────────────────────

describe('WO-1655 Project 2: 80 x 50 x 30 mm plate, Face 3.5 mm', () => {
  const PLATE_TOP_2 = 30
  const FACE_DEPTH_2 = 3.5

  const faceSketch2 = sketchRect('dxf-face-2', 'Face boundary 2', -40, -25, 40, 25)
  const engraveSketch2 = sketchRect('dxf-engrave-2', 'Engrave path 2', -15, -8, 15, 8)
  const vcarveSketch2 = sketchRect('dxf-vcarve-2', 'V-carve outline 2', -18, -10, 18, 10)
  const chamferSketch2 = sketchRect('dxf-chamfer-2', 'Chamfer contour 2', -20, -12, 20, 12)
  const threadSketch2 = sketchCircle('dxf-thread-2', 'Thread hole 2', 5, 5, 2.5)

  const allGeos2 = [faceSketch2, engraveSketch2, vcarveSketch2, chamferSketch2, threadSketch2]

  it('Engrave on Project 2: starts at -3.5 after Face; typed override wins', async () => {
    const face = makeFaceOp({ id: 'op-face-2', geometryId: 'dxf-face-2', faceDepthMm: FACE_DEPTH_2 })
    const engrave = makeEngraveOp({ id: 'op-engrave-2', geometryId: 'dxf-engrave-2', depthMm: 1.5 })

    installProject({
      plateSize: { width: 80, height: 50, depth: 30 },
      originZ: PLATE_TOP_2,
      geometries: allGeos2,
      operations: [face, engrave],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face-2')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave-2')

    expect(opById('op-engrave-2').status).toBe('ready')
    expect(topOfPlan('op-engrave-2')).toBeCloseTo(-FACE_DEPTH_2, 3)
    const cuts = (opById('op-engrave-2').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cuts[0].z - PLATE_TOP_2).toBeCloseTo(-FACE_DEPTH_2 - 1.5, 3)

    // Typed override
    useCamStore.getState().updateOperation(SETUP_ID, 'op-engrave-2', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-engrave-2').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave-2')
    expect(topOfPlan('op-engrave-2')).toBeCloseTo(0, 3)
    const cutsTyped = (opById('op-engrave-2').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsTyped[0].z - PLATE_TOP_2).toBeCloseTo(-1.5, 3)
  })

  it('V-carve on Project 2: starts at -3.5 after Face; typed override wins', async () => {
    const face = makeFaceOp({ id: 'op-face-2', geometryId: 'dxf-face-2', faceDepthMm: FACE_DEPTH_2 })
    const vcarve = makeVCarveOp({ id: 'op-vcarve-2', geometryId: 'dxf-vcarve-2', flatDepthMm: 2 })

    installProject({
      plateSize: { width: 80, height: 50, depth: 30 },
      originZ: PLATE_TOP_2,
      geometries: allGeos2,
      operations: [face, vcarve],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face-2')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-vcarve-2')

    expect(opById('op-vcarve-2').status).toBe('ready')
    expect(topOfPlan('op-vcarve-2')).toBeCloseTo(-FACE_DEPTH_2, 3)
    const cuts = (opById('op-vcarve-2').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cuts[0].z - PLATE_TOP_2).toBeCloseTo(-FACE_DEPTH_2 - 2, 3)

    // Typed override
    useCamStore.getState().updateOperation(SETUP_ID, 'op-vcarve-2', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-vcarve-2').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-vcarve-2')
    expect(topOfPlan('op-vcarve-2')).toBeCloseTo(0, 3)
    const cutsTyped = (opById('op-vcarve-2').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsTyped[0].z - PLATE_TOP_2).toBeCloseTo(-2, 3)
  })

  it('Chamfer on Project 2: starts at -3.5 after Face; typed override wins', async () => {
    const face = makeFaceOp({ id: 'op-face-2', geometryId: 'dxf-face-2', faceDepthMm: FACE_DEPTH_2 })
    const chamfer = makeChamferOp({ id: 'op-chamfer-2', geometry: chamferSketch2, chamferWidthMm: 1.5 })

    installProject({
      plateSize: { width: 80, height: 50, depth: 30 },
      originZ: PLATE_TOP_2,
      geometries: allGeos2,
      operations: [face, chamfer],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face-2')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer-2')

    expect(opById('op-chamfer-2').status).toBe('ready')
    expect(topOfPlan('op-chamfer-2')).toBeCloseTo(-FACE_DEPTH_2, 3)
    const cuts = (opById('op-chamfer-2').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cuts[0].z - PLATE_TOP_2).toBeCloseTo(-FACE_DEPTH_2 - 2, 3) // -1.5 - 0.5 = -2

    // Typed override
    useCamStore.getState().updateOperation(SETUP_ID, 'op-chamfer-2', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-chamfer-2').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer-2')
    expect(topOfPlan('op-chamfer-2')).toBeCloseTo(0, 3)
    const cutsTyped = (opById('op-chamfer-2').toolpathMoves ?? []).filter((m) => m.type !== 'rapid')
    expect(cutsTyped[0].z - PLATE_TOP_2).toBeCloseTo(-2, 3)
  })

  it('Thread mill on Project 2: starts at -3.5 after Face; typed override wins', async () => {
    const face = makeFaceOp({ id: 'op-face-2', geometryId: 'dxf-face-2', faceDepthMm: FACE_DEPTH_2 })
    const threadMill = makeThreadMillOp({ id: 'op-thread-2', geometryId: 'dxf-thread-2', threadDepthMm: 5 })

    installProject({
      plateSize: { width: 80, height: 50, depth: 30 },
      originZ: PLATE_TOP_2,
      geometries: allGeos2,
      operations: [face, threadMill],
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face-2')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-thread-2')

    expect(opById('op-thread-2').status).toBe('ready')
    expect(topOfPlan('op-thread-2')).toBeCloseTo(-FACE_DEPTH_2, 3)
    const plunges = (opById('op-thread-2').toolpathMoves ?? []).filter((m) => m.role === 'plunge')
    expect(plunges[0].z - PLATE_TOP_2).toBeCloseTo(-FACE_DEPTH_2 - 5, 3) // -3.5 - 5 = -8.5

    // Typed override
    useCamStore.getState().updateOperation(SETUP_ID, 'op-thread-2', {
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          ...(opById('op-thread-2').smartHeight!.intent as OperationHeightIntentV2),
          planeOverrides: {
            top: { reference: 'wcs_plane', offsetMm: 0, owner: { kind: 'user_override' } },
          },
        },
      },
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-thread-2')
    expect(topOfPlan('op-thread-2')).toBeCloseTo(0, 3)
    const plungesTyped = (opById('op-thread-2').toolpathMoves ?? []).filter((m) => m.role === 'plunge')
    expect(plungesTyped[0].z - PLATE_TOP_2).toBeCloseTo(-5, 3)
  })
})

// ─── Tier 2 pictures: side view evidence in src/tests/evidence/WO-1655/ ──────

describe('WO-1655 pictures', () => {
  it('WRITE_EVIDENCE=1 captures side views of Engrave and Chamfer after Face', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return

    const PLATE_TOP = 20
    const FACE_DEPTH = 2
    const faceSketch = sketchRect('dxf-face-pic', 'Face boundary', -30, -20, 30, 20)
    const engraveSketch = sketchRect('dxf-engrave-pic', 'Engrave path', -10, -5, 10, 5)
    const chamferSketch = sketchRect('dxf-chamfer-pic', 'Chamfer contour', -15, -10, 15, 10)

    const face = makeFaceOp({ id: 'op-face-pic', geometryId: 'dxf-face-pic', faceDepthMm: FACE_DEPTH })
    const engrave = makeEngraveOp({ id: 'op-engrave-pic', geometryId: 'dxf-engrave-pic', depthMm: 1 })
    const chamfer = makeChamferOp({ id: 'op-chamfer-pic', geometry: chamferSketch, chamferWidthMm: 1 })

    installProject({
      plateSize: { width: 60, height: 40, depth: 20 },
      originZ: PLATE_TOP,
      geometries: [faceSketch, engraveSketch, chamferSketch],
      operations: [face, engrave, chamfer],
    })

    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-face-pic')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-engrave-pic')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'op-chamfer-pic')

    const holder: ToolHolder = { id: 'h', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }
    const toPath = (moves: readonly ToolpathMove[]): PathPoint[] =>
      moves.map((m) => ({
        x: m.x,
        y: m.y,
        z: m.z,
        kind: m.type === 'rapid' || m.role === 'rapid' ? 'traverse' as const : m.role === 'plunge' ? 'plunge' as const : 'cut' as const,
      }))

    const dir = 'src/tests/evidence/WO-1655'
    const engraveMoves = opById('op-engrave-pic').toolpathMoves ?? []
    const chamferMoves = opById('op-chamfer-pic').toolpathMoves ?? []

    writeSideView({
      dir,
      name: '1-engrave-faced-top',
      title: 'Engrave starts at the faced top (Z = -2.000)',
      subtitle: 'Plate 60 x 40 x 20, Face removed 2 mm. Engrave 1 mm deep starts at Z -2.000, not stock top.',
      obstacles: [{ columns: [[-30, 30, 0, PLATE_TOP - FACE_DEPTH]], colour: '#c0392b', label: 'faced material' }],
      path: toPath(engraveMoves),
      bands: toolBands(ENGRAVE_TOOL, holder),
      placements: [{ x: 0, tipZ: PLATE_TOP - FACE_DEPTH - 1 }],
      referenceLines: [
        { z: PLATE_TOP, label: 'original stock top' },
        { z: PLATE_TOP - FACE_DEPTH, label: 'faced top' },
      ],
      captions: [
        'Red = remaining material after Face - blue = Engrave cut at Z -3.000, starting from faced top Z -2.000',
      ],
    })

    writeSideView({
      dir,
      name: '2-chamfer-faced-top',
      title: 'Chamfer starts at the faced top (Z = -2.000)',
      subtitle: 'Plate 60 x 40 x 20, Face removed 2 mm. Chamfer width 1 mm cut starts from faced top Z -2.000.',
      obstacles: [{ columns: [[-30, 30, 0, PLATE_TOP - FACE_DEPTH]], colour: '#c0392b', label: 'faced material' }],
      path: toPath(chamferMoves),
      bands: toolBands(CHAMFER_TOOL, holder),
      placements: [{ x: 0, tipZ: PLATE_TOP - FACE_DEPTH - 1.5 }],
      referenceLines: [
        { z: PLATE_TOP, label: 'original stock top' },
        { z: PLATE_TOP - FACE_DEPTH, label: 'faced top' },
      ],
      captions: [
        'Red = remaining material after Face - blue = Chamfer cut along edge at faced top Z -2.000',
      ],
    })
  })
})
