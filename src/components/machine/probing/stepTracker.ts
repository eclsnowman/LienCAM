// WO-2063 - "While it runs, both views follow the machine's real position
// live" (docs/design/PROBING-SCREEN-V2.md, job 3).
//
// The runners report touches, not steps, so the screen follows the steps from
// the one fact every controller streams: the machine position. Each step's
// moves have a direction (X+, Z-, ...); the tracker stays on a move while the
// machine moves that way, measures how far along it is, and moves on when the
// machine starts moving the way a later move goes. A probe move that reverses
// on its own axis has touched (the back-off and slow touch belong to it).
//
// Pure: fed positions, returns a new state. The panel owns the timing.

import type { P3, ProbeScene, StepMove } from './probeScene'

export interface TrackerState {
  /** Index into scene.steps of the step the machine is on. */
  step: number
  /** Which of that step's moves. */
  move: number
  /** 0..1 along that move. */
  t: number
  /** Machine position where the current move began. */
  segStart: P3
  /** Last machine position seen. */
  last: P3
  /** The current step's touch has happened. */
  touched: boolean
  /** The real length of the last schematic probe move (machineMm), measured
   *  where it touched. */
  touchMm?: number | null
}

type Dir = { axis: 'x' | 'y' | 'z'; sign: 1 | -1 } | null

const MOVE_EPS = 0.005

function dirOf(dx: number, dy: number, dz: number, eps = MOVE_EPS): Dir {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const az = Math.abs(dz)
  const m = Math.max(ax, ay, az)
  if (m < eps) return null
  if (m === ax) return { axis: 'x', sign: dx > 0 ? 1 : -1 }
  if (m === ay) return { axis: 'y', sign: dy > 0 ? 1 : -1 }
  return { axis: 'z', sign: dz > 0 ? 1 : -1 }
}

function moveDir(m: StepMove): Dir {
  return dirOf(m.to.x - m.from.x, m.to.y - m.from.y, m.to.z - m.from.z, 1e-9)
}

const same = (a: Dir, b: Dir) => a !== null && b !== null && a.axis === b.axis && a.sign === b.sign

/** The machine going the way a move goes. A move drawn to a schematic length
 *  (machineMm - Tool Z's crossing to the setter) matches any sideways motion:
 *  the real crossing may run diagonally where the picture draws X. */
function goes(d: Dir, m: StepMove): boolean {
  const md = moveDir(m)
  if (m.machineMm === undefined) return same(d, md)
  if (d === null || md === null) return false
  return md.axis === 'z' ? d.axis === 'z' && d.sign === md.sign : d.axis !== 'z'
}

/** How far along the move `pos` is, from where the machine began it; not clamped. */
function rawProgressOn(m: StepMove, segStart: P3, pos: P3, touchMm?: number | null): number {
  // Drawn to a schematic length: the share of the machine's real distance.
  if (m.machineMm !== undefined) {
    const real = m.machineMmFromTouch && touchMm ? touchMm : m.machineMm
    return Math.hypot(pos.x - segStart.x, pos.y - segStart.y, pos.z - segStart.z) / real
  }
  const vx = m.to.x - m.from.x
  const vy = m.to.y - m.from.y
  const vz = m.to.z - m.from.z
  const len2 = vx * vx + vy * vy + vz * vz
  if (len2 < 1e-12) return 1
  return ((pos.x - segStart.x) * vx + (pos.y - segStart.y) * vy + (pos.z - segStart.z) * vz) / len2
}

function progressOn(m: StepMove, segStart: P3, pos: P3, touchMm?: number | null, searchMm?: number | null): number {
  // WO-2115: a search from the operator's start is followed over its whole
  // search, so the drawn probe reaches the surface only when the real one touches.
  const raw = searchMm ? Math.hypot(pos.x - segStart.x, pos.y - segStart.y, pos.z - segStart.z) / searchMm : rawProgressOn(m, segStart, pos, touchMm)
  return Math.max(0, Math.min(1, raw))
}

/**
 * WO-2115: the machine's first move, when it searches from wherever the
 * operator left the probe (the top search, Z0's touch, the Z surface's point
 * 1). That start is any height up to the search above the surface; the
 * picture draws it at one height, so where the real probe will touch is not
 * known until it does. Followed at the drawn distance, the drawn probe reached
 * the top ~5 mm early and waited there for the real touch (walkthrough
 * 2026-09-28). Returns the search's full length when it runs farther than the
 * drawn move: the drawn probe covers the drawn distance as the machine covers
 * the search - it tracks the machine's Z, never ahead of it, and reaches the
 * surface when the real probe touches. Otherwise null (followed as drawn).
 * A run that stops on it is still drawn where the machine went (stoppedAt).
 */
export function startSearchMm(scene: ProbeScene, m: StepMove | null | undefined): number | null {
  if (!m || m.kind !== 'probe' || m.machineMm !== undefined || !m.searchMm) return null
  if (scene.steps[firstMachineStep(scene)]?.moves[0] !== m) return null
  const drawn = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y, m.to.z - m.from.z)
  return m.searchMm > drawn + 1e-9 ? m.searchMm : null
}

