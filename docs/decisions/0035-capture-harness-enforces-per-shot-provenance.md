# 0035 - Capture harness enforces per-shot provenance

Date: 2026-08-08
Status: Accepted

## Context

Screenshot evidence has repeatedly been made against an unproven live page.
WO-061 captured a stale build from another checkout on the shared default Vite
port. WO-066 and WO-067 established the corrective pattern: start the branch's
own strict-port server, delete stale output, and prove branch-specific behavior
on the live page immediately before every shot. WO-085 audit A7 found the same
class again, and WO-063 added a fifth failure mode by committing two distinct
surface names whose PNG bytes were identical.

WO prose did not make these rules reliable. Four work orders - WO-061, WO-066,
WO-067, and WO-085 - paid directly for the provenance lesson, while WO-063 paid
for the adjacent duplicate-frame lesson.

## Decision

The reusable module at `tools/capture/lib/provenance.mjs` owns screenshot
validity:

1. `withViteCaptureServer` requires a caller-supplied dedicated port, launches
   this checkout's Vite entry with `--strictPort`, waits for it to answer, and
   tears down the process tree in `finally`, including via `taskkill /T /F` on
   Windows.
2. `captureProvenancedScreenshot` is the screenshot write boundary. For every
   shot it deletes the destination, requires and evaluates a caller predicate
   against the live page, writes only after an exact `true`, then verifies a
   non-trivial file.
3. A missing, throwing, or false predicate is a hard failure. There is no
   default predicate, warning-only mode, or opt-out. The work order that owns a
   capture owns the branch-specific live-page fact that proves provenance.
4. The module hashes every accepted PNG in the Node process. If a later shot is
   byte-identical, it names both files, deletes the later file, and throws. A WO
   may deliberately disclose identical surfaces, but it cannot present them as
   two successful harness captures.
5. Failed size, write, and duplicate validations remove the candidate file so a
   thrown run cannot leave invalid evidence behind.
6. Every accepted shot records both repository commit identity and live source
   identity. The live identity includes the scoped dirty state, included and
   excluded paths, file count, and a SHA-256 digest over each relative path and
   its current bytes. This makes source substitution under one unchanged HEAD
   observable instead of silently attributing two revisions to one identity.
7. The default live-source scope is `src/` excluding `src/tests/`. Callers may
   explicitly widen or narrow the scope. The record names the exact scope, so
   the default does not claim to cover `public/`, Vite or build configuration,
   package manifests, capture scripts, or installed dependency bytes.

`tools/capture/shoot.mjs` uses these boundaries and therefore requires both a
dedicated port and a predicate module when invoked as a CLI.

## Alternatives considered

- Keep the requirements in each WO. Rejected: the same failure recurred after
  the rule was documented.
- Infer provenance from a default selector or the server URL. Rejected: only
  the owning WO knows which branch-specific live behavior distinguishes its
  build. A generic check can prove that some app answered, not that the right
  code answered.
- Warn on a missing predicate and continue. Rejected: skippable provenance is
  equivalent to no provenance.
- Permit identical images and leave review to notice matching sizes. Rejected:
  WO-063 printed equal byte counts without catching the duplicate frame.
- Use commit identity alone. Rejected: a capture can temporarily substitute
  live source bytes while HEAD remains unchanged, which is the failure WO-126
  must make falsifiable.
- Refuse every dirty source tree. Rejected: deliberate before/after capture may
  use controlled source substitution; the harness must identify that state,
  not hide it or make the workflow impossible.
- Hash the entire checkout by default. Rejected: generated evidence and test
  output would make unchanged product source appear different. Wider claims
  require an explicit caller-selected scope.

## Consequences

- New reusable captures must provide an executable provenance predicate for
  every shot and a collision-free dedicated port.
- A capture process cannot silently retain stale, undersized, missing, or later
  duplicate output.
- Existing one-off evidence scripts remain reproducible artifacts. They can be
  migrated to the shared boundary in their owning follow-up work rather than
  weakening the new contract.
- Legitimately identical surfaces require deliberate WO disclosure instead of
  two nominally distinct successful captures.
- Two captures of unchanged bytes in the recorded scope produce the same live
  source identity. Different bytes under the same HEAD produce different
  identities. Neither result makes a claim about paths outside that recorded
  scope.

## References

- `tools/capture/lib/provenance.mjs`
- `tools/capture/shoot.mjs`
- `src/tests/tools/captureProvenance.test.ts`
- `src/tests/tools/capture-proof/bite-proof.mjs`
- WO-061, WO-063, WO-066, WO-067, WO-085, WO-092, and WO-126
