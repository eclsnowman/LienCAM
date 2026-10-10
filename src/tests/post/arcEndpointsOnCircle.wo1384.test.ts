// ============================================================
// WO-1384: posted arcs must keep both endpoints on the circle they emit
// ============================================================
// The recorded defect: `collapsePolyline` fitted a circle whose center made
// every original point's RADIAL DEVIATION individually pass `arcTolerance`,
// then emitted the arc with the ORIGINAL endpoints and that fitted center.
// An unconstrained least-squares fit can satisfy that per-point check while
// the two endpoints sit on slightly DIFFERENT radii from the fitted center --
// a controller that recomputes start/end radius from the emitted X/Y/I/J (as
// a strict arc-move validator does) then rejects the block. Recorded case:
// `X52.18 Y179.729 I11.849 J14.191` from `X54.934 Y176.803`, radii 18.4874 vs
// 18.4431 mm, 0.0443 mm apart.
//
// This test drives the REAL production path end to end: a Project ->
// buildPostInput -> postProgram (UCCNC). It parses every emitted G2/G3 block,
// reconstructs the start/end radius from the actual emitted text (never a
// hand-derived expectation), and asserts they agree within 0.002 mm -- the
// rounding budget left by the dialect's 3-decimal coordinate format.

import { describe, it, expect } from 'vitest'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { makeMachine, makeOp, makeTool, makeWcs, stampGenerationCurrent } from './helpers'
import type { Project, Setup, ToolpathMove, Vec2 } from '../../types'

// --- near-circle fixture geometry --------------------------------------------
// A run of points mostly exact on a true circle, with ONE interior sample
// nudged off-circle by 0.05 mm -- the same shape of noise real CAM offset /
// fillet math introduces (individually within the 0.05 mm default
// arcTolerance, so the run still collapses to an arc; not a rejection case).
// An UNCONSTRAINED least-squares fit lets that single nudge drag the fitted
// center off the start/end perpendicular bisector, reproducing the defect;
// the WO-1384 fix locks the center onto that bisector so it cannot.
const RADIUS = 20
const SAMPLES = 11
const SWEEP_DEG = 65
const PERTURB_INDEX = 3 // one interior sample, nudged +0.05mm outward
const PERTURB_MM = 0.05

function nearCirclePts(cx: number, cy: number): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const deg = (SWEEP_DEG * i) / (SAMPLES - 1)
    const t = (deg * Math.PI) / 180
    const r = RADIUS + (i === PERTURB_INDEX ? PERTURB_MM : 0)
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  return pts
}

/** Rotate then translate a point set -- models a nest placement transform: a
 *  seed's local toolpath rotated to its placed angle and offset to its sheet
 *  position. */
function placeRotated(pts: Vec2[], angleDeg: number, offset: Vec2): Vec2[] {
  const t = (angleDeg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return pts.map((p) => ({
    x: offset.x + p.x * c - p.y * s,
    y: offset.y + p.x * s + p.y * c,
  }))
}

/** A rapid to pts[0] anchors the run, then dense 'cut' feed moves through the
 *  rest -- the same shape arcfit-collapse.test.ts's arcFeedMoves uses. */
function feedRun(pts: Vec2[], z: number, feed: number): ToolpathMove[] {
  const anchor: ToolpathMove = { type: 'rapid', x: pts[0].x, y: pts[0].y, z }
  const cuts: ToolpathMove[] = pts.slice(1).map((p) => ({
    type: 'feed',
    x: p.x,
    y: p.y,
    z,
    feed,
    role: 'cut',
  }))
  return [anchor, ...cuts]
}

function buildProject(wcs = makeWcs()): Project {
  const tool = makeTool({ id: 't1', toolNumber: 1 })

  // Run 1: the plain contour, centered at the WCS origin.
  const plain = nearCirclePts(0, 0)
  // Run 2: the SAME noisy shape as a rotated + translated copy -- a nest
  // placing a second instance of the same seed geometry at a different angle
  // and sheet position.
  const rotatedCopy = placeRotated(nearCirclePts(0, 0), 41, { x: 60, y: 35 })

  const op = makeOp({
    id: 'op-arcs',
    name: 'Arc endpoints',
    type: 'contour_2d',
    toolId: 't1',
    toolpathMoves: [
      ...feedRun(plain, 0, 800),
      ...feedRun(rotatedCopy, 0, 800),
    ],
  })

  const setup: Setup = {
    id: 's1',
    name: 'Setup 1',
    wcs,
    stock: {} as Setup['stock'],
    operations: [op],
    notes: '',
  }

  const project: Project = {
    id: 'p1',
    name: 'P',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [tool],
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }

  stampGenerationCurrent(project, setup, op, tool)
  return project
}

// --- G-code G2/G3 endpoint-radius parser -------------------------------------
// Reads the ACTUAL emitted text (never a hand-derived expectation), tracking
// modal X/Y across every line so a suppressed word still resolves to the
// carried-forward position -- exactly what a controller does.
function parseWords(line: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of line.matchAll(/([A-Z])(-?[0-9.]+)/g)) out[m[1]] = Number(m[2])
  return out
}

interface ArcCheck {
  line: string
  startRadius: number
  endRadius: number
  diff: number
}

function checkArcEndpointRadii(gcode: string): ArcCheck[] {
  const results: ArcCheck[] = []
  let curX = 0
  let curY = 0
  for (const line of gcode.split('\n')) {
    if (line.length === 0) continue
    const words = parseWords(line)
    const isArc = /^G[23]\b/.test(line)
    const startX = curX
    const startY = curY
    const endX = words.X ?? curX
    const endY = words.Y ?? curY
    if (isArc && typeof words.I === 'number' && typeof words.J === 'number') {
      const centerX = startX + words.I
      const centerY = startY + words.J
      const startRadius = Math.hypot(startX - centerX, startY - centerY)
      const endRadius = Math.hypot(endX - centerX, endY - centerY)
      results.push({ line, startRadius, endRadius, diff: Math.abs(startRadius - endRadius) })
    }
    curX = endX
    curY = endY
  }
  return results
}

describe('WO-1384: posted arc endpoints stay on the circle they emit', () => {
  it('every G2/G3 start and end radius agree within 0.002mm (plain contour + rotated copy)', () => {
    const project = buildProject()
    const setup = project.setups[0]
    const input = buildPostInput(project, setup)
    const result = postProgram(input, UCCNC_CONFIG)

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)

    const arcs = checkArcEndpointRadii(result.gcode)
    // Sanity: the fixture actually produced arcs (not all lines).
    expect(arcs.length).toBeGreaterThan(0)

    for (const arc of arcs) {
      expect(arc.diff, `${arc.line} -> start r=${arc.startRadius} end r=${arc.endRadius}`).toBeLessThanOrEqual(0.002)
    }
  })

  it('holds under a rotated WCS too (I/J rotation composes with the endpoint lock)', () => {
    const wcs = makeWcs({ xAxis: { x: 0, y: -1, z: 0 }, yAxis: { x: 1, y: 0, z: 0 } })
    const project = buildProject(wcs)
    const setup = project.setups[0]
    const input = buildPostInput(project, setup)
    const result = postProgram(input, UCCNC_CONFIG)

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)

    const arcs = checkArcEndpointRadii(result.gcode)
    expect(arcs.length).toBeGreaterThan(0)
    for (const arc of arcs) {
      expect(arc.diff, `${arc.line} -> start r=${arc.startRadius} end r=${arc.endRadius}`).toBeLessThanOrEqual(0.002)
    }
  })
})
