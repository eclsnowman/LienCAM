// WO-1618 (finding SH-9): a through Pocket 2D above a vise is still cut, down to the vise.
//
// The WO-1606 scene, on the production compute path (runHeightScenario: store actions,
// the operation dialog's defaults, computeOperationToolpath and the REAL toolpath worker,
// moves read back in WCS). A 60 x 40 sketch raised 50 mm, auto stock 12 mm thick on top
// of it (WCS 0 .. -12), the pocket X 15..35 Y 10..30 cut through to stock bottom - 0.5 =
// WCS -12.5. The vise top is the stock bottom, WCS -12.
//
// Hand-worked expectation: only the depths within the Shank clearance (default 0.25 mm)
// of the vise top reach it. So where the vise is under the pocket the deepest cut is
// WCS -12 + 0.25 = -11.75, and where it is not, the pocket goes the full -12.5.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolpathMove } from '../../types'
import { useCamStore } from '../../store'
import {
  installRealToolpathWorker, isCutting, movesEnteringBox, rectLoop, runHeightScenario,
  type HeightScenario, type ScenarioWorkholding,
} from '../helpers/heightScenario'

installRealToolpathWorker()

const RAISE = 50
const TOOL_RADIUS = 3
const ALLOWANCE = 0.25
const VISE_TOP_WCS = -12
const BREAKTHROUGH_WCS = -12.5
const TOL = 0.01

function scenarioWith(workholding: ScenarioWorkholding): HeightScenario {
  return {
    part: {
      kind: 'sketch_2d', z: RAISE,
      loops: [rectLoop('outline', 0, 0, 60, 40), rectLoop('pocket', 15, 10, 35, 30)],
    },
    stock: { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 },
    operation: 'pocket_2d',
    loopIds: ['pocket'],
    bottomRow: { reference: 'stock_bottom', offsetMm: -0.5 },
    workholding,
  }
}

/** Side view (X across, Z up) of the program with the vise and stock, for the picture
 *  verdict. Written only with WRITE_EVIDENCE=1; EVIDENCE_TAG names before/after. */
function writeSideView(name: string, reading: Awaited<ReturnType<typeof runHeightScenario>>) {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const tag = process.env.EVIDENCE_TAG ?? 'after'
  const box = reading.workholdingWcs!
  const x0 = reading.stockXY.minX - 5
  const x1 = reading.stockXY.maxX + 5
  const z0 = reading.stockBottomWcs - 6
  const z1 = reading.stockTopWcs + 4
  const scale = 12
  const W = (x1 - x0) * scale
  const H = (z1 - z0) * scale
  const px = (x: number) => ((x - x0) * scale).toFixed(1)
  const pz = (z: number) => ((z1 - z) * scale).toFixed(1)
  const cuts = reading.moves.filter((m: ToolpathMove) => isCutting(m, 'pocket_2d'))
  const path = cuts.map((m: ToolpathMove, i: number) => `${i === 0 ? 'M' : 'L'}${px(m.x)} ${pz(m.z)}`).join(' ')
  const deepest = cuts.length ? Math.min(...cuts.map((m: ToolpathMove) => m.z)) : NaN
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 40}" font-family="sans-serif">
<rect width="100%" height="100%" fill="white"/>
<text x="8" y="22" font-size="18">WO-1618 ${tag}: ${name} - side view, ${cuts.length} cutting moves, deepest cut Z ${Number.isFinite(deepest) ? deepest.toFixed(3) : 'none'}</text>
<g transform="translate(0,40)">
<rect x="${px(reading.stockXY.minX)}" y="${pz(reading.stockTopWcs)}" width="${((reading.stockXY.maxX - reading.stockXY.minX) * scale).toFixed(1)}" height="${((reading.stockTopWcs - reading.stockBottomWcs) * scale).toFixed(1)}" fill="#d9c7a3" stroke="#8a7550"/>
<rect x="${px(Math.max(box.min.x, x0))}" y="${pz(box.max.z)}" width="${((Math.min(box.max.x, x1) - Math.max(box.min.x, x0)) * scale).toFixed(1)}" height="${((box.max.z - Math.max(box.min.z, z0)) * scale).toFixed(1)}" fill="#7d8fa6" stroke="#34455c"/>
<text x="${px(Math.max(box.min.x, x0)) }" y="${(Number(pz(box.max.z)) + 22).toFixed(1)}" font-size="16" fill="white" dx="6">Vise (top Z ${box.max.z.toFixed(2)})</text>
${path ? `<path d="${path}" fill="none" stroke="#d62728" stroke-width="1.5"/>` : ''}
</g></svg>`
  const dir = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-1618')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${tag}-${name}.svg`), svg)
}

