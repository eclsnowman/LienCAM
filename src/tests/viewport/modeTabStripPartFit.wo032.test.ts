// RETIRED by WO-047 (kept as a pointer, not silently deleted).
//
// WO-032's contract (queue/WO-032-strip-fit-contract.md) pinned, as RENDERED
// GEOMETRY in a real layout engine, that the FLOATING part-workspace mode-tab
// strip never overlapped the workbench side panels at any width from 960 up.
// That box no longer exists: WO-047 (the Operator-approved WO-036 header design)
// moved the mode tabs natively into the top header for every workspace and
// deleted the floating strip, its portal hosts, and the WO-025/WO-032
// part-span fit CSS the contract guarded. A geometry contract for a removed
// box has nothing left to measure, so the suite is retired rather than kept
// green against a skeleton the app can no longer render.
//
// Where the coverage went:
//   - The strip's new location, order and behavior are pinned by
//     src/tests/viewport/headerModeTabs.wo047.test.tsx and
//     src/tests/viewport/modeTabStripLocation.test.ts (which also asserts the
//     floating mechanism stays gone).
//   - Header width pressure is handled by the <=1500px icon-only rule on the
//     right-side utilities (asserted in modeTabStripLocation.test.ts); the
//     header is a normal flex row, not an absolutely positioned box, so the
//     escape-the-anchors failure class WO-032 existed to catch cannot recur.
//
// The retired suite's last green form is in git history at this path
// (pre-WO-047), alongside its full-real-app probe
// src/tests/evidence/WO-032/probe.mjs.

import { describe, it } from 'vitest'

describe('WO-032 part strip fit contract (RETIRED by WO-047)', () => {
  it.skip('superseded: the floating part strip was removed; see header comment for pointers', () => {})
})
