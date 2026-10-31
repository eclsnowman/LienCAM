# LienCAM Conventions

Public contributors: follow [CONTRIBUTING](../CONTRIBUTING.md) and run
`npm run test:public`. This document also records private development practices;
private-only tools and documents named below do not ship in the public repository.

This document describes how we work on LienCAM: engineering principles,
workflow patterns, code and commit conventions, testing discipline, and
the patterns for AI-assisted development that have proven effective for
this project.

docs/ARCHITECTURE.md describes what the system is. This document describes
how we work on it. The two are complementary: docs/ARCHITECTURE.md is the
target, this document is the discipline that gets us there.

## Engineering principles

These principles apply across all work on the project. They are not
rules — they are heuristics for resolving design tension.

### 0. The user-facing bar: needs matched or exceeded, or it is a miss

the operator's standing directive (2026-08-03, verbatim intent): for anything
user-facing, judge the work against the USER's needs, not against its own
correctness. If their needs are not matched or exceeded by what we
provided, it is a miss — no matter how clean the tests. Account for the
user's real limitations in visibility (can they SEE it — size, contrast,
affordance), knowledge (nothing assumed), and experience (their actual
workflow). The work should be enjoyable, informative, and bring utility
and joy in the execution of their work. Lofty, worthwhile, and binding:
before calling any user-facing deliverable done, walk it as the
least-equipped user and fix what fails that walk at the source.

Origin example: help images shipped technically perfect (captured,
blind-reviewed, tested) but rendered tiny with no way to enlarge —
"less than useless" to the person they were made for.

### 0b. A capability is not present until something CONSUMES it

**This project's signature defect, and on 2026-09-08 it reached five recorded
instances in one day.** Every one of that day's worst findings was this shape,
and it is the only finding that would have prevented the other four.

The pattern: a capability is provisioned, computed, displayed, or solved on one
path - and nothing consumes it, or a sibling path was never given it. Each half
looks finished. Each passes its own tests. The defect lives in the gap between
them, and **nothing tests a gap.**

The five, so the shape is unmistakable:

1. **WO-1019** built the geometry door and left it with no caller. Its own
   comment named the disease: *"a capability that reports as present and has no
   door."*
2. **WO-1267** gave that door a handle and did not carry across the post's
   CAM-12 guard, so the new route could arm a program that silently omitted an
   operation.
3. **CAM-12 itself** exists because the same silent drop had already reached the
   file route once, making a validator unreachable for exactly the defect it was
   written for.
4. **The stock-edge overrun**: solved as `passExtension` on 2D Face and
   `stockEdgeOvershoot` on Adaptive Rough 3D, absent on Parallel Finish 3D -
   against an ADR that had explicitly recorded the convention as cross-cutting.
   The part comes off with fins on it.
5. **The spindle at-speed gate**: `upToSpeedToleranceRpm` is a validated
   definition field, someone provisioned the number; `vfdUpToSpeed()` computes
   the answer and refuses to guess; `SpindlePanel` renders "up to speed" /
   "ramping" on screen. **Nothing gated motion on any of it**, and a 9.52 mm
   cutter entered its first cut at about a ninth of its commanded speed.

**What follows from it, and these are the operative rules:**

- **Landing a producer without its consumer is not half the work. It is zero of
  the work, plus a false report of progress** - because the next reader sees a
  field, a function, a label or a door and reasonably concludes the capability
  exists.
- **A work order that adds or widens a route states which guards, refusals and
  behaviours the EXISTING sibling route applies to the same input**, and for each
  one either carries it across or says why it does not apply. Silence is not an
  argument. ADR-0043 Amendment 3 states the machine-route form of this; it
  generalises.
- **An audit or review of such an order checks that list.** A guard present on
  one route and absent on its sibling is a defect on the route that lacks it,
  never a feature of the route that has it.
- **When you find a configured-but-unread field, a computed-but-unused value, or
  a rendered-but-unconsulted label, that is a defect report, not a curiosity.**
  Four of the five above were visible in the source before they were visible on
  hardware.
- **The cheapest instrument is a fixture driven through BOTH paths and
  compared.** Not another unit test on either side - each side already passes its
  own. Every one of the five was found by a human or a machine exercising the
  real product, and every one was invisible to a green suite.

Corollary for judging your own work: before calling a capability done, name the
line of code that consumes it. If you cannot, it is not done, and saying so
plainly is worth more than a passing test.

### 1. Functional clarity over cosmetic perfection

Structurally correct with small geometric imperfections is preferable
to mathematically perfect and hard to reason about. Counter the
temptation to fight minor visual artifacts that don't affect actual
cutting, or chain together complex math to eliminate a deviation no
operator will notice.

**Safety caveat.** A visual artifact is only "cosmetic" if it doesn't
affect cutting behavior. Artifacts that touch tool engagement, gouging
risk, collision risk, climb direction, entry safety, or uncut-stock
boundaries are functional defects, regardless of how small they appear.
"It still cuts" isn't the test — the test is whether the artifact
changes what the tool actually does in the material.

This pairs with the toolpath/postprocessor separation in principle 2:
often what feels like a "cosmetic" issue in the toolpath layer is
really a concern that belongs in the postprocessor or the controller.
Before adding smoothing math, ask whether the problem belongs in this
layer at all.

### 2. Toolpath planning is separate from GCode generation

The toolpath layer (everything in `src/lib/cam/`) produces
controller-agnostic output: geometry (lines, arcs) with move-type
intent (rapid, cut, plunge, helix, etc.) and feeds derived from
project/process settings. That output is `ToolpathMove[]`.

A separate postprocessor takes `ToolpathMove[]` and produces GCode
for a specific controller. The postprocessor handles GCode dialect
choices (G0/G1/G2/G3, M-codes, comments), machine-specific formatting,
acceleration/deceleration ramps if the controller doesn't handle them
internally, resolution preferences (arcs vs line segments), and any
other controller-specific concerns.

This abstraction makes the toolpath software portable across
controllers — one toolpath calculation can target different machines
by swapping the postprocessor.

**Consequences for toolpath code:**

- Operations emit clean geometric moves with role tags. They do NOT
  include M-codes, dialect-specific tricks, or controller assumptions.
