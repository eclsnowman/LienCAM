// WO-1902: an ordinary test run must leave `git status` clean. A test that
// records what it measured writes through this helper: the capture goes to an
// untracked, gitignored scratch tree unless WRITE_EVIDENCE=1 asks for the
// committed location. Keeping a capture in the repo is a deliberate act.
import { join } from 'node:path'

/** Untracked scratch root (gitignored). */
export const EVIDENCE_SCRATCH_ROOT = join(process.cwd(), '.test-scratch')

/** The directory a test should write its capture into.
 *  `committedDir` is the tracked path under src/tests/evidence/ (absolute or
 *  cwd-relative). WRITE_EVIDENCE=1 returns it unchanged; otherwise the same
 *  relative path under the scratch root. */
export function evidenceOutDir(committedDir: string): string {
  if (process.env.WRITE_EVIDENCE === '1') return committedDir
  const cwd = process.cwd().split('\\').join('/')
  const norm = committedDir.split('\\').join('/')
  const rel = norm.startsWith(`${cwd}/`) ? norm.slice(cwd.length + 1) : norm
  return join(EVIDENCE_SCRATCH_ROOT, rel)
}
