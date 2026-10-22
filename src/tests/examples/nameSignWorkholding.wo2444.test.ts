// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const part = join(root, 'examples/05-name-sign')
const evidence = join(root, 'src/tests/evidence/WO-2444')
const original = join(root, 'src/tests/evidence/WO-2377')
const json = (name: string, dir = evidence) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const project = () => json('name-sign.camproject', part)

// Random import IDs differ on every production build; resolve them to the
// geometry/loop names before comparing the authored operation with the original.
function stableParams(p: any, op: any) {
  const geometry = p.geometry.find((g: any) => g.id === op.params.geometryId)
  return { ...op.params, geometryId: geometry.name,
    loopIds: op.params.loopIds.map((id: string) => geometry.loops.findIndex((l: any) => l.id === id)) }
}

describe('WO-2444 production-built taped and tabbed name sign', () => {
  it('preserves tape and glue and four triangular 6 x 1.5 mm tabs in the saved and reopened project', () => {
    const p = project(), setup = p.setups[0]
    expect(setup.holdingMethod).toBe('tape_glue')
    expect(setup.notes).toMatch(/masking tape.*spoilboard.*whole blank.*superglue/i)
    expect(setup.notes).toContain('cut the 4 tabs and sand the stubs')
    const contour = setup.operations.find((o: any) => o.type === 'contour_2d')
    expect(contour.params).toMatchObject({ tabs: true, tabShape: 'triangular', tabCount: 4, tabWidth: 6, tabHeight: 1.5 })
    const report = json('verification.json')
    expect(report.holdingMethod).toBe(setup.holdingMethod)
    expect(report.notes).toBe(setup.notes)
    expect(report.contourParams).toEqual(contour.params)
  })

  it('reopens through Open project in a fresh browser and recomputes every operation current', () => {
    const p = project(), roundTrip = json('round-trip.json'), steps = json('steps.json')
    expect(roundTrip.reopened).toEqual(roundTrip.saved)
    expect(roundTrip.saved.id).toBe(p.id)
    expect(steps.every((s: any) => s.status === 'passed')).toBe(true)
    expect(steps.map((s: any) => s.label)).toEqual(expect.arrayContaining([
      'Record tape and glue under the whole blank', 'Reopen saved project in a fresh context', 'Reopen and compute operations',
    ]))
    expect(p.setups.flatMap((s: any) => s.operations).map((o: any) => o.status)).toEqual(['ready', 'ready'])
    expect(json('verification.json').operations.map((o: any) => o.status)).toEqual(['ready', 'ready'])
    for (const op of p.setups[0].operations) {
      expect(op.toolpathMoves.length).toBeGreaterThan(100)
      expect(op.smartHeight.intent.version).toBe(2)
    }
  })

  it('keeps the lettering, profile, stock and V-carve byte-for-byte against the original production example', () => {
    const p = project(), baseline = json('name-sign.camproject', original)
    const stripIds = (g: any) => ({ name: g.name, loops: g.loops.map(({ id, ...loop }: any) => loop), position: g.position })
    expect(p.geometry.map(stripIds)).toEqual(baseline.geometry.map(stripIds))
    const { id: stockId, ...stock } = p.sceneStock.fixedStocks[0]
    const { id: baselineId, ...oldStock } = baseline.sceneStock.fixedStocks[0]
    expect(stock).toEqual(oldStock)
    const carve = p.setups[0].operations[0], oldCarve = baseline.setups[0].operations[0]
    expect(stableParams(p, carve)).toEqual(stableParams(baseline, oldCarve))
    // WO-3059 re-pin: WO-2926 (fce97d15e6, 10-17) recomputed the stale shipped
    // V-carve on the current engine (integrated-refresh.log: 12036 moves,
    // camgen-v4), so its moves are no longer the WO-2377 original's 11608. The
    // authored carve above still equals the original; the moves are pinned byte
    // for byte to the refreshed shipped result.
    expect(carve.toolpathMoves).toHaveLength(12036)
    expect(createHash('sha256').update(JSON.stringify(carve.toolpathMoves)).digest('hex'))
      .toBe('45bff6e13bdce1ebdced2c1138f4bc6b8e84c5bbb364ca2ec96288eeec81fd08')
    const contour = p.setups[0].operations[1], oldContour = baseline.setups[0].operations[1]
    const { tabShape, ...params } = stableParams(p, contour)
    expect(params).toEqual(stableParams(baseline, oldContour))
    expect(contour.toolpathMoves).not.toEqual(oldContour.toolpathMoves)
    const lowRamps = contour.toolpathMoves.filter((move: any, i: number, moves: any[]) => {
      const prev = moves[i - 1]
      return prev && move.type === 'feed' && move.role === 'cut' &&
        Math.abs(move.z - prev.z) > 1e-6 && Math.hypot(move.x - prev.x, move.y - prev.y) > 1e-6 &&
        Math.max(move.z, prev.z) <= 1.5 + 1e-6 && Math.min(move.z, prev.z) >= -0.2 - 1e-6
    })
    expect(lowRamps.length).toBeGreaterThanOrEqual(8)
    expect(json('verification.json').postedDepths).toEqual({ carve: -1, contour: -6.2 })
  })

  it('exports the production text and PDF job sheet with holding, tab dimensions and removal instructions', () => {
    const sheet = readFileSync(join(evidence, 'name-sign.setup.txt'), 'utf8')
    expect(sheet).toContain('Method: Tape and glue')
    expect(sheet).toMatch(/4 tabs.*6(?:\.0+)?mm wide x 1\.5(?:0+)?mm high, triangular/)
    expect(sheet).toContain('cut the 4 tabs and sand the stubs')
    const nc = readFileSync(join(evidence, 'name-sign.nc'))
    // Export and Setup Sheet each stage their own fresh post. A main-example
    // production control also yields different hashes across those two clicks
    // (WO-2444/main-sheet-control/comparison.json). This order checks holding
    // instructions, rather than assuming cross-click post determinism.
    expect(sheet).toContain(`Bytes: ${nc.length}`)
    expect(readFileSync(join(evidence, 'name-sign.setup.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('reads exactly four remaining bridges and a cleared upper perimeter from live Cut Stock at the end', () => {
    const report = json('verification.json'), sim = report.simulation
    expect(sim.stockSync).toBe('exact')
    expect(sim.stockMs).toBe(Math.round(report.totalMs))
    expect(Math.abs(sim.markerMs - report.totalMs)).toBeLessThanOrEqual(1)
    expect(sim.removedVolumeMm3).toBeGreaterThan(0)
    expect(sim.tabs).toMatchObject({ display: 'true', bottomSolidRuns: 4, bottomBridgeRuns: 4, aboveTabSolidSamples: 0 })
    expect(sim.tabs.samples).toBeGreaterThan(1000)
    expect(sim.tabs.bottomSolidSamples).toBeGreaterThan(0)
  })

  it('captures new production pictures and leaves browser and application consoles free of errors', () => {
    for (const name of ['toolpaths.png', 'simulation-end.png', 'reopened.png']) {
      const bytes = readFileSync(join(evidence, name))
      expect(bytes.length).toBeGreaterThan(50_000)
      expect(bytes.readUInt32BE(16)).toBe(1920)
      expect(bytes.readUInt32BE(20)).toBe(1080)
    }
    for (const name of ['built-console.json', 'reopened-console.json', 'posted-console.json', 'simulation-console.json']) {
      expect(json(name).filter((e: any) => e.error)).toEqual([])
    }
    expect(json('browser-console.json').filter((e: any) => ['error', 'pageerror'].includes(e.type))).toEqual([])
    expect(json('scan.json').hits).toEqual([])
  })
})