- **Smoothing splits by layer.** Controller-level smoothing — jerk
  limiting, block blending, generic GCode-level acceleration ramps —
  belongs to the postprocessor or the controller. Geometry that
  controls cutter engagement or machining safety — corner fillets
  to prevent gouging, lead-in arcs to bound entry engagement, radii
  that prevent the tool from chipping at high feed — belongs in the
  toolpath layer. The test: does the geometry change what material
  the cutter actually removes? If yes, it's a toolpath fact. If no
  (it just makes the GCode read smoother to the controller's motion
  planner), it's postprocessor.
- Feed rate selection happens in the operation, by move role. A move
  tagged `'cut'` gets the cut feed from process settings; `'plunge'`
  gets plunge feed; etc. The operation resolves feed-per-move; the
  postprocessor just uses whatever feed is on the move.
- Resolution chunking (e.g., expanding an arc into many short line
  segments for legacy controllers) is the postprocessor's job. The
  toolpath emits an arc primitive; what comes out the other side
  depends on the postprocessor's target.

**Historical anchor.** *The principle is grounded in a specific
event: the loopback-v2 spiral work built a C1-continuous biarc system
in the toolpath layer to solve what was actually a postprocessor /
controller concern. The architectural split documented here is the
structural fix.*

### 3. Audit root cause before adding complexity

Understand the root cause of a problem before designing the fix.
Adding mitigation layers without understanding the structural issue
compounds complexity. A symptom-driven fix that works might be hiding
a structural issue that produces three more symptoms later.

Pattern: when a bug surfaces, the first question is "why is this
happening at this layer?", not "how do I make this layer handle it?".
If the layer producing the symptom is the wrong place to fix, the fix
goes elsewhere. The biarc work in principle 2 is the canonical
example: the symptom appeared at the toolpath layer, but the root
cause was a layering mismatch — the entire concern needed to move,
not be patched.

**Non-convergence is itself a signal.** The root cause is not always
visible at the first bug-surface; sometimes it only reveals itself
through the *shape of the failed fixes*. When successive patches each
fix some cases and break others — never converging — that pattern is
diagnostic: it means the problem is structural, not a tuning issue, and
each patch is trading one manifestation for another. Stop patching and
address the structure. (Canonical example: the 2026-05-29 OCCT linking
session tried several heuristics for fillet solution-side selection and
chain orientation; each fixed some transitions and broke others. The
non-convergence was the tell that adjacency/direction were being
inferred from geometry rather than carried as canonical orientation —
the structural fix, not another heuristic, was the answer.)

### 4. Plan before execute

Non-trivial work begins with a plan, not with code. The plan surfaces
ambiguities, allows decisions to be reviewed before they harden into
implementation, and catches errors that are cheap to fix in prose and
expensive to fix in code.

Plan-first is enforced at the CC interaction level (see AI-assisted
development patterns below) but the principle applies generally: think
through what you're doing before you do it, especially when
architectural surfaces are involved.

### 5. Conformance over consistency

When in doubt, follow the convention in docs/ARCHITECTURE.md rather than
match what some existing code happens to do. Consistency is the outcome
of every operation following the same contract, not the input. If
existing code violates the contract, that's migration debt — don't
match the wrong pattern.

### 6. Migration debt is acceptable; divergent abstractions are not

Existing code that doesn't yet match the canonical architecture is
known migration debt — it gets fixed in scheduled phases. **New code
that introduces a new divergent abstraction is not migration debt;
it's a fresh architectural problem.**

The distinction matters: it's acceptable for AC today to have
`params.safeZ` because that predates the height vocabulary discipline
and is on the migration list. It would not be acceptable to add
`params.helixSafeZ` today because we know better now.

### 7. Properties panel as a first-class edit surface

Every selectable entity — geometry, operation, setup, stock, nest, and
any future selection type — exposes its commonly-edited values as
inline, editable Properties-panel fields, not only in a tree row, a
viewport gizmo, or a modal. This follows "Many Paths to Same Result":
the multiple surfaces edit ONE canonical store action, so the user is
never forced to drill down to change a common value.

Wiring a feature's Properties-panel edits is part of building the
feature, not a later add-on. When adding a new operation type, selection
type, or editable entity, the plan includes its Properties-panel fields
alongside its tree and viewport representations.

## Workflow

### Plan-first development

Non-trivial work follows a four-step cycle:

1. **Reconnaissance** — Read existing code, gather facts, produce a
   structured inventory. Stop. No design decisions in this step.
2. **Plan** — Propose the implementation: file changes, new types,
   tests to add, validation criteria. Stop for review. No code in
   this step.
3. **Execute** — Implement per the approved plan. Run tests. Verify
   behavior matches plan.
4. **Commit** — Single atomic commit with descriptive message.
   STATUS.md update either bundled or separately backfilled.

Trivial work (small fixes, typos, formatting) can skip the reconnaissance
and plan steps. The boundary between trivial and non-trivial is judgment:
when in doubt, plan.

### Help/wiki updated with every completed feature (the operator rule, 2026-08-01)

Private development: the planning hitlist below is not exported. Public help sources
and the wiki generator are included in the release.

A feature is not COMPLETE until the in-app help/wiki reflects it. When a
feature lands and is considered done, the same delivery updates the help
topic hitlist (docs/planning/HELP-WIKI-PLAN.md while the system is being
built; the live help registry once it exists) with the new additions.
Final screenshots and polished prose may lag until the feature's UI is
stable, but the topic entry and its draft summary may not. This applies to
every client working the repo (Claude, Codex, Kimi/OpenCode, successors).

### Atomic commits

One commit per logical change. A commit message subject line should
fully describe the change in 50-70 characters. If the change is too
large to summarize in one line, it's too large to be one commit.

Examples of correct atomicity:
- "feat(ac): add frontier-tangent planning primitives (C3a)"
- "fix(heights): add wcsZ to bottomHeight in AC cutZ calculation"
- "refactor: extract resolveHeights into shared subsystem"
- "chore: remove loopback-v2 era infrastructure"

Examples of incorrect atomicity:
- "fix various AC issues and update docs" (mixed concerns)
- "WIP" (no description)
- "stuff" (nondescriptive)

### Backfill pattern for STATUS.md updates

When a code commit lands without a STATUS.md update (context pressure,
session boundary, or just forgot), the next session opens with a small
admin commit that updates STATUS.md to reflect the prior code commit.
Commit message format:

```
docs(ac): backfill STATUS.md for <commit-hash>
```

Body briefly notes what's being added to STATUS.md and why it wasn't
in the original commit. Backfill commits are not failures — they are
a clean way to keep documentation current without blocking code work
on documentation perfection.

