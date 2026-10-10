import { describe, expect, it } from 'vitest'
import {
  buildSurfaceMeshPoints,
  compileSurfaceCompensatedProgram,
  fingerprintProgram,
  planSurfaceMesh,
  surfaceCompensationAt,
  type SurfaceMeshMap,
} from '../../lib/machine/zSurfaceMesh'

const PROGRAM = [
  'G21 G90',
  'G0 X-50 Y-50 Z5',
  'G0 X10 Y20',
  'G1 Z-0.2 F100',
  'G1 X30 Y20 F400',
  'G2 X30 Y40 I0 J10',
  'G1 X10 Y40',
  'G1 X10 Y20',
  'G0 Z5',
  'G0 X100 Y100',
].join('\n')

function slopedMesh(programText = PROGRAM): SurfaceMeshMap {
  const bounds = { minX: 8, minY: 18, maxX: 32, maxY: 42 }
  const points = buildSurfaceMeshPoints(bounds, 3, 3)
  const samples = points.map((point) => ({
    ...point,
    machineZ: 10 + (point.x - bounds.minX) * 0.01 + (point.y - bounds.minY) * 0.02,
  }))
  return {
    bounds,
    cutBounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
    pointsX: 3,
    pointsY: 3,
    fadeMm: 10,
    referenceMachineZ: samples[0].machineZ,
    samples,
    sourceFingerprint: fingerprintProgram(programText),
    sourceName: 'mesh.nc',
    workOffset: 'G54',
    probedAt: 1,
    active: true,
  }
}

