// WO-3001 - the pattern operation through the production entry points (WO-2962
// PLAN Phase B). A shipped example (05 name sign) opens through File Open; the
// PLAN sec. 6 rose spiral is added through the command layer
// (executeCamCommands -> prepareCamCommands), generated through the store's
// computeOperationToolpath and the real toolpathWorker, posted as Post Process
// Export does (stageOperationsForEmission -> postProject), then saved and
// reopened. The independent truth for the moves is the pattern library itself
// (buildPatternToolpath, WO-2982), called directly with the same spec, tool and
// stock-top plane.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { Operation, Tool } from '../../types'
import type { OperationHeightIntentV2 } from '../../lib/cam/smartHeights'

const ROOT = path.resolve(__dirname, '../../..')
const SIGN = path.join(ROOT, 'examples/05-name-sign/name-sign.camproject')

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

const { useCamStore, smartHeightStockBounds, setupProvenStockId, snapshotCurrentProjectFile } = await import('../../store')
const post = await import('../../lib/post')
const { buildPatternToolpath } = await import('../../lib/cam/pattern2d')
const { buildPatternSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeights, defaultPasses, defaultLinking } = await import('../../kernel/parameterDefaults')

// The real toolpathWorker behind a Worker shim (spindleStopsRaised.wo2693's harness).
type Vec3 = { x: number; y: number; z: number }
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: WorkerResponseMsg) => void; onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
  Worker: unknown
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
const posted: WorkerRequestMsg[] = []
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
  postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: structuredClone(m) }) },
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
    posted.push(structuredClone(data))
    void workerScope.onmessage!({ data: structuredClone(data) })
  }
  terminate(): void { if (activeShim === this) activeShim = null }
}

/** PLAN sec. 6, anchored at the sign's profile centroid, clipped to nothing. */
const ROSE_SPEC = {
  version: 1, units: 'mm', anchor: 'region-centroid', depth: 0.15, chordTol: 0.005,
  curves: [{
    kind: 'polar', r: '(r0 - pitch * t / 360) * (1 + amp * sin(lobes * t))', t: [0, 5400],
    params: [
      { name: 'r0', value: 27.5, length: true }, { name: 'pitch', value: 1.6, length: true },
      { name: 'amp', value: 0.02, length: false }, { name: 'lobes', value: 9, length: false },
    ],
  }],
}

function ballFrom(template: Tool): Tool {
  return {
    ...structuredClone(template), id: 'wo3001-ball-3', name: 'D3 ball', type: 'ball_end_mill', diameter: 3,
    fluteLength: 10, cornerRadius: 1.5, toolNumber: 3,
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300, depthOfCut: 0.15, stepover: 1 } },
  }
}

async function openSign() {
  await useCamStore.getState().loadProjectFromFile(fs.readFileSync(SIGN, 'utf8'))
  const state = useCamStore.getState()
  const setup = state.project.setups[0]
  const profile = state.project.geometry.find(geo => geo.name === 'profile')!
  const ball = ballFrom(state.toolLibrary[0])
  useCamStore.setState(s => ({ toolLibrary: [...s.toolLibrary, ball] }))
  return { setup, profile, ball, stockId: setupProvenStockId(setup, state.project)! }
}

function patternOperation(setupId: string, stockId: string, geometryId: string, toolId: string, spec: unknown = ROSE_SPEC): Operation {
  return {
    id: 'wo3001-rose', name: 'Rose spiral', type: 'pattern', enabled: true, status: 'pending',
    toolId, geometrySelections: [],
    heights: structuredClone(defaultHeights), passes: structuredClone(defaultPasses), linking: structuredClone(defaultLinking),
    params: { geometryId, loopIds: [], spec: structuredClone(spec) },
    smartHeight: { kind: 'smart_v2', intent: buildPatternSmartHeightIntent({
      setupId, safetyIntent: defaultHeights.heightIntent!, stockId, depthMm: 0.15,
    }) },
  }
}

const liveOp = (id: string) => useCamStore.getState().project.setups.flatMap(s => s.operations).find(op => op.id === id)!

/** Feed moves (G1/G2/G3) inside an operation's posted span, in the work frame.
 *  The post fits arcs to the polyline, so an arc carries its centre (I/J). */
