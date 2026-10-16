import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

// One opt-in for deliberate committed captures, shared by explicit writers
// and the test-time filesystem hook. Reads always use the committed baseline.
export const EVIDENCE_REFRESH_ENV = 'WRITE_EVIDENCE'
export const EVIDENCE_SCRATCH_ROOT = join(process.cwd(), '.test-scratch')

export function refreshEvidence(): boolean {
  return process.env[EVIDENCE_REFRESH_ENV] === '1'
}

export function evidenceOutDir(committedDir: string): string {
  if (refreshEvidence()) return committedDir
  // Windows lanes may be reached through both the checkout path (cwd) and the
  // physical H:/... path Node assigns to __dirname. They name one worktree.
  const root = process.cwd()
  const physicalRoot = realpathSync(root)
  const absolute = resolve(committedDir)
  const logicalRel = relative(root, absolute)
  const rel = logicalRel === '..' || logicalRel.startsWith(`..${sep}`) || isAbsolute(logicalRel)
    ? relative(physicalRoot, absolute) : logicalRel
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Evidence capture must be inside the worktree: ${committedDir}`)
  }
  return join(EVIDENCE_SCRATCH_ROOT, rel)
}
