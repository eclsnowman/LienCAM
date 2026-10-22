// WO-2835 fix round 4: measure proof coverage without inventing missing geometry.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { typedMock } from '../support/typedMock'
import { controllerSettingNumber, type ToolpathMove, type Tool } from '../../types'

import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'

// In-memory binary caches so a File Open keeps every embedded STL/STEP byte.
const stlBytes = new Map<string, ArrayBuffer>()
const stepBytes = new Map<string, ArrayBuffer>()
const stepDisplay = new Map<string, CachedStepDisplay>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytes.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytes.delete(id) }),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepBytes.set(id, buffer) }),
    loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
    removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
    cacheStepDisplay: vi.fn(async (
      id: string,
      payload: BrepModelPayload,
      sourceSha256: string,
      tessellation: StepDisplayTessellation | null,
    ) => {
      stepDisplay.set(id, {
        displayContractVersion: 1, sourceSha256, tessellation, payload, byteLength: 0, updatedAt: 0,
      })
    }),
    loadCachedStepDisplay: vi.fn(async (id: string) => stepDisplay.get(id) ?? null),
    removeCachedStepDisplay: vi.fn(async (id: string) => { stepDisplay.delete(id) }),
  })
})

// 3D families: the real BvhKernel + cam3d dispatcher in-process (no Worker here).
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const { Cam3dClient } = await import('../../cam3d/worker/client')
  const { Cam3dDispatcher } = await import('../../cam3d/worker/dispatcher')
  let client: InstanceType<typeof Cam3dClient> | null = null
  const make = () => {
    const kernel = new BvhKernel()
    const fakeWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as never) },
      terminate(): void {},
    }
    const dispatcher = new Cam3dDispatcher(kernel, (message: unknown) => {
      fakeWorker.onmessage?.({ data: message } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker as never)
  }
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    getCam3dClient: () => (client ??= make()),
    disposeCam3dClient: () => { client = null },
  })
})

// STEP parts tessellate through the in-process OCCT core instead of the browser model worker.
vi.mock('../../cam3d/input/stepTessellatorWorker', async () => {
  const { readFileSync } = await import('node:fs')
  const nodePath = await import('node:path')
  const { loadOcctModel } = await import('../../lib/cam/geometry/occt/model/loader')
  const { makeOcctCoreTessellator } = await import('../../cam3d/input/occtCoreTessellator')
  const wasmPath = nodePath.resolve(__dirname, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')
  let tessellator: import('../../cam3d/input/types').StepTessellator | null = null
  const workerStepTessellator: import('../../cam3d/input/types').StepTessellator = async (bytes, params) => {
    tessellator ??= makeOcctCoreTessellator(await loadOcctModel({ wasmBinary: readFileSync(wasmPath) }))
    return tessellator(bytes, params)
  }
  return typedMock<typeof import('../../cam3d/input/stepTessellatorWorker')>({ workerStepTessellator })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

const hopControl = vi.hoisted(() => ({ off: false, inputs: [] as unknown[] }))
vi.mock('../../cam3d/integration/airFeedOverRemovedStock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/airFeedOverRemovedStock')>()
  return typedMock<typeof import('../../cam3d/integration/airFeedOverRemovedStock')>({ ...actual, rapidAirFeedsOverRemovedStock: (input: Parameters<typeof actual.rapidAirFeedsOverRemovedStock>[0]) => {
    const result = actual.rapidAirFeedsOverRemovedStock(hopControl.off ? { ...input, floorHopMm: 0 } : input)
    hopControl.inputs.push({ ...input, remaining: { ...input.remaining, topZ: Array.from(input.remaining.topZ) },
      control: hopControl.off, result })
    return result
  } })
})

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')

// The worker runs in-process: the store posts to a Worker shim that hands the
// request straight to toolpathWorker's onmessage, exactly as the browser would.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
/** The setup whose proven stock the viewport reports (the store asks with no id). */
let viewportSetup = 0
if (g.window === undefined) g.window = {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups[viewportSetup]
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(setup, project)!)
  },
}
g.self = { postMessage: (m: unknown) => { activeShim?.onmessage?.({ data: m }) }, onmessage: null }
await import('../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) { activeShim = this; void workerSelf.onmessage?.({ data }) }
  terminate() { activeShim = null }
}

