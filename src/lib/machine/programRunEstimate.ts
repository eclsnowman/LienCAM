import type { MachineConfig, ToolpathMove } from '../../types'
import type { ProgramStep } from './controller'
import { readGcodeProgram, type GcodeReaderOptions } from '../gcode/reader'
import { estimateRuntimeMs, plannedMoveDurationsMs } from '../cam/runtime'
import { machineCutTimeMotion } from '../simulation/machineCutTimeMotion'

export interface ProgramRunEstimate {
  totalMs: number
  /** Cursor of the move executing, not a count of moves sent ahead. */
  fromCursor: (cursor: number) => number
  /** WO-2684: where every move before `cursor` ends, in the program's own
   *  work frame - where the machine stands once they have all run - and the
   *  cursor of the last of them. Null before the file's first move. */
  endBefore: (cursor: number) => { x: number; y: number; z: number; cursor: number } | null
  /** WO-2684 (machine seat 10-08): the time left from inside the move at
   *  `cursor` - its unfinished part plus every move after it. The unfinished
   *  part is read from where the machine stands along that move (`at`, the
   *  program's own work frame); when the machine is not on it, or stands in a
   *  dwell, from how long the move has been running (`msInMove`). A cursor on a line with no
   *  motion (an M0, a tool change) has started nothing: every move after it. */
  remainingAt: (cursor: number, at: { x: number; y: number; z: number } | null, msInMove: number) => number
}

/** Off the planned path by more than this, a reported position does not say
 *  how far along a move the machine is. */
const ON_MOVE_MM = 0.5

/** How far along `to` (from `from`) a position stands, and how far off it. */
function alongMove(from: ToolpathMove, to: ToolpathMove, at: { x: number; y: number; z: number }): { done: number; offMm: number } {
  if ((to.type === 'arc_cw' || to.type === 'arc_ccw') && to.cx !== undefined && to.cy !== undefined) {
    const start = Math.atan2(from.y - to.cy, from.x - to.cx)
    const end = Math.atan2(to.y - to.cy, to.x - to.cx)
    const turn = (a: number) => {
      const t = to.type === 'arc_ccw' ? a - start : start - a
      return ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    }
    const sweep = turn(end) || 2 * Math.PI
    const turned = turn(Math.atan2(at.y - to.cy, at.x - to.cx))
    // Outside the swept angle: at whichever end is nearer.
    const done = turned <= sweep ? turned / sweep : turned < sweep + (2 * Math.PI - sweep) / 2 ? 1 : 0
    const radius = Math.hypot(from.x - to.cx, from.y - to.cy)
    const z = from.z + (to.z - from.z) * done
    return { done, offMm: Math.hypot(Math.hypot(at.x - to.cx, at.y - to.cy) - radius, at.z - z) }
  }
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const lengthSq = d.x * d.x + d.y * d.y + d.z * d.z
  const done = lengthSq === 0 ? 1
    : Math.max(0, Math.min(1, ((at.x - from.x) * d.x + (at.y - from.y) * d.y + (at.z - from.z) * d.z) / lengthSq))
  return {
    done,
    offMm: Math.hypot(at.x - from.x - d.x * done, at.y - from.y - d.y * done, at.z - from.z - d.z * done),
  }
}

function estimate(moves: ToolpathMove[], cursors: number[], machine: MachineConfig): ProgramRunEstimate | null {
  if (moves.length < 2) return null
  const rapid = machine.rapidRate
  const motion = machineCutTimeMotion(machine)
  const speed = (m: ToolpathMove) => m.type === 'rapid' ? rapid : m.feed as number
  const durations = motion ? plannedMoveDurationsMs(moves, speed, motion) : null
  const suffix = new Array<number>(moves.length + 1).fill(0)
  const travel = new Array<number>(moves.length).fill(0)
  for (let i = moves.length - 1; i > 0; i--) {
    travel[i] = durations?.[i] ?? estimateRuntimeMs([moves[i - 1], moves[i]], rapid)
    suffix[i] = suffix[i + 1] + travel[i] + (moves[i].dwellMs ?? 0)
  }
  // The first move at or after the cursor.
  const firstAt = (cursor: number): number => {
    let low = 1
    let high = cursors.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (cursors[middle] < cursor) low = middle + 1
      else high = middle
    }
    return low
  }
  return {
    totalMs: suffix[1],
    fromCursor: (cursor) => suffix[firstAt(cursor)],
    endBefore: (cursor) => {
      const last = firstAt(cursor) - 1
      return last < 1 ? null : { x: moves[last].x, y: moves[last].y, z: moves[last].z, cursor: cursors[last] }
    },
    remainingAt: (cursor, at, msInMove) => {
      const first = firstAt(cursor)
      if (first >= moves.length || cursors[first] !== cursor) return suffix[first]
      // One line can be several moves (a sampled arc, a dwell on its line).
      let past = first
      while (past < moves.length && cursors[past] === cursor) past++
      if (at) {
        // The earliest of them the machine stands on: never skip a pass.
        let before = 0
        for (let i = first; i < past; i++) {
          const along = alongMove(moves[i - 1], moves[i], at)
          const dwell = moves[i].dwellMs ?? 0
          before += travel[i]
          if (along.offMm <= ON_MOVE_MM) {
            // Standing still in a dwell (review 10-08), where it stands says
            // nothing: its time less the time the line has run past its motion.
            const dwellLeft = along.done < 1 ? dwell : Math.min(dwell, Math.max(0, before + dwell - msInMove))
            return (1 - along.done) * travel[i] + dwellLeft + suffix[i + 1]
          }
          before += dwell
        }
      }
      // Not on it (no position, or a frame the reader could not match): the
      // time it has run, never past the end of the line's own moves.
      let ran = Math.max(0, msInMove)
      for (let i = first; i < past; i++) {
        const own = travel[i] + (moves[i].dwellMs ?? 0)
        if (ran < own) return own - ran + suffix[i + 1]
        ran -= own
      }
      return suffix[past]
    },
  }
}

