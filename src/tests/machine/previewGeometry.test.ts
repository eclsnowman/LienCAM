import { describe, expect, it } from 'vitest'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { buildProgramPath } from '../../lib/machine/programPath'
import { boundsOfPoints } from '../../lib/machine/machineEnvelope'

describe('buildPreviewModel', () => {
  it('maps lines and rapids with source-line attribution and bounds', () => {
    const m = buildPreviewModel('G21\nG90\nG0 X10 Y5\nG1 X20 Y5 F600\nG1 X20 Y15')
    expect(m.polylines).toHaveLength(3)
    expect(m.polylines[0]).toMatchObject({ kind: 'rapid', line: 3 })
    expect(m.polylines[1]).toMatchObject({ kind: 'feed', line: 4 })
    expect(m.minX).toBe(0) // start position origin included
    expect(m.maxX).toBe(20)
    expect(m.maxY).toBe(15)
  })

  it('samples an IJ quarter-circle arc through its true midpoint', () => {
    // CCW quarter from (10,0) to (0,10) about (0,0): G3 with I-10 J0.
    const m = buildPreviewModel('G21\nG90\nG0 X10 Y0\nG3 X0 Y10 I-10 J0 F500')
    const arc = m.polylines.find((p) => p.kind === 'arc')!
    expect(arc.points.length).toBeGreaterThan(8)
    // True midpoint of the CCW quarter is (r/sqrt2, r/sqrt2).
    const mid = arc.points[Math.floor(arc.points.length / 2)]
    expect(Math.hypot(mid.x, mid.y)).toBeCloseTo(10, 3) // stays on the radius
    expect(mid.x).toBeGreaterThan(0)
    expect(mid.y).toBeGreaterThan(0)
    // Endpoints pinned exactly.
    expect(arc.points[0]).toEqual({ x: 10, y: 0 })
    expect(arc.points.at(-1)).toEqual({ x: 0, y: 10 })
    // Bounds include the arc bulge, not just the chord.
    expect(m.maxX).toBeCloseTo(10, 6)
    expect(m.maxY).toBeCloseTo(10, 6)
  })

  it('handles R-format arcs and falls back to a chord when unsolvable', () => {
    const r = buildPreviewModel('G21\nG90\nG0 X0 Y0\nG2 X10 Y0 R5 F500')
    const arc = r.polylines.find((p) => p.kind === 'arc')!
    expect(arc.points.length).toBeGreaterThan(8)
    // CW half-circle above or below: R5 short arc; midpoint must be 5 off axis.
    const mid = arc.points[Math.floor(arc.points.length / 2)]
    expect(Math.abs(mid.y)).toBeCloseTo(5, 3)

    // Unsolvable radius (too small for the chord) -> chord fallback, no throw.
    const bad = buildPreviewModel('G21\nG90\nG0 X0 Y0\nG2 X10 Y0 R2 F500')
    const badArc = bad.polylines.find((p) => p.kind === 'arc')!
    expect(badArc.points).toHaveLength(2)
  })

  it.each([
    {
      plane: 'G18',
      program: 'G21\nG90\nG0 X40 Y10 Z50\nG18\nG2 X60 Z50 I10 K0 F500',
      constantAxis: 'y' as const,
      constantValue: 10,
    },
    {
      plane: 'G19',
      program: 'G21\nG90\nG0 X10 Y40 Z50\nG19\nG2 Y60 Z50 J10 K0 F500',
      constantAxis: 'x' as const,
      constantValue: 10,
    },
  ])('$plane samples its Z bulge in the shared 3D program path', ({ program, constantAxis, constantValue }) => {
    const path = buildProgramPath(program)
    const bounds = boundsOfPoints(path.moves)
    expect(path.moves.length).toBeGreaterThan(8)
    expect(bounds?.max.z).toBeCloseTo(60, 6)
    expect(path.moves.every((point) => point[constantAxis] === constantValue || point[constantAxis] === 0)).toBe(true)
  })

  it('converts G20 coordinates and arc dimensions to canonical millimetres', () => {
    const path = buildProgramPath('G20\nG90\nG0 X1 Y0\nG3 X0 Y1 I-1 J0 F10')
    const bounds = boundsOfPoints(path.moves)

    expect(bounds?.max.x).toBeCloseTo(25.4, 6)
    expect(bounds?.max.y).toBeCloseTo(25.4, 6)
    const arcPoints = path.moves.filter((point) => point.x > 0 && point.y > 0)
    expect(arcPoints.length).toBeGreaterThan(8)
    expect(Math.max(...arcPoints.map((point) => Math.hypot(point.x, point.y)))).toBeCloseTo(25.4, 3)
  })

  it('keeps G53 targets out of work bounds and records their machine ranges', () => {
    const model = buildPreviewModel([
      'G21 G90 G54',
      'G1 X10 Y10 Z-5 F100',
      'G53 G0 X5 Y5 Z49',
      'M30',
    ].join('\n'))

    // WO-1639: workBounds excludes the phantom (0,0,0) start the preview
    // assumes but the program never commanded - only the real endpoint.
    expect(model.workBounds).toEqual({
      min: { x: 10, y: 10, z: -5 },
      max: { x: 10, y: 10, z: -5 },
    })
    expect(model.machineCoordinateRanges).toEqual({
      x: { min: 5, max: 5 },
      y: { min: 5, max: 5 },
      z: { min: 49, max: 49 },
    })
    expect(model.polylines).toHaveLength(1)
  })

  it('returns a safe unit extent for an empty program', () => {
    const m = buildPreviewModel('G21\n(only setup)\nM30')
    expect(m.polylines).toHaveLength(0)
    expect(m.maxX).toBeGreaterThan(m.minX)
  })
})

