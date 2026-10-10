import { describe, it, expect } from 'vitest'
import { buildEngraveToolpath } from '../../lib/cam/engrave2d'
import type { EngraveParams, EngraveWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// WO-1891: an OPEN engraving stroke may be cut in reverse when its far end is
// nearer the tool, so text and logos carry less lifted travel. CLOSED loops keep
// their direction; the chosen order never plans more travel than the legacy one.

function makeTool(over: Partial<Tool> = {}): Tool {
  return {
    id: 't1', name: 'engraver', type: 'flat_end_mill',
    diameter: 3, fluteLength: 12, shankDiameter: 3, overallLength: 40,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300 } },
    ...over,
  } as Tool
}

function makeHeights(bottom = -2): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes = (stepdown = 5): PassParams => ({
  stepdown, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0,
})

const linking = (over: Partial<LinkingParams> = {}): LinkingParams => ({
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height', ...over,
})

function makeParams(over: Partial<EngraveParams> = {}): EngraveParams {
  return {
    geometryId: '', loopIds: [], includeOpen: true, includeClosed: true,
    mode: 'trace', depthModel: 'constant',
    side: 'center', sideOffset: 0, axialOffset: 0,
    targetLineWidth: 0, useWidthForDepth: false,
    direction: 'as_drawn', tolerance: 0.01,
    ...over,
  }
}

function payload(params: EngraveParams, loops: LoopData[],
  heights = makeHeights(), pp = passes(), link = linking()): EngraveWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights, passes: pp, linking: link,
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

type Move = ReturnType<typeof buildEngraveToolpath>[number]
const cuts = (m: Move[]) => m.filter(x => x.role === 'cut')

/** Total XY distance travelled on rapid moves (the lifted travel we care about). */
function rapidXY(moves: Move[]): number {
  let total = 0, px = 0, py = 0
  for (const m of moves) {
    if (m.type === 'rapid') total += Math.hypot(m.x - px, m.y - py)
    px = m.x; py = m.y
  }
  return total
}

const legacy = (p: EngraveWorkerPayload) => rapidXY(buildEngraveToolpath(p, undefined, { reverseOpen: false }))
const reversed = (p: EngraveWorkerPayload) => rapidXY(buildEngraveToolpath(p, undefined, { reverseOpen: true }))

// Two open strokes laid end to end. The first runs +X; the second is drawn
// "backwards" (starts at its far end), so today's order rapids out to x=20 and
// cuts back, while reverse entry starts where the first stroke finished.
const strokeA: LoopData = {
  id: 'A', closed: false, type: 'open',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
}
const strokeBBackwards: LoopData = {
  id: 'B', closed: false, type: 'open',
  points: [{ x: 20, y: 0 }, { x: 10, y: 0 }],
}

// A small open-stroke "text" sample (letter E), strokes drawn in mixed
// directions so reversal has room to help.
const textSample: LoopData[] = [
  { id: 'spine', closed: false, type: 'open', points: [{ x: 0, y: 0 }, { x: 0, y: 10 }] },
  { id: 'top',   closed: false, type: 'open', points: [{ x: 8, y: 10 }, { x: 0, y: 10 }] },
  { id: 'mid',   closed: false, type: 'open', points: [{ x: 0, y: 5 }, { x: 8, y: 5 }] },
  { id: 'bot',   closed: false, type: 'open', points: [{ x: 8, y: 0 }, { x: 0, y: 0 }] },
]

const closedRect: LoopData = {
  id: 'R', closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
}

describe('WO-1891 — engraving enters an open stroke from its nearer end', () => {
  it('acceptance 1: reversal drops travel and each stroke is cut fully once', () => {
    const p = payload(makeParams({ includeClosed: false }), [strokeA, strokeBBackwards])
    const before = legacy(p)
    const after = reversed(p)
    expect(after).toBeLessThan(before)

    const c = cuts(buildEngraveToolpath(p, undefined, { reverseOpen: true }))
    // Stroke A (0..10) cut as drawn, then stroke B entered at its near end
    // (10) and cut out to its far end (20): each stroke fully once, no re-cut.
    expect(c.map(m => m.x)).toEqual([0, 10, 10, 20])
    expect(c.length).toBe(4)
  })

  it('acceptance 2: closed loops are byte-identical to the legacy order', () => {
    const p = payload(makeParams({ includeClosed: true, includeOpen: false }), [closedRect])
    expect(buildEngraveToolpath(p, undefined, { reverseOpen: true }))
      .toEqual(buildEngraveToolpath(p, undefined, { reverseOpen: false }))
  })

  it('acceptance 3: a text sample rapid distance never increases', () => {
    const p = payload(makeParams({ includeClosed: false }), textSample)
    const before = legacy(p)
    const after = reversed(p)
    expect(after).toBeLessThanOrEqual(before)
    // record the numbers for the work order
    expect(typeof before).toBe('number')
    expect(typeof after).toBe('number')
    console.log(`WO-1891 text sample rapid XY: legacy=${before.toFixed(4)} reversed=${after.toFixed(4)}`)
  })

  it('acceptance 4: disabling reversal reproduces the legacy travel exactly', () => {
    const p = payload(makeParams({ includeClosed: false }), [strokeA, strokeBBackwards])
    const c = cuts(buildEngraveToolpath(p, undefined, { reverseOpen: false }))
    expect(c.map(m => m.x)).toEqual([0, 10, 20, 10])   // legacy: out to 20 then cut back
    expect(legacy(p)).toBe(reversed(p) + 10)            // far-end entry accounts for the 10mm saved
  })

  // Regression (audit): offsetOpenChain offsets relative to travel direction, so
  // a reversed open stroke used to land on the OPPOSITE physical side of the
  // drawn line when side compensation is on. The chosen cut geometry must be
  // identical to main's; only entry order/travel may change.
  for (const side of ['left', 'right'] as const) {
    it(`side compensation (${side}) keeps the same physical cut geometry after reversal`, () => {
      const p = payload(
        makeParams({ includeClosed: false, side, sideOffset: 1 }),
        [strokeA, strokeBBackwards],
      )
      const legacyCuts = cuts(buildEngraveToolpath(p, undefined, { reverseOpen: false }))
      const revCuts = cuts(buildEngraveToolpath(p, undefined, { reverseOpen: true }))

      // Reversal must actually be taken for this payload (otherwise the check
      // is vacuous): the second stroke is entered at its near end (x=10).
      expect(revCuts.map(m => m.x)).toEqual([0, 10, 10, 20])

      const key = (m: Move) => `${m.x.toFixed(6)},${m.y.toFixed(6)}`
      const legacySet = [...new Set(legacyCuts.map(key))].sort()
      const revSet = [...new Set(revCuts.map(key))].sort()
      expect(revSet).toEqual(legacySet)
      // Sanity: the offset really moved off the drawn centreline (y=0).
      expect(legacyCuts.every(m => Math.abs(m.y) === 1)).toBe(true)
    })
  }
})
