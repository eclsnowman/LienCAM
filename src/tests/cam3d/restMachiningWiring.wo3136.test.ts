// @vitest-environment jsdom
// WO-3136 (owner D5, 2026-10-28 "Build it as described"): a smaller 3D finish skips
// surface a BIGGER finish already cut to tolerance, so it only cuts where the big
// tool could not reach. After a rough that left stock-to-leave, it still cuts
// everything. Only an earlier BIGGER finish counts: a rough (even one cut to size)
// and an equal-size finish never make it leave anything out. Production route: File Open of the shipped knob, the real store's
// computeOperationToolpath, the real kernel, planner and postprocess fallback.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { Operation, Project, Tool, ToolpathMove } from '../../types'
import { typedMock } from '../support/typedMock'

const ROOT = path.resolve(__dirname, '../../..')
const KNOB = path.join(ROOT, 'examples/06-knob-handwheel/knob-handwheel.camproject')

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
      id: string, payload: BrepModelPayload, sourceSha256: string, tessellation: StepDisplayTessellation | null,
    ) => {
      stepDisplay.set(id, { displayContractVersion: 1, sourceSha256, tessellation, payload, byteLength: 0, updatedAt: 0 })
    }),
    loadCachedStepDisplay: vi.fn(async (id: string) => stepDisplay.get(id) ?? null),
    removeCachedStepDisplay: vi.fn(async (id: string) => { stepDisplay.delete(id) }),
  })
})
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
      // Delivered on a later turn, as a real worker's message is: the turns between
      // kernel calls let this worker read Vitest's RPC replies ("Timeout calling
      // onTaskUpdate", see goodspec-tripwires.test.ts).
      postMessage(message: unknown): void { setImmediate(() => dispatcher.handle(message as never)) },
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

// Records what the production route hands the finish-link seam and what it returns;
// the seam itself runs unchanged.
type LinkInput = Parameters<typeof import('../../store/finishLinks').lowerFinishLinksAfterEarlierOperations>[0]
type LinkOutput = ReturnType<typeof import('../../store/finishLinks').lowerFinishLinksAfterEarlierOperations>
const linkCalls: { input: LinkInput; output: LinkOutput }[] = []
vi.mock('../../store/finishLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/finishLinks')>()
  return typedMock<typeof import('../../store/finishLinks')>({
    lowerFinishLinksAfterEarlierOperations: (input) => {
      const output = actual.lowerFinishLinksAfterEarlierOperations(input)
      linkCalls.push({ input, output })
      return output
    },
  })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
  configurable: true,
})

const { useCamStore } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')

beforeEach(() => {
  stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear(); linkCalls.length = 0
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
})
afterEach(() => new Promise<void>(resolve => setImmediate(resolve)))
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

const BIG_BALL_ID = 'wo3136-ball-6'
const EARLIER_FINISH_ID = 'wo3136-parallel-earlier'
type Case = 'big-finish' | 'equal-finish' | 'rough-left-stock' | 'rough-at-size' | 'none'

/**
 * The shipped knob, its own 3 mm ball Parallel finish unchanged, with what comes
 * before it chosen per case: a 6 mm ball Parallel finish, a 3 mm ball Parallel
 * finish with the same tool, the knob's own 6 mm flat rough leaving 0.5 mm or as
 * shipped (0 mm, cut to size), or nothing enabled. The waterline after it is disabled.
 */
