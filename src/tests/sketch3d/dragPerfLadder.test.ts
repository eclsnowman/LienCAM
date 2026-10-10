// Measured perf ladder (criterion 5). Entity count drives solve time, so the numbers here
// are environment-dependent by design - this test asserts sane, non-flaky invariants (solves
// complete, durations are finite/positive) and LOGS the honest median/p95 for the report. It
// does not hard-fail on missing the 16ms/100-entity target: the throttle policy (proven
// separately in dragThrottle.test.ts with synthetic timing) is what keeps the interactive
// loop live on slower machines, and the WO explicitly wants a miss reported, not hidden.
import { describe, expect, it } from 'vitest'
import { Sketch3dDragSession, createSketch3dSolveService } from '../../sketch3d'
import { chainDragFixture } from './dragFixtures'

const ENTITY_COUNTS = [25, 50, 100, 150]
const WARMUP_MOVES = 5
const MEASURED_MOVES = 60

function percentile(sortedMs: number[], p: number): number {
  const index = Math.min(sortedMs.length - 1, Math.floor((sortedMs.length - 1) * p))
  return sortedMs[index]
}

async function measureLadder(entityCount: number): Promise<{ median: number; p95: number; samples: number }> {
  // Each tier gets its own service, disposed immediately after measuring: the wasm heap is a
  // fixed 16 MB (SKC-1 finding) and a long-lived service repeatedly re-pushing a 100+-entity
  // primitive set via clear_data()+push_primitives_and_params() every move was measured to
  // exhaust it well before 4 tiers x 65 moves could complete undisposed.
  const service = await createSketch3dSolveService()
  try {
    const { document, dragPoint } = chainDragFixture(entityCount)
    // frameBudgetMs: Infinity - this measurement must never throttle/coalesce, so every move()
    // actually solves and every duration is a real sample (throttle behavior is a separate,
    // already-covered concern in dragThrottle.test.ts).
    const session = new Sketch3dDragSession(service, document, { frameBudgetMs: Number.POSITIVE_INFINITY })
    session.begin(dragPoint, { x: 0, y: 0 })

    for (let i = 0; i < WARMUP_MOVES; i++) {
      session.move({ x: i, y: i * 0.5 })
    }

    const durations: number[] = []
    for (let i = 0; i < MEASURED_MOVES; i++) {
      const result = session.move({ x: (i % 20) - 10, y: ((i * 7) % 20) - 10 })
      expect(result.status, result.error ?? '').not.toBe('failed')
      expect(result.solveMs).not.toBeNull()
      durations.push(result.solveMs as number)
    }
    session.end()

    durations.sort((a, b) => a - b)
    return {
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      samples: durations.length,
    }
  } finally {
    // Observed (2026-07-08, reproducible): disposing a service that has run ~65 solves at
    // 100+ entities sometimes prints an "Aborted(OOM)" line to stderr from inside
    // destroy_gcs_module() itself. Verified across repeated runs that this never correlates
    // with a solve returning status 'failed', never affects a later tier's results, and the
    // process does not exit - so it reads as an internal allocator diagnostic during teardown,
    // not the fatal OOM described in SKC-1's disposalSoak calibration note. Left as an honest,
    // non-blocking observation for a future session with wasm-build visibility to explain.
    service.dispose()
  }
}

describe('sketch3d drag solve perf ladder (criterion 5)', () => {
  it('measures median/p95 solve-per-move across the entity-count ladder', async () => {
    const measured: Record<number, { median: number; p95: number; samples: number }> = {}
    for (const entityCount of ENTITY_COUNTS) {
      measured[entityCount] = await measureLadder(entityCount)
    }

    for (const entityCount of ENTITY_COUNTS) {
      const { median, p95, samples } = measured[entityCount]
      expect(samples).toBe(MEASURED_MOVES)
      expect(median).toBeGreaterThan(0)
      expect(p95).toBeGreaterThanOrEqual(median)
    }

    // eslint-disable-next-line no-console
    console.log(
      'SKC-2_PERF_LADDER ' +
        JSON.stringify(
          ENTITY_COUNTS.map((entityCount) => ({
            entities: entityCount,
            medianMs: Number(measured[entityCount].median.toFixed(3)),
            p95Ms: Number(measured[entityCount].p95.toFixed(3)),
          })),
        ),
    )
  }, 60000)
})
