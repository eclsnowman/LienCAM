# WO-3009 synthetic reference-CAM fixtures

Hand-written programs for the reference-CAM harness tests
(`src/tests/benchmark/referenceImport.wo3009.test.ts`). None of them came from
any CAM program; real reference output lives only in the private store named by
`LIENCAM_REFERENCE_CAM_DIR`, outside this repository.

| file | what it pins |
|---|---|
| `inch-square.nc` | G20: every coordinate, arc centre and feed imports x 25.4 |
| `one-air-move.nc` | one fed move through cleared air: M-AIR-1 = 36 mm by hand |
| `words.nc` | the ignored-word report: N, G54, T1, M6, S (settings), M3, G43, H, M8, G4, P, M5, M30 |
| `canned-cycle.nc` | G81 changes motion and is not interpreted: the row is "n/a: unparsed motion word G81" |
| `rotary.nc` | an A word: "n/a: unparsed motion word A" |
| `boss-skim.nc` | a small valid program for the stepped-boss rough row (store round trip) |
