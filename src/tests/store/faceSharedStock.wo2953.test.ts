// Production store and actual worker; controlled deliveries exercise lifecycle.
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOperationStockDomain, useCamStore } from '../../store'
import { buildFaceSmartHeightIntent } from '../../lib/cam/smartHeights'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { ImportedGeometry, Operation, Project, Tool, ToolpathMove } from '../../types'
import { operationStockWorldFrame, stockCutsFromMoves } from '../../store/operationStockInputs'
import { createOperation } from '../../kernel/headless'
import { normalizePocketEntryForFillStrategy } from '../../lib/cam/pocketEntryPolicy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

const donor = JSON.parse(readFileSync('src/tests/evidence/WO-2694/journey-1009-scratch.camproject', 'utf8')) as Project
let requests: Extract<WorkerRequestMsg, { type: 'COMPUTE_FACE' }>[] = []
let instances: RealWorker[] = []
let hold = false
const captures: unknown[] = []
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
  if (process.env.WO2953_CAPTURE === '1') writeFileSync('src/tests/evidence/WO-2953/application.json', JSON.stringify({
    entry: 'useCamStore previewOperationSmartHeightPlan and computeOperationToolpath; real toolpathWorker',
    limits: 'Numeric project-world-mm application evidence; no hardware or tight clearance claim.', cases: captures }, null, 2) + '\n')
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
const preview = () => useCamStore.getState().previewOperationSmartHeightPlan(setup().id, op())
const generate = (id = 'target') => useCamStore.getState().computeOperationToolpath(setup().id, id)
const update = (id: string, patch: Partial<Operation>) => useCamStore.getState().updateOperation(setup().id, id, patch)
const top = () => op().resolvedHeightPlan!.machining.materialStart.machineMm

function rawOperations(transform: (ops: Operation[]) => Operation[]) {
  useCamStore.setState(s => ({ project: { ...s.project, setups: s.project.setups.map(item =>
    item.id === setup().id ? { ...item, operations: transform(item.operations) } : item) } }))
}

