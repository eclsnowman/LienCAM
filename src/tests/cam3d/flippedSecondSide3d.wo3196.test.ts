// WO-3196: a 3D operation on a flipped second setup machines the underside.
//
// Gap 3D-08 (2026-10-23): on fix_freeform, 3D Finish on Setup 1, then a new
// "Second side of Setup 1, turned about X" with the same 3D Finish gave the
// identical result. Nothing on the 3D route read Setup.flipOf, so the second
// side re-cut the first side's top.
//
// Production path (rule 6): the project is built through store actions, the
// second side through planSecondSideSetup the way the Setup dialog saves it,
// and both operations compute through computeOperationToolpath. Only browser
// transports are replaced (the STEP cache, the tessellator worker, the cam3d
// worker) by the product's own code in-process - the WO-1620 harness.
//
// Measured against geometry, independent of the operation: the part's
// tessellated vertices are turned HERE, in the test (180 degrees about the
// block's X axis through its centre), and the ball cutter is dropped on that
// turned mesh with the kernel's contact math. The second side's cut must ride
// that surface, and must differ from the first side's.
//
// Round 3: scene restore, the viewport and Simulate's deviation target place
// the part with that same turn while the second side is active, and as stored
// for Setup 1.
//
// Round 4: a gizmo drop of the turned part is drawn where it was dropped, on
// auto stock (which re-wraps around the moved part, moving the turn centre
// with it) as on fixed stock; Setup 1 stores the drop as dropped.
//
// Round 5: a drag never invents a rotation. A translation carries the stored
// rotation through unchanged (exact zeros), so parallel, waterline and adaptive
// Generate and their Smart Height previews still admit the part after a drag on
// the turned Setup 2, and Setup 1 still generates after returning to it; a
// rotate composes its un-turned delta onto the stored rotation, snapped.
//
//   npx vitest run src/tests/cam3d/flippedSecondSide3d.wo3196.test.ts

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'

const PART_FILE = 'test_fixtures/brep/fix_freeform.step'
function partBytes(): ArrayBuffer {
  const buf = readFileSync(join(process.cwd(), PART_FILE))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** The STEP display record the deviation target reads (null = none cached). */
const stepDisplay: { mesh: PartMesh | null } = { mesh: null }
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    loadCachedStep: async () => partBytes(),
    loadCachedStepDisplay: async () => stepDisplay.mesh && {
      displayContractVersion: actual.STEP_DISPLAY_CONTRACT_VERSION,
      sourceSha256: await actual.computeStepSha256(partBytes()),
      payload: { mesh: { positions: stepDisplay.mesh.positions, indices: stepDisplay.mesh.indices } },
    } as unknown as Awaited<ReturnType<typeof actual.loadCachedStepDisplay>>,
    cacheStepDisplay: async () => {},
  })
})
// Scene restore re-reads the STEP through the OCCT worker; only that transport
// is replaced, and only while the restore route is under test.
const restoreReadStep = { on: false }
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...actual,
    readStep: (...args: Parameters<typeof actual.readStep>) => restoreReadStep.on
      ? Promise.resolve({ restored: true } as unknown as Awaited<ReturnType<typeof actual.readStep>>)
      : actual.readStep(...args),
    setBrepPayload: (...args: Parameters<typeof actual.setBrepPayload>) => {
      if (!restoreReadStep.on) actual.setBrepPayload(...args)
    },
  })
})
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenario.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))

import * as scenario from '../helpers/heightScenario'
import {
  useCamStore, smartHeightStockBounds, setupPartTurn, setupDisplayPartTurn, activeSetupTurnedPartPlacements,
  storedPoseForActiveSetupDrop,
} from '../../store'
import { restoreGeometryToViewport, retessellateBrepParts, type RestoreViewport } from '../../lib/viewport/restoreScene'
import { loadDeviationTarget } from '../../lib/simulation/deviationTarget'
import { operationStockWorldFrame } from '../../store/operationStockInputs'
import { partWorldTransform, partWorldTransformAsSetupHoldsIt, storedRotationAfterGesture } from '../../store/partTransform'
import { planSecondSideSetup, turnWorldPointForSecondSide, type SecondSideTurn } from '../../lib/cam/flipSetup'
import { poseToMat4 } from '../../lib/workholding/pose'
import { operationRegenerationInputsKey } from '../../lib/cam/generationFingerprint'
import { buildAdaptive3dSmartIntent, buildParallel3dSmartIntent, buildWaterline3dSmartIntent } from '../../lib/cam/smartHeights'
import { deriveOperationHeightDraft } from '../../lib/cam/newOperationHeightDefaults'
import { defaultHeightIntent, operationSafetyHeightIntent, setupDefaultHeightIntent } from '../../lib/cam/heightIntent'
import { defaultHeights, defaultLinking, defaultPasses } from '../../components/modals/newOperationModalDefaults'
import { DEFAULT_PARALLEL3D_PARAMS } from '../../cam3d/integration/parallel3dOperation'
import { DEFAULT_WATERLINE_PARAMS } from '../../cam3d/integration/waterline3dOperation'
import { DEFAULT_ADAPTIVE3D_PARAMS } from '../../cam3d/integration/adaptive3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { AutoStockItem, FixedStockItem, ImportedGeometry, Operation, Setup, Tool, ToolpathMove, Vec3, WCS } from '../../types'

const GEO_ID = 'part-1'
const STOCK_ID = 'stock-1'
const TOOL_ID = 'tool-1'
const BALL = 6
/** The operation's own tolerance (0.05) plus 0.01 for sampling the chord
 *  between its points - the same reading on both sides. */
