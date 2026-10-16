// WO-2876: 2D Pocket refused a 40 mm square with a 12 mm round island inside,
// 3 mm flat, inside-out (the dialog's default) - "pocket2d entry: no
// island-clear entry point". About 11 mm of tool-centre room lies between the
// island keep-out and the wall on every side. The entry search took its
// candidates from the innermost ring generation only; the rings are offsets of
// the outer boundary alone, so those innermost rings shrink onto the island and
// every candidate sat inside its keep-out.
//
// Measured on the production path: the store's computeOperationToolpath with
// the real toolpath worker (heightScenario harness, rule 6). That harness tags
// every sketch loop 'contour'; a real sketch bake tags the circle 'hole' by
// containment nesting (lib/sketch/bake.ts step 6), so the circle is re-tagged
// through the store's own setLoopTypes before the compute that is read. The
// ADR 0003 refusal stays for a pocket with truly no room.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { useCamStore } from '../../store'
import { offsetLoop, ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { ensureCCW, pointInPolygon } from '../../lib/cam/geometry'
import { toWork } from '../../lib/program/coords'
import {
  circleLoop, installRealToolpathWorker, rectLoop, runHeightScenario,
  type HeightScenario, type ScenarioLoop,
} from '../helpers/heightScenario'
import type { ToolpathMove } from '../../types'

await ensureClipperReady()
installRealToolpathWorker()

type Pt2 = { x: number; y: number }

// The harness's fixed ids (heightScenario.ts GEO_ID / SETUP_ID / OP_ID).
const GEO_ID = 'part-1'
const SETUP_ID = 'setup-1'
const OP_ID = 'op-1'

const TOOL_D = 3
const R = TOOL_D / 2

function scenario(loops: ScenarioLoop[]): HeightScenario {
  return {
    part: { kind: 'sketch_2d', z: 0, loops },
    stock: { kind: 'auto', offsetXY: 5, offsetZTop: 6, offsetZBottom: 0 },
    operation: 'pocket_2d',
    loopIds: loops.map(l => l.id),
    toolDiameter: TOOL_D,
  }
}

interface Computed { status: string; errorMessage?: string; moves: ToolpathMove[] }

/** The scenario as the operator draws it: outer loop a contour, inner loop a hole. */
async function computeWithIsland(
  outer: ScenarioLoop, island: ScenarioLoop, stepover?: number, entryType?: 'plunge',
): Promise<Computed> {
  await runHeightScenario(scenario([outer, island]))
  const store = useCamStore.getState()
  store.setLoopTypes(GEO_ID, { [island.id]: 'hole' })
  if (stepover !== undefined) {
    const op = store.project.setups.find(s => s.id === SETUP_ID)!.operations.find(o => o.id === OP_ID)!
    store.updateOperation(SETUP_ID, OP_ID, { passes: { ...op.passes, stepover } })
  }
  if (entryType !== undefined) {
    const op = useCamStore.getState().project.setups.find(s => s.id === SETUP_ID)!.operations.find(o => o.id === OP_ID)!
    useCamStore.getState().updateOperation(SETUP_ID, OP_ID, { linking: { ...op.linking, entryType } })
  }
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, OP_ID)
  const setup = useCamStore.getState().project.setups.find(s => s.id === SETUP_ID)!
  const op = setup.operations.find(o => o.id === OP_ID)!
  const moves = (op.toolpathMoves ?? []).map(m => ({ ...m, ...toWork(m, setup.wcs) }))
  return { status: op.status, errorMessage: op.errorMessage, moves }
}

const ENTRY_ROLES = new Set(['helix', 'ramp', 'plunge'])

/** Offset `loop` by `d` (tool-centre keep-out), after shifting it by `shift`. */
function grown(loop: ScenarioLoop, d: number, shift: Pt2): Pt2[] {
  const pts = loop.points.map(p => ({ x: p.x + shift.x, y: p.y + shift.y }))
  const loops = offsetLoop(ensureCCW(pts) as Pt2[], d, 0)
  if (loops.length === 0) throw new Error('test setup: offset failed')
  return loops[0] as Pt2[]
}

