# Kernel linking service (WO-3026, alpha.3 A3-12, parity)

One link planner surface for both lanes. Nothing in the app calls it yet: the engine
selector stays `current`, and a family switches over in P6. Every carded policy
(MD-60..MD-66) is off; `policy.ts` admits only the parity values.

| File | What it holds | Today's original (read-only) |
|---|---|---|
| `primitives.ts` | approach / retract primitives: Clearance -> Retract -> Feed approach, feed plunge, retract, WO-2835 floor hop | `src/lib/cam/moves/index.ts` |
| `finishLinker3d.ts` | 3D raster finishing linker (Parallel, Scallop, Pencil, shallow half) and its corridor keep-down proof | `src/cam3d/pathbuild/index.ts` |
| `waterlineLinker.ts` | waterline's own linker (steep half too) | `src/cam3d/strategies/waterline/link.ts` |
| `roles.ts` | the 12-role vocabulary, one feed row per role, the 3D lane's 8 IR roles mapped as today | `src/types` MoveRole, `feedrates.ts`, `cam3d/ir/toToolpathMoves.ts` |
| `standoffs.ts` | the five local standoff constants as one table at today's values | pathbuild, adaptive3dOperation, drill2d, adaptiveClearing2d processFeature, traverseSafety |
| `cases.ts` | link spans, link case (short gap, long gap, level change, between regions), link outcome | - |
| `mapping.ts` | parity policy table: retract / transition fields x case -> each family's link outcomes today | each family's link code (cited per row) |
| `policy.ts` | the seven linking policies, all at parity, and the card each alternative waits for | - |
| `service.ts` | `createLinkingService()` | - |

Parity proof: `src/tests/kernel/linkingParity.wo3026.test.ts` (production runs, recorded
calls replayed through the kernel copies) and `linkingUnits.wo3026.test.ts`.

Not here at parity: the 2.5D families' inline approach variants and in-engine link
decisions (Pocket, Face, Adaptive 2D, Thread Mill, Drill, Bore), the Adaptive 3D rough
linker and traverse safety, and the rest-aware passes (`restAir2d.ts`,
`finishLinksOverRemovedStock.ts`, `airFeedOverRemovedStock.ts`). They need the material
service (WO-3017) for their stock queries; the table records which code decides each
family's links until they move.