/** The first machine step (after the YOU steps that start the run). */
export function firstMachineStep(scene: ProbeScene): number {
  const i = scene.steps.findIndex((s) => s.owner === 'machine' && s.moves.length > 0)
  return i < 0 ? 0 : i
}

function nextMove(scene: ProbeScene, step: number, move: number): { step: number; move: number } | null {
  let si = step
  let mi = move + 1
  while (si < scene.steps.length && mi >= scene.steps[si].moves.length) {
    si++
    mi = 0
  }
  return si < scene.steps.length ? { step: si, move: mi } : null
}

export function startTracker(scene: ProbeScene, machineStart: P3): TrackerState {
  return { step: firstMachineStep(scene), move: 0, t: 0, segStart: { ...machineStart }, last: { ...machineStart }, touched: false }
}

/**
 * WO-2113: where the drawn probe stands when the run ends here. The tracker
 * holds an untouched probe move just short of its end while it runs; a run
 * that stops on it (a miss: no top within the search) went as far as the
 * machine really went - past the drawn top, never resting on it.
 */
export function stoppedAt(scene: ProbeScene, state: TrackerState): P3 | null {
  const cur = scene.steps[state.step]?.moves[state.move]
  if (!cur) return null
  const t = cur.kind === 'probe' && !state.touched
    ? Math.max(0, rawProgressOn(cur, state.segStart, state.last, state.touchMm))
    : state.t
  return {
    x: cur.from.x + (cur.to.x - cur.from.x) * t,
    y: cur.from.y + (cur.to.y - cur.from.y) * t,
    z: cur.from.z + (cur.to.z - cur.from.z) * t,
  }
}

export function trackPosition(scene: ProbeScene, state: TrackerState, pos: P3): TrackerState {
  const d = dirOf(pos.x - state.last.x, pos.y - state.last.y, pos.z - state.last.z)
  if (!d) return state
  const step = scene.steps[state.step]
  const cur = step?.moves[state.move]
  if (!cur) return { ...state, last: { ...pos } }
  const cd = moveDir(cur)
  const next = nextMove(scene, state.step, state.move)
  if (goes(d, cur)) {
    // A move that does not probe ends where the plan says. Carrying on the
    // same way past that end is the next move when it goes the same way
    // (Bore / Rect pocket: "toward the wall", then "probes" to it). A probe
    // move keeps the machine until it reverses: its search may run past `to`.
    const nm = next ? scene.steps[next.step].moves[next.move] : null
    const len = Math.hypot(cur.to.x - cur.from.x, cur.to.y - cur.from.y, cur.to.z - cur.from.z)
    const raw = rawProgressOn(cur, state.segStart, pos, state.touchMm)
    if (cur.kind !== 'probe' && next && nm && goes(d, nm) && (raw - 1) * (cur.machineMm ?? len) > MOVE_EPS) {
      const end: P3 = {
        x: state.segStart.x + cur.to.x - cur.from.x,
        y: state.segStart.y + cur.to.y - cur.from.y,
        z: state.segStart.z + cur.to.z - cur.from.z,
      }
      return {
        step: next.step,
        move: next.move,
        t: nm.kind === 'probe' ? Math.min(progressOn(nm, end, pos, state.touchMm), 0.999) : progressOn(nm, end, pos, state.touchMm),
        segStart: end,
        last: { ...pos },
        touched: next.step === state.step ? state.touched : false,
        touchMm: state.touchMm,
      }
    }
    const t = progressOn(cur, state.segStart, pos, state.touchMm, startSearchMm(scene, cur))
    return { ...state, t: cur.kind === 'probe' && !state.touched ? Math.min(t, 0.999) : t, last: { ...pos } }
  }
  // Only the NEXT move can take over: the runner's own back-off and slow
  // touch reverse on the probe's axis, and a wider look-ahead would read the
  // slow touch as a later step's descent.
  const reversed = cur.kind === 'probe' && cd !== null && d.axis === cd.axis && d.sign !== cd.sign
  const touchMm = reversed && cur.machineMm !== undefined
    ? Math.hypot(state.last.x - state.segStart.x, state.last.y - state.segStart.y, state.last.z - state.segStart.z)
    : state.touchMm
  if (next && goes(d, scene.steps[next.step].moves[next.move])) {
    const m = scene.steps[next.step].moves[next.move]
    return {
      step: next.step,
      move: next.move,
      t: progressOn(m, state.last, pos, touchMm),
      segStart: { ...state.last },
      last: { ...pos },
      // Reversing off a probe move means it touched; a new step starts untouched.
      touched: next.step === state.step ? state.touched || reversed : false,
      touchMm,
    }
  }
  if (reversed) return { ...state, t: 1, touched: true, last: { ...pos }, touchMm }
  return { ...state, last: { ...pos } }
}