const TOL = 0.06

const isRapid = (m: ToolpathMove) => m.type === 'rapid'

function finishOn(setup: Setup, opId: string): Operation {
  const setupIntent = setupDefaultHeightIntent(setup)
  const safetyIntent = operationSafetyHeightIntent(setupIntent, new Set())
  const params = { ...DEFAULT_PARALLEL3D_PARAMS, stepover: 2 } as unknown as Record<string, unknown>
  return {
    id: opId, name: '3D Finish', type: 'parallel_3d', enabled: true, status: 'pending', toolId: TOOL_ID,
    passes: { ...defaultPasses }, linking: { ...defaultLinking }, geometrySelections: [GEO_ID],
    heights: {
      ...defaultHeights,
      ...deriveOperationHeightDraft({ operationType: 'parallel_3d', setupIntent, currentParams: params }).heights,
    },
    params,
    smartHeight: {
      kind: 'smart_v2',
      intent: buildParallel3dSmartIntent({ setupId: setup.id, geometryIds: [GEO_ID], safetyIntent }),
    },
  } as unknown as Operation
}

async function compute(setupId: string, opId: string): Promise<Operation> {
  await useCamStore.getState().computeOperationToolpath(setupId, opId)
  return useCamStore.getState().project.setups.find(s => s.id === setupId)!.operations.find(o => o.id === opId)!
}

/** Drop the ball on `mesh` under every cut move, sampled every 0.5 mm.
 *  Returns how far the tip sits above (+) or below (-) the contact, over the part. */
async function deviationFromSurface(mesh: PartMesh, moves: readonly ToolpathMove[]) {
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const kernel = new BvhKernel()
  const meshHandle = kernel.uploadMesh(mesh)
  const cutterHandle = kernel.makeCutter({ kind: 'ball', diameter: BALL })
  const zSeed = mesh.bounds.min[2] - 1e4
  const points: Array<{ x: number; y: number; z: number }> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    // The cut itself: links, ramps and lifts leave the surface by design.
    if (a.role !== 'cut' || b.role !== 'cut' || b.type === 'arc_cw' || b.type === 'arc_ccw') continue
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5))
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  try {
    const xy = new Float64Array(points.length * 2)
    points.forEach((p, i) => { xy[i * 2] = p.x; xy[i * 2 + 1] = p.y })
    const dropped = await kernel.dropPath(meshHandle, cutterHandle, xy, zSeed)
    let maxGouge = 0
    let maxAbove = 0
    let over = 0
    points.forEach((p, i) => {
      if (dropped[i] <= zSeed) return
      over++
      maxGouge = Math.max(maxGouge, dropped[i] - p.z)
      maxAbove = Math.max(maxAbove, p.z - dropped[i])
    })
    return { samples: points.length, over, maxGouge, maxAbove }
  } finally {
    kernel.releaseCutter(cutterHandle)
    kernel.releaseMesh(meshHandle)
  }
}

/** Where a pose puts a local point, through the matrix the viewport and the
 *  deviation target both use. */
function placeLocal(pose: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } },
  p: { x: number; y: number; z: number }) {
  const m = poseToMat4(pose)
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  }
}

function cutExtents(moves: readonly ToolpathMove[]) {
  const cut = moves.filter(m => !isRapid(m))
  const lo = (key: 'x' | 'y' | 'z') => cut.reduce((v, m) => Math.min(v, m[key]), Infinity)
  const hi = (key: 'x' | 'y' | 'z') => cut.reduce((v, m) => Math.max(v, m[key]), -Infinity)
  return { n: moves.length, minX: lo('x'), maxX: hi('x'), minY: lo('y'), maxY: hi('y'), minZ: lo('z'), maxZ: hi('z') }
}

