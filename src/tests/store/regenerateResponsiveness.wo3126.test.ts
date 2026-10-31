// Production store and actual worker; controlled deliveries exercise lifecycle.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { projectOperationFingerprint } from '../../lib/cam/generationFingerprint'
import { ZDexelField } from '../../cam3d/stock/zdexel'
import { removeSweep } from '../../cam3d/stock/removeSweep'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOperationStockDomain, useCamStore } from '../../store'
import { buildFaceSmartHeightIntent } from '../../lib/cam/smartHeights'
import { offPageStockBackend } from '../../store/toolpathPostprocess'
import * as postprocess from '../../store/toolpathPostprocess'
import type { OperationStockInputs } from '../../lib/cam/operationStockAuthority'
import * as stockAuthority from '../../lib/cam/operationStockAuthority'
import { stockCutterOf } from '../../store/toolReachInputs'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { Project } from '../../types'
import { operationStockWorldFrame, stockCutsFromMoves, nextOperationStockChange } from '../../store/operationStockInputs'

// Keep the regression test installed during historical builds too. These
// additional API checks run only on the new source; the paired Generate tests
// below use production APIs present on both sources, with identical assertions.
const prepareStockCutsOffPage = Reflect.get(postprocess, 'prepareStockCutsOffPage')
const captureStockOffPage = Reflect.get(postprocess, 'captureStockOffPage')
const captureStock = Reflect.get(stockAuthority, 'captureStock')

const exactOracles = JSON.parse(readFileSync('src/tests/evidence/WO-3126/residual-oracles.json', 'utf8'))
const donor = JSON.parse(readFileSync('src/tests/evidence/WO-2694/journey-1009-scratch.camproject', 'utf8')) as Project
let requests: Extract<WorkerRequestMsg, { type: 'COMPUTE_FACE' }>[] = []
let instances: RealWorker[] = []
let hold = false
let active: RealWorker | undefined
const workerSelf = {
  onmessage: null as ((event: { data: WorkerRequestMsg }) => Promise<void>) | null,
  postMessage(data: WorkerResponseMsg) {
    if (hold && data.type !== 'TOOLPATH_PROGRESS') active!.terminal = data
    else active?.onmessage?.({ data })
  },
}
class RealWorker {
  onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
  onerror: ((error: ErrorEvent) => void) | null = null
  terminal?: WorkerResponseMsg
  terminated = false
  constructor() { instances.push(this) }
  postMessage(data: WorkerRequestMsg) {
    // A default Pocket predecessor also runs through the real worker; only Face requests are recorded.
    if (data.type === 'COMPUTE_FACE') requests.push(structuredClone(data))
    else if (data.type !== 'COMPUTE_POCKET') throw new Error('Expected production Face worker request')
    active = this
    void workerSelf.onmessage!({ data: structuredClone(data) })
  }
  terminate() { this.terminated = true }
  release(data = this.terminal!) { this.onmessage?.({ data }) }
}
beforeAll(async () => {
  vi.stubGlobal('self', workerSelf); vi.stubGlobal('Worker', RealWorker)
  await import('../../lib/cam/toolpathWorker')
})
beforeEach(() => {
  vi.stubEnv('LIENCAM_ENGINE', 'current')
  requests = []; instances = []; hold = false
  install()
})
afterEach(() => { vi.useRealTimers() })
afterAll(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs()

})
function install(edit?: (project: Project) => void) {
  const project = structuredClone(donor)
  const setup = project.setups[0], stock = project.stocks![0]
  const template = setup.operations.find(op => op.type === 'face')!
  project.geometry = []; project.modelItems = []; project.modelItemPlacements = []
  project.modelItemDocuments = undefined
  stock.mode = 'explicit'
  stock.bounds = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 16 },
    size: { x: 20, y: 20, z: 16 }, center: { x: 0, y: 0, z: 8 } }
  stock.position = { ...stock.bounds.min }
  project.sceneStock = { ...project.sceneStock, mode: 'fixed', autoStocks: [], fixedStocks: [{
    id: stock.id, name: stock.name, width: 20, height: 20, depth: 16, position: { ...stock.bounds.min },
  }] }
  setup.operations = ['prior', 'target'].map((id, i) => ({ ...structuredClone(template), id, name: id,
    params: { ...template.params, stockOffset: 2 },
    status: 'pending', toolpathMoves: undefined, generationFingerprint: undefined,
    resolvedHeights: undefined, resolvedHeightPlan: undefined,
    smartHeight: { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({ setupId: setup.id,
      stockId: stock.id, safetyIntent: template.heights.heightIntent!, mode: 'explicit_depth', explicitTargetWcsMm: i === 0 ? -2 : -5 }) },
  }))
  edit?.(project)
  useCamStore.setState({ project, toolLibrary: structuredClone(project.toolLibrary), toolpathBatch: null })
}
const setup = () => useCamStore.getState().project.setups[0]
const op = (id = 'target') => setup().operations.find(candidate => candidate.id === id)!
const generate = (id = 'target') => useCamStore.getState().computeOperationToolpath(setup().id, id)
const top = () => op().resolvedHeightPlan!.machining.materialStart.machineMm

