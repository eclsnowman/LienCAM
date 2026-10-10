// WO-411 slice 1 - the factory probe routines AS DATA, transcribed from
// docs/research/probe-routine-format.md section 3. Compiled in, never stored;
// "Restore factory routines" reads this constant. Every routine here must
// validate with zero errors (probeRoutineFormat.wo411.test.ts pins that).
//
// Fifteen routines: four edge variants, four outside-corner, four
// inside-corner, bore centre, boss centre, and the tool setter measure
// (WO-1613). Rect pocket / rect boss / angle / Z surface stay code
// (follow-ups).

import type {
  ProbeRoutine,
  ProbeRoutineAxis,
  ProbeRoutineDirection,
  ProbeRoutineInput,
  ProbeRoutineStep,
} from './probeRoutineFormat'
import { DEFAULT_TOP_SEARCH_MM } from './probeFeatureCycle'

export const FACTORY_ROUTINE_ID_PREFIX = 'factory.'

type Sign = ProbeRoutineDirection

/** The bound on a machine-coordinate input (setter X/Y, crossing heights, hole top). */
const COORDINATE_BOUND_MM = 5000

/** The id prefix every factory Inside corner variant shares. */
const FACTORY_CORNER_INSIDE_PREFIX = 'factory.corner.inside.'

/**
 * WO-2074: the top input Bore centre and Inside corner declare - the Routines
 * tab fills its default from work Z0 (holeRoutineForMachine), the same way
 * bossRoutineForMachine fills the boss's crossOverZ. A routine expression
 * cannot read work Z0 itself (probeRoutineExpr: input/touch/calc/probe/start
 * only), so the tab supplies it; the operator can still type a rim's machine Z
 * instead. Since WO-2065 the routine's safe height and probing depth are
 * measured from it.
 */
function holeTopInput(): ProbeRoutineInput {
  return {
    name: 'topZ',
    label: 'Top of the hole, machine Z',
    type: 'length',
    unit: 'mm',
    min: -COORDINATE_BOUND_MM,
    max: COORDINATE_BOUND_MM,
    default: 0,
    help: "Defaults to work Z0 - the hole is in the face Z0 was probed on. Type the rim's machine Z instead if you touched it there.",
  }
}

// --- WO-2065: top, safe height, probing depth (design 4.1) -------------------
//
// The same three heights the Probing panel's cycles use (probeFeatureCycle,
// WO-2055..2058): the top of the feature (touched where the operator started,
// or, for a hole, work Z0 / the rim), safe height = top + the probe's surface
// clearance (every XY move runs there), probing depth = top - depth (every
// side touch runs there). Every way down to depth is a move that stops on
// contact (WO-2073); if it touches something above depth, a check stops the
// routine there, as the panel's cycle does. Until 2026-09-27 these routines
// touched at whatever height the operator left the probe.

/** Probing depth below the top (design 4.4 default 5 mm). Always positive. */
function depthInput(): ProbeRoutineInput {
  return { name: 'depthMm', label: 'Probing depth below the top', type: 'length', unit: 'mm', min: 0.1, max: 100, default: 5 }
}

/** How far down the first touch looks for the top from where the probe starts.
 *  WO-2108: the Probing screen's field has the same default. */
function topSearchInput(): ProbeRoutineInput {
  return { name: 'topSearchMm', label: 'Search down for the top, up to', type: 'length', unit: 'mm', min: 1, max: 200, default: DEFAULT_TOP_SEARCH_MM }
}

/** How far in from the face the operator starts, over the material (design 4.2 default 10 mm). */
function startDistanceInput(): ProbeRoutineInput {
  return { name: 'startDistanceMm', label: 'Start distance from the face, about', type: 'length', unit: 'mm', min: 1, max: 50, default: 10 }
}

/** Safe height and probing depth from a top expression (machine Z). */
function heightCalcs(top: string): ProbeRoutineStep[] {
  return [
    { kind: 'calc', name: 'safeZ', unit: 'mm', expr: `${top} + probe.surfaceClearanceMm` },
    { kind: 'calc', name: 'depthZ', unit: 'mm', expr: `${top} - input.depthMm` },
  ]
}

/** Touch the top where the operator started, then work out the two heights. */
function touchTheTop(): ProbeRoutineStep[] {
  return [
    { kind: 'touch', name: 'top', axis: 'Z', direction: '-', searchMm: 'input.topSearchMm' },
    ...heightCalcs('touch.top.z'),
  ]
}

function riseToSafe(name: string): ProbeRoutineStep {
  return { kind: 'move', name, frame: 'machine', to: { z: 'calc.safeZ' } }
}

/** The way down to probing depth: a probe move that stops on contact, then a
 *  check that it got there - a contact above depth stops the routine. */
function descendToDepth(name: string, message: string): ProbeRoutineStep[] {
  return [
    { kind: 'move', name, frame: 'machine', to: { z: 'calc.depthZ' }, stopOnContact: true },
    {
      kind: 'check',
      condition: { cmp: '<=', left: `touch.${name}.z`, right: 'calc.depthZ + 0.001' },
      message,
    },
  ]
}