describe('WO-3196: 3D Finish on a second side turned about X machines the underside', () => {
  it('cuts the turned part, not Setup 1\'s top; Setup 1 still cuts its own top', async () => {
    await scenario.prepareInProcessCam3dClient()
    const mesh = await scenario.tessellateSolid({ format: 'step', bytes: partBytes() }, 0.05)
    const [minX, minY, minZ] = mesh.bounds.min
    const [maxX, maxY, maxZ] = mesh.bounds.max

    const store = useCamStore.getState()
    store.newProject()
    if (useCamStore.getState().toolLibrary.some(t => t.id === TOOL_ID)) useCamStore.getState().removeTool(TOOL_ID)
    useCamStore.getState().addTool({
      id: TOOL_ID, name: 'Ball 6', type: 'ball_end_mill', diameter: BALL, fluteLength: 40, shankDiameter: BALL,
      overallLength: 80, numberOfFlutes: 2, material: 'carbide', coating: 'none', toolNumber: 1, notes: '',
      feedsAndSpeeds: { default: { rpm: 12000, feedRate: 1200, plungeRate: 400, depthOfCut: 2, stepover: 2 } },
    } as unknown as Tool)
    // A B-rep keeps its model coordinates; "Drop to floor" seats its lowest point at Z0.
    const partZ = -minZ
    useCamStore.getState().addGeometry({
      id: GEO_ID, name: 'fix_freeform', filename: 'fix_freeform.step', type: 'brep', format: 'step',
      boundingBox: {
        min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
      },
      position: { x: 0, y: 0, z: partZ }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    } as unknown as ImportedGeometry)
    useCamStore.getState().addAutoStock({
      id: STOCK_ID, name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0,
    } as AutoStockItem)
    useCamStore.getState().setStockMembership(GEO_ID, STOCK_ID)
    const block = smartHeightStockBounds(useCamStore.getState().project, STOCK_ID)!
    expect(block).toBeTruthy()

    // Setup 1: the Setup dialog's default - front-left corner of the stock TOP.
    const first = {
      id: 'setup-1', name: 'Setup 1',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54, fixtureOffsetOwner: 'setup',
        origin: { x: block.min.x, y: block.min.y, z: block.max.z },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
        originBinding: { kind: 'stock_corner', stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
      } as unknown as WCS,
      stock: { type: 'rectangular', width: 100, height: 100, depth: 12, offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'aluminum' },
      fixtureStack: [], supportPlane: { mode: 'stock_bottom', offset: 0 },
      defaultHeightIntent: defaultHeightIntent(), operations: [], notes: '',
    } as unknown as Setup
    useCamStore.getState().addSetup(first)

    // Setup 2: "Second side of Setup 1, turned about X", saved the way SetupModal saves it.
    const plan = planSecondSideSetup(useCamStore.getState().project, { parentSetupId: first.id, axis: 'x' })
    if (!plan.ok) throw new Error(plan.message)
    const second = {
      ...first, id: 'setup-2', name: 'Setup 2', operations: [],
      wcs: {
        ...first.wcs, id: 'wcs-2', label: `G${plan.fixtureOffset}`, fixtureOffset: plan.fixtureOffset,
        origin: plan.origin, stockId: plan.stockId,
        cornerRow: plan.cornerRow, cornerCol: plan.cornerCol, cornerFace: plan.cornerFace,
        originBinding: { kind: 'stock_corner', stockId: plan.stockId, cornerRow: plan.cornerRow, cornerCol: plan.cornerCol, cornerFace: plan.cornerFace },
      } as unknown as WCS,
      flipOf: { setupId: first.id, axis: 'x' as const },
    } as Setup
    useCamStore.getState().addSetup(second)

    const setupNow = (id: string) => useCamStore.getState().project.setups.find(s => s.id === id)!
    const project0 = () => useCamStore.getState().project
    useCamStore.getState().addOperation(first.id, finishOn(setupNow(first.id), 'op-1'))
    const one = await compute(first.id, 'op-1')
    useCamStore.getState().addOperation(second.id, finishOn(setupNow(second.id), 'op-2'))
    const two = await compute(second.id, 'op-2')
    expect(one.status, one.errorMessage).toBe('ready')
    expect(two.status, two.errorMessage).toBe('ready')
    const movesOne = one.toolpathMoves ?? []
    const movesTwo = two.toolpathMoves ?? []

    // The part as each setup holds it, in world (machine) coordinates.
    const upright: PartMesh = {
      ...mesh,
      positions: Float32Array.from(mesh.positions, (v, i) => (i % 3 === 2 ? v + partZ : v)),
      bounds: { min: [minX, minY, minZ + partZ], max: [maxX, maxY, maxZ + partZ] },
    }
    const cy = (block.min.y + block.max.y) / 2
    const cz = (block.min.z + block.max.z) / 2
    const turnedPositions = new Float32Array(upright.positions.length)
    for (let i = 0; i < upright.positions.length; i += 3) {
      turnedPositions[i] = upright.positions[i]
      turnedPositions[i + 1] = 2 * cy - upright.positions[i + 1]
      turnedPositions[i + 2] = 2 * cz - upright.positions[i + 2]
    }
    const turned: PartMesh = {
      ...mesh, positions: turnedPositions,
      bounds: {
        min: [minX, 2 * cy - maxY, 2 * cz - (maxZ + partZ)],
        max: [maxX, 2 * cy - minY, 2 * cz - (minZ + partZ)],
      },
    }

    const firstOnUpright = await deviationFromSurface(upright, movesOne)
    const secondOnTurned = await deviationFromSurface(turned, movesTwo)
    const secondOnUpright = await deviationFromSurface(upright, movesTwo)
    const extents = { setup1: cutExtents(movesOne), setup2: cutExtents(movesTwo) }
    console.log('WO-3196', JSON.stringify({ block, extents, firstOnUpright, secondOnTurned, secondOnUpright }))

    // Setup 1 rides its own top (first side unchanged by this order).
    expect(firstOnUpright.over).toBeGreaterThan(100)
    expect(firstOnUpright.maxGouge).toBeLessThan(TOL)
    expect(firstOnUpright.maxAbove).toBeLessThan(TOL)

    // Setup 2 differs from Setup 1 and rides the TURNED part: no cut into it,
    // never lifted off it where the cutter is over it.
    expect(JSON.stringify(extents.setup2)).not.toBe(JSON.stringify(extents.setup1))
    expect(secondOnTurned.over).toBeGreaterThan(100)
    expect(secondOnTurned.maxGouge).toBeLessThan(TOL)
    expect(secondOnTurned.maxAbove).toBeLessThan(TOL)
    // The turned part's top (what was the underside) is the stock top here, 1 mm
    // above the first side's top: Setup 2's highest cut reaches it.
    expect(extents.setup2.maxZ).toBeGreaterThan(maxZ + partZ + 0.5)

    // The part a second side is drawn/compared with is placed by the same turn
    // the toolpath was computed on: its placed vertices span the turned part's
    // box. Setup 1's placement is the stored pose, unchanged.
    const geo = project0().geometry.find(g => g.id === GEO_ID)!
    const placed = (setupId: string) => {
      const turn = setupPartTurn(setupNow(setupId), geo, project0())
      if (turn === 'no-block') throw new Error('no block')
      const pose = partWorldTransformAsSetupHoldsIt(partWorldTransform(geo, project0().stocks ?? []), turn)
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const w = placeLocal(pose, { x: mesh.positions[i], y: mesh.positions[i + 1], z: mesh.positions[i + 2] })
        ;[w.x, w.y, w.z].forEach((v, k) => { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v) })
      }
      return { pose, lo, hi }
    }
    const shownOne = placed(first.id)
    expect(shownOne.pose).toEqual(partWorldTransform(geo, project0().stocks ?? []))
    const shownTwo = placed(second.id)
    for (let k = 0; k < 3; k++) {
      expect(shownTwo.lo[k]).toBeCloseTo(turned.bounds.min[k], 3)
      expect(shownTwo.hi[k]).toBeCloseTo(turned.bounds.max[k], 3)
    }

    // Round 3: every route that draws or compares the part uses that same turn.
    const storedPose = partWorldTransform(geo, project0().stocks ?? [])
    const roundPose = (pose: object) =>
      JSON.parse(JSON.stringify(pose, (_k, v) => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 + 0 : v))
    // Scene restore (reload and B-rep re-tessellation) places the part for the
    // active setup.
    const restoredAt = async (setupId: string, how: 'restore' | 'retessellate') => {
      useCamStore.getState().setActiveSetup(setupId)
      const drawn: Array<{ id: string; position: unknown; rotation: unknown }> = []
      const vp = {
        addBrepModel: (id: string, _payload: unknown, _name: string, position: unknown, rotation: unknown) => {
          drawn.push({ id, position, rotation })
        },
        setSTLVisible: () => {},
      } as unknown as RestoreViewport
      const hooks = { patchGeometry: () => {}, setBrepImportError: (msg: string | null) => { if (msg) throw new Error(msg) } }
      restoreReadStep.on = true
      try {
        if (how === 'restore') await restoreGeometryToViewport(vp, [geo], hooks, project0().stocks ?? [])
        else await retessellateBrepParts(vp, [geo], hooks, project0().stocks ?? [])
      } finally {
        restoreReadStep.on = false
      }
      expect(drawn.map(d => d.id)).toEqual([GEO_ID])
      return roundPose(drawn[0])
    }
    for (const how of ['restore', 'retessellate'] as const) {
      expect(await restoredAt(second.id, how)).toEqual(roundPose({ id: GEO_ID, ...shownTwo.pose }))
      expect(await restoredAt(first.id, how)).toEqual(roundPose({ id: GEO_ID, ...storedPose }))
    }

    const turnTwo = setupDisplayPartTurn(project0(), setupNow(second.id), geo)
    expect(turnTwo).toEqual({ axis: 'x', center: { x: (block.min.x + block.max.x) / 2, y: cy, z: cz } })
    expect(setupDisplayPartTurn(project0(), setupNow(first.id), geo)).toBeNull()

    // Viewport: with Setup 2 active the part is drawn at the turned pose; with
    // Setup 1 active nothing is turned (the part is drawn as stored). A gizmo
    // drop of the turned part stores the pose un-turned.
    useCamStore.getState().setActiveSetup(second.id)
    const drawnTwo = activeSetupTurnedPartPlacements(project0())
    expect(drawnTwo.map(p => p.id)).toEqual([GEO_ID])
    expect(roundPose(drawnTwo[0])).toEqual(roundPose({ id: GEO_ID, ...shownTwo.pose }))
    expect(roundPose(partWorldTransformAsSetupHoldsIt(drawnTwo[0], turnTwo))).toEqual(roundPose(storedPose))
    useCamStore.getState().setActiveSetup(first.id)
    expect(activeSetupTurnedPartPlacements(project0())).toEqual([])

    // Simulate's deviation target (the resolver DeviationPanel passes): Setup 2
    // compares against the TURNED part, Setup 1 against the upright one. The
    // top of each target is read against the test's own meshes.
    const { BufferGeometry, Float32BufferAttribute, DoubleSide, Ray, Vector3 } = await import('three')
    const { MeshBVH } = await import('three-mesh-bvh')
    const topOf = (m: PartMesh) => {
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(Array.from(m.positions), 3))
      g.setIndex(Array.from(m.indices))
      const tree = new MeshBVH(g)
      const ray = new Ray(new Vector3(), new Vector3(0, 0, -1))
      return (x: number, y: number) => {
        ray.origin.set(x, y, m.bounds.max[2] + 1)
        return tree.raycastFirst(ray, DoubleSide)?.point.z ?? null
      }
    }
    stepDisplay.mesh = mesh
    const targetFor = async (setupId: string) => {
      const project = project0()
      const setup = setupNow(setupId)
      return loadDeviationTarget(project, STOCK_ID, operationStockWorldFrame(project.id), new AbortController().signal,
        g => setupDisplayPartTurn(project, setup, g))
    }
    const [targetOne, targetTwo] = [await targetFor(first.id), await targetFor(second.id)]
    stepDisplay.mesh = null
    try {
      const [uprightTop, turnedTop] = [topOf(upright), topOf(turned)]
      let compared = 0
      let maxTwoVsTurned = 0
      let maxOneVsUpright = 0
      let maxTwoVsUpright = 0
      for (let x = minX + 1; x < maxX; x += (maxX - minX) / 23) {
        for (let y = minY + 1; y < maxY; y += (maxY - minY) / 23) {
          const want2 = turnedTop(x, y)
          const want1 = uprightTop(x, y)
          const got2 = targetTwo.topAt(x, y)
          const got1 = targetOne.topAt(x, y)
          if (want2 === null || want1 === null || got2 === null || got1 === null) continue
          compared++
          maxTwoVsTurned = Math.max(maxTwoVsTurned, Math.abs(got2 - want2))
          maxOneVsUpright = Math.max(maxOneVsUpright, Math.abs(got1 - want1))
          maxTwoVsUpright = Math.max(maxTwoVsUpright, Math.abs(got2 - want1))
        }
      }
      console.log('WO-3196 deviation target', JSON.stringify({ compared, maxTwoVsTurned, maxOneVsUpright, maxTwoVsUpright }))
      expect(compared).toBeGreaterThan(100)
      expect(maxOneVsUpright).toBeLessThan(1e-3)
      expect(maxTwoVsTurned).toBeLessThan(1e-3)
      expect(maxTwoVsUpright).toBeGreaterThan(1)
    } finally {
      targetOne.dispose()
      targetTwo.dispose()
    }

    // The turn is an input of the 3D result: a second side that stops being one
    // (its first side removed) reads its 3D result as outdated. A 2D family's
    // claim does not carry it (the shipped tool-storage-bar second side keeps
    // its saved chamfer current).
    const project = useCamStore.getState().project
    const flipped = setupNow(second.id)
    const { flipOf: _turn, ...unturned } = flipped
    const finish = flipped.operations[0]
    expect(operationRegenerationInputsKey(project, flipped, finish))
      .not.toBe(operationRegenerationInputsKey(project, unturned as Setup, finish))
    const chamfer = { ...finish, type: 'chamfer' } as Operation
    expect(operationRegenerationInputsKey(project, flipped, chamfer))
      .toBe(operationRegenerationInputsKey(project, unturned as Setup, chamfer))
  }, 240_000)
})