interface PostedFeed { kind: 'line' | 'cw' | 'ccw'; from: { x: number; y: number }; x: number; y: number; z: number; cx?: number; cy?: number }
function postedFeeds(gcode: string, span: { startLine: number; endLine: number }): PostedFeed[] {
  const lines = gcode.split('\n').slice(span.startLine - 1, span.endLine)
  const out: PostedFeed[] = []
  let x = NaN, y = NaN, z = NaN, motion = ''
  for (const raw of lines) {
    const line = raw.replace(/\(.*?\)|;.*/g, '').trim().toUpperCase()
    const word = (k: string) => { const m = line.match(new RegExp(`${k}(-?\\d*\\.?\\d+)`)); return m ? Number(m[1]) : undefined }
    const gm = line.match(/\bG0?([0-3])\b/)
    if (gm) motion = gm[1]
    const nx = word('X'), ny = word('Y'), nz = word('Z')
    if (nx === undefined && ny === undefined && nz === undefined) continue
    const from = { x, y }
    x = nx ?? x; y = ny ?? y; z = nz ?? z
    if (motion === '1') out.push({ kind: 'line', from, x, y, z })
    if (motion === '2' || motion === '3') {
      out.push({ kind: motion === '2' ? 'cw' : 'ccw', from, x, y, z, cx: from.x + (word('I') ?? 0), cy: from.y + (word('J') ?? 0) })
    }
  }
  return out
}

/** Distance from p to the polyline. */
function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y)
}

function polylineDistance(p: { x: number; y: number }, pts: Array<{ x: number; y: number }>): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segmentDistance(p, pts[i - 1], pts[i]))
  return best
}

