import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import type { Import2DResult } from '../../lib/import/svgImporter'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type {
  PocketParams, PocketWorkerPayload, LoopData,
} from '../../lib/cam/types'

// Pocket ring generation goes through clipper2 offsetLoop (same as the worker,
// which awaits this before COMPUTE_POCKET) — load it before exercising builders.
await ensureClipperReady()
import type { Loop2D } from '../../types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// ─────────────────────────────────────────────────────────────────────────────
// STABLE LOOP-ID reproduction (B19c recurrence prevention).
//
// PROVEN ROOT CAUSE (docs/planning/STABLE-LOOP-ID-PLAN.md): loop ids are
// crypto.randomUUID() minted FRESH on every loop derivation at
// src/lib/geometry/path2d.ts:150 (joinSegments). importDXF -> joinSegments ->
// Loop2D[] therefore yields a DIFFERENT id for the same geometric loop on every
// re-derive. An op's stored params.loopIds then orphan and the builder either
// fails loud (B19c net) or emits 0 moves.
//
// Import -> loops call chain used here:
//   importDXF(dxfText)                     src/lib/import/dxfImporter.ts:216
//     -> joinSegments(segs, layerName)     src/lib/geometry/path2d.ts (mints id
//                                          via crypto.randomUUID() at :150)
//     -> centerLoops(allLoops)             src/lib/geometry/path2d.ts:184
//   => Import2DResult.loops : Loop2D[]     {id, points, closed, type, layerId, area}
//
// CASE 1 is GREEN now and after the fix (sanity).
// CASE 2 + CASE 3 are RED now (bug reproduces) and GREEN after stable ids land.
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const dxfPath = join(here, '../../../Sample Parts/Leadscrew_Stepper_Mount.DXF')
const dxfText = readFileSync(dxfPath, 'utf8')

// Independent re-derivation of loops straight from the real DXF text. Each call
// is a fresh, independent run of the import -> joinSegments chain.
function deriveLoops(): Loop2D[] {
  const result: Import2DResult = importDXF(dxfText)
  return result.loops
}

// Largest pocketable boundary = the largest CLOSED, CONTOUR-wound loop by
// absolute area. Picked by area so the choice is geometry-driven, not
// index-driven. NB: on this real DXF the single largest-area loop (~2800 mm^2)
// is wound CW (type 'hole') so the pocket builder treats it as an island, not a
// boundary; we therefore target the largest 'contour' loop (~415 mm^2, the
// part's pocketable outline).
function largestPocketableLoop(loops: Loop2D[]): Loop2D {
  const candidates = loops.filter(l => l.closed && l.type === 'contour')
  expect(candidates.length).toBeGreaterThan(0)
  return candidates.reduce((a, b) => (b.area > a.area ? b : a))
}

const tool: Tool = {
  id: 't1', name: 'O3 flat', type: 'flat_end_mill',
  diameter: 3, fluteLength: 20, shankDiameter: 3, overallLength: 50,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as Tool

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

// Build a pocket payload that cuts `targetLoops` worth of geometry, with the op's
// stored selection = `selectionIds`. `loops` is the loop set the builder sees at
// compute time (the "current" derivation). The orphan happens when selectionIds
// were minted on a DIFFERENT derivation than `loops`.
function pocketPayload(selectionIds: string[], loops: Loop2D[]): PocketWorkerPayload {
  const loopData: LoopData[] = loops.map(l => ({
    id: l.id, points: l.points, closed: l.closed, type: l.type,
  }))
  return {
    opId: 'op', setupId: 's',
    params: {
      geometryId: 'g', loopIds: selectionIds, direction: 'climb', orderStrategy: 'by_depth',
      fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
      helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
    } as PocketParams,
    heights, passes, linking, tool, loops: loopData, wcsOrigin: { x: 0, y: 0, z: 0 },
  } as PocketWorkerPayload
}

describe('stable loop ids: real DXF re-derive orphan (B19c recurrence)', () => {
  // CASE 1 — sanity. GREEN now and after the fix.
  it('CASE 1: a pocket bound to the real DXF largest loop builds a non-zero toolpath', () => {
    const loops = deriveLoops()
    const target = largestPocketableLoop(loops)
    const moves = buildPocketToolpath(pocketPayload([target.id], loops))
    // The plan cites ~915 moves; assert non-zero and report what we measure.
    console.log(`[CASE 1] largest pocketable (contour) loop area=${target.area.toFixed(2)} mm^2, ` +
      `points=${target.points.length}, move count=${moves.length}`)
    expect(moves.length).toBeGreaterThan(0)
  })

  // CASE 2 — THE BUG, core property. RED until stable ids land.
  // Two independent derivations of the SAME DXF text must yield the SAME id for
  // the i-th loop. Today ids are random uuids, so they differ -> FAILS now.
  it('CASE 2: loop ids are STABLE across two independent re-derivations', () => {
    const a = deriveLoops()
    const b = deriveLoops()
    expect(a.length).toBe(b.length)
    expect(a.length).toBeGreaterThan(0)
    const idsA = a.map(l => l.id)
    const idsB = b.map(l => l.id)
    // RED until stable ids land: random uuids differ on every derivation.
    expect(idsB).toEqual(idsA)
  })

  // CASE 3 — end-to-end orphan. RED until stable ids land.
  // Store the selection from derivation #1, then build the pocket against
  // derivation #2's (today freshly-minted) loop set using that stored id. The
  // selection must SURVIVE the re-derive (same non-zero toolpath). Today the
  // builder fails loud ("selected loop(s) no longer exist") -> FAILS now.
  it('CASE 3: a stored selection survives a re-derive (same non-zero toolpath)', () => {
    const derive1 = deriveLoops()
    const stored = largestPocketableLoop(derive1)
    const storedId = stored.id            // saved on the op at selection time

    // Re-derive in place (fresh ids today). The op still carries storedId.
    const derive2 = deriveLoops()

    // RED until stable ids land: storedId is a derivation-#1 random uuid; no loop
    // in derive2 carries it, so buildPocketToolpath throws the B19c fail-loud
    // "no longer exist" error (or, pre-B19c, returned 0 moves).
    let moves: ReturnType<typeof buildPocketToolpath> = []
    expect(() => { moves = buildPocketToolpath(pocketPayload([storedId], derive2)) })
      .not.toThrow()
    expect(moves.length).toBeGreaterThan(0)
  })
})