describe('WO-3196: a second side places the part with the same turn the 3D engine cuts', () => {
  const turns: SecondSideTurn[] = [
    { axis: 'x', center: { x: 3, y: -7, z: 11 } },
    { axis: 'y', center: { x: -4, y: 5, z: 9 } },
  ]
  const poses = [
    { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    { position: { x: 12, y: -3, z: 4 }, rotation: { x: 0, y: 0, z: 30 } },
    { position: { x: -5, y: 8, z: 2 }, rotation: { x: 10, y: 20, z: 30 } },
    { position: { x: 1, y: 2, z: 3 }, rotation: { x: 15, y: 90, z: 0 } },
    { position: { x: 1, y: 2, z: 3 }, rotation: { x: 180, y: 0, z: -45 } },
  ]
  const locals = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 7, z: 0 }, { x: 2, y: -3, z: 5 }]

  it('every local point lands where the turn puts the upright placement', () => {
    for (const turn of turns) for (const pose of poses) {
      const shown = partWorldTransformAsSetupHoldsIt(pose, turn)
      for (const p of locals) {
        const want = turnWorldPointForSecondSide(placeLocal(pose, p), turn)
        const got = placeLocal(shown, p)
        expect(got.x).toBeCloseTo(want.x, 6)
        expect(got.y).toBeCloseTo(want.y, 6)
        expect(got.z).toBeCloseTo(want.z, 6)
      }
    }
  })

  it('a first side keeps its placement', () => {
    for (const pose of poses) expect(partWorldTransformAsSetupHoldsIt(pose, null)).toBe(pose)
  })

  it('round 5: a gesture that did not rotate keeps the stored rotation; a rotate is drawn as dropped', () => {
    for (const turn of turns) for (const pose of poses) {
      const shown = partWorldTransformAsSetupHoldsIt(pose, turn)
      // A drag: the drawn rotation comes back through degrees-radians-degrees.
      const echoed = { x: shown.rotation.x * (1 + 1e-15), y: shown.rotation.y, z: shown.rotation.z }
      expect(storedRotationAfterGesture(pose.rotation, shown.rotation, echoed, turn)).toBe(pose.rotation)
      for (const spin of [{ x: 0, y: 0, z: 25 }, { x: 40, y: -15, z: 5 }]) {
        const after = { x: shown.rotation.x + spin.x, y: shown.rotation.y + spin.y, z: shown.rotation.z + spin.z }
        const stored = storedRotationAfterGesture(pose.rotation, shown.rotation, after, turn)
        const redrawn = partWorldTransformAsSetupHoldsIt({ position: shown.position, rotation: stored }, turn)
        for (const p of locals) {
          const want = placeLocal({ position: shown.position, rotation: after }, p)
          const got = placeLocal({ position: shown.position, rotation: redrawn.rotation }, p)
          expect(got.x).toBeCloseTo(want.x, 6)
          expect(got.y).toBeCloseTo(want.y, 6)
          expect(got.z).toBeCloseTo(want.z, 6)
        }
        for (const v of [stored.x, stored.y, stored.z]) expect(Object.is(v, -0)).toBe(false)
      }
    }
    const drop = { x: 1, y: 2, z: 3 }
    expect(storedRotationAfterGesture({ x: 0, y: 0, z: 0 }, drop, drop, null)).toBe(drop)
  })
})

