# 0036 - Landing gates reject new failures relative to a committed red baseline

Date: 2026-08-08
Status: Accepted

## Context

The runner's landing gate executed only a work order's declared test slice (or
test files changed by the branch when no slice was declared) plus the build.
That fast slice proves the intended corner, but it cannot detect damage in an
unrelated test file.

Three incidents on 2026-08-08 demonstrated the hole:

1. WO-070's manual audit found two branch-added full-suite failures that its
   machine-only slice could not see: overlay-cohesion drift and a stale
   generated overlay artifact.
2. WO-075 passed a green focused gate but moved source lines that made
   `src/tests/evidence/UI-70/OVERLAY-RUNTIME-KEYS.md` stale, reintroducing a
   failure fixed by WO-069.
3. That inherited failure then blocked WO-076 from reaching its required
   focused count even though WO-076 did not cause it.

Main already had known failures owned by WO-065, WO-073, WO-074, and WO-076.
The WO-076 stale-fiber assertion is order/load-sensitive: it passed one
untouched full run and an isolated run, then failed in the implemented gate's
full run. Requiring an absolutely green full suite would therefore stop every
work order and turn the unattended runner into a stalled pipeline.

## Decision

Keep the existing declared/derived focused slice and build unchanged. After
audit and review, at the landing gate only, run one additional full Vitest
sweep with its structured JSON reporter. Compare each failed assertion by
normalized repository-relative file path plus Vitest full test name against
`tools/known-red.json`.

- A failed assertion absent from the committed baseline makes the gate red.
- A failed assertion present in the baseline is ignored for the verdict and
  named in `test-output-broad-gate.txt` with its owner and reason.
- A baseline assertion that passes, or no longer exists in a test file that
  did run, leaves the gate green but prints `BASELINE IS STALE` and tells the
  operator to remove the entry.
- A skipped baseline assertion, a baseline file that did not run, a malformed
  report, a missing or unparseable report, a timeout, a killing signal, or a
  held suite lock is inconclusive. A structured report is malformed unless all
  nine Vitest count fields are non-negative integers, the aggregate test counts
  match the assertions, and every suite and assertion has the shape needed to
  identify it. The runner parks an inconclusive work order as ready-to-land for
  architect review. It neither silently passes nor waits for a retry.
- The runner accepts a red result only when exit 1 carries an explicit parsed
  `no-new-failures: RED` verdict line. Exit 1 without that line is a gate
  malfunction and therefore inconclusive, so a parser crash cannot masquerade
  as a branch-introduced failure.
- There is deliberately NO "runtime error suite" rail (WO-084 correction). The
  first draft of this decision claimed one, guarding on
  `report.numRuntimeErrorTestSuites` - a field Vitest 3.2.7's JSON reporter
  never emits, so that guard was always `undefined > 0` and could not fire.
  Trusting it would have been trusting nothing. The dead guard is deleted and
  no replacement was built on the sweep's exit code, because
  `vite.config.mts` documents that a raw `vitest run` exit code is not
  trustworthy in either direction on this suite; gating on it would inject the
  known birpc infra flake into the landing decision.
- A test-file collection/import failure with no assertion identity is treated
  as a new synthetic file-level failure, so broken modules do not escape the
  comparison. This is the path that actually covers a suite dying before its
  assertions, and it is stronger than the rail it replaces: RED, not parked.

The broad sweep runs once per landing candidate, not per worker attempt. On
main commit `81f3fc1c6944`, the first untouched full suite took 325.829 seconds
and reported 5 failed, 7,686 passed, and 21 skipped (7,712 total). A later full
run also exposed the WO-076 stale-fiber baseline assertion and took 532.523
seconds under concurrent machine load. The accepted wall-clock cost is thus
roughly 5.5 to 9 minutes at landing (325.8 s, 493.98 s and 532.5 s measured);
paying it on every implementation retry would multiply the expensive work
without improving the final verdict. That cost is unchanged by WO-084: the
proof runs the same gate over a temporary two-file root, so it takes about 1.5
seconds per sweep and adds nothing to the real landing path.

The baseline is intentionally committed, reviewable debt. It is not updated
automatically. Adding an entry requires a reviewed code change carrying a
reason and an owning work order.

## Alternatives considered

### Always require an absolutely green full suite

Rejected. Main was already red, so this would stop all landings until unrelated
repair work orders completed. That failure mode violates the runner's
never-stall requirement.

### Always run only the global census tests

Rejected. The three incidents show that the damaged invariant is not reliably
predictable from the work order slice. A hand-maintained global-test list would
repeat the same blind spot under a different name.

### Run changed tests plus a global-invariant list

Rejected. This lowers cost but still cannot catch a source change that drifts a
generated artifact or invariant test outside both lists. The full comparison is
the only closed set available today.

### Recompute the baseline automatically from main

Rejected. An automatic baseline can bless new main failures without review and
can grow invisibly. The committed file makes every accepted red explicit and
makes stale entries visible when repairs land.

## Consequences

Positive:

- A branch cannot land a new Vitest assertion failure merely because it lies
  outside the work order's focused slice.
- Existing main failures do not block unrelated work.
- Repairs announce the exact baseline debt that should be deleted.
- Infrastructure uncertainty parks for human review instead of hanging or
  silently passing.

Negative:

- Every landing candidate paid 5 minutes 26 seconds to 8 minutes 53 seconds in
  the measured runs and writes a structured temporary report.
- Test identity renames require baseline maintenance.
- Assertion identity is only as stable as the test's file path and full name.

## Proof

Every claim above is pinned by committed tests that drive the real mechanism,
not a pure decision helper (WO-089; COHESION-STANDARD section 10):

- `src/tests/tools/noNewFailuresGate.e2e.test.ts` runs
  `tools/test-gate.mjs --no-new-failures` as a process against a temporary root
  built by `src/tests/tools/gateFixture.ts`, and asserts exit 1 with the named
  new failure, exit 0 once that failure is blessed, exit 1 for a file that dies
  during collection, `BASELINE IS STALE` for a repaired entry, and exit 2 for an
  unreadable baseline. It then calls `processWorkOrder`, the production entry
  point, and observes the work order move to `failed`, escalation fire,
  `landBranch` remain uncalled, and the early-return value come back. The same
  file proves that empty stale branches proceed while stale branches carrying
  commits park without deletion.
- `src/tests/tools/noNewFailuresComparator.test.ts` pins the verdict table,
  validates every emitted count field and suite shape, covers a missing suite
  name without throwing, and censuses a real Vitest 3.2.7 JSON report.

## References

- `tools/test-gate.mjs`
- `tools/runner.mjs`
- `tools/known-red.json`
- `src/tests/tools/`
- `queue/WO-078-no-new-failures-gate.md`
- `queue/WO-084-no-new-failures-gate-proven.md`
