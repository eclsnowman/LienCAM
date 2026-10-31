import { describe, expect, it } from 'vitest'
import type { Tool, ToolpathMove } from '../../types'
import { ZDexelField } from '../../cam3d/stock'
import { stockCheckCutters, toolpathPostCheck, type StockTraverseInput, type ToolpathPostCheckInput } from './toolpathPostCheck'

// Stock top Z0, 4 mm flat tool. Rapids at/above Z0 are in air; below it they are
// fine only where this op (or an earlier one) has already cut the corridor.
const freshStock = (): ZDexelField => ZDexelField.fromBox({ minX: -10, minY: -10, minZ: -5, maxX: 20, maxY: 20, maxZ: 0 }, 0.25)
const flat4: StockTraverseInput = { field: freshStock(), removal: { cutter: { kind: 'flat', diameter: 4 }, liftMm: 0 },
  query: { cutter: { kind: 'flat', diameter: 4 }, liftMm: 0 } }
const stockOf = (over: Partial<StockTraverseInput> = {}): StockTraverseInput => ({ ...flat4, field: freshStock(), ...over })

const moves: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10 },
  { type: 'rapid', x: 0, y: 0, z: 1 },
  { type: 'feed', x: 0, y: 0, z: -2, feed: 100 },
  { type: 'feed', x: 10, y: 0, z: -2, feed: 200 },
  { type: 'feed', x: 10, y: 10, z: -2, feed: 200 },
  { type: 'rapid', x: 10, y: 10, z: 10 },
]
const gcode = 'G21 G90 G17\nG0 X0 Y0 Z10\nG0 Z1\nG1 Z-2 F100\nX10 F200\nY10\nG0 Z10\nM30'
const fixture = (): Omit<ToolpathPostCheckInput, 'moves'> & { moves: ToolpathMove[] } => ({
  moves: moves.map(m => ({ ...m })), bottomZ: -2, stock: stockOf(),
  posted: {
    gcode,
    readerOptions: { dialect: 'uccnc', sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 10 } },
    sourceToWork: m => ({ ...m }),
    toleranceMm: 0.002,
  },
})