describe('WO-3196 round 4: a drag on a turned part lands where it is dropped', () => {
  const PART = 'drag-part'
  const BLOCK = 'drag-stock'
  const box = { x: 40, y: 40, z: 24 }

  /** One STEP part at the origin in its stock, Setup 1 and its second side
   *  turned about X, built through the store as the Setup dialog saves them. */
  function build(stock: 'auto' | 'fixed') {
    useCamStore.getState().newProject()
    useCamStore.getState().addGeometry({
      id: PART, name: 'block part', filename: 'block.step', type: 'brep', format: 'step',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { ...box }, size: { ...box },
        center: { x: box.x / 2, y: box.y / 2, z: box.z / 2 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    } as unknown as ImportedGeometry)
    if (stock === 'auto') {
      useCamStore.getState().addAutoStock({
        id: BLOCK, name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0,
      } as AutoStockItem)
    } else {
      useCamStore.getState().addFixedStock({
        id: BLOCK, name: 'Fixed Stock 1', width: 120, height: 120, depth: 64, position: { x: -40, y: -40, z: -20 },
      } as FixedStockItem)
    }
    useCamStore.getState().setStockMembership(PART, BLOCK)
    const block = smartHeightStockBounds(useCamStore.getState().project, BLOCK)!
    expect(block).toBeTruthy()
    const first = {
      id: 'drag-setup-1', name: 'Setup 1',
      wcs: {
        id: 'drag-wcs-1', label: 'G54', fixtureOffset: 54, fixtureOffsetOwner: 'setup',
        origin: { x: block.min.x, y: block.min.y, z: block.max.z },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        stockId: BLOCK, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
        originBinding: { kind: 'stock_corner', stockId: BLOCK, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
      } as unknown as WCS,
      stock: { type: 'rectangular', width: 100, height: 100, depth: 12, offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'aluminum' },
      fixtureStack: [], supportPlane: { mode: 'stock_bottom', offset: 0 },
      defaultHeightIntent: defaultHeightIntent(), operations: [], notes: '',
    } as unknown as Setup
    useCamStore.getState().addSetup(first)
    const plan = planSecondSideSetup(useCamStore.getState().project, { parentSetupId: first.id, axis: 'x' })
    if (!plan.ok) throw new Error(plan.message)
    const second = {
      ...first, id: 'drag-setup-2', name: 'Setup 2',
      wcs: {
        ...first.wcs, id: 'drag-wcs-2', label: `G${plan.fixtureOffset}`, fixtureOffset: plan.fixtureOffset,
        origin: plan.origin, stockId: plan.stockId,
        cornerRow: plan.cornerRow, cornerCol: plan.cornerCol, cornerFace: plan.cornerFace,
        originBinding: { kind: 'stock_corner', stockId: plan.stockId, cornerRow: plan.cornerRow, cornerCol: plan.cornerCol, cornerFace: plan.cornerFace },
      } as unknown as WCS,
      flipOf: { setupId: first.id, axis: 'x' as const },
    } as Setup
    useCamStore.getState().addSetup(second)
    return { first: first.id, second: second.id }
  }

  const project = () => useCamStore.getState().project
  const part = () => project().geometry.find(g => g.id === PART)!
  /** Where the viewport draws the part with the active setup (the effect's input). */
  const shown = () => activeSetupTurnedPartPlacements(project()).find(p => p.id === PART)!
  /** The gizmo's drag-end commit for an imported part (Viewport handlePartTransformChange). */
  const drop = (pose: { position: Vec3; rotation: Vec3 }) => {
    const stored = storedPoseForActiveSetupDrop(project(), part(), pose)
    useCamStore.getState().updateGeometryTransform(PART, stored.position, stored.rotation)
    return stored
  }
  const corners = [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(k => ({ x: i * box.x, y: j * box.y, z: k * box.z }))))
  /** Every corner of the part where `pose` draws it. */
  const drawnCorners = (pose: { position: Vec3; rotation: Vec3 }) => corners.map(c => placeLocal(pose, c))
  const expectSameDrawing = (got: { position: Vec3; rotation: Vec3 }, want: { position: Vec3; rotation: Vec3 }) => {
    const [a, b] = [drawnCorners(got), drawnCorners(want)]
    a.forEach((p, i) => {
      expect(p.x).toBeCloseTo(b[i].x, 6)
      expect(p.y).toBeCloseTo(b[i].y, 6)
      expect(p.z).toBeCloseTo(b[i].z, 6)
    })
  }

  for (const stock of ['auto', 'fixed'] as const) {
    it(`${stock} stock: a +10 mm drag on X, Y or Z moves the drawn turned part +10 mm on that axis`, () => {
      const results: Record<string, unknown> = {}
      for (const axis of ['x', 'y', 'z'] as const) {
        const { second } = build(stock)
        useCamStore.getState().setActiveSetup(second)
        const before = shown()
        expect(before).toBeTruthy()
        const want = { position: { ...before.position, [axis]: before.position[axis] + 10 }, rotation: { ...before.rotation } }
        const stored = drop(want)
        const after = shown()
        results[axis] = { before: before.position, want: want.position, stored: stored.position, after: after.position }
        expect(after.position.x).toBeCloseTo(want.position.x, 6)
        expect(after.position.y).toBeCloseTo(want.position.y, 6)
        expect(after.position.z).toBeCloseTo(want.position.z, 6)
        expectSameDrawing(after, want)
      }
      console.log(`WO-3196 drag ${stock}`, JSON.stringify(results))
    })
  }

  it('auto stock: a gizmo rotate of the turned part is drawn as dropped', () => {
    const { second } = build('auto')
    useCamStore.getState().setActiveSetup(second)
    const before = shown()
    const want = { position: { ...before.position }, rotation: { ...before.rotation, z: before.rotation.z + 30 } }
    drop(want)
    const after = shown()
    console.log('WO-3196 rotate auto', JSON.stringify({ before, want, after }))
    expectSameDrawing(after, want)
  })

  it('Setup 1: a drag stores the drop exactly as dropped, as before this order', () => {
    for (const stock of ['auto', 'fixed'] as const) {
      const { first } = build(stock)
      useCamStore.getState().setActiveSetup(first)
      expect(activeSetupTurnedPartPlacements(project())).toEqual([])
      const base = partWorldTransform(part(), project().stocks ?? [])
      const want = { position: { ...base.position, y: base.position.y + 10 }, rotation: { x: 0, y: 0, z: 15 } }
      expect(storedPoseForActiveSetupDrop(project(), part(), want)).toBe(want)
      drop(want)
      expect(partWorldTransform(part(), project().stocks ?? [])).toEqual(want)
    }
  })

  // Round 5: a translation is not a rotation. The stored rotation comes through
  // a translation-only drag byte-for-byte - exact zeros, never -0 or 7e-15 -
  // because every 3D route admits a part only with rotation X and Y exactly 0.
  for (const stock of ['auto', 'fixed'] as const) {
    it(`round 5, ${stock} stock: a translation-only drag on X, Y or Z stores rotation exactly (0, 0, 0)`, () => {
      for (const axis of ['x', 'y', 'z'] as const) {
        const { second } = build(stock)
        useCamStore.getState().setActiveSetup(second)
        const before = shown()
        drop({ position: { ...before.position, [axis]: before.position[axis] + 10 }, rotation: { ...before.rotation } })
        const r = part().rotation
        // toBe is Object.is: -0 and 7e-15 both fail.
        expect([axis, r.x, r.y, r.z]).toEqual([axis, 0, 0, 0])
        expect(r.x).toBe(0)
        expect(r.y).toBe(0)
        expect(r.z).toBe(0)
      }
    })
  }

  it('round 5: a gizmo rotate composes its un-turned delta onto the stored rotation, snapped', () => {
    const { second } = build('auto')
    useCamStore.getState().setActiveSetup(second)
    for (const [dz, want] of [[30, 30], [-90, -60]] as const) {
      const before = shown()
      drop({ position: { ...before.position }, rotation: { ...before.rotation, z: before.rotation.z + dz } })
      // The drop's Euler Z spins the drawn part about its own Z: drawn
      // Rx(180)Rz(s + dz) un-turns to Rz(s + dz) - the stored spin moves by dz.
      const r = part().rotation
      expect(r.x).toBe(0)
      expect(r.y).toBe(0)
      expect(r.z).toBe(want)
    }
    // A gesture that tilts the part keeps its tilt (only noise is snapped).
    const before = shown()
    drop({ position: { ...before.position }, rotation: { ...before.rotation, y: before.rotation.y + 90 } })
    const r = part().rotation
    expect(Math.abs(r.x) + Math.abs(r.y)).toBeGreaterThan(1)
    for (const v of [r.x, r.y, r.z]) expect(Math.round(v * 1e9) / 1e9).toBe(v)
  })
})

describe('WO-3196 round 5: 3D Generate after a drag on the turned part', () => {
  const FLAT_ID = 'tool-flat'

  function opOn(setup: Setup, opId: string, kind: 'parallel_3d' | 'waterline_3d' | 'adaptive_3d'): Operation {
    const setupIntent = setupDefaultHeightIntent(setup)
    const safetyIntent = operationSafetyHeightIntent(setupIntent, new Set())
    const defaults = kind === 'parallel_3d' ? DEFAULT_PARALLEL3D_PARAMS
      : kind === 'waterline_3d' ? DEFAULT_WATERLINE_PARAMS : DEFAULT_ADAPTIVE3D_PARAMS
    // Adaptive as the kernel parity harness runs it (linkingParity.wo3026): cleared to the stock boundary.
    const params = {
      ...defaults, ...(kind === 'adaptive_3d' ? { useStockBoundary: true, axialStockToLeave: 0.5 } : { stepover: 2 }),
    } as unknown as Record<string, unknown>
    const input = { setupId: setup.id, geometryIds: [GEO_ID], safetyIntent, finishDepthMm: params.finishDepth as number | undefined }
    return {
      id: opId, name: kind, type: kind, enabled: true, status: 'pending',
      toolId: kind === 'adaptive_3d' ? FLAT_ID : TOOL_ID,
      passes: { ...defaultPasses }, linking: { ...defaultLinking }, geometrySelections: [GEO_ID],
      heights: {
        ...defaultHeights,
        ...deriveOperationHeightDraft({ operationType: kind, setupIntent, currentParams: params }).heights,
      },
      params,
      smartHeight: {
        kind: 'smart_v2',
        intent: kind === 'parallel_3d' ? buildParallel3dSmartIntent(input)
          : kind === 'waterline_3d' ? buildWaterline3dSmartIntent(input)
          : buildAdaptive3dSmartIntent({ ...input, mode: 'initial_stock' }),
      },
    } as unknown as Operation
  }

  it('Setup 2 drag +10 mm Y: parallel, waterline and adaptive still generate, shifted by the drag; so does Setup 1', async () => {
    // Waterline's opencamlib build loads only under a window (as in
    // heightScenario.installRealToolpathWorker); this file's other tests run without one.
    const g = globalThis as { window?: unknown }
    const createdWindow = g.window === undefined
    if (createdWindow) g.window = {}
    try {
      await generateAfterDrag()
    } finally {
      if (createdWindow) delete g.window
    }
  }, 240_000)

  async function generateAfterDrag() {
    await scenario.prepareInProcessCam3dClient()
    const mesh = await scenario.tessellateSolid({ format: 'step', bytes: partBytes() }, 0.05)
    const [minX, minY, minZ] = mesh.bounds.min
    const [maxX, maxY, maxZ] = mesh.bounds.max
    useCamStore.getState().newProject()
    for (const tool of [
      { id: TOOL_ID, name: 'Ball 6', type: 'ball_end_mill', toolNumber: 1 },
      { id: FLAT_ID, name: 'Flat 2', type: 'flat_end_mill', toolNumber: 2 },
    ]) {
      if (useCamStore.getState().toolLibrary.some(t => t.id === tool.id)) useCamStore.getState().removeTool(tool.id)
      const diameter = tool.id === FLAT_ID ? 2 : BALL
      useCamStore.getState().addTool({
        ...tool, diameter, fluteLength: 40, shankDiameter: diameter,
        overallLength: 80, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
        feedsAndSpeeds: { default: { rpm: 12000, feedRate: 1200, plungeRate: 400, depthOfCut: 2, stepover: 2 } },
      } as unknown as Tool)
    }
    useCamStore.getState().addGeometry({
      id: GEO_ID, name: 'fix_freeform', filename: 'fix_freeform.step', type: 'brep', format: 'step',
      boundingBox: {
        min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
      },
      position: { x: 0, y: 0, z: -minZ }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    } as unknown as ImportedGeometry)
    useCamStore.getState().addAutoStock({
      id: STOCK_ID, name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0,
    } as AutoStockItem)
    useCamStore.getState().setStockMembership(GEO_ID, STOCK_ID)
    const block = smartHeightStockBounds(useCamStore.getState().project, STOCK_ID)!
    const first = {
      id: 'setup-1', name: 'Setup 1',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54, fixtureOffsetOwner: 'setup',
        origin: { x: block.min.x, y: block.min.y, z: block.max.z },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
        originBinding: { kind: 'stock_corner', stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
      } as unknown as WCS,
      stock: { type: 'rectangular', width: 100, height: 100, depth: 12, offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'aluminum' },
      fixtureStack: [], supportPlane: { mode: 'stock_bottom', offset: 0 },
      defaultHeightIntent: defaultHeightIntent(), operations: [], notes: '',
    } as unknown as Setup
    useCamStore.getState().addSetup(first)
    const plan = planSecondSideSetup(useCamStore.getState().project, { parentSetupId: first.id, axis: 'x' })
    if (!plan.ok) throw new Error(plan.message)
    useCamStore.getState().addSetup({
      ...first, id: 'setup-2', name: 'Setup 2', operations: [],
      wcs: {
        ...first.wcs, id: 'wcs-2', label: `G${plan.fixtureOffset}`, fixtureOffset: plan.fixtureOffset,
        origin: plan.origin, stockId: plan.stockId,
        cornerRow: plan.cornerRow, cornerCol: plan.cornerCol, cornerFace: plan.cornerFace,
        originBinding: { kind: 'stock_corner', stockId: plan.stockId, cornerRow: plan.cornerRow, cornerCol: plan.cornerCol, cornerFace: plan.cornerFace },
      } as unknown as WCS,
      flipOf: { setupId: first.id, axis: 'x' as const },
    } as Setup)
    const setupNow = (id: string) => useCamStore.getState().project.setups.find(s => s.id === id)!
    const kinds = ['parallel_3d', 'waterline_3d', 'adaptive_3d'] as const
    useCamStore.getState().addOperation('setup-1', opOn(setupNow('setup-1'), 'op-1', 'parallel_3d'))
    for (const kind of kinds) useCamStore.getState().addOperation('setup-2', opOn(setupNow('setup-2'), `op-2-${kind}`, kind))
    const runAll = async () => {
      const out: Record<string, ToolpathMove[]> = {}
      for (const [setupId, opId] of [['setup-1', 'op-1'], ...kinds.map(k => ['setup-2', `op-2-${k}`])]) {
        const op = await compute(setupId, opId)
        expect([opId, op.status, op.errorMessage]).toEqual([opId, 'ready', undefined])
        out[opId] = op.toolpathMoves ?? []
      }
      // Smart Height previews admit the part the same way Generate does.
      for (const kind of kinds) {
        const op = setupNow('setup-2').operations.find(o => o.id === `op-2-${kind}`)!
        const preview = kind === 'parallel_3d' ? useCamStore.getState().previewParallel3dSmartHeights
          : kind === 'waterline_3d' ? useCamStore.getState().previewWaterline3dSmartHeights
          : useCamStore.getState().previewAdaptive3dSmartHeights
        await expect(preview('setup-2', op)).resolves.toBeTruthy()
      }
      return out
    }
    const before = await runAll()

    // The gizmo's drop on the turned part: +10 mm in drawn Y, rotation as drawn.
    useCamStore.getState().setActiveSetup('setup-2')
    const drawn = activeSetupTurnedPartPlacements(useCamStore.getState().project).find(p => p.id === GEO_ID)!
    const geo = () => useCamStore.getState().project.geometry.find(g => g.id === GEO_ID)!
    const stored = storedPoseForActiveSetupDrop(useCamStore.getState().project, geo(),
      { position: { ...drawn.position, y: drawn.position.y + 10 }, rotation: { ...drawn.rotation } })
    useCamStore.getState().updateGeometryTransform(GEO_ID, stored.position, stored.rotation)
    // Auto stock re-wraps the moved part: stored and drawn both move +10 Y.
    expect(geo().position.y).toBeCloseTo(10, 9)

    const after = await runAll()
    const shifts: Record<string, unknown> = {}
    for (const opId of Object.keys(before)) {
      const [a, b] = [before[opId], after[opId]]
      shifts[opId] = { before: a.length, after: b.length }
      expect([opId, b.length]).toEqual([opId, a.length])
      let worst = 0
      a.forEach((m, i) => {
        worst = Math.max(worst, Math.abs(b[i].x - m.x), Math.abs(b[i].y - (m.y + 10)), Math.abs(b[i].z - m.z))
      })
      expect([opId, worst < 1e-6]).toEqual([opId, true])
    }
    console.log('WO-3196 round 5 generate after drag', JSON.stringify(shifts))
  }
})