## AI-assisted development patterns

This project uses a three-role development model with AI assistance:

- **Chat (Claude in conversation)** — Architect and conductor. Reads
  architecture context, designs plans, reviews CC output, makes
  cross-cutting decisions. Does not directly edit code.
- **CC (Claude Code in IDE/terminal)** — Worker. Reads files, runs
  tools, edits code, runs tests, commits. Operates on focused tasks
  with planned scope.
- **User (project owner)** — Domain expert and decision-maker. Reviews
  plans, approves or rejects, sets priorities, validates outputs
  visually.

The patterns below have emerged as effective for this triangle. They
are the operational glue that makes the architecture in
docs/ARCHITECTURE.md actually achievable.

### Plan-first CC sessions

CC sessions for non-trivial work follow the four-step cycle above
explicitly. The pattern in practice:

```
USER → CHAT:   "Here's what I want to do"
CHAT → USER:   Plan and prompts for CC
USER → CC:     Anchor prompt (orient to current state)
CC → USER:     Sync (confirms current state from STATUS.md)
USER → CHAT:   Forward CC's sync
CHAT → USER:   Task prompt (specific work to do)
USER → CC:     Forward the task
CC → USER:     Plan or reconnaissance findings, STOP
USER → CHAT:   Forward CC's output
CHAT → USER:   Review, corrections, approval, implementation prompt
USER → CC:     Forward the implementation prompt
CC → USER:     Implementation report, test results, STOP
USER → CHAT:   Forward CC's report
CHAT → USER:   Approval to commit, or corrections
USER → CC:     Forward commit instruction
CC → USER:     Commit hash, STOP
```

This is verbose but every step has a reason. The user's role as
forwarder between chat and CC creates the human review gate.

**The full loop is required for non-trivial or high-risk work**:
architectural changes, new operation development, anything touching
shared subsystems, anything where getting it wrong has real
consequences (test regressions, lost work, machine safety
implications). Compressing the cycle on this kind of work skips
review and produces worse outcomes.

**The cycle can compress for small, low-risk, mechanical changes**:
typos in documentation, renaming a single field with no semantic
change, removing a clearly dead file, formatting fixes. In those
cases CC can be given the task directly, perform it, and report —
no separate plan step. The judgment call is whether the work has
any realistic chance of producing a surprise. If "just do it" would
make a reviewer uncomfortable, it's not eligible for compression.

### Reconnaissance vs execution sessions

CC sessions have two modes that should not be mixed:

- **Reconnaissance** — Read files, run searches, produce structured
  factual reports. No file edits, no commits. Output goes to chat for
  synthesis. Examples: "audit the current safeZ migration surface",
  "summarize how each operation handles heights", "find all dead tool
  scripts".
- **Execution** — Apply approved changes, run tests, commit. Pre-planned
  scope. Output is a commit hash and test report.

A session can be one or the other, not both. Mixing them creates
context pressure and risks executing on un-reviewed plans.

### Three-step session reset protocol

When CC's context fills up (~75-80% of terminal-reported context bar,
not the model's self-report which can lag), reset rather than push
through. The reset protocol:

1. **Anchor** — Chat drafts an anchor message that orients fresh CC
   to current state: branch, latest commit hash, what's in flight, what
   docs to read (typically STATUS.md only).
2. **Sync** — Fresh CC reads what the anchor specifies and reports back
   a summary of current state. Chat verifies no discontinuity (CC's
   summary matches expectation; if not, reconcile before proceeding).
3. **Task** — Chat sends the actual work prompt. Fresh session proceeds
   with full context.

The sync step catches errors. If CC's summary disagrees with what chat
thinks the state is, that disagreement gets resolved before any code
runs. Skipping sync risks proceeding with mismatched assumptions.

### "Use judgment + escape hatch" pattern

For tasks with predictable structure but uncertain details, CC can be
given autonomy bounded by stop conditions:

```
"Remove all 'adaptive_2d' code paths in NewOperationModal.
Use judgment when conditional UI elements exclusively serve the
'adaptive_2d' branch (remove them too).

ESCAPE HATCH: If any code path has unclear interactions (e.g., a flag
referenced in places not in the inventory, or shared state that other
branches depend on), STOP and report rather than guess."
```

This works because:
- The bounded autonomy lets CC handle obvious cases without round-trips
- The escape hatch prevents CC from guessing when guesses would create
  bugs
- The pattern is more efficient than full plan-first for mechanical
  refactors with predictable structure

Use this pattern when:
- The general approach is well-defined
- Individual cases are mechanical
- Some cases might be ambiguous and need human judgment
- Speed matters more than maximum review density

Do NOT use this pattern when:
- The approach itself is uncertain (use plan-first instead)
- Stakes of getting a single case wrong are high
- The work is architecturally novel

### Context discipline

CC context fills faster than expected. Discipline matters:

- **Watch the terminal context bar**, not CC's self-reported percentage.
  The terminal bar is authoritative; CC's self-report can lag by 5-15
  percentage points and tends to underestimate.
- **At 75-80% terminal context**, finish the current step and reset.
  Continuing risks compaction mid-operation or running out before
  completing.
- **At 90%+ terminal context**, do only the minimum needed to reach a
  natural stopping point (typically: commit what's done, report hash,
  stop). Don't start new work.
- **Defer non-critical operations** when context is tight. STATUS.md
  updates, follow-on edits, documentation polish — all can move to a
  fresh session.

The pattern in practice: a complex CC session that produces 43 tests +
a commit is usually right at the boundary. If STATUS.md update wasn't
done in the same session, that's fine — it lands as a backfill commit
in a fresh session.

### Visual review for CAM

CAM operations have a verification gap that doesn't exist in most
software: a toolpath can pass every numerical test and still be
geometrically wrong on a real machine. Visual review is not optional.

At milestone boundaries (especially M4 sub-commits for AC), visual
review checks:

- **Path roles are distinguishable** — rapid, plunge, helix, ramp,
  cut, stepover, lead-in, etc. Visualizations should colour-code by
  role.
- **Plunges land in cleared territory**, not into uncut material.
- **Climb-correctness** is preserved on every cut move (uncut on the
  right of heading by convention).
- **Approach geometry** makes physical sense (lateral feeds from
  cleared side, not through uncut).
- **No unsafe fallbacks** (centroid plunge in regions that should use
  frontier-tangent entry).

Visual review may surface issues that no test catches. When it does,
add a test that captures the issue (visual review finding becomes
regression test).