const LANDED_BESIDE_THE_FACE = 'The descent to probing depth touched something above that depth - start closer to the edge.'
const LANDED_IN_THE_HOLE = "The descent to probing depth touched something above that depth - start over the open hole, or check the top (work Z0 or the rim's machine Z)."
const LANDED_BESIDE_THE_BOSS = 'The descent to probing depth touched something above that depth - start over the middle of the boss, and check its diameter.'

/** A hole's start is over the hole at any height: rise to safe height only
 *  when the probe starts below it - never a plain move down. */
function riseToSafeWhenBelow(): ProbeRoutineStep {
  return {
    kind: 'branch',
    name: 'startHeight',
    condition: { cmp: '<', left: 'start.z', right: 'calc.safeZ' },
    then: [riseToSafe('riseToSafe')],
  }
}

/** Step-out from a start over the material to just past the face (design 4.2):
 *  start distance + tip radius + clearance. */
const SIDE_STEP_OUT_CALC: ProbeRoutineStep = {
  kind: 'calc',
  name: 'stepOut',
  unit: 'mm',
  expr: 'input.startDistanceMm + probe.tipRadiusMm + probe.surfaceClearanceMm',
}

/** WO-2569: one seek, bounded by the expected distance from the stepped-out
 *  start to the face plus configured overtravel (WO-2036). */
const SIDE_SEARCH_CALC: ProbeRoutineStep = {
  kind: 'calc',
  name: 'search',
  unit: 'mm',
  expr: 'input.startDistanceMm + probe.surfaceClearanceMm + probe.overtravelMm',
}

/** The start-frame offset that steps out past a face touched moving `direction`. */
function stepOutExpr(direction: Sign): string {
  return direction === '+' ? '-calc.stepOut' : 'calc.stepOut'
}

function signWord(axis: ProbeRoutineAxis, direction: Sign): string {
  if (axis === 'X') return direction === '-' ? 'left' : 'right'
  if (axis === 'Y') return direction === '-' ? 'toward the front' : 'toward the back'
  return direction === '-' ? 'down' : 'up'
}

function dirSlug(direction: Sign): string {
  return direction === '-' ? 'minus' : 'plus'
}

/** `touch.<name>.<axis> -+ probe.tipRadiusMm`: a + touch stops one radius
 *  before the face (add), a - touch one radius after it (subtract) -
 *  calculateEdge, WO-261. */
function faceExpr(touchName: string, axis: ProbeRoutineAxis, direction: Sign): string {
  const coordinate = `touch.${touchName}.${axis.toLowerCase()}`
  return direction === '+' ? `${coordinate} + probe.tipRadiusMm` : `${coordinate} - probe.tipRadiusMm`
}

function compensationSign(direction: Sign): string {
  return direction === '+' ? '+tip radius' : '-tip radius'
}

// --- 3.1 edge: four flat routines ----------------------------------------

function edgeRoutine(axis: 'X' | 'Y', direction: Sign): ProbeRoutine {
  const a = axis.toLowerCase()
  return {
    schemaVersion: 1,
    id: `factory.edge.${a}-${dirSlug(direction)}`,
    name: `Edge - ${axis}, probe moves ${signWord(axis, direction)}`,
    version: '2.0.0',
    provenance: { kind: 'factory' },
    description:
      `Start over the material, within the start distance of the face, at any height above it. It touches the top, rises to top + clearance, `
      + `steps out past the face, descends to top - depth (stopping if it touches anything), and touches the face moving ${signWord(axis, direction)}. `
      + 'The face is one tip radius beyond the contact.',
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [startDistanceInput(), depthInput(), topSearchInput()],
    steps: [
      ...touchTheTop(),
      SIDE_STEP_OUT_CALC,
      SIDE_SEARCH_CALC,
      riseToSafe('riseToSafe'),
      { kind: 'move', name: 'pastTheFace', frame: 'start', to: { [a]: stepOutExpr(direction) } },
      ...descendToDepth('descent', LANDED_BESIDE_THE_FACE),
      { kind: 'touch', name: 'face', axis, direction, searchMm: 'calc.search' },
      { kind: 'calc', name: `face${axis}`, unit: 'mm', expr: faceExpr('face', axis, direction) },
      riseToSafe('riseAfterFace'),
    ],
    outputs: [
      {
        kind: 'workOffset',
        wcs: 'active',
        label: `Set work ${axis} zero on the touched face`,
        compensationNote: `Probe tip radius compensation: ${compensationSign(direction)} on ${axis} (${axis}${direction} touch).`,
        axes: { [axis]: `calc.face${axis}` },
      },
    ],
  }
}

export const FACTORY_EDGE_X_MINUS: ProbeRoutine = edgeRoutine('X', '-')
export const FACTORY_EDGE_X_PLUS: ProbeRoutine = edgeRoutine('X', '+')
export const FACTORY_EDGE_Y_MINUS: ProbeRoutine = edgeRoutine('Y', '-')
export const FACTORY_EDGE_Y_PLUS: ProbeRoutine = edgeRoutine('Y', '+')

// --- 3.2 outside corner: four variants, around the corner from the top ------
//
// WO-2065 (design 4.2; the panel's WO-2056): the operator starts OVER the
// material near the corner, within the start distance of both faces. Each face
// gets its own step-out from that one start: the X face first, then back over
// the start at safe height, then out past the Y face. Until 2026-09-27 the
// probe was parked diagonally off the corner at probing depth and slid round.

