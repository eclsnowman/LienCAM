// WO-3008 08b: one placement transform per part instance, one STL recentring
// rule, Z = 0 at the table, the rotated-part policy (MD-43) and the loop-typing
// policy (MD-44), both OFF at parity.
//
// Independent truths: today's copies of each rule (read-only), the app's real
// store compute route for the rotated-part refusal, and the real STL and SVG
// importers for the loop-typing record.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meshRecenterShift } from '../../mesh/recognition/toolpathTargets'
import { recentredForDisplay } from '../../lib/workholding/shapes'
import { resolveAdaptive3dPartSource } from '../../cam3d/integration/adaptive3dPartSource'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'
import { partWorldTransform } from '../../store/partTransform'
import { effectiveZRotationDeg } from '../../store/dispatchGeo'
import { seatedPositionFromBounds } from '../../lib/import/seatGeometry'
import { parseStl } from '../../cam3d/input/stl'
import { projectSTLToLoops } from '../../lib/geometry/stlProjection'
import { operatorText } from '../../i18n/locales/en/console-and-operator-messages'
import {
  PARITY_POLICY, ROTATED_PART_REFUSAL_KEYS, TABLE_Z, effectiveYawDeg, geometryWorldAabb, loopTypingDiff,
  partPlacement, placePoint, rotatedPartDecision, stlRecentreShift, typeLoops, windingType, type WorldLoop,
} from '../../kernel/world'
import { restStepFixture } from '../cam3d/restStepFixture'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Operation, OperationType, PhysicalStock, SceneStock, Setup, Tool } from '../../types'
import type { PartMesh } from '../../cam3d/kernel/types'

// The world service names keys as plain strings; the typed i18n function wants its key union.
const say = (key: string, values: Record<string, unknown>) => (operatorText as unknown as (k: string, o: Record<string, unknown>) => string)(key, values)

const EVIDENCE = 'src/tests/evidence/WO-3008'
const bb = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] },
  size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
  center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
})
function readStl(path: string) {
  const bytes = readFileSync(path)
  return parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}
const stlPositions = (path: string): Float32Array => readStl(path).positions
const minZ = (positions: ArrayLike<number>) => { let z = Infinity; for (let i = 2; i < positions.length; i += 3) z = Math.min(z, positions[i]); return z }