await ensureClipperReady()


import { checkHolderAndShankClearance } from '../../lib/cam/holderClearance'
import { ZDexelField, maxTraverseIntrusion, removeSweep, type LinearMove } from '../../cam3d/stock'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import type { StockState } from '../../lib/cam/stockState'
import { resolveWorkholdingPlacements } from '../../lib/workholding/resolveWorkholding'
import { estimateRuntimeMsOrError } from '../../lib/cam/runtime'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { machineCutTimeMotion } from '../../lib/simulation/machineCutTimeMotion'
import { validatePersistedSmartHeightState } from '../../lib/cam/smartHeights/authority'

// This is a diagnostic of the represented stock, not a full continuous-solid
// certificate. In particular, never turn missing holder geometry into a PASS.
const reports: Record<string, unknown>[] = []
interface CapturedStream {
  operation: string; control: boolean; bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  origin: unknown; tool: Tool; moves: ToolpathMove[]
}
const streams: CapturedStream[] = []
const finishCallers: Record<string, unknown>[] = []
const evidencePrefix = process.env.WO2835_EVIDENCE_PREFIX ?? 'round5'
const witnessTargets: Record<string, number[]> = { 'Adaptive Clearing 1': [43467, 44351], '3D Finish 3': [11, 12] }
const definition = JSON.parse(readFileSync('docs/machine/profiles/LienCNCV2.definition.json', 'utf8')).definition
const number = (key: string) => controllerSettingNumber(definition.settings, 'uccnc', `Generalsettings.${key}`)!
const cornerMm = number('Cornerserror')
const linearMm = number('Linearerror')
const stopDeg = number('Stopatangle')
// The sample GRBL job has no definition. 0.1 mm is an explicitly conservative
// desk-analysis band, not an imported or measured machine fact.
const undefinedDefinitionBandMm = 0.1

function segment(a: ToolpathMove, b: ToolpathMove): LinearMove {
  return { x0: a.x, y0: a.y, z0: a.z, x1: b.x, y1: b.y, z1: b.z }
}
function cutterFor(tool: Tool): { kind: 'flat' | 'ball'; diameter: number } {
  return { kind: tool.type === 'ball_end_mill' ? 'ball' : 'flat', diameter: tool.diameter }
}
function gap(field: ZDexelField, a: ToolpathMove, b: ToolpathMove, tool: Tool): number | null {
  let min = Infinity
  // Each small segment is tested as a swept cutter at its LOWEST Z, not just
  // poses. This encloses every straight line within the represented field.
  const n = Math.max(1, Math.ceil(Math.abs(b.z - a.z) / 0.01))
  let from = a
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const to = { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
    min = Math.min(min, -maxTraverseIntrusion(field, segment(from, to), cutterFor(tool)).intrusionMm)
    from = to
  }
  return Number.isFinite(min) ? min : null // null means no represented material under the footprint
}
function directionAngle(a: ToolpathMove, b: ToolpathMove, c: ToolpathMove): number | null {
  const u = [b.x - a.x, b.y - a.y, b.z - a.z]
  const v = [c.x - b.x, c.y - b.y, c.z - b.z]
  const lengths = Math.hypot(...u) * Math.hypot(...v)
  return lengths > 1e-12 ? Math.acos(Math.max(-1, Math.min(1, u.reduce((s, x, i) => s + x * v[i], 0) / lengths))) * 180 / Math.PI : null
}