function outsideCornerWords(xDirection: Sign, yDirection: Sign): { name: string; xFace: string; yFace: string } {
  const xFace = xDirection === '-' ? 'right' : 'left'
  const yFace = yDirection === '-' ? 'back' : 'front'
  return { name: `Outside corner - ${yFace} ${xFace}`, xFace, yFace }
}

function outsideCornerRoutine(xDirection: Sign, yDirection: Sign): ProbeRoutine {
  const w = outsideCornerWords(xDirection, yDirection)
  const steps: ProbeRoutineStep[] = [
    ...touchTheTop(),
    SIDE_STEP_OUT_CALC,
    SIDE_SEARCH_CALC,

    riseToSafe('riseToSafe'),
    { kind: 'move', name: `past${cap(w.xFace)}Face`, frame: 'start', to: { x: stepOutExpr(xDirection) } },
    ...descendToDepth('descentX', LANDED_BESIDE_THE_FACE),
    { kind: 'touch', name: 'xFace', axis: 'X', direction: xDirection, searchMm: 'calc.search' },
    { kind: 'calc', name: 'cornerX', unit: 'mm', expr: faceExpr('xFace', 'X', xDirection) },
    riseToSafe('riseAfterXFace'),

    { kind: 'move', name: 'backOverTheStart', frame: 'start', to: { x: '0', y: '0' } },
    { kind: 'move', name: `past${cap(w.yFace)}Face`, frame: 'start', to: { y: stepOutExpr(yDirection) } },
    ...descendToDepth('descentY', LANDED_BESIDE_THE_FACE),
    { kind: 'touch', name: 'yFace', axis: 'Y', direction: yDirection, searchMm: 'calc.search' },
    { kind: 'calc', name: 'cornerY', unit: 'mm', expr: faceExpr('yFace', 'Y', yDirection) },
    riseToSafe('riseAfterYFace'),
  ]
  return {
    schemaVersion: 1,
    id: `factory.corner.outside.x-${dirSlug(xDirection)}.y-${dirSlug(yDirection)}`,
    name: w.name,
    version: '2.0.0',
    provenance: { kind: 'factory' },
    description:
      `Start over the material within the start distance of the ${w.xFace} and ${w.yFace} faces, at any height. It touches the top; `
      + 'for each face it steps out past it at top + clearance, descends to top - depth (stopping if it touches anything) and touches it: '
      + `the ${w.xFace} face moving ${signWord('X', xDirection)}, then the ${w.yFace} face moving ${signWord('Y', yDirection)}. Proposes the corner as work zero.`,
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [startDistanceInput(), depthInput(), topSearchInput()],
    steps,
    outputs: [
      {
        kind: 'workOffset',
        wcs: 'active',
        label: 'Set work zero at the corner',
        compensationNote: `Probe tip radius compensation: ${compensationSign(xDirection)} on X and ${compensationSign(yDirection)} on Y (X${xDirection} and Y${yDirection} touches).`,
        axes: { X: 'calc.cornerX', Y: 'calc.cornerY' },
      },
      {
        kind: 'report',
        items: [
          { label: 'Corner X (machine)', expr: 'calc.cornerX', unit: 'mm' },
          { label: 'Corner Y (machine)', expr: 'calc.cornerY', unit: 'mm' },
        ],
      },
    ],
  }
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export const FACTORY_CORNER_OUTSIDE_X_MINUS_Y_MINUS: ProbeRoutine = outsideCornerRoutine('-', '-')
export const FACTORY_CORNER_OUTSIDE_X_PLUS_Y_MINUS: ProbeRoutine = outsideCornerRoutine('+', '-')
export const FACTORY_CORNER_OUTSIDE_X_MINUS_Y_PLUS: ProbeRoutine = outsideCornerRoutine('-', '+')
export const FACTORY_CORNER_OUTSIDE_X_PLUS_Y_PLUS: ProbeRoutine = outsideCornerRoutine('+', '+')

// --- 3.2 inside corner: two touches from one start ---------------------------

function insideCornerRoutine(xDirection: Sign, yDirection: Sign): ProbeRoutine {
  const xFace = xDirection === '-' ? 'left' : 'right'
  const yFace = yDirection === '-' ? 'front' : 'back'
  return {
    schemaVersion: 1,
    id: `${FACTORY_CORNER_INSIDE_PREFIX}x-${dirSlug(xDirection)}.y-${dirSlug(yDirection)}`,
    name: `Inside corner - ${yFace} ${xFace}`,
    version: '2.0.0',
    provenance: { kind: 'factory' },
    description:
      'Start over the pocket near the corner, clear of both walls, at any height. From top + clearance it descends to top - depth '
      + `(stopping if it touches anything), touches the ${xFace} wall moving ${signWord('X', xDirection)}, then the ${yFace} wall moving `
      + `${signWord('Y', yDirection)}, and rises again. The top is work Z0 or the rim's machine Z. Proposes the corner as work zero in X and Y.`,
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [
      { name: 'searchMm', label: 'Search up to (each wall)', type: 'length', unit: 'mm', min: 1, max: 50, default: 15 },
      holeTopInput(),
      depthInput(),
    ],
    steps: [
      ...heightCalcs('input.topZ'),
      riseToSafeWhenBelow(),
      ...descendToDepth('descent', LANDED_IN_THE_HOLE),
      { kind: 'touch', name: 'xFace', axis: 'X', direction: xDirection, searchMm: 'input.searchMm' },
      { kind: 'calc', name: 'cornerX', unit: 'mm', expr: faceExpr('xFace', 'X', xDirection) },
      { kind: 'touch', name: 'yFace', axis: 'Y', direction: yDirection, searchMm: 'input.searchMm' },
      { kind: 'calc', name: 'cornerY', unit: 'mm', expr: faceExpr('yFace', 'Y', yDirection) },
      riseToSafe('riseAfterWalls'),
    ],
    outputs: [
      {
        kind: 'workOffset',
        wcs: 'active',
        label: 'Set work zero at the inside corner',
        compensationNote: `Probe tip radius compensation: ${compensationSign(xDirection)} on X and ${compensationSign(yDirection)} on Y (X${xDirection} and Y${yDirection} touches).`,
        axes: { X: 'calc.cornerX', Y: 'calc.cornerY' },
      },
      {
        kind: 'report',
        items: [
          { label: 'Corner X (machine)', expr: 'calc.cornerX', unit: 'mm' },
          { label: 'Corner Y (machine)', expr: 'calc.cornerY', unit: 'mm' },
        ],
      },
    ],
  }
}

export const FACTORY_CORNER_INSIDE_X_MINUS_Y_MINUS: ProbeRoutine = insideCornerRoutine('-', '-')
export const FACTORY_CORNER_INSIDE_X_PLUS_Y_MINUS: ProbeRoutine = insideCornerRoutine('+', '-')
export const FACTORY_CORNER_INSIDE_X_MINUS_Y_PLUS: ProbeRoutine = insideCornerRoutine('-', '+')
export const FACTORY_CORNER_INSIDE_X_PLUS_Y_PLUS: ProbeRoutine = insideCornerRoutine('+', '+')

// --- 3.3 bore centre (the contract's touches, from the top since WO-2065) -------

export const FACTORY_BORE_CENTRE_ID = 'factory.bore-centre'

export const FACTORY_BORE_CENTRE: ProbeRoutine = {
  schemaVersion: 1,
  id: FACTORY_BORE_CENTRE_ID,
  name: 'Bore centre',
  version: '3.0.0',
  provenance: { kind: 'factory' },
  description: 'Start roughly over the hole centre, at any height. Rises to top + clearance if below it, then descends to top - depth (stopping on contact). Four wall seeks at Search then Probe speed, returning toward the start away from each wall, then rises to top + clearance. The top is work Z0 unless you type the rim\'s machine Z. Proposes the centre as work zero and reports the diameter.',
  requires: { homed: true, envelope: 'full', probe: 'touch' },
  inputs: [
    { name: 'diameter', label: 'Bore diameter, about', type: 'length', unit: 'mm', min: 3, max: 300, default: 20 },
    holeTopInput(),
    depthInput(),
  ],
  steps: [
    // WO-2554: nominal diameter never determines a move toward a wall.
    {
      kind: 'check',
      condition: { cmp: '>', left: 'input.diameter / 2', right: 'probe.tipRadiusMm' },
      message: 'The bore diameter must be larger than the probe tip.',
    },
    { kind: 'calc', name: 'search', unit: 'mm', expr: 'probe.maxTravelMm' },
    ...heightCalcs('input.topZ'),
    riseToSafeWhenBelow(),
    ...descendToDepth('descent', LANDED_IN_THE_HOLE),

    { kind: 'touch', name: 'left', axis: 'X', direction: '-', searchMm: 'calc.search' },
    // A back-off already across the starting line must not move toward this wall.
    {
      kind: 'branch', name: 'returnAfterLeft',
      condition: { cmp: '<', left: 'touch.left.x + probe.retractMm', right: 'start.x' },
      then: [{ kind: 'move', name: 'backFromLeft', frame: 'start', to: { x: '0' } }],
    },

    { kind: 'touch', name: 'right', axis: 'X', direction: '+', searchMm: 'calc.search' },
    // A back-off already across the starting line must not move toward this wall.
    {
      kind: 'branch', name: 'returnAfterRight',
      condition: { cmp: '>', left: 'touch.right.x - probe.retractMm', right: 'start.x' },
      then: [{ kind: 'move', name: 'backFromRight', frame: 'start', to: { x: '0' } }],
    },

    { kind: 'touch', name: 'front', axis: 'Y', direction: '-', searchMm: 'calc.search' },
    // A back-off already across the starting line must not move toward this wall.
    {
      kind: 'branch', name: 'returnAfterFront',
      condition: { cmp: '<', left: 'touch.front.y + probe.retractMm', right: 'start.y' },
      then: [{ kind: 'move', name: 'backFromFront', frame: 'start', to: { y: '0' } }],
    },

    { kind: 'touch', name: 'back', axis: 'Y', direction: '+', searchMm: 'calc.search' },
    // A back-off already across the starting line must not move toward this wall.
    {
      kind: 'branch', name: 'returnAfterBack',
      condition: { cmp: '>', left: 'touch.back.y - probe.retractMm', right: 'start.y' },
      then: [{ kind: 'move', name: 'backFromBack', frame: 'start', to: { y: '0' } }],
    },
    riseToSafe('riseAfterWalls'),

    { kind: 'calc', name: 'centreX', unit: 'mm', expr: '(touch.left.x + touch.right.x) / 2' },
    { kind: 'calc', name: 'centreY', unit: 'mm', expr: '(touch.front.y + touch.back.y) / 2' },
    { kind: 'calc', name: 'diameterX', unit: 'mm', expr: 'touch.right.x - touch.left.x + 2 * probe.tipRadiusMm' },
    { kind: 'calc', name: 'diameterY', unit: 'mm', expr: 'touch.back.y - touch.front.y + 2 * probe.tipRadiusMm' },
    {
      kind: 'check',
      condition: {
        all: [
          { cmp: '>', left: 'calc.diameterX', right: '0' },
          { cmp: '>', left: 'calc.diameterY', right: '0' },
        ],
      },
      message: 'The touches do not describe a positive diameter - the probe did not touch opposite walls.',
    },
  ],
  outputs: [
    {
      kind: 'workOffset',
      wcs: 'active',
      label: 'Set work zero at the bore centre',
      compensationNote: 'Probe tip radius compensation: tip radius added at both walls (2x radius per measured diameter); the centre needs none.',
      axes: { X: 'calc.centreX', Y: 'calc.centreY' },
    },
    {
      kind: 'report',
      items: [
        { label: 'Diameter (X)', expr: 'calc.diameterX', unit: 'mm' },
        { label: 'Diameter (Y)', expr: 'calc.diameterY', unit: 'mm' },
      ],
    },
  ],
}

// --- 3.4 boss centre (the contract's touches, from the top since WO-2065) -------
//
// WO-2065 (design 4.1, 4.2; the panel's WO-2058): the operator starts OVER THE
// MIDDLE of the boss, by eye, at any height above it. The routine touches the
// top there; each face is touched from a start stepped out nominal radius + tip
// radius + clearance from the middle, after a descent to top - depth that stops
// on contact; every move between faces runs at top + clearance - the top it
// touched, so it never moves through the boss. It ends over the middle at that
// height. Until 2026-09-27 the operator started just left of the boss below its
// top and every cross-over ran at a cross-over height the machine filled in
// (WO-2052: its safe Z, or start + lift when higher).

export const FACTORY_BOSS_CENTRE_ID = 'factory.boss-centre'

/** How far below the top of Z travel the boss cross-over runs when the machine
 *  declares no safe Z (as probeFeatureCycle's boss and the setter crossing). */
export const BOSS_CROSS_OVER_BELOW_Z_TOP_MM = 1

/**
 * WO-2052: the boss cross-over height a machine gives a boss routine that
 * declares a `crossOverZ` input, machine Z: its declared safe Z, else the top
 * of Z travel less 1 mm. Null when neither is known. Since WO-2065 the factory
 * boss crosses at its touched top + clearance and declares no such input, so
 * this and bossRoutineForMachine leave it unchanged.
 */
export function bossCrossOverDefaultZ(
  safeZMachineMm: number | null | undefined,
  zTravelMaxMm: number | null | undefined,
): number | null {
  if (typeof safeZMachineMm === 'number' && Number.isFinite(safeZMachineMm)) return safeZMachineMm
  if (typeof zTravelMaxMm === 'number' && Number.isFinite(zTravelMaxMm)) return zTravelMaxMm - BOSS_CROSS_OVER_BELOW_Z_TOP_MM
  return null
}

/** One face of the boss: over its stepped-out start at safe height, down to
 *  depth (stopping on contact), the touch, and back up to safe height. */
function bossFace(
  name: 'left' | 'right' | 'front' | 'back',
  to: { x: string; y: string },
  axis: 'X' | 'Y',
  direction: Sign,
): ProbeRoutineStep[] {
  return [
    { kind: 'move', name: `over${cap(name)}Start`, frame: 'start', to },
    ...descendToDepth(`descent${cap(name)}`, LANDED_BESIDE_THE_BOSS),
    { kind: 'touch', name, axis, direction, searchMm: 'calc.search' },
    riseToSafe(`riseAfter${cap(name)}`),
  ]
}

export const FACTORY_BOSS_CENTRE: ProbeRoutine = {
  schemaVersion: 1,
  id: FACTORY_BOSS_CENTRE_ID,
  name: 'Boss centre',
  version: '2.0.0',
  provenance: { kind: 'factory' },
  description: 'Start over the middle of the boss, by eye, at any height above it. It touches the top, rises to top + clearance, and for each of the four faces steps out past it at that height, descends to top - depth (stopping if it touches anything), touches it and rises again - it never moves across the boss below top + clearance. Ends over the middle. Proposes the centre as work zero and reports the diameter.',
  requires: { homed: true, envelope: 'full', probe: 'touch' },
  inputs: [
    { name: 'diameter', label: 'Boss diameter, about', type: 'length', unit: 'mm', min: 3, max: 300, default: 20 },
    depthInput(),
    topSearchInput(),
  ],
  steps: [
    { kind: 'calc', name: 'approach', unit: 'mm', expr: 'input.diameter / 2 + probe.tipRadiusMm + probe.surfaceClearanceMm' },
    { kind: 'calc', name: 'search', unit: 'mm', expr: 'probe.surfaceClearanceMm + probe.overtravelMm' },
    ...touchTheTop(),
    riseToSafe('riseToSafe'),

    ...bossFace('left', { x: '-calc.approach', y: '0' }, 'X', '+'),
    ...bossFace('right', { x: 'calc.approach', y: '0' }, 'X', '-'),
    ...bossFace('front', { x: '0', y: '-calc.approach' }, 'Y', '+'),
    ...bossFace('back', { x: '0', y: 'calc.approach' }, 'Y', '-'),
    { kind: 'move', name: 'finishOverTheMiddle', frame: 'start', to: { x: '0', y: '0' } },

    { kind: 'calc', name: 'centreX', unit: 'mm', expr: '(touch.left.x + touch.right.x) / 2' },
    { kind: 'calc', name: 'centreY', unit: 'mm', expr: '(touch.front.y + touch.back.y) / 2' },
    { kind: 'calc', name: 'diameterX', unit: 'mm', expr: 'touch.right.x - touch.left.x - 2 * probe.tipRadiusMm' },
    { kind: 'calc', name: 'diameterY', unit: 'mm', expr: 'touch.back.y - touch.front.y - 2 * probe.tipRadiusMm' },
    {
      kind: 'check',
      condition: {
        all: [
          { cmp: '>', left: 'calc.diameterX', right: '0' },
          { cmp: '>', left: 'calc.diameterY', right: '0' },
        ],
      },
      message: 'The touches do not describe a positive diameter - the probe did not touch opposite faces.',
    },
  ],
  outputs: [
    {
      kind: 'workOffset',
      wcs: 'active',
      label: 'Set work zero at the boss centre',
      compensationNote: 'Probe tip radius compensation: tip radius subtracted at both faces (2x radius per measured diameter); the centre needs none.',
      axes: { X: 'calc.centreX', Y: 'calc.centreY' },
    },
    {
      kind: 'report',
      items: [
        { label: 'Diameter (X)', expr: 'calc.diameterX', unit: 'mm' },
        { label: 'Diameter (Y)', expr: 'calc.diameterY', unit: 'mm' },
      ],
    },
  ],
}

// --- WO-1613: the tool setter measure ------------------------------------------
//
// Operator 2026-09-16 18:04Z: every user's setter and distances are form fields,
// not macro text files, and the tool never rushes into the setter - the
// descent onto it runs at the fast probe speed unless the user raises it.
// `requires.probe: 'toolSetter'` marks the routine; its INPUTS are the whole
// measure (probeRoutineExpand.planToolSetterMeasure turns them into moves), and
// the steps below say the same path in the routine format's words. Speeds are
// `length` inputs read per minute, so the screen converts them with the rest.

export const FACTORY_TOOL_SETTER_ID = 'factory.tool-setter'

/** The input names a tool setter routine must declare. */
export const TOOL_SETTER_INPUTS = [
  'setterX',
  'setterY',
  'crossingZ',
  'clearanceMm',
  'approachFeed',
  'fastFeed',
  'fineFeed',
  'retractMm',
  'fineSearchMm',
  'maxSearchMm',
] as const
export type ToolSetterInputName = (typeof TOOL_SETTER_INPUTS)[number]

/** The values a setter routine's defaults are filled from. */
export type ToolSetterDefaults = Record<ToolSetterInputName, number>

/** Generic numbers for the compiled routine; a machine definition replaces
 *  the setter position, crossing height and search depth (toolSetterRoutineForMachine). */
export const GENERIC_TOOL_SETTER_DEFAULTS: ToolSetterDefaults = {
  setterX: 0,
  setterY: 0,
  crossingZ: 0,
  clearanceMm: 5,
  approachFeed: 400,
  fastFeed: 400,
  fineFeed: 50,
  retractMm: 2,
  fineSearchMm: 4,
  maxSearchMm: 100,
}

function toolSetterRoutine(d: ToolSetterDefaults): ProbeRoutine {
  return {
    schemaVersion: 1,
    id: FACTORY_TOOL_SETTER_ID,
    name: 'Tool setter - measure tool length',
    version: '1.0.0',
    provenance: { kind: 'factory' },
    description:
      'Raises Z to the crossing height, crosses to the setter, then comes down onto it. When the tool table knows the '
      + "tool's length it descends at the approach speed to the clearance above the expected touch, as a probe move that "
      + 'stops if the setter triggers early. Then a fast and a fine touch; the fine one is the measurement.',
    requires: { homed: true, envelope: 'full', probe: 'toolSetter' },
    inputs: [
      { name: 'setterX', label: 'Setter X (machine)', type: 'length', unit: 'mm', min: -COORDINATE_BOUND_MM, max: COORDINATE_BOUND_MM, default: d.setterX },
      { name: 'setterY', label: 'Setter Y (machine)', type: 'length', unit: 'mm', min: -COORDINATE_BOUND_MM, max: COORDINATE_BOUND_MM, default: d.setterY },
      { name: 'crossingZ', label: 'Crossing height, machine Z', type: 'length', unit: 'mm', min: -COORDINATE_BOUND_MM, max: COORDINATE_BOUND_MM, default: d.crossingZ, help: 'Z is raised to this before any XY move, so a long tool never meets the setter from the side.' },
      { name: 'clearanceMm', label: 'Approach clearance above the expected touch', type: 'length', unit: 'mm', min: 0.5, max: 50, default: d.clearanceMm },
      { name: 'approachFeed', label: 'Approach speed, per minute', type: 'length', unit: 'mm', min: 1, max: 10000, default: d.approachFeed, help: 'The descent toward the expected touch. It stops if the setter triggers early, whatever the speed.' },
      { name: 'fastFeed', label: 'Fast probe speed, per minute', type: 'length', unit: 'mm', min: 1, max: 5000, default: d.fastFeed },
      { name: 'fineFeed', label: 'Fine probe speed, per minute', type: 'length', unit: 'mm', min: 1, max: 5000, default: d.fineFeed },
      { name: 'retractMm', label: 'Retract after a touch', type: 'length', unit: 'mm', min: 0.2, max: 20, default: d.retractMm },
      { name: 'fineSearchMm', label: 'Fine search distance', type: 'length', unit: 'mm', min: 0.5, max: 40, default: d.fineSearchMm },
      { name: 'maxSearchMm', label: 'Maximum search depth below the crossing height', type: 'length', unit: 'mm', min: 1, max: 2000, default: d.maxSearchMm },
    ],
    steps: [
      { kind: 'move', name: 'crossingHeight', frame: 'machine', to: { z: 'input.crossingZ' } },
      { kind: 'move', name: 'overSetter', frame: 'machine', to: { x: 'input.setterX', y: 'input.setterY' } },
      { kind: 'touch', name: 'setter', axis: 'Z', direction: '-', searchMm: 'input.maxSearchMm', retractMm: 'input.retractMm', backoffMm: 'input.retractMm' },
    ],
    outputs: [
      { kind: 'toolLength', tool: 'active', machineZ: 'touch.setter.z', label: 'Record the measured tool length' },
    ],
  }
}

export const FACTORY_TOOL_SETTER: ProbeRoutine = toolSetterRoutine(GENERIC_TOOL_SETTER_DEFAULTS)

/** A routine the Measure tool button can run: it asks for the tool setter and
 *  declares every setter input as a length. */
export function isToolSetterRoutine(routine: ProbeRoutine): boolean {
  if (routine.requires?.probe !== 'toolSetter') return false
  return TOOL_SETTER_INPUTS.every((name) =>
    routine.inputs.some((input) => input.name === name && input.type === 'length'))
}

/**
 * The factory setter routine with the defaults this machine's definition
 * supplies (setter X/Y, crossing height, search depth) and its probe profile
 * (speeds, retract). A value outside an input's bounds is clamped to them.
 * A user or imported routine is returned unchanged: its defaults are its own.
 */
export function toolSetterRoutineForMachine(
  routine: ProbeRoutine,
  defaults: Partial<ToolSetterDefaults>,
): ProbeRoutine {
  if (routine.provenance.kind !== 'factory' || routine.id !== FACTORY_TOOL_SETTER_ID) return routine
  return {
    ...routine,
    inputs: routine.inputs.map((input) => {
      const value = defaults[input.name as ToolSetterInputName]
      if (input.type !== 'length' || value === undefined || !Number.isFinite(value)) return input
      return { ...input, default: Number(Math.min(input.max, Math.max(input.min, value)).toFixed(4)) }
    }),
  }
}

/**
 * WO-2052: the factory boss routine with this machine's cross-over height
 * (bossCrossOverDefaultZ) as its `crossOverZ` default, clamped to the input's
 * bounds. Any other routine, or no height, is returned unchanged. Since
 * WO-2065 the factory boss has no `crossOverZ` input (it crosses at its
 * touched top + clearance), so this returns it unchanged; the Routines tab
 * still calls it (ProbeRoutineEditor).
 */
export function bossRoutineForMachine(routine: ProbeRoutine, crossOverZ: number | null | undefined): ProbeRoutine {
  if (routine.provenance.kind !== 'factory' || routine.id !== FACTORY_BOSS_CENTRE_ID) return routine
  if (typeof crossOverZ !== 'number' || !Number.isFinite(crossOverZ)) return routine
  return {
    ...routine,
    inputs: routine.inputs.map((input) => {
      if (input.name !== 'crossOverZ' || input.type !== 'length') return input
      return { ...input, default: Number(Math.min(input.max, Math.max(input.min, crossOverZ)).toFixed(4)) }
    }),
  }
}

/** True for the factory Bore centre and every factory Inside corner variant -
 *  the routines WO-2074 gives a `topZ` input. */
export function isFactoryHoleRoutineId(id: string | null | undefined): boolean {
  return id === FACTORY_BORE_CENTRE_ID || (typeof id === 'string' && id.startsWith(FACTORY_CORNER_INSIDE_PREFIX))
}

/** "G54 Z 0 (machine Z 43.78)" - Operator's rule: any wording that shows a top
 *  names its coordinate system. */
function workZeroCoordinateLabel(activeWcs: string | null | undefined, machineZ: number): string {
  return `${activeWcs ?? 'work'} Z 0 (machine Z ${machineZ})`
}

/**
 * WO-2074: the factory Bore centre / Inside corner routine with this
 * machine's work Z0 (machine Z, the active work offset's Z) as its `topZ`
 * default, clamped to the input's bounds, and named with its coordinate
 * system in the help text. The routine's safe height and probing depth are
 * measured from it (WO-2065). Any other routine, or no known work Z0, is
 * returned unchanged.
 */
export function holeRoutineForMachine(
  routine: ProbeRoutine,
  workZeroMachineZ: number | null | undefined,
  activeWcs: string | null | undefined,
): ProbeRoutine {
  if (routine.provenance.kind !== 'factory' || !isFactoryHoleRoutineId(routine.id)) return routine
  if (typeof workZeroMachineZ !== 'number' || !Number.isFinite(workZeroMachineZ)) return routine
  return {
    ...routine,
    inputs: routine.inputs.map((input) => {
      if (input.name !== 'topZ' || input.type !== 'length') return input
      const clamped = Number(Math.min(input.max, Math.max(input.min, workZeroMachineZ)).toFixed(4))
      return { ...input, default: clamped, help: `Defaults to ${workZeroCoordinateLabel(activeWcs, clamped)} - the hole is in the face Z0 was probed on. Type the rim's machine Z instead if you touched it there.` }
    }),
  }
}

// --- the list ------------------------------------------------------------------

export const FACTORY_PROBE_ROUTINES: readonly ProbeRoutine[] = [
  FACTORY_EDGE_X_MINUS,
  FACTORY_EDGE_X_PLUS,
  FACTORY_EDGE_Y_MINUS,
  FACTORY_EDGE_Y_PLUS,
  FACTORY_CORNER_OUTSIDE_X_MINUS_Y_MINUS,
  FACTORY_CORNER_OUTSIDE_X_PLUS_Y_MINUS,
  FACTORY_CORNER_OUTSIDE_X_MINUS_Y_PLUS,
  FACTORY_CORNER_OUTSIDE_X_PLUS_Y_PLUS,
  FACTORY_CORNER_INSIDE_X_MINUS_Y_MINUS,
  FACTORY_CORNER_INSIDE_X_PLUS_Y_MINUS,
  FACTORY_CORNER_INSIDE_X_MINUS_Y_PLUS,
  FACTORY_CORNER_INSIDE_X_PLUS_Y_PLUS,
  FACTORY_BORE_CENTRE,
  FACTORY_BOSS_CENTRE,
  FACTORY_TOOL_SETTER,
]

export function findFactoryRoutine(id: string): ProbeRoutine | null {
  return FACTORY_PROBE_ROUTINES.find((routine) => routine.id === id) ?? null
}

/** The picker's edge tile chooses among the four flat edge files. */
export function factoryEdgeRoutine(axis: 'X' | 'Y', direction: ProbeRoutineDirection): ProbeRoutine {
  return findFactoryRoutine(`factory.edge.${axis.toLowerCase()}-${dirSlug(direction)}`)!
}

/** The picker's corner tiles choose among the eight corner files. */
export function factoryCornerRoutine(
  kind: 'inside' | 'outside',
  xDirection: ProbeRoutineDirection,
  yDirection: ProbeRoutineDirection,
): ProbeRoutine {
  return findFactoryRoutine(`factory.corner.${kind}.x-${dirSlug(xDirection)}.y-${dirSlug(yDirection)}`)!
}

// --- the contract's INVALID example (section 3.5) - a test fixture, NOT factory --

/**
 * `user.bad-slot`, verbatim from the contract. Typed `unknown` because it is
 * not a ProbeRoutine: it carries a `gcode` step and an unbounded input. The
 * static validator must report exactly the contract's static errors on it.
 * Never listed, never stored; it exists so a test can pin the sentences.
 */
export const CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT: unknown = {
  schemaVersion: 1,
  id: 'user.bad-slot',
  name: 'Slot width (broken on purpose)',
  version: '0.1.0',
  provenance: { kind: 'user' },
  description: 'Two touches across a slot. Every mistake below is one the validator must name.',
  requires: { homed: false, envelope: 'axis', probe: 'touch' },
  inputs: [
    { name: 'widthMm', label: 'Slot width, about', type: 'length', unit: 'mm', default: 10 },
  ],
  steps: [
    { kind: 'move', name: 'toLeftWall', frame: 'start', to: { x: '-900' }, feed: 'rapid' },
    { kind: 'touch', name: 'left', axis: 'X', direction: '-', searchMm: '80', searchFeedFactor: 2.5 },
    { kind: 'move', name: 'toRightWall', frame: 'start', to: { x: 'input.widthMm' } },
    { kind: 'touch', name: 'right', axis: 'X', direction: '+', searchMm: 'input.widthMm' },
    {
      kind: 'calc',
      name: 'width',
      unit: 'mm',
      expr: '((((((((((touch.right.x - touch.left.x + 2 * probe.tipRadiusMm) / (touch.right.x - touch.right.x)))))))))) * 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1',
    },
    { kind: 'gcode', line: 'G10 L20 P0 X0' },
  ],
  outputs: [
    { kind: 'workOffset', wcs: 'G54', axes: { X: 'calc.centre' }, label: 'Set X zero' },
  ],
}
