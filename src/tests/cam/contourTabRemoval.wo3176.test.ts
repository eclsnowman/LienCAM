// WO-3221 (WO-3176 Brief B): the Create tab removal contour authoring contract.
//
// contourTabRemoval.ts is a pure adapter: it reads a computed tabbed Contour
// and authors a SEPARATE finishing-only Contour plus its tabRemovalSource
// binding. These cases pin what it writes, what it refuses, and the target
// identities it resolves. Expected tab centers are walked here, on the
// preview's ORIGINAL path, by arc length - independent of the planner's
// re-seaming - so a target that followed a re-seamed index instead of the
// tab's own position fails.

import { beforeAll, describe, expect, it } from 'vitest'

import {
  contourTabRemovalSourceIdentity, contourTabRemovalTargets, hasTabRemovalBinding, planContourTabRemoval,
  readTabRemovalBinding, reviewContourTabRemoval, tabRemovalComputeRefusal,
} from '../../lib/cam/contourTabRemoval'
import { computeContourTabPreviewLoop } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { operationDependsOnPredecessors } from '../../lib/cam/generationFingerprint'
import type { ContourParams, ContourTabRemovalSource } from '../../lib/cam/types'
import type { ContourTabPreview, Operation, Setup, Tool } from '../../types'

beforeAll(async () => { await ensureClipperReady() })

type P = { x: number; y: number }
const R = 3
/** The analytic fixture's inner part: 60 x 30, centred in the 100 x 60 stock. */
const PART: P[] = [{ x: -30, y: -15 }, { x: 30, y: -15 }, { x: 30, y: 15 }, { x: -30, y: 15 }]

const TOOL: Tool = {
  id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill', diameter: 2 * R, fluteLength: 30,
  shankDiameter: 6, overallLength: 80, numberOfFlutes: 2,
} as unknown as Tool

function previewFor(loops: Array<{ id: string; points: P[] }>): ContourTabPreview {
  return {
    tabTopZ: 1.5,
    sourceKey: 'key-1',
    loops: loops.map((loop) => {
      const finish = computeContourTabPreviewLoop(loop.points, 'outer', 'climb', 2 * R)!
      return { loopId: loop.id, path: finish.path, perimeter: finish.perimeter }
    }),
  }
}

function source(params: Partial<ContourParams> = {}, extra: Partial<Operation> = {}): Operation {
  const loops = [{ id: 'outline', points: PART }]
  return {
    id: 'src', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: ['part'],
    heights: { clearanceHeight: 30, retractHeight: 25, feedHeight: 22, topHeight: 0, bottomHeight: -6 },
    smartHeight: { kind: 'smart_v2', intent: { bottom: -6 } },
    passes: { stepdown: 2, stepover: 1.5, stockToLeave: 0.3, floorStockToLeave: 0.1, finishPasses: 1, springPasses: 1 },
    linking: { entryType: 'ramp_linear', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    params: {
      geometryId: 'part', loopIds: [], side: 'outer', direction: 'climb',
      tabs: true, tabWidth: 8, tabHeight: 1.5, tabCount: 4, contourFinishMode: 'final', ...params,
    },
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 30 }],
    generationFingerprint: 'camgen-src',
    contourTabPreview: previewFor(loops),
    ...extra,
  } as unknown as Operation
}

function setupWith(...operations: Operation[]): Setup {
  return { id: 'setup-1', name: 'Setup 1', operations, notes: '', holdingMethod: 'screws' } as unknown as Setup
}

/** Point at arc distance d along a closed polyline (independent walk). */
function walk(path: P[], d: number): P {
  const total = path.reduce((sum, p, i) => sum + Math.hypot(path[(i + 1) % path.length].x - p.x, path[(i + 1) % path.length].y - p.y), 0)
  let s = ((d % total) + total) % total
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (s <= len) return { x: a.x + (b.x - a.x) * (s / len), y: a.y + (b.y - a.y) * (s / len) }
    s -= len
  }
  return path[0]
}

const plan = (src: Operation, extra: Partial<Parameters<typeof planContourTabRemoval>[0]> = {}) =>
  planContourTabRemoval({ setup: setupWith(src), source: src, tool: TOOL, previewCurrent: true,
    operationId: 'cleanup-1', name: 'Outline profile - tab removal', ...extra })