async function run(workholding: ScenarioWorkholding) {
  const reading = await runHeightScenario(scenarioWith(workholding))
  const consoleLines = (useCamStore.getState() as unknown as { consoleEvents?: Array<{ message: string }> })
    .consoleEvents?.map(event => event.message) ?? []
  const cutting = reading.moves.filter(m => isCutting(m, 'pocket_2d'))
  return { reading, consoleLines, cutting }
}

describe('WO-1618: a through pocket above a vise is cut down to the vise', () => {
  it('vise under the whole pocket: every cut stops at the vise top plus the allowance', async () => {
    const { reading, consoleLines, cutting } = await run(
      { name: 'Vise', min: { x: 10, y: 5, z: 0 }, max: { x: 40, y: 35, z: RAISE } },
    )
    writeSideView('vise-under-whole-pocket', reading)
    console.log(`[WO-1618 whole] status ${reading.status}, ${cutting.length} cutting moves, ` +
      `deepest ${reading.deepestCutZ}, console ${JSON.stringify(consoleLines.filter(l => /workholding/i.test(l)))}`)
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(cutting.length, 'cutting moves').toBeGreaterThan(0)
    expect(Math.abs(reading.deepestCutZ - (VISE_TOP_WCS + ALLOWANCE)), `deepest cut ${reading.deepestCutZ}`)
      .toBeLessThanOrEqual(TOL)
    // The pocket is cleared across its floor at that depth, not just touched. The
    // moves are in WCS; the vise box (machine X 10, Y 5) gives the shift.
    const dx = reading.workholdingWcs!.min.x - 10
    const dy = reading.workholdingWcs!.min.y - 5
    const floorMoves = cutting.filter(m => Math.abs(m.z - reading.deepestCutZ) <= TOL)
    const xs = floorMoves.map(m => m.x)
    const ys = floorMoves.map(m => m.y)
    expect(Math.min(...xs)).toBeLessThanOrEqual(dx + 15 + TOOL_RADIUS + 0.5)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(dx + 35 - TOOL_RADIUS - 0.5)
    expect(Math.min(...ys)).toBeLessThanOrEqual(dy + 10 + TOOL_RADIUS + 0.5)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(dy + 30 - TOOL_RADIUS - 0.5)
    expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, TOOL_RADIUS).length, 'moves entering the vise')
      .toBe(0)
    expect(consoleLines.some(line => /over the workholding the cut stops 0\.25 mm above its top/.test(line)
      && /last 0\.75 mm of the depth was not cut/.test(line)), 'the console says what was left and why').toBe(true)
    expect(consoleLines.some(line => /nothing to cut/.test(line))).toBe(false)
  }, 120_000)

  it('vise under half the pocket: the full breakthrough away from it, the vise top plus the allowance over it', async () => {
    // The vise's +X face at X 25 runs across the middle of the pocket.
    const { reading, cutting } = await run(
      { name: 'Vise', min: { x: 0, y: 5, z: 0 }, max: { x: 25, y: 35, z: RAISE } },
    )
    const box = reading.workholdingWcs!
    writeSideView('vise-under-half-pocket', reading)
    console.log(`[WO-1618 half] status ${reading.status}, ${cutting.length} cutting moves, deepest ${reading.deepestCutZ}`)
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(Math.abs(reading.deepestCutZ - BREAKTHROUGH_WCS), `deepest cut ${reading.deepestCutZ}`).toBeLessThanOrEqual(TOL)
    const xyToVise = (x: number, y: number) =>
      Math.hypot(Math.max(box.min.x - x, 0, x - box.max.x), Math.max(box.min.y - y, 0, y - box.max.y))
    const belowFloor = cutting.filter(m => m.z < VISE_TOP_WCS + ALLOWANCE - TOL)
    expect(belowFloor.length, 'breakthrough cuts beside the vise').toBeGreaterThan(0)
    const closest = Math.min(...belowFloor.map(m => xyToVise(m.x, m.y)))
    expect(closest, 'breakthrough cuts keep the cutter and allowance off the vise').toBeGreaterThanOrEqual(
      TOOL_RADIUS + ALLOWANCE - TOL)
    // Over the vise the pocket still clears down to the floor (pocket X 15.. in machine X; box min X is machine 0).
    const overVise = cutting.filter(m => xyToVise(m.x, m.y) === 0 && m.x > box.min.x + 15)
    expect(overVise.length, 'cuts over the vise').toBeGreaterThan(0)
    expect(Math.min(...overVise.map(m => m.z))).toBeCloseTo(VISE_TOP_WCS + ALLOWANCE, 2)
    expect(movesEnteringBox(reading.moves, box, TOOL_RADIUS).length, 'moves entering the vise').toBe(0)
  }, 120_000)
})
