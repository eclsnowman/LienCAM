// WO-3197: file open -> store Generate -> postProject -> application reader.
// Only browser transport/cache seams are replaced; no engine or post is mocked.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { stockCheckCutters, toolpathPostCheck, type ToolpathPostIssue } from '../helpers/toolpathPostCheck'
import { ZDexelField } from '../../cam3d/stock'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { toWork } from '../../lib/program/coords'
import type { Project, ToolpathMove } from '../../types'
import type { GcodeWcs } from '../../lib/gcode/reader'

// Known product findings, each filed to its order. A listed row must STILL
// produce its issue: a fix that clears it turns this test red until the entry
// is removed. Any issue no entry claims stays a hard failure.
// WO-3204 (adaptive links over uncleared stock) cleared its entries.
interface KnownFinding { order: string; check: ToolpathPostIssue['check']; pattern: RegExp; what: string }
const KNOWN_FINDINGS: Record<string, readonly KnownFinding[]> = {}
const claims = (finding: KnownFinding, issue: ToolpathPostIssue) =>
  issue.check === finding.check && finding.pattern.test(issue.message)

const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const files = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.camproject')).sort()
const summary: Record<string, unknown>[] = []
const evidence = path.resolve('src/tests/evidence/WO-3197')
afterAll(() => fs.writeFileSync(path.join(evidence, 'example-coverage.json'), JSON.stringify(summary) + '\n'))

