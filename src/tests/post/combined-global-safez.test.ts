// ============================================================
// Combined multi-setup GLOBAL safe-Z retract (multi-fixture crash fix)
// ============================================================
// emitCombinedProgram previously lifted between work offsets to the OUTGOING
// setup's OWN work-relative safe Z. When the next setup sits on a taller fixture
// / higher stock (higher wcs.origin.z), that height can be BELOW the next
// setup's stock top in MACHINE space -> the subsequent XY rapid could crash.
//
// The fix retracts between offsets to a GLOBAL safe height: the max clearance
// across ALL setups taken in a COMMON world/machine frame (each setup's safe
// work-Z lifted to world via toWorld), then re-expressed in the OUTGOING setup's
// work frame via toWork. Sequencing (lift -> offset change -> XY) is unchanged;
// only the inter-section retract HEIGHT changes.
//
// These tests assert:
//  1. Same clearance height across both setups -> byte-identical to today.
//  2. Setup B on a higher stock/origin -> setup A's inter-section retract is
//     RAISED to the global max in world space (clears setup B's stock top).
//  3. No G53 Z0 is introduced.

import { describe, it, expect } from 'vitest'
import { emitCombinedProgram } from '../../lib/post/emit'
import { toWork, toWorld } from '../../lib/post/coords'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'
import type { PostInput, PostOperation, PostConfig } from '../../lib/post/types'
import type { Tool, ToolpathMove, WCS } from '../../types'

// Compose a single-op PostInput on a given WCS + tool with hand-built moves,
// mirroring the buildPostInput resolution path (feeds/spindle/coolant).
function makeSetupInput(
  wcs: WCS,
  opId: string,
  opName: string,
  tool: Tool,
  moves: ToolpathMove[],
): PostInput {
  const machine = makeMachine({ coolant: true })
  const op = makeOp({ id: opId, name: opName, toolId: tool.id, toolpathMoves: moves })
  const postOp: PostOperation = {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  }
  return { machine, setup: { wcs, operations: [postOp] } }
}

// The single shared tool keeps both setups on the SAME tool so the inter-section
// boundary does NOT take the tool-change retract path -- the trailing retract is
// then the ONLY inter-section Z lift, so we can assert its height directly.
function sameToolSetups(
  wcsA: WCS,
  wcsB: WCS,
  movesA: ToolpathMove[],
  movesB: ToolpathMove[],
): [PostInput, PostInput] {
  const tool = makeTool({ id: 'tShared', toolNumber: 1 })
  const a = makeSetupInput(wcsA, 'op-a', 'Setup A', tool, movesA)
  const b = makeSetupInput(wcsB, 'op-b', 'Setup B', tool, movesB)
  return [a, b]
}

const cfg: PostConfig = UCCNC_CONFIG

// The inter-section trailing retract is the LAST `G0 Z<n>` line that appears
// BEFORE the second setup's work-offset select (G55). Returns its numeric Z.
function interSectionRetractZ(lines: string[]): number {
  const g55Idx = lines.findIndex((l) => l.trim() === 'G55')
  expect(g55Idx).toBeGreaterThan(0)
  // Walk backward from G55 to the nearest Z-only G0 (the trailing retract).
  for (let i = g55Idx - 1; i >= 0; i--) {
    const m = /^G0 Z(-?\d+(?:\.\d+)?)$/.exec(lines[i].trim())
    if (m) return parseFloat(m[1])
  }
  throw new Error('no inter-section G0 Z retract found before G55')
}

describe('emitCombinedProgram — global safe-Z inter-section retract', () => {
  it('same clearance height + same origin -> byte-identical inter-section retract', () => {
    // Both setups: same WCS origin z=0, both top out at work Z=5.
    const wcsA = makeWcs({ id: 'wA', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 } })
    const wcsB = makeWcs({ id: 'wB', label: 'G55', fixtureOffset: 55, origin: { x: 0, y: 0, z: 0 } })
    const [a, b] = sameToolSetups(
      wcsA,
      wcsB,
      [
        move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
      ],
      [
        move({ type: 'rapid', x: 40, y: 60, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 40, y: 60, z: 3, feed: 2000, role: 'cut' }),
      ],
    )
    const { lines } = emitCombinedProgram([a, b], cfg, { pauseBetweenSetups: false })
    // Setup A alone retracts to its local safe work-Z = 5; global max world Z = 5;
    // converted back into A's frame (origin 0) = 5. Byte-identical.
    expect(interSectionRetractZ(lines)).toBe(5)
  })

  it('setup B higher (origin.z) -> setup A inter-section retract RAISED to global max, clears B stock top', () => {
    // Setup A: origin z=0, safe work-Z = 5  -> world safe Z = 5.
    // Setup B: origin z=20 (taller fixture), safe work-Z = 5 -> world safe Z = 25.
    // Global max world safe Z = 25. Setup A's inter-section retract must lift to
    // 25 in A's work frame (origin 0) = 25, NOT its local 5.
    const wcsA = makeWcs({ id: 'wA', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 } })
    const wcsB = makeWcs({ id: 'wB', label: 'G55', fixtureOffset: 55, origin: { x: 0, y: 0, z: 20 } })
    const [a, b] = sameToolSetups(
      wcsA,
      wcsB,
      [
        move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
      ],
      // World Z 25 = clearance (work 5 over origin 20); cut at world Z 22.
      [
        move({ type: 'rapid', x: 40, y: 60, z: 25, role: 'rapid' }),
        move({ type: 'feed', x: 40, y: 60, z: 22, feed: 2000, role: 'cut' }),
      ],
    )
    const { lines } = emitCombinedProgram([a, b], cfg, { pauseBetweenSetups: false })

    const retractZ = interSectionRetractZ(lines)

    // Old per-setup behavior would have used setup A's local safe work-Z = 5.
    const setupALocalSafeWorkZ = 5
    expect(retractZ).toBeGreaterThan(setupALocalSafeWorkZ)

    // The retract Z is under setup A's offset (work coords). Convert it to WORLD
    // (toWorld via A's WCS) and confirm it clears setup B's stock-top in MACHINE
    // space. Setup B's highest move is world Z = 25 (its clearance plane).
    const retractWorldZ = toWorld({ x: 0, y: 0, z: retractZ }, wcsA).z
    const setupBStockTopWorldZ = 25
    expect(retractWorldZ).toBeGreaterThanOrEqual(setupBStockTopWorldZ)

    // Exact: global max world Z = 25 -> in A's work frame (origin 0) = 25.
    const expectedWorkZ = toWork({ x: 0, y: 0, z: 25 }, wcsA).z
    expect(retractZ).toBe(expectedWorkZ)
    expect(retractZ).toBe(25)
  })

  it('introduces NO G53 (no machine-zero plunge) in the combined program', () => {
    const wcsA = makeWcs({ id: 'wA', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 } })
    const wcsB = makeWcs({ id: 'wB', label: 'G55', fixtureOffset: 55, origin: { x: 0, y: 0, z: 20 } })
    const [a, b] = sameToolSetups(
      wcsA,
      wcsB,
      [move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }), move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' })],
      [move({ type: 'rapid', x: 40, y: 60, z: 25, role: 'rapid' }), move({ type: 'feed', x: 40, y: 60, z: 22, feed: 2000, role: 'cut' })],
    )
    const { lines } = emitCombinedProgram([a, b], cfg, { pauseBetweenSetups: false })
    expect(lines.some((l) => l.includes('G53'))).toBe(false)
  })
})
