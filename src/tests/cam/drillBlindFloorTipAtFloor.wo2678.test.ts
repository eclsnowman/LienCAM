// WO-2678: a Drill's tip stops at a blind hole's flat floor.
//
// the operator, 2026-10-08 ~7:20 AM, on "A drill can't make a flat-bottomed blind hole.
// Which wins for blind holes with a flat floor?": "Tip stops at the floor
// (Recommended)" - the drill point goes to the floor, so the part is never cut
// into; through holes keep the point length so they break out clean.
//
// Part 1 is his Full Suite, Setup 2, Drill 2 through the production compute (the
// store's computeOperationToolpath and the real toolpathWorker in-process) with
// the part known to the reach gate: Part 1's own STEP, tessellated by the real
// OCCT kernel and placed where the project puts it, rides on the request exactly
// as a model-body part's tessellation does (toolReachInputs.ts). Its twelve 5 mm
// holes are blind with flat floors at world Z 6, 4 and 1. Before the fix every
// floor took 1.2 mm of drill point below it and the gate stopped the cutter 20
// times, 17.5 mm uncut. Part 2 pins the evidence rule on its own: a through hole
// keeps its point compensation and breakthrough, a blind one takes no point (a
// Break through the operator turns on is still theirs), unknown keeps today's
// answer, Bore is untouched.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Tool, ToolpathMove } from '../../types'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

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

// emscripten's Node branch references CJS globals (same shim as inputStep.test.ts).
const here = dirname(fileURLToPath(import.meta.url))
const cjs = globalThis as unknown as Record<string, unknown>
cjs.require ??= createRequire(import.meta.url)
cjs.__dirname ??= here
cjs.__filename ??= fileURLToPath(import.meta.url)

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const {
  buildDrillBoreSmartHeightEvidenceContext, buildDrillBoreSmartHeightIntent, drillPointCompensationMm,
  resolveDrillBoreSmartHeights,
} = await import('../../lib/cam/smartHeights/drillBore')
const { loadOcctModel, _resetOcctModelForTest } = await import('../../lib/cam/geometry/occt/model/loader')
const { importStepToPartMesh, makeOcctCoreTessellator } = await import('../../cam3d/input')
const { resolveSamplePartPath } = await import('../../cam3d/input/fixturePaths')

// The worker runs in-process: the store posts to a Worker shim that hands the
// request straight to toolpathWorker's onmessage, exactly as the browser would.
// `partForRequest` is the one addition: the part the gate is told about.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
let partForRequest: ClearanceMesh | undefined
if (g.window === undefined) g.window = {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups.find(s => s.name === 'Setup 2')!
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(setup, project)!)
  },
}
g.self = { postMessage: (m: unknown) => { activeShim?.onmessage?.({ data: m }) }, onmessage: null }
await import('../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) {
    activeShim = this
    const request = data as { payload?: Record<string, unknown> }
    if (partForRequest && request.payload && 'clearanceAllowanceMm' in request.payload) {
      request.payload.clearancePart = partForRequest
    }
    void workerSelf.onmessage?.({ data })
  }
  terminate() { activeShim = null }
}

interface OperationReadback {
  name: string
  status: string
  errorMessage?: string
  toolpathMoves?: ToolpathMove[]
  reachShortfall?: { reachedZ: number; askedZ: number; uncutMm: number }
}

/** Part 1's STEP tessellated by the real kernel, moved to where the project places it. */
async function partOneInWorld(position: { x: number; y: number; z: number }): Promise<ClearanceMesh> {
  _resetOcctModelForTest()
  const wasm = readFileSync(join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm'))
  const oc = await loadOcctModel({ wasmBinary: wasm })
  const buf = readFileSync(resolveSamplePartPath('Step Test With Holes.step'))
  const bytes = new ArrayBuffer(buf.byteLength)
  new Uint8Array(bytes).set(buf)
  const { mesh } = await importStepToPartMesh(bytes, { camTolerance: 0.04, tessellator: makeOcctCoreTessellator(oc) })
  const positions = Float32Array.from(mesh.positions)
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += position.x
    positions[i + 1] += position.y
    positions[i + 2] += position.z
  }
  return { positions, indices: Uint32Array.from(mesh.indices) }
}