const domain = () => getOperationStockDomain(setup().id, useCamStore.getState().project.stocks![0].id)
const request = () => { const d = domain(); return { beforeOperationId: d.finalOperationId, frame: d.frame, maxCellMm: Number.MAX_VALUE } }
async function tailReady() {
  const d = domain(), req = request()
  for (let count = 0; count < 100; count++) {
    const read = d.authority.readBefore(req)
    if (read.status === 'ready') return { ...d, read, req }
    if (read.status !== 'recomputing') throw new Error(JSON.stringify(read))
    await nextOperationStockChange(d.authority)
  }
  throw new Error('Stock did not settle')
}

describe('WO-3126 renderer stock preparation through production Generate', () => {
  it('lets a queued renderer timer run before stock preparation during Generate All', async () => {
    let timerRan = false
    const calls: boolean[] = []
    const create = offPageStockBackend.create
    const spy = vi.spyOn(offPageStockBackend, 'create').mockImplementation(initial => {
      calls.push(timerRan)
      return create(initial)
    })
    try {
      setTimeout(() => { timerRan = true }, 0)
      await useCamStore.getState().computeAllToolpaths()
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0], 'queued renderer timer must run before bulk stock preparation').toBe(true)
      expect(setup().operations.map(o => o.status)).toEqual(['ready', 'ready'])
      expect(requests.map(r => r.payload.opId)).toEqual(['prior', 'target'])
      expect(useCamStore.getState().toolpathBatch).toBeNull()
    } finally { spy.mockRestore() }
  })

  it('lets a queued renderer cancel callback stop remaining Generate jobs', async () => {
    const original = useCamStore.getState().project.id
    setTimeout(() => useCamStore.getState().newProject(), 0)
    await useCamStore.getState().computeAllToolpaths()
    expect(useCamStore.getState().project.id).not.toBe(original)
    expect(requests.some(r => r.payload.opId === 'target'), 'cancel callback must stop the stock-dependent target').toBe(false)
    expect(useCamStore.getState().toolpathBatch).toBeNull()
  })

  it('gives a queued batch entry renderer callback a turn before any planning dispatch', async () => {
    let callbackRan = false
    const dispatches: boolean[] = []
    const compute = useCamStore.getState().computeOperationToolpath
    useCamStore.setState({ computeOperationToolpath: (setupId, opId, batchId) => {
      dispatches.push(callbackRan)
      return compute(setupId, opId, batchId)
    } })
    try {
      setTimeout(() => { callbackRan = true }, 0)
      await useCamStore.getState().computeAllToolpaths()
      expect(dispatches.length).toBe(2)
      expect(dispatches[0], 'queued batch entry must yield before planning dispatch').toBe(true)
      expect(setup().operations.map(o => o.status)).toEqual(['ready', 'ready'])
    } finally { useCamStore.setState({ computeOperationToolpath: compute }) }
  })

  it('gives a settled predecessor renderer callback a turn before dependent batch dispatch', async () => {
    let callbackRan = false
    let scheduled = false
    let targetSawCallback = false
    const off = useCamStore.subscribe(state => {
      const operations = state.project.setups[0]?.operations
      if (!scheduled && operations?.[0]?.status === 'ready') {
        scheduled = true
        setTimeout(() => { callbackRan = true }, 0)
      }
    })
    const compute = useCamStore.getState().computeOperationToolpath
    useCamStore.setState({ computeOperationToolpath: (setupId, opId, batchId) => {
      if (opId === 'target') targetSawCallback = callbackRan
      return compute(setupId, opId, batchId)
    } })
    try {
      await useCamStore.getState().computeAllToolpaths()
      expect(scheduled).toBe(true)
      expect(targetSawCallback, 'settled predecessor callback must run before dependent dispatch').toBe(true)
      expect(setup().operations.map(o => o.status)).toEqual(['ready', 'ready'])
    } finally { off(); useCamStore.setState({ computeOperationToolpath: compute }) }
  })

  it('coalesces queued worker progress without losing phases, completion or terminal cleanup', async () => {
    hold = true
    const pending = generate('prior')
    await vi.waitFor(() => expect(instances.some(worker => worker.terminal)).toBe(true))
    const worker = instances.find(worker => worker.terminal)!
    let updates = 0
    const off = useCamStore.subscribe(state => {
      if (state.project.setups[0]?.operations[0]?.progressPhase === 'wo3126-burst') updates++
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const progress = (fraction: number, phase = 'wo3126-burst') => worker.release({
      type: 'TOOLPATH_PROGRESS', opId: 'prior', progress: fraction, phase,
    })
    try {
      for (let i = 1; i < 20; i++) progress(i / 20)
      expect(updates, 'queued progress must not flood renderer publications').toBe(1)
      clock.mockReturnValue(1_000_060)
      progress(0.96)
      expect(op('prior').progress).toBe(0.96)
      progress(0.98, 'wo3126-next-phase')
      expect(op('prior').progressPhase).toBe('wo3126-next-phase')
      progress(1, 'wo3126-next-phase')
      expect(op('prior').progress).toBe(1)
    } finally {
      clock.mockRestore(); off()
      worker.release()
      await pending
    }
    expect(op('prior').status).toBe('ready')
    progress(0.5, 'late obsolete progress')
    expect(op('prior').progress).toBeUndefined()
    expect(op('prior').progressPhase).toBeUndefined()
  })

  it('skips pure progress persistence while retaining authored and nested durable writes', async () => {
    await generate('prior')
    const history = useCamStore.getState().projectHistory.length
    const stringify = vi.spyOn(JSON, 'stringify')
    const durable = () => stringify.mock.calls.map(([value]) => value as { state?: { project?: { name?: string } }; version?: number })
      .filter(value => value?.state?.project && value.version !== undefined)
    let off = () => {}
    try {
      useCamStore.getState().updateOperation(setup().id, 'prior', { progress: 0.5, progressPhase: 'runtime phase' })
      expect(op('prior').progressPhase).toBe('runtime phase')
      expect(useCamStore.getState().projectHistory.length).toBe(history)
      expect(durable().length, 'pure progress must not serialize a durable snapshot').toBe(0)
      useCamStore.setState({ project: { ...useCamStore.getState().project, name: 'authored after progress' } })
      expect(durable().some(value => value.state!.project!.name === 'authored after progress')).toBe(true)
      stringify.mockClear()
      let nested = false
      off = useCamStore.subscribe(state => {
        if (nested || state.project.setups[0]?.operations[0]?.progress !== 0.75) return
        nested = true
        useCamStore.setState({ project: { ...state.project, name: 'nested authored write' } })
      })
      useCamStore.getState().updateOperation(setup().id, 'prior', { progress: 0.75, progressPhase: 'next runtime phase' })
      expect(nested).toBe(true)
      expect(durable().some(value => value.state!.project!.name === 'nested authored write')).toBe(true)
    } finally { off(); stringify.mockRestore() }
  })

  it('yields new-result witness preparation before publishing and drops cancellation during preparation', async () => {
    hold = true
    const pending = generate('prior')
    await vi.waitFor(() => expect(instances.some(worker => worker.terminal)).toBe(true))
    const worker = instances.find(worker => worker.terminal)!
    let timer = false
    let publishedAfterTimer = false
    const off = useCamStore.subscribe(state => {
      if (state.project.setups[0]?.operations[0]?.status === 'ready') publishedAfterTimer = timer
    })
    setTimeout(() => { timer = true }, 0)
    worker.release()
    await pending
    off()
    expect(publishedAfterTimer, 'new-result witness preparation must yield before ready publication').toBe(true)
    install()
    const again = generate('prior')
    await vi.waitFor(() => expect(instances.some(candidate => candidate !== worker && candidate.terminal)).toBe(true))
    instances.find(candidate => candidate !== worker && candidate.terminal)!.release()
    const replacement = structuredClone(donor)
    replacement.id = 'cancel-during-witness'
    replacement.setups = []
    useCamStore.getState().setProject(replacement)
    await again
    expect(useCamStore.getState().project.id).toBe(replacement.id)
    expect(useCamStore.getState().project.setups).toEqual([])
  })

  it('preserves exact geometry fingerprint bytes through raw edits and typed content', () => {
    const project = structuredClone(donor)
    const s = project.setups[0], operation = s.operations.find(o => o.resolvedHeights)!
    const fingerprint = () => projectOperationFingerprint(project, s, operation, operation.resolvedHeights!)
    const values: string[] = [fingerprint(), fingerprint()]
    const geometry = project.geometry[0]
    geometry.position.x += 0.125
    values.push(fingerprint())
    geometry.position.x -= 0.125
    values.push(fingerprint())
    Object.assign(geometry, { wo3126Raw: { data: new Float32Array([1, -0, NaN, Infinity]), array: [undefined, { z: -0, a: Infinity }] } })
    values.push(fingerprint(), fingerprint())
    const raw = Reflect.get(geometry, 'wo3126Raw')
    raw.data[0] = 2
    values.push(fingerprint())
    raw.data[0] = 1
    values.push(fingerprint())
    raw.array[1].extra = true
    values.push(fingerprint())
    delete raw.array[1].extra
    values.push(fingerprint())
    expect(values).toEqual(exactOracles.fingerprints)
    expect(values[0]).toBe(values[1])
    expect(values[2]).not.toBe(values[0])
    expect(values[3]).toBe(values[0])
    expect(values[4]).toBe(values[5])
    expect(values[6]).not.toBe(values[4])
    expect(values[7]).toBe(values[4])
    expect(values[8]).not.toBe(values[4])
    expect(values[9]).toBe(values[4])
  })

  it('preserves exact flat and ball sweep arrays, volume and update counts', () => {
    const results = []
    for (const kind of ['flat', 'ball'] as const) {
      const field = ZDexelField.fromBox({ minX: -3, minY: -3, minZ: -2, maxX: 8, maxY: 8, maxZ: 8 }, 0.2)
      const cutter = { kind, diameter: 4 }
      const moves = [
        { x0: -2, y0: 0, z0: 5, x1: 7, y1: 4, z1: 5 },
        { x0: 0, y0: 0, z0: 7, x1: 5, y1: 6, z1: -3 },
        { x0: 3, y0: 3, z0: 8, x1: 3, y1: 3, z1: -1 },
        { x0: 0, y0: 0, z0: 8, x1: 7, y1: 7, z1: 10 },
      ]
      const outcomes = [...moves, ...moves].map(move => removeSweep(field, move, cutter))
      results.push({ kind, outcomes, sha256: createHash('sha256').update(new Uint8Array(field.top.buffer)).digest('hex') })
    }
    expect(results).toEqual(exactOracles.sweeps)
    expect(results.every(r => r.outcomes.every(o => o.removedVolumeMm3 >= 0))).toBe(true)
  })

  it('preserves ordered moves, status, material and authoring undo on repeat Generate', async () => {
    await useCamStore.getState().computeAllToolpaths()
    const before = setup().operations.map(o => ({ id: o.id, status: o.status, moves: o.toolpathMoves, time: o.estimatedCutTimeMs }))
    const material = top()
    const history = useCamStore.getState().projectHistory.length
    requests = []
    await useCamStore.getState().computeAllToolpaths([setup().id])
    expect(setup().operations.map(o => ({ id: o.id, status: o.status, moves: o.toolpathMoves, time: o.estimatedCutTimeMs }))).toEqual(before)
    expect(top()).toBe(material)
    expect(requests.map(r => r.payload.opId)).toEqual(['prior', 'target'])
    // Exact old-source behavior: one terminal authoring snapshot per operation.
    expect(useCamStore.getState().projectHistory.length).toBe(history + 2)
    expect(useCamStore.getState().toolpathBatch).toBeNull()
  })

  it('invalidates same-count in-place and edit-away/edit-back moves on every stock route', async () => {
    await generate()
    const d = await tailReady()
    let notifications = 0
    const off = d.authority.subscribe(() => { notifications++ })
    const moves = op('prior').toolpathMoves!
    const index = moves.findIndex(m => m.role === 'cut')
    const old = moves[index].z
    moves[index].z = old + 0.5
    useCamStore.setState({ project: useCamStore.getState().project })
    moves[index].z = old
    useCamStore.setState({ project: useCamStore.getState().project })
    expect(d.authority.isCurrent(d.read.token)).toBe(false)
    expect(d.authority.exportSurface(d.read.token).status).toBe('unavailable')
    expect(d.authority.query(d.read.token, { kind: 'highest-material', frame: d.frame,
      bounds: { minX: -10, minY: -10, minZ: 0, maxX: 10, maxY: 10, maxZ: 16 } }).status).toBe('unavailable')
    expect(notifications).toBeGreaterThan(0)
    off()
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(top()).toBeCloseTo(14, 9)
    const current = await tailReady()
    expect(current.read.token).not.toBe(d.read.token)
    const x = moves[index].x
    moves[index].x = x + 1 // A query must inspect live bytes even without a store notification.
    expect(current.authority.isCurrent(current.read.token)).toBe(false)
    moves[index].x = x
    useCamStore.setState({ project: useCamStore.getState().project })
  })

  it('revokes internal scan reuse before a stock subscriber makes an unreported raw edit', async () => {
    await generate()
    const d = await tailReady()
    const moves = op('prior').toolpathMoves!
    const index = moves.findIndex(move => move.role === 'cut')
    let called = false
    let renewed = false
    const off = d.authority.subscribe(() => {
      if (called) return
      called = true
      const before = d.authority.readBefore(d.req)
      moves[index].x += 0.125
      const after = d.authority.readBefore(d.req)
      renewed = after.token !== before.token
    })
    try {
      moves[index].z += 0.25
      useCamStore.setState({ project: useCamStore.getState().project })
      expect(called).toBe(true)
      expect(renewed, 'raw edits inside subscriber callbacks must renew the content token').toBe(true)
      expect(d.authority.isCurrent(d.read.token)).toBe(false)
      expect(d.authority.exportSurface(d.read.token).status).toBe('unavailable')
    } finally { off() }
  })

  it('keeps an explicit empty ready result as verified zero removal', async () => {
    await generate('prior')
    op('prior').toolpathMoves = []
    useCamStore.setState({ project: useCamStore.getState().project })
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(top()).toBe(16)
  })

  it('drops prepared stock and late Generate results after project replacement', async () => {
    hold = true
    const pending = useCamStore.getState().computeAllToolpaths()
    await vi.waitFor(() => expect(instances.some(i => i.terminal)).toBe(true))
    const old = [...instances]
    const replacement = structuredClone(donor)
    replacement.id = 'wo3126-replacement'
    replacement.setups = []
    useCamStore.getState().setProject(replacement)
    old.forEach(worker => { if (worker.terminal) worker.release() })
    await pending
    expect(useCamStore.getState().project.id).toBe(replacement.id)
    expect(useCamStore.getState().project.setups).toEqual([])
    expect(useCamStore.getState().toolpathBatch).toBeNull()
  })

  it('cooperatively prepares exact ramp/arc/rotary cuts on no-worker hosts', async () => {
    const tool = useCamStore.getState().toolLibrary.find(t => t.id === op('prior').toolId)!
    const frame = operationStockWorldFrame('wo3126-conversion')
    const moves = [{ type: 'rapid' as const, x: 0, y: 0, z: 10 },
      { type: 'feed' as const, x: 5, y: 0, z: 8, role: 'cut' as const },
      { type: 'arc_ccw' as const, x: 5, y: 5, z: 8, cx: 2.5, cy: 2.5, role: 'cut' as const }]
    let timer = false
    setTimeout(() => { timer = true }, 0)
    expect(await prepareStockCutsOffPage(moves, stockCutterOf(tool), frame)).toEqual(stockCutsFromMoves(moves, tool, frame))
    expect(timer).toBe(true)
    const rotary = [...moves, { type: 'feed' as const, x: 0, y: 0, z: 8, a: 1 }]
    expect(await prepareStockCutsOffPage(rotary, stockCutterOf(tool), frame)).toEqual(stockCutsFromMoves(rotary, tool, frame))
  })

  it('retains exact authority keys with cooperative capture and waits for missing predecessors', async () => {
    const frame = operationStockWorldFrame('wo3126-keys')
    const input: OperationStockInputs = { projectEpoch: 'wo3126-keys', changeRevision: 1, setupId: 'setup', stockId: 'stock', frame,
      initial: { revision: 'block', bounds: { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 5, maxZ: 5 }, resolutionMm: 1, maxColumns: 100 },
      operations: [{ id: 'prior', enabled: true, stockId: 'stock', inputRevision: 'a', toolRevision: 'b', removal: { status: 'computing' } },
        { id: 'target', enabled: true, stockId: 'stock', inputRevision: 'a', toolRevision: 'b', removal: { status: 'missing' } }] }
    const req = { beforeOperationId: 'target', frame, maxCellMm: 1 }
    const expected = captureStock(input, req)
    const actual = await captureStockOffPage(input, req)
    expect(actual.key).toBe(expected.key)
    expect(actual.baseKey).toBe(expected.baseKey)
    expect(actual.waiting).toEqual(['prior'])
    expect(actual.problem).toEqual(expected.problem)
  })
})
