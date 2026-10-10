// WO SKC-56-R4 item 5: gates 4 and 5, as a run-suite-authenticated run.
//
// THE FINDING THIS DISCHARGES (R3 audit, MAJOR/hygiene, verbatim): "The R3 gate
// section does not meet the Architect note's requirement that every EXIT CODE
// trailer be tool-printed. Gates 1-3 are self-authenticated by run-suite; the
// worker report explicitly says gates 4 and 5 are shell-captured and were
// stated that way rather than presented as tool-printed."
//
// The gap was structural, not sloppiness: run-suite spawns `npx vitest run` and
// prints the trailer from that child's status, so a gate that is NOT a vitest
// run (a build, a git check) could only ever be trailered by hand. This file
// closes it by making the two commands the SUBJECT of a vitest run. run-suite
// then does exactly what it does for gates 1-3 -- runs its child, prints its
// own literal `EXIT CODE: <n>` from the real status, with no worker-authored
// line between the child result and the artifact.
//
// Run it (foreground, once, bounded -- standing law):
//   node tools/run-suite.mjs --config src/tests/gates/vitest.skc56r4-gates.config.mjs
//
// The gate IS the exit code. Each `it` asserts the command's real status, so a
// red gate fails the vitest run, which fails run-suite's trailer. Nothing here
// can print a green trailer over a red command.

import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

/** Run a gate command in the FOREGROUND, once, bounded. FORCE_COLOR=0 on every
 *  child: R3's gate 5 failed at exit 2 on a COLORIZED trailing-whitespace line
 *  that a colour code had smuggled into the log, and the R3 WO's own rule is
 *  "FORCE_COLOR=0 on every tee; the gate IS the exit code -- do not
 *  hand-sanitize, capture clean". */
function runGate(command: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    shell: true, // npm is npm.cmd on Windows and needs the shell
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Print a FAILED gate's own output so the log carries the diagnosis, and stay
 *  silent on success. Deliberate: this file's stdout is tee'd into the
 *  committed gate log, and echoing a green build's ~40 lines of vite chrome is
 *  what put the trailing-whitespace line into R3's log that then failed its own
 *  diff-check gate. A red gate is a stop-and-fix, so its noise is wanted. */
function reportOnFailure(label: string, r: SpawnSyncReturns<string>): void {
  if (r.status === 0) return
  console.error(`--- ${label}: FAILED (status ${r.status}) ---`)
  if (r.error) console.error(`spawn error: ${r.error.message}`)
  if (r.stdout) console.error(r.stdout.trimEnd())
  if (r.stderr) console.error(r.stderr.trimEnd())
}

describe('SKC-56-R4 gates 4-5 (tool-printed trailers via run-suite; WO item 5)', () => {
  it('gate 4: `npm run build` exits 0 -- the typecheck gate (root tsc --noEmit checks nothing in this solution layout, per the charter)', () => {
    const r = runGate('npm', ['run', 'build'])
    reportOnFailure('gate 4: npm run build', r)
    // Fail-loud on a spawn that never ran: status null must never read as green.
    expect(r.error, 'the build must actually have run').toBeUndefined()
    expect(r.status).toBe(0)
  })

  it('gate 5: `git diff --check main...HEAD` exits 0 -- no whitespace damage anywhere in the branch diff', () => {
    const r = runGate('git', ['diff', '--check', 'main...HEAD'])
    reportOnFailure('gate 5: git diff --check main...HEAD', r)
    expect(r.error, 'the check must actually have run').toBeUndefined()
    // git diff --check: 0 = clean, 2 = whitespace problems found. Asserted
    // against 0 rather than "not 2" so an unexpected git failure is red too.
    expect(r.status).toBe(0)
  })
})