async function inspectSetup(index: number, lastName: string, control = false): Promise<void> {
  hopControl.off = control
  const file = JSON.parse(readFileSync('Example Projects/Full Suite.camproject', 'utf8'))
  if (control) for (const setup of (file.project ?? file).setups) for (const op of setup.operations) {
    op.linking = { ...op.linking, floorHopMm: 0 }
  }
  await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
  viewportSetup = index
  const setup = useCamStore.getState().project.setups[index]
  for (const op of setup.operations) {
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    if (op.name === lastName) break
  }
  const project = useCamStore.getState().project
  const done = project.setups[index]
  const box = smartHeightStockBounds(project, setupProvenStockId(done, project)!)!
  const workholding = resolveWorkholdingPlacements(project, done.id, { includeAvailability: true })
  expect(workholding.placements).toEqual([])
  expect(workholding.omissions ?? []).toEqual([])
  const originZ = done.wcs.origin.z
  const bounds = { minX: box.min.x, minY: box.min.y, minZ: box.min.z - originZ,
    maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z - originZ }
  const field = ZDexelField.fromBox(bounds, 0.1, 4_000_000)
  const state: StockState = { schemaVersion: 1, representation: 'z-dexel', bounds,
    requestedResolutionMm: 0.1, resolutionMm: field.cell, warnings: field.warnings,
    nx: field.nx, ny: field.ny, bottomZ: bounds.minZ, topZ: field.top }
  for (const op of done.operations) {
    expect(op.errorMessage ?? '', op.name).toBe('')
    const tool = project.toolLibrary.find(t => t.id === op.toolId)!
    const holder = project.holders?.find(h => h.id === tool.holderId)
    const original = (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - originZ }))
    expect(original.length, op.name).toBeGreaterThan(0)
    streams.push({ operation: op.name, control, bounds, origin: done.wcs.origin, tool, moves: original })
    if (control) { if (op.name === lastName) break; else continue }
    const history: { from: ToolpathMove; to: ToolpathMove; moveIndex: number }[] = []
    const origins: number[] = []
    const moves = sampleArcMovesForLinearConsumers(original, {}, origins)
    const links: Record<string, unknown>[] = []
    let noncuttingCollisions = 0
    let rapidSegments = 0
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      const cutting = b.type !== 'rapid' && isStockCuttingRole(effectiveMoveRole(b))
      if (cutting) {
        removeSweep(field, segment(a, b), cutterFor(tool))
        history.push({ from: a, to: b, moveIndex: origins[i] })
      }
      if (b.type !== 'rapid') continue
      rapidSegments++
      // Whole shank and every holder segment actually defined by the job,
      // against exactly the current field; future cuts have not been replayed.
      const assembly = checkHolderAndShankClearance({ stock: state, moves: [a, b], tool, holder })
      noncuttingCollisions += assembly.collisions.length
      const lowerBoundCutterGapMm = gap(field, a, b, tool)
      const witness = maxTraverseIntrusion(field, segment(a, b), cutterFor(tool))
      const prior = (witnessTargets[op.name] ?? []).includes(origins[i]) ? history.filter(h => {
        const dx = h.to.x - h.from.x, dy = h.to.y - h.from.y
        const d2 = dx * dx + dy * dy
        const t = d2 ? Math.max(0, Math.min(1, ((witness.x - h.from.x) * dx + (witness.y - h.from.y) * dy) / d2)) : 0
        return Math.hypot(witness.x - h.from.x - t * dx, witness.y - h.from.y - t * dy) <= tool.diameter / 2 + 0.1
      }) : undefined
      const next = moves[i + 1]
      const angle = next ? directionAngle(a, b, next) : null
      const exactStop = angle !== null && angle > stopDeg
      const band = undefinedDefinitionBandMm // One fallback model; no assumed exact-stop exemption.
      links.push({ moveIndex: origins[i], from: a, to: b, lowerBoundCutterGapMm,
        witness, priorSweepsAtWitness: prior, shankStatus: assembly.shankStatus, holderStatus: assembly.holderStatus,
        collisions: assembly.collisions, nextRole: next?.role ?? null,
        junction: { angleDeg: angle, exactStop, cornerBandMm: band,
          // Bounds for a tolerance tube, not a simulated/controller-readback path.
          lowestAllowedTipZ: Math.min(a.z, b.z) - band,
          jobUndefinedDefinitionBandMm: undefinedDefinitionBandMm,
          roundedStockClearanceCertified: false },
        fedHandover: next && next.type !== 'rapid' ? { minGapMm: gap(field, b, b, tool), role: next.role } : null })
    }
    reports.push({ operation: op.name, setup: done.name, moveCount: original.length,
      tool, holder: holder ?? null, declaredHolderCount: project.holders?.length ?? 0,
      machineDefinitionPresent: Boolean(project.machine.controllerDefinition),
      declaredWorkholding: workholding,
      stockResolutionMm: field.cell, rapidSegments, noncuttingCollisions, links,
      fullAssemblyAndRoundedPathCertified: false,
      gaps: ['The job defines no holder profile; unknown geometry cannot be swept.',
        'Stock replay stores column centres, not conservative whole-cell solids.',
        'A tolerance tube lower bound alone does not certify the rounded XY corridor or fed handover.'] })
    if (op.name === lastName) break
  }
}

