// @vitest-environment node
// WO-2446: example 07 rebuilt as the operator holds a tabbed part - two clamps, screw
// holes drilled first, an operator stop for the screws, then the relief and the
// tabbed outline. Reads the project, posted file, job sheet and Cut Stock
// readback the production build (tools/examples/build-relief-medallion.mjs)
// wrote, and parses the posted file with the app's own G-code reader.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readGcodeProgram } from '../../lib/gcode/reader'

const root = resolve(import.meta.dirname, '../../..')
const part = join(root, 'examples/07-relief-medallion')
const evidence = join(root, 'src/tests/evidence/WO-2446')
const json = (name: string, dir = evidence) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const project = () => json('relief-medallion.camproject', part)

const STOP_MESSAGE = 'Drive 4 screws, remove the 2 clamps, then press Cycle Start'
const RELIEF_DEPTH = 2
const STOCK = 90
const HOLE_DIAMETER = 4
const HOLE_INSET = 8
const SCREW_HEAD = 8

function stockOf(p: any) {
  const setup = p.setups[0]
  return p.sceneStock.fixedStocks.find((s: any) => s.id === setup.wcs.stockId)
}

/** Centre of a closed loop of the drawing, in world mm. */
function loopCentre(geometry: any, loopId: string) {
  const loop = geometry.loops.find((l: any) => l.id === loopId)
  const xs = loop.points.map((q: any) => q.x), ys = loop.points.map((q: any) => q.y)
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2 + geometry.position.x,
    y: (Math.min(...ys) + Math.max(...ys)) / 2 + geometry.position.y,
    diameter: Math.max(...xs) - Math.min(...xs),
  }
}

function holes(p: any) {
  const drill = p.setups[0].operations.find((o: any) => o.type === 'drill')
  const geometry = p.geometry.find((g: any) => g.id === drill.params.geometryId)
  return drill.params.loopIds.map((id: string) => loopCentre(geometry, id))
}

const lowestZ = (op: any) => Math.min(...op.toolpathMoves.map((m: any) => m.z))

function read(gcode: string, machine: any) {
  const result = readGcodeProgram(gcode, {
    dialect: 'grbl',
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    macroMCodes: 'report',
    workOffsets: { G54: { x: 0, y: 0, z: 0 } },
    machineDefinition: machine,
  })
  if (!result.ok) throw new Error(`reader refused line ${result.refusal.line}: ${result.refusal.message}`)
  return result.program
}

/** The posted file read in order: sections by their operation comments, the
 *  operator stop's M0, and the moves around it. */
function postedOrder(gcode: string, p: any) {
  const lines = gcode.split(/\r?\n/)
  const at = (text: string) => lines.findIndex((l) => l.trim() === text) + 1
  const ops = p.setups[0].operations
  const sections = ops.map((op: any) => at(`( ${op.name} )`))
  const stopComment = at(`( ${STOP_MESSAGE} )`)
  const program = read(gcode, p.machine)
  const stop = program.items.find((item) => item.kind === 'pause' && !item.optional && item.line > stopComment)!
  const movesIn = (from: number, to: number) => program.moves.filter((_, i) => program.moveLines[i] > from && program.moveLines[i] < to)
  return { lines, sections, stopComment, stop, program, movesIn }
}

