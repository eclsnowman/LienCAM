// programPath - turn a g-code PROGRAM into the app's shared 3D move vocabulary
// (`ToolpathMove[]`), with 1-based source-line attribution per move.
//
// WHY THIS EXISTS AS A LIB, NOT INSIDE THE CONTROL TAB:
//
// The app already renders 3D toolpaths in two places - the Toolpath tab and the
// Simulation panel - but BOTH consume CAM output, which is already
// `ToolpathMove[]` straight from the operation engines. Nothing converted the
// other direction: a posted or opened g-code PROGRAM had no route into the 3D
// scene. `lib/gcode/backplot.ts` renders a 2D SVG plan view, and
// `lib/machine/previewGeometry.ts` builds XY polylines - neither produces moves.
//
// So this is the missing adapter, and it belongs beside the other machine-side
// g-code modules rather than inside a React component: anything that can render
// `ToolpathMove[]` can now render a program. That includes the Control tab
// today, and a g-code-driven simulation or a post-process preview later.
//
// It deliberately REUSES what already exists rather than re-deriving it:
// `buildPreviewModel` supplies arc-centre reconstruction, arc sampling, and
// G90/G91-corrected per-segment start/end depths (z0/z), so the 3D path never
// re-derives modal interpretation in a second place.

import { buildPreviewModel, type PreviewModel, type PreviewMove } from './previewGeometry'
import { placeMachineFrameTarget, type MachineFramePlacement } from './pathFidelity'
import type { MoveRole, ToolpathMove } from '../../types'

/** Display-only classification of resolved loaded-program endpoints. Unknown
 * starts stay cut; rapids and arcs retain their commanded motion semantics.
 * Shared by text, staged listings and armed geometry, never by the sender. */
export function loadedProgramMoveRole(
  kind: 'rapid' | 'feed' | 'arc',
  from: { x?: number; y?: number; z?: number } | null,
  to: { x: number; y: number; z: number },
): MoveRole {
  if (kind === 'rapid') return 'rapid'
  if (kind !== 'feed' || from?.x !== to.x || from?.y !== to.y || from?.z === undefined) return 'cut'
  if (to.z < from.z) return 'plunge'
  if (to.z > from.z) return 'retract'
  return 'cut'
}

export interface ProgramPath {
  moves: ToolpathMove[]
  /** 1-based source line for moves[i] - the key the sender's cursor uses. */
  moveLines: number[]
  /** WO-3263: source lines of G53 feed moves left undrawn because no live
   *  work offset was known to place them. Absent when there are none. */
  unplacedMachineLines?: number[]
}

/** WO-3263: the placement of the frame the preview draws the program in -
 *  its origin in machine coordinates and its XY rotation - or null when the
 *  controller has not reported it. */
export type PlaceMachineFrame = () => MachineFramePlacement | null

/**
 * WO-3263: the frame the viewport draws the program in. ProgramPreview hands
 * the viewport the ACTIVE work offset as the program's origin and turns the
 * program by the ACTIVE offset's reported rotation
 * (resolveProgramPreviewGrid's programOriginMachine, resolvePreviewRotation's
 * programDeg), whatever G54..G59 the program itself selects. A G53 target is a
 * machine position, so it is turned into THAT frame: drawn through the same
 * transform, it lands on its machine position in every view. The rows are the
 * controller-reported ones; no stored project offset enters it.
 */
export function placeMachineFrameFromReported(
  offsets: Readonly<Record<string, readonly number[] | undefined>>,
  activeWcs: string | null,
  rotations: Readonly<Record<string, number>>,
): PlaceMachineFrame {
  return () => {
    const row = activeWcs === null ? undefined : offsets[activeWcs]
    if (!row || row.length < 3 || !row.slice(0, 3).every(Number.isFinite)) return null
    const degrees = rotations[activeWcs!] ?? 0
    return {
      origin: { x: row[0], y: row[1], z: row[2] },
      rotationDeg: Number.isFinite(degrees) ? degrees : 0,
    }
  }
}

/**
 * Build the 3D path for a program. Z is interpolated across a sampled arc,
 * which is exactly right for a helix and harmless for a flat one.
 */
export function buildProgramPath(
  programText: string | null,
  /** WO-3263: places G53 feed moves. Without it they are not drawn, as before. */
  placeMachineFrame?: PlaceMachineFrame,
): ProgramPath {
  if (!programText) return { moves: [], moveLines: [] }
  return programPathFromPreview(buildPreviewModel(programText), placeMachineFrame)
}