beforeAll(async () => {
  await inspectSetup(0, 'Pocket 2')
  await inspectSetup(3, '3D Finish 3')
  await inspectSetup(0, 'Pocket 2', true)
  await inspectSetup(3, '3D Finish 3', true)
  hopControl.off = false
}, 1_200_000)

afterAll(() => {
  if (process.env.WO2835_CAPTURE_CLEARANCE === '1') {
    const file = JSON.parse(readFileSync('Example Projects/Full Suite.camproject', 'utf8'))
    const project = file.project ?? file
    const old = JSON.parse(gunzipSync(readFileSync('src/tests/evidence/WO-2835/round8-old-streams.json.gz')).toString())
    const time = (stream: CapturedStream) => {
      const op = project.setups.flatMap((s: { operations: { name: string; feedrateOverride?: object }[] }) => s.operations)
        .find((o: { name: string }) => o.name === stream.operation)
      const rates = resolveFeedrates(stream.tool, op.feedrateOverride, project.machine.rapidRate)
      return estimateRuntimeMsOrError(stream.moves, project.machine.rapidRate,
        rates.fastTraverseRate ?? project.machine.rapidRate, rates.finishRate ?? project.machine.rapidRate,
        machineCutTimeMotion(project.machine))
    }
    writeFileSync(`src/tests/evidence/WO-2835/${evidencePrefix}-time-comparison.json`, JSON.stringify({
      oldSource: old.source, newSource: process.env.WO2835_SOURCE, method: 'production runtime estimator; original project machine/feed settings; estimates, no board run',
      rows: streams.map(s => {
        const before = old.streams.find((v: CapturedStream) => v.operation === s.operation && v.control === s.control)
        return { operation: s.operation, hopOff: s.control, oldMoves: before.moves.length, newMoves: s.moves.length,
          exactStreamEqual: JSON.stringify(before.moves) === JSON.stringify(s.moves), oldTime: time(before), newTime: time(s) }
      }),
    }, null, 2) + '\n')
  }
  if (process.env.WO2835_CAPTURE_CLEARANCE === '1') writeFileSync(
    `src/tests/evidence/WO-2835/${evidencePrefix}-callers.json.gz`, gzipSync(JSON.stringify({
      source: process.env.WO2835_SOURCE, finishCallers })))
  if (process.env.WO2835_CAPTURE_CLEARANCE === '1') writeFileSync(
    `src/tests/evidence/WO-2835/${evidencePrefix}-seam-inputs.json.gz`, gzipSync(JSON.stringify(hopControl.inputs)))
  if (process.env.WO2835_CAPTURE_CLEARANCE === '1') writeFileSync(
    `src/tests/evidence/WO-2835/${evidencePrefix}-streams.json.gz`, gzipSync(JSON.stringify({ source: process.env.WO2835_SOURCE, streams })))
  console.info('WO-2835 clearance coverage:', reports.map(r => ({ operation: r.operation, rapidSegments: r.rapidSegments, noncuttingCollisions: r.noncuttingCollisions, proofComplete: false })))
  // Evidence is opt-in; ordinary focused runs never dirty the checkout.
  if (process.env.WO2835_CAPTURE_CLEARANCE === '1') writeFileSync(
    `src/tests/evidence/WO-2835/${evidencePrefix}-diagnostic.json`,
    JSON.stringify({ source: process.env.WO2835_SOURCE, method: 'production computeOperationToolpath; sequential stock replay',
      controllerDefinition: 'docs/machine/profiles/LienCNCV2.definition.json',
      controller: { cornerMm, linearMm, stopDeg }, physicalBoardReadbackPerformed: false,
      proofComplete: false, reports }, null, 2) + '\n')
})

