// WO-3009 acceptance (1): current-engine P0 rows (the first families,
// adaptive_3d and pocket_2d), planned through the app's production entry
// (planChain), posted through every shipping dialect and re-imported by the
// independent reader, score the same cells as the program the post wrote.
// Every cell where the re-import differs from the native ENGINE row must be
// explained by what a G-code file cannot carry (roles) or by the post's own
// arc fit; none may come from the reader. Writes round-trip.json.
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planChain, scoreChain } from './chainRunner'
import { alpha3Chains } from './registry'
import { parseProgram } from './reference/parse'
import { libraryTool, scoreReferenceSteps } from './reference/rows'
import { cellDiffs, DIALECTS, maxRelativeDeviation, nativeProgramView, postedGeometryView, postStep, reimport } from './reference/roundTrip'

const ROWS = [
  { chainId: 'stepped-boss-rough-finish-declared', type: 'adaptive_3d' },
  { chainId: 'engagement-pocket-pocket_2d-declared', type: 'pocket_2d' },
]
const EVIDENCE = 'src/tests/evidence/WO-3009'
const noProgram = parseProgram('')

describe('WO-3009 reference round trip through every dialect', () => {
  it('re-imports every dialect to the posted geometry\'s cells, and every engine difference has a named cause', async () => {
    const record = []
    for (const target of ROWS) {
      const chain = alpha3Chains().find(c => c.id === target.chainId)!
      const step = chain.steps.find(s => s.type === target.type && !s.unavailableReason)
      expect(step, `${target.chainId} has a ${target.type} step`).toBeDefined()
      const native = await planChain(chain)
      const plan = native.steps.find(s => s.stepId === step!.id)!
      expect(plan.status).toBe('ready')
      const engine = (await scoreChain(chain, native)).rows.find(r => r.stepId === step!.id)!
      const tool = libraryTool(step!.toolId)
      const score = async (moves: ReturnType<typeof nativeProgramView>) => (await scoreReferenceSteps(chain, native,
        [{ stepId: step!.id, settings: plan.settings, program: { moves, parsed: noProgram } }])).rows[0]
      const view = await score(nativeProgramView(plan, tool))
      const roleCells = new Set(cellDiffs(engine, view).diffs.map(d => d.cell))
      const dialects = []
      for (const dialect of DIALECTS) {
        const program = postStep(plan, tool, step!.type, dialect.id)
        const imported = reimport(program, plan)
        expect(imported.unavailable, `${dialect.id}: ${imported.unavailable}`).toBeUndefined()
        const reference = (await scoreReferenceSteps(chain, native, [{ stepId: step!.id, settings: plan.settings, program: imported }])).rows[0]
        const posted = postedGeometryView(plan, tool, dialect.id)
        const postedRow = await score(posted)
        const fitCells = new Set(cellDiffs(view, postedRow).diffs.map(d => d.cell))
        const vsPosted = cellDiffs(postedRow, reference)
        const vsEngine = cellDiffs(engine, reference).diffs.map(d => ({ ...d,
          cause: [...(roleCells.has(d.cell) ? ['roles: a G-code file carries none'] : []),
            ...(fitCells.has(d.cell) ? ['post arc fit / unwritten sub-resolution blocks'] : [])] }))
        expect(reference, `${dialect.id} scored a reference row`).toBeDefined()
        expect(reference.engineId).toBe('reference')
        expect(imported.moves!.length, `${dialect.id} move count`).toBe(posted.length)
        expect(vsPosted.diffs, `${dialect.id} re-import vs posted geometry`).toEqual([])
        expect(vsEngine.filter(d => !d.cause.length), `${dialect.id} engine differences with no cause`).toEqual([])
        dialects.push({ dialect: dialect.id, programBytes: Buffer.byteLength(program), reimportedMoves: imported.moves!.length,
          postedGeometryMoves: posted.length, ignoredWords: imported.parsed.ignoredWords,
          unknownStartBlocks: imported.parsed.unknownStartBlocks, zeroLengthBlocks: imported.parsed.zeroLengthBlocks,
          cellsCompared: vsPosted.compared, differencesVsPostedGeometry: vsPosted.diffs.length,
          largestRelativeDeviationVsPostedGeometry: maxRelativeDeviation(postedRow, reference),
          engineCellsDiffering: vsEngine })
      }
      record.push({ key: engine.key, opType: step!.type, nativeMoves: plan.moves.length, dialects })
    }
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(`${EVIDENCE}/round-trip.json`, JSON.stringify({
      order: 'WO-3009', test: 'src/tests/benchmark/referenceRoundTrip.wo3009.test.ts',
      reader: 'gcode-parser 2.2.0 + gcode-toolpath 3.0.0 (cncjs, MIT), not src/lib/gcode',
      tolerance: 'count cells exact; every other cell within its scorecard band (metricRegistry.ts); reasons equal with quoted numbers to 1e-4 relative',
      comparisons: {
        vsPostedGeometry: 'the moves the dialect writes, computed WITHOUT reading the file: production collapsePolyline with the dialect limits, blocks unchanged at its resolution dropped, roles removed; scored by the same adapter',
        engineCellsDiffering: 'cells where the re-import differs from the native engine row, each with its cause: roles (engine row vs the role-free program view of the same moves) and/or the post arc fit (program view vs posted geometry)',
      },
      rows: record,
    }, null, 1) + '\n')
  }, 600_000)
})
