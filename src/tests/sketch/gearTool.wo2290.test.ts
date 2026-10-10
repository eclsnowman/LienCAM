import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sketch, SketchEntity, Vec2 } from '../../lib/sketch/types'
import { bakeSketch } from '../../lib/sketch/bake'
import { expandBlocksForGeometry } from '../../lib/sketch/blocks'
import { ARMABLE_TOOLS, toolPreview, escapeTool } from '../../lib/sketch/tools/toolMachine'
import { toolStepStatus } from '../../lib/sketch/tools/toolSteps'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourWorkerPayload } from '../../lib/cam/types'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'

class StubWorker { onmessage = null; onerror = null; postMessage(): void {} terminate(): void {} }
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
let store: typeof import('../../store').useCamStore
let tools: typeof import('../../lib/sketch/sketcher').sketcherTools
let toolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
beforeAll(async () => {
  ;({ useCamStore: store } = await import('../../store'))
  ;({ sketcherTools: tools, sketcherToolStore: toolStore } = await import('../../lib/sketch/sketcher'))
  await ensureClipperReady()
})
beforeEach(() => {
  store.getState().startNewSketch()
  toolStore.setState({ constructionMode: false, chain: null })
  tools.setGearParams?.({ teeth: 20, module: 2, pressureAngle: 20, rootFillet: 0.3 })
})
const center = { x: 7, y: -3 }
const cursor = { x: 29, y: -3 }
function draw(teeth = 20, pressureAngle: 14.5 | 20 | 25 = 20): Sketch {
  tools.setGearParams({ teeth, pressureAngle })
  tools.armTool('gear')
  tools.click(center, 0.05, null, false)
  expect(store.getState().activeSketch!.entities).toHaveLength(3)
  tools.click(cursor, 0.05, null, false, () => store.getState().pushHistory())
  return store.getState().activeSketch!
}
function samples(e: SketchEntity, count = 100): Vec2[] {
  if (e.kind === 'line') return Array.from({ length: count + 1 }, (_, i) => ({ x: e.start.x + (e.end.x - e.start.x) * i / count, y: e.start.y + (e.end.y - e.start.y) * i / count }))
  if (e.kind !== 'arc') return []
  const sweep = (e.endAngle - e.startAngle + 4 * Math.PI) % (2 * Math.PI)
  return Array.from({ length: count + 1 }, (_, i) => ({ x: e.center.x + e.radius * Math.cos(e.startAngle + sweep * i / count), y: e.center.y + e.radius * Math.sin(e.startAngle + sweep * i / count) }))
}
const radius = (p: Vec2): number => Math.hypot(p.x - center.x, p.y - center.y)
// The gear lands as one locked block (as an imported layer does); its lines and
// arcs, and their chaining joints, are the block's world members.
const flat = (sk: Sketch) => expandBlocksForGeometry(sk.entities, sk.constraints, sk.blockDefs)
const outer = (sk: Sketch) => flat(sk).entities.filter((e) => !e.construction)