/** WO-3125: the exact same adapter for an already parsed source program. */
export function programPathFromPreview(model: Readonly<PreviewModel>, placeMachineFrame?: PlaceMachineFrame): ProgramPath {
  const moves: ToolpathMove[] = []
  const moveLines: number[] = []
  // WO-3263: a G53 FEED move is a straight line to a machine target. The model
  // keeps it out of the work polylines until a caller has a live offset (see
  // resolveProgramSegments); placed here, it is drawn as the feed it is. G53
  // rapids are parks and stay undrawn, as designed.
  const machineFeeds: PreviewMove[] = placeMachineFrame === undefined
    ? []
    : model.moves.filter((move) => move.coordinateFrame === 'machine' && move.kind === 'feed')
  const unplacedMachineLines: number[] = []
  let nextMachineFeed = 0
  // Axes a placed G53 move left where the machine is: a later work move that
  // does not name one of them runs at that value, not the model's.
  const held: Partial<Record<'x' | 'y' | 'z', number>> = {}
  let last: { x: number; y: number; z: number } | null = null
  const push = (move: ToolpathMove, line: number): void => {
    moves.push(move)
    moveLines.push(line)
    last = { x: move.x, y: move.y, z: move.z }
  }
  const flushMachineFeeds = (beforeLine: number): void => {
    while (nextMachineFeed < machineFeeds.length && machineFeeds[nextMachineFeed].line < beforeLine) {
      const feed = machineFeeds[nextMachineFeed++]
      const placement = placeMachineFrame!()
      if (placement === null) {
        unplacedMachineLines.push(feed.line)
        continue
      }
      const target: Partial<Record<'x' | 'y' | 'z', number>> = {}
      for (const axis of feed.addressedAxes) {
        if (axis === 'x' || axis === 'y' || axis === 'z') target[axis] = feed.to[axis]
      }
      // Before anything is drawn the tool is where the preview assumes every
      // program starts (the work origin, WO-1639).
      const from = last ?? { x: 0, y: 0, z: 0 }
      const to = placeMachineFrameTarget(from, target, placement)
      if (moves.length === 0) push({ type: 'feed', role: 'cut', ...from }, feed.line)
      push({ type: 'feed', role: loadedProgramMoveRole('feed', from, to), ...to }, feed.line)
      if (target.x !== undefined || target.y !== undefined) {
        held.x = to.x
        held.y = to.y
      }
      if (target.z !== undefined) held.z = to.z
    }
  }

  for (let i = 0; i < model.polylines.length; i++) {
    const poly = model.polylines[i]
    flushMachineFeeds(poly.line)
    for (const axis of poly.addressedAxes ?? ['x', 'y', 'z']) {
      if (axis === 'x' || axis === 'y' || axis === 'z') delete held[axis]
    }
    const z0 = held.z ?? poly.z0
    const z1 = held.z ?? poly.z
    const pts = held.x === undefined && held.y === undefined
      ? poly.points
      : poly.points.map((p) => ({ x: held.x ?? p.x, y: held.y ?? p.y }))
    for (let k = 0; k < pts.length; k++) {
      // A polyline's first point is the previous one's endpoint; emit it only
      // to seed the very first move.
      if (k === 0 && moves.length > 0) continue
      const t = pts.length > 1 ? k / (pts.length - 1) : 1
      push({
        type: poly.kind === 'rapid' ? 'rapid' : 'feed',
        role: loadedProgramMoveRole(poly.kind, { ...pts[0], z: z0 }, { ...pts[pts.length - 1], z: z1 }),
        x: pts[k].x,
        y: pts[k].y,
        z: z0 + (z1 - z0) * t,
      }, poly.line)
    }
  }
  flushMachineFeeds(Infinity)
  return unplacedMachineLines.length === 0 ? { moves, moveLines } : { moves, moveLines, unplacedMachineLines }
}

/**
 * The contiguous run of points belonging to one source line, as a polyline -
 * what a viewport highlights as "the move executing right now". Returns null
 * when the line produced no geometry (a modal header, M3, M5), so a caller
 * clears the highlight instead of pointing it at the wrong move.
 */
export function segmentPointsForLine(
  path: ProgramPath,
  line: number,
): Array<{ x: number; y: number; z: number }> | null {
  if (line <= 0) return null
  const first = path.moveLines.indexOf(line)
  if (first < 0) return null
  let last = first
  while (last + 1 < path.moveLines.length && path.moveLines[last + 1] === line) last++
  // A single-move line still needs its start point to draw as a line.
  const from = first > 0 ? first - 1 : first
  if (last <= from) return null
  const pts: Array<{ x: number; y: number; z: number }> = []
  for (let i = from; i <= last; i++) {
    const m = path.moves[i]
    pts.push({ x: m.x, y: m.y, z: m.z })
  }
  return pts
}