describe('WO-3001 pattern operation through the app', () => {
  it('adds through the command layer, generates through the worker, posts the library moves, and survives save/reopen', async () => {
    const { setup, profile, ball, stockId } = await openSign()
    const op = patternOperation(setup.id, stockId, profile.id, ball.id)

    // 1. The command layer (the same transaction scripted callers get).
    const added = useCamStore.getState().executeCamCommands([{ kind: 'operation.add', setupId: setup.id, operation: op }])
    expect(added.ok).toBe(true)
    expect(liveOp(op.id).type).toBe('pattern')

    // 2. Generate through the store and the real worker dispatch.
    posted.length = 0
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    const ready = liveOp(op.id)
    expect(ready.errorMessage).toBeUndefined()
    expect(ready.status).toBe('ready')
    expect(posted.map(m => m.type)).toEqual(['COMPUTE_PATTERN'])
    const request = posted[0] as Extract<WorkerRequestMsg, { type: 'COMPUTE_PATTERN' }>

    // The independent truth: the library itself, with the stock top as the
    // top of cut (stock 0..6 mm, WCS Z0 on the stock top) and the profile's
    // closed loop as the region.
    const stock = smartHeightStockBounds(useCamStore.getState().project, stockId)!
    const wcs = setup.wcs.origin
    expect(request.payload.heights.topHeight).toBeCloseTo(stock.max.z - wcs.z, 9)
    const region = (profile.loops ?? []).filter(loop => loop.closed)
    expect(region.length).toBeGreaterThan(0)
    const truth = buildPatternToolpath({
      spec: ROSE_SPEC, tool: ball, heights: request.payload.heights, wcsOrigin: wcs,
      region: request.payload.loops.filter(loop => loop.closed).map(loop => loop.points),
      spindleRpm: 18000,
    })
    expect(ready.toolpathMoves).toEqual(truth.moves)
    const cuts = truth.moves.filter(m => m.role === 'cut')
    expect(cuts.length).toBeGreaterThan(2500)
    // Every cut 0.15 mm below the stock top (C4); one plunge, nothing rapids below retract (C5).
    for (const m of cuts) expect(m.z).toBeCloseTo(stock.max.z - 0.15, 9)
    expect(truth.moves.filter(m => m.role === 'plunge')).toHaveLength(1)
    const retractZ = wcs.z + request.payload.heights.retractHeight
    for (const m of truth.moves.filter(m => m.type === 'rapid')) expect(m.z).toBeGreaterThanOrEqual(retractZ - 1e-9)

    // 3. Post as Post Process Export does; the op's G1 words are the library's cuts.
    await useCamStore.getState().verifyModelReferences()
    const staged = await useCamStore.getState().stageOperationsForEmission(setup.id, undefined)
    let gcode: string
    let span: { startLine: number; endLine: number } | undefined
    try {
      const state = useCamStore.getState()
      const project = { ...state.project, toolLibrary: state.toolLibrary }
      const live = project.setups.find(s => s.id === setup.id)!
      const result = post.postProject(project, [live], post.GRBL_CONFIG, {
        mode: 'separate', pauseBetweenSetups: false, baseName: project.name, ext: 'nc',
        modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad, programContext: true,
      })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      gcode = result.files![0].result.gcode
      span = result.files![0].result.operationSpans?.find(s => s.opId === op.id)
    } finally {
      staged.restore()
    }
    expect(span).toBeDefined()
    const feeds = postedFeeds(gcode, span!)
    // The library's cut path in the posted work frame (the plunge, then every cut).
    const path = truth.moves.filter(m => m.type === 'feed').map(m => ({ x: m.x - wcs.x, y: m.y - wcs.y, z: m.z - wcs.z }))
    const planar = feeds.filter(f => f.from.x !== f.x || f.from.y !== f.y)
    expect(planar.length).toBeGreaterThan(10)
    // Every posted end point sits on the library's path, walking it forward in the library's order
    // (the post rounds to 3 decimals and the arc fitter may end an arc between two library points) ...
    let k = 0
    for (const f of planar) {
      let best = Infinity
      let bestAt = k
      for (let j = Math.max(1, k); j < Math.min(path.length, k + 400); j++) {
        const d = segmentDistance(f, path[j - 1], path[j])
        if (d < best) { best = d; bestAt = j }
      }
      expect(best, `posted end (${f.x}, ${f.y}) is off the library path`).toBeLessThanOrEqual(0.006)
      expect(Math.abs(f.z - path[bestAt].z)).toBeLessThanOrEqual(0.0005 + 1e-9)
      k = bestAt
    }
    // ... the last one is the library's last cut point ...
    const end = path[path.length - 1]
    expect(Math.hypot(planar[planar.length - 1].x - end.x, planar[planar.length - 1].y - end.y)).toBeLessThanOrEqual(0.0006)
    // ... and every fitted arc stays on the library's path within the post's declared arc tolerance
    // plus the 3-decimal rounding of its end and centre words (sampled at 8 points).
    let worst = 0
    for (const f of planar.filter(f => f.kind !== 'line')) {
      const r = Math.hypot(f.from.x - f.cx!, f.from.y - f.cy!)
      const a0 = Math.atan2(f.from.y - f.cy!, f.from.x - f.cx!)
      let a1 = Math.atan2(f.y - f.cy!, f.x - f.cx!)
      if (f.kind === 'ccw') { while (a1 <= a0) a1 += 2 * Math.PI } else { while (a1 >= a0) a1 -= 2 * Math.PI }
      for (let i = 1; i < 8; i++) {
        const a = a0 + ((a1 - a0) * i) / 8
        worst = Math.max(worst, polylineDistance({ x: f.cx! + r * Math.cos(a), y: f.cy! + r * Math.sin(a) }, path))
      }
    }
    expect(worst).toBeLessThanOrEqual((post.GRBL_CONFIG.options.arcTolerance ?? 0.05) + 0.002)
    expect(gcode).toMatch(/S18000/)

    // 4. Save and reopen: the pattern op, its spec and its height authority come back.
    const saved = await snapshotCurrentProjectFile()
    expect(saved).not.toBeNull()
    await useCamStore.getState().loadProjectFromFile(saved!)
    const reopened = liveOp(op.id)
    expect(reopened.type).toBe('pattern')
    expect(reopened.params).toEqual(op.params)
    expect(reopened.smartHeight).toEqual(op.smartHeight)
    useCamStore.setState(s => s.toolLibrary.some(t => t.id === ball.id) ? {} : { toolLibrary: [...s.toolLibrary, ball] })
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    expect(liveOp(op.id).status).toBe('ready')
    expect(liveOp(op.id).toolpathMoves).toEqual(truth.moves)
  }, 120_000)

  it('a spec it cannot read is refused in one plain sentence naming the field, and nothing is cut', async () => {
    const { setup, profile, ball, stockId } = await openSign()
    const op = patternOperation(setup.id, stockId, profile.id, ball.id, { ...ROSE_SPEC, gcode: 'M3 S24000' })
    expect(useCamStore.getState().executeCamCommands([{ kind: 'operation.add', setupId: setup.id, operation: op }]).ok).toBe(true)
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    const refused = liveOp(op.id)
    expect(refused.status).toBe('error')
    expect(refused.toolpathMoves ?? []).toHaveLength(0)
    expect(refused.errorMessage).toMatch(/gcode/)
    expect(refused.errorMessage!.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1)
  }, 120_000)
  it('the Properties panel\'s Smart Height preview resolves a pattern op to the stock top and the stated depth', async () => {
    const { setup, profile, ball, stockId } = await openSign()
    const op = patternOperation(setup.id, stockId, profile.id, ball.id)
    expect(useCamStore.getState().executeCamCommands([{ kind: 'operation.add', setupId: setup.id, operation: op }]).ok).toBe(true)
    const plan = await useCamStore.getState().previewOperationSmartHeightPlan(setup.id, liveOp(op.id))
    const stock = smartHeightStockBounds(useCamStore.getState().project, stockId)!
    expect(plan.machining.materialStart.wcsMm).toBeCloseTo(stock.max.z - setup.wcs.origin.z, 9)
    expect(plan.machining.cutterCenterEnd!.wcsMm).toBeCloseTo(stock.max.z - setup.wcs.origin.z - 0.15, 9)
  }, 120_000)
  // WO-3001 fix round 2 (audit F1): one depth authority. The displayed Bottom
  // Height is the depth that is cut; the script's constant depth feeds the
  // Smart Height Target End, and an operator's Bottom Height override wins.
  async function computedDepths(edit: (op: Operation, setupId: string, stockId: string) => void) {
    const { setup, profile, ball, stockId } = await openSign()
    const op = patternOperation(setup.id, stockId, profile.id, ball.id)
    edit(op, setup.id, stockId)
    expect(useCamStore.getState().executeCamCommands([{ kind: 'operation.add', setupId: setup.id, operation: op }]).ok).toBe(true)
    await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    const ready = liveOp(op.id)
    expect(ready.errorMessage).toBeUndefined()
    expect(ready.status).toBe('ready')
    expect(ready.resolvedHeights?.version).toBe(1)
    const cutZ = [...new Set((ready.toolpathMoves ?? []).filter(m => m.role === 'cut').map(m => Number((m.z - setup.wcs.origin.z).toFixed(6))))]
    const displayed = ready.resolvedHeights?.version === 1 ? ready.resolvedHeights.wcs.bottom : NaN
    return { cutZ, displayed }
  }

  it('the Bottom Height it shows is the depth it cuts, with the script depth feeding it', async () => {
    // The audit's reproduction: the saved Target End says 1 mm, the script says 0.15 mm.
    const { cutZ, displayed } = await computedDepths((op, setupId, stockId) => {
      op.smartHeight = { kind: 'smart_v2', intent: buildPatternSmartHeightIntent({
        setupId, safetyIntent: defaultHeights.heightIntent!, stockId, depthMm: 1,
      }) }
    })
    expect(cutZ).toEqual([-0.15])
    expect(displayed, 'the displayed Bottom Height is not the depth that was cut').toBeCloseTo(cutZ[0], 9)
  }, 120_000)

  it('an operator Bottom Height override is the depth it cuts', async () => {
    const { cutZ, displayed } = await computedDepths(op => {
      const sh = op.smartHeight as { kind: 'smart_v2'; intent: OperationHeightIntentV2 }
      sh.intent.planeOverrides = { bottom: { reference: 'wcs_plane', offsetMm: -0.4, owner: { kind: 'user_override' } } }
    })
    expect(displayed).toBeCloseTo(-0.4, 9)
    expect(cutZ, 'the cut ignores the Bottom Height override').toEqual([-0.4])
  }, 120_000)
})
