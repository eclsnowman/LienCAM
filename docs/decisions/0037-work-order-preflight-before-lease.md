# 0037 - Work orders pass preflight before lease

Date: 2026-08-08
Status: Accepted

## Context

Three preventable work-order defects consumed worker cycles on 2026-08-08:

- WO-072 demanded a green test slice that was already red for an unrelated
  reason on main.
- WO-078 cited 294 assertions that could not reach any changed line.
- Three queued work orders named failed or dead gates and could therefore
  never become eligible under the dispatcher's old gate filter.

A checklist in an architect document was not enough. These facts are mostly
mechanical and must be checked before the queued-to-leased transition, while
the architect can still repair the request without blaming a worker attempt.

## Decision

`tools/wo-preflight.mjs` runs once per lease candidate, before the runner
changes its state to `leased`:

1. If `test-slice` is non-empty, run it against the runner's current main
   checkout with Vitest's JSON reporter. A first red causes the named failing
   files to run once more in isolation. Only the same assertion
   failing in both runs makes preflight REFUSE. A failure that does not repeat
   WARNs as order-dependent evidence. `tools/known-red.json` supplies the owner
   named in a refusal, but does not make a repeatedly red slice satisfiable or
   leaseable. Every failure is reported by repository-relative file plus full
   test name.
2. Compare `test-slice` and `owned-paths` using direct path overlap or a shared
   meaningful path segment after generic segments such as `src`, `tests`,
   `lib`, and `components` are removed. No plausible pair makes preflight WARN,
   never REFUSE.
3. Parse `gate` through one helper shared by dispatcher and preflight. REFUSE
   when the target is missing or terminal (`failed`, `retired`, `dead`, or
   `superseded`), and name successors whose `sliced-from` begins with that
   gate id. Landed/done gates are satisfied; live pending gates keep waiting.

A REFUSE moves the candidate from `queued` to the existing `held` state and
creates an architect-owned escalation containing the exact reasons. WARN and
PASS remain leaseable. The dispatcher sends candidates with missing or
terminal gates to the runner instead of silently filtering them forever; live
pending gates still wait and landed/done gates proceed normally.

Preflight is fail-open for its own errors. A spawn failure, malformed report,
or unexpected exception is logged loudly, but the candidate remains eligible.
This does not lower an acceptance criterion: it prevents optional guard
machinery from becoming a new unattended-pipeline stop. The normal worker,
audit, review, focused test, build, and landing gates remain unchanged.

The reachability heuristic is deliberately weak. Shared path words can produce
false confidence, and aliases, generated tests, dynamic imports, or unusually
located tests can produce false warnings. It is evidence for architect review,
not proof of runtime coverage, which is why it cannot hard-refuse a lease.

## Alternatives considered

### Keep the six-item human checklist only

Rejected. Each automated condition had already been missed during a busy day.
The request is cheapest to repair before dispatch.

### Hard-refuse a slice that the path heuristic cannot connect

Rejected. Static path names cannot prove reachability. A false refusal would
stall legitimate work and violate the pipeline liveness rule.

### Let the dispatcher keep filtering all unlanded gates

Rejected. A failed or dead target will never become landed, so its dependents
would remain silently queued forever and preflight would never see them.

### Fail closed when preflight itself crashes

Rejected. The worker and landing gates still enforce acceptance. Turning a
diagnostic guard outage into a fleet outage is the exact failure mode the
unattended runner must avoid.

## Consequences

- Impossible green-slice acceptance and dead gates consume no worker attempt.
- A one-shot order-dependent red cannot turn into an irreversible hold, while
  every repeatedly failing assertion refuses the lease.
- `tools/known-red.json` provides ownership and routing evidence for an existing
  failure; it does not override unsatisfiable green acceptance in a WO spec.
- Irrelevant slices are visible before work begins without risking a false
  mechanical refusal.
- Test-slice execution adds one focused Vitest run per lease and, only after a
  first red, one isolated confirmation of its named failing files. It never
  runs per worker attempt and is skipped entirely for an empty slice.
- Preflight failures remain observable while the pipeline keeps moving.
- The committed fixtures under `src/tests/tools/fixtures/` preserve both the
  defect and healthy direction for every check.

## References

- `tools/wo-preflight.mjs`
- `tools/runner.mjs`
- `tools/dispatcher.mjs`
- `src/tests/tools/woPreflight.test.ts`
- `queue/WO-088-wo-preflight-check.md`
