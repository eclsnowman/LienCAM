import './trackedEvidenceWrites'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect } from 'vitest'
import { assertTrackedStateUnchanged, trackedState } from '../helpers/trackedFileGuard'

// WO-2733: install before collection, then check after suite teardown (Vitest
// runs afterAll hooks in reverse registration order). Covers module-level and
// teardown writers, including future tools tests without a per-file opt-in.
// Public source exports have no Git metadata. Explicit evidence recording is
// still supported by WO-1902's existing WRITE_EVIDENCE convention.
const root = process.cwd()
const testPath = expect.getState().testPath?.replaceAll('\\', '/') ?? ''
if (testPath.includes('/src/tests/tools/') && existsSync(join(root, '.git')) && process.env.WRITE_EVIDENCE !== '1') {
  const before = trackedState(root)
  afterAll(() => assertTrackedStateUnchanged(root, before))
}
