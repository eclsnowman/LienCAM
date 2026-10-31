# Architecture Decision Records

Architecture Decision Records (ADRs) capture the *why* behind significant
architectural choices in LienCAM. Each ADR records the context that prompted
the decision, what was chosen, what alternatives were considered, and the
downstream consequences.

ADRs complement the other canonical documents:

| Document | What it answers |
|---|---|
| docs/ARCHITECTURE.md | What the system is |
| docs/CONVENTIONS.md | How we work on it |
| ADRs | Why we made significant choices |

Git history captures the mechanical changes themselves.

## When to write an ADR

Write an ADR when:
- A choice constrains significant future work (naming conventions, interface
  contracts, layering decisions)
- A non-obvious alternative was seriously considered and rejected — capturing
  the rejection reason prevents re-opening the debate
- A future capability is being designed for today, even though implementation
  is deferred
- The decision is cross-cutting: it affects multiple operations, subsystems, or
  the operation contract

Do NOT write an ADR for:
- Implementation details that don't affect the public interface or cross-cutting
  contracts
- Decisions already fully covered in docs/ARCHITECTURE.md (unless the decision history
  is itself valuable)
- Low-stakes choices that are trivially reversible
- Per-operation design notes (those go in STATUS.md)

## Template

Each ADR is a Markdown file named `NNNN-kebab-case-title.md` with this structure:

````markdown
# NNNN — Short descriptive title

Date: YYYY-MM-DD
Status: Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
What question or problem prompted this decision? What did the codebase look like
before this decision was made?

## Decision
What did we choose? Be specific about behavior, signatures, file locations, and
any other concrete details.

## Alternatives considered
What other approaches were considered? Why weren't they chosen?

## Consequences
Positive and negative downstream effects. What future work does this open or close?

## References
Links to relevant code, docs/ARCHITECTURE.md sections, docs/CONVENTIONS.md sections,
related ADRs, and the commit(s) that implemented this decision.
````

## Amendment conventions

ADRs are append-only. The Context / Decision / Alternatives sections are not
edited after the ADR is written. If a decision changes:

1. Mark the original ADR `Status: Superseded by ADR-XXXX`.
2. Write a new ADR capturing the new context, the new decision, and why the old
   decision no longer holds.

The original context and rationale remain valuable even after supersession —
future maintainers can trace the full decision path, not just the current state.

## Active ADRs

