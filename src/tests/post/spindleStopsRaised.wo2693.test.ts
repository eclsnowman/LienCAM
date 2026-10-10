// WO-2693 acceptance: the spindle never stops with the tool low.
//
// The owner, 10-09: "Yes spindle should be at a raised height
// before turning off." Found in the 10-09 newcomer journey on Full Suite: a 3D
// rough ended at cutting depth and the post's next block (tool change or
// program end) ran M5 there.
//
// Every shipped example that opens through File Open is regenerated here
// through the production compute entry (the store's computeOperationToolpath,
// with the real toolpathWorker and the real cam3d dispatcher in-process - the
// same harness as _exampleGenerate.probe and the Smart Height V2 authority
// test), staged and posted per setup exactly as Post Process Export does
// (verifyModelReferences -> stageOperationsForEmission -> postProject), for
// GRBL and UCCNC.
//
// The bar: at every M5, M6 and M30 in the posted text, the tool's Z is at or
// above the clearance plane of the operation that last moved it. An
// operation's clearance plane is the highest Z at which its own moves make a
// horizontal rapid (its traverse plane), carried into the posted work frame by
// the offset between its last posted Z and its last move's Z. The post's own
// safe height is NOT the bar: the post travels between operations at the whole
// setup's highest Z, and an operation that ends on its own lower clearance
// plane (Full Suite's 3D Finish 3) is raised clear of the stock. Retract height
// is not in the posted text; clearance >= retract, so this bar is the stricter.
//
// Slow (every 3D op of every example): opt-in with WO2693_ACCEPT=1. Run one
// example per process to bound memory, e.g. (PowerShell):
//   $env:WO2693_ACCEPT='1'; $env:WO2693_ONLY='Full Suite'
//   npx vitest run src/tests/post/spindleStopsRaised.wo2693.test.ts --maxWorkers=1
// WO2693_ONLY=<substring> narrows to matching files; WO2693_DUMP_DIR=<dir>
// writes every posted program there (main-vs-branch text diffs).
// 10-09 record: main fails Full Suite (Setups 2 and 5, both dialects, combined)
// and 07 Relief medallion; the branch passes all 12 covered examples.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import { typedMock } from '../support/typedMock'

const ROOT = path.resolve(__dirname, '../../..')

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
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
  configurable: true,
})

const { useCamStore, smartHeightStockBounds } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const post = await import('../../lib/post')

// 2D families: the real toolpathWorker behind a Worker shim (heightScenario's
// pattern). Operations are computed one at a time, so one active shim suffices.
type Vec3 = { x: number; y: number; z: number }
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: WorkerResponseMsg) => void; onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
  Worker: unknown
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
// The rendered stock box (CNCViewport.getStockBounds): one stock's box, or the
// whole stock group's when no id is given.
// The node environment has no window: give the store the one viewport member it reads.
g.window ??= {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const ids = stockId !== undefined ? [stockId] : (project.stocks ?? []).map(s => s.id)
    const boxes = ids.map(id => smartHeightStockBounds(project, id)).filter((b): b is { min: Vec3; max: Vec3 } => b !== null)
    if (boxes.length === 0) return null
    return {
      min: { x: Math.min(...boxes.map(b => b.min.x)), y: Math.min(...boxes.map(b => b.min.y)), z: Math.min(...boxes.map(b => b.min.z)) },
      max: { x: Math.max(...boxes.map(b => b.max.x)), y: Math.max(...boxes.map(b => b.max.y)), z: Math.max(...boxes.map(b => b.max.z)) },
    }
  },
}
const workerScope = {
  postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
  onmessage: null as ((e: { data: WorkerRequestMsg }) => Promise<void>) | null,
}
g.self = workerScope
await import('../../lib/cam/toolpathWorker')
if (typeof workerScope.onmessage !== 'function') throw new Error('the real toolpathWorker did not install its handler')
g.Worker = class {
  onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(data: WorkerRequestMsg): void {
    activeShim = this
    void workerScope.onmessage!({ data })
  }
  terminate(): void { if (activeShim === this) activeShim = null }
}

// ---------------------------------------------------------------------------
// The posted-text bar
// ---------------------------------------------------------------------------