describe('WO-3008 placement and the STL recentring rule', () => {
  it('one STL recentring rule equals every exported copy, on a real example STL', () => {
    const positions = stlPositions('examples/01-fixture-plate/fixture-plate.stl')
    const shift = stlRecentreShift(positions)
    const [sx, sy, sz] = meshRecenterShift({ positions } as Parameters<typeof meshRecenterShift>[0])
    expect([shift.x, shift.y, shift.z]).toEqual([sx, sy, sz])
    const shifted = Float32Array.from({ length: positions.length }, (_, i) =>
      positions[i] + (i % 3 === 0 ? shift.x : i % 3 === 1 ? shift.y : shift.z))
    expect(recentredForDisplay(positions, []).positions).toEqual(shifted)
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], positions[i]); hi[i % 3] = Math.max(hi[i % 3], positions[i]) }
    const mesh: PartMesh = { positions, indices: new Uint32Array(0), bounds: { min: lo as [number, number, number], max: hi as [number, number, number] }, source: 'stl' }
    const stlRow = { id: 'p', name: 'p', filename: 'p.stl', type: 'mesh', format: 'stl', boundingBox: bb([0, 0, 0], [1, 1, 1]),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true } as ImportedGeometry
    expect(resolveAdaptive3dPartSource(stlRow, [], mesh).partMesh.positions).toEqual(shifted)
    expect(stlRecentreShift([])).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('one placement per part instance: imported pose, Model Item placement, no placement named', () => {
    const imported = { id: 'a', name: 'a', filename: 'a.step', type: 'brep', format: 'step', boundingBox: bb([0, 0, 0], [1, 1, 1]),
      position: { x: 10, y: -4, z: 2 }, rotation: { x: 0, y: 0, z: 37 }, loaded: true } as ImportedGeometry
    const placed = partPlacement(imported)
    expect(placed.ok && { position: placed.position, rotation: placed.rotation }).toEqual(partWorldTransform(imported, []))
    const model = { ...imported, id: 'm', format: 'model', type: 'model', modelItemId: 'item', position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 }, modelBody: { ref: { bodyId: 'b', lineageId: 'b', stableIds: [], version: 1 } } } as unknown as ImportedGeometry
    const records = [
      { modelItemId: 'item', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 } },
      { modelItemId: 'item', bodyId: 'b', position: { x: 5, y: 6, z: 7 }, rotation: { x: 90, y: 0, z: 0 } },
    ]
    const fromModel = partPlacement(model, records)
    expect(fromModel.ok && { position: fromModel.position, rotation: fromModel.rotation }).toEqual(resolveModelReferenceFrame(records, 'item', 'b'))
    const itemOnly = partPlacement(model, records.slice(0, 1))
    expect(itemOnly.ok && itemOnly.position).toEqual(resolveModelReferenceFrame(records.slice(0, 1), 'item', 'b').position)
    expect(partPlacement(model, [])).toEqual({ ok: false, reason: 'no-placement', modelItemId: 'item', bodyId: 'b' })
    expect(() => resolveModelReferenceFrame([], 'item', 'b')).toThrow()
    // The yaw the 2.5D lane reads, representation-independent.
    for (const rotation of [{ x: 0, y: 0, z: 37 }, { x: 180, y: 180, z: -10 }, { x: 0, y: 0, z: -135 }]) {
      expect(effectiveYawDeg(rotation)).toBe(effectiveZRotationDeg(rotation))
    }
    if (placed.ok) expect(placePoint(placed.toWorld, { x: 1, y: 0, z: 0 }).z).toBe(2)
  })

  it('Z = 0 at the table for 2.5D loops, 3D-lane meshes, modelled bodies and workholding', () => {
    // 3D lane: a real STL, raw Z off the table, recentred then placed at the import pose.
    const positions = stlPositions('examples/04-tool-storage-bar/tool-storage-bar.stl')
    const shift = stlRecentreShift(positions)
    expect(minZ(positions) + shift.z).toBe(TABLE_Z)
    // STEP keeps native coordinates and is seated by its pose.
    const step = { id: 's', name: 's', filename: 's.step', type: 'brep', format: 'step', boundingBox: bb([-3, -4, 12], [30, 40, 25]),
      rotation: { x: 0, y: 0, z: 0 }, loaded: true } as ImportedGeometry
    step.position = seatedPositionFromBounds(step.boundingBox.min, step.boundingBox.max)
    expect(geometryWorldAabb(step, {})?.min.z).toBe(TABLE_Z)
    // 2.5D loops sit flat at the import pose's Z, which is the table.
    const flat = { id: 'd', name: 'd', filename: 'd.dxf', type: 'curves_2d', format: 'dxf', boundingBox: bb([0, 0, 0], [0, 0, 0]),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      loops: [{ id: 'l', closed: true, type: 'contour', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] }] } as ImportedGeometry
    expect(geometryWorldAabb(flat, {})).toMatchObject({ min: { z: TABLE_Z }, max: { z: TABLE_Z } })
    // Modelled body: body-local bbox through a placement seated the same way.
    const model = { ...step, id: 'm', format: 'model', type: 'model', modelItemId: 'item', position: { x: 0, y: 0, z: 0 },
      modelBody: { ref: { bodyId: 'b', lineageId: 'b', stableIds: [], version: 1 },
        display: { positions: [], indices: [], normals: [], edgePositions: [], edgeOffsets: [], bbox: { min: [-1, -1, 4], max: [9, 9, 11] } } } } as unknown as ImportedGeometry
    const seat = seatedPositionFromBounds({ x: -1, y: -1, z: 4 }, { x: 9, y: 9, z: 11 })
    expect(geometryWorldAabb(model, { modelItemPlacements: [{ modelItemId: 'item', position: seat, rotation: { x: 0, y: 0, z: 0 } }] })?.min.z).toBe(TABLE_Z)
    // Workholding shapes are drawn recentred (STL rule), bottom on the table.
    const vise = stlPositions('examples/06-knob-handwheel/knob-fixed-jaw.stl')
    expect(minZ(recentredForDisplay(vise, []).positions)).toBe(TABLE_Z)
  })
})