describe('WO-2835 production-entry assembly clearance diagnostic', () => {
  for (const name of ['Adaptive Clearing 1', 'Pocket 2', '3D Rough 1', '3D Finish 3']) {
    it(`${name}: sweeps the defined shank against current stock and records every rapid junction`, () => {
      const report = reports.find(r => r.operation === name)!
      expect(report).toBeDefined()
      expect(report.rapidSegments).toBeGreaterThan(0)
      expect(report.noncuttingCollisions).toBe(0)
      // Truthful scope: an undefined holder and centre-sampled stock are NOT
      // evidence of a fully clear assembly/controller-rounded route.
      expect(report.declaredHolderCount).toBe(0)
    })
  }
})

// Astra's requested continuous witness check. This fixture emits only straight
// segments. At a fixed XY, solve the exact interval during which the flat
// cutter covers it, then take the lowest tip on that interval. No grid,
// sampled removal, lowest-Z whole-segment shortcut or cutting-role assumption.
function flatPointSweepZ(a: ToolpathMove, b: ToolpathMove, x: number, y: number, radius: number): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
  const qx = x - a.x, qy = y - a.y
  let lo = 0, hi = 1
  if (l2 > 1e-24) {
    const middle = (qx * dx + qy * dy) / l2
    const perpendicular2 = Math.max(0, qx * qx + qy * qy - middle * middle * l2)
    if (perpendicular2 > radius * radius) return Infinity
    const half = Math.sqrt(Math.max(0, (radius * radius - perpendicular2) / l2))
    lo = Math.max(0, middle - half)
    hi = Math.min(1, middle + half)
    if (hi < lo) return Infinity
  } else if (qx * qx + qy * qy > radius * radius) return Infinity
  return a.z + (b.z - a.z) * (b.z >= a.z ? lo : hi)
}

describe('WO-2835 continuous stock witnesses (no represented-stock approximation)', () => {
  for (const point of [
    { x: -17.762806311746857, y: 31.060000000000002 },
    { x: 27.637193688253134, y: -20.04 },
  ]) {
    it(`Adaptive Clearing 1: no rapid first cuts standing stock at (${point.x}, ${point.y})`, () => {
      const stream = streams.find(s => s.operation === 'Adaptive Clearing 1' && !s.control)!
      expect(stream.tool.type).toBe('flat_end_mill')
      expect(stream.moves.every(m => m.type === 'feed' || m.type === 'rapid')).toBe(true)
      expect(point.x).toBeGreaterThan(stream.bounds.minX)
      expect(point.x).toBeLessThan(stream.bounds.maxX)
      expect(point.y).toBeGreaterThan(stream.bounds.minY)
      expect(point.y).toBeLessThan(stream.bounds.maxY)
      let top = stream.bounds.maxZ
      const contacts: { moveIndex: number; previousTop: number; sweptTipZ: number }[] = []
      for (let i = 1; i < stream.moves.length; i++) {
        const move = stream.moves[i]
        const z = flatPointSweepZ(stream.moves[i - 1], move, point.x, point.y, stream.tool.diameter / 2)
        if (move.type === 'rapid' && z < top - 1e-8 && top > stream.bounds.minZ) {
          contacts.push({ moveIndex: i, previousTop: top, sweptTipZ: z })
        }
        // Even a prior unsafe rapid physically removes this column. Never use
        // stock roles to pretend it remained intact for a later counterexample.
        top = Math.max(stream.bounds.minZ, Math.min(top, z))
      }
      expect(contacts, 'Rapid cuts standing stock before the next fed engagement').toEqual([])
    })
  }
})

