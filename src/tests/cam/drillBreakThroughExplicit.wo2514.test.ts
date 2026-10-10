// WO-2514: a Drill set by explicit depth (Material Start / Target End) can break
// through on purpose - the full diameter passes the bottom by the Break through
// distance, with the drill point length added from the tool's own angle.
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts
//   -> the op's toolpathMoves -> postProject(UCCNC_CONFIG) -> the posted Z words
//
// The only stand-in is the Worker thread (node has none): the stub hands each
// request to the real worker module in-process (same harness as pocketSlotFeed.wo2291).
//
// Fixture: a 6 mm circle in a DXF on a 12 mm plate, 5 mm 118 deg drill, explicit
// Material Start 0 and Target End -8.0 (WCS Z; work zero at the plate top).

import { beforeAll, describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import { UCCNC_CONFIG } from '../../lib/post'
import { postProject } from '../../lib/post/postProject'
import { buildDrillBoreAuthoringIntent } from '../../lib/cam/smartHeights/drillBoreAuthoring'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  defaultBoreParams, defaultDrillParams, defaultHeights, defaultLinking, defaultPasses,
} from '../../components/modals/newOperationModalDefaults'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  FixedStockItem, ImportedGeometry, Operation, PhysicalStock, SceneStock, Setup, Tool, ToolpathMove,
} from '../../types'

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = { postMessage: (msg) => { deliver?.(msg) }, onmessage: null }

class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

const BOTTOM = -8
const POINT = 2.5 / Math.tan(59 * Math.PI / 180)

function drillTool(angleFromAxisDeg = 59): Tool {
  return {
    id: 'drill-5', name: '5 mm Drill', toolNumber: 1, type: 'drill', diameter: 5, tipDiameter: 0, angleFromAxisDeg,
    fluteLength: 30, shankDiameter: 5, overallLength: 70, numberOfFlutes: 2, material: 'hss', coating: 'none',
    notes: '', feedsAndSpeeds: { default: { rpm: 3000, feedRate: 300, plungeRate: 150, depthOfCut: 2, stepover: 1 } },
  } as unknown as Tool
}

function boreTool(): Tool {
  return {
    id: 'mill-4', name: '4 mm end mill', toolNumber: 2, type: 'flat_end_mill', diameter: 4,
    fluteLength: 20, shankDiameter: 4, overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    notes: '', feedsAndSpeeds: { default: { rpm: 12000, feedRate: 600, plungeRate: 200, depthOfCut: 1, stepover: 1 } },
  } as unknown as Tool
}

function circle(r: number) {
  return Array.from({ length: 48 }, (_, k) => ({
    x: 30 + r * Math.cos((2 * Math.PI * k) / 48), y: 20 + r * Math.sin((2 * Math.PI * k) / 48),
  }))
}

function geometry(r: number): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Holes', filename: 'holes.dxf', type: 'curves_2d', format: 'dxf', stockId: 'stock-1',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 0 },
      size: { x: 60, y: 40, z: 0 }, center: { x: 30, y: 20, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [{ id: 'hole', layerId: 'L1', closed: true, type: 'contour', area: Math.PI * r * r, points: circle(r) }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function operation(kind: 'drill' | 'bore', breakthroughMm: number | undefined, geo: ImportedGeometry): Operation {
  const safetyIntent = defaultHeightIntent()
  const base = kind === 'drill' ? defaultDrillParams : defaultBoreParams
  const params: Record<string, unknown> = {
    ...base, geometryId: geo.id, loopIds: ['hole'],
    ...(kind === 'drill' ? { perHoleDepth: false } : { perBoreDepth: false }),
  }
  if (breakthroughMm === undefined) delete params.breakthroughMm
  else params.breakthroughMm = breakthroughMm
  return {
    id: 'op-1', name: kind === 'drill' ? 'Drill 1' : 'Bore 1', type: kind, enabled: true, status: 'pending',
    toolId: kind === 'drill' ? 'drill-5' : 'mill-4', geometrySelections: ['hole'],
    heights: { ...defaultHeights, heightIntent: safetyIntent },
    passes: { ...defaultPasses }, linking: { ...defaultLinking }, params,
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreAuthoringIntent({
        operationType: kind, setupId: 'setup-1', safetyIntent, geometries: [geo], selectedLoopIds: ['hole'],
        draft: { mode: 'explicit_depth', explicitStartWcsMm: 0, explicitEndWcsMm: BOTTOM },
      }),
    },
  } as unknown as Operation
}

function install(op: Operation, geo: ImportedGeometry, drillAngleFromAxisDeg = 59): void {
  const stock: FixedStockItem = {
    id: 'stock-1', name: 'Plate', width: 60, height: 40, depth: 12, position: { x: 0, y: 0, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: 60, fixedHeight: 40, fixedDepth: 12, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 12 },
      size: { x: 60, y: 40, z: 12 }, center: { x: 30, y: 20, z: 6 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
  const setup: Setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 12 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: [op],
    notes: '',
  } as Setup
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [geo], setups: [setup], sceneStock, stocks: [physicalStock],
      activeSetupId: 'setup-1', activeOperationId: op.id,
      toolLibrary: [drillTool(drillAngleFromAxisDeg), boreTool()],
    },
    toolLibrary: [drillTool(drillAngleFromAxisDeg), boreTool()],
    toolpathBatch: null,
    consoleEvents: [],
  }))
}

interface Run {
  bottomRow: number | undefined
  physicalBottom: number | undefined
  deepestMoveWcs: number
  postedZ: number[]
  gcode: string[]
}