- 0001 — [Toolpath/postprocessor separation](0001-toolpath-postprocessor-separation.md)
- 0002 — [Canonical Z vocabulary across operations](0002-canonical-z-vocabulary.md)
- 0003 — [No silent fallbacks for specialized strategies](0003-no-silent-fallbacks.md)
- 0004 — [Two-tier feedrate resolver (no operation-level fallbacks)](0004-two-tier-feedrate-resolver.md)
- 0005 — [Recipe / template system as future requirement](0005-recipe-template-system.md) *(Proposed)*
- 0006 — [Safety fallback feedrate values (300 / 100 mm/min)](0006-safety-fallback-feedrate-values.md)
- 0007 — [Persistence and library architecture](0007-persistence-and-library-architecture.md)
- 0008 — [Persistent user-space storage](0008-persistent-user-space-storage.md) *(Proposed)*
- 0009 — [First-run wizard](0009-first-run-wizard.md) *(Proposed)*
- 0010 — [Flexible import system](0010-flexible-import-system.md) *(Proposed)*
- 0012 — [Grid as occupancy oracle; real geometry for all path representation](0012-grid-as-oracle-real-geometry-paths.md)
- 0013 — [Recursive real-geometry split detection via disjoint-segment wall-follow counting](0013-recursive-real-geometry-split-detection.md)
- 0014 — [Adopt OCCT as the geometry kernel (opencascade.js custom WASM build, in-worker)](0014-adopt-occt-geometry-kernel.md)
- 0015 — [2D Facing operation: scope, boundary-source abstraction, and outward-overrun convention](0015-2d-facing-operation.md)
- 0016 — [Parametric sketch mode on planegcs](0016-parametric-sketch-mode-planegcs.md)
- 0017 — [Machining orientation is canonical for B-rep derivation](0017-machining-orientation-agnostic-derivation.md) *(Proposed)*
- 0018 — [B-rep model kernel: STEP import, face/edge selection, derivation layer](0018-brep-model-kernel.md)
- 0019 — [Loop identity is content-derived and stable across re-derivation](0019-stable-content-derived-loop-ids.md)
- 0020 — [Nested machine/setup/stock/geometry coordinate hierarchy](0020-nested-coordinate-hierarchy.md)
- 0021 — [Postprocessor architecture and post-customization/security model](0021-postprocessor-architecture-and-customization.md)
- 0022 — [Canonical millimeters; convert units only at the two edges](0022-canonical-mm-units-convert-at-edges.md)
- 0023 — [Spatial index (ClearedIndex) for cleared engagement queries](0023-cleared-spatial-index.md) *(Rejected — implemented, measured slower AND not byte-identical; do not rebuild)*
- 0024 — [Instanced nest toolpath and post-expansion contract](0024-instanced-nest-toolpath-post-expansion.md) *(Accepted 2026-06-20; Amendment 1 (P7) supersedes section 3 — inter-copy travel + machining order are generated in software as real ToolpathMove[] via a shared nest expander; the post only formats)*
- 0025 — [Nest as geometry node, seed authoring, and sheet-as-auto-stock](0025-nest-as-geometry-seed-sheet-stock.md) *(Accepted 2026-06-20; Amendment 3 (N1d) corrects the sheet to bind to a FIXED stock with thickness = stock depth)*
- 0026 — [One stock per setup; different-height fixtures use separate setups + combined multi-offset posting](0026-one-stock-per-setup-multi-fixture-posting.md) *(Accepted 2026-06-20; fail-loud guard for a setup spanning >1 stock + global safe-Z retract between work offsets)*
- 0027 — [Versioned project/settings schema with migrate-on-load](0027-versioned-schema-migration-framework.md) *(Accepted 2026-06-20; general migration-chain engine + Project.schemaVersion; fail-loud on a newer-than-supported file per ADR-0003)*
- 0028 — [Voxel stock-removal simulation engine, rendered by raymarching](0028-voxel-simulation-engine.md) *(Accepted 2026-06-22; GPU voxel field + raymarch shipped as default behind appSettings.simulationEngine with GPU auto-fallback to the retained 2.5D heightmap; dense-backed first, sparse bricks + partial-upload perf deferred behind the VoxelField interface)*
- 0029 — [Tool angle stored as angle-from-axis (half-angle)](0029-tool-angle-stored-as-angle-from-axis.md) *(Accepted 2026-06-22; one canonical Tool.angleFromAxisDeg, no `/2` in consumers; included vs per-side conversion at the UI + timeline-based CAD/CAM system-import edges per docs/tool_angle_conventions.md; schema v1->v2 migration; supersedes cd846fd/v0.4.2)*
- 0030 — [Tool geometry as a single tip-up revolved profile; holders and named libraries](0030-tool-geometry-revolved-profile-holders-libraries.md) *(Accepted 2026-06-23; one `buildToolProfile` (`src/lib/tool/toolProfile.ts`) drives the 2D diagram, 3D lathe, and simulation; new Tool fields tipDiameter/neckDiameter/holderId/libraryId; ToolHolder segment-stack + ToolLibrary named libraries; passive shank/holder rub warning (active avoidance deferred); schema v2->v3 migration; builds on ADR-0029 angle convention + ADR-0027 migration chain)*
- 0031 — [Thread-milling operation: pure helix core, bottom-to-top, hand-locked orbit](0031-thread-mill-operation.md) *(Accepted 2026-06-25; Amendments 1-9: thread-teeth+relief tool geometry, chamfer-style smart thread depth + thread passes UI (A1); exit climb + neck->shank transition cone (A2); real per-hole radial span + presets (A3); external threads with reference-direction top/base toggle (A4); in-modal B-rep face/edge/section pick (A5); smart cylinder-pick auto-fill (A6); functional climb/conventional via orbit sense x travel direction (A7); internal lead-out cusp -> tangent exit (A8); external cut to the thread ROOT, not the crest (A9); voxel-sim thread-form carving + full-form toolpath deferred)*
- 0032 — [Project license: GPL-3.0-or-later](0032-project-license-gpl-3.0-or-later.md) *(Accepted 2026-07-02; LICENSE + THIRD-PARTY-NOTICES.md + SPDX LGPL-2.1-or-later headers on the Adaptive2d engine port; AGPL considered and declined; MIT/Apache/MPL legally unavailable due to the LGPL port; **superseded by ADR-0056**)*
- 0033 — [Sketch-level driving dimensions on solver-inert text](0033-sketch-level-driving-dimensions-on-text.md) *(Proposed)*