// Round 8: continuous cutter surface at a fixed witness XY. Unlike the grid
// diagnostic, all prior physical sweeps participate, including earlier G0s.
// Flat arcs solve angular coverage exactly; ball sweeps minimize the analytic
// lower sphere envelope on the clipped line interval (no ball arcs here).
function physicalSurfaceZ(a: ToolpathMove, b: ToolpathMove, x: number, y: number, tool: Tool): number {
  const r = tool.diameter / 2, dz = b.z - a.z
  const ball = tool.type === 'ball_end_mill'
  if (b.type === 'arc_cw' || b.type === 'arc_ccw') {
    expect(ball, 'Add an exact ball-arc oracle if this fixture gains one').toBe(false)
    const cx = b.cx!, cy = b.cy!, ar = Math.hypot(a.x - cx, a.y - cy)
    expect(Math.abs(ar - Math.hypot(b.x - cx, b.y - cy))).toBeLessThan(1e-6)
    const d = Math.hypot(x - cx, y - cy)
    if (d < 1e-15) return ar <= r ? Math.min(a.z, b.z) : Infinity
    const c = (d * d + ar * ar - r * r) / (2 * d * ar)
    if (c > 1) return Infinity
    if (c <= -1) return Math.min(a.z, b.z)
    const sign = b.type === 'arc_ccw' ? 1 : -1
    const start = Math.atan2(a.y - cy, a.x - cx)
    let sweep = sign * (Math.atan2(b.y - cy, b.x - cx) - start)
    while (sweep <= 0) sweep += 2 * Math.PI
    const phi = sign * (Math.atan2(y - cy, x - cx) - start), half = Math.acos(c)
    let z = Infinity
    for (let k = -3; k <= 3; k++) {
      const lo = Math.max(0, (phi + 2 * Math.PI * k - half) / sweep)
      const hi = Math.min(1, (phi + 2 * Math.PI * k + half) / sweep)
      if (hi >= lo) z = Math.min(z, a.z + dz * (dz >= 0 ? lo : hi))
    }
    return z
  }
  if (!ball) return flatPointSweepZ(a, b, x, y, r)
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
  const qx = x - a.x, qy = y - a.y
  if (l2 < 1e-24) return qx * qx + qy * qy <= r * r
    ? Math.min(a.z, b.z) + r - Math.sqrt(Math.max(0, r * r - qx * qx - qy * qy)) : Infinity
  const middle = (qx * dx + qy * dy) / l2
  const perp = Math.max(0, qx * qx + qy * qy - middle * middle * l2)
  if (perp > r * r) return Infinity
  const half = Math.sqrt(Math.max(0, (r * r - perp) / l2))
  const lo = Math.max(0, middle - half), hi = Math.min(1, middle + half)
  if (hi < lo) return Infinity
  const t = Math.max(lo, Math.min(hi, middle - dz * Math.sqrt(Math.max(0, r * r - perp)) / Math.sqrt(l2 * (l2 + dz * dz))))
  return a.z + dz * t + r - Math.sqrt(Math.max(0, r * r - (qx - t * dx) ** 2 - (qy - t * dy) ** 2))
}

describe('WO-2835 finish physical stock regression', () => {
  for (const control of [false, true]) {
    it(`3D Finish 3: no rapid first cuts stock at the 68 certified ball witnesses (hop ${control ? 'off' : 'on'})`, () => {
      const certificates = JSON.parse(readFileSync('src/tests/evidence/WO-2835/round7-finish-volumes.json', 'utf8'))
      const points = certificates.inputs[0].records.filter((r: { controlHopOff: boolean }) => !r.controlHopOff)
        .map((r: { cylinder: { x: number; y: number } }) => r.cylinder)
      expect(points).toHaveLength(68)
      const finish = streams.find(s => s.operation === '3D Finish 3' && s.control === control)!
      const prior = streams.filter(s => s.control === control && s.bounds.minX === finish.bounds.minX)
      const contacts: { point: unknown; moveIndex: number; previousTop: number; sweptSurfaceZ: number }[] = []
      for (const point of points) {
        let top = finish.bounds.maxZ
        for (const stream of prior) {
          expect(['flat_end_mill', 'ball_end_mill']).toContain(stream.tool.type)
          for (let i = 1; i < stream.moves.length; i++) {
            const move = stream.moves[i]
            const z = physicalSurfaceZ(stream.moves[i - 1], move, point.x, point.y, stream.tool)
            if (stream === finish && move.type === 'rapid' && z < top - 1e-8 && top > finish.bounds.minZ) {
              contacts.push({ point, moveIndex: i, previousTop: top, sweptSurfaceZ: z })
            }
            top = Math.max(finish.bounds.minZ, Math.min(top, z))
          }
          if (stream === finish) break
        }
      }
      expect(contacts, 'Finish rapid first removes actual remaining stock before fed engagement').toEqual([])
    })
  }
})

