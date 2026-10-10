// WO SKC-56-R4 item 5 (the R3 audit's MAJOR): EVERY trailer in the committed
// gate log must be TOOL-PRINTED by run-suite, "including config-based runs
// (gates 4/5 class)". A worker-authored trailer is an evidence FAIL regardless
// of outcome -- and R3's gates 4 (npm run build) and 5 (git diff --check) were
// shell-captured with hand-written trailers, because run-suite only ever
// spawns `npx vitest run` and neither gate is a vitest run.
//
// This config is how those two gates become run-suite output without touching
// the shared fleet tool (tools/run-suite.mjs is outside this WO's ownership
// manifest): the gate COMMANDS are executed by a vitest file, so run-suite
// runs vitest as it always does and prints its own literal `EXIT CODE: <n>`
// trailer, atomically, from the child's real status.
//
//   node tools/run-suite.mjs --config src/tests/gates/vitest.skc56r4-gates.config.mjs
//
// Why a SEPARATE config rather than an ordinary test: the root config's include
// is ['src/tests/**/*.test.ts', 'src/tests/**/*.test.tsx'], and a gate that
// shells out to a full `npm run build` must never be dragged into an ordinary
// slice run or the Architect's repo-wide campaign. The `.gate.mts` suffix
// matches neither root pattern, so this file is the ONLY way to run it --
// the same isolation the committed tools/tests/vitest.bk146.config.mjs
// precedent uses.
export default {
  test: {
    include: ['src/tests/gates/skc56r4Gates.gate.mts'],
    // A cold `npm run build` is ~30-60s; the default 5s timeout would fail the
    // gate on the clock rather than on the build.
    hookTimeout: 900_000,
    testTimeout: 900_000,
    // The gates shell out to real processes and must not overlap.
    fileParallelism: false,
  },
}
