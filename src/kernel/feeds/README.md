# Kernel feed/speed service (WO-3033, alpha.3 A3-15, parity)

One service answers "what F and S does this operation post?" for both lanes. Nothing in
the app calls it yet: the engine selector stays `current`. Both carded policies (MD-75,
MD-77) are off; with the parity ruleset and policy every number equals today's.

| File | What it holds | Today's original (read-only) |
|---|---|---|
| `contracts.ts` | rule key (role x material x tool type x diameter interval x coating x rigidity), rule, rate stage, ruleset, cutting-data selection, provenance | - |
| `ruleData.ts` | `PARITY_RULESET` v1.0.0: the seven rate stages (override, tool entry, fallback) and one open feed row per WO-3026 role; `validateRuleset` (every row sourced, with units) | `src/lib/cam/feedrates.ts` resolveFeedrates; `src/kernel/linking/roles.ts` ROLE_FEED_TABLE |
| `select.ts` | `selectCuttingData` (one entry for feed and spindle), `matchRule` (most specific row, earlier on a tie), `roleFeed` (no row: today's role rate, "tool library, no rule") | `src/lib/post/resolve.ts` pickFeeds |
| `policy.ts` | `PARITY_FEED_POLICY`: MD-75 material entry and MD-77 chip thinning, both off | - |
| `thinning.ts` | radial chip-thinning relation (A.4.1: ae 0.10 D -> Kr 0.60), used only under MD-77 | settings collector `radialFactor` (WO-2900) |
| `service.ts` | `createFeedSpeedService()` (rates, requested and clamped rpm, role rows, provenance, one-line reports) and `feedForMove` (the F a move posts with) | resolveFeedrates, applyResolvedMoveFeed, requestedSpindleRpm, resolveSpindle |

RC-019 at parity: today the spindle reads the tool's `default` entry, else its first entry,
while the feed reads `default` only (a tool without one feeds at 300 / 100 mm/min). The
service makes one selection and keeps that split as the parity behaviour; MD-75 removes it
(and puts the operation's material key first) once the operator approves its before/after card.

Where today warns on the console (a missing feed) or clamps (rpm outside the machine), the
service proceeds the same and says so in `reports`, one line each. It adds no refusal.

Parity proof: `src/tests/kernel/feedsParity.wo3033.test.ts` (today's live resolver vs the
kernel on a generated grid and on every A.5 row's production-route record) and
`feedsUnits.wo3033.test.ts`.
