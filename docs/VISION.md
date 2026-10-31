# LienCAM — Vision and Path

> **What this document is.** The single statement of WHY this project exists, WHAT
> "done well" looks like, and the PATH we are on. Everything tactical defers to
> [queue/](../queue/) (rule 2: the one backlog, live + [archive](../queue/archive/),
> is the authority for delivered-vs-not and build sequencing). If this document
> and the code disagree, the code wins; fix this document at the next
> housekeeping sweep.
>
> Last verified against HEAD: 2026-09-22 (cb9acea25).

## Why this project exists

Hobby and small-shop CNC users have no great CAM option they actually own:

- The dominant tool (timeline-based CAD/CAM system) is proprietary, cloud-tethered, and its free
  tier has been repeatedly cut. Your workflow can be taken away or re-priced at
  any time.
- Open-source alternatives (open-source CAD/CAM system Path, and browser tools like browser-based CAM system) are
  either hard to use, incomplete for real 2.5D machining workflows, or both.
- CAM is the last link between design and a spinning cutter. A tool that
  generates motion for a machine you stand next to should be inspectable,
  local-first, and honest about what it does not know.

LienCAM exists to close that gap: a CAM (and increasingly CAD) system that
is genuinely open source, runs entirely in the browser with no backend, no
cloud, no accounts, and treats correctness and trust as features — not
marketing.

## The goal

**A class-leading open-source CAM and CAD system.**

> **The CAD half, stated plainly (added 2026-07-10, the operator goal-clarity
> directive):** the 3D modeling program builds a parametric modeling
> environment - sketches on real planes and faces, a design tree,
> features, direct editing and defeaturing - so a part can go from idea
> to toolpath without ever leaving this tool. Its experience bar is
> the operator's hands on the real app (workflow parity with mature parametric CAD systems for the workflows
> he uses), never a metric. Canonical plan: queue/ (rule 2 - the CAD/3D
> modeling work orders); live progress: the Mission Control capabilities tab;
> structure: [ARCHITECTURE.md](ARCHITECTURE.md)'s B-rep model kernel (ADR 0018).

"Class-leading" is a checklist, not a slogan. It means:

1. **Trustworthy toolpaths.** Operations either produce correct motion or fail
   loudly with a reason. No silent empty toolpaths, no silently stale G-code.
   (ADR-0003 fail-loud; posting is setup-scoped and never emits stale output.)
2. **The software just knows.** The UX north star: *select on the model, and
   the software just knows* — geometry-driven smart selection and smart
   heights instead of mode-picking and manual numbers. Many paths to the same
   result; never many modes.
3. **Complete hobby 3-axis workflow, end to end.** Import (STL/STEP/DXF/SVG) or
   sketch parametrically -> set up stock and WCS -> generate 2D/2.5D toolpaths
   (contour, pocket, adaptive clearing, face, drill, bore, chamfer, engrave, thread
   mill) plus 3D FINISHING and 3D ADAPTIVE ROUGHING shipped (M1 v0.9.0 / M2
   v0.10.x incl. side entry v0.10.2; rest machining next) -> simulate against
   stock -> post to your controller (GRBL,
   LinuxCNC, UCCNC) -> run it. No step requires another program or a subscription.
4. **Performance that respects the machine you have.** Toolpath computation in
   Web Workers, simulation that scrubs smoothly, adaptive clearing that
   finishes in seconds, not minutes.
5. **Production-capable over time.** Near-term: quality and functional for
   hobby CNC users. Long-range: class-leading adaptive clearing and rest
   machining suitable for production work.
6. **Contributor-ready.** A stranger (human or AI) can clone, build, read the
   docs, and land a correct change. Boring, popular, openly licensed
   dependencies. Decisions recorded with their reasoning (ADRs).

## Who it is for

- **Now:** hobby CNC users running 3-axis routers and mills (the reference
  machine is a real UCCNC-controlled router — its operator is the project's
  first user and harshest reviewer).
- **Later:** small shops that need dependable 2.5D production CAM without
  subscription lock-in.

## Non-goals (for now)

- No cloud services, no accounts, no telemetry. Local-first is a feature.
- No 4/5-axis machining until the 3-axis story is class-leading.
- No native/desktop port; the browser is the platform (TypeScript is the
  production target — research prototypes in other languages must be ported to
  ship).
- No feature racing against a timeline-based CAD/CAM system's breadth. We win on trust, openness,
  and the core workflow being excellent — not on checkbox count.

## The path

The tactical build plan (what is delivered, what is next, in what order) and
open bugs both live in [queue/](../queue/) (live + [archive](../queue/archive/)),
rule 2's one backlog. This section states only the strategic arc that backlog
serves:

1. **Deep, correct core CAM.** The shipped 2D/2.5D operations become
   boringly reliable on real parts: smart heights as a coherent coordinate
   system (not patches), smart selection collapsing selection modes into one,
   adaptive clearing performance work.
