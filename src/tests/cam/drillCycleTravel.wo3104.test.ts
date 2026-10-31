// Oracle: WO-1886 rapid peck re-approach, WO-1926 shrinking pecks, and the owner-approved
// WO-3104 external travel switch. Stock-cutting roles do not define hole entry.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { NestRecord, Operation, ToolpathMove } from '../../types'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains, toolById, type BenchmarkChain } from '../benchmark/registry'
import { validatePersistedSmartHeightState } from '../../lib/cam/smartHeights/authority'
import { buildNestExpansion } from '../../lib/cam/nesting/nestRuntime'
import { enforceOperationTravel } from '../../lib/heights/minimumTravelZ'
import { makeMachine, makeOp, makeWcs } from '../post/helpers'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { readGcodeProgram } from '../../lib/gcode/reader'
import { typedMock } from '../support/typedMock'
import { evidenceOutDir } from '../helpers/evidenceScratch'

const cases = [
  { name: 'chip-break', cycleType: 'chip_break', decrement: 1 },
  { name: 'shrinking-peck', cycleType: 'peck', decrement: 1 },
  { name: 'constant-peck', cycleType: 'peck', decrement: 0 },
] as const
const point = (m: ToolpathMove) => ({ type: m.type, x: m.x, y: m.y, z: m.z })
const nearXY = (a: ToolpathMove, b: ToolpathMove) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6

/** Independent depth oracle, pinned to the shipped example's resolved Top0/Bottom-13.
 * Check EVERY internal sequence in EVERY hole, including type, target and feed.
 * Native parser expansion is intentionally never accepted as generated evidence. */
function checkCycles(moves: ToolpathMove[], kind: typeof cases[number], feed: number, unchecked: boolean, holes = 3) {
  const depths: number[] = []
  let z = 0, step = 3
  while (z > -13) { z = Math.max(-13, z - step); depths.push(z); step = Math.max(1, step - kind.decrement) }
  const cuts = moves.flatMap((m, i) => m.type === 'feed' && m.z < 0 ? [i] : [])
  expect(cuts.map(i => moves[i].z), 'selected cycle cutting depths, without added feed retrace').toEqual(Array.from({ length: holes }, () => depths).flat())
  for (let hole = 0; hole < holes; hole++) {
    const first = cuts[hole * depths.length]
    if (unchecked) {
      expect(moves[first - 1].z, `hole ${hole} external entry at Feed`).toBe(feed)
      expect(moves[first - 1].type, `hole ${hole} external entry rapid`).toBe('rapid')
    }
    for (let p = 0; p < depths.length - 1; p++) {
      const at = cuts[hole * depths.length + p], cut = moves[at]
      const targets = kind.cycleType === 'chip_break' ? [Math.min(0, cut.z + 0.5)] : [5, Math.min(feed, cut.z + 0.5)]
      const expected = targets.map(z => ({ type: 'rapid', x: cut.x, y: cut.y, z }))
      expect(moves.slice(at + 1, at + 1 + targets.length).map(point), `hole ${hole} peck ${p}: internal rapid contract`).toEqual(expected)
      const next = moves[at + targets.length + 1]
      expect(point(next)).toEqual({ type: 'feed', x: cut.x, y: cut.y, z: depths[p + 1] })
      expect(next.feed).toBe(cut.feed)
    }
  }
  if (unchecked) for (let i = 1; i < moves.length; i++) {
    if (!nearXY(moves[i - 1], moves[i])) {
      expect(Math.min(moves[i - 1].z, moves[i].z), 'external XY retains Retract or higher').toBeGreaterThanOrEqual(5)
    }
  }
}

