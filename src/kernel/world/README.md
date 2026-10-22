# Kernel world model (WO-3008, alpha.3 A3-08 P2 parity slice)

A headless kernel service: the stock record, stock kinds, placement, loop typing
and the machine record. It imports only kernel files and the pure modules the
WO-2904 boundary allows (`src/types`, `src/lib/geometry/coordinateFrames`).
Nothing in the app calls it: the engine selector stays `current`, and the app
keeps `getStockBoundsFromViewport` (src/store/index.ts) until a later order
switches it.

| Query | File | At parity with today's |
|---|---|---|
| `stockBounds(record, setup)`, `stockKind`, `stockBottomWcsZ`, `stockFootprint` | stock.ts | the viewport's `getStockBounds(setup.wcs.stockId)` (box per id, union fallback) |
| `membership(geo, stocks)`, `isStockMember`, `cuttingStockId`, `membershipState` | stock.ts | `src/store/stockAssignment.ts` (assignment, derived members, compute owner) |
| `geometryWorldAabb` | stock.ts | `src/store/dispatchGeo.ts` `geometryWorldBounds` |
| `partPlacement`, `stlRecentreShift`, `rotatedPartDecision` | placement.ts | Model Item placement, the five STL recentring copies, the six 3D routes' X/Y refusals |
| `typeLoops`, `nestingDepths`, `loopTypingDiff` | loops.ts | each entry path's own outer/hole type |
| `machineRecord(profile)` | machine.ts | `docs/machine/profiles/*.machine.json` |

Policies: `PARITY_POLICY` = `rotated_part_placement` (MD-43) and
`loop_type_from_nesting` (MD-44), both OFF until card V07 is approved.

A reserved stock kind (mesh, cylinder, cast) plans from its bounding box and
says so in one line (`NON_BOX_STOCK_LINE`). Material carried into the next setup
is an interface slot only (`carriedMaterial`, A3-10). What material is left before
an operation is WO-2953's question, never this service's.

Proof: `src/tests/kernel/world*.wo3008.test.ts`, evidence in
`src/tests/evidence/WO-3008/` (repository-record.md, parity.json,
record-vs-viewport.json, benchmark-before-after.json, feature-proof.json).