### G. Verify before asserting; defer in the user's domain

The chat-assistant (architect) and CC can both reason confidently about code,
structure, and math. Neither can see what a render actually shows, and neither
operates the machines. The user is the authority on what a toolpath *does* — cut
quality, climb vs. conventional, engagement, motion, what a rendered path actually
looks like. The discipline: **when about to state a conclusion that lives in the
user's domain, verify it or defer to the user — do not assert it from inference.**

This is not the same as the role model (which says who the domain expert is); it is
a behavioral rule about not substituting fast, confident inference for the user's
read. The failure mode is subtle because it feels like competence: glancing at a
render and declaring what it shows, overriding the user's stated convention with a
visual impression, or describing a path's behavior the AI cannot actually see. All
of these reach into the user's domain with structural-confidence that does not
belong there. State reasoning as reasoning ("I'd expect X because…"), present it for
the user to judge against the render, and treat the user's correction as
authoritative. A collaboration that observes this boundary is markedly more
effective than one that does not.

### H. Externalize reasoning into renders the user judges (the review loop)

For visual/geometric work, the productive loop is: **CC builds → the result renders
in the debug viewer → the user looks → the user reports what the motion does → the
architect aims the next step at what was seen.** Reasoning is externalized into
something the user can see and judge, rather than the AI trying to be right about
output it cannot see.

This is distinct from the visual-regression testing gate (Testing discipline): that
gate turns confirmed-good output into regression fixtures. This is the upstream
*design* loop — the mechanism by which an uncertain design is steered toward correct
by repeated look-and-report cycles. A user-annotated render (arrows, labels, markup
on what is right or wrong) is the highest-bandwidth input available; design directly
against it. When the AI finds itself reasoning at length about geometry instead of
rendering it and asking, that is the cue to render and ask.

### I. Diagnose before building on an uncertain mechanism

When a mechanism's correctness is genuinely in doubt — a metric that might fire in
the wrong place, a measurement whose endpoints might not be comparable, a claim that
something is "validated" when it is only proposed — spend one cheap reconnaissance
step (CC reads or measures and reports numbers, no build) to pin it down before
committing a build session to it.

This extends "audit root cause before adding complexity" (a bug-fix methodology) and
the reconnaissance/execution split (which separates the modes): the specific pattern
here is using a measurement-and-report step to *confirm a mechanism is sound before
building on it*, not to fix a known bug. It has repeatedly caught errors that would
otherwise have been baked into a build — a false "validated" claim, a metric that
fired on the wrong shapes, a measurement comparing mismatched endpoints — each caught
for the cost of a read instead of a wasted build-and-revert. When in doubt whether a
mechanism is right, prove it cheaply first.

### J. Let geometry emerge; do not deform it after extraction

Toolpath geometry produced by a field, solver, or extraction (e.g. distance-field
isocontours, marching-squares rings, scanned arcs) should be made correct by shaping
the *field or the construction it emerges from* — not by displacing the points after
the fact to satisfy a constraint. Post-hoc point surgery on extracted geometry
produces artifacts (kinks, discontinuities) and hides the real problem.

Concrete example from history: a load-band rate-limiter that clamped interior points
of already-extracted arcs (leaving endpoints fixed) produced kinks at the wall and
was reverted; the correct form governs where the *next* element is placed, or drives
re-extraction from a conditioned field, so the corrected geometry emerges already-
right. This pairs with principle 1 (functional clarity) and principle 3 (audit root
cause): if a constraint isn't being met, fix the construction, not the output.

## UI conventions the operator has ruled on (binding)

Private development: the standards document below is not exported.

These live in `docs/ui-ux/COHESION-STANDARD.md` (section 13 and the modality
rules) - encode new rulings THERE the moment they surface, and read it before
speccing any UI work order.

## Code conventions

### Operation internals

Operations are deterministic at the I/O boundary: payload in,
`ToolpathMove[]` out, no payload mutation, no global state, no I/O.
(This is the full operation contract in docs/ARCHITECTURE.md.) From a
code-writing perspective, the boundary rule allows freely:

- Local mutable working state derived from the payload (occupancy
  grids, state machines, accumulators, candidate lists, score
  caches)
- Helper functions that mutate local variables and return values
- Imperative loops over geometry, recursive descent through state
  trees
- Anything that's a private implementation detail not shared
  outside the operation

What the boundary forbids:

- Mutating the input payload itself (parameters, heights, loops,
  etc.) — the payload is treated as deeply immutable
- Module-level mutable state that persists across calls
- Reading or writing global state, environment, DOM, or filesystem
- Calling out to async work that the operation's output depends on

The mental model: an operation is a pure function from payload to
moves at the boundary, even if its insides are an imperative state
machine the size of a small city.

### File and directory naming

- Operation files: `<op>2d.ts` (flat) or `<op>2d/` (submodule directory)
  - The `2d` suffix leaves room for future `3d` operations
  - Submodules used when the operation has multiple algorithm files
- Per-operation submodule files:
  - `index.ts` — public entry point with `build<Op>Toolpath`
  - `types.ts` — internal types
  - Other algorithm files named by function: `planner.ts`, `stock.ts`, etc.
- Shared modules under `src/lib/cam/<subsystem>.ts` (flat) or
  `src/lib/cam/<subsystem>/` (with internal structure)

### Function and type naming

- Operation entry function: `build<Op>Toolpath` (camelCase, `Op` is
  the operation name)
- Operation params type: `<Op>Params` (PascalCase)
- Worker payload type: `<Op>WorkerPayload`
- Worker message type string: `COMPUTE_<OP>` (SCREAMING_SNAKE_CASE)
- Internal types: free-form within the submodule, but exported names
  should be self-explanatory

### Z-coordinate aliasing

The canonical local aliases for resolved absolute Z values, mirroring
the height field names:

```ts
const wcsZ        = payload.wcsOrigin.z
const clearanceZ  = heights.clearanceHeight + wcsZ
const retractZ    = heights.retractHeight   + wcsZ
const feedZ       = heights.feedHeight      + wcsZ
const topZ        = heights.topHeight       + wcsZ
const bottomZ     = heights.bottomHeight    + wcsZ
```

Pattern: drop "Height" from the field name, append "Z". No exceptions.
This is enforced by docs/ARCHITECTURE.md's MUST NOT clause; restated here
for code-level discipline.