/** Adapt the file reader's geometry; WO-2148 remains the only time planner. */
export function textProgramRunEstimate(text: string, machine: MachineConfig, options: GcodeReaderOptions): ProgramRunEstimate | null {
  const read = readGcodeProgram(text, options)
  if (!read.ok) return null
  const moves: ToolpathMove[] = [{ type: 'rapid', ...options.initialPosition }, ...read.program.moves]
  const cursors = [0, ...read.program.moveLines]
  for (const item of read.program.items) {
    if (item.kind !== 'dwell') continue
    // A dwell belongs to its own line, including when no motion shares it.
    const index = cursors.findIndex((line) => line > item.line)
    const at = index < 0 ? moves.length : index
    moves.splice(at, 0, { ...moves[at - 1], type: 'rapid', dwellMs: item.seconds * 1000 })
    cursors.splice(at, 0, item.line)
  }
  return estimate(moves, cursors, machine)
}

/** Staged file/toolpath doors already hold the geometry the controller runs. */
export function stagedProgramRunEstimate(steps: readonly ProgramStep[], machine: MachineConfig): ProgramRunEstimate | null {
  const moves: ToolpathMove[] = [{ type: 'rapid', x: 0, y: 0, z: 0 }]
  const cursors = [0]
  // Step ids are not program order: a file's dwells and stop fences take ids
  // above its moves (WO-2684 review 10-08: G4 P10000 then G1 X20 staged as
  // ids 4 then 3). The estimate runs on each step's place in the program.
  const place = new Map<number, number>()
  steps.forEach((step, index) => place.set(step.id, index + 1))
  const placeOf = (id: number): number => {
    const known = place.get(id)
    if (known !== undefined) return known
    // An id no step carries: the first step at or after it.
    let first = steps.length + 1
    for (const [stepId, at] of place) if (stepId >= id && at < first) first = at
    return first
  }
  for (const step of steps) {
    const previous = moves[moves.length - 1]
    if (step.kind === 'line' || step.kind === 'arc') {
      const at = { x: step.to.x ?? previous.x, y: step.to.y ?? previous.y, z: step.to.z ?? previous.z }
      if (step.kind === 'arc' && step.plane !== 'xy') {
        // The shared reader samples non-XY arcs into the XYZ vocabulary.
        const plane = step.plane === 'xz' ? 'G18' : 'G19'
        const centre = step.plane === 'xz'
          ? `I${step.centre.x - previous.x} K${step.centre.z - previous.z}`
          : `J${step.centre.y - previous.y} K${step.centre.z - previous.z}`
        const read = readGcodeProgram(`G21 G90 ${plane}\nG${step.clockwise ? 2 : 3} X${at.x} Y${at.y} Z${at.z} ${centre} F${step.feedMmMin}`, {
          dialect: 'generic', sessionWcs: 'G54', initialPosition: previous,
        })
        if (!read.ok) return null
        for (const move of read.program.moves) { moves.push(move); cursors.push(placeOf(step.id)) }
      } else {
        moves.push(step.kind === 'arc'
          ? { ...at, type: step.clockwise ? 'arc_cw' : 'arc_ccw', cx: step.centre.x, cy: step.centre.y, feed: step.feedMmMin }
          : { ...at, type: step.rapid ? 'rapid' : 'feed', feed: step.feedMmMin })
        cursors.push(placeOf(step.id))
      }
    } else if (step.kind === 'dwell') {
      moves.push({ ...previous, type: 'rapid', dwellMs: step.seconds * 1000 })
      cursors.push(placeOf(step.id))
    }
  }
  const own = estimate(moves, cursors, machine)
  if (!own) return null
  return {
    totalMs: own.totalMs,
    fromCursor: (id) => own.fromCursor(placeOf(id)),
    endBefore: (id) => {
      const end = own.endBefore(placeOf(id))
      return end && { ...end, cursor: steps[end.cursor - 1].id }
    },
    remainingAt: (id, at, msInMove) => own.remainingAt(placeOf(id), at, msInMove),
  }
}