describe('WO-2678 part 1: Full Suite Drill 2 ends at the blind floors with the part known', () => {
  let drill: OperationReadback
  let reachLines: string[]
  let tipsByHole: Map<string, number>
  let partBounds: { minZ: number; maxZ: number }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const text = readFileSync(join(process.cwd(), 'Example Projects', 'Full Suite.camproject'), 'utf8')
    await useCamStore.getState().loadProjectFromFile(text)
    const project = useCamStore.getState().project
    const part = project.geometry.find(geo => geo.name === 'Part 1')!
    partForRequest = await partOneInWorld(part.position!)
    let minZ = Infinity, maxZ = -Infinity
    for (let i = 2; i < partForRequest.positions.length; i += 3) {
      minZ = Math.min(minZ, partForRequest.positions[i])
      maxZ = Math.max(maxZ, partForRequest.positions[i])
    }
    partBounds = { minZ, maxZ }
    const setup = project.setups.find(s => s.name === 'Setup 2')!
    const op = setup.operations.find(o => o.name === 'Drill 2')!
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    drill = useCamStore.getState().project.setups.find(s => s.name === 'Setup 2')!
      .operations.find(o => o.name === 'Drill 2') as unknown as OperationReadback
    reachLines = useCamStore.getState().consoleEvents
      .map(e => e.message)
      .filter(m => /left uncut|stopped short|cut stopped/i.test(m))
    tipsByHole = new Map()
    for (const move of drill.toolpathMoves ?? []) {
      if (move.type === 'rapid') continue
      const key = `${move.x.toFixed(2)},${move.y.toFixed(2)}`
      tipsByHole.set(key, Math.min(tipsByHole.get(key) ?? Infinity, move.z))
    }
    console.warn('[WO-2678] Drill 2', JSON.stringify({
      status: drill.status,
      error: drill.errorMessage ?? null,
      moves: drill.toolpathMoves?.length ?? 0,
      partBounds,
      tips: [...tipsByHole.values()].map(z => Number(z.toFixed(4))).sort((a, b) => a - b),
      reachShortfall: drill.reachShortfall ?? null,
      reachLines,
    }))
  }, 300_000)

  it('the part the gate is told about is Part 1 where the project places it (world Z 0..14)', () => {
    expect(partBounds.minZ).toBeCloseTo(0, 3)
    expect(partBounds.maxZ).toBeCloseTo(14, 3)
  })

  it('is ready with no stop: nothing left uncut and no stop said', () => {
    expect(drill.status, drill.errorMessage).toBe('ready')
    expect(drill.reachShortfall).toBeUndefined()
    expect(reachLines).toEqual([])
  })

  it('every hole ends with the tip at its floor: four each at world Z 6, 4 and 1', () => {
    const tips = [...tipsByHole.values()].sort((a, b) => a - b)
    expect(tips).toHaveLength(12)
    for (const [index, floor] of [1, 4, 6].entries()) {
      for (const tip of tips.slice(index * 4, index * 4 + 4)) expect(tip).toBeCloseTo(floor, 3)
    }
  })
})

// ── Part 2: the evidence rule, through the Smart Height resolver ─────────────

const DRILL: Tool = {
  id: 'd5', name: '5 mm drill', type: 'drill', diameter: 5, fluteLength: 40, shankDiameter: 5, overallLength: 75,
  numberOfFlutes: 2, angleFromAxisDeg: 59, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
} as Tool
const POINT = drillPointCompensationMm(DRILL)

function feature(id: string, floor: number, through?: boolean) {
  return {
    loopId: id,
    feature: {
      modelItemId: 'm', bodyId: 'b', featureKind: 'detected_hole', stableId: id, sourceVersion: 1,
      sourceFingerprint: `fp-${id}`,
    },
    topMachineMm: 10,
    floorMachineMm: floor,
    fingerprint: `ev-${id}`,
    ...(through === undefined ? {} : { through }),
  }
}

function tipsFor(
  operationType: 'drill' | 'bore',
  features: ReturnType<typeof feature>[],
  breakthroughMm = 0,
): Record<string, number> {
  const safety = { reference: 'stock_top' as const, offset: 5, provenance: 'inferred' as const }
  const intent = buildDrillBoreSmartHeightIntent({
    operationType, setupId: 's', mode: 'detected_features', features,
    safetyIntent: { clearance: safety, retract: { ...safety, offset: 3 }, feed: { ...safety, offset: 1 } },
  })
  const evidence = buildDrillBoreSmartHeightEvidenceContext({
    operationType, mode: 'detected_features',
    revision: { projectRevision: 'p', setupRevision: 's', operationRevision: 'o' },
    wcsOriginMachineMm: 0, operationId: 'op', geometryIds: ['g'], features,
    owningStock: { stockId: 'st', topMachineMm: 10, bottomMachineMm: 0, fingerprint: 'st' },
    tool: DRILL, breakthroughMm,
  })
  const resolved = resolveDrillBoreSmartHeights({ operationType, intent, evidence, features, tool: DRILL, breakthroughMm })
  return Object.fromEntries(resolved.featureEndpoints.map(e => [e.loopId, e.cutterCenterEndWcsMm]))
}

describe('WO-2678 part 2: blind floors take no point, through holes keep it', () => {
  it('a blind detected floor is the tip; a through hole keeps its point compensation', () => {
    const tips = tipsFor('drill', [feature('blind', 4, false), feature('through', 0, true)])
    expect(tips.blind).toBeCloseTo(4, 9)
    expect(tips.through).toBeCloseTo(0 - POINT, 9)
  })

  it('a Break through the operator turns on is kept on both; the blind floor still takes no point', () => {
    const tips = tipsFor('drill', [feature('blind', 4, false), feature('through', 0, true)], 0.5)
    expect(tips.blind).toBeCloseTo(4 - 0.5, 9)
    expect(tips.through).toBeCloseTo(0 - POINT - 0.5, 9)
  })

  it('all blind: every tip is its floor', () => {
    const tips = tipsFor('drill', [feature('a', 4, false), feature('b', 6, false)])
    expect(tips).toEqual({ a: 4, b: 6 })
  })

  it('all through holes keep today\'s answer exactly (point + breakthrough below every floor)', () => {
    const tips = tipsFor('drill', [feature('a', 0, true), feature('b', 2, true)], 0.5)
    expect(tips.a).toBeCloseTo(-POINT - 0.5, 9)
    expect(tips.b).toBeCloseTo(2 - POINT - 0.5, 9)
  })

  it('where blind or through is not known, today\'s point compensation stays', () => {
    const tips = tipsFor('drill', [feature('unknown', 4)], 0)
    expect(tips.unknown).toBeCloseTo(4 - POINT, 9)
  })

  it('Bore is unchanged: its breakthrough still applies on a blind floor', () => {
    const tips = tipsFor('bore', [feature('blind', 4, false)], 0.5)
    expect(tips.blind).toBeCloseTo(3.5, 9)
  })
})