function rectangle(project: Project, id: string, bounds: number[], position = { x: 0, y: 0, z: 0 }, yaw = 0) {
  const [x0, y0, x1, y1] = bounds
  const geo = { id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf', loaded: true,
    stockId: project.stocks![0].id, position, rotation: { x: 0, y: 0, z: yaw },
    boundingBox: { min: { x: x0, y: y0, z: 0 }, max: { x: x1, y: y1, z: 0 },
      size: { x: x1 - x0, y: y1 - y0, z: 0 }, center: { x: (x0+x1)/2, y: (y0+y1)/2, z: 0 } },
    loops: [{ id: `${id}-loop`, layerId: id, closed: true, type: 'contour', points:
      [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }],
    layers2d: [{ id, name: id, color: '#fff', visible: true }],
  } as ImportedGeometry
  project.geometry.push(geo)
  return id
}
function region(op: Operation, id: string) {
  op.params = { ...op.params, boundarySource: 'geometry', geometryId: id, stockOffset: 0 }
}
function captureCase(name: string) {
  const project = useCamStore.getState().project
  captures.push({ name, projectId: project.id, stocks: structuredClone(project.stocks),
    geometry: structuredClone(project.geometry), setups: structuredClone(project.setups), requests: structuredClone(requests) })
}

describe('WO-2953 production Face shared stock', () => {
  it.each(['viewer-first', 'Face-first'] as const)('shares the live domain and rejects stale tokens with %s access', async order => {
    const stockId = useCamStore.getState().project.stocks![0].id
    const first = order === 'viewer-first' ? getOperationStockDomain(setup().id, stockId) : undefined
    const readSpy = first && vi.spyOn(first.authority, 'readBefore')
    const plan = await preview()
    const domain = getOperationStockDomain(setup().id, stockId)
    if (first) {
      expect(domain.authority).toBe(first.authority)
      expect(readSpy).toHaveBeenCalledWith(expect.objectContaining({ beforeOperationId: 'target', frame: domain.frame }))
      readSpy!.mockRestore()
    }
    // A second actual Face entry must use this authority even when Face created it.
    const spy = vi.spyOn(domain.authority, 'readBefore')
    expect((await preview()).machining.materialStart.machineMm).toBe(plan.machining.materialStart.machineMm)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ beforeOperationId: 'target', frame: domain.frame }))
    spy.mockRestore()
    expect(domain.finalOperationId).toBe('\u0000end-of-setup')
    expect(domain.frame.kind).toBe('world')
    const read = domain.authority.readBefore({ beforeOperationId: 'target', frame: domain.frame, maxCellMm: Number.MAX_VALUE })
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') throw new Error('Expected ready Face material')
    const query = { kind: 'highest-material' as const, frame: domain.frame,
      bounds: { minX: -10, minY: -10, minZ: 0, maxX: 10, maxY: 10, maxZ: 16 } }
    const material = domain.authority.query(read.token, query)
    expect(material.status).toBe('ready')
    if (material.status === 'ready') expect(material.value).toBeCloseTo(14, 9)
    const prior = op('prior')
    rawOperations(ops => ops.map(o => o.id === 'prior' ? { ...o, enabled: false } : o))
    rawOperations(ops => ops.map(o => o.id === 'prior' ? prior : o))
    expect(domain.authority.isCurrent(read.token)).toBe(false)
    expect(domain.authority.query(read.token, query).status).not.toBe('ready')
    await generate()
    await vi.waitFor(() => {
      const tail = domain.authority.readBefore({ beforeOperationId: domain.finalOperationId, frame: domain.frame, maxCellMm: Number.MAX_VALUE })
      expect(tail.status).toBe('ready')
      if (tail.status === 'ready') {
        const material = domain.authority.query(tail.token, query)
        expect(material.status).toBe('ready')
        if (material.status === 'ready') expect(material.value).toBeCloseTo(11, 9)
      }
    })
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(useCamStore.getState().project))
    const replacement = getOperationStockDomain(setup().id, stockId)
    expect(replacement.authority).not.toBe(domain.authority)
    expect(replacement.frame.projectEpoch).not.toBe(domain.frame.projectEpoch)
    expect(domain.authority.query(read.token, query).status).not.toBe('ready')
  })
  it('describes missing public stock domains', () => {
    expect(() => getOperationStockDomain('absent-setup', 'absent-stock')).toThrow("setup 'absent-setup' is unavailable")
    expect(() => getOperationStockDomain(setup().id, 'absent-stock')).toThrow("stock 'absent-stock' is unavailable")
  })
  it('computes missing predecessors in order and shares preview Top with the worker', async () => {
    const plan = await preview()
    expect(op('prior').status, op('prior').errorMessage).toBe('ready')
    expect(plan.machining.materialStart.machineMm).toBeCloseTo(14, 6)
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(top()).toBe(plan.machining.materialStart.machineMm)
    const artifact = op().resolvedHeightPlan!.machining.materialArtifact as unknown as { sourceFrame: { kind: string }; stockQuality: { capability: string; cellMm: number; maxVerticalOverRetentionMm: null } }
    expect(artifact.sourceFrame.kind).toBe('world')
    expect(artifact.stockQuality).toMatchObject({ capability: 'full-cell-upper-envelope-v1', cellMm: 0.5, maxVerticalOverRetentionMm: null })
    expect(useCamStore.getState().previewFaceSmartHeights(setup().id, op()).machine.top).toBe(top())
    captureCase('fully-faced-preview-and-worker')
    expect(op().resolvedHeights!.machine.bottom).toBe(11)
    expect(requests.map(request => request.payload.opId)).toEqual(['prior', 'target'])
    const request = requests.at(-1)!
    expect(request.type).toBe('COMPUTE_FACE')
    if (request.type === 'COMPUTE_FACE') expect(request.payload.heights.topHeight + setup().wcs.origin.z).toBe(top())
  })
  it.each(['suppress', 'remove', 'reorder'] as const)('rereads remaining material after raw %s', async action => {
    expect((await preview()).machining.materialStart.machineMm).toBeCloseTo(14, 6)
    rawOperations(ops => action === 'suppress' ? ops.map(o => o.id === 'prior' ? { ...o, enabled: false } : o)
      : action === 'remove' ? ops.filter(o => o.id !== 'prior') : [...ops].reverse())
    expect((await preview()).machining.materialStart.machineMm).toBe(16)
    await generate(); expect(top()).toBe(16)
  })
  it('never falls back to loaded stock when prior cuts already reach the target', async () => {
    update('prior', { smartHeight: { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({
      setupId: setup().id, stockId: useCamStore.getState().project.stocks![0].id,
      safetyIntent: op().heights.heightIntent!, mode: 'explicit_depth', explicitTargetWcsMm: -6 }) } })
    await generate('prior')
    await generate()
    expect(op('prior').status).toBe('ready')
    expect(op().status).toBe('error')
    expect(requests.map(request => request.payload.opId)).toEqual(['prior'])
    expect(op().toolpathMoves).toBeUndefined()
  })
  it('preserves failed upstream state without dispatching downstream cuts', async () => {
    update('prior', { status: 'error', errorMessage: 'controlled upstream error' })
    await expect(preview()).rejects.toThrow('controlled upstream error')
    await generate()
    expect(op().status).toBe('error'); expect(requests).toHaveLength(0)
    expect(op('prior').enabled).toBe(true)
  })
  it('keeps explicit user Top independent of failed upstream material', async () => {
    const intent = buildFaceSmartHeightIntent({ setupId: setup().id,
      stockId: useCamStore.getState().project.stocks![0].id, safetyIntent: op().heights.heightIntent!, mode: 'explicit_depth', explicitTargetWcsMm: -5 })
    intent.machining.start = { owner: { kind: 'user_override' }, value: { kind: 'explicit_plane',
      plane: { reference: 'stock_top', offsetMm: 0, owner: { kind: 'user_override' } } } }
    update('target', { smartHeight: { kind: 'smart_v2', intent } })
    update('prior', { status: 'error', errorMessage: 'unused' })
    await generate(); expect(op().status, op().errorMessage).toBe('ready'); expect(top()).toBe(16)
    expect(requests).toHaveLength(1)
  })
  it.each(['success', 'browser error', 'watchdog'] as const)('rejects a stale material token on delayed %s after ABA', async terminal => {
    await preview()
    vi.useFakeTimers(); hold = true
    const done = generate()
    await vi.waitFor(() => expect(instances.at(-1)?.terminal).toBeDefined())
    const worker = instances.at(-1)!
    const previous = op('prior')
    rawOperations(ops => ops.map(o => o.id === 'prior' ? { ...o, enabled: false } : o))
    rawOperations(ops => ops.map(o => o.id === 'prior' ? previous : o))
    if (terminal === 'success') worker.release()
    else if (terminal === 'browser error') worker.onerror?.({ message: 'controlled browser error' } as ErrorEvent)
    else await vi.advanceTimersByTimeAsync(180_000)
    await done
    expect(op().status).toBe('outdated')
    expect(op().toolpathMoves).toBeUndefined()
    expect(worker.terminated).toBe(true)
  })
  it.each(['current', 'both', 'kernel'] as const)('uses supported shared material on the %s engine', async engine => {
    vi.stubEnv('LIENCAM_ENGINE', engine)
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(top()).toBeCloseTo(14, 6)
    expect(requests.map(request => request.payload.opId)).toEqual(['prior', 'target'])
  })
  it('keeps a partly untouched region at its highest material', async () => {
    install(project => region(project.setups[0].operations[0], rectangle(project, 'left', [-20, -20, -4, 20])))
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(top()).toBe(16)
    captureCase('partly-untouched')
  })
  it('queries translated rotated geometry in world mm with a nonzero setup origin', async () => {
    install(project => {
      region(project.setups[0].operations[0], rectangle(project, 'left', [-20, -20, -4, 20]))
      region(project.setups[0].operations[1], rectangle(project, 'placed-target', [10, 0, 12, 2], { x: -8, y: -12, z: 0 }, 90))
      project.setups[0].wcs.xAxis = { x: 0, y: 1, z: 0 }
      project.setups[0].wcs.yAxis = { x: -1, y: 0, z: 0 }
    })
    const plan = await preview()
    expect(plan.machining.materialStart.machineMm).toBeCloseTo(14, 6)
    expect(plan.machining.materialStart.wcsMm).toBeCloseTo(-2, 6)
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    const request = requests.at(-1)!
    if (request.type !== 'COMPUTE_FACE') throw new Error('Expected Face payload')
    expect(request.payload.loops[0].points[0].x).toBeCloseTo(-8, 9)
    expect(request.payload.loops[0].points[0].y).toBeCloseTo(-2, 9)
    expect(op().resolvedHeights!.machine.bottom).toBe(11)
    captureCase('placed-region-world-mm')
  })
  it('keeps a real 0.1 mm residual wall between coarse sample centers', async () => {
    install(project => {
      const [left, target] = project.setups[0].operations
      const right = structuredClone(left); right.id = 'right'; right.name = 'right'
      region(left, rectangle(project, 'left-strip', [-20, -20, -0.05, 20]))
      region(right, rectangle(project, 'right-strip', [0.05, -20, 20, 20]))
      for (const prior of [left, right]) prior.params = { ...prior.params, boundaryContainment: 'inside', passAngle: 90 }
      region(target, rectangle(project, 'wall-region', [-0.4, -3, 0.4, 3]))
      project.setups[0].operations = [left, right, target]
    })
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(op('prior').status).toBe('ready'); expect(op('right').status).toBe('ready')
    expect(top(), 'an uncut 0.1 mm wall remains at the original top').toBe(16)
    captureCase('real-thin-wall')
  })
  // Fix round 2026-10-20: a ramp, an arc or a tool with no removal shape is
  // enclosed conservatively (never under-retained), so the Face generates.
  it.each(['arc', 'ramp', 'undercut'] as const)('encloses %s removal conservatively and generates', async kind => {
    await generate('prior')
    const prior = op('prior')
    if (kind === 'undercut') {
      useCamStore.setState(s => ({ toolLibrary: s.toolLibrary.map(tool => tool.id === prior.toolId
        ? { ...tool, type: 'dovetail_mill' as const } : tool) }))
    } else {
      const moves = structuredClone(prior.toolpathMoves!)
      const index = moves.findIndex((move, i) => i > 0 && move.role === 'cut' &&
        Math.hypot(move.x - moves[i - 1].x, move.y - moves[i - 1].y) > 1)
      const from = moves[index - 1], to = moves[index]
      if (kind === 'arc') {
        // A real minor CCW arc over the same chord: centre left of it, 5 chords away.
        const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy)
        Object.assign(to, { type: 'arc_ccw', cx: (from.x + to.x) / 2 - dy / length * 5 * length,
          cy: (from.y + to.y) / 2 + dx / length * 5 * length })
      }
      if (kind === 'ramp') to.z += 0.5
      rawOperations(ops => ops.map(o => o.id === 'prior' ? { ...o, toolpathMoves: moves } : o))
    }
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(op().toolpathMoves!.length).toBeGreaterThan(0)
    // Never below the 14 the prior really cut to; at most the uncut 16.
    expect(top()).toBeGreaterThanOrEqual(14)
    if (kind === 'ramp') expect(top()).toBeLessThanOrEqual(14.5)
    if (kind === 'undercut') expect(top(), 'a tool with no removal shape removes nothing').toBe(16)
    else expect(top()).toBeLessThan(16)
  })
  it('still refuses rotary removal: the stock turns under it', async () => {
    await generate('prior')
    const moves = structuredClone(op('prior').toolpathMoves!)
    moves[moves.findIndex(move => move.role === 'cut')].a = 10
    rawOperations(ops => ops.map(o => o.id === 'prior' ? { ...o, toolpathMoves: moves } : o))
    const count = requests.length
    await generate()
    expect(op().status).toBe('error')
    expect(op().errorMessage).toContain('rotary endpoint')
    expect(requests.slice(count).some(request => request.payload.opId === 'target')).toBe(false)
    expect(op().toolpathMoves).toBeUndefined()
  })
  // The New Operation dialog's Pocket: kernel defaults, then the dialog's own
  // entry policy for the fill (inside-out -> Helix, outside-in -> Profile Ramp).
  it.each([['inside_out', 'ramp_helical'], ['outside_in', 'ramp_linear']] as const)(
    'generates a Face after a default %s Pocket with its default %s entry', async (fill, entry) => {
      install(project => {
        const template = project.setups[0].operations[0]
        const pocketId = rectangle(project, 'pocket-sketch', [-5, -4, 5, 4])
        const pocket = createOperation('pocket_2d', { id: 'prior', name: 'Pocket', toolId: template.toolId },
          { params: { geometryId: pocketId, fillStrategy: fill, stayDown: fill === 'outside_in' } })
        pocket.linking.entryType = normalizePocketEntryForFillStrategy(fill, pocket.linking.entryType)
        pocket.smartHeight = smartHeightAuthorityFixture('pocket_2d', { setupId: project.setups[0].id,
          heights: pocket.heights, params: pocket.params, geometryIds: [pocketId], stockId: project.stocks![0].id })
        project.setups[0].operations[0] = pocket
      })
      expect(op('prior').linking.entryType).toBe(entry)
      await generate('prior')
      expect(op('prior').status, op('prior').errorMessage).toBe('ready')
      const moves = op('prior').toolpathMoves!
      expect(moves.some((move, i) => i > 0 && move.type !== 'rapid' && Math.abs(move.z - moves[i - 1].z) > 1e-6 &&
        (move.type !== 'feed' || Math.hypot(move.x - moves[i - 1].x, move.y - moves[i - 1].y) > 1e-6)),
      'the Pocket really enters with XY+Z motion (ramp or helix)').toBe(true)
      await generate()
      expect(op().status, op().errorMessage).toBe('ready')
      expect(op().toolpathMoves!.length).toBeGreaterThan(0)
      // The Face region spans the whole 16 mm block; the pocket leaves its rim.
      expect(top()).toBe(16)
      captureCase(`default-${fill}-pocket-then-face`)
    })
  // Fix-round audit: identity keys must never touch lists built per call, or
  // every store write renews the revision and a setup of 65+ operations never settles.
  it('keeps a setup of more than 64 operations current across store writes', async () => {
    install(project => {
      const [prior, target] = project.setups[0].operations
      const parked = Array.from({ length: 70 }, (_, i) => ({ ...structuredClone(prior), id: `parked-${i}`, name: `parked-${i}`, enabled: false }))
      project.setups[0].operations = [prior, ...parked, target]
    })
    await generate('prior')
    expect(op('prior').status, op('prior').errorMessage).toBe('ready')
    await generate()
    expect(op().status, op().errorMessage).toBe('ready')
    expect(op('prior').status).toBe('ready')
    expect(top()).toBeCloseTo(14, 6)
  })
  it('excludes explicitly different stock and rejects unresolved membership', async () => {
    install(project => {
      const id = rectangle(project, 'other', [-10, -10, 10, 10])
      project.geometry[0].stockId = 'other-stock'
      const other = structuredClone(project.stocks![0]); other.id = 'other-stock'; project.stocks!.push(other)
      region(project.setups[0].operations[0], id)
      project.setups[0].operations[0].status = 'error'
    })
    await generate(); expect(op().status, op().errorMessage).toBe('ready'); expect(top()).toBe(16)
    expect(requests.map(request => request.payload.opId)).toEqual(['target'])
    rawOperations(ops => ops.map(o => o.id === 'prior' ? { ...o, params: { ...o.params, geometryId: 'missing' } } : o))
    await expect(preview()).rejects.toThrow('ownership is unresolved')
  })
  it('does not fabricate a Top outside the stock', async () => {
    install(project => region(project.setups[0].operations[1], rectangle(project, 'outside', [100, 100, 105, 105])))
    await generate()
    expect(op().status).toBe('error')
    expect(op().errorMessage).toContain('No remaining material intersects')
    expect(requests.map(request => request.payload.opId)).toEqual(['prior'])
  })
  it('coalesces simultaneous preview and generation prerequisites', async () => {
    const [plan] = await Promise.all([preview(), generate()])
    expect(op().status, op().errorMessage).toBe('ready')
    expect(top()).toBe(plan.machining.materialStart.machineMm)
    expect(requests.filter(request => request.payload.opId === 'prior')).toHaveLength(1)
  })
  it('does not restart a cancelled predecessor or publish downstream cuts', async () => {
    hold = true
    const priorDone = generate('prior')
    await vi.waitFor(() => expect(instances[0]?.terminal).toBeDefined())
    const done = generate()
    update('prior', { passes: { ...op('prior').passes, stepover: 1 } })
    instances[0].release(); await priorDone; await done
    expect(op('prior').status).toBe('outdated')
    expect(op().status).toBe('error')
    expect(requests.map(request => request.payload.opId)).toEqual(['prior'])
  })
  it('rejects late completion after same-ID project reload', async () => {
    await preview(); hold = true
    const done = generate()
    await vi.waitFor(() => expect(instances.at(-1)?.terminal).toBeDefined())
    const worker = instances.at(-1)!
    const saved = JSON.stringify(useCamStore.getState().project)
    await useCamStore.getState().loadProjectFromFile(saved)
    const replacement = structuredClone(op())
    worker.release(); await done
    expect(op()).toEqual(replacement)
    expect(op().status).not.toBe('computing')
  })
  it('invalidates a pending result across undo and redo', async () => {
    await preview(); hold = true
    const done = generate()
    await vi.waitFor(() => expect(instances.at(-1)?.terminal).toBeDefined())
    const worker = instances.at(-1)!
    update('prior', { enabled: false })
    useCamStore.getState().undo()
    useCamStore.getState().redo()
    worker.release(); await done
    expect(op().status).not.toBe('ready')
    expect(op().toolpathMoves).toBeUndefined()
  })

  it('retains the ball footprint upper envelope', async () => {
    install(project => { project.toolLibrary.find(tool => tool.id === project.setups[0].operations[0].toolId)!.type = 'ball_end_mill' })
    const plan = await preview()
    expect(op('prior').status, op('prior').errorMessage).toBe('ready')
    expect(plan.machining.materialStart.machineMm).toBeGreaterThan(14)
    expect(plan.machining.materialStart.machineMm).toBeLessThan(16)
    captureCase('ball-upper-envelope')
  })
  it('declares effective cell size and coarsening rather than a tight clearance certificate', async () => {
    install(project => {
      project.setups[0].operations.shift()
      const stock = project.stocks![0]
      stock.position = { x: 0, y: 0, z: 0 }
      stock.bounds.size = { x: 1000, y: 1000, z: 16 }
    })
    const plan = await preview()
    const artifact = plan.machining.materialArtifact as unknown as { stockQuality: { cellMm: number; warnings: string[]; maxVerticalOverRetentionMm: null } }
    expect(artifact.stockQuality.cellMm).toBeGreaterThan(0.5)
    expect(artifact.stockQuality.warnings.join(' ')).toContain('coarsening')
    expect(artifact.stockQuality.maxVerticalOverRetentionMm).toBeNull()
    expect(requests).toHaveLength(0)
  })
  it.each(['tool', 'geometry', 'placement', 'setup', 'stock', 'target'] as const)('rejects pending publication after %s edit-away/back', async kind => {
    await preview(); hold = true
    const done = generate()
    await vi.waitFor(() => expect(instances.at(-1)?.terminal).toBeDefined())
    const worker = instances.at(-1)!
    const original = useCamStore.getState()
    const changed = structuredClone(original.project)
    if (kind === 'tool') useCamStore.setState({ toolLibrary: original.toolLibrary.map(tool => ({ ...tool, diameter: tool.diameter + 1 })) })
    else {
      if (kind === 'geometry') rectangle(changed, 'new-part', [0, 0, 1, 1])
      if (kind === 'placement') changed.modelItemPlacements = [{ modelItemId: 'part', position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 } }]
      if (kind === 'setup') changed.setups[0].wcs.origin.z += 1
      if (kind === 'stock') changed.stocks![0].bounds.size.z += 1
      if (kind === 'target') changed.setups[0].operations[1].passes.stepover += 1
      useCamStore.setState({ project: changed })
    }
    useCamStore.setState({ project: original.project, toolLibrary: original.toolLibrary })
    worker.release(); await done
    expect(op().status).toBe('outdated')
    expect(op().toolpathMoves).toBeUndefined()
  })

  it('recomputes a dependent result after equal-count upstream move edits', async () => {
    await generate()
    expect(op().status).toBe('ready')
    const last = structuredClone(op()); last.id = 'last'; last.name = 'last'; last.status = 'pending'
    last.toolpathMoves = undefined; last.generationFingerprint = undefined
    last.smartHeight = { kind: 'smart_v2', intent: buildFaceSmartHeightIntent({ setupId: setup().id,
      stockId: useCamStore.getState().project.stocks![0].id, safetyIntent: last.heights.heightIntent!,
      mode: 'explicit_depth', explicitTargetWcsMm: -7 }) }
    rawOperations(ops => [...ops, last])
    const moves = structuredClone(op('prior').toolpathMoves!)
    const index = moves.findIndex(move => move.role === 'cut')
    moves[index].x += 0.1 // Same length and saved depth; new removal content.
    rawOperations(ops => ops.map(o => o.id === 'prior' ? { ...o, toolpathMoves: moves } : o))
    const domain = getOperationStockDomain(setup().id, useCamStore.getState().project.stocks![0].id)
    expect(domain.authority.readBefore({ beforeOperationId: 'last', frame: domain.frame,
      maxCellMm: Number.MAX_VALUE })).toMatchObject({ status: 'recomputing', waitingFor: ['target'] })
    await generate('last')
    expect(op('last').status, op('last').errorMessage).toBe('ready')
    expect(requests.filter(request => request.payload.opId === 'target')).toHaveLength(2)
  })

})

