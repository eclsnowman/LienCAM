import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Tool } from '../../types'
import {
  createDirectionService, engagedForLoop, FAMILY_POLICY, foldForSpindle, loopWindingFor, materialSideFor,
  normalizeCutHand, NOTICE_FOLLOWS_DRAWING, NOTICE_NESTING_WINS, PARITY_FLAGS, readEngagedSide, resolveDirection,
  spindleForCutHand,
  type DirectionFamily, type DirectionRequest, type DirectionResolution, type LoopWinding, type MillingDirection,
} from '../../kernel/direction'
// The current engine, read-only: the parity oracle.
import * as engineRule from '../../lib/cam/millingDirection'
import {
  directionForClockwiseSpindle, directionForTool, normalizeToolCutHand, spindleRotationForTool, spindleSignForTool,
} from '../../lib/tool/cutHand'
import { resolveAdaptiveMillingDirection } from '../../lib/cam/types'
import { threadOrbitSense } from '../../lib/cam/threadHelix'
import { orbitSenseFor } from '../../lib/cam/trochoidal2d'
import {
  directionForClockwisePlanner, materialSideForClockwisePlanner, materialSideForMilling,
} from '../../cam3d/rough/millingDirection'
import { alpha3Chains, alpha3Tools } from '../benchmark/alpha3Registry'

type Hand = Tool['cutHand'] | undefined
type ToolLike = Pick<Tool, 'cutHand'>
const HANDS: Hand[] = ['right', 'left', undefined]
const DIRECTIONS: MillingDirection[] = ['climb', 'conventional']
const WINDINGS: LoopWinding[] = ['ccw', 'cw']
const BOOLS = [true, false]
const flip = (w: LoopWinding): LoopWinding => w === 'ccw' ? 'cw' : 'ccw'

interface Case { label: string; request: DirectionRequest; expected: Partial<DirectionResolution> }
interface Input { family: DirectionFamily; params: Record<string, unknown>; tool: ToolLike }

/**
 * Today's engine, field by field. Exported engine functions are called; where
 * the engine states the rule inline in a private function, the expression is
 * copied verbatim with its file and line, so the oracle is the engine's own text.
 */
