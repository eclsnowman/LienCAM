// WO-3204: adaptive links and rapids never cross stock that is not yet cleared.
// Operator's WO-096 rule (src/cam3d/rough/traverseSafety.ts:4-9): travel below the travel
// height only where the code generator KNOWS the stock is cleared. Measured with WO-3197's
// oracle -- the shipped example file opened through the store, Generate on the real worker
// route, every traverse replayed against the production z-dexel stock (ZDexelField +
// removeSweep + maxTraverseIntrusion) in program order. Only browser transport/cache seams
// are replaced (the WO-3197 harness); no engine is mocked.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../../lib/stepCache'
import type { BrepModelPayload } from '../../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../../support/typedMock'

const EXAMPLES_DIR = path.resolve(__dirname, '../../../../Example Projects')

const stlBytes = new Map<string, ArrayBuffer>()
const stepBytes = new Map<string, ArrayBuffer>()
const stepDisplay = new Map<string, CachedStepDisplay>()
vi.mock('../../../lib/stlCache', () => typedMock<typeof import('../../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytes.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytes.delete(id) }),
}))
vi.mock('../../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/stepCache')>()
  return typedMock<typeof import('../../../lib/stepCache')>({
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

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../../store')
const { ensureClipperReady } = await import('../../../lib/cam/face2d/clipperOffset')
// The worker runs in-process: the store posts to a Worker shim that hands the request
// straight to toolpathWorker's onmessage, exactly as the browser would.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
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
await import('../../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) { activeShim = this; void workerSelf.onmessage?.({ data }) }
  terminate() { activeShim = null }
}
await ensureClipperReady()

import { stockCheckCutters, toolpathPostCheck } from '../../helpers/toolpathPostCheck'
import { ZDexelField } from '../../../cam3d/stock'
import type { ToolpathMove } from '../../../types'

const { resetDocumentHolder, setDocumentStorage } = await import('../../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../../doc/persist')

// The orders' witnesses: every adaptive operation WO-3197 found crossing standing stock.
const CASES: { file: string; setup: string; ops: string[] }[] = [
  { file: 'Adaptive Clearing Shapes.camproject', setup: 'GOOD corpus',
    ops: ['CommaSpiral', 'Kidney', 'SquareIsland', 'Tee', 'Bar', 'BootL', 'Triangle', 'Barbell', 'Boomerang']
      .map(shape => `Adaptive Clearing - ${shape}`) },
  // First operation of its setup: the setup stock is still the whole block.
  { file: 'Full Suite.camproject', setup: 'Setup 1', ops: ['Adaptive Clearing 1'] },
]
const record = process.env.WO3204_EVIDENCE
const rows: Record<string, unknown>[] = []

/** Stay-down motion: a non-cutting move that travels laterally below the clearance plane. */
function stayDownMoves(moves: readonly ToolpathMove[], clearanceZ: number): number {
  let n = 0
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i], p = moves[i - 1]
    if ((m.role === 'fast_traverse' || m.role === 'loop_back' || m.role === 'rapid' || m.type === 'rapid')
      && Math.hypot(m.x - p.x, m.y - p.y) > 1e-9 && Math.min(m.z, p.z) < clearanceZ - 1e-6) n++
  }
  return n
}

for (const { file, setup: setupName, ops } of CASES) {
  describe(`WO-3204 ${file}`, () => {
    let setupStock: ZDexelField | undefined
    beforeAll(async () => {
      resetDocumentHolder()
      setDocumentStorage(new InMemoryDocumentStorage())
      const viewport = g.window!.__cncViewport
      delete g.window!.__cncViewport
      useCamStore.getState().newProject()
      await useCamStore.getState().loadProjectFromFile(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'))
      g.window!.__cncViewport = viewport
    })
    for (const opName of ops) {
      it(`${setupName} / ${opName}: no link or rapid crosses uncleared stock`, { timeout: 1_200_000 }, async () => {
        const start = useCamStore.getState().project
        viewportSetup = start.setups.findIndex(s => s.name === setupName)
        const setupId = start.setups[viewportSetup].id
        const opId = start.setups[viewportSetup].operations.find(o => o.name === opName)!.id
        await useCamStore.getState().computeOperationToolpath(setupId, opId)
        const project = useCamStore.getState().project
        const setup = project.setups.find(s => s.id === setupId)!
        const op = setup.operations.find(o => o.id === opId)!
        expect(op.status, `${op.name}: ${op.errorMessage ?? ''}`).toBe('ready')
        const moves = op.toolpathMoves ?? []
        const planes = op.resolvedHeights!.machine
        // The listed operations run first and in order in their setup: one stock per setup.
        const bounds = smartHeightStockBounds(project, setupProvenStockId(setup, project)!)!
        setupStock ??= ZDexelField.fromBox({ minX: bounds.min.x, minY: bounds.min.y, minZ: bounds.min.z,
          maxX: bounds.max.x, maxY: bounds.max.y, maxZ: bounds.max.z }, 0.2)
        const tool = useCamStore.getState().toolLibrary.find(t => t.id === op.toolId)!
        const issues = toolpathPostCheck({ moves, bottomZ: planes.bottom, stock: { field: setupStock, ...stockCheckCutters(tool) } })
        const intrusions = issues.filter(i => i.check === 'rapid')
        const stayDown = stayDownMoves(moves, planes.clearance)
        rows.push({ file, setup: setupName, operation: opName, moves: moves.length,
          estimatedCutTimeMs: op.estimatedCutTimeMs, stayDownMoves: stayDown,
          intrusions: intrusions.length, witnesses: intrusions.slice(0, 5) })
        if (record) fs.writeFileSync(record, JSON.stringify(rows, null, 1) + '\n')
        expect(intrusions.slice(0, 5), `${file} / ${opName}`).toEqual([])
        expect(issues, `${file} / ${opName}`).toEqual([])
        // Stay-down stays wherever it is proven: the program still travels low.
        expect(stayDown, 'stay-down travel kept where the stock proves it').toBeGreaterThan(0)
      })
    }
  })
}