for (const kind of cases) for (const feed of [5, 4.5]) {
  describe(`WO-3104 ${kind.name} Feed${feed}/Retract5`, () => {
    const results: { flag: boolean | undefined; moves: ToolpathMove[]; op: Operation; tool: ReturnType<typeof toolById>['libraryTool'] }[] = []
    beforeAll(async () => {
      for (const flag of [undefined, true, false]) {
        const chain = structuredClone(alpha3Chains().find(c => c.id === 'ex04-tool-storage-bar-declared')!) as BenchmarkChain
        chain.steps = chain.steps.filter(s => s.authoredOperation?.name === 'Drill 1').slice(0, 1)
        expect(chain.steps).toHaveLength(1)
        const s = chain.steps[0], authored = s.authoredOperation!
        s.params = { ...s.params, cycleType: kind.cycleType, peckDepth: 3, chipBreakRetract: 0.5, peckDecrement: kind.decrement, minPeckDepth: 1 }
        authored.params = s.params
        authored.heights = { ...authored.heights, minimizeZTravel: flag, feedHeight: feed,
          heightIntent: { ...authored.heights.heightIntent!, feed: { reference: 'wcs_plane', offset: feed, provenance: 'user' } } }
        const validated = validatePersistedSmartHeightState(authored.smartHeight)
        if (!validated.ok) throw new Error(validated.message)
        authored.smartHeight = { ...validated.state, intent: { ...validated.state.intent,
          safety: { ...validated.state.intent.safety, feed: { reference: 'wcs_plane', offsetMm: feed, owner: { kind: 'user_override' } } } } }
        // Retain the generated snapshot rather than the saved example's stale
        // Feed5 snapshot when the operator has selected Feed4.5.
        let store: typeof import('../../store') | undefined
        vi.doMock('../../store', async importOriginal => {
          store = await importOriginal<typeof import('../../store')>()
          return typedMock<typeof import('../../store')>({ ...store })
        })
        let planned: Awaited<ReturnType<typeof planChain>>
        try { planned = await planChain(chain) } finally { vi.doUnmock('../../store') }
        const step = planned.steps[0]
        const actual = store!.useCamStore.getState().project.setups.flatMap(s => s.operations).find(o => o.id === step.stepId)!
        expect(actual.resolvedHeights?.wcs.feed).toBe(feed)
        expect(step.status, step.operatorText).toBe('ready')
        expect(step.heights?.feedHeight).toBe(feed)
        results.push({ flag, moves: step.moves, op: makeOp({ ...authored, ...step.settings, heights: step.heights!, resolvedHeights: actual.resolvedHeights }), tool: toolById(s.toolId).libraryTool })
      }
      const dir = evidenceOutDir(`src/tests/evidence/WO-3104/drill-repair/${process.env.WO3104_PHASE ?? 'current'}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/${kind.name}-feed${feed}.json`, JSON.stringify(results))
    }, 180_000)

    it('generated publication preserves internal partial retracts and rapid re-approach', () => {
      expect(results[1].moves).toEqual(results[0].moves)
      for (const r of results) {
        expect(r.moves[0].z).toBe(15)
        expect(r.moves.at(-1)?.z).toBe(15)
        checkCycles(r.moves, kind, feed, r.flag === false)
      }
    })

    for (const route of ['uccnc', 'grbl', 'copies', 'nest'] as const) {
      it(`${route} expanded Post preserves the selected internal cycle and external planes`, () => {
        const programs: string[] = []
        for (const r of results) {
          const machine = makeMachine(), tool = r.tool!
          // Two translated copies plus an actual higher crossing exercise the
          // final post boundary on the generated stream (no native reconstruction).
          let moves = route === 'copies' ? [...r.moves,
            { ...r.moves.at(-1)!, z: 25 }, { ...r.moves[0], x: r.moves[0].x + 100, z: 25 },
            ...r.moves.map(m => ({ ...m, x: m.x + 100 }))] : r.moves
          if (route === 'nest') {
            const nest: NestRecord = { id: 'n', name: 'Two drill copies', sheet: { width: 400, height: 100 }, style: 'ninety',
              spacing: { partGap: 5, sheetMargin: 5, windowGap: 5 }, seed: 1,
              sources: [{ geometryId: 'seed', quantity: 2 }], placements: [0, 100].map((x, i) => ({
                partId: 'seed', instanceId: String(i), x, y: 0, rotationDeg: 0, depth: 0 })), unplaced: [], utilization: 0.5 }
            moves = buildNestExpansion(nest, [{ ...r.op, params: { ...r.op.params, geometryId: 'seed' }, toolpathMoves: r.moves }]).moves
            expect(moves.length).toBeGreaterThan(r.moves.length * 2)
          }
          const config = route === 'grbl' ? GRBL_CONFIG : UCCNC_CONFIG
          const posted = emitProgram({ machine, setup: { wcs: makeWcs(), operations: [{ op: r.op, tool, moves,
            // Force expanded UCCNC to inspect constant pecks too; the separate
            // native test below checks real native selection, without this flag.
            nestExpanded: route !== 'grbl', feeds: resolveFeedrates(tool, r.op.feedrateOverride),
            spindle: resolveSpindle(r.op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }, config)
          const text = posted.lines.join('\n')
          const out = evidenceOutDir(`src/tests/evidence/WO-3104/drill-repair/${process.env.WO3104_PHASE ?? 'current'}`)
          writeFileSync(`${out}/${kind.name}-feed${feed}-${route}-${r.flag}.nc`, text)
          expect(text).not.toMatch(/G8[123]/)
          const read = readGcodeProgram(text, { dialect: route === 'grbl' ? 'grbl' : 'uccnc', sessionWcs: 'G54',
            initialPosition: { x: 0, y: 0, z: 50 }, machineUnits: 'mm', workOffsets: { G54: { x: 0, y: 0, z: 0 } } })
          expect(read.ok).toBe(true)
          if (!read.ok) throw new Error('Posted program did not parse')
          const parsed = read.program.moves as ToolpathMove[]
          checkCycles(parsed, kind, feed, r.flag === false, route === 'copies' || route === 'nest' ? 6 : 3)
          if (route === 'copies') expect(parsed.some(m => m.z === 25)).toBe(true)
          programs.push(text)
        }
        expect(programs[1], 'missing and checked posted bytes').toBe(programs[0])
      })
    }

    it('native selection remains constant-peck only, with unchecked Feed R', () => {
      const machine = makeMachine()
      const programs = results.map(r => {
        const tool = r.tool!
        return emitProgram({ machine, setup: { wcs: makeWcs(), operations: [{ op: r.op, tool, moves: r.moves,
          feeds: resolveFeedrates(tool, r.op.feedrateOverride), spindle: resolveSpindle(r.op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }, UCCNC_CONFIG).lines.join('\n')
      })
      expect(programs[1]).toBe(programs[0])
      const out = evidenceOutDir(`src/tests/evidence/WO-3104/drill-repair/${process.env.WO3104_PHASE ?? 'current'}`)
      writeFileSync(`${out}/${kind.name}-feed${feed}-native-false.nc`, programs[2])
      if (kind.name === 'constant-peck') expect(programs[2]).toContain(`G98 G83`)
      else expect(programs[2]).not.toMatch(/G8[123]/)
      if (kind.name === 'constant-peck') expect(programs[2].split('\n').find(l => l.startsWith('G98 G83'))).toContain(` R${feed} `)
    })
  })
}

it('drill context retains external Feed entries and Retract links after every XY boundary', () => {
  const rapid = (x: number, z: number): ToolpathMove => ({ type: 'rapid', role: 'rapid', x, y: 0, z })
  const cut = (x: number, z: number): ToolpathMove => ({ type: 'feed', role: 'plunge', x, y: 0, z, feed: 500 })
  const heights = { ...makeOp().heights, clearanceHeight: 15, feedHeight: 4.5, minimizeZTravel: false }
  const moves = [rapid(0, 15), rapid(0, 1), cut(0, -3), rapid(0, -2.5), cut(0, -5),
    rapid(20, 1), cut(20, -3), rapid(20, -2.5), cut(20, -5), rapid(20, 15)]
  const result = enforceOperationTravel(moves, heights, 0, 0, undefined, 'drill')
  for (const x of [0, 20]) {
    const first = result.findIndex(m => m.x === x && m.z === 1 && m.type === 'feed')
    expect(first).toBeGreaterThan(0)
    expect(result[first - 1]).toEqual(rapid(x, 4.5))
    const peck = result.findIndex(m => m.x === x && m.z === -3)
    expect(result[peck + 1]).toEqual(rapid(x, -2.5))
  }
  const traverses = result.filter((m, i) => i > 0 && !nearXY(m, result[i - 1]))
  expect(traverses).toEqual([rapid(20, 5)])
  expect(enforceOperationTravel(result, heights, 0, 0, undefined, 'drill')).toEqual(result)
})