// Every enclosed sweep must sit inside the real cutter somewhere on the real
// path: horizontal offset h <= R - R' and its tip (flat) or ball centre no lower.
// That is sufficient for the whole upward-open body (see stockCutsFromMoves).
describe('WO-2953 conservative removal never exceeds the real cut', () => {
  const frame = operationStockWorldFrame('enclosure')
  const flat = { id: 'f', name: 'flat 6', type: 'flat_end_mill', diameter: 6 } as Tool
  const ball = { id: 'b', name: 'ball 6', type: 'ball_end_mill', diameter: 6 } as Tool
  const start = { type: 'feed', x: 0, y: 0, z: 10, role: 'cut' } as ToolpathMove
  type Path = (t: number) => { x: number; y: number; z: number }
  const cases: [string, ToolpathMove, Path][] = [
    ['ramp', { type: 'feed', x: 20, y: 5, z: 7, role: 'cut' }, t => ({ x: 20 * t, y: 5 * t, z: 10 - 3 * t })],
    ['cw arc', { type: 'arc_cw', x: 10, y: 0, z: 10, cx: 5, cy: 0, role: 'cut' },
      t => ({ x: 5 - 5 * Math.cos(Math.PI * t), y: 5 * Math.sin(Math.PI * t), z: 10 })],
    ['ccw helix', { type: 'arc_ccw', x: 0, y: 8, z: 8, cx: 0, cy: 4, role: 'cut' },
      t => ({ x: 4 * Math.sin(Math.PI * t), y: 4 - 4 * Math.cos(Math.PI * t), z: 10 - 2 * t })],
  ]
  it.each(cases.flatMap(([name, move, path]) => [flat, ball].map(tool => [name, tool.type, move, path, tool] as const)))(
    '%s with a %s', (_name, _type, move, path, tool) => {
      const cuts = stockCutsFromMoves([start, move], tool, frame)
      if (typeof cuts === 'string') throw new Error(cuts)
      expect(cuts.length).toBeGreaterThan(1)
      const R = tool.diameter / 2
      const real = Array.from({ length: 20001 }, (_, k) => path(k / 20000))
      for (const cut of cuts) {
        const Rc = cut.cutter.diameter / 2
        expect(cut.cutter.kind).toBe(tool.type === 'ball_end_mill' ? 'ball' : 'flat')
        for (let k = 0; k <= 20; k++) {
          const u = k / 20, m = cut.move
          const p = { x: m.x0 + (m.x1 - m.x0) * u, y: m.y0 + (m.y1 - m.y0) * u, z: m.z0 + (m.z1 - m.z0) * u }
          const lift = tool.type === 'ball_end_mill' ? Rc - R : 0 // compare ball centres, flat tips
          const ok = real.some(q => Math.hypot(p.x - q.x, p.y - q.y) <= R - Rc + 2e-3 && p.z + lift >= q.z - 1e-9)
          expect(ok, `${JSON.stringify(p)} r=${Rc}`).toBe(true)
        }
      }
    })
  it('removes nothing for a tool with no removal shape, an arc without a centre, or a first cut with no start', () => {
    expect(stockCutsFromMoves([start, cases[0][1]], { ...flat, type: 'v_bit' } as Tool, frame)).toEqual([])
    expect(stockCutsFromMoves([start, { ...cases[1][1], cx: undefined }], flat, frame)).toEqual([])
    expect(stockCutsFromMoves([start], flat, frame)).toEqual([])
  })
})