// Controls of the shared qualification seam, not application-rendering claims.
// The production witness tests above keep their independent physical oracle.
describe('WO-2835 continuous finish qualification controls', () => {
  const tool = { id: 'query', name: 'query', type: 'flat_end_mill', diameter: 1,
    fluteLength: 20, shankDiameter: 1, overallLength: 50 } as Tool
  const bounds = { minX: -10, minY: -10, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 }
  const remaining: StockState = { schemaVersion: 1, representation: 'z-dexel', bounds,
    requestedResolutionMm: 0.2, resolutionMm: 0.2, warnings: [], nx: 100, ny: 100,
    bottomZ: 0, topZ: new Float32Array(10000) }
  const move = (x: number, y: number, z: number): ToolpathMove => ({ type: 'feed', role: 'cut', feed: 500, x, y, z })
  const history = (type: Tool['type'] = 'flat_end_mill') => ({ enabled: true, status: 'ready',
    tool: { ...tool, id: 'earlier', type, diameter: 8, shankDiameter: 8, fluteLength: 50, cornerRadius: 1 },
    toolpathMoves: [move(-9, 0, 0), move(9, 0, 0)] })
  const run = async (overrides: Partial<import('../../cam3d/integration/airFeedOverRemovedStock').AirFeedOverRemovedStockInput> = {}) => {
    const { rapidAirFeedsOverRemovedStock } = await import('../../cam3d/integration/airFeedOverRemovedStock')
    return rapidAirFeedsOverRemovedStock({ tool, remaining, moves: [move(-2, 0, 3), move(2, 0, 3)],
      preceding: [history()], floorHopMm: 0, ...overrides })
  }
  for (const type of ['flat_end_mill', 'ball_end_mill', 'bull_nose'] as const) {
    it(`${type}: preserves successful conversion in a genuinely removed corridor`, async () => {
      expect((await run({ preceding: [history(type)] })).rapided).toBe(1)
    })
    it(`${type}: rejects actual solid stock even when every sampled top is empty`, async () => {
      expect((await run({ preceding: [history(type)], moves: [move(-2, 4.5, 3), move(2, 4.5, 3)] })).rapided).toBe(0)
    })
  }
  it('missing, disabled, outdated, missing-tool and unsupported histories contribute no removal', async () => {
    for (const preceding of [undefined, [], [{ ...history(), enabled: false }], [{ ...history(), status: 'outdated' }],
      [{ ...history(), tool: undefined }], [history('v_bit')]]) {
      expect((await run({ preceding })).rapided).toBe(0)
    }
  })
  it('checks a larger defined shank rather than only the cutting diameter', async () => {
    expect((await run({ tool: { ...tool, fluteLength: 1, shankDiameter: 12 } })).rapided).toBe(0)
    expect((await run({ tool: { ...tool, fluteLength: 20, shankDiameter: 12 } })).rapided).toBe(1)
  })
  it('never extends a prior short flute into an infinite removed column', async () => {
    const earlier = history()
    expect((await run({ preceding: [{ ...earlier, tool: { ...earlier.tool, fluteLength: 1 } }] })).rapided).toBe(0)
  })
  it('supports circular physical removal without treating its chord as a cut', async () => {
    const earlier = history()
    earlier.tool.diameter = 4
    earlier.toolpathMoves = [move(3, 0, 0), { ...move(3, 0, 0), type: 'arc_ccw', cx: 0, cy: 0 }]
    expect((await run({ preceding: [earlier], moves: [move(3, -0.1, 3), move(3, 0.1, 3)] })).rapided).toBe(1)
    expect((await run({ preceding: [earlier], moves: [move(-0.1, 0, 3), move(0.1, 0, 3)] })).rapided).toBe(0)
  })
  it('bounds a sloping candidate continuously and preserves its exact feed when unproven', async () => {
    const moves = [move(-2, 0, 12), move(2, 0, -1)]
    const result = await run({ moves })
    expect(result.rapided).toBe(0)
    expect(result.moves).toEqual(moves)
  })
  it('uses same-frame histories under a translated and rotated placement', async () => {
    const angle = 0.63, c = Math.cos(angle), s = Math.sin(angle)
    const place = (m: ToolpathMove): ToolpathMove => ({ ...m, x: 130 + m.x * c - m.y * s,
      y: -40 + m.x * s + m.y * c, z: m.z + 17 })
    const earlier = history()
    const placedBounds = { minX: 110, maxX: 150, minY: -60, maxY: -20, minZ: 17, maxZ: 27 }
    expect((await run({ moves: [move(-2, 0, 3), move(2, 0, 3)].map(place),
      remaining: { ...remaining, bounds: placedBounds, bottomZ: 17, nx: 200, ny: 200,
        topZ: new Float32Array(40000).fill(17) },
      preceding: [{ ...earlier, toolpathMoves: earlier.toolpathMoves.map(place) }] })).rapided).toBe(1)
  })
})