/** How many stops the reader judged, and how many it could not (no op had moved yet). */
const tally = { checked: 0, unjudged: 0 }

interface LowStop {
  line: number
  code: string
  z: number
  clearance: number
  opName: string
}

/** What the reader needs of one operation, in the operation's own (model) frame. */
interface OpFacts {
  name: string
  /** Highest Z of a horizontal rapid in the op's own moves (its traverse
   *  plane); undefined when it makes none. */
  traverseZ: number | undefined
  /** Z of the op's last move. */
  lastZ: number
}

function opFacts(name: string, moves: ReadonlyArray<{ type: string; x: number; y: number; z: number }>): OpFacts {
  let traverseZ: number | undefined
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    // The first move positions the tool from wherever the last op left it: horizontal.
    if (m.type !== 'rapid' || (i > 0 && m.x === moves[i - 1].x && m.y === moves[i - 1].y)) continue
    traverseZ = Math.max(traverseZ ?? -Infinity, m.z)
  }
  return { name, traverseZ, lastZ: moves[moves.length - 1]?.z ?? Number.NaN }
}

/** Every M5 / M6 / M30 at which the tool sits below the clearance plane of the
 *  operation that last moved it. `spans` index the program's lines. */
function lowSpindleStops(
  gcode: string,
  spans: ReadonlyArray<{ opId: string; startLine: number; endLine: number }>,
  facts: (opId: string) => OpFacts | undefined,
): LowStop[] {
  const lines = gcode.split('\n').map(raw => raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase())
  const spanAt = (i: number) => spans.find(s => i >= s.startLine && i < s.endLine)
  // Pass 1: the tool's Z after every line, and which lines move it.
  const zAfter: number[] = []
  const moves: boolean[] = []
  let z = Number.NaN
  let cycle = false
  for (const line of lines) {
    // A canned drilling cycle's Z word is the hole bottom, not where the tool
    // rests: between holes and after G80 it sits on the plane it started from.
    if (/\bG(?:73|8[1-9])\b/.test(line)) cycle = true
    const endsCycle = /\bG80\b/.test(line)
    if (endsCycle) cycle = false
    const zWord = cycle || endsCycle || /\bG53\b/.test(line) ? null : /\bZ(-?\d*\.?\d+)/.exec(line)
    if (zWord) z = Number(zWord[1])
    moves.push(!endsCycle && !/\bG53\b/.test(line) && (zWord !== null || /\b[XY]-?\d*\.?\d+/.test(line)))
    zAfter.push(z)
  }
  // Pass 2: judge each stop against the op whose span last moved the tool. Its
  // traverse plane is carried into the posted frame by the offset between where
  // the span ends (the op's last posted position) and the op's last move.
  let lastSpan: { opId: string; startLine: number; endLine: number } | undefined
  const out: LowStop[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue
    if (moves[i]) lastSpan = spanAt(i) ?? lastSpan
    for (const code of ['M5', 'M6', 'M30'] as const) {
      if (!new RegExp(`\\b${code.replace('M', 'M0*')}\\b`).test(line)) continue
      const op = lastSpan === undefined ? undefined : facts(lastSpan.opId)
      const postedEnd = lastSpan === undefined ? undefined : zAfter[lastSpan.endLine - 1]
      if (op?.traverseZ === undefined || postedEnd === undefined || !Number.isFinite(postedEnd)) { tally.unjudged++; continue }
      tally.checked++
      const bar = Number((op.traverseZ + (postedEnd - op.lastZ)).toFixed(3))
      if (!(zAfter[i] >= bar - 1e-3)) out.push({ line: i + 1, code, z: zAfter[i], clearance: bar, opName: op.name })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The examples
// ---------------------------------------------------------------------------

function exampleFiles(): string[] {
  const files: string[] = []
  const projectsDir = path.join(ROOT, 'Example Projects')
  for (const f of fs.readdirSync(projectsDir).filter(n => n.endsWith('.camproject')).sort()) files.push(path.join(projectsDir, f))
  const kits = path.join(ROOT, 'examples')
  for (const folder of fs.readdirSync(kits).filter(f => /^\d\d-/.test(f)).sort()) {
    for (const f of fs.readdirSync(path.join(kits, folder)).filter(n => n.endsWith('.camproject')).sort()) {
      const full = path.join(kits, folder, f)
      const project = JSON.parse(fs.readFileSync(full, 'utf8')) as { setups: Array<{ operations: Array<{ enabled?: boolean }> }> }
      // Modeling sources (no enabled operation) have nothing to post.
      if (project.setups.some(s => s.operations.some(o => o.enabled !== false))) files.push(full)
    }
  }
  const only = process.env.WO2693_ONLY
  // The knob (06) is NOT covered by default: generating its parallel finish in
  // this in-process harness kills the test worker (ERR_IPC_CHANNEL_CLOSED, 10-09).
  // Name it with WO2693_ONLY=06-knob to try it anyway.
  return only ? files.filter(f => f.includes(only)) : files.filter(f => !f.includes('06-knob-handwheel'))
}

const ACCEPT = process.env.WO2693_ACCEPT === '1'
const DUMP = process.env.WO2693_DUMP_DIR
const FILES = ACCEPT ? exampleFiles() : []

describe.skipIf(!ACCEPT)('WO-2693: the spindle stops only with the tool raised', () => {
  it.each(FILES.map(f => [path.relative(ROOT, f), f] as const))('%s', { timeout: 3_600_000 }, async (label, filePath) => {
    stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear()
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.getState().newProject()
    const origWarn = console.warn
    const origLog = console.log
    console.warn = () => {}
    console.log = () => {}
    const report: string[] = []
    tally.checked = 0; tally.unjudged = 0
    let programs = 0
    try {
      await useCamStore.getState().loadProjectFromFile(fs.readFileSync(filePath, 'utf8'))
      // Generate, one operation at a time, in setup order (rest roughs read their predecessors).
      for (const setup of useCamStore.getState().project.setups) {
        for (const op of setup.operations.filter(o => o.enabled !== false)) {
          await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
        }
      }
      const ops = useCamStore.getState().project.setups.flatMap(s => s.operations.filter(o => o.enabled !== false))
      const notReady = ops.filter(o => o.status !== 'ready').map(o => `${o.name}: ${o.status} ${o.errorMessage ?? ''}`)
      expect(notReady, `${label}: every operation generates`).toEqual([])

      // Generator level, frame-free: every operation ends on its own traverse plane.
      for (const op of ops) {
        const f = opFacts(op.name, op.toolpathMoves ?? [])
        if (f.traverseZ !== undefined && f.lastZ < f.traverseZ - 1e-6) {
          report.push(`generator ${op.name} (${op.type}) ends at z=${f.lastZ.toFixed(3)} below its traverse plane ${f.traverseZ.toFixed(3)}`)
        }
      }

      // Post every setup as Post Process Export does.
      await useCamStore.getState().verifyModelReferences()
      const restores: Array<() => void> = []
      try {
        for (const setup of useCamStore.getState().project.setups) {
          restores.push((await useCamStore.getState().stageOperationsForEmission(setup.id, undefined)).restore)
        }
        const state = useCamStore.getState()
        const project = { ...state.project, toolLibrary: state.toolLibrary }
        const factsById = new Map(project.setups.flatMap(s => s.operations)
          .map(o => [o.id, opFacts(o.name, o.toolpathMoves ?? [])] as const))
        for (const [dialect, config] of [['grbl', post.GRBL_CONFIG], ['uccnc', post.UCCNC_CONFIG]] as const) {
          for (const setup of project.setups) {
            if (!setup.operations.some(o => o.enabled !== false)) continue
            const result = post.postProject(project, [setup], config, {
              mode: 'separate', pauseBetweenSetups: false, baseName: project.name, ext: 'nc',
              modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad, programContext: true,
            })
            expect(result.ok, `${label} ${setup.name} ${dialect}: ${JSON.stringify(result.diagnostics)}`).toBe(true)
            const file = result.files![0].result
            programs++
            if (DUMP) {
              fs.mkdirSync(DUMP, { recursive: true })
              const stem = `${path.basename(filePath, '.camproject')}--${setup.name}--${dialect}`.replace(/[^A-Za-z0-9.-]+/g, '_')
              fs.writeFileSync(path.join(DUMP, `${stem}.nc`), file.gcode)
            }
            for (const low of lowSpindleStops(file.gcode, file.operationSpans ?? [], id => factsById.get(id))) {
              report.push(`posted ${setup.name} ${dialect}: line ${low.line} ${low.code} at Z${low.z} below ${low.opName}'s clearance Z${low.clearance}`)
            }
          }
          // The whole project as one program with an operator pause between
          // setups (the setup-boundary M5 + M0 route).
          const postable = project.setups.filter(s => s.operations.some(o => o.enabled !== false))
          if (postable.length > 1) {
            const combined = post.postProject(project, postable, config, {
              mode: 'combined', pauseBetweenSetups: true, baseName: project.name, ext: 'nc',
              modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad,
            })
            expect(combined.ok, `${label} combined ${dialect}: ${JSON.stringify(combined.diagnostics)}`).toBe(true)
            programs++
            if (DUMP) {
              const stem = `${path.basename(filePath, '.camproject')}--combined--${dialect}`.replace(/[^A-Za-z0-9.-]+/g, '_')
              fs.writeFileSync(path.join(DUMP, `${stem}.nc`), combined.combined!.gcode)
            }
            for (const low of lowSpindleStops(combined.combined!.gcode, combined.combined!.operationSpans ?? [], id => factsById.get(id))) {
              report.push(`posted combined ${dialect}: line ${low.line} ${low.code} at Z${low.z} below ${low.opName}'s clearance Z${low.clearance}`)
            }
          }
        }
      } finally { restores.reverse().forEach(restore => restore()) }
    } finally {
      console.warn = origWarn
      console.log = origLog
    }
    origLog(`[wo2693] ${label}: ${programs} programs, ${tally.checked} stops judged, ${tally.unjudged} unjudged: ${report.length === 0 ? 'PASS' : `FAIL\n  ${report.join('\n  ')}`}`)
    expect(report, label).toEqual([])
  })
})

// The cached-project route (WO-2693 round 2): a saved kit project whose stored
// 3D rough still ends at depth (generated before the generator fix; its
// generation fingerprint still matches, so nothing regenerates). Open, verify,
// stage and post exactly as Post Process Export and tools/examples/post-all.mjs
// do - no compute - and the post itself must lift before the spindle stops.
const STORED_KITS = [
  { file: 'examples/07-relief-medallion/relief-medallion.camproject', rough: '3D Rough 2' },
  { file: 'examples/06-knob-handwheel/knob-handwheel.camproject', rough: '3D Rough 1' },
]
describe('WO-2693: a stored path that ends at depth is lifted by the post', () => {
  it.each(STORED_KITS)('$file', { timeout: 600_000 }, async ({ file, rough }) => {
    stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear()
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.getState().newProject()
    const origWarn = console.warn
    const origLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      await useCamStore.getState().loadProjectFromFile(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      await useCamStore.getState().verifyModelReferences()
      const restores: Array<() => void> = []
      try {
        for (const setup of useCamStore.getState().project.setups) {
          const staged = await useCamStore.getState().stageOperationsForEmission(setup.id, undefined)
          restores.push(staged.restore)
        }
        const state = useCamStore.getState()
        const project = { ...state.project, toolLibrary: state.toolLibrary }
        // The stored path really is the old one: the rough still ends below its own plane.
        const roughOp = project.setups.flatMap(s => s.operations).find(o => o.name === rough)!
        const facts = opFacts(roughOp.name, roughOp.toolpathMoves ?? [])
        expect(facts.traverseZ, `${file}: ${rough} has a traverse plane`).toBeDefined()
        expect(facts.lastZ, `${file}: ${rough}'s stored path ends at depth (not regenerated)`).toBeLessThan(facts.traverseZ! - 1)
        const factsById = new Map(project.setups.flatMap(s => s.operations)
          .map(o => [o.id, opFacts(o.name, o.toolpathMoves ?? [])] as const))
        const lows: string[] = []
        for (const config of [post.GRBL_CONFIG, post.UCCNC_CONFIG]) {
          const result = post.postProject(project, project.setups, config, {
            mode: 'combined', pauseBetweenSetups: true, baseName: project.name, ext: 'nc',
            modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad,
          })
          expect(result.ok, `${file} ${config.id}: ${JSON.stringify(result.diagnostics)}`).toBe(true)
          const program = result.combined!
          if (DUMP) {
            fs.mkdirSync(DUMP, { recursive: true })
            fs.writeFileSync(path.join(DUMP, `stored--${path.basename(file, '.camproject')}--${config.id}.nc`), program.gcode)
          }
          tally.checked = 0
          for (const low of lowSpindleStops(program.gcode, program.operationSpans ?? [], id => factsById.get(id))) {
            lows.push(`${config.id}: line ${low.line} ${low.code} at Z${low.z} below ${low.opName}'s clearance Z${low.clearance}`)
          }
          expect(tally.checked, `${file} ${config.id}: stops judged`).toBeGreaterThan(0)
        }
        // WO2693_KIT_DIR=<dir>: write the shipped examples/gcode programs for this
        // kit exactly as tools/examples/post-all.mjs does (same Open -> stage ->
        // postProject combined route, same header line, all five dialects).
        const kitDir = process.env.WO2693_KIT_DIR
        if (kitDir) {
          const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
          const stem = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')
          const dialects = { uccnc: post.UCCNC_CONFIG, grbl: post.GRBL_CONFIG, grblhal: post.GRBLHAL_CONFIG, linuxcnc: post.LINUXCNC_CONFIG, generic: post.GENERIC_CONFIG }
          fs.mkdirSync(kitDir, { recursive: true })
          for (const [id, original] of Object.entries(dialects)) {
            const header = `LienCAM ${version} - ${project.name} - ${id}`
            const headerLine = original.capabilities.comment === 'semicolon' ? `; ${header}` : `(${header})`
            const config = { ...original, framing: { ...original.framing, programStart: [headerLine, ...original.framing.programStart] } }
            const result = post.postProject(project, project.setups, config, {
              mode: 'combined', pauseBetweenSetups: true, baseName: project.name, ext: 'nc',
              modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad,
            })
            expect(result.ok, `${file} ${id}`).toBe(true)
            fs.writeFileSync(path.join(kitDir, `${stem}-${id}.nc`), result.combined!.gcode)
          }
        }
        expect(lows, file).toEqual([])
      } finally { restores.reverse().forEach(restore => restore()) }
    } finally {
      console.warn = origWarn
      console.log = origLog
    }
  })
})

// The bar itself, on hand-written programs (always runs; milliseconds).
describe('WO-2693: the low-stop reader', () => {
  // Model z 30 is posted Z15: the work frame sits 15 below the model frame.
  const rough = [
    { type: 'rapid', x: 0, y: 0, z: 30 }, { type: 'rapid', x: 5, y: 0, z: 30 }, { type: 'rapid', x: 5, y: 0, z: 20 },
    { type: 'feed', x: 5, y: 0, z: 12 }, { type: 'feed', x: 10, y: 0, z: 12 },
  ]
  it('flags an M5 with the tool below the clearance of the op that last moved', () => {
    const gcode = ['G90', 'G54', '(Rough)', 'T1', 'M3 S10000', 'G0 X0 Y0 Z15', 'X5', 'Z5', 'G1 Z-3 F300', 'X10', 'M5', 'G0 Z15', 'M30'].join('\n')
    expect(lowSpindleStops(gcode, [{ opId: 'a', startLine: 2, endLine: 10 }], () => opFacts('Rough', rough)))
      .toEqual([{ line: 11, code: 'M5', z: -3, clearance: 15, opName: 'Rough' }])
  })
  it('passes an M5 after the op lifted to its own clearance plane', () => {
    const lifted = [...rough, { type: 'rapid', x: 10, y: 0, z: 30 }]
    const gcode = ['G90', 'G54', '(Rough)', 'T1', 'M3 S10000', 'G0 X0 Y0 Z15', 'X5', 'Z5', 'G1 Z-3 F300', 'X10', 'G0 Z15', 'M5', 'G0 Z15', 'M30'].join('\n')
    expect(lowSpindleStops(gcode, [{ opId: 'a', startLine: 2, endLine: 11 }], () => opFacts('Rough', lifted))).toEqual([])
  })
})
