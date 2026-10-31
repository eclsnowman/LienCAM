> RETIRED / SUPERSEDED (2026-06-16). The end-to-end OCCT linking refactor described here
> was ABANDONED in favor of the FreeCAD Adaptive2d TS port (`engine/`). Do NOT begin this
> work. Kept only for fillet/tangent reference. Current state: `docs/planning/AC-PERF-HANDOFF.md`.

# Adaptive Clearing — OCCT Migration Handoff

> **Freshness: CURRENT as of 2026-05-29 (chat-side, sandbox-only — NO repo commits this
> session).** This session was a library evaluation + OCCT proof-of-concept, conducted
> entirely in the chat sandbox (`/home/claude`), not in the repo. Nothing here has been
> committed to `adaptive-clearing-v1`. The mechanical repo state is still HEAD `79943ec`
> as described in the main `HANDOFF.md`. This file is the entry point for the NEXT
> session, whose job is to begin the end-to-end OCCT refactor of the linking/transition
> layer.

> Read this together with the main `HANDOFF.md` (working discipline, roles, repo state),
> `docs/CONVENTIONS.md` (canonical discipline), and `toolpath_element_convention.md` (the
> numbering/orientation convention — it diagnoses the EXACT failure this session hit).

---

## 0. TL;DR for the impatient

- We chose a library: **OpenCASCADE (OCCT) via the `cadquery-ocp` PyPI wheel**, after a
  cited evaluation against cavalier_contours, build123d, shapely, Clipper2, pygeometry2d.
- **Why OCCT and not a lighter 2D lib:** the stated roadmap includes 3D toolpathing, true
  STEP/surface/solid geometry understanding, and a future UI drawing/geometry-editing
  layer. OCCT is the only open-source B-rep kernel that serves all of those AND solves
  today's 2D tangent-arc problem with one primitive (`ChFi2d_FilletAlgo`). The backend
  serves double duty exactly as Operator asked.
- **Proven this session (sandbox):** OCCT's `ChFi2d_FilletAlgo` produces a fillet arc
  **tangent to two curved polylines with 0.000000 mm point gap and 0.0000° tangent
  mismatch** at both contact points — on the previously-broken transition 5→6. This is
  the definitive proof the library/approach is correct.
- **NOT solved this session:** the full 9-segment ring→ring transition chain. It builds
  for all 36 transitions with zero point gaps, but ~half the exit/entry-fillet joints show
  ~178° tangent flips. Root cause identified (below). The fix is an architecture change,
  not a patch.
- **The strategic decision Operator made:** stop cobbling half-measures. **Refactor adaptive-
  clearing linking to an end-to-end OCCT approach.** This handoff architects that.

---

## 1. The core technical finding (why this is the right path)

### What was broken before OCCT

The hand-rolled tangent-arc construction (filleting between the ring polyline and the
boundary polyline) had a systematic flaw: it computed tangent points on the **infinite
tangent lines** of the curves at the ring nodes, but the ring and boundary are **curved
polylines**. The tangent points landed off the actual curves, and the trim/projection
bridges that tried to reconnect them introduced ~90° kinks at 4 of 8 joints in every R0
transition. This is documented in the main HANDOFF lineage; it is the "don't deform
extracted geometry / let geometry emerge" lesson (CONVENTIONS §J) showing up as a
construction-math problem rather than a post-hoc one.

### What OCCT gives us

`ChFi2d_FilletAlgo` is the exact primitive: "arc tangent to two edges … initial edges
… must be connected by the end or start points (shared vertices are not obligatory) …
iterative … allows to create fillet on any curves of initial edges … including ellipses
and b-splines." It does the Newton-method tangent solve we were attempting by hand, but
correctly and for arbitrary curves. **POC numbers: 0.000000 mm gap, 0.0000° tangent
mismatch at both contact points.** See `poc_occt_fillet_5_6.png` — the ring smoothly
enters the arc, the arc smoothly enters the boundary, no kinks.