describe('WO-3221 Create tab removal contour: target identities', () => {
  it('even spacing: four targets at (k + 0.5) x perimeter / 4 along the finish path, labelled loopId#k', () => {
    const src = source()
    const preview = src.contourTabPreview!
    const loop = preview.loops[0]
    // 60 x 30 part, 6 mm cutter outside: four 60/30 mm sides joined by R3 arcs.
    const perimeter = 2 * (60 + 30) + 2 * Math.PI * R
    expect(loop.perimeter).toBeCloseTo(perimeter, 1)
    const { loopIds, targets } = contourTabRemovalTargets(src, preview)
    expect(loopIds).toEqual(['outline'])
    expect(targets.map((t) => t.label)).toEqual(['outline#0', 'outline#1', 'outline#2', 'outline#3'])
    targets.forEach((target, k) => {
      const expected = walk(loop.path, (k + 0.5) * loop.perimeter / 4)
      expect(Math.hypot(target.center.x - expected.x, target.center.y - expected.y)).toBeLessThan(1e-6)
      expect(target).toMatchObject({ width: 8, height: 1.5, shape: 'box' })
    })
  })

  it('hand-placed tabs over the seam: the planner re-seams, every target stays at its own fraction of the original path', () => {
    // The first tab's interval crosses the seam (1.99 mm < W/2 from it).
    const fractions = [0.01, 0.3, 0.62, 0.9]
    const src = source({ tabLocations: { outline: fractions }, tabShape: 'triangular' })
    const loop = src.contourTabPreview!.loops[0]
    const { targets } = contourTabRemovalTargets(src, src.contourTabPreview!)
    expect(targets).toHaveLength(4)
    const expected = fractions.map((f) => walk(loop.path, f * loop.perimeter))
    for (const e of expected) {
      expect(targets.some((t) => Math.hypot(t.center.x - e.x, t.center.y - e.y) < 1e-6)).toBe(true)
    }
    expect(targets.every((t) => t.shape === 'triangular')).toBe(true)
  })

  it("an outline set to 'none' carries no targets and is not cut by the cleanup", () => {
    const loops = [{ id: 'outline', points: PART }, { id: 'block', points: PART.map((p) => ({ x: p.x / 6, y: p.y / 6 + 40 })) }]
    const src = source({ tabLocations: { block: 'none' } }, { contourTabPreview: previewFor(loops) })
    const result = plan(src)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.binding.loopIds).toEqual(['outline'])
    expect((result.operation.params as unknown as ContourParams).loopIds).toEqual(['outline'])
    expect(result.targets.every((t) => t.loopId === 'outline')).toBe(true)
  })
})

