// WO-3009 row adapter: a normalised reference program replaces one step's
// moves and the UNCHANGED scoreChain collectors score it. Rows keep the A.5
// key (part, setup, step, tool, scope) and carry engine id `reference`.
// A reference row is an input to "good", never an oracle (alpha3-17 A.7).
import type { FeedrateOverride, ToolpathMove } from '../../../types'
import type { CutterSpec } from '../../../cam3d/kernel/types'
import { toolToCutterSpec } from '../../../cam3d/integration/cutterSpec'
import { removeSweep, ZDexelField } from '../../../cam3d/stock'
import { replaySagittaFor, toolpathMovesToLinearSweeps } from '../../../cam3d/rough/replayStock'
import { resolveFeedrates } from '../../../lib/cam/feedrates'
import { estimateRuntimeMsOrError } from '../../../lib/cam/runtime'
import { chainScene, scoreChain, type PlannedChain, type PlannedStep, type ScorecardRow } from '../chainRunner'
import { partById, toolById, type BenchmarkChain } from '../registry'
import type { NormalisedProgram } from './normalise'
import type { ParsedProgram } from './parse'
import { assignRoles } from './roles'

export const REFERENCE_ENGINE_ID = 'reference'
/** The rapid rate the alpha3 collectors resolve feeds against (metrics.alpha3.ts). */
const RAPID_RATE = 8000

export interface ReferenceStepInput {
  stepId: string
  program: NormalisedProgram
  /** Strategy settings as set, in the A.5 row's vocabulary (params.json). Feeds/speeds not given here come from the program. */
  settings?: PlannedStep['settings']
}
export type ReferenceRow = Omit<ScorecardRow, 'engineId'> & {
  engineId: typeof REFERENCE_ENGINE_ID
  roleInference: string
  program: Pick<ParsedProgram, 'ignoredWords' | 'unknownStartBlocks' | 'zeroLengthBlocks' | 'spindleRpm'> & { unparsedMotionWord?: string }
}

export function libraryTool(stepToolId: string) {
  const tool = toolById(stepToolId).libraryTool
  if (!tool) throw new Error(`reference harness: benchmark tool ${stepToolId} has no library record`)
  return tool
}

/** Feeds and speeds the program itself states, as settings data (A.7). */
function programOverride(moves: readonly ToolpathMove[], rpm: readonly number[]): FeedrateOverride {
  const fed = moves.filter(m => m.type !== 'rapid' && typeof m.feed === 'number').map(m => m.feed!)
  const plunges = moves.filter(m => m.role === 'plunge' && typeof m.feed === 'number').map(m => m.feed!)
  const cut = fed.length ? Math.max(...fed) : 0
  return { enabled: true, rpm: rpm.find(s => s > 0) ?? 0, feedRate: cut, plungeRate: plunges.length ? Math.min(...plunges) : cut,
    rampFeedrate: cut, leadInFeedrate: cut, leadOutFeedrate: cut, fastTraverseFeedrate: cut }
}

/**
 * Score reference programs for some steps of a chain. Steps without an input
 * keep the current engine's moves, so the carried stock is the chain's own.
 */
export async function scoreReferenceSteps(chain: BenchmarkChain, native: PlannedChain, inputs: readonly ReferenceStepInput[]) {
  const byStep = new Map(inputs.map(input => [input.stepId, input]))
  const scene = chain.alpha3?.project ? undefined : await chainScene(chain)
  const field = scene ? ZDexelField.fromBox(scene.box, partById(chain.partId).coverageCell) : undefined
  const inference = new Map<string, string>()
  const steps = chain.steps.map(step => {
    const plan = native.steps.find(candidate => candidate.stepId === step.id)
    if (!plan) throw new Error(`reference harness ${chain.id}: nothing planned for ${step.id}`)
    const input = byStep.get(step.id)
    const cutter: CutterSpec | undefined = field && !step.unavailableReason ? toolToCutterSpec(libraryTool(step.toolId)) : undefined
    if (!input) {
      if (field && cutter && plan.status === 'ready') carve(field, plan.moves, cutter)
      return plan
    }
    const base: PlannedStep = { stepId: plan.stepId, setupId: plan.setupId, sourceWcs: plan.sourceWcs,
      sourceWcsOrigin: plan.sourceWcsOrigin, heights: plan.heights, planMs: 0, moves: [] }
    if (input.program.unavailable !== undefined) {
      inference.set(step.id, 'none: program unavailable')
      return { ...base, status: 'n/a' as const, operatorText: input.program.unavailable, settings: input.settings ?? plan.settings }
    }
    const moves = field && cutter ? assignRoles(input.program.moves, field, cutter) : input.program.moves
    inference.set(step.id, field && cutter ? 'stock replay (carried z-dexel field, M-AIR-1 contact threshold)'
      : 'none: no world-space stock replay for this row; fed moves keep the default unlabelled role')
    const settings = input.settings ?? (plan.settings ? { ...plan.settings, feedrateOverride: programOverride(moves, input.program.parsed.spindleRpm) } : undefined)
    const feeds = resolveFeedrates(libraryTool(step.toolId), settings?.feedrateOverride, RAPID_RATE)
    const time = estimateRuntimeMsOrError(moves, RAPID_RATE, feeds.fastTraverseRate ?? RAPID_RATE, feeds.finishRate ?? RAPID_RATE)
    return { ...base, moves, status: 'ready' as const, operatorText: '', settings,
      ...(time.ms === undefined ? {} : { cutTimeMs: time.ms }) }
  })
  const result = await scoreChain(chain, { chainId: native.chainId, steps })
  const rows: ReferenceRow[] = result.rows.filter(row => byStep.has(row.stepId)).map(row => {
    const parsed = byStep.get(row.stepId)!.program.parsed
    return { ...row, engineId: REFERENCE_ENGINE_ID, roleInference: inference.get(row.stepId)!,
      program: { ignoredWords: parsed.ignoredWords, unknownStartBlocks: parsed.unknownStartBlocks,
        zeroLengthBlocks: parsed.zeroLengthBlocks, spindleRpm: parsed.spindleRpm,
        ...(parsed.unparsedMotionWord ? { unparsedMotionWord: parsed.unparsedMotionWord } : {}) } }
  })
  return { rows, planned: { chainId: native.chainId, steps } as PlannedChain }
}

function carve(field: ZDexelField, moves: readonly ToolpathMove[], cutter: CutterSpec) {
  for (const sweep of toolpathMovesToLinearSweeps(moves, replaySagittaFor(field))) removeSweep(field, sweep, cutter)
}