describe('surface mesh planning', () => {
  it('derives defaults from cutting moves, excludes rapids, and adds the margin', () => {
    const result = planSurfaceMesh(PROGRAM, { marginMm: 2, pointsX: 3, pointsY: 4, fadeMm: 8 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.setup.cutBounds).toEqual({ minX: 10, minY: 20, maxX: 30, maxY: 40 })
    expect(result.setup.bounds).toEqual({ minX: 8, minY: 18, maxX: 32, maxY: 42 })
    expect(result.points).toHaveLength(12)
    expect(result.points.slice(0, 3).map((point) => point.column)).toEqual([0, 1, 2])
    expect(result.points.slice(3, 6).map((point) => point.column)).toEqual([2, 1, 0])
  })

  it('refuses an edited mesh rectangle that no longer covers all cutting moves', () => {
    const result = planSurfaceMesh(PROGRAM, {
      bounds: { minX: 11, minY: 18, maxX: 32, maxY: 42 },
      pointsX: 3,
      pointsY: 3,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'The measured mesh must cover every cutting move. Expand the area or reset it to the cutting bounds.',
    })
  })
})

describe('surface mesh interpolation and spatial fade', () => {
  it('bilinearly interpolates the measured field inside the grid', () => {
    const result = surfaceCompensationAt(slopedMesh(), 20, 30)
    expect(result?.insideMeasuredArea).toBe(true)
    expect(result?.fadeWeight).toBe(1)
    expect(result?.offsetMm).toBeCloseTo(0.36, 6)
  })

  it('is continuous at the measured edge and eases to exactly flat outside the fade band', () => {
    const mesh = slopedMesh()
    const edge = surfaceCompensationAt(mesh, 32, 30)!
    const barelyOutside = surfaceCompensationAt(mesh, 32.001, 30)!
    const halfway = surfaceCompensationAt(mesh, 37, 30)!
    const flat = surfaceCompensationAt(mesh, 42, 30)!
    const beyond = surfaceCompensationAt(mesh, 60, 30)!
    expect(Math.abs(edge.offsetMm - barelyOutside.offsetMm)).toBeLessThan(0.00001)
    expect(halfway.fadeWeight).toBeCloseTo(0.5, 6)
    expect(flat).toMatchObject({ offsetMm: 0, fadeWeight: 0, insideMeasuredArea: false })
    expect(beyond.offsetMm).toBe(0)
  })
})

describe('surface compensated program compiler', () => {
  it('subdivides feeds and arcs, preserves source attribution, and returns to flat Z beyond the fade', () => {
    const result = compileSurfaceCompensatedProgram(PROGRAM, slopedMesh(), {
      maxSegmentMm: 4,
      splitDeltaZMm: 0.02,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.generatedMotionLines).toBeGreaterThan(20)
    expect(result.lines.filter((line) => line.sourceLine === 6).length).toBeGreaterThan(8)
    expect(result.lines.filter((line) => line.sourceLine === 6).every((line) => line.text.startsWith('G1 '))).toBe(true)
    const last = result.lines.filter((line) => line.sourceLine === 10).at(-1)
    expect(last?.text).toContain('X100 Y100 Z5')
  })

  // WO-2283 (Operator 2026-09-30): the mesh belongs to its work system, not to
  // the program it was planned from - another program compiles against it.
  it('compensates another program in the mesh work system, and fails closed on incremental motion', () => {
    const mesh = slopedMesh()
    const other = compileSurfaceCompensatedProgram(`${PROGRAM}\nM30`, mesh)
    expect(other.ok, other.ok ? '' : other.reason).toBe(true)
    if (other.ok) expect(other.generatedMotionLines).toBeGreaterThan(20)
    const incremental = 'G21 G90\nG1 X0 Y0 Z0\nG91\nG1 X1'
    const incrementalMesh = slopedMesh(incremental)
    expect(compileSurfaceCompensatedProgram(incremental, incrementalMesh)).toEqual({
      ok: false,
      reason: 'Mesh compensation currently requires absolute G90 motion.',
    })
  })

  it('fails closed on modal, machine-coordinate, and auxiliary-axis programs the compiler cannot preserve', () => {
    for (const [line, expected] of [
      ['G53 G0 X0', 'uses G18, G19, G53, G92, or G93'],
      ['G18 G2 X10 Z0 I5 K0', 'uses G18, G19, G53, G92, or G93'],
      ['G1 X10 A90', 'contains rotary or auxiliary-axis motion'],
    ] as const) {
      const program = `G21 G90\nG1 X0 Y0 Z0\n${line}`
      const result = compileSurfaceCompensatedProgram(program, slopedMesh(program))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain(expected)
    }
  })
})

describe('WO-2283: only the moves in the mesh work system are compensated', () => {
  const mesh = slopedMesh()
  const surface = (x: number, y: number) => surfaceCompensationAt(mesh, x, y)!.offsetMm

  it('passes a program that runs wholly in another work system through untouched', () => {
    expect(compileSurfaceCompensatedProgram(PROGRAM, mesh, { startWcs: 'G55' }))
      .toEqual({ ok: true, lines: [], generatedMotionLines: 0 })
    expect(compileSurfaceCompensatedProgram(`G55\n${PROGRAM}`, mesh))
      .toEqual({ ok: true, lines: [], generatedMotionLines: 0 })
  })

  it('compensates the G54 moves and sends the G55 moves as written', () => {
    const program = [
      'G21 G90 G54',
      'G0 X10 Y20 Z5',
      'G1 Z-0.2 F100',
      'G1 X30 Y20 F400',
      'G0 Z5',
      'G55 G0 X200 Y200',
      'G1 Z-3 F100',
      'X210',
      'G54 G0 X30 Y40 Z5',
      'G1 Z-0.2 F100',
      'M30',
    ].join('\n')
    const result = compileSurfaceCompensatedProgram(program, mesh, { maxSegmentMm: 50 })
    expect(result.ok, result.ok ? '' : result.reason).toBe(true)
    if (!result.ok) return
    const textOf = (line: number) => result.lines.filter((l) => l.sourceLine === line).map((l) => l.text)
    // G54: compensated by the measured surface.
    expect(textOf(3)).toEqual([`G1 X10 Y20 Z${Number((-0.2 + surface(10, 20)).toFixed(4))} F100`])
    // G55: exactly the program's own blocks; the modal feed is stated again
    // because the compensated stream's last move was a G0.
    expect(textOf(6)).toEqual(['G55 G0 X200 Y200'])
    expect(textOf(7)).toEqual(['G1 Z-3 F100'])
    expect(textOf(8)).toEqual(['X210'])
    // Back in G54: the work offset is selected again, and the first move goes
    // straight to its compensated end (its start is where only the machine knows).
    expect(textOf(9)).toEqual(['G54', `G0 X30 Y40 Z${Number((5 + surface(30, 40)).toFixed(4))}`])
    expect(textOf(10)).toEqual([`G1 X30 Y40 Z${Number((-0.2 + surface(30, 40)).toFixed(4))} F100`])
  })

  it('states the modal motion again for a G55 block that leans on it after a compensated move', () => {
    // The compensated arc goes out as G1 chords; the G55 block continues the
    // program's G2, so G2 is stated again in front of it.
    const program = ['G21 G90 G54', 'G0 X10 Y20 Z5', 'G1 Z-0.2 F100', 'G2 X30 Y20 I10 J0', 'G55', 'X50 I10 J0', 'M30'].join('\n')
    const result = compileSurfaceCompensatedProgram(program, mesh)
    expect(result.ok, result.ok ? '' : result.reason).toBe(true)
    if (!result.ok) return
    expect(result.lines.filter((l) => l.sourceLine === 4).every((l) => l.text.startsWith('G1 '))).toBe(true)
    expect(result.lines.filter((l) => l.sourceLine === 6).map((l) => l.text)).toEqual(['G2 X50 I10 J0'])
  })

  it('refuses a cut back in G54 before the program has said where X, Y and Z are there', () => {
    const program = ['G21 G90 G54', 'G0 X10 Y20 Z5', 'G1 Z-0.2 F100', 'G55 G0 X200 Y200', 'G54 G1 Z-0.2 F100', 'M30'].join('\n')
    const result = compileSurfaceCompensatedProgram(program, mesh)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('Line 5 cuts in G54 straight after a move in another work offset')
  })

  it('cannot place a move that runs before any work offset when the active one is unknown', () => {
    const result = compileSurfaceCompensatedProgram(PROGRAM, mesh, { startWcs: null })
    expect(result.ok).toBe(false)
  })
})