function knobProject(kind: Case): string {
  const project = JSON.parse(fs.readFileSync(KNOB, 'utf8')) as Project
  const ops = project.setups[0].operations
  const [rough, finish, waterline] = ops
  expect([rough.type, finish.type, waterline.type]).toEqual(['adaptive_3d', 'parallel_3d', 'waterline_3d'])
  const small = project.toolLibrary.find(t => t.id === finish.toolId)!
  expect([small.type, small.diameter]).toEqual(['ball_end_mill', 3])
  waterline.enabled = false
  rough.enabled = kind === 'rough-left-stock' || kind === 'rough-at-size'
  if (kind === 'rough-left-stock') {
    rough.params = { ...rough.params, radialStockToLeave: 0.5, axialStockToLeave: 0.5 }
  }
  if (kind === 'rough-at-size') {
    expect(rough.params).toMatchObject({ radialStockToLeave: 0, axialStockToLeave: 0 })
  }
  if (kind === 'big-finish' || kind === 'equal-finish') {
    const earlier = structuredClone(finish) as Operation
    earlier.id = EARLIER_FINISH_ID
    earlier.params = { ...earlier.params, stepover: 0.4 }
    if (kind === 'big-finish') {
      const big: Tool = { ...small, id: BIG_BALL_ID, name: '6 mm ball end mill', diameter: 6, shankDiameter: 6, cornerRadius: 3, toolNumber: 6 }
      project.toolLibrary.push(big)
      earlier.name = '3D Finish 6 mm ball'
      earlier.toolId = BIG_BALL_ID
    } else {
      earlier.name = '3D Finish 3 mm ball, earlier'
    }
    ops.splice(1, 0, earlier)
  }
  for (const op of ops) { op.status = 'pending'; delete op.toolpathMoves }
  return JSON.stringify(project)
}

const isCut = (m: ToolpathMove): boolean => m.type === 'feed' && m.role === 'cut'

async function generate(kind: Case): Promise<{ before?: Operation; finish: Operation }> {
  const store = useCamStore.getState()
  await store.loadProjectFromFile(knobProject(kind))
  const setupId = useCamStore.getState().project.setups[0].id
  const opsNow = () => useCamStore.getState().project.setups[0].operations
  const first = opsNow().find(o => o.enabled && o.type !== 'parallel_3d' || o.id === EARLIER_FINISH_ID)
  if (first) {
    await turn()
    await useCamStore.getState().computeOperationToolpath(setupId, first.id)
    const done = opsNow().find(o => o.id === first.id)!
    expect(done.status, done.errorMessage).toBe('ready')
  }
  const finishId = opsNow().find(o => o.type === 'parallel_3d' && o.id !== EARLIER_FINISH_ID)!.id
  await turn()
  await useCamStore.getState().computeOperationToolpath(setupId, finishId)
  await turn()
  const finish = opsNow().find(o => o.id === finishId)!
  expect(finish.status, finish.errorMessage).toBe('ready')
  return { before: first ? opsNow().find(o => o.id === first.id) : undefined, finish }
}

const cutsOf = (moves: readonly ToolpathMove[]): ToolpathMove[] => moves.filter(isCut)
const key = (m: ToolpathMove): string => `${m.x},${m.y},${m.z}`

/**
 * Independent oracle, not the product's certificate: the material the earlier
 * ball sweeps left, stamped on a 0.05 mm grid from ball positions every 0.05 mm
 * along each sweep (capped by the stock top), and the deepest the finish's ball
 * would cut into it anywhere along a move (sampled every 0.02 mm).
 */
