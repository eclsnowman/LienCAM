// WO-3009 private compare: every valid store entry is matched to its A.5 row,
// checked for comparability, normalised, scored by the unchanged collectors
// under engine id `reference`, and diffed against the current engine's row.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainScene, planChain, scoreChain, type ChainResult, type PlannedChain } from '../chainRunner'
import { alpha3Chains, rowKey, type BenchmarkChain, type BenchmarkStep } from '../registry'
import { diffRow, familyReport, notComparable, type RowDiff } from './diff'
import { normaliseProgram, type NormalisedProgram } from './normalise'
import { parseProgram } from './parse'
import { libraryTool, scoreReferenceSteps, type ReferenceRow } from './rows'
import { isInside, referenceStoreDir, repositoryRoot } from './privacy'
import { NORMALISED, readReferenceStore, type StoreEntry } from './store'

/** Decide-and-log default (WO-3009): the first families compared. The operator can change it in one line. */
export const FIRST_FAMILIES = ['adaptive_3d', 'pocket_2d']

export interface CompareResult {
  excluded: { path: string; reason: string }[]
  notComparable: { path: string; key: string; reasons: string[] }[]
  outOfScope: { path: string; key: string; reason: string }[]
  rows: { path: string; key: string; reference: ReferenceRow; diff?: RowDiff }[]
  report: Record<string, RowDiff[]>
}

export function findStep(key: string, chains: readonly BenchmarkChain[] = alpha3Chains()): { chain: BenchmarkChain; step: BenchmarkStep } | undefined {
  for (const chain of chains) for (const step of chain.steps) if (rowKey(chain, step) === key) return { chain, step }
  return undefined
}

export async function compareStore(dir: string, families: readonly string[] = FIRST_FAMILIES, normalised?: Map<string, NormalisedProgram>): Promise<CompareResult> {
  return compareEntries(readReferenceStore(dir), families, normalised)
}

/** `normalised`, when given, receives each scored program's normaliser output by store path. */
export async function compareEntries(entries: readonly StoreEntry[], families: readonly string[] = FIRST_FAMILIES, normalised?: Map<string, NormalisedProgram>): Promise<CompareResult> {
  const result: CompareResult = { excluded: [], notComparable: [], outOfScope: [], rows: [], report: {} }
  const native = new Map<string, { planned: PlannedChain; scored: ChainResult }>()
  for (const entry of entries) {
    if (entry.status === 'excluded') { result.excluded.push({ path: entry.path, reason: entry.reason }); continue }
    const p = entry.params
    const key = [p.partId, p.setupLabel, p.stepId, p.toolId, p.scopeId].join('/')
    const found = findStep(key)
    if (!found) { result.outOfScope.push({ path: entry.path, key, reason: 'no A.5 row has this key' }); continue }
    const { chain, step } = found
    if (!families.includes(step.type)) { result.outOfScope.push({ path: entry.path, key, reason: `family ${step.type} is not in this run (${families.join(', ')})` }); continue }
    if (chain.alpha3?.project) { result.outOfScope.push({ path: entry.path, key, reason: 'project fixture: no world-space stock box to compare' }); continue }
    const { box } = await chainScene(chain)
    const reasons = notComparable(p, { tool: libraryTool(step.toolId), box })
    if (reasons.length) { result.notComparable.push({ path: entry.path, key, reasons }); continue }
    let run = native.get(chain.id)
    if (!run) {
      const planned = await planChain(chain)
      run = { planned, scored: await scoreChain(chain, planned) }
      native.set(chain.id, run)
    }
    const program = normaliseProgram(parseProgram(entry.program), { originMm: p.wcsOriginMm })
    normalised?.set(entry.path, program)
    const [reference] = (await scoreReferenceSteps(chain, run.planned, [{ stepId: step.id, program, settings: p.settings }])).rows
    const current = run.scored.rows.find(row => row.key === key)
    result.rows.push({ path: entry.path, key, reference, ...(current ? { diff: diffRow(current, reference) } : {}) })
  }
  result.report = familyReport(result.rows.flatMap(row => row.diff ? [row.diff] : []))
  return result
}

export type CaptureRun = { skip: string } | { skip?: undefined; dir: string; result: CompareResult; reportFile: string }

/** The private capture (referenceCompare.capture.ts): the store from the environment only, the report written into the store. */
export async function runReferenceCapture(env: Record<string, string | undefined> = process.env): Promise<CaptureRun> {
  const store = referenceStoreDir(env)
  if (store.skip !== undefined) return { skip: store.skip }
  const families = env.LIENCAM_REFERENCE_FAMILIES?.split(',').map(f => f.trim()).filter(Boolean) ?? FIRST_FAMILIES
  const normalised = new Map<string, NormalisedProgram>()
  const result = await compareStore(store.dir, families, normalised)
  // alpha3-17 A.7 Storage: normalised.moves.json beside each program that imported, in the store only.
  for (const [path, program] of normalised) {
    if (!program.moves) continue
    const file = join(store.dir, path, NORMALISED)
    if (!isInside(file, store.dir) || isInside(file, repositoryRoot())) throw new Error(`reference store refused: ${NORMALISED} would be written outside the store`)
    writeFileSync(file, JSON.stringify({ units: 'mm', frame: 'A.5 row world frame (Z up, Z = 0 at the table)', moves: program.moves }) + '\n')
  }
  const out = join(store.dir, '_reports')
  mkdirSync(out, { recursive: true })
  const reportFile = join(out, `reference-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(reportFile, JSON.stringify(result, null, 1) + '\n')
  return { dir: store.dir, result, reportFile }
}
