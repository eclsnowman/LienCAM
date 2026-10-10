// WO-411 slice 1 - format types, expression language, static validator,
// factory routines as data. Contract: docs/research/probe-routine-format.md.
import { describe, expect, it } from 'vitest'
import {
  CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT,
  FACTORY_BORE_CENTRE,
  FACTORY_BOSS_CENTRE,
  FACTORY_CORNER_OUTSIDE_X_MINUS_Y_MINUS,
  FACTORY_EDGE_X_MINUS,
  FACTORY_PROBE_ROUTINES,
  factoryCornerRoutine,
  factoryEdgeRoutine,
} from '../../lib/machine/probeRoutineFactory'
import {
  EXPR_MAX_PAREN_DEPTH,
  EXPR_MAX_TOKENS,
  checkExprNames,
  evaluateExpr,
  findConstantZeroDivisor,
  parseExpr,
  type ExprEvalScope,
  type ExprNameScope,
} from '../../lib/machine/probeRoutineExpr'
import {
  PROBE_ROUTINE_SCHEMA_VERSION,
  canonicalRoutineJson,
  parseProbeRoutine,
  serializeProbeRoutine,
  validateProbeRoutine,
  type ProbeRoutine,
  type RoutineError,
} from '../../lib/machine/probeRoutineFormat'

const SAMPLE_MACHINE_FEEDS = { searchMmMin: 300, finalMmMin: 50 }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function codes(errors: readonly RoutineError[]): string[] {
  return errors.map((e) => e.code)
}

/** A minimal valid user routine to mutate in the table tests. */
function minimalRoutine(): ProbeRoutine {
  return {
    schemaVersion: 1,
    id: 'user.minimal',
    name: 'Minimal',
    version: '1.0.0',
    provenance: { kind: 'user' },
    description: 'One touch, one calc.',
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [
      { name: 'searchMm', label: 'Search up to', type: 'length', unit: 'mm', min: 1, max: 50, default: 10 },
    ],
    steps: [
      { kind: 'touch', name: 'face', axis: 'X', direction: '-', searchMm: 'input.searchMm' },
      { kind: 'calc', name: 'faceX', unit: 'mm', expr: 'touch.face.x - probe.tipRadiusMm' },
    ],
    outputs: [
      { kind: 'workOffset', wcs: 'active', axes: { X: 'calc.faceX' }, label: 'Set X zero' },
    ],
  }
}

function errorsOf(json: unknown): RoutineError[] {
  const result = validateProbeRoutine(json, { profileFeeds: SAMPLE_MACHINE_FEEDS })
  return result.ok ? [] : result.errors
}

// ---------------------------------------------------------------------------