// ── MD-43 rotated part: today's refusal through the app's real compute route ──
function tool(id: string): Tool {
  return { id, name: id, type: 'ball_end_mill', diameter: 3, fluteLength: 12, shankDiameter: 3, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 300, depthOfCut: 1, stepover: 0.5 } } }
}
function operation(type: OperationType, params: Record<string, unknown>): Operation {
  return stampSmartHeightAuthority({
    id: `op-${type}`, name: `My ${type}`, type, enabled: true, status: 'pending', toolId: 't', geometrySelections: ['geo'],
    heights: { clearanceHeight: 25, clearanceHeightMode: 'absolute', retractHeight: 17, feedHeight: 16, topHeight: 0,
      topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom' },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    params,
  }, { setupId: 'setup', geometryIds: ['geo'], stockId: 'stock' })
}

async function computeRotated(type: OperationType, params: Record<string, unknown>, geo: ImportedGeometry, mesh: PartMesh): Promise<Operation> {
  vi.resetModules()
  vi.doMock('../../cam3d/integration/parallel3dOperation', async importOriginal => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: vi.fn(async () => mesh),
  }))
  vi.doMock('../../lib/stepCache', async importOriginal => typedMock<typeof import('../../lib/stepCache')>({
    ...(await importOriginal<typeof import('../../lib/stepCache')>()),
    loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
  }))
  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', { localStorage, __cncViewport: { getStockBounds: () => null } })
  const { useCamStore } = await import('../../store')
  const op = operation(type, params)
  const setup: Setup = { id: 'setup', name: 'setup', notes: '', operations: [op],
    wcs: { id: 'wcs', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: 'stock' },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } }
  const stock: PhysicalStock = { id: 'stock', name: 'stock', mode: 'explicit', bounds: bb([0, 0, 0], [70, 50, 12]), position: { x: 0, y: 0, z: 0 } }
  const sceneStock: SceneStock = { mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 70, fixedHeight: 50, fixedDepth: 12,
    fixedStocks: [{ id: 'stock', name: 'stock', width: 70, height: 50, depth: 12, position: { x: 0, y: 0, z: 0 } }] }
  useCamStore.setState(state => ({
    project: { ...state.project, id: `wo3008-${type}`, geometry: [geo], setups: [setup], stocks: [stock], sceneStock,
      toolLibrary: [tool('t')], activeSetupId: 'setup' },
    toolLibrary: [tool('t')], toolpathBatch: null,
  }))
  await useCamStore.getState().computeOperationToolpath('setup', op.id)
  return useCamStore.getState().project.setups[0].operations[0]
}

