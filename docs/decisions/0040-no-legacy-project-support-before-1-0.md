# 0040 - No legacy project support before 1.0

Date: 2026-08-17
Status: Accepted

## Context

LienCAM is pre-release. Its `.camproject` format has moved through at least
nineteen schema versions, and the codebase already carries a dozen migration
functions (`migrateHeightIntentSemantics`,
`migrateAdaptiveClearingAuthoredSemantics`, `migrateHierarchy`, and others)
written on the assumption that a saved file must keep working.

On 2026-08-15 commit `2e5678b7` finished the Smart Height V2-only cutover. It
made a missing or legacy height authority a hard refusal in add, preview,
compute, and post (`src/lib/cam/smartHeights/authority.ts`), required
`resolvedHeightPlan.version === 2` and `resolvedHeights.version === 1` in
`operationGenerationIsCurrent`, and bumped `CAM_GENERATION_CONTRACT_VERSION`
from 1 to 2 - which invalidates every previously stored generation
fingerprint.

The full-suite baseline captured on 2026-08-17 showed 435 failing tests, of
which roughly 275 trace to that single cutover. Three independent agent
reviews reached the same archaeology and then split on what it meant. Each one
spent significant effort on the same unanswered question: does a project saved
before the cutover still have to work? All three tracked `Example Projects/`
files (schema 4, 13 and 18) carry zero Smart Height V2 authority and would be
refused.

That question had already been settled by the operator with Codex, but it was not
written down anywhere an agent could read it, so it was re-litigated three
times in one day.

## Decision

**Until the operator says otherwise, or LienCAM ships a public release, no old project
file needs to keep working.** There is no legacy.

- A breaking format or contract change does not require a migration.
- A project file used as a test fixture is updated or regenerated, not
  migrated. Fixtures serve the tests; the tests do not serve the fixtures.
- The sample projects under `Example Projects/` are test items under this rule
  like any other. When a change breaks them, re-author or regenerate them.
- Tests that fail only because they construct pre-cutover shapes are STALE
  TESTS. Update them to the current contract.

This does not license silent breakage. A change that invalidates saved files
still says so plainly in its work order and in STATUS.md, so the reason is
recoverable later. It licenses *not building migration machinery* for a
product with no released users.

## Consequences

- The ~275 Smart Height V2 failures are fixture work, not a product defect.
  Stamp a valid `smart_v2` envelope, `resolvedHeightPlan` v2, `resolvedHeights`
  v1, and a current fingerprint, rather than writing a synthesizing migration.
- The existing `migrate*` functions stay where they are - removing them is
  unrelated work and they cost nothing - but no NEW migration is written for a
  pre-1.0 format break.
- Reviews must stop treating "this breaks saved projects" as a blocking
  finding on its own. It is a NOTE. It becomes a finding again the moment a
  public release exists, and this ADR is what must be revisited then.
- Any agent that reaches this question should read this file and proceed, not
  escalate. That is the entire reason it exists.

## Alternatives considered

**Write a Smart Height migration.** Rejected. It would have to synthesize an
authority envelope, a height plan, resolved heights, and fresh fingerprints
from legacy fields across three schema generations. Height data drives tool Z
on a CNC machine, so a subtly wrong synthesis is a crash, not a cosmetic bug -
and it would have been built to protect files that nobody but the operator has, in a
product he is still deliberately breaking.
