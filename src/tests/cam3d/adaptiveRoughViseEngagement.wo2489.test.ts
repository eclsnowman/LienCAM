// @vitest-environment jsdom
//
// WO-2489: the knob example's Adaptive Rough with its vise imported (WO-2445's
// corrected vise, through the production workholding-file import) is the same
// rough as without it. The vise's two jaw rows carry the knob's stock id, and the
// full-clear gate counted them as two more parts on that stock: "3 parts share
// this stock", so the rough fell back to part bounds with interior entry and
// refused at the engagement cap (77 % vs 75 %). Workholding is not a part.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../support/typedMock'

const ROOT = path.resolve(__dirname, '../../..')
const KNOB = path.join(ROOT, 'examples/06-knob-handwheel/knob-handwheel.camproject')
const VISE = path.join(ROOT, 'src/tests/evidence/WO-2489/knob-base-vise.workholding.json')

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

// What the store asks the rough for (the production request, less the live handles).
const calls: Record<string, unknown>[] = []
let inputsOnly = true
vi.mock('../../cam3d/integration/adaptive3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/adaptive3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/adaptive3dOperation')>({
    ...actual,
    computeAdaptive3dMoves: (async (input: Parameters<typeof actual.computeAdaptive3dMoves>[0]) => {
      const { partMesh: _p, client: _c, signal: _s, onProgress: _o, tool: _t, startFromStock: _r, ...rest } = input
      calls.push(JSON.parse(JSON.stringify(rest)) as Record<string, unknown>)
      if (inputsOnly) throw new Error('WO-2489: request recorded, not generated')
      return actual.computeAdaptive3dMoves(input)
    }) as typeof actual.computeAdaptive3dMoves,
  })
})
// The engine's own whole-path engagement report (adaptiveRough.ts, the cap check).
const engagementReports: { peakFraction: number; peakAt: unknown; overCapLengthMm: number; longestOverCapRunMm: number }[] = []
vi.mock('../../cam3d/rough', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/rough')>()
  return typedMock<typeof import('../../cam3d/rough')>({
    ...actual,
    measurePathEngagement: ((...args: Parameters<typeof actual.measurePathEngagement>) => {
      const result = actual.measurePathEngagement(...args)
      engagementReports.push({ peakFraction: result.peakFraction, peakAt: result.peakAt,
        overCapLengthMm: result.overCapLengthMm, longestOverCapRunMm: result.longestOverCapRunMm })
      return result
    }) as typeof actual.measurePathEngagement,
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
  stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear(); calls.length = 0; engagementReports.length = 0
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
})

async function roughKnob(withVise: boolean) {
  // WO-2548's shipped project now retains WO-2445's assembly. Start both
  // controls without it, then import the original two-jaw fixture only for
  // withVise. Otherwise the nominal no-vise control already has a vise and
  // the import adds a second one, invalidating this comparison.
  const input = JSON.parse(fs.readFileSync(KNOB, 'utf8'))
  input.geometry = input.geometry.filter((g: { workholding?: boolean }) => g.workholding !== true)
  delete input.workholding
  await useCamStore.getState().loadProjectFromFile(JSON.stringify(input))
  const setup = useCamStore.getState().project.setups[0]
  if (withVise) {
    const imported = await useCamStore.getState().importWorkholdingFile(fs.readFileSync(VISE, 'utf8'), setup.id)
    expect(imported?.instanceId).toBeTruthy()
  }
  const op = useCamStore.getState().project.setups[0].operations[0]
  expect(op.type).toBe('adaptive_3d')
  await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
  const after = useCamStore.getState().project.setups[0].operations[0]
  return { op: after, project: useCamStore.getState().project }
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('WO-2489 knob Adaptive Rough with the example vise', () => {
  it('asks the rough for the same full-stock side-entry plan with the vise as without it', { timeout: 300_000 }, async () => {
    inputsOnly = true
    await roughKnob(false)
    const withoutVise = calls.splice(0)
    resetDocumentHolder(); setDocumentStorage(new InMemoryDocumentStorage()); useCamStore.getState().newProject()
    const { project } = await roughKnob(true)
    const withVise = calls.splice(0)
    // The vise really is in this setup, as two workholding rows on the knob's stock.
    const jaws = project.geometry.filter(g => g.workholding === true)
    expect(jaws.map(g => g.name).sort()).toEqual(['knob-fixed-jaw', 'knob-moving-jaw'])
    expect(project.workholding?.instances).toHaveLength(1)
    expect(withoutVise).toHaveLength(1)
    expect(withoutVise[0]).toMatchObject({ sideEntry: true, reachStockEdgeBy: 6 })
    expect(withVise).toEqual(withoutVise)
  })

  // Opt-in (minutes): WO2489_GENERATE=1 generates both through the store and
  // writes src/tests/evidence/WO-2489/generate-<label>.json.
  it.skipIf(process.env.WO2489_GENERATE !== '1')('generates with the vise within the engagement cap and above the jaws',
    { timeout: 1_800_000 }, async () => {
      inputsOnly = false
      const label = process.env.WO2489_LABEL ?? 'run'
      const summary: Record<string, unknown> = {}
      // WO2489_ONLY=vise|novise runs one of the two (each is several minutes).
      const only = process.env.WO2489_ONLY
      for (const withVise of [false, true].filter(v => !only || only === (v ? 'vise' : 'novise'))) {
        resetDocumentHolder(); setDocumentStorage(new InMemoryDocumentStorage()); useCamStore.getState().newProject()
        engagementReports.length = 0
        const t0 = performance.now()
        const { op } = await roughKnob(withVise)
        const moves = op.toolpathMoves ?? []
        const report = engagementReports[engagementReports.length - 1] ?? null
        summary[withVise ? 'withVise' : 'withoutVise'] = {
          status: op.status, error: op.errorMessage ?? null, moves: moves.length, sha256: sha(moves),
          minZ: moves.length ? Math.min(...moves.map(m => m.z)) : null, engagement: report,
          seconds: Math.round((performance.now() - t0) / 1000),
        }
      }
      fs.writeFileSync(path.join(ROOT, `src/tests/evidence/WO-2489/generate-${label}${only ? `-${only}` : ''}.json`), JSON.stringify(summary, null, 2) + '\n')
      if (only === 'novise') return
      const vise = summary.withVise as { status: string; minZ: number; engagement: { peakFraction: number } }
      expect(vise.status).toBe('ready')
      expect(vise.minZ).toBeGreaterThan(3) // the jaw tops (WO-2445 vise, Z 3)
      expect(vise.engagement.peakFraction).toBeLessThanOrEqual(0.75)
    })
})