2. **CAD maturity.** The parametric sketch environment and the B-rep/STEP
   kernel grow until simple parts never need an external CAD program.
3. **Trust infrastructure.** Simulation, verification, and fail-loud coverage
   good enough that a user can believe what the screen shows before running
   G-code on iron.
4. **The openness milestone.** GPL-3.0-or-later licensing is shipped. Remaining
   work is to strip research baggage (tracked in queue/), make the README and
   docs contributor-ready, and publish the repository.
5. **Class-leading frontier.** Production-grade adaptive clearing, rest
   machining, 3D toolpaths — the features that make people switch, built on
   the trust earned in 1-3. (3D FINISHING and 3D ADAPTIVE ROUGHING shipped:
   M1 v0.9.0 / M2 v0.10.x incl. side entry v0.10.2; rest machining next.)

## Someday - not scheduled

Aspirational; not on the path above and not a queue/ work order. Anyone who
decides to actually build one of these opens a WO first (rule 2 - the queue
is the one backlog, not this list).

- **First-run wizard.** Guided path from an empty browser tab to a first
  toolpath. Proposed, not decided: [ADR-0009](decisions/0009-first-run-wizard.md).
- **Flexible import system.** Field-mapping recovery UI for tool/machine
  imports with mismatched schemas (e.g. a timeline-based CAD/CAM system
  export). Proposed, not decided: [ADR-0010](decisions/0010-flexible-import-system.md).
- **Multiple workspaces / plates.** Several independent job scenes in one
  project with switching between them (Bambu Studio / Orca Slicer
  build-plate style). Named in [the 2026-07-21 feature hitlist](archive/FEATURE-HITLIST-2026-07-21.md)
  as future; no ADR, no WO.
- **Image underlay.** Calibrate and trace a scan or logo as a sketch
  reference. Named in [the 2026-07-21 feature hitlist](archive/FEATURE-HITLIST-2026-07-21.md)
  as someday (size M); no ADR, no WO.
- **Stock-vs-model deviation heatmap.** Color simulated stock by signed
  distance to the target model surface after a toolpath, so the user sees at
  a glance where material remains or a gouge occurred. the operator request
  2026-06-27, named in [the 2026-07-21 feature hitlist](archive/FEATURE-HITLIST-2026-07-21.md);
  the transparency-toggle stepping stone shipped, the quantitative heatmap
  did not; no ADR, no WO.
- **Windowed / trailing toolpath display.** During simulation, show only the
  moves just before/after the current tool position instead of the full
  path, for readability on complex multi-depth jobs. Named in
  [the 2026-07-21 feature hitlist](archive/FEATURE-HITLIST-2026-07-21.md); the
  basic hide-toolpath toggle and stock-transparency slider shipped
  2026-06-27, the moving-window variant did not; no ADR, no WO.

## How we work (the principles that got us here)

These are engineering values, learned the hard way, that apply to every
contribution — human or AI:

- **The artifact is the truth.** A claim ("done", "matches", "fixed") is
  earned by an inspected artifact — a rendered toolpath, a measured number, a
  real click in the real UI — or it is not made.
- **Reproduce before you fix.** No fix ships for a theorized cause. Profile
  before optimizing.
- **Fail loud.** Silent fallbacks and silent empty results are bugs by
  definition (ADR-0003).
- **Systems, not patches.** A change to a shared code path must be designed
  and regression-tested for every case that flows through it, not just the one
  that prompted it.
- **Port, don't re-derive.** When a validated solution exists (FreeCAD's
  Adaptive2d, PlaneGCS), port it and preserve its invariants rather than
  re-deriving from scratch.
- **Gates measure the real requirement.** A test that can pass while the
  machinist would reject the part is a defect in the test. Strengthen gates,
  never weaken them.
- **Boring, open technology.** Popular, well-documented, permissively licensed
  dependencies unless there is a written reason otherwise.

## Where truth lives (document map)

| Question | Canonical document |
|---|---|
| Why does this project exist; what is the goal? | this file (docs/VISION.md) |
| What is delivered vs not; what bugs are open; what do we build next? | [queue/](../queue/) (live + [archive](../queue/archive/)) (authority; precedence: code > queue > everything else) |
| How is the system structured? | [ARCHITECTURE.md](ARCHITECTURE.md), [UI-ARCHITECTURE.md](UI-ARCHITECTURE.md) |
| How do we write and commit code? | [CONVENTIONS.md](CONVENTIONS.md) |
| Why was a significant choice made? | [decisions/](decisions/) (ADRs, indexed in decisions/README.md) |
| What happened in the last session on a subsystem? | that subsystem's HANDOFF.md / STATUS.md (session continuity; may lag HEAD) |

When documents disagree: **code > queue/ > ADRs/architecture docs >
planning docs > HANDOFF/STATUS > memory.** Anyone finding a disagreement fixes
the lower-precedence document or flags it, rather than propagating it.