describe('WO-3197 shared toolpath and post safety oracle', () => {
  it('passes a safe planned approach, cut and vertical retract through the app reader', () => {
    expect(toolpathPostCheck(fixture())).toEqual([])
  })
  it.each(['x', 'y', 'z', 'a', 'b', 'c', 'feed', 'cx', 'cy', 'engagement', 'dwellMs'] as const)(
    'rejects nonfinite %s without serializing NaN away', key => {
      const input = fixture()
      input.moves[3][key] = Number.NaN
      expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'finite', moveIndex: 3 }))
    },
  )
  it.each([Infinity, -Infinity])('rejects infinite coordinates %s', value => {
    const input = fixture()
    input.moves[3].x = value
    expect(toolpathPostCheck(input).some(i => i.check === 'finite')).toBe(true)
  })
  it('rejects a rapid through uncut stock and names where it hits', () => {
    const input = fixture()
    input.moves[4].type = 'rapid' // (10,0,-2) -> (10,10,-2): never cut
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({
      check: 'rapid', moveIndex: 4, message: expect.stringContaining('into uncleared stock'),
    }))
  })
  it('passes the SAME low rapid once that stock was cut earlier in the program', () => {
    const input = fixture()
    input.posted = undefined
    // Cut (0,0)->(10,0) and (10,0)->(10,10), then rapid back along both at Z-2
    // and lift there (a diagonal exit from the floor would cross uncut corners).
    input.moves.splice(5, 0, { type: 'rapid', x: 10, y: 0, z: -2 }, { type: 'rapid', x: 0, y: 0, z: -2 },
      { type: 'rapid', x: 0, y: 0, z: 10 })
    expect(toolpathPostCheck(input)).toEqual([])
    // Control: the same two rapids before the cuts that clear them fail.
    const early = fixture()
    early.posted = undefined
    early.moves.splice(3, 0, { type: 'rapid', x: 10, y: 0, z: -2 })
    expect(toolpathPostCheck(early)).toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 3 }))
  })
  it('replays a setup: a later operation sees what an earlier one cut', () => {
    const field = freshStock()
    const first = fixture()
    first.posted = undefined
    first.stock = stockOf({ field })
    expect(toolpathPostCheck(first)).toEqual([])
    const descentIntoSlot: ToolpathMove[] = [
      { type: 'rapid', x: 5, y: 0, z: 10 }, { type: 'rapid', x: 5, y: 0, z: -2 }, { type: 'rapid', x: 10, y: 0, z: -2 },
    ]
    expect(toolpathPostCheck({ moves: descentIntoSlot, bottomZ: -2, stock: stockOf({ field }) })).toEqual([])
    expect(toolpathPostCheck({ moves: descentIntoSlot, bottomZ: -2, stock: stockOf() }))
      .toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 1 }))
  })
  it('accepts a material-relative rapid descent that stops above the material left', () => {
    const input = fixture()
    input.posted = undefined
    input.moves[1].z = 0.5 // below Retract 5 / Feed 1, still in air over Z0
    expect(toolpathPostCheck(input)).toEqual([])
    input.moves[1].z = -0.5
    input.stock = stockOf() // the first run cut this column; ask an uncut stock
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 1 }))
  })
  it('judges a diagonal rapid at its LOWEST tip even if its endpoint is high', () => {
    const input = fixture()
    input.moves[4] = { type: 'rapid', x: 10, y: 10, z: 10 }
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 4 }))
  })
  it('passes a vertical lift from inside the cut (a subset of the pose the tool holds)', () => {
    const input = fixture()
    input.posted = undefined
    input.moves.push({ type: 'rapid', x: 10, y: 10, z: 12 })
    expect(toolpathPostCheck(input)).toEqual([])
  })
  it('treats a non-cutting feed role (loop_back) as a traverse, never as removal', () => {
    const input = fixture()
    input.posted = undefined
    input.moves[4] = { type: 'feed', role: 'loop_back', x: 10, y: 10, z: -2, feed: 200 }
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 4 }))
  })
  it('leaves material in for a tool the field cannot follow, and judges with the full-diameter body', () => {
    const vbit = { id: 'v', type: 'v_bit', diameter: 6, angleFromAxisDeg: 45 } as unknown as Tool
    const cutters = stockCheckCutters(vbit)
    expect(cutters).toEqual({ query: { cutter: { kind: 'flat', diameter: 6 }, liftMm: 0 } })
    const input = fixture()
    input.posted = undefined
    input.stock = stockOf(cutters)
    input.moves.splice(5, 0, { type: 'rapid', x: 10, y: 0, z: -2 })
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 5 }))
    expect(stockCheckCutters({ id: 'b', type: 'ball_end_mill', diameter: 6 } as unknown as Tool))
      .toEqual({ removal: { cutter: { kind: 'ball', diameter: 6 }, liftMm: 0 }, query: { cutter: { kind: 'ball', diameter: 6 }, liftMm: 0 } })
  })
  it('flags only radial contact the field resolves: a graze within half a cell diagonal passes, a deeper one fails', () => {
    // Slot cut along Y=0 (walls at Y=+-2); a low rapid offset in Y grazes the wall.
    const run = (offset: number) => {
      const input = fixture()
      input.posted = undefined
      input.moves.splice(5, 0, { type: 'rapid', x: 10, y: offset, z: -2 }, { type: 'rapid', x: 0, y: offset, z: -2 },
        { type: 'rapid', x: 0, y: offset, z: 10 })
      return toolpathPostCheck(input).filter(i => i.check === 'rapid').map(i => i.moveIndex)
    }
    expect(run(0.1)).toEqual([]) // 0.1 mm < 0.25/sqrt(2)
    expect(run(0.5)).toEqual([6]) // the return along the slot cuts 0.5 mm into its wall
  })
  it('judges a drill with its point lifted like its removal, so a peck re-enters its own cone', () => {
    const drill = { id: 'd', type: 'drill', diameter: 5, angleFromAxisDeg: 59 } as unknown as Tool
    const cutters = stockCheckCutters(drill)
    expect(cutters.removal?.liftMm).toBeGreaterThan(1)
    expect(cutters.query).toEqual({ cutter: { kind: 'flat', diameter: 5 }, liftMm: cutters.removal!.liftMm })
    const peck: ToolpathMove[] = [
      { type: 'rapid', x: 5, y: 5, z: 5 }, { type: 'rapid', x: 5, y: 5, z: 0.5 }, { type: 'feed', x: 5, y: 5, z: -2, feed: 100 },
      { type: 'rapid', x: 5, y: 5, z: 5 }, { type: 'rapid', x: 5, y: 5, z: -1.5 }, { type: 'feed', x: 5, y: 5, z: -4, feed: 100 },
    ]
    expect(toolpathPostCheck({ moves: peck, bottomZ: -4, stock: stockOf(cutters) })).toEqual([])
    // The lift is the oracle's named limit: a point deeper than it into fresh stock still fails.
    const fresh = [...peck.slice(0, 4), { type: 'rapid', x: 12, y: 5, z: 5 }, { type: 'rapid', x: 12, y: 5, z: -1.5 - cutters.removal!.liftMm }] as ToolpathMove[]
    expect(toolpathPostCheck({ moves: fresh, bottomZ: -4, stock: stockOf(cutters) }))
      .toEqual([expect.objectContaining({ check: 'rapid', moveIndex: 5 })])
  })
  it('flags a rapid below bottom as both a crash and a bottom violation', () => {
    const input = fixture()
    input.moves[1] = { type: 'rapid', x: 2, y: 0, z: -3 }
    const issues = toolpathPostCheck(input)
    expect(issues).toContainEqual(expect.objectContaining({ check: 'rapid', moveIndex: 1 }))
    expect(issues).toContainEqual(expect.objectContaining({ check: 'bottom', moveIndex: 1 }))
  })
  it('rejects a feed below bottom', () => {
    const input = fixture()
    input.moves[3].z = -2.01
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'bottom', moveIndex: 3 }))
  })
  it('rejects inconsistent arcs and missing centres/start points', () => {
    for (const arc of [
      { type: 'arc_ccw', x: 10, y: 10, z: -2, cx: 5, cy: 0 },
      { type: 'arc_cw', x: 10, y: 10, z: -2 },
    ] as ToolpathMove[]) {
      const input = fixture()
      input.moves[4] = arc
      expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'arc', moveIndex: 4 }))
    }
    expect(toolpathPostCheck({ ...fixture(), moves: [{ type: 'arc_cw', x: 0, y: 0, z: 10, cx: 1, cy: 0 }] })
      .some(i => i.check === 'arc')).toBe(true)
  })
  it('accepts a full circle and a helical arc in absolute-centre form', () => {
    const input = fixture()
    input.posted = undefined
    input.moves = [
      { type: 'rapid', x: 1, y: 0, z: 10 },
      { type: 'arc_ccw', x: 1, y: 0, z: 9, cx: 0, cy: 0 },
      { type: 'arc_cw', x: 0, y: 1, z: 8, cx: 0, cy: 0 },
    ]
    expect(toolpathPostCheck(input)).toEqual([])
  })
  it('detects a dropped corner via reader geometry, even with the same endpoints', () => {
    const input = fixture()
    input.posted!.gcode = gcode.replace('X10 F200\nY10', 'X10 Y10 F200')
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({ check: 'post', message: expect.stringContaining('missing/reordered') }))
  })
  it('rejects an added detour and reversed traversal', () => {
    for (const replacement of ['X20 F200\nX10\nY10', 'Y10 F200\nX10\nY0\nY10']) {
      const input = fixture()
      input.posted!.gcode = gcode.replace('X10 F200\nY10', replacement)
      expect(toolpathPostCheck(input).some(i => i.check === 'post')).toBe(true)
    }
  })
  it('accepts collinear segmentation and retains complete modal context for a span', () => {
    const input = fixture()
    input.posted!.gcode = gcode.replace('X10 F200', 'X5 F200\nX10')
    input.posted!.lineRange = { startLine: 2, endLine: 8 }
    expect(toolpathPostCheck(input)).toEqual([])
  })
  it('rejects missing terminal motion and reader refusals', () => {
    for (const bad of [gcode.replace('G0 Z10\nM30', 'M30'), 'G999 X1']) {
      const input = fixture()
      input.posted!.gcode = bad
      expect(toolpathPostCheck(input).some(i => i.check === 'post')).toBe(true)
    }
  })
  it('checks native posted arcs through the reader rather than endpoint counts', () => {
    const input = fixture()
    input.moves = [
      { type: 'rapid', x: 1, y: 0, z: 10 },
      { type: 'arc_ccw', x: 0, y: 1, z: 9, cx: 0, cy: 0, feed: 100 },
      { type: 'rapid', x: 0, y: 1, z: 10 },
    ]
    input.posted!.gcode = 'G21 G90 G17\nG0 X1 Y0 Z10\nG3 X0 Y1 Z9 I-1 J0 F100\nG0 Z10\nM30'
    expect(toolpathPostCheck(input)).toEqual([])
  })
  it('checks posted arc radius agreement more tightly than reader admission', () => {
    const input = fixture()
    input.moves = [
      { type: 'rapid', x: 1, y: 0, z: 10 },
      { type: 'arc_ccw', x: 0, y: 1, z: 9, cx: 0, cy: 0, feed: 100 },
      { type: 'rapid', x: 0, y: 1, z: 10 },
    ]
    input.posted!.toleranceMm = 0.06
    input.posted!.gcode = 'G21 G90 G17\nG0 X1 Y0 Z10\nG3 X0 Y1.005 Z9 I-1 J0 F100\nG0 Z10\nM30'
    expect(toolpathPostCheck(input)).toContainEqual(expect.objectContaining({
      check: 'post', message: expect.stringContaining('inconsistent arc radii'),
    }))
  })
  it('supports a single-point path without inventing an incoming segment', () => {
    const input = fixture()
    input.moves = [{ type: 'rapid', x: 0, y: 0, z: 10 }]
    input.posted!.gcode = 'G21 G90\nG0 X0 Y0 Z10\nM30'
    expect(toolpathPostCheck(input)).toEqual([])
  })
  it('accepts a rapid-only operation posted as no motion (WO-2870), and only that', () => {
    const input = fixture()
    input.moves = [{ type: 'rapid', x: 0, y: 0, z: 10 }, { type: 'rapid', x: 0, y: 0, z: 1 }, { type: 'rapid', x: 0, y: 0, z: 10 }]
    input.posted!.gcode = 'G21 G90\n( Pocket: nothing left to cut )\nM30'
    expect(toolpathPostCheck(input)).toEqual([])
    const cut = fixture()
    cut.posted!.gcode = 'G21 G90\n( Pocket: nothing left to cut )\nM30'
    expect(toolpathPostCheck(cut).some(i => i.check === 'post')).toBe(true)
  })
  it('rejects a posted rapid replacing a cutting feed', () => {
    const input = fixture()
    input.posted!.gcode = gcode.replace('G1 Z-2 F100', 'G0 Z-2')
    expect(toolpathPostCheck(input).some(i => i.check === 'post')).toBe(true)
  })
  it('rejects empty input and invalid check parameters', () => {
    expect(toolpathPostCheck({ ...fixture(), moves: [], posted: undefined }).length).toBeGreaterThan(0)
    expect(toolpathPostCheck({ ...fixture(), bottomZ: NaN }).some(i => i.check === 'finite')).toBe(true)
    expect(toolpathPostCheck({ ...fixture(), toleranceMm: -1 }).some(i => i.check === 'finite')).toBe(true)
    expect(toolpathPostCheck({ ...fixture(), stock: stockOf({ intrusionToleranceMm: NaN }) }).some(i => i.check === 'finite')).toBe(true)
    expect(toolpathPostCheck({ ...fixture(), stock: stockOf({ radialResolutionMm: -1 }) }).some(i => i.check === 'finite')).toBe(true)
    expect(toolpathPostCheck({ ...fixture(), stock: stockOf({ radialResolutionMm: 2 }) }).some(i => i.check === 'rapid')).toBe(true)
  })
})