describe('buildPreviewModel distance mode (G90/G91)', () => {
  // WO-022 audit repro: the preview used to read every coordinate word as
  // absolute, so these G91 offsets collapsed back onto X0..10/Y0..10.
  const AUDIT_REPRO = 'G90\nG0 X10 Y10\nG91\nG1 X5 Y0 F600\nG1 X0 Y5'

  it('pins the audit repro: G91 moves offset from position, reaching X15/Y15', () => {
    const m = buildPreviewModel(AUDIT_REPRO)
    expect(m.polylines).toHaveLength(3)
    expect(m.polylines[1].points).toEqual([
      { x: 10, y: 10 },
      { x: 15, y: 10 },
    ])
    expect(m.polylines[2].points).toEqual([
      { x: 15, y: 10 },
      { x: 15, y: 15 },
    ])
    expect(m.maxX).toBe(15)
    expect(m.maxY).toBe(15)
  })

  it('mixed mode: returning to G90 reads absolute coordinates again', () => {
    const m = buildPreviewModel('G90\nG0 X10 Y10\nG91\nG1 X5 Y5 F600\nG90\nG1 X0 Y0')
    expect(m.polylines[1].points.at(-1)).toEqual({ x: 15, y: 15 })
    expect(m.polylines[2].points).toEqual([
      { x: 15, y: 15 },
      { x: 0, y: 0 },
    ])
  })

  it('G91 on the motion line itself applies to that block', () => {
    const m = buildPreviewModel('G90\nG0 X10 Y10\nG91 G1 X5 F600')
    expect(m.polylines[1].points.at(-1)).toEqual({ x: 15, y: 10 })
  })

  it('G91 arcs: endpoint words are offsets, IJ center stays start-relative', () => {
    // The same CCW quarter circle as the absolute arc test, commanded
    // incrementally: from (10,0) to (0,10) about (0,0).
    const m = buildPreviewModel('G21\nG90\nG0 X10 Y0\nG91\nG3 X-10 Y10 I-10 J0 F500')
    const arc = m.polylines.find((p) => p.kind === 'arc')!
    expect(arc.points[0]).toEqual({ x: 10, y: 0 })
    expect(arc.points.at(-1)).toEqual({ x: 0, y: 10 })
    const mid = arc.points[Math.floor(arc.points.length / 2)]
    expect(Math.hypot(mid.x, mid.y)).toBeCloseTo(10, 3)
  })

  it('G91 Z words accumulate into the z0/z depths', () => {
    const m = buildPreviewModel('G90\nG0 Z5\nG91\nG1 Z-3 F200\nG1 Z-3')
    expect(m.polylines[1]).toMatchObject({ z0: 5, z: 2 })
    expect(m.polylines[2]).toMatchObject({ z0: 2, z: -1 })
  })
})

