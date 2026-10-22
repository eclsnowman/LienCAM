# Kernel entry and leads service (WO-3031, alpha.3 A3-13, parity)

One entry surface for both lanes: the one helix builder, the one ramp builder, one lead
library, the entry ladder, and today's gates as rule data. Nothing in the app calls it yet:
the engine selector stays `current`, and a family switches over in P6. Every policy the operator
named (A-29 slow plunge for rated tools, A-30 working defaults, A-34 owned-tool / approach
search) and the MD-68 / MD-70 cards are OFF; `policy.ts` holds the parity values.

| File | What it holds | Today's original (read-only) |
|---|---|---|
| `helix.ts` | `buildHelix`: one builder, each family's pitch (entry angle, or Bore / Thread Mill's own) and sampling recipe; today's call shapes `helixDescent`, `threadHelix`, `helixArcs` route through it | `src/lib/cam/moves/index.ts` helixDescent, `src/lib/cam/threadHelix.ts` generateThreadHelix / generateHelixArcs, `src/cam3d/rough/emit.ts` emitHelix |
| `ramp.ts` | `rampDescent`, `rampTo` | `src/lib/cam/moves/index.ts` |
| `leads.ts` | straight, polyline, arc (tangent semicircle, G2/G3), ramp and helix leads; reading a lead run's kind | `threadHelix.ts` generateLeadArc; the families' inline leads |
| `gates.ts` | today's gates (helix floors, 5 % straight-descent allowance, bore orbit floor, backoff, sampling) and entry conventions, each citing its code | the cited constants |
| `ladder.ts` | rungs helix -> ramp -> open -> pre-drilled -> rated plunge -> declared rest; the rated-plunge gate; the declared-rest record type | - |
| `classify.ts` | reading a program's entries: helix, ramp, plunge, open | - |
| `mapping.ts` | parity table: each family x linking entry type -> today's entry classes, helix form, pitch, floor, no-fit behaviour, leads, lead fields | each family's entry code (cited per row) |
| `policy.ts` | the six entry policies at parity and the card each alternative waits for | - |
| `service.ts` | `createEntryService()` | - |

Parity proof: `src/tests/kernel/entryParity.wo3031.test.ts` (production runs, recorded calls
replayed through the kernel) and `entryUnits.wo3031.test.ts`.

Not here at parity: the stock reads that decide where an entry starts (Adaptive 3D's
`stockAwareRampStart` and the straight-descent stock verdict) stay in `src/cam3d/rough/emit.ts`
until the material service carries them; `gates.ts` holds their numbers and rule. Pocket's
curve walk and Contour's tab-clamped ramp keep their own walks over the one ramp builder.
