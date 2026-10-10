// @vitest-environment jsdom
//
// WO-400 probe (opt-in): open ONE example project through the store and run
// Generate all in-process, with the same mocks the Smart Height V2 authority
// test uses (in-process cam3d client, OCCT core tessellator, in-memory binary
// caches). Lets a 3D rough that misbehaves in the headless browser proof be
// timed here and its planner warnings read.
//
//   EXAMPLE_PROBE=Full_Suite npx vitest run src/tests/examples/_exampleGenerate.probe.test.ts
//
// Skipped entirely without EXAMPLE_PROBE / EXAMPLE_PROBE_FILE (a full 3D rough takes minutes).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../support/typedMock'

const EXAMPLES_DIR = path.resolve(__dirname, '../../../Example Projects')

// In-memory binary caches so a load -> save round trip keeps every embedded
// STL/STEP byte-identical (the real ones live in IndexedDB).
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
    // Real signature (stepCache.ts:108): the caller hands the raw payload, not
    // a prebuilt record - the record is assembled here the same way the real
    // function assembles it, so a round trip through this fixture returns a
    // genuine `CachedStepDisplay` rather than a bare payload wearing its name.
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

// 3D families preview through the cam3d client; jsdom has no Worker, so the
// real BvhKernel + dispatcher run in-process (the pattern
// modelBodyStockBinding.wo305 and adaptive3dHeightTruth.cam16 use).
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

// STEP parts tessellate through the browser model worker by default; hand the
// default tessellator the in-process OCCT core instead (the cam3d gate tests'
// pattern), so a STEP-based 3D operation can preview here.
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

// EXAMPLE_PROBE_PLAN_DUMP=<path.json>: record every 2D level-plan request the 3D rougher
// makes (feature AND params, byte-faithful) so a level can be replayed in 2D in seconds
// (WO-409's repro loop). The engine is untouched; this wraps processFeature at the test seam.
const planDumpPath = process.env.EXAMPLE_PROBE_PLAN_DUMP
const planRequests: unknown[] = []
vi.mock('../../lib/cam/adaptiveClearing2d/engine/processFeature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/adaptiveClearing2d/engine/processFeature')>()
  if (!process.env.EXAMPLE_PROBE_PLAN_DUMP) {
    return typedMock<typeof import('../../lib/cam/adaptiveClearing2d/engine/processFeature')>(actual)
  }
  return typedMock<typeof import('../../lib/cam/adaptiveClearing2d/engine/processFeature')>({
    ...actual,
    processFeature: (feature: unknown, params: unknown) => {
      const res = actual.processFeature(feature as never, params as never)
      planRequests.push({ feature, params, passes: res.passes.length, aborted: res.stats.aborted ?? null })
      return res
    },
  })
})

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')

beforeEach(() => {
  stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear()
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
})


// ---------------------------------------------------------------------------
// WO-400 probe: open ONE example project through the store and run its
// operations in-process (same mocks as the V2 authority test), so a 3D rough
// that misbehaves in the headless browser proof can be timed and its planner
// warnings read here. Opt-in: EXAMPLE_PROBE=<substring of the file name>.
// ---------------------------------------------------------------------------
// EXAMPLE_PROBE=<substring> picks example files; EXAMPLE_PROBE_FILE=<absolute path> opens
// any .camproject (an uploaded repro, for instance) through the same store path.
const PROBE = process.env.EXAMPLE_PROBE
const PROBE_FILE = process.env.EXAMPLE_PROBE_FILE
const PROBE_FILES: string[] = PROBE_FILE
  ? [PROBE_FILE]
  : PROBE ? fs.readdirSync(EXAMPLES_DIR).filter(n => n.endsWith('.camproject') && n.includes(PROBE)).map(n => path.join(EXAMPLES_DIR, n)) : []

describe.skipIf(!PROBE && !PROBE_FILE)('Example project generate probe', () => {
  it.each(PROBE_FILES)('%s: Generate all completes', { timeout: 1_800_000 }, async (filePath) => {
    const fileName = path.basename(filePath)
    const warnCounts = new Map<string, number>()
    const origWarn = console.warn
    const rawKept: string[] = []
    console.warn = (...args: unknown[]) => {
      const line = String(args[0])
      // Refusal diagnostics keep their numbers (the over-cap runs of the side-entry gate).
      if (line.includes('over-cap run') && rawKept.length < 60) rawKept.push(line)
      const key = line.replace(/-?\d+\.\d+/g, 'N').slice(0, 140)
      warnCounts.set(key, (warnCounts.get(key) ?? 0) + 1)
    }
    try {
      await useCamStore.getState().loadProjectFromFile(fs.readFileSync(filePath, 'utf8'))
      const t0 = performance.now()
      await useCamStore.getState().computeAllToolpaths()
      for (;;) {
        const ops = useCamStore.getState().project.setups.flatMap(s => s.operations)
        if (!ops.some(o => o.status === 'computing' || o.status === 'pending')) break
        await new Promise(r => setTimeout(r, 1000))
      }
      const ops = useCamStore.getState().project.setups.flatMap(s => s.operations)
      origWarn(`[probe] ${fileName}: ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      for (const o of ops) origWarn(`[probe]   ${o.name} (${o.type}): ${o.status} moves=${o.toolpathMoves?.length ?? 0} ${o.errorMessage ?? ''}`)
      for (const s of useCamStore.getState().project.setups) origWarn(`[probe]   setup ${s.name}: ${s.operations.map(o => `${o.name}=${o.status}`).join('; ')}`)
      for (const line of rawKept) origWarn(`[probe]   ${line}`)
      for (const [k, v] of [...warnCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) origWarn(`[probe]   ${v}x ${k}`)
      // EXAMPLE_PROBE_DUMP=<path.json>: write every op's moves so two builds can be diffed (dome-top bisect, 2026-08-20).
      if (planDumpPath) fs.writeFileSync(planDumpPath, JSON.stringify(planRequests))
      if (process.env.EXAMPLE_PROBE_DUMP) fs.writeFileSync(process.env.EXAMPLE_PROBE_DUMP, JSON.stringify(ops.map(o => ({ name: o.name, type: o.type, status: o.status, error: o.errorMessage ?? null, moves: o.toolpathMoves ?? [] }))))
      expect(ops.every(o => o.status === 'ready')).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})