**These aliases are local resolved variables only.** They are computed
inside the operation from `payload.heights.*` plus `payload.wcsOrigin.z`.
They are NOT params, fields on types, or public API.

Specifically, **do not add operation-specific Z params like `safeZ`,
`cutDepth`, `bridgeZ`, or `plungeZ` on `<Op>Params`.** The
height-plane vocabulary lives on `HeightParams` and gets resolved into
local Z aliases inside each operation. An op-specific Z param means
the operation is inventing new vocabulary instead of using the
canonical model — a layering violation.

The `ACParams.safeZ` violation was removed in Phase 1 (resolved). Any
remaining op-specific Z params are migration debt to retire the same way.

### Coordinate hierarchy resolution

Datums and height planes resolve through ONE common coordinate
subsystem that walks the nested hierarchy
(machine -> setup primary WCS -> stock -> geometry -> operation
internal offsets). This is engineering doctrine, governed by ADR-0020
(0020-nested-coordinate-hierarchy.md):

1. An operation MUST resolve every height/datum through the common
   subsystem. It MUST NOT read geometry, stock, or WCS to compute a
   plane itself.
2. An op declares a reference + offset + its geometry/loop selection;
   the subsystem composes geometry -> stock -> setup WCS -> machine. An
   op NEVER reaches outside its selected geometry's owning frame.
3. Op-internal offsets (chamfer tip, drill per-hole, pocket floor,
   plane offset) CONSUME resolved planes only; they never re-resolve
   references or reach into geometry/stock/WCS themselves.
4. Undeterminable ownership or binding -> FAIL LOUD (ADR-0003), never a
   silent guess at which stock/part/frame a plane resolves through.
5. UI previews MUST call the same resolver. No mirrors, ever — a
   duplicated resolver is what produced the display-vs-dispatch drift.
6. New reference types go in the common reference enum (ADR-0002
   spirit), not as per-op resolution logic.

A test asserts every operation type routes its datum resolution
through the shared subsystem; a new op that bypasses it fails that
test.

### MoveRole assignment for ambiguous moves

When emitting a `ToolpathMove` whose role doesn't fit cleanly into
the existing `MoveRole` union, use the closest existing role rather
than tagging it `undefined` or coining a new ad-hoc role. The union
grows deliberately, not speculatively.

**Current ambiguous case:**

- **AC C3 frontier-tangent contact feed** (the lateral move from the
  plunge point in cleared territory to the contact point at the
  uncut frontier): use `'lead_in'`. It is semantically a tangent
  lead-in to a cut profile. A specialized `'frontier_entry'` role
  may be added later if visual review or simulator integration
  needs to distinguish frontier-tangent contacts from generic
  lead-ins; until then, `'lead_in'` is the convention.

New ambiguous cases should be discussed and added here as they
arise, so the union stays compact but the resolution for each known
case is documented.

### Strategy failures and silent fallbacks