async function materialOracle(input: LinkInput) {
  const { bounds } = input.remaining!
  const cell = 0.05
  const nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1
  const ny = Math.ceil((bounds.maxY - bounds.minY) / cell) + 1
  const top = new Float64Array(nx * ny).fill(bounds.maxZ)
  const ball = (r: number, d: number) => (d > r ? Infinity : r - Math.sqrt(r * r - d * d))
  for (const op of input.preceding ?? []) {
    if (!op.enabled || op.status !== 'ready' || !op.toolpathMoves || !op.tool) continue
    expect(op.tool.type).toBe('ball_end_mill')
    const r = op.tool.diameter / 2
    const moves = op.toolpathMoves
    for (let i = 1; i < moves.length; i++) {
      if (i % 2000 === 0) await turn()
      const a = moves[i - 1], b = moves[i]
      if (b.type === 'rapid') continue
      expect(b.type).toBe('feed')
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / cell))
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t
        const i0 = Math.max(0, Math.ceil((x - r - bounds.minX) / cell)), i1 = Math.min(nx - 1, Math.floor((x + r - bounds.minX) / cell))
        const j0 = Math.max(0, Math.ceil((y - r - bounds.minY) / cell)), j1 = Math.min(ny - 1, Math.floor((y + r - bounds.minY) / cell))
        for (let j = j0; j <= j1; j++) {
          const qy = bounds.minY + j * cell
          for (let ii = i0; ii <= i1; ii++) {
            const h = z + ball(r, Math.hypot(bounds.minX + ii * cell - x, qy - y))
            if (h < top[j * nx + ii]) top[j * nx + ii] = h
          }
        }
      }
    }
  }
  const r = input.tool.diameter / 2
  /** Deepest intrusion of the finish's ball into that material along a -> b, mm. */
  return (a: ToolpathMove, b: ToolpathMove): number => {
    let worst = -Infinity
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.02))
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t
      const i0 = Math.max(0, Math.ceil((x - r - bounds.minX) / cell)), i1 = Math.min(nx - 1, Math.floor((x + r - bounds.minX) / cell))
      const j0 = Math.max(0, Math.ceil((y - r - bounds.minY) / cell)), j1 = Math.min(ny - 1, Math.floor((y + r - bounds.minY) / cell))
      for (let j = j0; j <= j1; j++) {
        const qy = bounds.minY + j * cell
        for (let ii = i0; ii <= i1; ii++) {
          const under = z + ball(r, Math.hypot(bounds.minX + ii * cell - x, qy - y))
          if (Number.isFinite(under)) worst = Math.max(worst, top[j * nx + ii] - under)
        }
      }
    }
    return worst
  }
}

it('WO-3136 knob: a 3 mm ball Parallel after a 6 mm ball Parallel cuts only where the 6 mm ball could not reach', async () => {
  const { before, finish } = await generate('big-finish')
  expect(before?.id).toBe(EARLIER_FINISH_ID)
  expect(linkCalls).toHaveLength(2)
  const { input, output } = linkCalls[1]
  expect(input.tool.diameter).toBe(3)
  const tolerance = (input.op.params as { tolerance: number }).tolerance
  expect(tolerance).toBe(0.05)
  const planned = cutsOf(input.moves)
  const published = cutsOf(finish.toolpathMoves!)
  console.log('WO-3136 big-finish', JSON.stringify({ planned: planned.length, published: published.length, moves: finish.toolpathMoves!.length }))
  // The owner's card: "fewer 3 mm cutting moves".
  expect(published.length, 'the 3 mm finish must leave out surface the 6 mm finish already cut').toBeLessThan(planned.length * 0.75)
  expect(output.dependsOnEarlierOperations).toBe(true)

  // Cuts kept wherever the 6 mm ball left material above the tolerance.
  const intrusion = await materialOracle(input)
  const kept = new Set(cutsOf(output.moves).map(key))
  let leftOut = 0, worst = -Infinity, needed = 0
  for (let i = 1; i < input.moves.length; i++) {
    if (i % 2000 === 0) await turn()
    const move = input.moves[i]
    if (!isCut(move)) continue
    const depth = intrusion(input.moves[i - 1], move)
    if (depth > tolerance + 0.005) needed++
    if (kept.has(key(move))) continue
    leftOut++
    worst = Math.max(worst, depth)
  }
  console.log('WO-3136 oracle', JSON.stringify({ leftOut, worstLeftOutIntrusionMm: worst, cutsTheOracleNeeds: needed }))
  expect(leftOut).toBe(planned.length - cutsOf(output.moves).length)
  expect(needed, 'the 6 mm ball leaves material the 3 mm ball must still cut').toBeGreaterThan(1000)
  expect(worst, 'no left-out cut may meet more than the tolerance of material').toBeLessThanOrEqual(tolerance + 0.005)
}, 1_800_000)