function engineCases({ family, params, tool }: Input): Case[] {
  const cases: Case[] = []
  const hand = tool.cutHand
  const add = (label: string, request: Omit<DirectionRequest, 'family' | 'cutHand'>, expected: Partial<DirectionResolution>) =>
    cases.push({ label, request: { family, cutHand: hand, ...request }, expected })
  const dir = params.direction as MillingDirection
  switch (family) {
    case 'contour': case 'chamfer': {
      // contour2d.ts:450-476 / chamfer2d.ts:107,191: needsReverse = loopWindingFor(planner, isOuter) === 'cw' on CCW offsets.
      const planner = directionForTool(dir, tool)
      for (const isOuter of BOOLS) add(`closed isOuter=${isOuter}`,
        { preference: dir, loop: { closed: true, winding: 'ccw' }, material: { source: 'side-parameter', inside: isOuter } },
        { planner, materialSide: engineRule.materialSideFor(planner), winding: engineRule.loopWindingFor(planner, isOuter),
          reverse: engineRule.loopWindingFor(planner, isOuter) === 'cw' })
      // chamfer2d.ts:177-179: with no loopSides override the side comes from nesting (holes inner, else outer).
      if (family === 'chamfer') for (const nesting of ['outer', 'hole'] as const) {
        const isOuter = nesting !== 'hole'
        add(`nesting ${nesting}`,
          { preference: dir, loop: { closed: true, winding: 'ccw' }, material: { source: 'nesting', nesting } },
          { planner, winding: engineRule.loopWindingFor(planner, isOuter), reverse: engineRule.loopWindingFor(planner, isOuter) === 'cw' })
      }
      if (family === 'contour') for (const openSide of ['left', 'right'] as const) {
        // contour2d.ts:336-341
        const forwardMaterialSide = openSide === 'right' ? 'left' : 'right'
        add(`open side=${openSide}`,
          { preference: dir, loop: { closed: false }, material: { source: 'side-parameter', sideOfDrawn: forwardMaterialSide } },
          { planner, reverse: forwardMaterialSide !== engineRule.materialSideFor(planner) })
      }
      break
    }
    case 'bore': {
      // bore2d.ts:124-127 orbitIsCCW = loopWindingFor(direction, false) === 'ccw', direction = directionForTool (bore2d.ts:270).
      const planner = directionForTool(dir, tool)
      add('orbit', { preference: dir }, { planner, orbitSense: engineRule.loopWindingFor(planner, false) === 'ccw' ? 1 : -1 })
      break
    }
    case 'thread': {
      const cut = params.cutDirection as MillingDirection
      const kind = params.threadKind as 'internal' | 'external'
      add(`orbit ${kind}`, { preference: cut, material: { source: 'side-parameter', inside: kind === 'external' } },
        { orbitSense: threadOrbitSense(kind, cut, spindleSignForTool(tool)) })
      break
    }
    case 'trochoid':
      add('orbit', { preference: dir }, { orbitSense: orbitSenseFor(directionForTool(dir, tool)) })
      break
    case 'engrave': {
      // engrave2d/index.ts:162-164, 213, 231-234
      const planner = dir === 'as_drawn' as string ? 'as_drawn' : directionForTool(dir, tool)
      const orbit = orbitSenseFor(planner === 'as_drawn' ? directionForTool('climb', tool) : planner)
      add('orbit', { preference: dir, role: 'orbit' }, { planner, orbitSense: orbit })
      for (const given of WINDINGS) {
        const isCCW = given === 'ccw'
        const reverse = planner !== 'as_drawn' && isCCW !== (planner === 'conventional')
        add(`closed ${given}`, { preference: dir, loop: { closed: true, winding: given } },
          { planner, reverse, ...(planner === 'as_drawn' ? {} : { winding: reverse ? flip(given) : given }) })
      }
      add('open', { preference: dir, loop: { closed: false } }, { planner, reverse: false })
      // engrave2d/index.ts:224-235: only closed curves are turned for the direction; an open
      // stroke keeps its drawn order (the orderer may flip it for travel, never for the side).
      for (const sideOfDrawn of ['left', 'right'] as const) add(`open stock ${sideOfDrawn}`,
        { preference: dir, loop: { closed: false }, material: { source: 'side-parameter', sideOfDrawn } }, { planner, reverse: false })
      break
    }
    case 'pocket': {
      // pocket2d.ts:2205 useClimb; :737-739 orientRoughRing (climb -> CCW); :1340-1341 / :1570-1571
      // island walls (climb -> CW); :1493 outer wall (climb keeps the path).
      const useClimb = directionForTool(dir, tool) !== 'conventional'
      for (const fill of ['outside_in', 'inside_out'] as const) add(`rough ring ${fill}`,
        { preference: dir, role: 'pocket-rough-ring', fill }, { winding: useClimb ? 'ccw' : 'cw' })
      add('island wall', { preference: dir, role: 'pocket-island-wall' }, { winding: useClimb ? 'cw' : 'ccw' })
      for (const given of WINDINGS) add(`outer wall ${given}`, { preference: dir, role: 'pocket-outer-wall', loop: { closed: true, winding: given } },
        { reverse: !useClimb, winding: useClimb ? given : flip(given) })
      break
    }
    case 'face': {
      // face2d/index.ts:189-191 plannerDirection; :367-373 bothWays / oneWayPlusX; :1067-1068 rings
      // (climb -> CCW); :420 + :955-957 spiral.
      const d = params.direction as MillingDirection | 'both_ways'
      const plannerDirection = d === 'both_ways' ? 'both_ways' : directionForTool(d, tool)
      const oneWayPlusX = plannerDirection !== 'conventional'
      for (const pattern of ['linear', 'zigzag', 'one_way'] as const) {
        const bothWays = pattern === 'zigzag' ? true : pattern === 'one_way' ? false : plannerDirection === 'both_ways'
        add(`pattern ${pattern}`, { preference: d, role: pattern === 'one_way' ? 'face-one-way' : `face-${pattern}` },
          bothWays ? { engaged: 'both' } : { travelPlusX: oneWayPlusX })
      }
      add('offset rings', { preference: d, role: 'face-offset' }, { winding: oneWayPlusX ? 'ccw' : 'cw' })
      const spiralClimb = directionForTool(d === 'both_ways' ? 'climb' : d, tool) === 'climb'
      add('spiral', { preference: d, role: 'face-spiral' }, { winding: spiralClimb ? 'ccw' : 'cw' })
      break
    }
    case 'adaptive2d': {
      // adaptiveClearing2d/engine/index.ts:108-111
      const bit = params.climb as boolean | undefined
      const planner = directionForTool(resolveAdaptiveMillingDirection(bit), tool)
      for (const inside of BOOLS) add(`loop inside=${inside}`,
        { adaptiveStoredBit: bit, loop: { closed: true }, material: { source: 'side-parameter', inside } },
        { selected: resolveAdaptiveMillingDirection(bit), planner, materialSide: engineRule.materialSideFor(planner),
          winding: engineRule.loopWindingFor(planner, inside) })
      break
    }
    case 'adaptive3d': case 'rest3d': case 'wallCleanup3d': {
      // cam3d/rough/millingDirection.ts; adaptiveRough.ts:1207-1213 (missing -> climb); wallCleanup.ts:193.
      const spindle = spindleRotationForTool(tool)
      const selected = family === 'adaptive3d' ? dir ?? 'climb' : dir
      const planner = directionForClockwisePlanner(selected, spindle)
      add('loop', { preference: dir }, { selected, planner, materialSide: materialSideForMilling(selected, spindle) })
      expect(materialSideForClockwisePlanner(planner)).toBe(materialSideForMilling(selected, spindle))
      break
    }
    case 'waterline': {
      // waterline/loops.ts:221-234 (classifyLevel), spindle = spindleRotationForTool (waterline3dOperation.ts:187).
      const spindle = spindleRotationForTool(tool)
      const wantMaterialOnRight = (dir === 'climb') === (spindle === 'cw')
      for (const materialInside of BOOLS) for (const given of WINDINGS) {
        const ccw = given === 'ccw'
        const materialOnRight = materialInside !== ccw
        add(`probe inside=${materialInside} ${given}`,
          { preference: dir, loop: { closed: true, winding: given }, material: { source: 'probe', inside: materialInside } },
          { reverse: materialOnRight !== wantMaterialOnRight })
      }
      break
    }
    case 'scallop':
      // scallop/index.ts:295-297 orientPath: climb wants clockwise, cutter hand not read.
      for (const given of WINDINGS) add(`ring ${given}`, { preference: dir, loop: { closed: true, winding: given } },
        { reverse: (given === 'cw') !== (dir === 'climb'), foldApplied: false })
      break
    case 'pencil':
      // pencil/index.ts:475 conventional reverses the traced pass, cutter hand not read.
      add('trace', { preference: dir, loop: { closed: false } }, { reverse: dir === 'conventional', foldApplied: false })
      break
  }
  return cases
}

