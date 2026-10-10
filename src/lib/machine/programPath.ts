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

import { buildPreviewModel } from './previewGeometry'
import type { ToolpathMove } from '../../types'

export interface ProgramPath {
  moves: ToolpathMove[]
  /** 1-based source line for moves[i] - the key the sender's cursor uses. */
  moveLines: number[]
}

/**
 * Build the 3D path for a program. Z is interpolated across a sampled arc,
 * which is exactly right for a helix and harmless for a flat one.
 */
export function buildProgramPath(programText: string | null): ProgramPath {
  if (!programText) return { moves: [], moveLines: [] }
  const model = buildPreviewModel(programText)
  const moves: ToolpathMove[] = []
  const moveLines: number[] = []

  for (let i = 0; i < model.polylines.length; i++) {
    const poly = model.polylines[i]
    const z0 = poly.z0
    const z1 = poly.z
    const pts = poly.points
    for (let k = 0; k < pts.length; k++) {
      // A polyline's first point is the previous one's endpoint; emit it only
      // to seed the very first move.
      if (k === 0 && moves.length > 0) continue
      const t = pts.length > 1 ? k / (pts.length - 1) : 1
      moves.push({
        type: poly.kind === 'rapid' ? 'rapid' : 'feed',
        role: poly.kind === 'rapid' ? 'rapid' : 'cut',
        x: pts[k].x,
        y: pts[k].y,
        z: z0 + (z1 - z0) * t,
      })
      moveLines.push(poly.line)
    }
  }
  return { moves, moveLines }
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