describe('WO-3221 Create tab removal contour: the authored cleanup', () => {
  it('a NEW finishing-only contour: same tool, outline, side, direction and heights; allowance 0; tabs off; source untouched', () => {
    const src = source()
    const before = structuredClone(src)
    const result = plan(src)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cleanup = result.operation
    const params = cleanup.params as unknown as ContourParams
    expect(cleanup.id).toBe('cleanup-1')
    expect(cleanup.id).not.toBe(src.id)
    expect(cleanup).toMatchObject({ type: 'contour_2d', enabled: true, status: 'pending', toolId: 'tool-1' })
    expect(cleanup.toolpathMoves).toBeUndefined()
    expect(cleanup.generationFingerprint).toBeUndefined()
    expect(cleanup.contourTabPreview).toBeUndefined()
    expect(cleanup.smartHeight).toEqual(src.smartHeight)
    expect(cleanup.heights).toEqual(src.heights)
    expect(cleanup.linking).toEqual(src.linking)
    expect(cleanup.passes).toEqual({ stepdown: 2, stepover: 1.5, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 1 })
    expect(params).toMatchObject({ geometryId: 'part', loopIds: ['outline'], side: 'outer', direction: 'climb', tabs: false })
    for (const key of ['tabWidth', 'tabHeight', 'tabCount', 'tabShape', 'tabLocations', 'contourFinishMode'] as const) {
      expect(params[key]).toBeUndefined()
    }
    expect(params.tabRemovalSource).toEqual(result.binding)
    expect(result.binding).toMatchObject({
      version: 1, sourceSetupId: 'setup-1', sourceOperationId: 'src', loopIds: ['outline'],
      sourceIdentity: contourTabRemovalSourceIdentity(src, TOOL),
    })
    expect(result.binding.targets).toHaveLength(4)
    // The source object, its settings and tab locations are exactly as they were.
    expect(src).toEqual(before)
    // Nothing is shared: editing the cleanup cannot reach the source.
    ;(cleanup.heights as unknown as Record<string, number>).bottomHeight = 99
    expect(src.heights.bottomHeight).toBe(-6)
  })

  it('refuses in one reason, never a partial or substituted cleanup', () => {
    const src = source()
    const four = contourTabRemovalTargets(src, src.contourTabPreview!).targets.map((t) => t.label)
    const cases: Array<[string, ReturnType<typeof plan>]> = [
      ['missing', planContourTabRemoval({ setup: setupWith(), source: src, tool: TOOL, previewCurrent: true, operationId: 'x', name: 'x' })],
      ['not-contour', plan(source({}, { type: 'pocket_2d' }))],
      ['open', plan(source({ pathType: 'open' }))],
      ['tabs-off', plan(source({ tabs: false }))],
      ['generate-first', plan(source({}, { status: 'outdated' }))],
      ['generate-first', plan(source({}, { contourTabPreview: undefined }))],
      ['stale', plan(src, { previewCurrent: false })],
      ['no-tabs', plan(source({ tabLocations: { outline: 'none' } }))],
      ['selective', plan(src, { selectedLabels: four.slice(0, 2) })],
      ['flipped', plan(src, { targetSetupId: 'setup-2-flipped' })],
    ]
    for (const [reason, result] of cases) expect(result, reason).toEqual({ ok: false, reason })
    const made = plan(src)
    expect(made.ok).toBe(true)
    if (made.ok) expect(plan({ ...made.operation, status: 'ready', contourTabPreview: src.contourTabPreview })).toEqual({ ok: false, reason: 'is-cleanup' })
    // All four selected is the whole removal.
    expect(plan(src, { selectedLabels: four }).ok).toBe(true)
  })

  it('the source identity follows its cut inputs, not its name, state or output', () => {
    const src = source()
    const id = contourTabRemovalSourceIdentity(src, TOOL)
    const changed: Array<[string, Operation, Tool]> = [
      ['tab count', source({ tabCount: 3 }), TOOL],
      ['tab location', source({ tabLocations: { outline: [0.1, 0.3, 0.6, 0.8] } }), TOOL],
      ['tab shape', source({ tabShape: 'triangular' }), TOOL],
      ['side', source({ side: 'inner' }), TOOL],
      ['outline', source({ loopIds: ['other'] }), TOOL],
      ['bottom', source({}, { smartHeight: { kind: 'smart_v2', intent: { bottom: -6.2 } } } as Partial<Operation>), TOOL],
      ['diameter', src, { ...TOOL, diameter: 5 }],
      ['cut hand', src, { ...TOOL, cutHand: 'left' } as Tool],
    ]
    for (const [what, op, tool] of changed) expect(contourTabRemovalSourceIdentity(op, tool), what).not.toBe(id)
    const same: Array<[string, Operation]> = [
      ['name', { ...src, name: 'Renamed' }],
      ['status', { ...src, status: 'computing', progress: 0.5 }],
      ['moves', { ...src, toolpathMoves: [] }],
      ['feed', { ...src, feedrateOverride: { feedRate: 5 } } as Operation],
    ]
    for (const [what, op] of same) expect(contourTabRemovalSourceIdentity(op, TOOL), what).toBe(id)
  })
})

