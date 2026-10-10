// MC-TIER1 goal 3: the 3D program path the Control-tab viewport renders.
//
// The viewport itself needs WebGL, so these pin the PURE half - the geometry
// handed to renderToolpath and the segment lookup the frame loop uses to
// highlight the executing move. Getting this wrong is not a cosmetic bug: a
// plunge drawn at the wrong Z, or a highlight pointing at the wrong line, tells
// the operator the machine is somewhere it is not.

import { describe, it, expect } from 'vitest'
import { buildProgramPath, segmentPointsForLine } from '../../lib/machine/programPath'

const PROGRAM = [
  'G21 G90 G54', // 1
  'M3 S12000', // 2
  'G0 X0 Y0', // 3
  'G0 Z5', // 4
  'G1 Z-2 F300', // 5  plunge: XY still, Z moves
  'G1 X10 Y0 F800', // 6
  'G1 X10 Y10', // 7
  'G0 Z5', // 8
  'M5', // 9
].join('\n')

describe('MC-TIER1: 3D program path', () => {
  it('carries real Z, so a plunge is a vertical move and not a dot', () => {
    const path = buildProgramPath(PROGRAM)
    const plunge = path.moves.filter((_, i) => path.moveLines[i] === 5)
    expect(plunge.length).toBeGreaterThan(0)

    const end = plunge[plunge.length - 1]
    expect(end.z).toBeCloseTo(-2, 6)
    expect(end.x).toBeCloseTo(0, 6)
    expect(end.y).toBeCloseTo(0, 6)

    // The move BEFORE it ended at Z5, so the pair spans a real 7mm descent -
    // the exact thing the old 2D plan view could not show.
    const idx = path.moveLines.indexOf(5)
    expect(path.moves[idx - 1].z).toBeCloseTo(5, 6)
  })

  it('marks rapids and cuts distinctly so the viewport can colour them', () => {
    const path = buildProgramPath(PROGRAM)
    const rapid = path.moves[path.moveLines.indexOf(4)]
    const cut = path.moves[path.moveLines.indexOf(6)]
    expect(rapid.type).toBe('rapid')
    expect(rapid.role).toBe('rapid')
    expect(cut.type).toBe('feed')
    expect(cut.role).toBe('cut')
  })

  it('attributes every move to a 1-based source line, the sender cursor key', () => {
    const path = buildProgramPath(PROGRAM)
    expect(path.moves.length).toBe(path.moveLines.length)
    expect(path.moveLines.every((l) => Number.isInteger(l) && l >= 1)).toBe(true)
    // Motion lines only: M3/M5 and the modal header produce no geometry.
    expect(new Set(path.moveLines)).toEqual(new Set([3, 4, 5, 6, 7, 8]))
  })

  it('an empty or absent program yields an empty path, not a throw', () => {
    expect(buildProgramPath(null)).toEqual({ moves: [], moveLines: [] })
    expect(buildProgramPath('')).toEqual({ moves: [], moveLines: [] })
    expect(buildProgramPath('(just a comment)\n')).toEqual({ moves: [], moveLines: [] })
  })

  it('samples an arc into a polyline rather than cutting the corner', () => {
    const arc = ['G21 G90 G54', 'G0 X0 Y0', 'G1 Z-1 F200', 'G2 X10 Y10 I10 J0 F600'].join('\n')
    const path = buildProgramPath(arc)
    const pts = path.moves.filter((_, i) => path.moveLines[i] === 4)
    expect(pts.length).toBeGreaterThan(4) // a chord would be a single move
    // Every sample sits on the commanded radius about the reconstructed centre.
    for (const p of pts) {
      expect(Math.hypot(p.x - 10, p.y - 0)).toBeCloseTo(10, 3)
    }
  })
})

describe('MC-TIER1: executing-segment lookup', () => {
  it('returns the run of points for the cursor line, including its start', () => {
    const path = buildProgramPath(PROGRAM)
    const seg = segmentPointsForLine(path, 6)
    expect(seg).not.toBeNull()
    expect(seg!.length).toBeGreaterThanOrEqual(2)
    // Line 6 cuts from (0,0,-2) to (10,0,-2).
    expect(seg![0].x).toBeCloseTo(0, 6)
    expect(seg![seg!.length - 1].x).toBeCloseTo(10, 6)
    expect(seg![seg!.length - 1].z).toBeCloseTo(-2, 6)
  })

  it('refuses a line with no geometry instead of highlighting the wrong move', () => {
    const path = buildProgramPath(PROGRAM)
    expect(segmentPointsForLine(path, 1)).toBeNull() // modal header
    expect(segmentPointsForLine(path, 2)).toBeNull() // M3
    expect(segmentPointsForLine(path, 9)).toBeNull() // M5
    expect(segmentPointsForLine(path, 0)).toBeNull() // no cursor yet
    expect(segmentPointsForLine(path, 999)).toBeNull() // past the end
  })

  it('keeps a sampled arc whole - the highlight is the arc, not one chord', () => {
    const arc = ['G21 G90 G54', 'G0 X0 Y0', 'G1 Z-1 F200', 'G2 X10 Y10 I10 J0 F600'].join('\n')
    const seg = segmentPointsForLine(buildProgramPath(arc), 4)
    expect(seg!.length).toBeGreaterThan(4)
  })
})