describe('WO-2835 affected finish callers through production dispatch', () => {
  for (const type of ['parallel_3d', 'scallop_3d', 'pencil_3d', 'steep_shallow_3d', 'waterline_3d'] as const) {
    it(`${type}: reaches the shared seam and preserves exact retained feeds`, async () => {
      // Reuse the actual earlier rough from beforeAll; each variant replaces
      // only the final finish. No synthetic toolpath is passed to the store.
      viewportSetup = 3
      const setup = useCamStore.getState().project.setups[3]
      const original = setup.operations.find(o => o.name === '3D Finish 3')!
      const candidate = structuredClone(original)
      candidate.type = type
      candidate.status = 'pending'
      candidate.toolpathMoves = undefined
      candidate.generationFingerprint = undefined
      candidate.params = { ...candidate.params, stepover: 4, stepdown: 4,
        scallopHeight: 0.2, surfaceStockToLeave: 1, stockToLeave: 1 }
      const height = validatePersistedSmartHeightState(candidate.smartHeight)
      expect(height.ok).toBe(true)
      if (height.ok) candidate.smartHeight = { ...height.state, intent: { ...height.state.intent,
        policy: { ...height.state.intent.policy, operationType: type } } }
      // The store's command layer (camCommands.ts) refuses a patch naming the identity
      // fields, so send the edit without them, and check it landed before trusting a count.
      const { id: _id, provenance: _provenance, itemKey: _itemKey, userEdited: _userEdited, ...patch } =
        candidate as typeof candidate & { provenance?: unknown; itemKey?: unknown; userEdited?: unknown }
      useCamStore.getState().updateOperation(setup.id, original.id, patch)
      expect(useCamStore.getState().project.setups[3].operations.find(o => o.id === original.id)!.type, type).toBe(type)
      const count = hopControl.inputs.length
      const began = performance.now()
      await useCamStore.getState().computeOperationToolpath(setup.id, original.id)
      const elapsedMs = performance.now() - began
      const done = useCamStore.getState().project.setups[3].operations.find(o => o.id === original.id)!
      expect(done.errorMessage ?? '', type).toBe('')
      expect(done.status, type).toBe('ready')
      const calls = hopControl.inputs.slice(count) as (import('../../cam3d/integration/airFeedOverRemovedStock').AirFeedOverRemovedStockInput
        & { result: import('../../cam3d/integration/airFeedOverRemovedStock').AirFeedOverRemovedStockResult })[]
      expect(calls, type).toHaveLength(1)
      const call = calls[0]
      const feeds = new Set(call.moves.filter(m => m.type !== 'rapid').map(m => JSON.stringify(m)))
      expect(call.result.moves.filter(m => m.type !== 'rapid').every(m => feeds.has(JSON.stringify(m)))).toBe(true)
      finishCallers.push({ type, elapsedMs, estimatedCutTimeMs: done.estimatedCutTimeMs,
        candidates: call.result.candidates, rapided: call.result.rapided,
        historiesForwarded: call.preceding?.length ?? 0, sourceMoves: call.moves, moves: done.toolpathMoves })
    }, 180_000)
  }
  it('retains successful production air conversion with conservative physical qualification', () => {
    console.info('WO-2835 link counts', finishCallers.map(r => ({ fixture: `Full Suite Setup 5 / ${r.type}`,
      airFeedCandidates: r.candidates, convertedToRapid: r.rapided,
      keptFed: Number(r.candidates) - Number(r.rapided), historiesForwarded: r.historiesForwarded })))
    expect(finishCallers.some(r => Number(r.rapided) > 0)).toBe(true)
  })
})