function mismatches(cases: Case[], flags = PARITY_FLAGS) {
  const out: string[] = []
  for (const c of cases) {
    const got = resolveDirection(c.request, flags) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(c.expected)) {
      if (got[key] !== value) out.push(`${c.request.family} ${c.label} ${JSON.stringify(c.request)}: ${key} ${String(got[key])} != engine ${String(value)}`)
    }
  }
  return out
}

function gridInputs(): Input[] {
  const inputs: Input[] = []
  for (const cutHand of HANDS) {
    const tool = { cutHand } as ToolLike
    for (const direction of DIRECTIONS) {
      for (const family of ['contour', 'chamfer', 'bore', 'trochoid', 'engrave', 'pocket', 'face', 'adaptive3d',
        'rest3d', 'wallCleanup3d', 'waterline', 'scallop', 'pencil'] as DirectionFamily[]) inputs.push({ family, params: { direction }, tool })
      for (const threadKind of ['internal', 'external']) inputs.push({ family: 'thread', params: { cutDirection: direction, threadKind }, tool })
    }
    inputs.push({ family: 'face', params: { direction: 'both_ways' }, tool })
    inputs.push({ family: 'engrave', params: { direction: 'as_drawn' }, tool })
    for (const climb of [true, false, undefined]) inputs.push({ family: 'adaptive2d', params: { climb }, tool })
    inputs.push({ family: 'adaptive3d', params: { direction: undefined }, tool })
  }
  return inputs
}