describe('WO-411 slice 1: factory routines as data', () => {
  it('ships fifteen routines: 4 edge, 4 outside corner, 4 inside corner, bore, boss, tool setter (WO-1613)', () => {
    expect(FACTORY_PROBE_ROUTINES).toHaveLength(15)
    const ids = FACTORY_PROBE_ROUTINES.map((r) => r.id)
    expect(new Set(ids).size).toBe(15)
    expect(ids.every((id) => id.startsWith('factory.'))).toBe(true)
    expect(ids.filter((id) => id.startsWith('factory.edge.'))).toHaveLength(4)
    expect(ids.filter((id) => id.startsWith('factory.corner.outside.'))).toHaveLength(4)
    expect(ids.filter((id) => id.startsWith('factory.corner.inside.'))).toHaveLength(4)
    expect(ids).toContain('factory.bore-centre')
    expect(ids).toContain('factory.boss-centre')
    expect(ids).toContain('factory.tool-setter')
  })

  it.each(FACTORY_PROBE_ROUTINES.map((r) => [r.id, r] as const))('%s validates with zero errors', (_id, routine) => {
    const result = validateProbeRoutine(routine)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('every factory routine is factory provenance, homed, full envelope; only the tool setter one asks for the setter', () => {
    for (const routine of FACTORY_PROBE_ROUTINES) {
      expect(routine.provenance).toEqual({ kind: 'factory' })
      expect(routine.requires).toEqual({
        homed: true,
        envelope: 'full',
        probe: routine.id === 'factory.tool-setter' ? 'toolSetter' : 'touch',
      })
      expect(routine.schemaVersion).toBe(PROBE_ROUTINE_SCHEMA_VERSION)
    }
  })

  // WO-2065: the side routines work from the top (design 4.1) - touch the top
  // (or, for a hole, take work Z0 / the rim), rise to top + clearance, step out,
  // descend to top - depth as a move that stops on contact, check it got there,
  // then the contract's touches at that depth.
  const TOP_SAFE_DEPTH = [
    { kind: 'touch', name: 'top', axis: 'Z', direction: '-', searchMm: 'input.topSearchMm' },
    { kind: 'calc', name: 'safeZ', unit: 'mm', expr: 'touch.top.z + probe.surfaceClearanceMm' },
    { kind: 'calc', name: 'depthZ', unit: 'mm', expr: 'touch.top.z - input.depthMm' },
  ]
  const descent = (name: string) => [
    { kind: 'move', name, frame: 'machine', to: { z: 'calc.depthZ' }, stopOnContact: true },
    { kind: 'check', condition: { cmp: '<=', left: `touch.${name}.z`, right: 'calc.depthZ + 0.001' }, message: expect.stringContaining('The descent to probing depth touched something above that depth') },
  ]
  const namesOf = (r: ProbeRoutine) => r.steps.map((s) => ('name' in s && s.name ? s.name : s.kind))
  const stepNamed = (r: ProbeRoutine, name: string) => r.steps.find((s) => 'name' in s && s.name === name)

  it('the edge X- routine: top, safe height, step out, guarded descent, then the contract\'s section 3.1 touch', () => {
    expect(FACTORY_EDGE_X_MINUS.id).toBe('factory.edge.x-minus')
    expect(FACTORY_EDGE_X_MINUS.steps).toEqual([
      ...TOP_SAFE_DEPTH,
      { kind: 'calc', name: 'stepOut', unit: 'mm', expr: 'input.startDistanceMm + probe.tipRadiusMm + probe.surfaceClearanceMm' },
      { kind: 'calc', name: 'search', unit: 'mm', expr: 'input.startDistanceMm + probe.surfaceClearanceMm + probe.overtravelMm' },
      { kind: 'move', name: 'riseToSafe', frame: 'machine', to: { z: 'calc.safeZ' } },
      { kind: 'move', name: 'pastTheFace', frame: 'start', to: { x: 'calc.stepOut' } },
      ...descent('descent'),
      { kind: 'touch', name: 'face', axis: 'X', direction: '-', searchMm: 'calc.search' },
      { kind: 'calc', name: 'faceX', unit: 'mm', expr: 'touch.face.x - probe.tipRadiusMm' },
      { kind: 'move', name: 'riseAfterFace', frame: 'machine', to: { z: 'calc.safeZ' } },
    ])
    expect(FACTORY_EDGE_X_MINUS.inputs.map((i) => [i.name, i.default])).toEqual([['startDistanceMm', 10], ['depthMm', 5], ['topSearchMm', 25]])
    expect(FACTORY_EDGE_X_MINUS.outputs[0]).toMatchObject({
      kind: 'workOffset',
      wcs: 'active',
      compensationNote: 'Probe tip radius compensation: -tip radius on X (X- touch).',
      axes: { X: 'calc.faceX' },
    })
  })

  it('edge variants carry calculateEdge\'s sign and step out AGAINST the touch direction', () => {
    expect(stepNamed(factoryEdgeRoutine('X', '+'), 'faceX')).toMatchObject({ expr: 'touch.face.x + probe.tipRadiusMm' })
    expect(stepNamed(factoryEdgeRoutine('X', '+'), 'pastTheFace')).toMatchObject({ to: { x: '-calc.stepOut' } })
    expect(stepNamed(factoryEdgeRoutine('Y', '-'), 'faceY')).toMatchObject({ expr: 'touch.face.y - probe.tipRadiusMm' })
    expect(stepNamed(factoryEdgeRoutine('Y', '-'), 'pastTheFace')).toMatchObject({ to: { y: 'calc.stepOut' } })
    expect(stepNamed(factoryEdgeRoutine('Y', '+'), 'faceY')).toMatchObject({ expr: 'touch.face.y + probe.tipRadiusMm' })
    expect(stepNamed(factoryEdgeRoutine('Y', '+'), 'pastTheFace')).toMatchObject({ to: { y: '-calc.stepOut' } })
    expect(factoryEdgeRoutine('Y', '+').outputs[0]).toMatchObject({ axes: { Y: 'calc.faceY' } })
  })

  it('the outside back-right corner goes around the corner from the top: X face, back over the start, Y face (WO-2056 on the panel)', () => {
    const routine = FACTORY_CORNER_OUTSIDE_X_MINUS_Y_MINUS
    expect(routine.id).toBe('factory.corner.outside.x-minus.y-minus')
    expect(routine.name).toBe('Outside corner - back right')
    expect(namesOf(routine)).toEqual([
      'top', 'safeZ', 'depthZ', 'stepOut', 'search',
      'riseToSafe', 'pastRightFace', 'descentX', 'check', 'xFace', 'cornerX', 'riseAfterXFace',
      'backOverTheStart', 'pastBackFace', 'descentY', 'check', 'yFace', 'cornerY', 'riseAfterYFace',
    ])
    expect(stepNamed(routine, 'pastRightFace')).toEqual({ kind: 'move', name: 'pastRightFace', frame: 'start', to: { x: 'calc.stepOut' } })
    expect(stepNamed(routine, 'backOverTheStart')).toEqual({ kind: 'move', name: 'backOverTheStart', frame: 'start', to: { x: '0', y: '0' } })
    expect(stepNamed(routine, 'pastBackFace')).toEqual({ kind: 'move', name: 'pastBackFace', frame: 'start', to: { y: 'calc.stepOut' } })
    expect(stepNamed(routine, 'cornerX')).toMatchObject({ expr: 'touch.xFace.x - probe.tipRadiusMm' })
    expect(stepNamed(routine, 'cornerY')).toMatchObject({ expr: 'touch.yFace.y - probe.tipRadiusMm' })
    expect(routine.steps.slice(7, 9)).toEqual(descent('descentX'))
    expect(routine.steps.slice(14, 16)).toEqual(descent('descentY'))
  })

  it('the other outside corners step out past each face with the matching sign', () => {
    const backLeft = factoryCornerRoutine('outside', '+', '-')
    expect(stepNamed(backLeft, 'pastLeftFace')).toMatchObject({ to: { x: '-calc.stepOut' } })
    expect(stepNamed(backLeft, 'xFace')).toMatchObject({ kind: 'touch', axis: 'X', direction: '+' })
    expect(stepNamed(backLeft, 'cornerX')).toMatchObject({ expr: 'touch.xFace.x + probe.tipRadiusMm' })
    expect(stepNamed(backLeft, 'pastBackFace')).toMatchObject({ to: { y: 'calc.stepOut' } })
    const frontRight = factoryCornerRoutine('outside', '-', '+')
    expect(stepNamed(frontRight, 'pastFrontFace')).toMatchObject({ to: { y: '-calc.stepOut' } })
    expect(stepNamed(frontRight, 'yFace')).toMatchObject({ kind: 'touch', axis: 'Y', direction: '+' })
    expect(stepNamed(frontRight, 'cornerY')).toMatchObject({ expr: 'touch.yFace.y + probe.tipRadiusMm' })
  })

  it('inside corners descend once from the hole top, then two touches from there, X then Y, like planFeatureProbeCycle(insideCorner)', () => {
    const r = factoryCornerRoutine('inside', '-', '+')
    expect(r.steps.map((s) => s.kind)).toEqual(['calc', 'calc', 'branch', 'move', 'check', 'touch', 'calc', 'touch', 'calc', 'move'])
    expect(r.steps.slice(0, 2)).toEqual([
      { kind: 'calc', name: 'safeZ', unit: 'mm', expr: 'input.topZ + probe.surfaceClearanceMm' },
      { kind: 'calc', name: 'depthZ', unit: 'mm', expr: 'input.topZ - input.depthMm' },
    ])
    // rises only when it starts below safe height - never a plain move down
    expect(r.steps[2]).toEqual({
      kind: 'branch',
      name: 'startHeight',
      condition: { cmp: '<', left: 'start.z', right: 'calc.safeZ' },
      then: [{ kind: 'move', name: 'riseToSafe', frame: 'machine', to: { z: 'calc.safeZ' } }],
    })
    expect(r.steps.slice(3, 5)).toEqual(descent('descent'))
    expect(r.steps[5]).toMatchObject({ axis: 'X', direction: '-' })
    expect(r.steps[7]).toMatchObject({ axis: 'Y', direction: '+' })
    expect(r.steps[6]).toMatchObject({ expr: 'touch.xFace.x - probe.tipRadiusMm' })
    expect(r.steps[8]).toMatchObject({ expr: 'touch.yFace.y + probe.tipRadiusMm' })
    expect(r.steps[9]).toMatchObject({ kind: 'move', frame: 'machine', to: { z: 'calc.safeZ' } })
  })

  it('bore: descends from the hole top, four seeks with conditional returns toward the start, unchanged centre arithmetic', () => {
    const kinds = FACTORY_BORE_CENTRE.steps.map((s) => s.kind)
    expect(kinds.filter((k) => k === 'touch')).toHaveLength(4)
    expect(FACTORY_BORE_CENTRE.steps.filter((s) => s.kind === 'touch').map((s) => `${(s as { axis: string }).axis}${(s as { direction: string }).direction}`))
      .toEqual(['X-', 'X+', 'Y-', 'Y+'])
    const calc = (name: string) => (FACTORY_BORE_CENTRE.steps.find((s) => s.kind === 'calc' && s.name === name) as { expr: string }).expr
    expect(calc('search')).toBe('probe.maxTravelMm')
    expect(FACTORY_BORE_CENTRE.steps.some((s) => s.kind === 'calc' && s.name === 'approach')).toBe(false)
    expect(FACTORY_BORE_CENTRE.steps.filter((s) => s.kind === 'move').every((s) => s.kind === 'move' && s.to.x === undefined && s.to.y === undefined)).toBe(true)
    expect(stepNamed(FACTORY_BORE_CENTRE, 'returnAfterLeft')).toMatchObject({
      kind: 'branch',
      condition: { cmp: '<', left: 'touch.left.x + probe.retractMm', right: 'start.x' },
      then: [{ kind: 'move', name: 'backFromLeft', frame: 'start', to: { x: '0' } }],
    })
    expect(calc('diameterX')).toBe('touch.right.x - touch.left.x + 2 * probe.tipRadiusMm')
    expect(calc('centreX')).toBe('(touch.left.x + touch.right.x) / 2')
    expect(calc('safeZ')).toBe('input.topZ + probe.surfaceClearanceMm')
    expect(calc('depthZ')).toBe('input.topZ - input.depthMm')
    const firstTouch = FACTORY_BORE_CENTRE.steps.findIndex((s) => s.kind === 'touch')
    expect(FACTORY_BORE_CENTRE.steps.slice(firstTouch - 2, firstTouch)).toEqual(descent('descent'))
    expect(stepNamed(FACTORY_BORE_CENTRE, 'riseAfterWalls')).toMatchObject({ frame: 'machine', to: { z: 'calc.safeZ' } })
  })

  it('boss: starts over the middle, touches the top, and every XY move runs at top + clearance - never through the boss (WO-2052\'s rule); calculateBossCenter arithmetic', () => {
    const touches = FACTORY_BOSS_CENTRE.steps.filter((s) => s.kind === 'touch').map((s) => `${(s as { axis: string }).axis}${(s as { direction: string }).direction}`)
    expect(touches).toEqual(['Z-', 'X+', 'X-', 'Y+', 'Y-'])
    const calc = (name: string) => (FACTORY_BOSS_CENTRE.steps.find((s) => s.kind === 'calc' && s.name === name) as { expr: string }).expr
    expect(calc('approach')).toBe('input.diameter / 2 + probe.tipRadiusMm + probe.surfaceClearanceMm')
    expect(calc('safeZ')).toBe('touch.top.z + probe.surfaceClearanceMm')
    expect(calc('depthZ')).toBe('touch.top.z - input.depthMm')
    expect(calc('diameterX')).toBe('touch.right.x - touch.left.x - 2 * probe.tipRadiusMm')
    // no cross-over height input any more: the height comes from the touched top
    expect(FACTORY_BOSS_CENTRE.inputs.map((i) => i.name)).toEqual(['diameter', 'depthMm', 'topSearchMm'])
    // Every XY move comes straight after a rise to calc.safeZ (Z is never lowered
    // except by a descent that stops on contact), so no XY move runs below top + clearance.
    const moves = FACTORY_BOSS_CENTRE.steps.filter((s) => s.kind === 'move')
    expect(moves.filter((m) => m.kind === 'move' && m.to.z !== undefined && !m.stopOnContact).every((m) => m.kind === 'move' && m.to.z === 'calc.safeZ')).toBe(true)
    moves.forEach((m, i) => {
      if (m.kind !== 'move' || (m.to.x === undefined && m.to.y === undefined)) return
      expect(moves[i - 1]).toMatchObject({ frame: 'machine', to: { z: 'calc.safeZ' } })
    })
    expect(FACTORY_BOSS_CENTRE.steps.filter((s) => s.kind === 'branch')).toHaveLength(0)
    expect(moves.filter((m) => m.kind === 'move' && m.stopOnContact)).toHaveLength(4)
  })

  it('the bore and boss arithmetic agrees with calculateBoreCenter / calculateBossCenter on sample contacts', () => {
    const scope: ExprEvalScope = {
      input: { diameter: 20 },
      touch: {
        left: { x: -9.5, y: 0, z: -5, value: -9.5 },
        right: { x: 10.5, y: 0, z: -5, value: 10.5 },
        front: { x: 0, y: -10.2, z: -5, value: -10.2 },
        back: { x: 0, y: 9.8, z: -5, value: 9.8 },
      },
      calc: {},
      probe: { tipRadiusMm: 1, retractMm: 2, surfaceClearanceMm: 5, overtravelMm: 5, maxTravelMm: 50, crossOverLiftMm: 10 },
      start: { x: 0, y: 0, z: -5 },
    }
    const evalCalc = (routine: ProbeRoutine, name: string) => {
      const step = routine.steps.find((s) => s.kind === 'calc' && s.name === name) as { expr: string }
      const parsed = parseExpr(step.expr)
      const out = evaluateExpr(parsed.ast!, scope)
      if (!out.ok) throw new Error(out.fault.sentence)
      return out.value
    }
    // bore: diameter = xPos - xNeg + 2r ; centre = (xNeg + xPos)/2
    expect(evalCalc(FACTORY_BORE_CENTRE, 'diameterX')).toBeCloseTo(10.5 - -9.5 + 2, 9)
    expect(evalCalc(FACTORY_BORE_CENTRE, 'centreX')).toBeCloseTo(0.5, 9)
    expect(evalCalc(FACTORY_BORE_CENTRE, 'centreY')).toBeCloseTo(-0.2, 9)
    // boss: in the boss routine 'left' is the X+ touch (min face), 'right' the X- touch (max face)
    expect(evalCalc(FACTORY_BOSS_CENTRE, 'diameterX')).toBeCloseTo(10.5 - -9.5 - 2, 9)
    expect(evalCalc(FACTORY_BOSS_CENTRE, 'centreX')).toBeCloseTo(0.5, 9)
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 1: the contract\'s invalid example (section 3.5), static errors', () => {
  const result = validateProbeRoutine(CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT, { profileFeeds: SAMPLE_MACHINE_FEEDS })

  it('is refused', () => {
    expect(result.ok).toBe(false)
  })

  it('yields exactly the eight STATIC errors of the table, by code, in step order (#3, #4, #5 are expansion - slice 2)', () => {
    expect(codes(result.errors)).toEqual([
      'E_REQUIRES_HOMED', // #1
      'E_INPUT_UNBOUNDED', // #2
      // #3 E_RAPID_NOT_AT_SAFE_Z, #4 E_ENDPOINT_OUTSIDE_ENVELOPE, #5 E_SEARCH_OVER_MAX_TRAVEL: expansion
      'E_FEED_ABOVE_PROFILE', // #6
      'E_EXPR_UNBOUNDED', // #7
      'E_CALC_NOT_FINITE', // #8 (static by structure: the divisor is identically zero)
      'E_STEP_KIND', // #9
      'E_GCODE_IN_ROUTINE', // #10
      'E_EXPR_UNKNOWN_NAME', // #11
    ])
  })

  it('renders the contract\'s sentences', () => {
    const sentences = result.errors.map((e) => e.sentence)
    expect(sentences[0]).toBe(
      "Routine 'Slot width (broken on purpose)': it moves the machine (step 1 'toLeftWall') and touches twice, so it must declare `requires.homed: true` - every endpoint is a machine coordinate and means nothing unhomed.",
    )
    expect(sentences[1]).toBe(
      "Input 'widthMm': a length input needs `min` and `max`; without them the preview cannot promise where the machine will go.",
    )
    expect(sentences[2]).toBe(
      "Step 2 (touch 'left'): `searchFeedFactor` 2.5 asks for more than the profile's search feed (300 mm/min). A routine may only slow a feed down (factor between 0 and 1).",
    )
    expect(sentences[3]).toBe(
      "Step 5 (calc 'width'): the expression has 107 tokens (limit 64) and parentheses 10 deep (limit 8).",
    )
    expect(sentences[4]).toBe(
      "Step 5 (calc 'width'): divides by `touch.right.x - touch.right.x`, which is always zero - the result can never be a number.",
    )
    expect(sentences[5]).toBe(
      "Step 6: there is no step kind 'gcode'. A routine cannot write G-code; it can only move, touch, calculate, check and branch.",
    )
    expect(sentences[6]).toBe(
      'Step 6: the text "G10 L20 P0 X0" is a work-offset write. Offsets are set only by the Confirm button after the routine, never from inside it.',
    )
    expect(sentences[7]).toBe(
      "Output 1 (workOffset): `calc.centre` is not a calc in this routine (did you mean 'width'?).",
    )
  })

  it('every error names its step / input / output and carries a path', () => {
    const byStep = result.errors.filter((e) => e.where === 'step')
    expect(byStep.map((e) => e.step?.number)).toEqual([2, 5, 5, 6, 6])
    expect(byStep.map((e) => e.step?.name)).toEqual(['left', 'width', 'width', null, null])
    expect(result.errors[1]).toMatchObject({ where: 'input', index: 1, path: 'inputs[0].min' })
    expect(result.errors[7]).toMatchObject({ where: 'output', index: 1, path: 'outputs[0].axes.X' })
    expect(result.errors.every((e) => e.path.length > 0)).toBe(true)
  })

  it('without profile feeds the feed sentence still reads, just without the number', () => {
    const bare = validateProbeRoutine(CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT)
    expect(bare.errors[2].sentence).toBe(
      "Step 2 (touch 'left'): `searchFeedFactor` 2.5 asks for more than the profile's search feed. A routine may only slow a feed down (factor between 0 and 1).",
    )
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 1: expression language bounds and grammar', () => {
  it('limits are 64 tokens and 8 deep', () => {
    expect(EXPR_MAX_TOKENS).toBe(64)
    expect(EXPR_MAX_PAREN_DEPTH).toBe(8)
  })

  it('64 tokens parse; 65 tokens are E_EXPR_UNBOUNDED', () => {
    // n tokens: "1 + 1 + ... 1" (odd n ends on a number)
    const tokensOf = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '1' : '+')).join(' ')
    const sixtyFour = parseExpr(`-${tokensOf(63)}`) // unary minus + 63 = 64
    expect(sixtyFour.tokenCount).toBe(64)
    expect(sixtyFour.faults).toEqual([])
    const sixtyFive = parseExpr(`${tokensOf(63)} * 1`)
    expect(sixtyFive.tokenCount).toBe(65)
    expect(sixtyFive.faults.map((f) => f.code)).toEqual(['E_EXPR_UNBOUNDED'])
    expect(sixtyFive.faults[0].sentence).toBe('the expression has 65 tokens (limit 64).')
    expect(sixtyFive.ast).not.toBeNull() // the grammar still parsed, so later checks can run
  })

  it('8 deep parses; 9 deep is E_EXPR_UNBOUNDED', () => {
    const eight = `${'('.repeat(8)}1${')'.repeat(8)}`
    expect(parseExpr(eight).faults).toEqual([])
    const nine = `${'('.repeat(9)}1${')'.repeat(9)}`
    const faults = parseExpr(nine).faults
    expect(faults.map((f) => f.code)).toEqual(['E_EXPR_UNBOUNDED'])
    expect(faults[0].sentence).toBe('the expression has parentheses 9 deep (limit 8).')
  })

  it('function calls are refused, naming the token (abs, min, atan2)', () => {
    for (const fn of ['abs', 'min', 'atan2']) {
      const r = parseExpr(`${fn}(input.x)`)
      expect(r.ast).toBeNull()
      expect(r.faults).toHaveLength(1)
      expect(r.faults[0].code).toBe('E_EXPR_UNBOUNDED')
      expect(r.faults[0].token).toBe(`${fn}(`)
      expect(r.faults[0].sentence).toContain('function calls are not allowed')
    }
  })

  it('the exponent operator ** and ^ are refused', () => {
    const star = parseExpr('input.x ** 2')
    expect(star.faults.map((f) => f.code)).toEqual(['E_EXPR_UNBOUNDED'])
    expect(star.faults[0].token).toBe('**')
    const caret = parseExpr('input.x ^ 2')
    expect(caret.faults.map((f) => f.code)).toEqual(['E_EXPR_UNBOUNDED'])
    expect(caret.faults[0].token).toBe('^')
  })

  it.each([
    ['', 'empty'],
    ['1 +', 'ends where'],
    ['(1 + 2', 'no matching `)`'],
    ['1 + 2)', 'no matching `(`'],
    ['"1"', 'strings'],
    ['input.x = 1', 'assignment'],
    ['1, 2', 'comma'],
    ['+1', 'leading `+`'],
    ['1e999', 'not finite'],
    ['2x', 'unexpected'],
  ])('malformed %j is E_EXPR_UNBOUNDED (%s)', (source, fragment) => {
    const r = parseExpr(source)
    expect(r.ast).toBeNull()
    expect(r.faults.map((f) => f.code)).toEqual(['E_EXPR_UNBOUNDED'])
    expect(r.faults[0].sentence).toContain(fragment)
  })

  it('a JSON number is a one-token literal', () => {
    const r = parseExpr(12.5)
    expect(r.faults).toEqual([])
    expect(r.tokenCount).toBe(1)
    expect(r.ast).toEqual({ type: 'num', value: 12.5, text: '12.5' })
  })
})

describe('WO-411 slice 1: expression evaluation', () => {
  const scope: ExprEvalScope = {
    input: { d: 20, n: 3 },
    touch: { left: { x: -9, y: 1, z: -5, value: -9 } },
    calc: { a: 4 },
    probe: { tipRadiusMm: 1, retractMm: 2, surfaceClearanceMm: 5, overtravelMm: 5, maxTravelMm: 50, crossOverLiftMm: 10 },
    start: { x: 100, y: 200, z: -3 },
  }
  const run = (source: string) => {
    const parsed = parseExpr(source)
    expect(parsed.faults).toEqual([])
    return evaluateExpr(parsed.ast!, scope)
  }

  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 / 4', 2.5],
    ['-input.d / 2', -10],
    ['- - 2', 2],
    ['input.d / 2 - probe.tipRadiusMm - probe.surfaceClearanceMm', 4],
    ['touch.left.x - probe.tipRadiusMm', -10],
    ['start.x + calc.a', 104],
    ['touch.left.value', -9],
    ['2 * 3 - 4 / 2', 4],
    ['1 - 2 - 3', -4],
    ['8 / 2 / 2', 2],
  ])('%s = %d', (source, expected) => {
    const out = run(source)
    expect(out).toEqual({ ok: true, value: expected })
  })

  it('division by zero at evaluation is E_CALC_NOT_FINITE, never a number', () => {
    const out = run('1 / (calc.a - 4)')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.fault.code).toBe('E_CALC_NOT_FINITE')
  })

  it('a name missing from the scope is a fault, not undefined', () => {
    const out = run('calc.missing + 1')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.fault.code).toBe('E_EXPR_UNKNOWN_NAME')
  })

  it('finds the identically-zero divisor structurally, and ignores a value-dependent one', () => {
    expect(findConstantZeroDivisor(parseExpr('1 / (touch.left.x - touch.left.x)').ast!)).toBe('touch.left.x - touch.left.x')
    expect(findConstantZeroDivisor(parseExpr('1 / 0').ast!)).toBe('0')
    expect(findConstantZeroDivisor(parseExpr('1 / (0 * input.d)').ast!)).toBe('0 * input.d')
    expect(findConstantZeroDivisor(parseExpr('1 / -(2 - 2)').ast!)).toBe('-(2 - 2)')
    expect(findConstantZeroDivisor(parseExpr('1 / (input.d - input.n)').ast!)).toBeNull()
    expect(findConstantZeroDivisor(parseExpr('0 / input.d').ast!)).toBeNull()
  })
})

describe('WO-411 slice 1: expression name resolution (static scope)', () => {
  const scope: ExprNameScope = {
    inputs: new Map([['d', 'length'], ['side', 'enum']]),
    touches: new Map([
      ['left', { available: true }],
      ['right', { available: false, reason: 'later', stepNumber: 4 }],
      ['armed', { available: false, reason: 'branch-arm', stepNumber: 7 }],
    ]),
    calcs: new Map([['width', { available: true }]]),
  }
  const faultsOf = (source: string) => checkExprNames(parseExpr(source).ast!, scope)

  it.each([
    ['touch.right.x', 'E_EXPR_FORWARD_REFERENCE', 'happens later (step 4)'],
    ['touch.armed.x', 'E_EXPR_FORWARD_REFERENCE', 'inside a branch arm (step 7)'],
    ['input.side * 2', 'E_EXPR_ENUM_IN_ARITHMETIC', 'choice (enum) input'],
    ['calc.centre', 'E_EXPR_UNKNOWN_NAME', "(did you mean 'width'?)"],
    ['input.dd', 'E_EXPR_UNKNOWN_NAME', "(did you mean 'd'?)"],
    ['touch.lefty.x', 'E_EXPR_UNKNOWN_NAME', "(did you mean 'left'?)"],
    ['touch.left.w', 'E_EXPR_UNKNOWN_NAME', '.x, .y, .z and .value'],
    ['touch.left', 'E_EXPR_UNKNOWN_NAME', 'incomplete'],
    ['probe.tipRadius', 'E_EXPR_UNKNOWN_NAME', 'not a probe value'],
    ['start.w', 'E_EXPR_UNKNOWN_NAME', 'not a start coordinate'],
    ['foo.bar', 'E_EXPR_UNKNOWN_NAME', 'names start with input., touch., calc., probe. or start.'],
    ['abs', 'E_EXPR_UNKNOWN_NAME', 'not a name a routine can use'],
    ['input', 'E_EXPR_UNKNOWN_NAME', 'input.<name>'],
  ])('%s -> %s', (source, code, fragment) => {
    const faults = faultsOf(source)
    expect(faults).toHaveLength(1)
    expect(faults[0].code).toBe(code)
    expect(faults[0].sentence).toContain(fragment)
  })

  it('a clean expression has no faults', () => {
    expect(faultsOf('touch.left.x - probe.tipRadiusMm + calc.width * input.d + start.z')).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 1: the static validator, check by check', () => {
  it('accepts the minimal routine', () => {
    expect(validateProbeRoutine(minimalRoutine())).toMatchObject({ ok: true, errors: [] })
  })

  it.each<[string, (r: ProbeRoutine) => unknown, string, string]>([
    ['schemaVersion missing', (r) => { const j = r as unknown as Record<string, unknown>; delete j.schemaVersion; return j }, 'E_SCHEMA_MISSING', 'schemaVersion'],
    ['schemaVersion 2 (newer) refused whole', (r) => ({ ...r, schemaVersion: 2 }), 'E_SCHEMA_NEWER', 'saved by a newer LienCAM (format 2); this version reads format 1'],
    ['unknown top-level key (feeds do not travel)', (r) => ({ ...r, feeds: { search: 300 } }), 'E_UNKNOWN_FIELD', "'feeds'"],
    ['unknown key inside a step', (r) => { (r.steps[0] as unknown as Record<string, unknown>).feedMmMin = 300; return r }, 'E_UNKNOWN_FIELD', "'feedMmMin'"],
    ['factory. id on a user routine', (r) => ({ ...r, id: 'factory.mine' }), 'E_ID_RESERVED', "reserved"],
    ['length input without max', (r) => { delete (r.inputs[0] as unknown as Record<string, unknown>).max; return r }, 'E_INPUT_UNBOUNDED', 'needs `min` and `max`'],
    ['input min > max', (r) => { (r.inputs[0] as { min: number }).min = 60; return r }, 'E_INPUT_UNBOUNDED', 'greater than `max`'],
    ['default outside bounds', (r) => { (r.inputs[0] as { default: number }).default = 99; return r }, 'E_INPUT_DEFAULT_OUT_OF_RANGE', 'outside the input\'s own bounds (1 to 50 mm)'],
    ['enum default not an option', (r) => { r.inputs.push({ name: 'side', label: 'Side', type: 'enum', options: ['X', 'Y'], default: 'Z' }); return r }, 'E_INPUT_DEFAULT_OUT_OF_RANGE', 'not one of the options'],
    ['unknown step kind', (r) => { (r.steps as unknown[]).push({ kind: 'home' }); return r }, 'E_STEP_KIND', "no step kind 'home'"],
    ['duplicate step name', (r) => { r.steps.push({ kind: 'calc', name: 'faceX', unit: 'mm', expr: '1' }); return r }, 'E_STEP_NAME_DUPLICATE', "'faceX' is already used by step 2"],
    ['Z+ touch', (r) => { (r.steps[0] as { axis: string; direction: string }).axis = 'Z'; (r.steps[0] as { direction: string }).direction = '+'; return r }, 'E_TOUCH_DIRECTION', 'Z+ touch'],
    ['bad axis', (r) => { (r.steps[0] as { axis: string }).axis = 'W'; return r }, 'E_TOUCH_DIRECTION', '`axis` must be'],
    ['feed factor 1.5', (r) => { (r.steps[0] as { finalFeedFactor?: number }).finalFeedFactor = 1.5; return r }, 'E_FEED_ABOVE_PROFILE', '`finalFeedFactor` 1.5 asks for more than the profile\'s final feed'],
    ['abs( in a calc', (r) => { (r.steps[1] as { expr: string }).expr = 'abs(touch.face.x)'; return r }, 'E_EXPR_UNBOUNDED', 'function calls are not allowed (`abs(`)'],
    ['unknown name', (r) => { (r.steps[1] as { expr: string }).expr = 'touch.face.x - probe.radius'; return r }, 'E_EXPR_UNKNOWN_NAME', '`probe.radius` is not a probe value'],
    ['forward reference to a later touch', (r) => { r.steps.unshift({ kind: 'calc', name: 'early', unit: 'mm', expr: 'touch.face.x' }); return r }, 'E_EXPR_FORWARD_REFERENCE', "touch 'face', which happens later (step 2)"],
    ['enum in arithmetic', (r) => { r.inputs.push({ name: 'side', label: 'Side', type: 'enum', options: ['X', 'Y'], default: 'X' }); (r.steps[1] as { expr: string }).expr = 'input.side + 1'; return r }, 'E_EXPR_ENUM_IN_ARITHMETIC', 'choice (enum) input'],
    ['requires.homed false with two touches', (r) => { r.requires.homed = false; r.requires.envelope = 'axis'; r.steps.push({ kind: 'touch', name: 'second', axis: 'Y', direction: '-', searchMm: '5' }); return r }, 'E_REQUIRES_HOMED', 'touches twice'],
    ['requires.homed true with envelope axis', (r) => { r.requires.envelope = 'axis'; return r }, 'E_REQUIRES_HOMED', '`requires.envelope` must be "full"'],
    ['G-code text in a label', (r) => { (r.outputs[0] as { label: string }).label = 'G10 L2 P1 X0'; return r }, 'E_GCODE_IN_ROUTINE', 'work-offset write'],
    ['$H in a description', (r) => ({ ...r, description: 'Run $H first' }), 'E_GCODE_IN_ROUTINE', 'homing command'],
    ['M-word in a message', (r) => { r.steps.push({ kind: 'check', condition: { cmp: '>', left: '1', right: '0' }, message: 'Then M3 S1000' }); return r }, 'E_GCODE_IN_ROUTINE', 'M-code'],
    ['feed hold character', (r) => ({ ...r, description: 'Stop!' }), 'E_GCODE_IN_ROUTINE', 'real-time control character'],
    ['unknown output kind', (r) => { (r.outputs as unknown[]).push({ kind: 'writeOffset' }); return r }, 'E_OUTPUT_KIND', "no output kind \"writeOffset\""],
    ['branch three deep', (r) => {
      const cmp = { cmp: '>' as const, left: '1', right: '0' }
      r.steps.push({ kind: 'branch', condition: cmp, then: [{ kind: 'branch', condition: cmp, then: [{ kind: 'branch', condition: cmp, then: [] }] }] })
      return r
    }, 'E_BRANCH_DEPTH', 'this branch is 3 deep'],
    ['too many steps', (r) => { for (let i = 0; i < 63; i++) r.steps.push({ kind: 'calc', name: `c${i}`, unit: 'mm', expr: '1' }); return r }, 'E_TOO_MANY_STEPS', 'at most 64 steps'],
    ['nested all inside any', (r) => { r.steps.push({ kind: 'check', condition: { any: [{ all: [] } as unknown as { cmp: '>'; left: string; right: string }] }, message: 'x' }); return r }, 'E_FIELD_INVALID', 'one level only'],
    ['safeZ on a later move', (r) => { r.steps.push({ kind: 'move', to: { z: '5' }, safeZ: '5' }); return r }, 'E_FIELD_INVALID', 'first step'],
    ['feed factor 0', (r) => { (r.steps[0] as { searchFeedFactor?: number }).searchFeedFactor = 0; return r }, 'E_FIELD_INVALID', 'would stop the probe'],
  ])('%s -> %s', (_label, mutate, code, fragment) => {
    const errors = errorsOf(mutate(clone(minimalRoutine())))
    const hit = errors.find((e) => e.code === code)
    expect(hit, `expected ${code} in ${JSON.stringify(codes(errors))}`).toBeDefined()
    expect(hit!.sentence).toContain(fragment)
  })

  it('E_SCHEMA_NEWER refuses the whole file: nothing else is reported', () => {
    const errors = errorsOf({ ...minimalRoutine(), schemaVersion: 2, bogus: 1 })
    expect(codes(errors)).toEqual(['E_SCHEMA_NEWER'])
  })

  it('an enum input may drive axis / direction / wcs when every option is legal for the field', () => {
    const r = minimalRoutine()
    r.inputs.push({ name: 'axis', label: 'Axis', type: 'enum', options: ['X', 'Y'], default: 'X' })
    r.inputs.push({ name: 'dir', label: 'Direction', type: 'enum', options: ['+', '-'], default: '-' })
    r.inputs.push({ name: 'slot', label: 'Offset', type: 'enum', options: ['active', 'G54'], default: 'active' })
    ;(r.steps[0] as { axis: string; direction: string }).axis = '$input.axis'
    ;(r.steps[0] as { direction: string }).direction = '$input.dir'
    ;(r.outputs[0] as { wcs: string }).wcs = '$input.slot'
    expect(codes(errorsOf(r))).toEqual([])
    // Z among the axis options with + among the directions: a Z+ touch becomes possible -> refused
    ;(r.inputs[1] as { options: string[] }).options = ['X', 'Y', 'Z']
    expect(codes(errorsOf(r))).toEqual(['E_TOUCH_DIRECTION'])
    // an option illegal for the field
    ;(r.inputs[1] as { options: string[] }).options = ['X', 'A']
    const errs = errorsOf(r)
    expect(codes(errs)).toEqual(['E_TOUCH_DIRECTION'])
    expect(errs[0].sentence).toContain('"A", which is not allowed here')
    // a non-enum input where an enum is needed
    ;(r.steps[0] as { direction: string }).direction = '$input.searchMm'
    ;(r.inputs[1] as { options: string[] }).options = ['X', 'Y']
    expect(codes(errorsOf(r))).toEqual(['E_TOUCH_DIRECTION'])
  })

  it('names defined inside a branch arm are usable in that arm only; outputs see top-level names only', () => {
    const r = minimalRoutine()
    const cmp = { cmp: '>' as const, left: 'input.searchMm', right: '5' }
    r.steps.push({
      kind: 'branch',
      condition: cmp,
      then: [
        { kind: 'calc', name: 'inThen', unit: 'mm', expr: 'calc.faceX + 1' },
        { kind: 'calc', name: 'inThenToo', unit: 'mm', expr: 'calc.inThen * 2' }, // same arm: fine
      ],
      else: [
        { kind: 'calc', name: 'inElse', unit: 'mm', expr: 'calc.inThen' }, // other arm: refused
      ],
    })
    r.steps.push({ kind: 'calc', name: 'after', unit: 'mm', expr: 'calc.inThen' }) // after the branch: refused
    ;(r.outputs[0] as { axes: { X: string } }).axes.X = 'calc.inElse' // output: refused
    const errors = errorsOf(r)
    expect(codes(errors)).toEqual(['E_EXPR_FORWARD_REFERENCE', 'E_EXPR_FORWARD_REFERENCE', 'E_EXPR_FORWARD_REFERENCE'])
    expect(errors[0].step).toEqual({ number: 6, kind: 'calc', name: 'inElse' })
    expect(errors[0].sentence).toContain("inside a branch arm (step 4)")
    expect(errors[1].step?.number).toBe(7)
    expect(errors[2].where).toBe('output')
  })

  it('step numbering is flat document order: branch arms count in place', () => {
    const r = minimalRoutine()
    const cmp = { cmp: '>' as const, left: '1', right: '0' }
    r.steps.push({ kind: 'branch', condition: cmp, then: [{ kind: 'calc', name: 'a', unit: 'mm', expr: 'calc.nope' }] })
    r.steps.push({ kind: 'calc', name: 'b', unit: 'mm', expr: 'calc.nope' })
    const errors = errorsOf(r)
    expect(errors.map((e) => e.step?.number)).toEqual([4, 5])
  })

  it('a non-object, or garbage in the lists, is reported and never throws', () => {
    expect(validateProbeRoutine(null).ok).toBe(false)
    expect(validateProbeRoutine('text').ok).toBe(false)
    expect(validateProbeRoutine([]).ok).toBe(false)
    const r = minimalRoutine() as unknown as Record<string, unknown>
    r.steps = [null, 5, 'touch']
    r.inputs = 'no'
    r.outputs = [7]
    const result = validateProbeRoutine(r)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('the table from the WO: expansion-independent checks fire by name', () => {
    const table: Array<[string, string]> = [
      ['inputs bounded', 'E_INPUT_UNBOUNDED'],
      ['feeds as factors <= 1', 'E_FEED_ABOVE_PROFILE'],
      ['no lifecycle / gcode in the body (step kind)', 'E_STEP_KIND'],
      ['no lifecycle / gcode in the body (text)', 'E_GCODE_IN_ROUTINE'],
      ['forward references', 'E_EXPR_FORWARD_REFERENCE'],
    ]
    const badSlot = errorsOf(CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT)
    const forward = minimalRoutine()
    forward.steps.unshift({ kind: 'calc', name: 'early', unit: 'mm', expr: 'touch.face.x' })
    const all = [...badSlot, ...errorsOf(forward)]
    for (const [name, code] of table) {
      expect(all.some((e) => e.code === code), name).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 1: round trip', () => {
  it.each(FACTORY_PROBE_ROUTINES.map((r) => [r.id, r] as const))('%s: validate(JSON.parse(JSON.stringify(routine))) is identity', (_id, routine) => {
    const again = validateProbeRoutine(JSON.parse(JSON.stringify(routine)))
    expect(again.ok).toBe(true)
    expect(again.routine).toEqual(routine)
    // and the validator returns the object unchanged: no defaults injected
    expect(JSON.stringify(again.routine)).toBe(JSON.stringify(routine))
  })

  it('parse -> serialize -> parse is equal, and canonical JSON is stable under key order', () => {
    const text = serializeProbeRoutine(FACTORY_BORE_CENTRE)
    const once = parseProbeRoutine(text)
    expect(once.ok).toBe(true)
    const twice = parseProbeRoutine(serializeProbeRoutine(once.routine!))
    expect(twice.routine).toEqual(FACTORY_BORE_CENTRE)
    // WO-2074: Bore centre's new `topZ` input carries a `help` string (as
    // `crossOverZ` does on the Boss centre) - it needs the same allowance.
    const shuffled = JSON.parse(JSON.stringify(FACTORY_BORE_CENTRE, Object.keys(FACTORY_BORE_CENTRE).reverse().concat(['kind', 'name', 'unit', 'expr', 'label', 'type', 'min', 'max', 'default', 'help', 'axis', 'direction', 'searchMm', 'frame', 'to', 'x', 'y', 'z', 'stopOnContact', 'then', 'condition', 'cmp', 'left', 'right', 'all', 'message', 'wcs', 'axes', 'X', 'Y', 'compensationNote', 'items', 'homed', 'envelope', 'probe'])))
    expect(canonicalRoutineJson(shuffled)).toBe(canonicalRoutineJson(FACTORY_BORE_CENTRE))
  })

  it('invalid JSON text is an error sentence, not a throw', () => {
    const result = parseProbeRoutine('{ not json')
    expect(result.ok).toBe(false)
    expect(result.errors[0].sentence).toContain('not valid JSON')
  })
})