async function run(op: Operation, geo: ImportedGeometry, drillAngleFromAxisDeg = 59): Promise<Run> {
  install(op, geo, drillAngleFromAxisDeg)
  await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
  const project = useCamStore.getState().project
  const done = project.setups[0].operations[0]
  expect(done.status, done.errorMessage).toBe('ready')
  const plan = done.resolvedHeightPlan?.version === 2 ? done.resolvedHeightPlan : undefined
  const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2514', ext: 'nc',
    selectedOpIds: { 'setup-1': [op.id] },
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const span = result.operationSpans!.find(s => s.opId === op.id)!
  const gcode = result.gcode.split('\n').slice(span.startLine - 1, span.endLine)
  const postedZ = gcode.flatMap(line => {
    const m = /\bZ(-?[\d.]+)/.exec(line.replace(/\(.*?\)/g, ''))
    return m ? [Number(m[1])] : []
  })
  const moves: ToolpathMove[] = done.toolpathMoves ?? []
  return {
    bottomRow: plan?.machining.cutterCenterEnd?.wcsMm,
    physicalBottom: plan?.machining.physicalTarget?.wcsMm,
    deepestMoveWcs: Math.min(...moves.map(m => m.z)) - 12,
    postedZ,
    gcode,
  }
}

const ORIGINAL_WORKER = globalThis.Worker
let drillBreak: Run, drillZero: Run, drillAbsent: Run, boreBreak: Run, boreZero: Run, flatBreak: Run

beforeAll(async () => {
  ;(globalThis as { Worker: unknown }).Worker = InProcessToolpathWorker
  ;(globalThis as { self: unknown }).self = workerSelf
  await import('../../lib/cam/toolpathWorker')
  drillBreak = await run(operation('drill', 0.5, geometry(3)), geometry(3))
  drillZero = await run(operation('drill', 0, geometry(3)), geometry(3))
  drillAbsent = await run(operation('drill', undefined, geometry(3)), geometry(3))
  boreBreak = await run(operation('bore', 0.5, geometry(6)), geometry(6))
  boreZero = await run(operation('bore', 0, geometry(6)), geometry(6))
  // A 180 deg flat-bottom drill: half-angle 90, as the Tool Library stores it.
  flatBreak = await run(operation('drill', 0.5, geometry(3)), geometry(3), 90)
  ;(globalThis as { Worker: unknown }).Worker = ORIGINAL_WORKER
  console.info('[WO-2514]', JSON.stringify({
    drillBreak: { bottomRow: drillBreak.bottomRow, deepestZ: Math.min(...drillBreak.postedZ), gcode: drillBreak.gcode },
    drillZero: { bottomRow: drillZero.bottomRow, deepestZ: Math.min(...drillZero.postedZ), gcode: drillZero.gcode },
    boreBreak: { bottomRow: boreBreak.bottomRow, deepestZ: Math.min(...boreBreak.postedZ) },
  }))
}, 120_000)

describe('WO-2514: explicit-depth Drill breaks through at full diameter', () => {
  it('Break through 0.5 mm posts the tip at Target End - 0.5 - drill point = -10.00 mm', () => {
    const expected = BOTTOM - 0.5 - POINT
    expect(expected).toBeCloseTo(-10.0, 2)
    expect(drillBreak.physicalBottom).toBeCloseTo(BOTTOM, 6)
    expect(drillBreak.bottomRow).toBeCloseTo(expected, 6)
    expect(drillBreak.deepestMoveWcs).toBeCloseTo(expected, 4)
    expect(Math.min(...drillBreak.postedZ)).toBeCloseTo(expected, 2)
    expect(drillBreak.gcode).toContain('G98 G81 X30 Y20 Z-10.002 R5 F150')
    expect(drillZero.gcode).toContain('G98 G81 X30 Y20 Z-8 R5 F150')
  })

  it('Break through 0 (and an old project with no setting) leaves the tip at the bottom, as before', () => {
    for (const r of [drillZero, drillAbsent]) {
      expect(r.bottomRow).toBeCloseTo(BOTTOM, 6)
      expect(r.deepestMoveWcs).toBeCloseTo(BOTTOM, 4)
      expect(Math.min(...r.postedZ)).toBeCloseTo(BOTTOM, 3)
    }
    expect(drillAbsent.gcode.join('\n')).toBe(drillZero.gcode.join('\n'))
  })

  it('a 180 deg flat-bottom drill has no point length: Break through 0.5 mm posts the tip at -8.50 mm', () => {
    expect(flatBreak.physicalBottom).toBeCloseTo(BOTTOM, 6)
    expect(flatBreak.bottomRow).toBeCloseTo(BOTTOM - 0.5, 6)
    expect(flatBreak.deepestMoveWcs).toBeCloseTo(BOTTOM - 0.5, 4)
    expect(Math.min(...flatBreak.postedZ)).toBeCloseTo(BOTTOM - 0.5, 3)
    expect(flatBreak.gcode).toContain('G98 G81 X30 Y20 Z-8.5 R5 F150')
  })

  it('Bore with an explicit Target End is unchanged: the tool ends at the bottom whatever the setting', () => {
    expect(boreBreak.bottomRow).toBeCloseTo(BOTTOM, 6)
    expect(Math.min(...boreBreak.postedZ)).toBeCloseTo(BOTTOM, 3)
    expect(boreBreak.gcode.join('\n')).toBe(boreZero.gcode.join('\n'))
  })
})
