// WO-3009 PRIVATE reference-CAM compare. Manual, local only; never in the
// normal suite or CI (its own config, like alpha3Capture). The store path comes
// only from LIENCAM_REFERENCE_CAM_DIR and must lie outside this working tree;
// the report is written into the store, never into the repository.
//   LIENCAM_REFERENCE_CAM_DIR=<private dir> npx vitest run --config src/tests/benchmark/reference/referenceCompare.vitest.config.mts
// Optional: LIENCAM_REFERENCE_FAMILIES=adaptive_3d,pocket_2d (the default).
import { describe, expect, it } from 'vitest'
import { runReferenceCapture } from './compare'

describe('WO-3009 private reference-CAM compare', () => {
  it('scores every valid store entry with the unchanged collectors and writes the report into the store', async () => {
    const run = await runReferenceCapture()
    if (run.skip !== undefined) { console.log(`[WO-3009] ${run.skip}`); return }
    const { result } = run
    console.log(`[WO-3009] ${result.rows.length} scored, ${result.excluded.length} excluded, ${result.notComparable.length} not comparable, ${result.outOfScope.length} out of scope; report in the store's _reports folder`)
    expect(result.rows.every(row => row.reference.engineId === 'reference')).toBe(true)
  }, 14_400_000)
})
