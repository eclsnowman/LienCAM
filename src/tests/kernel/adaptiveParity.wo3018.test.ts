// WO-3018 acceptance 1 (PARITY): the adaptive kernel route is byte-identical to `current`.
//
// Production route: alpha.3 adaptive rows (WO-2899's A.5 set) go through the store's
// computeOperationToolpath (benchmark chain runner, real toolpath worker and real cam3d
// dispatcher) with the engine selector at `kernel`. Every move and the posted G-code of
// every adaptive_clearing_2d and adaptive_3d step must equal the record captured from
// the WO-3018 starter on the current engine (src/tests/evidence/WO-3018/before-record.json).
// Every output field is host-bound (float bits differ across platforms and node majors, and
// on a 3D row that can change the moves, the move count and the posted G-code): the record
// is the oracle for outputs only on its capture host. On any other host every output field
// (moves, move count, G-code hash and bytes) is compared with a same-process run of the
// current engine (live oracle, same chains), and the record's step ids, types, status and
// notices still hold.
// The 4 mm flat rows are n/a in the benchmark (no library recipe); parity plans them here
// with their synthetic feeds, because the bar is "same moves", not a scored row.
//
// Default run: a representative set (about 4 minutes). WO3018_PARITY=all plans every
// adaptive row (about 40 minutes, form-cylinder and ex06 are the slow ones).
// Re-record on the starter source only:
//   WO3018_RECORD=<path> WO3018_PARITY=all npx vitest run src/tests/kernel/adaptiveParity.wo3018.test.ts
// WO3018_ENGINE=current|kernel|both picks the engine (default: kernel, or current when recording).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import type * as AdaptiveKernelModule from '../../kernel/ops/adaptive'
import { typedMock } from '../support/typedMock'

const plannerRuns: Record<string, number> = {}

// Count what reaches the kernel planner, so the parity run proves the new route ran.
vi.mock('../../kernel/ops/adaptive', async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptiveKernelModule>()
  return typedMock<typeof AdaptiveKernelModule>({
    ...actual,
    createAdaptivePlanner: (record, dependencies) => {
      const planner = actual.createAdaptivePlanner(record, dependencies)
      return async input => {
        const plan = await planner(input)
        plannerRuns[record.type] = (plannerRuns[record.type] ?? 0) + 1
        return plan
      }
    },
  })
})

const { planChain } = await import('../benchmark/chainRunner')
const { alpha3Chains } = await import('../benchmark/registry')
const { postProgram, GRBL_CONFIG } = await import('../../lib/post')
const { resolveFeedrates } = await import('../../lib/cam/feedrates')
const { resolveSpindle, resolveCoolant } = await import('../../lib/post/resolve')
const { makeTool, makeMachine, makeOp, makeWcs } = await import('../post/helpers')

const RECORD_PATH = 'src/tests/evidence/WO-3018/before-record.json'
const ADAPTIVE = new Set(['adaptive_clearing_2d', 'adaptive_3d'])
// 2D: the engagement pocket at default and declared params (6 and 4 mm flat). 3D: a rest
// chain (kernel route with a retained field), outside-wall terraces, an island pocket,
// the box and sphere forms.
const DEFAULT_CHAINS = [
  'engagement-pocket-adaptive_clearing_2d-default',
  'engagement-pocket-adaptive_clearing_2d-declared',
  'engagement-pocket-rest-pencil-declared',
  'engagement-pocket-rough-finish-declared',
  'stepped-boss-rough-finish-declared',
  'form-box-default',
  'form-sphere-declared',
] as const
const ALL_CHAINS = () => alpha3Chains()
  .filter(chain => chain.steps.some(step => ADAPTIVE.has(step.type) && !step.unavailableReason))
  .map(chain => chain.id)

interface StepRecord { stepId: string; type: string; status?: string; operatorText?: string; moveCount: number; moves: string; gcode: string; gcodeBytes: number }

interface CaptureHost { platform: string; arch: string; nodeMajor: number }

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const thisHost = (): CaptureHost => ({ platform: process.platform, arch: process.arch,
  nodeMajor: Number(process.versions.node.split('.')[0]) })
const hostBound = ({ moves: _moves, moveCount: _moveCount, gcode: _gcode, gcodeBytes: _gcodeBytes, ...rest }: StepRecord) => rest

async function recordChains(engine: string, ids: string[], timings?: Record<string, number>) {
  vi.stubEnv('LIENCAM_ENGINE', engine)
  const records: Record<string, StepRecord[]> = {}
  for (const id of ids) {
    const started = performance.now()
    records[id] = await recordChain(id)
    if (timings) timings[id] = Math.round(performance.now() - started)
  }
  vi.unstubAllEnvs()
  return records
}