describe('WO-2876: Pocket 2D finds an entry around a round island in a plain square', () => {
  // The dialog's default stepover (3 mm, a full-width slot for this tool: each
  // ring is reached by its existing retract-and-plunge link) and a usual 40 %,
  // where every ring is reached at depth and the helix is the only way down.
  afterEach(() => { vi.restoreAllMocks() })

  // At 1 mm the first ring clear of the island leaves only 0.28 mm of room
  // (audit, astra 10-16); the next ring out fits the requested helix, so the
  // Helix the operator chose is kept rather than degraded to a plunge.
  it.each([
    { stepover: undefined, ringLinksPlunge: true },
    { stepover: 1.2, ringLinksPlunge: false },
    { stepover: 1, ringLinksPlunge: undefined },
  ])('the 40 mm square with a 12 mm circle computes, its entry clear of the island and inside the pocket (stepover $stepover)', async ({ stepover, ringLinksPlunge }) => {
    const square = rectLoop('square', 0, 0, 40, 40)
    const island = circleLoop('island', 20, 20, 6, 96)
    const warn = vi.spyOn(console, 'warn')
    const { status, errorMessage, moves } = await computeWithIsland(square, island, stepover)
    // Evidence capture (src/tests/evidence/WO-2876/render.mjs): WO2876_DUMP=before|after.
    if (process.env.WO2876_DUMP) {
      writeFileSync(`src/tests/evidence/WO-2876/${process.env.WO2876_DUMP}-stepover-${stepover ?? 'default'}.json`,
        JSON.stringify({ status, errorMessage, toolD: TOOL_D, square: square.points, island: island.points,
          moves: moves.map(m => [m.type === 'rapid' ? 'R' : (m.role ?? 'cut'), +m.x.toFixed(3), +m.y.toFixed(3), +m.z.toFixed(3)]) }))
    }
    expect(status, errorMessage).toBe('ready')
    expect(moves.length).toBeGreaterThan(0)

    // The moves are in WCS. Locate the sketch from the cut's own extent: the
    // outermost ring runs the square inset by the tool radius.
    const feeds = moves.filter(m => m.type === 'feed')
    const shift = { x: Math.min(...feeds.map(m => m.x)) - R, y: Math.min(...feeds.map(m => m.y)) - R }
    const islandKeepOut = grown(island, R - 0.01, shift)
    const pocketEnvelope = grown(square, -R + 0.01, shift)

    const entry = moves.filter(m => m.type === 'feed' && ENTRY_ROLES.has(m.role ?? ''))
    expect(entry.length, 'entry moves').toBeGreaterThan(0)
    // ~11 mm of room: the default helix fits, nothing degrades to a plunge.
    expect(entry.some(m => m.role === 'helix'), 'a helix entry').toBe(true)
    if (ringLinksPlunge === false) expect(entry.filter(m => m.role === 'plunge'), 'plunges').toEqual([])
    expect(warn.mock.calls.flat().filter(a => String(a).includes('helix_degraded_to_plunge')),
      'helix degraded to a plunge').toEqual([])
    const helix = entry.filter(m => m.role === 'helix')
    expect(helix.filter(m => pointInPolygon(m, islandKeepOut)), 'helix points in the island keep-out').toEqual([])
    expect(helix.filter(m => !pointInPolygon(m, pocketEnvelope)), 'helix points outside the pocket').toEqual([])

    console.log('[WO-2876 probe]', JSON.stringify({
      moves: moves.length,
      helixCentre: { x: (Math.min(...helix.map(m => m.x)) + Math.max(...helix.map(m => m.x))) / 2 - shift.x,
        y: (Math.min(...helix.map(m => m.y)) + Math.max(...helix.map(m => m.y))) / 2 - shift.y },
      helixDia: Math.max(...helix.map(m => m.x)) - Math.min(...helix.map(m => m.x)),
      plunges: entry.filter(m => m.role === 'plunge').length,
      retracts: moves.filter(m => m.type === 'rapid').length,
    }))
    const engaged = feeds.filter(m => pointInPolygon(m, islandKeepOut))
    expect(engaged, 'feed moves inside the island keep-out').toEqual([])
  }, 60_000)

  // Inside-out's other entry, Plunge, is placed by the same search.
  it('with a Plunge entry the plunge lands clear of the island and inside the pocket', async () => {
    const square = rectLoop('square', 0, 0, 40, 40)
    const island = circleLoop('island', 20, 20, 6, 96)
    const { status, errorMessage, moves } = await computeWithIsland(square, island, 1.2, 'plunge')
    expect(status, errorMessage).toBe('ready')
    const feeds = moves.filter(m => m.type === 'feed')
    const shift = { x: Math.min(...feeds.map(m => m.x)) - R, y: Math.min(...feeds.map(m => m.y)) - R }
    const islandKeepOut = grown(island, R - 0.01, shift)
    const pocketEnvelope = grown(square, -R + 0.01, shift)
    expect(moves.some(m => m.role === 'helix'), 'no helix on a Plunge entry').toBe(false)
    const plunges = feeds.filter(m => m.role === 'plunge')
    expect(plunges.length).toBeGreaterThan(0)
    expect(plunges.filter(m => pointInPolygon(m, islandKeepOut)), 'plunges in the island keep-out').toEqual([])
    expect(plunges.filter(m => !pointInPolygon(m, pocketEnvelope)), 'plunges outside the pocket').toEqual([])
    expect(feeds.filter(m => pointInPolygon(m, islandKeepOut)), 'feed moves in the island keep-out').toEqual([])
  }, 60_000)

  // A ring of material too narrow for any helix: a Ø24 circle round a Ø17
  // island leaves a 0.5 mm tool-centre corridor, so no ring offers more than
  // 0.25 mm of room. Rule 11 (the operator 10-14, "doing it never means doing something
  // else"): the Helix the operator chose cannot run, so the operation says so in
  // one line and moves nothing - it never plunges instead (astra audit 10-16 8:09).
  // The same pocket with Plunge chosen cuts, its plunges clear of island and wall.
  it.each([
    { name: 'no room at all (0.2 mm)', islandR: 8.5, stepover: 0.3 },
    // 0.32 mm of room fits a 0.17 mm helix by the 0.15 mm margin, below
    // helixFits' 0.2 mm: every safeHelixR consumer would plunge it unannounced.
    { name: 'room under the smallest real helix (0.32 mm)', islandR: 8.35, stepover: 0.33 },
  ])('a Helix with no room for any helix refuses in one line and moves nothing - $name', async ({ islandR, stepover }) => {
    const outer = circleLoop('outer', 20, 20, 12, 96)
    const island = circleLoop('island', 20, 20, islandR, 96)
    const warn = vi.spyOn(console, 'warn')
    const { status, errorMessage, moves } = await computeWithIsland(outer, island, stepover)
    expect(status, 'the Helix refuses').toBe('error')
    expect(errorMessage ?? '').toMatch(/no room for the Helix entry around the island .* Nothing was cut; a Plunge entry fits\.$/)
    expect(errorMessage ?? '', 'one line').not.toContain('\n')
    expect(moves, 'no substitute motion').toEqual([])
    expect(warn.mock.calls.flat().filter(a => String(a).includes('helix_degraded_to_plunge')),
      'no degradation to a plunge').toEqual([])

    const plunge = await computeWithIsland(outer, island, stepover, 'plunge')
    expect(plunge.status, plunge.errorMessage).toBe('ready')
    const feeds = plunge.moves.filter(m => m.type === 'feed')
    const shift = { x: Math.min(...feeds.map(m => m.x)) - R - 8, y: Math.min(...feeds.map(m => m.y)) - R - 8 }
    const islandKeepOut = grown(island, R - 0.01, shift)
    const pocketEnvelope = grown(outer, -R + 0.01, shift)
    expect(plunge.moves.some(m => m.role === 'helix'), 'no helix on a Plunge entry').toBe(false)
    const plunges = feeds.filter(m => m.role === 'plunge')
    expect(plunges.length).toBeGreaterThan(0)
    expect(plunges.filter(m => pointInPolygon(m, islandKeepOut)), 'plunges in the island keep-out').toEqual([])
    expect(plunges.filter(m => !pointInPolygon(m, pocketEnvelope)), 'plunges outside the pocket').toEqual([])
  }, 60_000)

  it('a square with no room around its island still refuses in plain words (ADR 0003)', async () => {
    // 3 mm tool, 20 mm square, 19 mm island: no tool-centre point clears both.
    // The island-fit guard says so before the entry search is reached.
    const square = rectLoop('square', 0, 0, 20, 20)
    const island = circleLoop('island', 10, 10, 9.5, 96)
    const { status, errorMessage, moves } = await computeWithIsland(square, island)
    expect(status).toBe('error')
    expect(moves).toEqual([])
    expect(errorMessage ?? '').toMatch(/island clearance is too narrow|no island-clear entry point/)
  }, 60_000)
})