const OP_FAMILY: Partial<Record<string, DirectionFamily>> = {
  contour_2d: 'contour', chamfer: 'chamfer', bore: 'bore', thread_mill: 'thread', engrave: 'engrave',
  pocket_2d: 'pocket', face: 'face', adaptive_clearing_2d: 'adaptive2d', adaptive_3d: 'adaptive3d',
  waterline_3d: 'waterline', scallop_3d: 'scallop', pencil_3d: 'pencil', steep_shallow_3d: 'waterline',
}

describe('WO-3003 kernel direction service at parity', () => {
  it('re-hosts the shared rule and the cut-hand fold exactly', () => {
    for (const direction of DIRECTIONS) {
      expect(materialSideFor(direction)).toBe(engineRule.materialSideFor(direction))
      for (const inside of BOOLS) expect(loopWindingFor(direction, inside)).toBe(engineRule.loopWindingFor(direction, inside))
      for (const spindle of ['cw', 'ccw'] as const) expect(foldForSpindle(direction, spindle)).toBe(directionForClockwiseSpindle(direction, spindle))
    }
    for (const value of ['left', 'right', undefined, null, 'LEFT', 42, {}]) {
      expect(normalizeCutHand(value)).toBe(normalizeToolCutHand(value))
      expect(spindleForCutHand(value)).toBe(spindleRotationForTool({ cutHand: value as Tool['cutHand'] }))
    }
    for (const bad of ['both', undefined, 'auto']) {
      expect(() => materialSideFor(bad as MillingDirection)).toThrow()
      expect(() => engineRule.materialSideFor(bad as MillingDirection)).toThrow()
    }
  })

  it('equals the current engine on every family, direction, cutter hand and loop fact (flags off)', () => {
    const cases = gridInputs().flatMap(engineCases)
    expect(cases.length).toBeGreaterThan(200)
    expect(mismatches(cases)).toEqual([])
  })

  it('equals the current engine on every direction-bearing step of the P0 fixtures and records parity.json', () => {
    const tools = new Map(alpha3Tools().map(tool => [tool.id, tool]))
    const rows: { chain: string; step: string; type: string; family?: DirectionFamily; cutHand: string; direction: unknown; cases: number; equal: boolean; mismatches: string[] }[] = []
    for (const chain of alpha3Chains()) for (const step of chain.steps) {
      const params = step.params as Record<string, unknown>
      const tool = { cutHand: tools.get(step.toolId)?.libraryTool?.cutHand } as ToolLike
      let family = OP_FAMILY[step.type]
      const direction = step.type === 'adaptive_clearing_2d' ? { climb: params.climb }
        : step.type === 'thread_mill' ? { cutDirection: params.cutDirection, threadKind: params.threadKind }
        : step.type === 'adaptive_3d' ? params.millingDirection
        : step.type === 'steep_shallow_3d' ? 'climb (steepShallow3dOperation.ts:104)' : params.direction
      if (step.type === 'engrave' && params.engraveStyle === 'trochoidal' && params.mode === 'trace' && params.side === 'center') family = 'trochoid'
      const input: Input | undefined = !family ? undefined
        : step.type === 'adaptive_3d' ? { family, params: { direction: params.millingDirection }, tool }
        : step.type === 'steep_shallow_3d' ? { family, params: { direction: 'climb' }, tool }
        : family === 'trochoid' && params.direction === 'as_drawn' ? { family: 'engrave', params, tool }
        : { family, params, tool }
      const cases = input ? engineCases(input) : []
      const bad = mismatches(cases)
      rows.push({ chain: chain.id, step: step.id, type: step.type, family, cutHand: normalizeToolCutHand(tool.cutHand),
        direction, cases: cases.length, equal: bad.length === 0, mismatches: bad })
    }
    const covered = rows.filter(row => row.family)
    const summary = {
      order: 'WO-3003', flags: PARITY_FLAGS,
      steps: rows.length, directionSteps: covered.length, cases: covered.reduce((n, row) => n + row.cases, 0),
      allEqual: covered.every(row => row.equal),
      noDirectionInput: [...new Set(rows.filter(row => !row.family).map(row => row.type))].sort(),
      families: [...new Set(covered.map(row => row.family))].sort(),
      rows,
    }
    mkdirSync('src/tests/evidence/WO-3003', { recursive: true })
    writeFileSync('src/tests/evidence/WO-3003/parity.json', JSON.stringify(summary, null, 1) + '\n')
    expect(covered.length).toBeGreaterThan(50)
    expect(covered.flatMap(row => row.mismatches)).toEqual([])
    expect(covered.every(row => row.cases > 0)).toBe(true)
  })

  it('folds a left-hand cutter to the mirror orientation in every folding family', () => {
    for (const [family, policy] of Object.entries(FAMILY_POLICY) as [DirectionFamily, typeof FAMILY_POLICY[DirectionFamily]][]) {
      const request: DirectionRequest = family === 'adaptive2d' ? { family, adaptiveStoredBit: false } : { family, preference: 'climb' }
      const right = resolveDirection({ ...request, cutHand: 'right' })
      const left = resolveDirection({ ...request, cutHand: 'left' })
      expect(right.foldApplied).toBe(false)
      expect(left.foldApplied, family).toBe(policy.fold)
      expect(left.planner, family).toBe(policy.fold ? 'conventional' : 'climb')
      // MD-72 (carded): scallop and pencil fold only with the flag on.
      const folded = resolveDirection({ ...request, cutHand: 'left' }, { fold_all_finishes: true })
      expect(folded.planner, family).toBe('conventional')
      expect(folded.foldApplied).toBe(true)
    }
  })

  it('says "follows the drawing" once for as-drawn and side-less open curves, and never refuses', () => {
    const service = createDirectionService()
    for (let i = 0; i < 5; i++) {
      const asDrawn = service.resolve({ family: 'engrave', preference: 'as_drawn', loop: { closed: false } })
      expect(asDrawn).toMatchObject({ reverse: false, engaged: 'follows-drawing' })
      expect(service.resolve({ family: 'contour', preference: 'climb', loop: { closed: false } }).engaged).toBe('follows-drawing')
    }
    expect(service.notices()).toEqual([NOTICE_FOLLOWS_DRAWING])
    // A loop wound against its nesting proceeds with the nesting and says so once.
    // Nesting alone decides the side (chamfer2d.ts:177-191: outer loops cut as outer, holes as inner).
    const nested = service.resolve({ family: 'chamfer', preference: 'climb', loop: { closed: true, winding: 'cw' },
      material: { source: 'nesting', nesting: 'outer' } })
    expect(nested).toMatchObject({ winding: 'cw', reverse: false, engaged: 'climb', labelMatchesEngaged: true })
    service.resolve({ family: 'chamfer', preference: 'climb', loop: { closed: true, winding: 'cw' }, material: { source: 'nesting', nesting: 'outer' } })
    expect(service.notices()).toEqual([NOTICE_FOLLOWS_DRAWING, NOTICE_NESTING_WINS])
    expect(resolveDirection({ family: 'chamfer', preference: 'climb', loop: { closed: true, winding: 'cw' }, material: { source: 'nesting', nesting: 'hole' } }))
      .toMatchObject({ winding: 'ccw', reverse: true, engaged: 'climb' })
    expect(resolveDirection({ family: 'chamfer', preference: 'climb', cutHand: 'left', loop: { closed: true, winding: 'ccw' }, material: { source: 'nesting', nesting: 'outer' } }))
      .toMatchObject({ winding: 'ccw', reverse: false, engaged: 'climb' })
    // Zigzag and both-ways passes proceed and report both sides; auto proceeds as climb.
    expect(resolveDirection({ family: 'face', preference: 'both_ways' }).engaged).toBe('both')
    expect(resolveDirection({ family: 'face', preference: 'climb', role: 'face-zigzag' }).engaged).toBe('both')
    expect(resolveDirection({ family: 'contour', preference: 'auto' }).planner).toBe('climb')
  })

  it('reports today\'s engaged sides, including the mismatched rows, and the carded flags correct them', () => {
    // BL-397: pocket outside-in rings and facing rings labelled climb engage conventional today.
    const ring = resolveDirection({ family: 'pocket', preference: 'climb', role: 'pocket-rough-ring', fill: 'outside_in' })
    expect(ring).toMatchObject({ winding: 'ccw', engaged: 'conventional', labelMatchesEngaged: false })
    expect(resolveDirection({ family: 'pocket', preference: 'climb', role: 'pocket-rough-ring', fill: 'inside_out' }))
      .toMatchObject({ winding: 'ccw', engaged: 'climb', labelMatchesEngaged: true })
    expect(resolveDirection({ family: 'face', preference: 'climb', role: 'face-offset' }))
      .toMatchObject({ winding: 'ccw', labelMatchesEngaged: false })
    // An open engrave stroke keeps its drawn order at parity; the engaged side is reported, not corrected.
    expect(resolveDirection({ family: 'engrave', preference: 'climb', loop: { closed: false }, material: { source: 'side-parameter', sideOfDrawn: 'left' } }))
      .toMatchObject({ reverse: false, engaged: 'conventional', labelMatchesEngaged: false })
    // GAP-032: a left-hand cutter on scallop engages the opposite side today.
    expect(resolveDirection({ family: 'scallop', preference: 'climb', cutHand: 'left', loop: { closed: true }, material: { source: 'probe', inside: true } }))
      .toMatchObject({ winding: 'cw', engaged: 'conventional', labelMatchesEngaged: false })
    // RC-005: Adaptive 2D with no stored bit cuts conventional today; MD-73 makes it climb.
    expect(resolveDirection({ family: 'adaptive2d' }).selected).toBe('conventional')
    expect(resolveDirection({ family: 'adaptive2d' }, { adaptive2d_default_climb: true }).selected).toBe('climb')
    expect(resolveDirection({ family: 'adaptive2d', adaptiveStoredBit: true }, { adaptive2d_default_climb: true }).selected).toBe('conventional')
    // With labels_mean_engaged_side every ring engages its label, either hand, either direction.
    for (const cutHand of ['right', 'left']) for (const preference of DIRECTIONS) {
      for (const fill of ['outside_in', 'inside_out'] as const) {
        expect(resolveDirection({ family: 'pocket', preference, cutHand, fill }, { labels_mean_engaged_side: true }).labelMatchesEngaged).toBe(true)
      }
      for (const role of ['face-offset', 'face-spiral'] as const) {
        expect(resolveDirection({ family: 'face', preference, cutHand, role }, { labels_mean_engaged_side: true }).labelMatchesEngaged).toBe(true)
      }
    }
    // The material-side families engage their label in every case today.
    for (const family of ['contour', 'chamfer', 'adaptive2d', 'adaptive3d', 'waterline'] as const) {
      for (const cutHand of ['right', 'left']) for (const preference of DIRECTIONS) for (const inside of BOOLS) {
        const request: DirectionRequest = family === 'adaptive2d'
          ? { family, adaptiveStoredBit: preference !== 'climb', cutHand, loop: { closed: true }, material: { source: 'side-parameter', inside } }
          : { family, preference, cutHand, loop: { closed: true }, material: { source: 'side-parameter', inside } }
        expect(resolveDirection(request).labelMatchesEngaged, `${family} ${cutHand} ${preference} ${inside}`).toBe(true)
      }
    }
  })

  it('ships every carded flag off, frozen, and resolves deterministically with no store or DOM', () => {
    expect(PARITY_FLAGS).toEqual({ adaptive2d_default_climb: false, labels_mean_engaged_side: false, fold_all_finishes: false })
    expect(Object.isFrozen(PARITY_FLAGS)).toBe(true)
    expect(createDirectionService().flags).toEqual(PARITY_FLAGS)
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
    const cases = gridInputs().flatMap(engineCases)
    const first = JSON.stringify(cases.map(c => resolveDirection(c.request)))
    const second = JSON.stringify(cases.map(c => resolveDirection(c.request)))
    expect(second).toBe(first)
  })

  it('reads the engaged side from standing stock alone (assertion helper)', () => {
    // A 10 mm square walked CCW around stock that fills it: material on the left.
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]
    const inside = (x: number, y: number) => x > 0 && x < 10 && y > 0 && y < 10
    const reading = readEngagedSide(square, inside, 'cw', 0.5)
    expect(reading).toMatchObject({ materialSide: 'left', engaged: 'conventional' })
    expect(reading.engaged).toBe(engagedForLoop('ccw', true, 'cw'))
    expect(readEngagedSide([...square].reverse(), inside, 'cw', 0.5).engaged).toBe('climb')
    expect(readEngagedSide(square, inside, 'ccw', 0.5).engaged).toBe('climb')
    expect(readEngagedSide(square, () => false, 'cw', 0.5).engaged).toBe('unknown')
  })
})