function postedGcode(stepId: string, type: string, moves: Parameters<typeof postProgram>[0]['setup']['operations'][number]['moves']) {
  const machine = makeMachine()
  const tool = makeTool({ id: 't1', name: 'Flat d6', type: 'flat_end_mill', diameter: 6, toolNumber: 1 })
  const op = makeOp({ id: stepId, name: 'Adaptive', type: type as 'adaptive_3d', toolId: tool.id, status: 'ready', toolpathMoves: moves })
  const result = postProgram({ machine, setup: { wcs: makeWcs(), operations: [{
    op, tool, moves,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
  }] } }, GRBL_CONFIG)
  expect(result.ok).toBe(true)
  return result.gcode
}

async function recordChain(id: string): Promise<StepRecord[]> {
  const chain = alpha3Chains().find(candidate => candidate.id === id)
  expect(chain, id).toBeDefined()
  // Adaptive steps only; the 2D 4 mm row is planned despite its n/a benchmark reason.
  // Only the steps the starter record holds (a new capture records all): steps added to the
  // stick later (WO-3025's second tool) are measured by the stick's own tests.
  const recorded = process.env.WO3018_RECORD ? undefined : (JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as
    { chains: Record<string, StepRecord[]> }).chains[id]?.map(step => step.stepId)
  const steps = chain!.steps
    .filter(step => ADAPTIVE.has(step.type) && (!step.unavailableReason || step.type === 'adaptive_clearing_2d'))
    .filter(step => !recorded || recorded.includes(step.id))
    .map(step => ({ ...step, unavailableReason: undefined }))
  const planned = await planChain({ ...chain!, steps })
  return planned.steps.map((step, index) => {
    const gcode = step.moves.length ? postedGcode(step.stepId, steps[index].type, step.moves) : ''
    return { stepId: step.stepId, type: steps[index].type, status: step.status, operatorText: step.operatorText,
      moveCount: step.moves.length, moves: sha(JSON.stringify(step.moves)), gcode: sha(gcode), gcodeBytes: gcode.length }
  })
}

describe('WO-3018 adaptive kernel route parity (production Generate)', () => {
  it('off the capture host compares the record on host-independent fields only', () => {
    const step: StepRecord = { stepId: 's', type: 'adaptive_3d', status: 'ready', operatorText: '', moveCount: 1,
      moves: 'm', gcode: 'g', gcodeBytes: 1 }
    expect(Object.keys(hostBound(step)).sort()).toEqual(['operatorText', 'status', 'stepId', 'type'])
  })

  it('moves and posted G-code of every adaptive step equal the starter on the current engine', { timeout: 7_200_000 }, async () => {
    const recordTo = process.env.WO3018_RECORD
    const engine = process.env.WO3018_ENGINE ?? (recordTo ? 'current' : 'kernel')
    const ids = process.env.WO3018_PARITY === 'all' ? ALL_CHAINS() : [...DEFAULT_CHAINS]
    const timings: Record<string, number> = {}
    const records = await recordChains(engine, ids, timings)
    const runs = { ...plannerRuns }
    if (process.env.WO3018_TIMINGS) writeFileSync(process.env.WO3018_TIMINGS, JSON.stringify({ engine, timings }, null, 1) + '\n')
    if (recordTo) {
      writeFileSync(recordTo, JSON.stringify({ host: thisHost(), chains: records }, null, 1) + '\n')
      return
    }
    const before = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as { host: CaptureHost; chains: Record<string, StepRecord[]> }
    expect(Object.keys(before.host ?? {}).sort(), 'before-record.json names its capture host').toEqual(['arch', 'nodeMajor', 'platform'])
    if (JSON.stringify(thisHost()) === JSON.stringify(before.host)) {
      for (const id of ids) expect(records[id], id).toEqual(before.chains[id])
    } else {
      for (const id of ids) expect(records[id].map(hostBound), id).toEqual(before.chains[id].map(hostBound))
      const live = await recordChains('current', ids)
      for (const id of ids) expect(records[id], `${id} against the live current engine`).toEqual(live[id])
    }
    const types = new Set(Object.values(records).flat().filter(step => step.moveCount > 0).map(step => step.type))
    expect([...types].sort()).toEqual(['adaptive_3d', 'adaptive_clearing_2d'])
    if (engine === 'kernel') {
      // The kernel route actually planned every generated adaptive step, in both aliases.
      const generated = Object.values(records).flat().filter(step => step.status === 'ready')
      expect(runs.adaptive_clearing_2d ?? 0).toBe(generated.filter(step => step.type === 'adaptive_clearing_2d').length)
      expect(runs.adaptive_3d ?? 0).toBe(generated.filter(step => step.type === 'adaptive_3d').length)
    }
  })
})
