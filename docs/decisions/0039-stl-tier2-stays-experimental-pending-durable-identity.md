# 0039 - STL Tier 2 stays experimental pending durable identity

Date: 2026-08-11
Status: Accepted; AMENDED IN PART by ADR-0051 (2026-09-22) - see Amendment 1 at
the foot of this file. The amendment carves out STL mesh EDITING keyed to
source-file facet order. Everything this ADR decides about analytic face keys
and about `src/spikes/tier2/` is unchanged.

## Context

The STL Tier 2 Phase 0 spike proved that a bounded recognizer can recover the
plate's planes, bores, cones, closed rims, and manifold shell. It did not prove
that the recovered faces, edges, and loops can be referenced durably after the
same physical part is retessellated.

The follow-up face-key experiment used snapped analytic parameters and passed
the measured corpus, but it also proved that every fixed quantization grid has
a boundary. Moving the grid only moves the failure: a same-face fit can cross a
bucket boundary, while widening the grid enough to hide that miss can merge two
different nearby surfaces. The committed measurement found 230 of 482 keyed
faces closer to a bucket boundary than drift already observed during
retessellation.

The spike is isolated under `src/spikes/tier2/`. Its lane test requires that no
product module import it.

## Decision

Keep `src/spikes/tier2/` as a measurement harness and do not integrate its
recognizer into the product. Retain the product's honest Tier 1 refusal for STL
geometry that needs curved-surface reconstruction.

Product work may resume only after a separate decision identifies a durable,
fail-closed reference source, such as exact source/kernel lineage or another
discrete topological fact available before tessellation, and proves save/load
and retessellation rebinding. A fuzzy resolver may be investigated, but it must
not be represented as a persistent key.

The mixed recommendation and generated spike report remain in `docs/research/`.
The recommendation includes the Phase 0 spike that was implemented as the
measurement harness, while the report remains at the path used by the committed
report generator and boundary tripwire. Retaining either document does not
authorize deletion of the harness or weakening its lane test.

## Alternatives considered

### Ship recognition with exact-buffer-only IDs

Rejected. Those IDs support picks against one active buffer but cannot safely
survive a document save, reload, or changed display tessellation.

### Persist fixed-grid analytic keys

Rejected. The boundary experiment proves that the apparent corpus pass is not
a durable identity guarantee, and a wider grid can merge distinct surfaces.

### Treat fuzzy nearest-surface matching as identity

Rejected as a persisted-key contract. It can return exact, ambiguous, or lost
as a separately named resolver, but guessing would violate fail-closed binding.

## Consequences

- STL Tier 2 recognition remains useful, executable evidence rather than a
  product promise.
- Unsupported curved STL geometry continues to refuse honestly.
- Future Tier 2 work has one explicit prerequisite: durable rebinding evidence.
- The 335-line mixed recommendation and generated result remain active research
  because executable code implements or owns part of each document.

## References

- `src/spikes/tier2/lane.test.ts`
- `src/spikes/tier2/geomkey.ts`
- `src/spikes/tier2/boundary.ts`
- `src/spikes/tier2/boundary.test.ts`
- `docs/research/STL-TIER2-SURFACE-INFERENCE.md`
- `docs/research/TIER2-SPIKE-RESULTS.md`
- `queue/WO-249-triage-the-cam-research-against-what-we-built.md`
- ADR-0051 (the separate decision this ADR's Decision section required)

## Amendment 1 (ADR-0051, 2026-09-22)

This ADR's Decision section allowed product work to resume "only after a
separate decision identifies a durable, fail-closed reference source, such as
exact source/kernel lineage or another discrete topological fact available
before tessellation, and proves save/load and retessellation rebinding."

ADR-0051 is that separate decision, and it is narrow:

- **What it unlocks.** Editing an imported STL, and recognising features in one
  for the purpose of editing it or targeting a toolpath at it, where every
  reference is a FACET INDEX IN THE IMPORTED FILE. For an STL the file is the
  tessellation - we never retessellate it - and its bytes are persisted with the
  project (`src/lib/projectBinaries.ts`), so the reference is discrete, exact
  and survives save/load with nothing to rebind.
- **What is unchanged.** Persisted analytic face keys (snapped axis/radius/plane
  parameters used as identity) remain rejected on this ADR's measured evidence.
  `src/spikes/tier2/` remains a measurement harness, its lane test stands, and
  no product module may import it.
- **What is still open.** Nothing here applies to meshes we tessellate ourselves
  from a kernel body; those still have no durable identity and still need their
  own decision.