- 0034 - [Part document embedded in .camproject as a nested versioned archive](0034-part-document-embedded-in-camproject.md) *(Proposed)*
- 0035 - [Capture harness enforces per-shot provenance](0035-capture-harness-enforces-per-shot-provenance.md)
- 0036 - [Landing gates reject new failures relative to a committed red baseline](0036-no-new-test-failures-landing-gate.md) *(Accepted)*
- 0037 - [Work orders pass preflight before lease](0037-work-order-preflight-before-lease.md) *(Accepted)*
- 0038 - [Dispatch history is an append-only ledger](0038-dispatch-history-is-an-append-only-ledger.md) *(Accepted)*
- 0039 - [STL Tier 2 stays experimental pending durable identity](0039-stl-tier2-stays-experimental-pending-durable-identity.md) *(Accepted; Amendment 1 (ADR-0051, 2026-09-22) carves out STL editing keyed to source-file facet order - analytic face keys and the spikes/tier2 lane test are unchanged)*
- 0040 - [No legacy project support before 1.0](0040-no-legacy-project-support-before-1-0.md) *(Accepted)*
- 0041 - [LienCAM speaks its own machine language; controllers are backends](0041-machine-controller-abstraction.md) *(Accepted)*
- 0042 - [The machine definition is controller-shaped](0042-the-machine-definition-is-controller-shaped.md) *(Accepted)*
- 0043 - [The live program builder owns the geometry path and inherits the post's responsibilities](0043-live-program-builder-owns-the-geometry-path.md) *(Accepted 2026-08-26; the operator "Agree - proceed" + machine seat Amendment 1; unblocks WO-1019, the bridge path the operator wants to measure)*
- 0050 - [The surface map is a session-time correction owned by the machine session](0050-surface-map-is-a-session-time-correction.md) *(Accepted 2026-09-22; ratifies the shipped zSurfaceMesh feature (ea13a854b), names gaps G1-G7 for WO-1822, decides the geometry route gets its own consumer of the same math)*
- 0051 - [An STL carries its edits as a replayed journal over its own bytes](0051-an-stl-carries-its-edits-as-a-replayed-journal.md) *(Accepted 2026-09-22; amends ADR-0039 in part - facet-index identity over persisted source bytes; source bytes + ordered edit journal replayed through ONE resolver on every route, never baked; promotion to B-rep unchanged and still preferred where it applies; ported from LienCAM-next's approach, not its kernel - WO-1836 gates only WO-1852; gates WO-1845..1852)*
- 0052 - [The geometry kernel's build recipe lives in this repository](0052-the-kernel-build-recipe-lives-in-this-repo.md) *(Accepted 2026-09-23 on the operator's D11 ruling; patches/occt-wasm-3.6.1-geo9-defeature.patch + pristine xtask/ + Dockerfile reproduce vendor/occt-wasm/occt-wasm-3.6.1-geo9-bk65.tgz's occt-wasm.wasm BYTE-FOR-BYTE (sha256 a3c02c79...); the notice's cited files now exist; unblocks WO-1824 and WO-1837 and lets the LienCAM-next history patches be judged on merit - taking them stays a separate decision; the shipped tarball is unchanged)*
- 0053 - [Indexed first: a rotary orientation is a Setup, and CAM stays Cartesian](0053-indexed-rotary-is-a-setup-orientation.md) *(Accepted 2026-09-23, WO-1838, on the operator's D8 "4axis framework in time"; FRAMEWORK only - nothing implemented. Indexed before wrapped; an orientation is its own Setup joined by `orientationOf`, the way `flipOf` already joins a second side; the rotary CENTRELINE is setup data, not machine data; CAM never writes `a`/`b`/`c` on a move - the A word enters only at the post's section boundary after the global safe-Z retract; section 6 lists the six "cleanups" that would close the door)*
- 0054 - [What a LinuxCNC backend needs from the controller contract](0054-what-a-linuxcnc-backend-needs-from-the-controller-contract.md) *(Accepted 2026-09-23, WO-1844; ANALYSIS only - nothing implemented. Of the five candidates the Next sweep raised: ADOPT an explicit UNKNOWN command outcome (a timeout already reported a running probe as a failure) and ADOPT an optional joints read beside the Cartesian pose (the operator's machine is a slaved gantry - four joints, three axes); KEEP stop on its own path, which the bridge's `StopNow` class already enforces end to end, owing only a comment on `controller.ts:1234`; NOT NEEDED, the session-invalidating monotonic clock - but convert interval arithmetic to `performance.now()` anyway, on its own order; REJECTED, "a stale snapshot forbids everything except stop", which would refuse what the software can do. The contract prerequisite is two additive optional changes plus one comment; the cost is the transport and ADR-0048 test equipment)*
- 0055 - [An AI agent works in the user's project through the command layer, never the machine](0055-an-agent-works-in-the-project-through-the-command-layer.md) *(Accepted 2026-09-30 from the operator's rulings 09-29/30: desktop only; the agent edits the project directly, undoable like a dialog; CAM strategy first, modeling close behind; no machine motion through MCP, ever; additive only - every internal dev hook and the machine seat's route stay. Brief: docs/design/AGENT-MCP.md)*
- 0056 - [Project licence: Apache-2.0, with the Adaptive2d engine a marked LGPL module](0056-project-licence-apache-2-0.md) *(Accepted 2026-10-01 on the operator's licence and copyright cards; supersedes ADR-0032 and deliberately gives up its "forks must stay open"; exceptions: `src/lib/cam/adaptiveClearing2d/engine/` LGPL-2.1-or-later, `pendant/linuxcnc-gateway/` GPL-3.0-or-later as a separate program; NOTICE "Copyright (c) 2026 Eric Lien and LienCAM contributors")*
- 0058 - [Controller software and firmware versions: know them, never flash, refuse only what cannot run](0058-controller-software-and-firmware-versions.md) *(Accepted 2026-10-15 on the operator's D1-D4; plan docs/machine/CONTROLLER-VERSIONS-PLAN.md)*
- 0059 - [An update keeps your data: user data survives every app update, even before 1.0](0059-an-update-keeps-your-data.md) *(Accepted 2026-10-17, WO-2883; ADR-0040 still governs project files. Frozen: appId com.liencam.desktop, productName LienCAM (the userData folder), the liencam://app origin, the userData path; NSIS deleteAppDataOnUninstall stays off; a store-key change reads the old key and keeps its value; pinned by src/tests/lib/update/keepsUserData.wo2883.test.ts; oracle = before/after diff of every stored value on a scratch copy of a real profile)*

## Superseded ADRs

- 0011 — [2D layer editing tools (Sketch mode)](0011-2d-layer-editing-tools.md) —
  superseded by ADR-0016 in its non-parametric scope; the fourth-view-mode and
  read-only-STL-projection decisions carry forward
- 0032 - [Project license: GPL-3.0-or-later](0032-project-license-gpl-3.0-or-later.md) -
  superseded by ADR-0056 (Apache-2.0 for LienCAM's own code, 2026-10-01)