describe('WO-3221 the saved binding', () => {
  const bound = (): Operation => {
    const src = source()
    const result = plan(src)
    if (!result.ok) throw new Error(result.reason)
    return result.operation
  }

  it('reads none, malformed or bound - a damaged binding is never an ordinary contour', () => {
    expect(readTabRemovalBinding(source())).toEqual({ kind: 'none' })
    const cleanup = bound()
    expect(readTabRemovalBinding(cleanup).kind).toBe('bound')
    const binding = (cleanup.params as unknown as ContourParams).tabRemovalSource!
    const damaged: unknown[] = [
      null, 'src', { ...binding, version: 2 }, { ...binding, sourceOperationId: '' }, { ...binding, loopIds: [] },
      { ...binding, targets: [] }, { ...binding, targets: [{ ...binding.targets[0], loopId: 'elsewhere' }] },
      { ...binding, targets: [{ ...binding.targets[0], center: { x: Number.NaN, y: 0 } }] },
      { ...binding, targets: [{ ...binding.targets[0], shape: 'round' }] },
    ]
    for (const value of damaged) {
      const op = { ...cleanup, params: { ...cleanup.params, tabRemovalSource: value } } as Operation
      expect(readTabRemovalBinding(op), JSON.stringify(value)).toEqual({ kind: 'malformed' })
      expect(hasTabRemovalBinding(op)).toBe(true)
      expect(operationDependsOnPredecessors(op)).toBe(true)
    }
  })

  it('a binding makes the cleanup predecessor-dependent; a contour without one is unchanged', () => {
    expect(operationDependsOnPredecessors(source())).toBe(false)
    expect(operationDependsOnPredecessors(bound())).toBe(true)
    // Only a contour reads the binding key.
    const pocket = { ...source(), type: 'pocket_2d', params: { tabRemovalSource: {} } } as unknown as Operation
    expect(operationDependsOnPredecessors(pocket)).toBe(false)
    expect(hasTabRemovalBinding(pocket)).toBe(false)
  })

  it('compute refusal: each broken link gives its one reason; the intact link gives none', () => {
    const src = source()
    const cleanup = bound()
    const tools = (id: string) => (id === 'tool-1' ? TOOL : undefined)
    const refusal = (setup: Setup, op: Operation = cleanup, resolve = tools) => tabRemovalComputeRefusal(setup, op, resolve)
    expect(refusal(setupWith(src, cleanup))).toBeNull()
    expect(refusal(setupWith(src), source())).toBeNull()
    const malformed = { ...cleanup, params: { ...cleanup.params, tabRemovalSource: { version: 1 } } } as Operation
    expect(refusal(setupWith(src, malformed), malformed)).toBe('binding-malformed')
    expect(refusal(setupWith(cleanup))).toBe('source-missing')
    expect(refusal({ ...setupWith(src, cleanup), id: 'setup-2' })).toBe('source-other-setup')
    expect(refusal(setupWith(cleanup, src))).toBe('source-after')
    expect(refusal(setupWith({ ...src, enabled: false }, cleanup))).toBe('source-disabled')
    // Tabs moved after creation: the old target #1 is not re-bound to a new #1.
    expect(refusal(setupWith(source({ tabLocations: { outline: [0.1, 0.35, 0.6, 0.85] } }), cleanup))).toBe('source-changed')
    expect(refusal(setupWith(src, cleanup), cleanup, () => ({ ...TOOL, diameter: 8 }))).toBe('source-changed')
    const withParams = (patch: Partial<ContourParams>) =>
      ({ ...cleanup, params: { ...cleanup.params, ...patch } }) as Operation
    for (const changed of [
      { ...cleanup, toolId: 'tool-2' } as Operation,
      withParams({ tabs: true }), withParams({ side: 'inner' }), withParams({ loopIds: [] }), withParams({ pathType: 'open' }),
    ]) {
      expect(refusal(setupWith(src, changed), changed)).toBe('cleanup-changed')
    }
  })

  it('review reports every target and the targets it would remove are the binding it writes', () => {
    const src = source()
    const review = reviewContourTabRemoval({ setup: setupWith(src), source: src, tool: TOOL, previewCurrent: true })
    expect(review.ok).toBe(true)
    const made = plan(src)
    if (!review.ok || !made.ok) return
    const binding: ContourTabRemovalSource = made.binding
    expect(binding.targets).toEqual(review.targets)
    expect(binding.loopIds).toEqual(review.loopIds)
  })
})
