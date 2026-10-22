// WO-3009 store reader (alpha3-17 A.7): one folder per <part-id>/<op>/<tool>/
// holding the raw program, params.json (every strategy parameter as set) and
// provenance.json (date, operator, program version, session id, file hashes).
// A folder that fails validation is EXCLUDED with its reason, never guessed at.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannedStep } from '../chainRunner'
import type { Point3 } from './parse'

export const PARAMS = 'params.json'
export const PROVENANCE = 'provenance.json'
export const NORMALISED = 'normalised.moves.json'

export interface ReferenceParams {
  /** The A.5 row this program answers: key (part, setup, step, tool, scope). */
  partId: string; setupLabel: string; stepId: string; toolId: string; scopeId: string
  opType: string
  tool: { type: string; diameterMm: number; cornerRadiusMm?: number }
  /** Stock box in the A.5 row's world frame, mm. */
  stock: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  /** Program zero in the A.5 row's world frame (Z up, Z = 0 at the table). */
  wcsOriginMm?: Point3
  /** Strategy settings in the A.5 row's vocabulary, when the generation session mapped them. */
  settings?: PlannedStep['settings']
  /** Every strategy parameter as set in the reference program, free-form. */
  strategy?: Record<string, unknown>
}
export interface ReferenceProvenance {
  date: string; operator: string; programVersion: string; sessionId: string
  /** sha256 (hex) of every file in the folder except provenance.json and normalised.moves.json. */
  files: Record<string, string>
}
export type StoreEntry =
  | { path: string; status: 'valid'; programFile: string; program: string; params: ReferenceParams & { wcsOriginMm: Point3 }; provenance: ReferenceProvenance }
  | { path: string; status: 'excluded'; reason: string }

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const dirs = (path: string) => readdirSync(path).filter(name => !name.startsWith('.') && !name.startsWith('_') && statSync(join(path, name)).isDirectory()).sort()

export function readReferenceStore(root: string): StoreEntry[] {
  const out: StoreEntry[] = []
  for (const part of dirs(root)) for (const op of dirs(join(root, part))) for (const tool of dirs(join(root, part, op))) {
    out.push(readEntry(join(root, part, op, tool), `${part}/${op}/${tool}`, { part, tool }))
  }
  return out
}

export function readEntry(dir: string, path: string, folder: { part: string; tool: string }): StoreEntry {
  const excluded = (reason: string): StoreEntry => ({ path, status: 'excluded', reason })
  if (!existsSync(join(dir, PROVENANCE))) return excluded(`missing ${PROVENANCE}`)
  if (!existsSync(join(dir, PARAMS))) return excluded(`missing ${PARAMS}`)
  const programs = readdirSync(dir).filter(name => ![PARAMS, PROVENANCE, NORMALISED].includes(name) && statSync(join(dir, name)).isFile()).sort()
  if (programs.length !== 1) return excluded(programs.length ? `more than one program file: ${programs.join(', ')}` : 'no program file')
  let provenance: ReferenceProvenance, params: ReferenceParams
  try { provenance = JSON.parse(readFileSync(join(dir, PROVENANCE), 'utf8')) } catch (error) { return excluded(`${PROVENANCE} is not JSON: ${(error as Error).message}`) }
  try { params = JSON.parse(readFileSync(join(dir, PARAMS), 'utf8')) } catch (error) { return excluded(`${PARAMS} is not JSON: ${(error as Error).message}`) }
  for (const field of ['date', 'operator', 'programVersion', 'sessionId'] as const) {
    if (typeof provenance[field] !== 'string' || !provenance[field]) return excluded(`${PROVENANCE} has no ${field}`)
  }
  for (const file of [programs[0], PARAMS]) {
    const recorded = provenance.files?.[file]
    if (typeof recorded !== 'string') return excluded(`${PROVENANCE} records no hash for ${file}`)
    if (recorded.toLowerCase() !== sha256(readFileSync(join(dir, file)))) return excluded(`hash mismatch: ${file}`)
  }
  if (params.partId !== folder.part || params.toolId !== folder.tool) {
    return excluded(`${PARAMS} names ${params.partId}/${params.toolId}, folder is ${folder.part}/${folder.tool}`)
  }
  const o = params.wcsOriginMm
  if (!o || ![o.x, o.y, o.z].every(Number.isFinite)) return excluded(`no WCS record (${PARAMS} wcsOriginMm): the harness cannot place the program`)
  return { path, status: 'valid', programFile: programs[0], program: readFileSync(join(dir, programs[0]), 'utf8'),
    params: params as ReferenceParams & { wcsOriginMm: Point3 }, provenance }
}

/** File hashes for a provenance record (used by the synthetic fixtures and the generation session). */
export function hashFiles(dir: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map(file => [file, sha256(readFileSync(join(dir, file)))]))
}