When an operation has a specialized strategy (e.g., AC's
frontier-tangent entry, pocket's helix-with-fallback-to-ramp,
chamfer's V-bit geometric check) and the specialized strategy
fails its safety or geometric checks, **the operation must surface
that failure explicitly rather than silently falling back to a
generic strategy.**

Two acceptable patterns:

- **Return an explicit failure.** The planner returns an
  `UNRESOLVED` decision (or equivalent typed failure variant), and
  the caller decides what to do — abort, ask the user, escalate to
  a fallback with clear logging.
- **Fall back with explicit logging.** If a fallback is genuinely
  safer and is what we want by design, emit a structured log /
  telemetry record naming the specialized strategy that failed, the
  rejection reason, and the fallback being used.

What is not acceptable: the operation silently produces a
"reasonable-looking" centroid plunge or generic lead-in when the
planned frontier-tangent entry was rejected. That hides bugs (the
rejection might be a logic error in the validator rather than
genuine infeasibility), creates surprising machine behavior, and
makes visual review meaningless because there's nothing to flag as
"this used a fallback."

The rule applies recursively: if a fallback also fails, that
failure surfaces. It does not fall back again silently.

### Debug telemetry for complex planners

Operations with non-trivial strategy selection (AC's planner,
pocket's entry-strategy decisions, future complex routing) must
expose enough internal state to diagnose "why did the planner do
X?" from outside the operation.

Minimum telemetry for a strategy-selecting planner:

- **Candidate counts** — how many candidates were generated at each
  filtering stage
- **Rejection reasons** — structured counts of why candidates were
  rejected, e.g.,
  `{ pathPenetratesUncut: 12, plungeInUncut: 3, climbWrong: 7, tangentStabilityTooLow: 2 }`
- **Selected strategy** — which strategy variant was chosen and its
  key parameters
- **Key scalar values** — engagement angle, frontier index, score
  components, anything that drove the decision

How telemetry is exposed depends on the operation. Common patterns:

- A `decision: PlannerDecision` field on each emitted move or
  sequence of moves
- A sidecar log returned alongside `ToolpathMove[]` (e.g., as a
  separate channel on the worker response)
- Structured `console.debug` output during development, gated by a
  debug flag

This is more than a debugging convenience: telemetry is what makes
visual review actionable. A move that looks wrong on the viewer is
half-debugged if the telemetry shows why the planner chose it.
Without telemetry, visual review surfaces problems but does not
help diagnose them, and "this looks off" becomes a blind
reproduction exercise.

### Imports and exports

- Import shared types from `src/lib/cam/types.ts` for worker-protocol
  types
- Import project-wide types from `src/types/index.ts` for
  `ToolpathMove`, `MoveRole`, etc.
- Operations import shared geometry from `src/lib/cam/geometry/` (the
  Phase 1 C3 consolidation is done; the former `offset2d.ts` no longer exists)
- Avoid deep relative imports (`../../../types`) — use the shorter
  path where possible
- Internal types: re-export through the submodule's `types.ts` if
  multiple internal files need them; don't import internal types from
  another submodule's internals

### Comments

- Operation files should have a header comment block describing
  algorithm overview, key conventions, and any operation-specific
  notes
- Functions with non-obvious logic get a JSDoc-style comment
  explaining purpose and any constraints (e.g., "expects CCW
  polygon", "returns NaN if degenerate")
- Inline comments for genuinely surprising or convention-specific
  code (e.g., "SUBTRACT entryNormal — points from cleared into uncut")
- Avoid comments that just restate the code

## Commit conventions

### Message format

Conventional Commits style with a small set of prefixes:

```
<type>(<scope>): <subject line, 50-70 chars>

<body, if needed, explains what changed and why>
<wrap at ~72 chars>

<footer for breaking changes, issue refs, etc. if applicable>
```

Prefixes in use:
- `feat` — New feature or capability
- `fix` — Bug fix
- `refactor` — Code change that neither fixes a bug nor adds a feature
- `docs` — Documentation only
- `chore` — Tooling, build, dependencies, project hygiene
- `test` — Adding or modifying tests (when not paired with feat/fix)

Scope (optional): the area affected, often the operation name or
subsystem. Examples: `ac`, `pocket`, `heights`, `types`.

Examples of well-formed messages:

```
feat(ac): add frontier-tangent planning primitives (C3a)
fix(heights): add wcsZ to bottomHeight in AC cutZ calculation
refactor(cam): extract resolveHeights into shared subsystem
chore: remove loopback-v2 era infrastructure
docs(ac): backfill STATUS.md for 56599da
```

### Multi-line commit messages

Use heredoc in the shell to write multi-line commit messages cleanly:

```bash
git commit -m "$(cat <<'EOF'
fix(heights): add wcsZ to bottomHeight in AC cutZ

Every other operation does `bottomHeight + wcsZ` to convert
WCS-relative heights to absolute machine Z. AC was using
`heights.bottomHeight` directly, which produced wrong Z when
wcsOrigin.z != 0.

Test fixtures use wcsOrigin.z = 0 so this never surfaced as a
test failure — caught during cross-operation audit (see
docs/ARCHITECTURE.md Tier 1 findings).

This commit also removes params.safeZ as part of normalizing AC's
height handling to match the canonical pattern.

Tests: 43/43 AC tests still pass. wcsOrigin.z=10 manual test
shows AC cuts now land at the correct absolute Z.
EOF
)"
```

The single-quoted heredoc (`<<'EOF'`) prevents shell expansion inside
the body, which matters when the body contains backticks or `$`.

### When to bundle, when to split

Bundle commits when:
- Multiple files change as part of one logical concern
- Splitting would leave the codebase in a broken state between commits
- The changes are tightly coupled (e.g., renaming a field touches
  five files — one commit)

Split commits when:
- Multiple unrelated concerns are being addressed
- Each commit can stand alone as a coherent change
- Bisecting between them would be useful for future debugging

The cleanup work split into two thematic commits (`chore: remove
loopback-v2 era infrastructure` and `chore: remove stale documentation`)
is a good example: each is coherent alone, each leaves the build green,
and they can be reverted independently.

### Versioning and release tagging

The project follows Semantic Versioning (`MAJOR.MINOR.PATCH`). The single
source of truth is the `version` field in `package.json`; the app reads it via
`src/version.ts` (`APP_VERSION`) and shows it in Settings -> About, alongside the
git build info (commit/branch/date, injected at build time) and the project
file-format version (`CURRENT_PROJECT_SCHEMA_VERSION` — a SEPARATE axis owned by
the migration framework, ADR-0027; it only changes when the saved `.camproject`
shape changes).

**Pre-1.0 convention.** The app is in initial development and stays in `0.x.y`
until its public launch (a leading `0` is the universal "expect change, not yet
stable" signal). `1.0.0` is the public release milestone.

**Bump rules** — applied by CC (the user does not manage version numbers):
- any `feat:` since the last bump -> bump MINOR (`0.1.0 -> 0.2.0`)
- only `fix:` / `docs:` / `chore:` since the last bump -> bump PATCH (`0.2.0 -> 0.2.1`)
- leave MAJOR at `0` until the public 1.0 launch

**When to bump + tag.** At a natural milestone (a feature batch lands and is
green, or the user says to cut a version): update `package.json`, commit as
`chore(release): vX.Y.Z`, then annotated-tag that commit `git tag -a vX.Y.Z -m
"vX.Y.Z"`. The tag is a permanent bookmark to that exact build (the git build
info in About points back to it). Surface the new number to the user when bumped.
Do not bump on every commit — only at milestones.

## Testing discipline

### Test organization

Tests live in `src/tests/<feature>/`. Active development tests get
their own subdirectory:

```
src/tests/
├── adaptive-clearing/
│   ├── m0-smoke.test.ts
│   ├── m1-engagement.test.ts
│   ├── m2-planner.test.ts
│   └── m4-edge-entry.test.ts
└── ...
```

Stable operations don't need a subdirectory unless they have enough
tests to warrant organizing.

### Public contributor tests and the private full-suite gate

In the public repository, use `npm run test:public` to run the regression
tests with exported inputs (`vitest.public.config.mts`). For a focused
change, use `npx vitest run --config vitest.public.config.mts <path>`.
The private gate tools below are not shipped in the public repository.

In the private development repository, a full-repository run used to
certify a milestone, release, or merge gate goes through `npm run test:gate`
(`node tools/test-gate.mjs`), never
raw `npm test` / `npx vitest run`. Vitest's own worker-RPC teardown can
throw `[vitest-worker]: Timeout calling "onTaskUpdate"` under heavy CPU
load even when every test passed (root cause is inside
`node_modules/vitest`, not this codebase; confirmed no fix exists in the
installed 3.x line - see `vite.config.ts`'s `maxWorkers` comment history,
BK-22). A raw `vitest run` has no way to tell that apart from a genuine
failure, so its exit code cannot certify a gate on a loaded machine.

`tools/run-suite.mjs` wraps the same Vitest invocation with a fail-closed
verdict layer (`tools/vitest-flake-classifier.mjs`, BK-153/BK-160): it
parses the captured output and only converts a nonzero exit to 0 when the
summary shows zero failed tests/files AND every unhandled error is the
exact `onTaskUpdate` RPC-timeout signature. Any named test failure, any
other error, or unparseable/ambiguous output keeps the original nonzero
exit - it can never mask a real red run. Regression-tested against
captured real incidents in `tools/tests/fixtures/BK-153/` and
`tools/tests/fixtures/BK-160/` (`node tools/run-suite.mjs --config
tools/tests/vitest.bk153.config.mjs` for the Vitest-based cases, `node
--test tools/tests/run-suite-quiescence.test.mjs` for the node:test
cases).

### Test ID prefixes

Tests get short ID prefixes that map to the implementation:

- `M0`, `M1`, `M2`, `M3`, `M4` — milestone smoke tests
- `T1`–`T6` — fixture-based integration tests (rectangle, L-shape, etc.)
- `C1`–`C4` — component classifier tests
- `FE-1`–`FE-5` — frontier extraction tests
- `CC`, `CG`, `SC`, `VG`, `PFE` — unit test categories per submodule

Prefixes make it easy to discuss specific tests in commit messages
and reviews ("VG-7 covers the engagement check"). Tests are renamed
or deleted when their implementation is — no orphan tests.

### CAM fixtures and tool-radius validity

CAM tests reveal a category of "failure" that isn't an algorithm
failure: a fixture geometry that's invalid for the tool radius the
test uses. A test that fails because the safe tool-center region has
collapsed (the corridor is narrower than the tool can fit) is testing
geometry, not the algorithm. The signal is meaningless and any "fix"
to the algorithm to pass that test would be wrong.

**Rule**: tests must fail because the algorithm is wrong, not because
the safe tool-center region has collapsed.

**Tool-radius-aware fixture guidance.** When designing a fixture,
compute the safe corridor width for the planned tool:

```
safeCorridorWidth = featureWidth - 2 * toolRadius
```

- If the fixture expects the tool to *traverse* the corridor,
  `safeCorridorWidth` must be positive — and preferably with margin
  (at least ~2 mm of safe corridor is a reasonable floor for
  non-degenerate testing).
- If the fixture intentionally has inaccessible remnants (e.g., to
  test that an algorithm correctly leaves them uncut rather than
  gouging into a too-narrow corner), state that intent explicitly in
  the test setup or in a comment so future maintainers don't "fix"
  the geometry by widening it.
- Document the tool radius assumed for each fixture in test comments
  or naming, so it's obvious when a fixture is being reused with a
  different tool than originally designed for.

### Strategy-level fixtures answer in seconds (WO-408)

A strategy-level test (a full rough, a carve replay, an engagement measure)
answers a yes/no question about the ALGORITHM, and its fixture is the smallest
geometry that still poses that question: shrink the stock/part footprint and
the level count, never the cell size relative to the cutter (a coarser field
changes the answer of a field assertion). Target: no test over 60 s, no file
over 120 s in the cam3d slice. Anything that needs more than a minute is a
smoke test, not a gate - it lives behind an env flag (`describe.skipIf(!
process.env.X)`), like the `_*.probe.test.ts` files and the Node example
probe (`EXAMPLE_PROBE`). A test that only times out is waste: it must fail
FAST on a smaller fixture for the same reason, or be skipped naming the WO.
When a shrink moves a pinned number (peak %, move count, level count), re-pin
it in the same commit with old -> new recorded in the WO; a re-pin is not a
verdict change.

### Coverage expectations

Coverage thresholds are per-fixture, not global. Each fixture has:

- **Floor** — the worst result we accept. Tests fail below this.
- **Target** — what we're aiming for. Tests don't fail just for being
  below target.

Floors and targets evolve. **In normal operation, floors only go up.**
A fixture that hit 96% must not regress below ~95%. Targets become
floors as we hit them. This is tracked per-operation in the
operation's STATUS.md.

**Deliberate rebaselining is permitted** when one of the following
changes:

- Fixture geometry (new shape, different dimensions, different tool
  assumption)
- Measurement method (different coverage metric, different test
  framework, different sampling resolution)
- Machining intent (e.g., a deliberate decision to leave certain
  remnants uncut that previous tests didn't account for)

A deliberate floor change must include rationale in the commit
message. Pattern:

```
chore(tests): rebaseline T3 floor from 0.90 to 0.85

Fixture geometry updated to use tighter corridor (12 mm → 10 mm)
to test L-shape navigation closer to tool diameter. New coverage
reflects expected uncut remnants in tight corner, not algorithmic
regression.
```

Without rationale in the commit, a floor drop reads as silent
regression and gets reverted on review.

### Visual regression

CAM tests have a gap: a numerically passing toolpath can be visually
wrong. Visual fixtures are exported to `test_fixtures/` as JSON for
the debug viewer to load. The pattern:

1. Test runs, produces toolpath, writes JSON fixture
2. Debug viewer loads JSON, displays toolpath visually
3. Human review at milestone boundaries verifies geometric correctness
4. Issues found visually become regression tests when fixable in code

The visual review step is not yet automated. It is a manual gate.

## Documentation discipline

### Where docs live

Private development layout: `UI-ARCHITECTURE.md`, `planning/` and session/work-order
documents below are not part of the public release.

```
/
├── README.md               Quick-start, what this project is
├── docs/
│   ├── ARCHITECTURE.md     Canonical system architecture
│   ├── UI-ARCHITECTURE.md  User-facing architecture (React, state, viewport, operation wizard)
│   ├── CONVENTIONS.md      This document
│   ├── planning/           Long-lived planning docs (cleanup, release, feature requests, audits)
│   └── decisions/          Architecture Decision Records (why significant choices were made)
└── src/lib/cam/
    └── <op>2d/
        └── STATUS.md   Per-operation milestone log
```

No root-level `STATUS.md`. Per-operation STATUS.md files live inside
the operation's submodule directory.

### STATUS.md pattern

Active operations carry a `STATUS.md` in their submodule. The pattern:

- Milestone tracker at the top (M0 / M1 / M2 / ... with commit hashes)
- Per-milestone sections describing what was implemented, with key
  architectural decisions inline
- A "Pre-<next> architectural work" section for known blockers
- A "Future Requirements" section for known unfinished work
- An "Engineering principles (provisional)" section if relevant
  principles haven't migrated to CONVENTIONS.md yet
- A "Misdiagnosis history" section at the bottom for design
  decisions that were considered and rejected, with rationale

Stable operations (contour, drill, etc.) don't need a STATUS.md. If
active work begins on a stable operation, create one.

### Document update cadence

The backfill pattern above recovers from a missed STATUS.md update; this subsection
states when the living docs are *due* for an update, so drift is caught early rather
than accumulating into the kind of multi-document staleness that requires a dedicated
housekeeping pass. (A per-operation HANDOFF.md mirrors this policy and points here as
the canonical home.)

- **HANDOFF.md (per-operation, when present).** Refreshed whenever the operation's
  state materially changes — a capability is validated, a strategic decision is made,
  or a guiding doc is found stale — and always at a session boundary where the next
  session would otherwise start from a wrong picture. It is a living snapshot:
  rewritten, not append-only. Chat-side authors its content; CC commits it.
- **STATUS.md (per-operation).** Gets a new milestone entry when a milestone closes or
  a major capability is validated; old milestone history is retained as record, never
  deleted. The backfill pattern (above) is the recovery path when a code commit lands
  without it.
- **Design-of-record / architecture docs.** Reconciled when implementation (including
  a prototype) proves the documented design incomplete or wrong. Do not let
  implementation silently diverge from the design-of-record: either reconcile the doc
  or flag the conflict explicitly in the operation's HANDOFF.md until it is
  reconciled. Reconciliation is its own focused commit, kept additive where possible
  (preserve the existing reasoning; augment and fix cross-references) rather than
  rewriting argued prose.
- **CONVENTIONS.md (this doc).** Updated when a working pattern is added, changed, or
  retired. Durable cross-cutting discipline belongs here; operation-specific notes
  belong in that operation's STATUS.md or HANDOFF.md.
- **Housekeeping trigger.** If a session opens and finds that MORE THAN ONE guiding
  doc disagrees with reality, stop and do a housekeeping pass before new feature work
  — drift compounds. At minimum, review all guiding docs for staleness at every
  milestone close.

### Architecture Decision Records

Significant architectural choices are captured in `docs/decisions/` as ADRs.
An ADR records the context that prompted a decision, what was chosen, what
alternatives were rejected, and the downstream consequences.

ADRs are append-only: once written, the Context / Decision / Alternatives
sections are not edited. If a decision changes, a new ADR supersedes the old
one. `docs/decisions/README.md` has the full template, the active ADR list,
and amendment conventions.

**When to write an ADR:**
- A choice constrains significant future work (naming conventions, interface
  contracts, layering decisions)
- A non-obvious alternative was seriously considered and rejected — capturing
  the rejection reason prevents re-opening the debate
- A future capability is being designed for today but implementation is deferred

**Integration with plan-first cycles:** Going forward, write the ADR as part of
the commit that implements the decision. If the decision was made in chat or
planning before this convention existed, retroactive ADRs are acceptable — the
6 Phase 1 ADRs in `docs/decisions/` are bootstrapping examples of this. New
architectural decisions should land their ADRs alongside their implementing
commits, not after.

**What ADRs are not:** Implementation details, per-operation design notes
(those go in STATUS.md), or documentation of things already fully covered in
docs/ARCHITECTURE.md — unless the decision history itself is valuable.

### Finding IDs for audit-to-WO tracing (forward-only)

Private development: the audit tools and work-order queue below are not exported.

An audit finding meant to become a work-order candidate gets a stable id the
moment it's written: `FINDING-<audit-slug>-<n>` (e.g.
`FINDING-architect-audit-2026-09-21-1`), stated once next to the finding in
the audit doc and repeated verbatim in the filing WO's `authority` field.
`tools/audit-coverage.mjs` (imported by `tools/fleet-status.mjs`) scans
repo-root `docs/*AUDIT*.md` and `docs/audits/*.md` for ids under this
convention and reports any with no WO citing them - the day the audit lands,
not a month later.

This is **forward-only**: it is not applied retroactively to
`docs/ARCHITECTURE-AUDIT-2026-08-26.md`, any `docs/audits/*.md` written
before 2026-09-22, or `docs/research/PROBING-RECON.md`. Matching free-text
findings in those documents to a WO needs semantic judgement a mechanical
checker deliberately does not attempt. An audit file that carries no ids
under this convention is reported as pre-convention/out-of-scope by name -
never silently passed as "nothing missing" and never false-flagged.

### Paired documentation

Private development: the UI architecture document below is not exported.

Features that span the backend/algorithm layer and the user interface require
updates to both architecture documents as part of the work:

- `docs/ARCHITECTURE.md` describes the algorithms, contracts, and shared subsystems
- `docs/UI-ARCHITECTURE.md` describes how users interact with those algorithms through
  the React component tree, state management, and viewport

Concrete examples:

- **Adding a new operation type** — both documents updated. docs/ARCHITECTURE.md
  documents the operation contract, params, and dispatch wiring.
  docs/UI-ARCHITECTURE.md documents the picker entry, per-operation parameter tabs,
  and any new toolpath role colors.
- **New user-facing behavior** (viewport interaction mode, new property panel
  field, new modal) — docs/UI-ARCHITECTURE.md must be updated even if no backend
  code changed.
- **New internal contract** (shared subsystem, height-vocabulary extension) —
  docs/ARCHITECTURE.md must be updated even if no UI change is visible.
- **Shared interaction contract** (for example Project / Use spanning the Sketcher
  package and 3D workbench) — docs/ARCHITECTURE.md documents candidate,
  resolver, commit, and fail-closed semantics; docs/UI-ARCHITECTURE.md documents
  blank-by-default entry, the existing semantic owner, direct viewport
  preview/commit, and cleanup behavior. A newly reachable control and removal of
  its old automatic behavior land atomically so neither a duplicate nor a missing
  workflow can ship.

Documentation gaps surfaced during code review or use should be tracked in the
relevant "Known Limitations" or "Future Work" section rather than left in chat
history.

### Avoiding doc proliferation

Private development: the planning directory below is not exported.

The codebase previously accumulated many root-level `.md` files
during active development that became stale. To avoid recurrence:

- **No transient planning docs at project root.** Active planning
  lives in chat sessions, then crystallizes into STATUS.md or
  CONVENTIONS.md. Long-lived planning docs (release plan, feature
  requests, audits) live in `docs/planning/`, never at the repo root.
  Throwaway plans should be throwaway, not committed.
- **One canonical doc per topic.** If we need a new top-level doc
  (e.g., DEPLOYMENT.md), discuss whether it belongs in an existing
  doc as a section first.
- **Per-feature docs go in the feature's directory**, not at root.
  If AC needs a deep-dive design doc, it goes in
  `src/lib/cam/adaptiveClearing2d/`, not at root.

### Migration debt tracking

When docs/ARCHITECTURE.md marks a rule as a migration target (e.g., "use
the shared geometry module"), the migration debt is tracked in one of
two places depending on scope:

- **AC-specific debt** → AC STATUS.md "Pre-C3b architectural work"
  section or "Future Requirements"
- **Cross-operation debt** → docs/ARCHITECTURE.md Roadmap section

Debt has an owner (the next milestone or phase that will address it)
and a rationale. Untracked debt becomes drift; drift accumulates into
the kind of cleanup we did in May 2026.

---

*Last updated: 2026-06-16. This document is canonical. If practice
diverges, either the practice should be corrected or this document
should be updated with an explicit rationale.*