for (const file of files) {
  const saved = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'))
  const inventory: Project = saved.project ?? saved
  describe(file, () => {
    beforeAll(async () => {
      resetDocumentHolder()
      setDocumentStorage(new InMemoryDocumentStorage())
      const viewport = g.window!.__cncViewport
      delete g.window!.__cncViewport
      useCamStore.getState().newProject()
      await useCamStore.getState().loadProjectFromFile(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'))
      g.window!.__cncViewport = viewport
    })
    for (const [setupIndex, savedSetup] of inventory.setups.entries()) {
      // WO-096 oracle: one in-process stock per setup, replayed in program order
      // (the tests below run sequentially in the setup's operation order).
      let setupStock: ZDexelField | undefined
      for (const savedOp of savedSetup.operations) {
        it(`${savedSetup.name} / ${savedOp.name}: generated path and posted readback`, { timeout: 1_200_000 }, async () => {
          viewportSetup = setupIndex
          const setupId = savedSetup.id
          await useCamStore.getState().computeOperationToolpath(setupId, savedOp.id)
          const project = useCamStore.getState().project
          const setup = project.setups.find(s => s.id === setupId)!
          const op = setup.operations.find(o => o.id === savedOp.id)!
          const row: Record<string, unknown> = { file, setup: setup.name, operation: op.name, type: op.type,
            enabled: op.enabled, status: op.status, error: op.errorMessage, moves: op.toolpathMoves?.length ?? 0 }
          summary.push(row)
          expect(op.status, `${op.name}: ${op.errorMessage ?? ''}`).toBe('ready')
          expect(op.resolvedHeights, 'production resolved height snapshot').toBeDefined()
          const moves = op.toolpathMoves ?? []
          const planes = op.resolvedHeights!.machine
          row.planes = planes
          row.minimizeZTravel = op.heights.minimizeZTravel ?? true
          // The setup's proven stock block (world, as the moves) is the start;
          // each enabled operation's cutting moves are removed as they pass.
          const bounds = smartHeightStockBounds(project, setupProvenStockId(setup, project)!)
          expect(bounds, 'setup stock block').toBeTruthy()
          const fresh = () => ZDexelField.fromBox({ minX: bounds!.min.x, minY: bounds!.min.y, minZ: bounds!.min.z,
            maxX: bounds!.max.x, maxY: bounds!.max.y, maxZ: bounds!.max.z }, 0.2)
          const field = op.enabled ? (setupStock ??= fresh()) : fresh()
          const tool = useCamStore.getState().toolLibrary.find(t => t.id === op.toolId)
          expect(tool, 'operation tool').toBeDefined()
          row.stockCell = field.cell
          row.stockBounds = bounds
          // Post each real operation in isolation through the same production
          // selectedOpIds route as the dialog, without rewriting its parameters.
          const config = project.machine.controller === 'grbl' ? GRBL_CONFIG
            : project.machine.controller === 'linuxcnc' ? LINUXCNC_CONFIG : UCCNC_CONFIG
          const posted = postProject(project, [setup], config, {
            mode: 'separate', pauseBetweenSetups: false, baseName: 'wo3197', ext: 'nc',
            selectedOpIds: { [setup.id]: [op.id] },
          })
          row.postDiagnostics = posted.diagnostics
          const result = posted.files?.[0]?.result
          row.postOk = posted.ok
          // WO-3215: posted motion block counts, before/after evidence for the arc budget rule.
          const span = result?.ok ? result.operationSpans?.[0] : undefined
          const blocks = span ? result!.gcode.split('\n').slice(span.startLine - 1, span.endLine) : []
          let motion = -1, postedArcs = 0, postedLines = 0
          for (const line of blocks) {
            const g = line.match(/\bG0?([0-3])(?!\d)/)
            if (g) motion = Number(g[1])
            if (!/[XYZ]-?[\d.]/.test(line) || /\bG53\b/.test(line)) continue
            if (motion === 1) postedLines++
            else if (motion === 2 || motion === 3) postedArcs++
          }
          Object.assign(row, { postedArcs, postedLines })
          const wcs = `G${setup.wcs.fixtureOffset}` as GcodeWcs
          const transform = (m: ToolpathMove): ToolpathMove => {
            const point = toWork(m, setup.wcs)
            const center = m.cx === undefined || m.cy === undefined ? undefined
              : toWork({ x: m.cx, y: m.cy, z: m.z }, setup.wcs)
            return { ...m, ...point, ...(center ? { cx: center.x, cy: center.y } : {}) }
          }
          // One call, so the stock replays this operation exactly once.
          const issues = toolpathPostCheck({ moves, bottomZ: planes.bottom, stock: { field, ...stockCheckCutters(tool!) },
            ...(result?.ok && moves.length ? { posted: {
              gcode: result.gcode, sourceToWork: transform, lineRange: result.operationSpans?.[0],
              readerOptions: { dialect: config.id as 'uccnc' | 'grbl' | 'linuxcnc', sessionWcs: wcs,
                initialPosition: transform(moves[0]), machineDefinition: project.machine, machineUnits: 'mm',
                macroMCodes: 'report', workOffsets: { [wcs]: setup.wcs.origin } },
            } } : {}) })
          row.safetyIssues = issues
          row.rapidWitnesses = issues.filter(i => i.check === 'rapid').slice(0, 10).map(i => ({
            ...i, from: moves[(i.moveIndex ?? 0) - 1], to: moves[i.moveIndex ?? 0],
          }))
          const known = KNOWN_FINDINGS[`${file} / ${savedSetup.name} / ${savedOp.name}`] ?? []
          for (const finding of known) {
            expect(issues.some(issue => claims(finding, issue)),
              `${finding.order} (${finding.what}) no longer reproduces on ${op.name}: remove its KNOWN_FINDINGS entry`).toBe(true)
          }
          row.knownFindings = known.map(f => f.order)
          // Limit failure display; full diagnostics stay in coverage artifact.
          const unknown = issues.filter(issue => !known.some(finding => claims(finding, issue)))
          expect(unknown.slice(0, 10), `${file} / ${op.name}`).toEqual([])
          expect(posted.ok, JSON.stringify(posted.diagnostics)).toBe(true)
          expect(result?.ok).toBe(true)
        })
      }
    }
  })
}

it('every known finding names a shipped example operation', () => {
  const shipped = new Set(files.flatMap(file => {
    const saved = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'))
    const project: Project = saved.project ?? saved
    return project.setups.flatMap(setup => setup.operations.map(op => `${file} / ${setup.name} / ${op.name}`))
  }))
  expect(Object.keys(KNOWN_FINDINGS).filter(key => !shipped.has(key))).toEqual([])
})