it('WO-3136 knob: with no earlier operation the 3 mm finish is byte-identical', async () => {
  const { before, finish } = await generate('none')
  expect(before).toBeUndefined()
  expect(linkCalls).toHaveLength(1)
  const { input, output } = linkCalls[0]
  expect(output.moves).toEqual(input.moves)
  expect(output.dependsOnEarlierOperations).toBe(false)
  expect(cutsOf(finish.toolpathMoves!)).toHaveLength(cutsOf(input.moves).length)
}, 1_800_000)

/**
 * The owner's card names only a bigger finish. Exactly what the link lowering and air
 * feeds alone make of this finish, with nothing left out.
 */
async function expectOnlyLoweringAndAirFeeds(input: LinkInput, output: LinkOutput, label: string): Promise<void> {
  expect(input.remaining).toBeDefined()
  const { lowerFinishLinksOverRemovedStock } = await import('../../cam3d/integration/finishLinksOverRemovedStock')
  const { rapidAirFeedsOverRemovedStock } = await import('../../cam3d/integration/airFeedOverRemovedStock')
  const { clearanceAllowanceMmOf } = await import('../../lib/cam/holderClearanceGate')
  const lowered = lowerFinishLinksOverRemovedStock({
    moves: input.moves, tool: input.tool, remaining: input.remaining!, clearanceZ: input.clearanceZ,
    ...(input.workholding.length > 0
      ? { workholding: input.workholding, workholdingAllowanceMm: clearanceAllowanceMmOf(input.op.params) }
      : {}),
  })
  const air = rapidAirFeedsOverRemovedStock({ moves: lowered.moves, tool: input.tool, remaining: input.remaining!, preceding: input.preceding })
  console.log(`WO-3136 ${label}`, JSON.stringify({
    planned: cutsOf(input.moves).length, published: cutsOf(output.moves).length, loweringAndAirOnly: cutsOf(air.moves).length,
  }))
  expect(cutsOf(output.moves), `${label}: no cut may be left out`).toHaveLength(cutsOf(air.moves).length)
  expect(output.moves).toEqual(air.moves)
}

it('WO-3136 knob: after a 6 mm flat rough that left 0.5 mm the 3 mm finish drops nothing', async () => {
  const { before } = await generate('rough-left-stock')
  expect(before?.type).toBe('adaptive_3d')
  // The rough is not a finish: only the 3 mm finish reaches the finish-link seam.
  expect(linkCalls).toHaveLength(1)
  const { input, output } = linkCalls[0]
  // The owner's card: the allowance is real material.
  await expectOnlyLoweringAndAirFeeds(input, output, 'rough-left-stock')
}, 1_800_000)

it('WO-3136 knob: after the knob\'s own 6 mm flat rough cut to size the 3 mm finish drops nothing', async () => {
  const { before } = await generate('rough-at-size')
  expect(before?.type).toBe('adaptive_3d')
  expect(linkCalls).toHaveLength(1)
  const { input, output } = linkCalls[0]
  // A rough is not a bigger finish, even at zero stock-to-leave (audit F1).
  await expectOnlyLoweringAndAirFeeds(input, output, 'rough-at-size')
}, 1_800_000)

it('WO-3136 knob: after an earlier finish with the same 3 mm ball the 3 mm finish drops nothing', async () => {
  const { before } = await generate('equal-finish')
  expect(before?.id).toBe(EARLIER_FINISH_ID)
  expect(linkCalls).toHaveLength(2)
  const { input, output } = linkCalls[1]
  const earlier = input.preceding?.find(p => p.enabled && p.status === 'ready' && p.toolpathMoves?.length)
  expect(earlier?.tool?.diameter).toBe(input.tool.diameter)
  // Only a strictly bigger tool's finish is left out of a smaller one.
  await expectOnlyLoweringAndAirFeeds(input, output, 'equal-finish')
}, 1_800_000)
