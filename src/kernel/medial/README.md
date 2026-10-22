# Kernel medial-axis service (WO-3038, alpha.3 A3-07, parity)

One medial-axis service for V-carve and, later, corner work: construction plus declared
filters, re-hosting today's V-carve medial axis. Nothing in the app calls it yet: V-carve
still calls `src/lib/cam/vcarve2d/medialAxis.ts`, which stays as it is (this is a copy, not a
move). MD-112 (dot point plunge) and MD-134 (flat clearing via the entry hierarchy) are OFF;
`policy.ts` holds the parity values and the card (V23) each alternative waits for.

| File | What it holds | Today's original (read-only) |
|---|---|---|
| `parameters.ts` | every number the axis and V-carve's spacing law use, at today's value, each citing file:line | `medialAxis.ts`, `index.ts` sampleSpacing / floor-ring core |
| `construct.ts` | region normalisation, boundary sampling, Delaunay of the samples, inscribed-circle centres with radius refinement, every candidate dual edge | `medialAxis.ts` normalizeRegion, sampleRegion, SegmentGrid, circumcircle, the node / edge loops of medialAxis |
| `filters.ts` | secondary-edge removal, spur pruning (separation peel, length prune), radius trim | `medialAxis.ts` consecutive test, pruneSpurs; `index.ts` splitByRadius |
| `extract.ts` | chains between junctions / leaves, cycles, corner extension to r = 0, dedupe and simplification | `medialAxis.ts` extractPaths, dedupe, simplify |
| `policy.ts` | MD-112 and MD-134 at parity, with the card each waits for | - |
| `service.ts` | `createMedialService()`: `axis` (today's medialAxis), `analyse` (axis + point sites), `graph`, `trimByRadius`, `carveSpacing`, `floorCoreSpacing` | - |
| `vendor/` | the same vendored Delaunator 5.1.0 + robust-predicates 3.0.2 (ISC + Unlicense) | `src/lib/cam/vcarve2d/vendor/` |

Parity proof: `src/tests/kernel/medialParity.wo3038.test.ts` (every call the production V-carve
routes make, replayed through the kernel; the same programs with the kernel substituted) and
`medialUnits.wo3038.test.ts` (each filter on a shape with a known skeleton, policies,
determinism).

A point site (a component whose axis is one point: a disc, a dot) is data only at parity;
today's V-carve decides what, if anything, it cuts there.
