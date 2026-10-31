// The owner's own parts that must never be committed (third-party models) live in the main checkout's
// ignored archive/fixtures/. Found from git's common directory, so a lane under archive/active-work
// reads the same copy and the path follows the checkout wherever it moves. Absent (Spark, CI, a fresh
// clone) -> a path that does not exist, and the tests that need the part skip.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function privateFixture(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: here, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return join(dirname(common), 'archive', 'fixtures', name)
  } catch {
    return join(here, '..', '..', '..', 'archive', 'fixtures', name)
  }
}