describe('WO-2290 gear through the production sketch engine', () => {
  it('arms Gear, commits one closed 20-tooth module-2 outline, and keeps its center available for a bore', () => {
    expect(ARMABLE_TOOLS.has('gear')).toBe(true)
    const sk = draw(), cut = outer(sk), points = cut.flatMap((e) => samples(e))
    expect(sk.entities.filter((e) => e.kind === 'block')).toHaveLength(1)
    expect(cut.every((e) => e.kind === 'line' || e.kind === 'arc')).toBe(true)
    expect(Math.max(...points.map(radius))).toBeCloseTo(22, 2)
    expect(Math.min(...points.map(radius))).toBeCloseTo(17.5, 2)
    const pitch = sk.entities.find((e) => e.kind === 'circle')!
    expect(pitch).toMatchObject({ construction: true, center, radius: 20 })
    // Tooth count comes from the angular period of the outline's crests,
    // independent of entity/sample count on the fitted flanks.
    const crestAngles = cut.filter((e) => e.kind === 'arc' && Math.abs(e.radius - 22) < 1e-8)
      .map((e) => e.kind === 'arc' ? (Math.atan2(Math.sin(e.startAngle) + Math.sin(e.endAngle), Math.cos(e.startAngle) + Math.cos(e.endAngle)) + 2 * Math.PI) % (2 * Math.PI) : 0).sort((a, b) => a - b)
    expect(crestAngles).toHaveLength(20)
    for (let i = 0; i < 20; i++) expect((crestAngles[(i + 1) % 20] - crestAngles[i] + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(2 * Math.PI / 20, 9)
    const baked = bakeSketch(sk)
    expect(baked.loops).toHaveLength(1)
    expect(baked.loops[0]).toMatchObject({ closed: true, type: 'contour' })
    const pts = baked.loops[0].points
    const area = pts.reduce((sum, a, i) => { const b = pts[(i + 1) % pts.length]; return sum + a.x * b.y - b.x * a.y }, 0) / 2
    expect(area).toBeGreaterThan(0) // normal Y-up outer winding
    const members = flat(sk)
    for (const c of members.constraints) {
      if (c.kind !== 'coincident') continue
      const site = (ref: typeof c.a): Vec2 => {
        const e = members.entities.find((x) => x.id === ref.entityId)!
        if (e.kind === 'line') return ref.site === 'start' ? e.start : e.end
        if (e.kind === 'arc') { const a = ref.site === 'start' ? e.startAngle : e.endAngle; return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) } }
        throw new Error('unexpected chain site')
      }
      const a = site(c.a), b = site(c.b)
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-8)
    }
    tools.armTool('circle-center')
    tools.click(center, 0.05, null, false)
    tools.click({ x: center.x + 3, y: center.y }, 0.05, null, false)
    expect(bakeSketch(store.getState().activeSketch!).loops).toHaveLength(2)
  })

  it('fits every flank within 0.01 mm of the independent true involute, between samples too', () => {
    const sk = draw(), base = 20 * Math.cos(20 * Math.PI / 180), tp = Math.tan(20 * Math.PI / 180)
    let worst = 0, checked = 0
    for (const e of outer(sk)) for (const pt of samples(e, 200)) {
      const r = radius(pt)
      if (r <= base + 0.01 || r >= 22 - 0.01) continue
      const t = Math.sqrt((r / base) ** 2 - 1)
      const halfWidth = Math.PI / 40 + tp - Math.atan(tp) - (t - Math.atan(t))
      const a = Math.atan2(pt.y - center.y, pt.x - center.x)
      const nearestTooth = Math.round(a / (Math.PI / 10)) * Math.PI / 10
      worst = Math.max(worst, r * Math.abs(Math.abs(a - nearestTooth) - halfWidth))
      checked++
    }
    expect(checked).toBeGreaterThan(1000)
    expect(worst).toBeLessThan(0.01)
  })

  it('undo removes the whole gear in one step and redo restores the same geometry', () => {
    const sk = draw()
    store.getState().undo()
    expect(store.getState().activeSketch!.entities).toHaveLength(3)
    store.getState().redo()
    expect(store.getState().activeSketch!.entities).toEqual(sk.entities)
  })

  it.each([6, 200])('commits %i teeth as one closed loop without a crossing or missing closing edge', (teeth) => {
    const sk = draw(teeth), baked = bakeSketch(sk)
    expect(baked.loops).toHaveLength(1)
    expect(baked.loops[0].closed).toBe(true)
    expect(flat(sk).constraints.filter((c) => c.kind === 'coincident')).toHaveLength(outer(sk).length)
  })

  it.each([14.5, 20, 25] as const)('handles pressure angle %s and zero fillet without changing diameter', (pressureAngle) => {
    tools.setGearParams({ rootFillet: 0 })
    const sk = draw(20, pressureAngle)
    const pts = outer(sk).flatMap((e) => samples(e, 10))
    expect(Math.max(...pts.map(radius))).toBeCloseTo(22, 2)
    expect(Math.min(...pts.map(radius))).toBeCloseTo(17.5, 2)
    expect(bakeSketch(sk).loops).toHaveLength(1)
  })

  it('previews the same fitted outline as the next click, updates live parameters, and Esc cancels the center', () => {
    tools.armTool('gear'); tools.click(center, 0.05, null, false)
    tools.setGearParams({ teeth: 30, module: 1.5 })
    const state = toolStore.getState()
    expect(toolStepStatus(state)!.stepIndex).toBe(1)
    const rotatedCursor = { x: center.x, y: center.y + 10 }
    const preview = toolPreview(state, rotatedCursor, { gearParams: state.gearParams })!
    expect(preview[0]).toEqual(preview[preview.length - 1])
    tools.click(rotatedCursor, 0.05, null, false)
    const sk = store.getState().activeSketch!
    expect(sk.entities.find((e) => e.kind === 'circle')).toMatchObject({ radius: 22.5 })
    for (const e of outer(sk)) {
      const pts = samples(e, 1)
      for (const p of pts) expect(preview.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-8)).toBe(true)
    }
    expect(escapeTool(state).state).toMatchObject({ tool: 'gear', chain: null })
  })

  it('clamps typed preferences and applies construction mode to the entire outline', () => {
    tools.setGearParams({ teeth: 201, module: -1, rootFillet: 100 })
    expect(toolStore.getState().gearParams).toMatchObject({ teeth: 200, module: 0.01 })
    expect(toolStore.getState().gearParams.rootFillet).toBeLessThan(0.011)
    toolStore.setState({ constructionMode: true })
    const sk = draw(6)
    expect(sk.entities.every((e) => e.construction)).toBe(true)
    expect(flat(sk).entities.every((e) => e.construction)).toBe(true)
    expect(bakeSketch(sk).loops).toHaveLength(0)
  })

  it.each([6, 200].flatMap((teeth) => ([14.5, 20, 25] as const).map((angle) => [teeth, angle] as const)))('keeps the outline simple at %s teeth and %s deg with the maximum root fillet', (teeth, pressureAngle) => {
    tools.setGearParams({ teeth, pressureAngle, rootFillet: 100 })
    const baked = bakeSketch(draw(teeth, pressureAngle))
    expect(baked.loops).toHaveLength(1)
    expect(baked.loops[0]).toMatchObject({ closed: true, type: 'contour' })
    expect(baked.crossingLoops).toHaveLength(0)
  })

  // Audit FAIL (Aborted(OOM)): the committed gear goes through the REAL
  // planegcs solve the sketch worker runs, unstubbed. Fails on the one-chain
  // gear (a single unsplittable 363-entity component aborts the WASM heap).
  it.each([
    [20, 2, 'the default gear'],
    [200, 2, '200 teeth'],
    [6, 100, '6 teeth at module 100'],
  ] as const)('%i teeth at module %i (%s) solves clean through the real planegcs solver and stays one closed loop', async (teeth, module, _label) => {
    tools.setGearParams({ module })
    const sk = draw(teeth)
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sk)
    if (!out.ok) throw new Error(`solve failed: ${out.reason} ${out.message}`)
    expect(out.status.solveFailed).toBeFalsy()
    expect(out.entities).toHaveLength(sk.entities.length)
    const solved: Sketch = { ...sk, entities: out.entities }
    const before = outer(sk).flatMap((e) => samples(e, 4)), after = outer(solved).flatMap((e) => samples(e, 4))
    for (let i = 0; i < before.length; i++) expect(Math.hypot(before[i].x - after[i].x, before[i].y - after[i].y)).toBeLessThan(1e-6)
    const baked = bakeSketch(solved)
    expect(baked.loops).toHaveLength(1)
    expect(baked.loops[0]).toMatchObject({ closed: true, type: 'contour' })
  }, 60_000)

  // The capture route: the centre click snaps to the sketch origin. The new
  // tie must land on the pitch circle's centre, not the fixed block origin
  // (that pair read "1 redundant (advisory) Coincident" in the toolbox).
  it('a centre snapped to the sketch origin solves with no redundant or conflicting constraint', async () => {
    tools.armTool('gear')
    const snapped = tools.snap({ x: 0, y: 0 }, 0.05)
    expect(snapped?.inferences.some((i) => i.kind === 'coincident')).toBe(true)
    tools.click(snapped!.point, 0.05, snapped, false)
    tools.click({ x: 22, y: 3 }, 0.05, null, false, () => store.getState().pushHistory())
    const sk = store.getState().activeSketch!
    const pitch = sk.entities.find((e) => e.kind === 'circle' && e.construction)!
    expect(sk.constraints.some((c) => c.kind === 'coincident' && [c.a, c.b].some((r) => r.entityId === pitch.id && r.site === 'center'))).toBe(true)
    const out = solveSketchOnWrapper(await createGcsWrapper(), sk)
    if (!out.ok) throw new Error(`solve failed: ${out.reason} ${out.message}`)
    expect(out.status.redundant).toEqual([])
    expect(out.status.conflicting).toEqual([])
    expect(bakeSketch({ ...sk, entities: out.entities }).loops).toHaveLength(1)
  }, 60_000)

  it('the baked gear is accepted by the production Contour operation', () => {
    const loops = bakeSketch(draw()).loops
    const payload = {
      opId: 'gear-contour', setupId: 's', loops, wcsOrigin: { x: 0, y: 0, z: 0 },
      params: { geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs: false },
      tool: { id: 't', name: '1mm endmill', type: 'flat_end_mill', diameter: 1, fluteLength: 20, shankDiameter: 1, overallLength: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: { default: { rpm: 10000, feedRate: 500, plungeRate: 100, depthOfCut: 2, stepover: 0.5 } } },
      heights: { clearanceHeight: 5, retractHeight: 3, feedHeight: 1, topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute' },
      passes: { stepdown: 5, stepover: 0.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
      linking: { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    } as unknown as ContourWorkerPayload
    const cuts = buildContourToolpath(payload).filter((m) => m.role === 'cut')
    expect(cuts.length).toBeGreaterThan(40)
    expect(cuts.every((m) => Number.isFinite(m.x) && Number.isFinite(m.y))).toBe(true)
  })
})
