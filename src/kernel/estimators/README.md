# Kernel cheap estimators (WO-3034, alpha.3 A3-21)

Fast, read-only estimates for any kernel operation's planned moves, cheap enough
to compare many candidate plans. Nothing in the app calls them: no motion, G-code,
stop or refusal changes, nothing the operator sees. An estimate that cannot be
made says so in its own status (`available` / `degraded` + reason /
`unavailable` + reason); the operation is never affected.

| Estimate | File | Model | Checked against the stick |
|---|---|---|---|
| Cycle time | cycleTime.ts, time/ | re-hosted copy of today's `estimateRuntimeMs` + achievable-feed planner + UCCNC linear unification + arc sampling + `machineCutTimeMotion` (draft: "re-hosted as copies"). No XYZ acceleration: `degraded`, distance over feed (today's rule). A feed-less move: `unavailable` with today's reason | identical to the store's `estimatedCutTimeMs` (M-TIME-1, BM-EST-time) |
| Cusp (scallop) | cusp.ts | the one relation h = r - sqrt(r^2 - (s/2)^2) (alpha3-17 A.4.1); r = ball radius, or a bull nose's corner radius on the spacing past its flat; s = 3D distance from each r-long piece of finishing path to the nearest piece of another pass lying across it on each side, within 60 deg of square (spatial hash). Flat end mill: `unavailable` (Q-81). `estimateCuspFromStepover` is the pre-plan flat-floor value. The mean is the promised figure; the max is returned with `maxStatus: 'unvalidated'` until it is checked against a dense geometric reference | M-GEOM-2.mean (M-GEOM-2 recorded) |
| Radial engagement | engagement.ts | replay of the moves through the kernel material sweep (WO-3017 `sweepMove`) at a declared cell (the engine's replay-cell rule: D/8, never finer than a third of the stock cell), sustained 2 mm window of fresh volume over the full-slot section; no stock: `degraded` stepover / D, "programmed, not measured" | peak / p95 engagement collector |
| Deflection proxy | deflection.ts | interface and status only: `unavailable` until an accepted external source supplies the form (REQ-EST-6, MD-96) | none (the stick has no deflection metric) |

`estimateOperation` runs all four and returns the set plus each estimator's wall
time beside it (timing never enters the set, so two runs give equal sets).

Inputs are the moves, the tool's kernel sweep shape (`sweepShape` from
src/kernel/material), the machine profile (the shape `machineRecord` is built
from: today's time model also reads per-axis max velocity, the stop angle and
UCCNC unification, which the world record does not carry), the operation's
resolved speeds (today `resolveFeedrates`; the kernel feed service WO-3033 is in
flight) and the stock box.

Proof: `src/tests/kernel/estimators.wo3034.test.ts` (analytic fixtures),
`src/tests/kernel/estimatorsVsStick.wo3034.test.ts` (live app row, live stick
collectors on committed A.5 moves, and the committed every-row comparison).
Evidence and the long capture: `src/tests/evidence/WO-3034/`.