describe('WO-2446 example 07 relief medallion: clamps, screws, operator stop, tabbed outline', () => {
  it('cuts a 90 x 90 x 8 mm blank with the disc in the middle, so the frame is one piece', () => {
    const p = project(), stock = stockOf(p)
    expect(stock).toMatchObject({ width: STOCK, height: STOCK, depth: 8 })
    const model = p.geometry.find((g: any) => g.format === 'model')
    expect(model.stockId).toBe(stock.id)
    expect(model.boundingBox.max.z - model.boundingBox.min.z).toBe(8)
    expect(stock.position.z).toBe(model.boundingBox.min.z)
    for (const axis of ['x', 'y'] as const) {
      expect(model.boundingBox.min[axis] - stock.position[axis]).toBeCloseTo(15, 1)
      expect(stock.position[axis] + STOCK - model.boundingBox.max[axis]).toBeCloseTo(15, 1)
    }
  })

  it('starts with two clamps on opposite side midpoints and records screws in the setup', () => {
    const p = project(), setup = p.setups[0], stock = stockOf(p)
    expect(setup.holdingMethod).toBe('screws')
    expect(setup.notes).toContain(STOP_MESSAGE)
    const definitions = p.workholding.definitions.filter((d: any) => d.kind === 'clamp')
    expect(definitions.map((d: any) => d.name)).toEqual(['example-02-toe-clamp'])
    const clamps = p.workholding.instances
    expect(clamps).toHaveLength(2)
    const centreY = stock.position.y + STOCK / 2
    const sides = clamps.map((c: any) => {
      expect(c.definitionId).toBe(definitions[0].id)
      expect(c.placement).toMatchObject({ kind: 'boundary', target: { kind: 'stock', id: stock.id } })
      // The midpoints of a square's four sides sit at 1/8, 3/8, 5/8 and 7/8 of its loop.
      expect([0.125, 0.375, 0.625, 0.875].some((f) => Math.abs(c.placement.fraction - f) < 1e-9)).toBe(true)
      expect(c.worldPose.position.y).toBeCloseTo(centreY, 6)
      return Math.sign(c.worldPose.position.x - (stock.position.x + STOCK / 2))
    })
    expect(sides.sort()).toEqual([-1, 1])
  })

  it('drills 4 screw holes 4 mm through the frame corners, clear of every other cut', () => {
    const p = project(), stock = stockOf(p), setup = p.setups[0]
    const drill = setup.operations[0]
    expect(drill.type).toBe('drill')
    expect(p.toolLibrary.find((t: any) => t.id === drill.toolId)).toMatchObject({ type: 'drill', diameter: HOLE_DIAMETER })
    const centres = holes(p)
    expect(centres).toHaveLength(4)
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([i, j]) => ({
      x: stock.position.x + (i ? STOCK - HOLE_INSET : HOLE_INSET), y: stock.position.y + (j ? STOCK - HOLE_INSET : HOLE_INSET),
    }))
    for (const corner of corners) {
      const hole = centres.find((c: any) => Math.hypot(c.x - corner.x, c.y - corner.y) < 0.1)
      expect(hole, JSON.stringify({ corner, centres })).toBeDefined()
      expect(hole.diameter).toBeCloseTo(HOLE_DIAMETER, 1)
    }
    // Through the 8 mm blank, past the drill's own tip.
    expect(lowestZ(drill)).toBeLessThanOrEqual(stock.position.z - 1.2)
    // Every cutting move of every other operation keeps its cutter clear of an 8 mm screw head.
    for (const op of setup.operations.slice(1)) {
      const radius = p.toolLibrary.find((t: any) => t.id === op.toolId).diameter / 2
      for (const m of op.toolpathMoves) {
        if (m.type === 'rapid') continue
        for (const h of centres) expect(Math.hypot(m.x - h.x, m.y - h.y) - radius).toBeGreaterThan(SCREW_HEAD / 2)
      }
    }
  })

  it('puts the operator stop with its message right after the drill', () => {
    const p = project(), setup = p.setups[0]
    expect(setup.machineActions).toHaveLength(1)
    expect(setup.machineActions[0]).toMatchObject({ kind: 'operator_stop', enabled: true, afterOpId: setup.operations[0].id, message: STOP_MESSAGE })
  })

  it('keeps the rough in the relief band and cuts the outline last with 4 triangular tabs', () => {
    const p = project(), setup = p.setups[0], ops = setup.operations
    expect(ops.map((o: any) => o.type)).toEqual(['drill', 'adaptive_3d', 'parallel_3d', 'contour_2d'])
    const model = p.geometry.find((g: any) => g.format === 'model')
    const bandBottom = model.boundingBox.max.z - RELIEF_DEPTH
    expect(lowestZ(ops[1])).toBeGreaterThanOrEqual(bandBottom - 1e-6)
    expect(lowestZ(ops[2])).toBeGreaterThanOrEqual(bandBottom - 1e-6)
    const outline = ops.at(-1)
    const cutter = p.toolLibrary.find((t: any) => t.id === outline.toolId).diameter
    expect(outline.params).toMatchObject({ tabs: true, tabShape: 'triangular', tabCount: 4, tabHeight: 1.5 })
    // Tab width is the span the cutter centre lifts over: 5 mm bridge + the 6 mm cutter.
    expect(outline.params.tabWidth - cutter).toBe(5)
    expect(lowestZ(outline)).toBeCloseTo(stockOf(p).position.z - 0.2, 6)
    const geometry = p.geometry.find((g: any) => g.id === outline.params.geometryId)
    expect(loopCentre(geometry, outline.params.loopIds[0]).diameter).toBeCloseTo(60, 1)
  })

  it('reopens through Open in a fresh browser with every operation current', () => {
    const p = project(), roundTrip = json('round-trip.json'), steps = json('steps.json')
    expect(roundTrip.reopened).toEqual(roundTrip.saved)
    expect(roundTrip.saved.id).toBe(p.id)
    expect(steps.every((s: any) => s.status === 'passed')).toBe(true)
    expect(steps.map((s: any) => s.label)).toEqual(expect.arrayContaining([
      'Reopen saved project in a fresh context', 'Reopen: every operation current without recompute',
    ]))
    expect(p.setups[0].operations.map((o: any) => o.status)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(json('verification.json').operations.map((o: any) => o.status)).toEqual(['ready', 'ready', 'ready', 'ready'])
  })

  it('posts the drills, a retract, the stop with its message, then the rough and the outline', () => {
    const p = project(), gcode = readFileSync(join(evidence, 'relief-medallion.nc'), 'utf8').replace(/\r\n/g, '\n')
    const { lines, sections, stopComment, stop, program, movesIn } = postedOrder(gcode, p)
    const [drill, rough, finish, outline] = sections
    expect(sections.every((line: number) => line > 0)).toBe(true)
    expect(drill).toBeLessThan(stopComment)
    expect(stop.line).toBe(stopComment + 1)
    expect(lines[stop.line - 1].trim()).toBe('M0')
    expect(rough).toBeGreaterThan(stop.line)
    expect(finish).toBeGreaterThan(rough)
    expect(outline).toBeGreaterThan(finish)
    // The 4 drill plunges come before the stop; the last move before it is the retract above them.
    const before = movesIn(drill, stop.line)
    expect(before.filter((m) => Math.abs(m.z + 9.5) < 1e-6)).toHaveLength(4)
    const last = before.at(-1)!
    expect(last.z).toBeGreaterThan(0)
    expect(Math.max(...before.map((m) => m.z))).toBe(last.z)
    expect(program.items.some((item) => item.kind === 'spindle' && !item.on && item.line > drill && item.line < stop.line)).toBe(true)
    // This starter machine has no Operator stop park: WO-2437 stops at safe height and says so
    // (with a park set, the same step parks there first - src/tests/post/operatorPauseBetweenOps.wo2437.test.ts).
    expect(lines.slice(drill, stop.line).some((l) => /no park position/.test(l))).toBe(true)
    // The relief cuts after the stop, inside the band; the through cut is only in the outline, last.
    expect(Math.min(...movesIn(rough, outline).map((m) => m.z))).toBeCloseTo(-RELIEF_DEPTH, 2)
    expect(Math.min(...movesIn(outline, lines.length + 1).map((m) => m.z))).toBeCloseTo(-8.2, 6)
  })

  it('exports a job sheet with the method, both clamps, the stop and its place, and the tabs', () => {
    const sheet = readFileSync(join(evidence, 'relief-medallion.setup.txt'), 'utf8')
    expect(sheet).toContain('Method: Screws')
    expect(sheet).toMatch(/Clamp: "example-02-toe-clamp" x 2/)
    expect(sheet).toMatch(/two example 02 toe clamps on the left and right side midpoints/)
    expect(sheet).toMatch(/Operation 1 drills 4 screw holes, 4 mm through/)
    expect(sheet).toMatch(/Then the program retracts and stops at the operator stop.*Drive 4 screws, remove the 2 clamps, then press Cycle Start/)
    expect(sheet).toMatch(/Tabs, operation 4 "Contour 4": 4 tabs per contour, 11mm wide x 1\.5mm high, triangular/)
    expect(sheet).toMatch(/bridges about 5 mm wide and 1\.5 mm high/)
    expect(readFileSync(join(part, 'relief-medallion.setup.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(sheet.replace(/\r\n/g, '\n'))
    expect(readFileSync(join(evidence, 'relief-medallion.setup.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('ends Cut Stock with the disc held by the 4 tabs to a whole frame and the holes drilled', () => {
    const report = json('verification.json'), sim = report.simulation
    expect(sim.stockSync).toBe('exact')
    expect(sim.stockMs).toBe(Math.round(report.totalMs))
    expect(Math.abs(sim.markerMs - report.totalMs)).toBeLessThanOrEqual(1)
    expect(sim.removedVolumeMm3).toBeGreaterThan(0)
    expect(sim.stock.display).toBe('true')
    expect(sim.stock.outline).toMatchObject({ bottomSolidRuns: 4, bottomBridgeRuns: 4, aboveTabSolidSamples: 0 })
    expect(sim.stock.outline.samples).toBeGreaterThan(500)
    for (const width of sim.stock.outline.bottomBridgeWidthsMm) expect(width).toBeGreaterThan(3.5)
    expect(sim.stock.frame.solidSamples).toBe(sim.stock.frame.samples)
    expect(sim.stock.frame.samples).toBeGreaterThan(1000)
    expect(sim.stock.screwHoles).toMatchObject({ solidSamples: 0, samples: 12 })
    expect(sim.stock.discCentreSolid).toBe(true)
  })

  it('captures new 1920 x 1080 pictures and leaves both consoles free of errors', () => {
    for (const [dir, names] of [[evidence, ['toolpaths.png', 'toolpaths-top.png', 'simulation-end.png', 'simulation-end-top.png', 'reopened.png']],
      [part, ['toolpaths.png', 'simulation-end.png', 'reopened.png']]] as const) {
      for (const name of names) {
        const bytes = readFileSync(join(dir, name))
        expect(bytes.length).toBeGreaterThan(50_000)
        expect(bytes.readUInt32BE(16)).toBe(1920)
        expect(bytes.readUInt32BE(20)).toBe(1080)
      }
    }
    for (const name of ['built-console.json', 'reopened-console.json', 'posted-console.json', 'simulation-console.json']) {
      expect(json(name).filter((e: any) => e.error)).toEqual([])
    }
    expect(json('console.json').filter((e: any) => ['error', 'pageerror'].includes(e.type))).toEqual([])
    expect(json('scan.json').hits).toEqual([])
  })
})