describe('WO-1075 the builder is the only parser: feeds and canned cycles', () => {
  // Compact readable form of one move: kind, from, to, modal feed.
  const shape = (model: ReturnType<typeof buildPreviewModel>) =>
    model.moves.map((move) => [
      move.kind,
      [move.from.x, move.from.y, move.from.z],
      [move.to.x, move.to.y, move.to.z],
      move.feedMmMin,
    ])

  it('carries the modal feed and the largest S on the move list', () => {
    const m = buildPreviewModel('G21 G90\nM3 S18000\nG0 X10\nG1 X20 F600\nG1 Y5\nS9000\nM30')
    expect(shape(m)).toEqual([
      ['rapid', [0, 0, 0], [10, 0, 0], null],
      ['feed', [10, 0, 0], [20, 0, 0], 600],
      ['feed', [20, 0, 0], [20, 5, 0], 600],
    ])
    expect(m.spindleRpmMax).toBe(18000)
  })

  it('reads a G20 feed as inches per minute', () => {
    const m = buildPreviewModel('G20 G90\nG1 X1 F10\nM30')
    expect(m.moves).toHaveLength(1)
    expect(m.moves[0].feedMmMin).toBeCloseTo(254, 9)
  })

  it('expands a G99 G81 cycle into rapid-to-R, feed-to-depth and retract-to-R', () => {
    const m = buildPreviewModel([
      'G21 G90',
      'G0 Z10',
      'G99 G81 X5 Y5 Z-5 R2 F900',
      'X15 Y5',
      'G80',
      'M30',
    ].join('\n'))

    expect(shape(m)).toEqual([
      ['rapid', [0, 0, 0], [0, 0, 10], null],
      // Hole 1: across at the current height, down to R, feed to depth, back to R.
      ['rapid', [0, 0, 10], [5, 5, 10], null],
      ['rapid', [5, 5, 10], [5, 5, 2], null],
      ['feed', [5, 5, 2], [5, 5, -5], 900],
      ['rapid', [5, 5, -5], [5, 5, 2], null],
      // Hole 2: G99 left the tool at R, so it traverses there - no re-approach.
      ['rapid', [5, 5, 2], [15, 5, 2], null],
      ['feed', [15, 5, 2], [15, 5, -5], 900],
      ['rapid', [15, 5, -5], [15, 5, 2], null],
    ])
    // Every expanded move keeps the source line of the block that commanded it.
    expect(m.moves.map((move) => move.line)).toEqual([2, 3, 3, 3, 3, 4, 4, 4])
  })

  it('expands a G98 G83 cycle into its pecks and a return to the initial plane', () => {
    const m = buildPreviewModel([
      'G21 G90',
      'G0 Z10',
      'G98 G83 X5 Y5 Z-5 R2 Q3 F600',
      'G80',
      'M30',
    ].join('\n'))

    expect(shape(m)).toEqual([
      ['rapid', [0, 0, 0], [0, 0, 10], null],
      ['rapid', [0, 0, 10], [5, 5, 10], null],
      ['rapid', [5, 5, 10], [5, 5, 2], null],
      ['feed', [5, 5, 2], [5, 5, -1], 600],
      ['rapid', [5, 5, -1], [5, 5, 2], null],
      ['rapid', [5, 5, 2], [5, 5, -1], null],
      ['feed', [5, 5, -1], [5, 5, -4], 600],
      ['rapid', [5, 5, -4], [5, 5, 2], null],
      ['rapid', [5, 5, 2], [5, 5, -4], null],
      ['feed', [5, 5, -4], [5, 5, -5], 600],
      // G98 returns to the height the cycle was invoked from, not to R.
      ['rapid', [5, 5, -5], [5, 5, 10], null],
    ])
  })

  it('leaves a program without canned cycles byte-identical to today; workBounds excludes the phantom start (WO-1639)', () => {
    const program = 'G21\nG90\nG0 X10 Y5\nG1 X20 Y5 F600\nG1 X20 Y15'
    const m = buildPreviewModel(program)

    expect(m.polylines.map(({ line, kind, points, z0, z }) => ({ line, kind, points, z0, z }))).toEqual([
      { line: 3, kind: 'rapid', points: [{ x: 0, y: 0 }, { x: 10, y: 5 }], z0: 0, z: 0 },
      { line: 4, kind: 'feed', points: [{ x: 10, y: 5 }, { x: 20, y: 5 }], z0: 0, z: 0 },
      { line: 5, kind: 'feed', points: [{ x: 20, y: 5 }, { x: 20, y: 15 }], z0: 0, z: 0 },
    ])
    expect(buildProgramPath(program).moves).toEqual([
      { type: 'rapid', role: 'rapid', x: 0, y: 0, z: 0 },
      { type: 'rapid', role: 'rapid', x: 10, y: 5, z: 0 },
      { type: 'feed', role: 'cut', x: 20, y: 5, z: 0 },
      { type: 'feed', role: 'cut', x: 20, y: 15, z: 0 },
    ])
    expect(m.workBounds).toEqual({ min: { x: 10, y: 5, z: 0 }, max: { x: 20, y: 15, z: 0 } })
  })

  it('hands every builder consumer the plunge a canned cycle really cuts', () => {
    const program = 'G21 G90\nG0 Z10\nG99 G81 X5 Y5 Z-5 R2 F900\nG80\nM30'
    const path = buildProgramPath(program)

    expect(boundsOfPoints(path.moves)).toEqual({
      min: { x: 0, y: 0, z: -5 },
      max: { x: 5, y: 5, z: 10 },
    })
    expect(path.moves.some((move) => move.type === 'feed' && move.z === -5)).toBe(true)
  })

  it('does not expand an incremental (G91) cycle - LienCAM posts G90 cycles only', () => {
    const m = buildPreviewModel('G21 G90\nG0 Z10\nG91\nG81 X5 Y5 Z-5 R2 F900\nG80\nM30')
    expect(m.moves).toHaveLength(2)
  })
})