describe('WO-3008 MD-43 rotated-part policy (off = parity)', () => {
  afterEach(() => {
    vi.doUnmock('../../cam3d/integration/parallel3dOperation')
    vi.doUnmock('../../lib/stepCache')
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const mesh = restStepFixture()
  const turned = { id: 'geo', name: 'Turned block', filename: 'turned.step', type: 'brep', format: 'step',
    boundingBox: bb([0, 0, 0], [70, 50, 12]), position: { x: 0, y: 0, z: 0 }, rotation: { x: 90, y: 0, z: 0 },
    loaded: true, stockId: 'stock' } as ImportedGeometry

  it.each([
    ['parallel-compute', 'parallel_3d', { stepover: 1, angle: 0, tolerance: 0.2, useStockBoundary: false }],
    ['waterline-compute', 'waterline_3d', { stepdown: 2, tolerance: 0.2, useStockBoundary: false }],
    ['adaptive-compute', 'adaptive_3d', { maxStepdown: 2, stepover: 0.4, tolerance: 0.2, helixDiameter: 2, helixAngleDeg: 10, cellSize: 1, useStockBoundary: false }],
  ] as const)('policy off reproduces today\'s %s refusal word for word (90 deg about X)', async (route, type, params) => {
    const decision = rotatedPartDecision(route, `My ${type}`, turned, [], PARITY_POLICY)
    expect(decision.refused).toBe(true)
    if (!decision.refused) return
    const op = await computeRotated(type, params, turned, mesh)
    expect(op.status).toBe('error')
    expect(op.errorMessage).toBe(say(decision.operatorKey, decision.values))
  }, 120_000)

  it('names every route\'s keys, refuses a placement turned about X for a modelled body, and on gives a placement', () => {
    const lines = Object.entries(ROTATED_PART_REFUSAL_KEYS).flatMap(([route, keys]) =>
      [keys.imported, keys.resolved].filter(Boolean).map(key => ({ route, key, line: say(key!, { value1: 'Op', value2: 'Part' }) })))
    expect(lines).toHaveLength(10)
    for (const { line } of lines) expect(line).toMatch(/flat/)
    const model = { ...turned, format: 'model', type: 'model', rotation: { x: 0, y: 0, z: 0 }, modelItemId: 'item',
      modelBody: { ref: { bodyId: 'b', lineageId: 'b', stableIds: [], version: 1 } } } as unknown as ImportedGeometry
    const records = [{ modelItemId: 'item', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 90, z: 0 } }]
    expect(rotatedPartDecision('adaptive-preview', 'Op', model, records, PARITY_POLICY))
      .toEqual({ refused: true, operatorKey: 'index122', values: { value1: 'Op', value2: 'Turned block' } })
    const on = rotatedPartDecision('adaptive-compute', 'Op', turned, [], { ...PARITY_POLICY, rotated_part_placement: true })
    expect(on.refused).toBe(false)
    if (!on.refused && on.placement?.ok) {
      // 90 deg about X stands local +Y up: the part's 50 mm side becomes its height.
      expect(placePoint(on.placement.toWorld, { x: 0, y: 50, z: 0 }).z).toBeCloseTo(50, 9)
    }
    // A spin about Z alone is never refused.
    expect(rotatedPartDecision('parallel-compute', 'Op', { ...turned, rotation: { x: 0, y: 0, z: 90 } }, [], PARITY_POLICY).refused).toBe(false)
  })
})

// ── MD-44 loop typing ──
const square = (id: string, size: number, ccw: boolean, type: WorldLoop['type']): WorldLoop => {
  const pts = [{ x: -size, y: -size }, { x: size, y: -size }, { x: size, y: size }, { x: -size, y: size }]
  return { id, closed: true, type, points: ccw ? pts : [...pts].reverse() }
}

describe('WO-3008 MD-44 loop-typing policy (off = parity)', () => {
  it('a loop set whose winding disagrees with its nesting: off keeps today\'s type, on types by nesting', () => {
    // A mesh projection chains undirected edges, so winding says nothing: outer CW, hole CCW, island CW.
    const raw = [square('outer', 30, false, 'contour'), square('hole', 20, true, 'contour'), square('island', 10, false, 'contour')]
    const winding = raw.map(loop => ({ ...loop, type: windingType(loop.points) }))
    expect(winding.map(loop => loop.type)).toEqual(['hole', 'contour', 'hole'])
    const off = typeLoops(winding, PARITY_POLICY)
    expect(off.map(loop => loop.type)).toEqual(winding.map(loop => loop.type))
    expect(off.map(loop => loop.points)).toEqual(winding.map(loop => loop.points))
    const on = typeLoops(winding, { ...PARITY_POLICY, loop_type_from_nesting: true })
    expect(on.map(loop => loop.type)).toEqual(['contour', 'hole', 'contour'])
    expect(on.map(loop => windingType(loop.points))).toEqual(['contour', 'hole', 'contour'])
    const open: WorldLoop = { id: 'open', closed: false, type: 'open', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }
    expect(typeLoops([open], { ...PARITY_POLICY, loop_type_from_nesting: true })[0].type).toBe('open')
  })

  it('writes the on-state diff list for the card from the fixture and today\'s real projection routes', () => {
    const raw = [square('outer', 30, false, 'contour'), square('hole', 20, true, 'contour'), square('island', 10, false, 'contour')]
    const fixture = loopTypingDiff(raw.map(loop => ({ ...loop, type: windingType(loop.points) })))
    expect(fixture.map(row => row.id)).toEqual(['outer', 'hole', 'island'])
    const routes: Record<string, unknown> = { 'winding-fixture': fixture }
    for (const path of ['examples/04-tool-storage-bar/tool-storage-bar.stl', 'examples/01-fixture-plate/fixture-plate.stl']) {
      const { positions, indices } = readStl(path)
      const projected = projectSTLToLoops(positions, indices, { simplificationTolerance: 0.05, minPerimeter: 1 })
      const loops = projected.loops.map(loop => ({ id: loop.id, closed: loop.closed, type: loop.type as WorldLoop['type'], points: loop.points }))
      const diff = loopTypingDiff(loops)
      // Today's STL projection already types by containment (WO-2935): MD-44 changes no type there.
      expect(diff.filter(row => row.off !== row.on)).toEqual([])
      routes[`stl-projection:${path}`] = { loops: loops.length, typeChanges: 0, reversed: diff.filter(row => row.reversed).map(row => row.id) }
    }
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(`${EVIDENCE}/loop-typing-on-diff.json`, JSON.stringify({ policy: 'loop_type_from_nesting (MD-44), OFF at parity', routes }, null, 2) + '\n')
  })
})