### Why OCCT and not a 2D-only library (the roadmap argument)

This is the load-bearing decision and the reason to accept OCCT's weight. Operator's stated
roadmap:

1. **Today:** 2D adaptive clearing needs tangent arcs between curved polylines. OCCT
   `ChFi2d_FilletAlgo` solves it.
2. **Later:** 3D toolpathing. OCCT provides B-rep solids, surface evaluation, 3D fillets,
   surface-surface intersection, projection of curves onto surfaces. Companion lib
   **OpenCAMLib** (LGPL, Python bindings) provides drop-cutter / push-cutter / waterline
   on tesselated surfaces when the 3D phase starts.
3. **Later:** true STEP / surface / solid understanding. STEP is a B-rep format storing
   analytic curves and surfaces (NURBS, etc.). OCCT reads STEP natively
   (`STEPControl_Reader`), returns `TopoDS_Solid`, and lets you walk topology and evaluate
   the analytic surfaces — NOT a lossy mesh. It is the kernel behind FreeCAD, KiCAD,
   CadQuery, Salome.
4. **Later:** UI drawing / geometry editing. OCCT has 2D sketcher primitives, splines,
   constraint solving (`Geom2dGcc` — the same machinery FreeCAD's sketcher uses),
   DXF/STEP/IGES I/O. The geometry-editing backend and the CAM backend share one kernel.

A 2D-only library (cavalier_contours, Clipper2, shapely) solves item 1 and forces a
rewrite for 2–4. OCCT solves 1 and is the foundation for 2–4. **One kernel, no rewrite.**

### License note (flag for any future commercialization)

OCCT is **LGPL 2.1 with the Open CASCADE exception** — commercial use permitted, no
royalties. If LienCNC ever ships closed-source, LGPL wants OCCT dynamically linked (so it
remains replaceable). Non-issue for open-source; design for it early if commercializing.
This belongs in an ADR when the refactor lands (see §6).

---

## 2. What was built this session (all in chat sandbox, NOT in repo)

> These are Python files in the chat container, written to validate the approach and
> establish the wrapper shape. They are **reference implementations to port**, not repo
> code. LienCNC's engine is TypeScript (`src/lib/cam/`); see §5 for the language question.

### Working artifacts (proven)

- **`poc_occt_fillet.py`** — single-fillet POC. Builds BSpline edges from the ring and
  boundary polylines, runs `ChFi2d_FilletAlgo`, verifies tangency. **0.000000 mm /
  0.0000°.** This is the artifact that proves OCCT is correct.
- **`poc_occt_fillet_5_6.png`** — the visual confirmation (Operator should look at this).
- **`liencam/geom/occt/fillet.py`** — the wrapper module. Public API:
  - `Curve2D` — wraps a `TopoDS_Edge`, exposes `start_point/end_point/start_tangent/
    end_tangent`.
  - `polyline_to_curve(pts)` — C2 BSpline interpolation through points (with near-
    duplicate dedup; OCCT rejects points closer than 1e-7).
  - `fillet_between(curve_a, curve_b, radius, near_point, interior_hint=None)` — the
    tangent-arc primitive. `interior_hint` selects which side the fillet sits on by
    nearest-arc-center.
  - `sample_curve(curve, n)` — discretize for rendering / G-code.
  - `curve_length(curve)` — approximate arc length.
- **`liencam/geom/occt/__init__.py`** — public exports.
- **`liencam/geom/occt/io.py`** — STUB for STEP/IGES/DXF (populated in the 3D phase).

### Incomplete artifact (NOT fit to ship — documented so it's resumable)

- **`sandbox_21_occt_transitions.py`** — the full 9-segment chain builder + tangency
  audit. Builds all 36 transitions, zero point gaps, but ~178° tangent flips on roughly
  half the `ewf→fe` and `iwf→li` joints (the wall-follow → fillet junctions). The lead-out
  and lead-in joints (`r_a→lo`, `li→r_b`, `lo→ewf`, `fi→iwf`) are mostly clean (~1°).

### Environment

- `pip install cadquery-ocp --break-system-packages` succeeded (OCCT 7.9.3 bindings,
  Python 3.12). Validated imports: `ChFi2d_FilletAlgo`, `GeomAPI_Interpolate`,
  `BRepAdaptor_Curve`, `gp_Pnt/gp_Vec/gp_Pln/gp_Ax3/gp_Dir`, `TColgp_HArray1OfPnt`,
  `BRepBuilderAPI_MakeEdge`.

---

## 3. The remaining bug — root cause (read this before re-attempting)

The ~178° flips are **tangency inversion** — the exact failure `toolpath_element_
convention.md` predicts when adjacency/direction is **inferred from geometric proximity
rather than read from a canonical order.** This session reproduced that prediction
empirically. Two compounding causes:

1. **Solution-side selection.** `ChFi2d_FilletAlgo` returns 2 solutions per curve pair
   (one fillet on each side). My `interior_hint` (nearest-arc-center) picks correctly most
   of the time but not consistently — small fillets relative to curve curvature make the
   3-point arc-center estimate unstable, and it sometimes picks the fillet on the wrong
   side of the wall, producing an arc whose tangent at the contact is antiparallel to the
   wall's motion direction.

2. **Hybrid polyline/arc impedance mismatch.** The wall-follow is built as an independent
   polyline (`walk_along_boundary`) while the fillet is tangent to a BSpline interpolation
   of the boundary. Their tangents at the shared contact point differ — by ~1–3° for the
   "clean" joints (the polyline-vs-spline discretization noise), and the orientation logic
   that stitches them sometimes reverses the wrong segment, flipping a clean ~2° into a
   ~178°.

Both are symptoms of the same structural problem the convention names: **the chain is
assembled by inferring direction/adjacency from geometry at link time, instead of carrying
canonical orientation + traversal direction stamped at construction.** Patching the
heuristics is the wrong fix (I tried; each patch fixed some transitions and broke others —
the signature of a structural, not a tuning, problem). The right fix is the architecture
in §4.

---

## 4. Strategy for the next session — end-to-end OCCT linking

> The decision (Operator, this session): **do not cobble half-measures; refactor adaptive-
> clearing linking to operate on OCCT curves end-to-end.** The principle is CONVENTIONS §3
> (audit root cause before adding complexity) and §J (let geometry emerge from the
> construction, don't deform after) applied at the architecture level: build the chain as
> connected OCCT geometry so tangency and orientation are properties of the construction,
> not of post-hoc stitching.

### The architectural shift

**Stop building polylines and stitching them to arcs. Build the entire transition chain as
a sequence of connected OCCT edges/curves, carrying canonical orientation per
`toolpath_element_convention.md`, and sample the finished chain to a polyline only at the
very end (for rendering and G-code emission).**

Concretely, the two structural fixes:

1. **Single shared wall curve.** Build ONE OCCT BSpline for the boundary stretch that
   covers lead-out + wall-follow + exit-fillet. Build the lead-out fillet against it (gives
   contact point P_wall_lo as a *parameter on that curve*). Build the exit fillet against
   the SAME curve (gives P_wf_fe as a parameter on the same curve). The wall-follow is then
   the curve trimmed between those two parameters — sharing tangents with both fillets BY
   CONSTRUCTION. No polyline-vs-spline mismatch, because the wall-follow IS a segment of the
   exact curve both fillets were tangent to.

2. **Canonical orientation + explicit traversal flag (per `toolpath_element_convention.md`).**
   Every element (ring, lead, wall-follow, fillet, loopback) carries: a sequence number, an
   immutable intrinsic orientation (uniform pocket-interior winding), and an explicit
   traversal-direction flag. Linking references these — never re-derives direction from
   geometry. Solution-side selection for each fillet uses the **known motion-direction at
   the contact** (read from the canonical orientation of the wall/loopback curve) as a hard
   geometric constraint: pick the fillet solution whose arc tangent at the wall contact
   agrees (within 90°) with the wall's canonical motion direction. This is deterministic,
   not a heuristic, so it converges.

### The canonical chain (carry this vocabulary; it's the existing MoveRole taxonomy)

`lead-out → wall-follow → fillet → rapid(loopback) → fillet → wall-follow → lead-in`,
bracketed by the two rings. Move-type tags (`lead_in`/`lead_out`/`loop_back`/`wall_follow`/
`rapid`/`plunge`) are a **postprocessor contract** (`MoveRole` in `src/types/index.ts`) —
emit the existing vocabulary, don't invent ad-hoc types. This layer is the first emitter of
`lead_out` and `loop_back`.

### Sandbox-first, visual-review-gated — NON-NEGOTIABLE

This is the discipline that turned the prior prototype around (main HANDOFF "Working
Discipline"; CONVENTIONS §G/§H). It applies fully here:

- **Build in the chat sandbox first, render, show Operator, get his read, THEN proceed.**
  The next session must NOT write repo code until the sandbox geometry passes a clean
  tangency audit AND Operator has visually confirmed a render.
- **Visual checking with Operator is a required workflow step, not a formality.** Operator reads
  the render and is the final judge of geometric and machining correctness — the architect
  must not assert what a render shows (CONVENTIONS §G). Concretely: after each sandbox
  milestone (single transition clean → all 36 clean → continuous-trajectory playback),
  the architect renders it and presents the image to Operator before the next step.
- **One concern per step (CONVENTIONS, "isolate variables").** Do the single-shared-wall-
  curve fix on ONE transition first. Render. Operator looks. Then expand to all 36. Render.
  Operator looks. Then the playback. Do not bundle.
- **Diagnose before building (CONVENTIONS §I).** The solution-side selection is the
  uncertain mechanism — prove it deterministic on one transition (print the chosen
  solution's tangent vs the canonical motion direction, confirm agreement) before relying
  on it across 36.

### Step-by-step plan for the next session

1. **Acknowledge + confirm state.** Read this handoff, the main HANDOFF, CONVENTIONS, and
   `toolpath_element_convention.md`. Confirm the strategic decision (end-to-end OCCT) and
   the sandbox-first/visual-gate discipline. Do NOT propose repo CC prompts yet.
2. **Re-establish the sandbox.** `pip install cadquery-ocp --break-system-packages`. Load
   the paisley m0 fixture. Re-run `poc_occt_fillet.py` to confirm the environment
   reproduces 0.000000/0.0000°. (Operator re-uploads the fixture and the sandbox files — see
   §7.)
3. **Single-transition end-to-end build (the heart of the work).** Rebuild ONE transition
   (use 5→6, the proven one) with: single shared wall curves, canonical orientation +
   traversal flags, deterministic motion-direction solution selection, full chain as
   connected OCCT curves, sampled to polyline only at the end. Audit all 8 joints. Target:
   MAX tangent mismatch < 0.5°, all gaps = 0.000000 mm. **Render. Show Operator. Get his read.**
4. **Expand to all 36 transitions.** Run the audit across R0. Target: every joint < 0.5°,
   every gap 0. **Render the full R0 with all transitions. Show Operator.**
5. **Continuous-trajectory playback rebuild.** Only after geometry passes. Data model:
   single ordered sequence `[ring[0], chain_0_1, ring[1], chain_1_2, …, ring[36]]` — each
   ring traversed ONCE (no double-count), smooth across transition boundaries, windowed
   reveal/hide, prev/next jumps a full loop. (The prior v3 viewer had double-traversal and
   abrupt jumps Operator flagged; this is the fix.) **Show Operator the playback.**
6. **Decide port strategy + ADR (see §5, §6).** Only once the sandbox approach is fully
   validated under Operator's eye does repo work begin.

---

## 5. The language question — RESOLVE EARLY (architect's call, flag to Operator)

The sandbox is **Python** (OCCT via `cadquery-ocp`). LienCNC's engine is **TypeScript**
(`src/lib/cam/`, worker protocol, `MoveRole`, the debug viewer). This is the one genuinely
new architectural surface the refactor introduces, and it must be decided before repo work:

**Option A — Python geometry service.** Run OCCT in Python as a geometry/linking service
the TS engine calls (subprocess, local HTTP, or WASM-compiled OCCT in-browser). Pros: uses
the mature `cadquery-ocp` wheel directly, same code as the sandbox, full OCCT surface
available for the 3D/STEP roadmap. Cons: introduces a Python runtime dependency and an IPC
boundary into a currently-pure-TS engine; the debug viewer and worker protocol assume TS.

**Option B — OCCT in the browser via WASM.** OCCT compiles to WASM (used by several web
CAD tools); `opencascade.js` is the known binding. Pros: stays in the JS/TS world, runs in
the worker, no separate runtime. Cons: `opencascade.js` is a different (sometimes thinner /
differently-generated) binding than `cadquery-ocp`; the `ChFi2d_FilletAlgo` surface and its
exact API must be re-validated in WASM (the sandbox proof is in the Python binding). Larger
bundle.

**Option C — port the specific algorithms to TS** (no OCCT dependency). Rejected by the
strategic decision: that's the cobble-half-measures path that caused this session's
problems, and it forfeits the 3D/STEP/UI roadmap payoff entirely. Do not pursue.

**Architect's lean:** This is partly a domain/product call (runtime constraints, deployment
target) — flag to Operator. Engineering lean is **B if `opencascade.js` exposes
`ChFi2d_FilletAlgo` cleanly** (keeps one language, one runtime, fits the worker model), with
**A as the fallback** if the WASM binding can't do the 2D fillet API the sandbox relies on.
**First concrete task on the repo side: a reconnaissance spike validating `ChFi2d_FilletAlgo`
in `opencascade.js`** — reproduce the 0.000000/0.0000° single-fillet result in the browser
binding. If it reproduces, B. If not, A. Do this spike in the sandbox/throwaway space, not
in the engine, and show Operator the result before choosing.

---

## 6. Documents to create/update when repo work lands

Per CONVENTIONS doc-maintenance cadence (do NOT create transient root docs; crystallize
into the right homes):

- **ADR** in `docs/decisions/` — "Adopt OCCT as the geometry kernel for adaptive-clearing
  linking (and roadmap 3D/STEP/UI)." Context (hand-rolled tangent failure), decision
  (OCCT/`ChFi2d_FilletAlgo`), alternatives rejected (cavalier_contours/Clipper2/shapely/
  build123d, and the TS-port option C), consequences (Python-or-WASM runtime question §5,
  LGPL dynamic-linking note §1). Write it alongside the implementing commit.
- **AC STATUS.md** (`src/lib/cam/adaptiveClearing2d/STATUS.md`) — new milestone entry when
  the OCCT linking lands and passes visual review.
- **AC HANDOFF.md** (the main one) — refresh when this refactor materially changes state.
- **`toolpath_element_convention.md`** — reconcile: this session confirmed its prediction
  (tangency inversion from proximity inference). Note that OCCT linking implements its
  numbering/orientation/traversal-flag model concretely.
- **docs/ARCHITECTURE.md** — when the geometry-kernel choice and any new geometry subsystem
  contract lands. **docs/UI-ARCHITECTURE.md** — only when the UI geometry-editing layer work
  begins (future).

---

## 7. Files the next session needs (Operator uploads these at session start)

**Context docs (re-upload at session start, per the established session-init pattern):**

1. This file — `HANDOFF-OCCT-MIGRATION.md` (entry point).
2. The main `HANDOFF.md` (working discipline, roles, repo state).
3. `docs/CONVENTIONS.md` (canonical discipline).
4. `toolpath_element_convention.md` (numbering/orientation convention — the heart of the
   §4 fix).
5. The orientation / planning-cycle / execution-cycle skill files
   (`liencam-orientation`, `liencam-planning-cycle`, `liencam-execution-cycle`).

**Sandbox artifacts to re-upload (so the next session resumes the OCCT work, not restarts
it):**

6. `poc_occt_fillet.py` — the proven single-fillet POC.
7. `liencam/geom/occt/fillet.py`, `__init__.py`, `io.py` — the wrapper module.
8. `sandbox_21_occt_transitions.py` — the incomplete full-chain builder (resume point;
   the §4 architecture is the rewrite of this file).

**Fixture:**

9. `Paisley_morph_m0.json` — the R0 fixture (37 rings, 36 transitions; toolRadius 5.0,
   stepover 3.0, cellSize 0.625mm). Parameters in use: R_lead=3.0mm, R_fillet=1.0mm,
   L_wf=4.0mm.

**For the repo-side spike (§5), the next session will also need (via CC, not chat upload):**

10. `src/types/index.ts` (the `MoveRole` taxonomy — the move-type contract).
11. The debug viewer (`debug-viewer-adaptive/morph-viewer.html`) and the existing
    `src/lib/cam/geometry/` shared module (`sampleArc`, etc.) — for understanding the
    integration surface, not yet for editing.

---

## 8. Roles for the next session (unchanged, restated for clarity)

- **Operator** — CNC/CAM domain expert and decision-maker. Reads renders, judges geometric and
  machining correctness, makes the cross-region-order and runtime (§5) domain calls. The
  visual-review gate runs through Operator: nothing proceeds past a sandbox milestone until he
  has looked at the render and given his read.
- **Chat (architect — this assistant)** — owns code/structure/git/thresholds/sequencing/
  ADRs. Builds and runs the sandbox, renders geometry, presents images to Operator, drafts CC
  prompts. Makes the engineering call on Python-vs-WASM (§5) with a recommendation, escalates
  only the genuine domain/product piece of it. Does NOT assert what a render shows — defers
  to Operator (CONVENTIONS §G).
- **CC (Claude Code, local, repo access)** — the worker, for the REPO-side work only. Once
  the sandbox approach is validated visually, CC: runs the `opencascade.js`
  `ChFi2d_FilletAlgo` spike (§5), then implements the chosen runtime integration, the
  canonical element model (`toolpath_element_convention.md`), the OCCT linking, tests, and
  commits. CC cannot see renders (Operator can); CC can see repo code (chat cannot) — pairing
  those two views is how it gets solved. Plan-first cycle (CONVENTIONS) for all non-trivial
  repo work; reconnaissance and execution sessions kept separate.

**What runs where:**
- **Chat sandbox (`/home/claude`, Python + `cadquery-ocp`):** all geometry proving — the
  single-transition end-to-end build, the 36-transition audit, the playback prototype. This
  is where §4 steps 2–5 happen. Fast iteration, full OCCT surface, renders for Operator.
- **Claude Code (local repo, TS):** the `opencascade.js` spike, then the actual engine
  integration — §4 step 6 onward. Only after the sandbox geometry is visually validated.

---

## 9. Self-honest note carried forward

This session spent a lot of iteration trying to patch the chain-assembly heuristics
(solution-side selection, orientation matching) and did not converge — each patch fixed
some transitions and broke others. That non-convergence is itself the signal: it's a
structural problem (proximity-inferred adjacency/direction), not a tuning problem, exactly
as `toolpath_element_convention.md` warned. The right move — made explicitly with Operator — was
to stop patching and architect the end-to-end OCCT approach (§4). The next session should
NOT resume by tweaking `sandbox_21_occt_transitions.py`'s heuristics; it should rebuild the
chain on the §4 architecture (single shared wall curve + canonical orientation +
deterministic motion-direction solution selection). The POC (`poc_occt_fillet.py`,
0.000000/0.0000°) is the anchor of confidence: the primitive is proven correct; the work is
assembling it correctly, with canonical orientation carried through.
```
