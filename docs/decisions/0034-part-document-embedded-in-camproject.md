# 0034 - Part document embedded in .camproject as a nested versioned archive

Date: 2026-07-16
Status: Proposed

Companion to docs/planning/INT-13-WORKBENCH-INTEGRATION-SPEC.md (section 4).
Work order INT-13.

## Context

The 3D modeling workspace (`SolidsWorkbenchPage`) is a full parametric B-rep modeller
- feature tree, sketches, extrude/fillet/shell, rollback, folders - that
today saves nothing. Its work exists only in memory, and the only route to
it is hand-typing `?lab3d=1&workbench=1`. the operator's INT-13 direction is to
integrate it into the mainline UI, and one of the four fixed targets is:
3D modeling workspace work saves into the `.camproject` recoverably and editably, and
CAM operations bound to the model still resolve after a reload.

### There are two persistence systems, and they do not know about each other

A recon at 883b7082 established this in full. It is the central fact this
ADR responds to.

| | `.camproject` (LIVE) | `doc/persist` zip (DORMANT) |
|---|---|---|
| Wired to production | yes - `store/index.ts:3469` save, `:3513` load | **no - zero non-test importers** |
| Current version | **8** (`projectMigrations.ts:22`) | **3** (`doc/persist/versioning.ts:3`) |
| Registration | ordered array `Migration<T>[]` (`projectMigrations.ts:457`) | mutable `Map` + side-effecting `registerMigration` (`versioning.ts:36-43`) |
| Step signature | `(data: T) => T`, `to` = version produced | `(pkg: MigrationPackage) => MigrationPackage`, keyed by **from** |
| Newer-file refusal | `UnknownSchemaVersionError` (`schemaMigration.ts:71`) | `FutureSchemaVersionError` (`versioning.ts:47`) |
| Post-step version check | **none** | yes (`versioning.ts:59-65`) |
| Missing step | `MissingMigrationError` (`schemaMigration.ts:77`) | `SchemaMigrationError` (`versioning.ts:56`) |
| Absent version stamp | `= 0`, migrates (`projectMigrations.ts:511`) | **throws** (`versioning.ts:72-73`) |
| Byte determinism | none - `JSON.stringify(..., null, 2)` (`index.ts:3502`) | full - `stableStringify` + fixed `ZIP_OPTIONS` (`format.ts:89`) |
| Autosave | none | `AutosaveController`, unused (`autosave.ts:22`) |
| Payload | one JSON blob, base64 binaries inline (`index.ts:3483`) | zip, one entry per body (`format.ts:180`) |

**`.camproject`** is plain JSON at schema v8. `saveProjectToFile`
(`store/index.ts:3469-3511`) spreads the whole live `Project` and overrides
four fields, so any field on `Project` rides along implicitly - this is
exactly why `Operation.modelReferences` needed no serializer change. It
already embeds binary payloads base64 via `collectProjectBinaries`
(`:3483`, added at schema v4). It has no `dag` field.

**`doc/persist`** is a real, tested, versioned document format -
`liencam-3d-zip` (`format.ts:91-146`): a manifest plus `document.json`
carrying `dag`, `elementMapDeltas`, `parameters`, `sketches`,
`camBindings`, `bodyCaches`, `rollback` and `folders`, with canonical
byte-determinism (`stableStringify`, fixed `ZIP_OPTIONS` at `format.ts:89`,
path-sorted entries) and a migration chain with per-step version
enforcement. It is **entirely dark**: `createDocumentArchive` /
`loadDocumentArchive` have zero production call sites - all ~60 are under
`src/tests/`, and every importer of `doc/persist` in the tree is a test
file.

The dormant format is the more rigorous design. The live format is five
versions ahead and carries all real user data. They disagree on
registration shape, step signature, error taxonomy, post-step checking, and
the meaning of a missing version stamp.

### The CAM/model link already exists, one-directionally

`Operation.modelReferences?: ModelReference[]` (`types/index.ts:597`) is
`{ bodyId, stableIds, role }` (`src/lib/cam/types.ts:22-34`), resolved by
the workbench against the shared `useCamStore` singleton via
`reresolveCamModelRefs` (`SolidsWorkbenchPage.tsx:3038-3118`). But the
referenced dag is **not persisted**, so a reloaded `.camproject` with
model-bound ops has nothing to resolve against. Closing that loop is the
heart of the target.

Note `camBindings` (`format.ts:33,101`) looks like it was reserved for this
and is **not usable**: `format.ts:101` is its only writer, fed solely by
test callers, and **nothing anywhere - including tests - reads it back**.
`loadDocumentArchive` has no parser for it and `LoadedDocument`
(`format.ts:60-70`) has no member for it. The link it reserved got built as
`ModelReference` on the live path instead.

## Decision

**Embed the existing `liencam-3d-zip` archive in `.camproject` as a base64
field, and let the two version axes nest.**

### 1. The field

```ts
// on Project
partDocument?: {
  format: 'liencam-3d-zip'
  bytes: string          // base64 of createDocumentArchive() output
}
```

Optional: absent means "this project has no part model", which is the
correct and common state. It rides the existing whole-`Project` spread at
`store/index.ts:3491-3501`, so no serializer change is needed - the same
implicit path `modelReferences` uses.

The entire `doc/persist` format and its migration chain are reused
**unchanged**. No convergence of the two engines is attempted.

### 2. Nested version axes

- `.camproject` `schemaVersion: 9` says "a `partDocument` field may be
  present".
- The inner archive carries its own `schemaVersion: 3`
  (`doc/persist/versioning.ts:3`) and its own newer-file refusal
  (`FutureSchemaVersionError`, `versioning.ts:47`).

This is ADR-0027's own stated two-axis pattern - a portable document
version distinct from an envelope version - applied one level deeper. The
part document format evolves on its own axis without touching
`.camproject`'s, and vice versa.

### 3. Schema v9 is a version-claim identity transform

Registered in the ordered array at `projectMigrations.ts:457-505`; steps are
looked up by `to === v`, not array position (`schemaMigration.ts:74-79`):

```ts
{
  to: 9,
  description:
    "partDocument envelope (embedded liencam-3d-zip) -- claims the version so older builds fail loud (identity transform)",
  up: migratePartDocumentEnvelope,   // return p
}
```

`CURRENT_PROJECT_SCHEMA_VERSION` (`projectMigrations.ts:22`) goes to 9.

This follows the dominant precedent in that file - v4, v5, v6 and v8 are
all literally `return p` - and specifically the **v5 rationale**
(`migrateCamModelReferenceSemantics`, `:176`), which is the exact analog.
Its own doc records why "additive, so no bump needed" was wrong for
`modelReferences`: an older build "drops the modelReferences, and would
happily recompute/post without honoring the B-rep link (WO CAM-1-R1 finding
3)". Bumping the stamp forces an older build through ADR-0027's newer-file
refusal (`UnknownSchemaVersionError`, `schemaMigration.ts:71`) instead of a
silent semantic downgrade.

**The same failure, and the bound on it.** Without the bump the file would
be stamped v8, an older build would accept it, and it would **edit CAM
while ignorant of the embedded model relationship** - recompute and post
operations whose `modelReferences` point into a `partDocument` it cannot
read, cannot regenerate, and cannot invalidate against. It would render a
model-bound op green and post it, having never checked the geometry the op
depends on. That is the v5 failure exactly, one level up: v5's own doc
says an older build "drops the modelReferences, and would happily
recompute/post without honoring the B-rep link". A v8 build handed a part
model honors nothing about it.

**What this ADR does NOT claim: that the part model is stripped on
round-trip.** It is not, and the v8 path is why. Unknown top-level
`Project` fields survive load and save by spreading:
`migrateProjectData` returns `{ ...migrated, schemaVersion }`
(`projectMigrations.ts:527`), `loadProjectFromFile` builds
`openedProject` as `{ ...migrated, ... }` (`store/index.ts:3566-3571`),
`reconcileLoadedOpLifecycle` returns `{ ...project, setups }` (`:3218`),
and `saveProjectToFile` builds its snapshot as `{ ...project, ... }`
(`:3491-3501`). A `partDocument` property therefore **survives** an
immediate v8 round trip untouched. An earlier draft of this ADR asserted
data destruction here; the code does not support it, and the bump does
not need it.

The v9 bump is grounded in **semantic incompatibility**, not data loss -
which is the same and sufficient grounding v5 shipped on. The data is
preserved; the *meaning* is not honored, and an unhonored dependency that
posts G-code to a machine is the harm.

Old files need no transform: `partDocument` is absent, a legal state. The
unconditional post-chain passes (`projectMigrations.ts:519-535`) are not
used; they exist for backfills that must reach documents already stamped at
current (`:352-361`), which does not apply.

**Consequence:** the stale comment at `types/index.ts:597-601` asserting
`modelReferences` "needs no schema-version bump" contradicts shipped
migration v5 and is corrected as part of this work.

### 4. No body payloads are persisted (`bodyCaches: []`)

`bodyCaches` are stored one zip entry per body,
`'bodies/' + encodeURIComponent(bodyId) + '.brep'` (`format.ts:180-187`) -
the largest thing that could land in a `.camproject`.

They are omitted. `loadDocumentArchive` already calls
`dag.regenerate(elementMap)` (`format.ts:134`): bodies are **derived** from
the dag. `bodyCaches` are a load-time optimization, not a source of truth,
and persisting derived data buys load speed at the cost of file size, a
correctness surface (a cache disagreeing with its dag) and a class of
staleness bugs.

**Omission is an input-side choice; the field is still written.** This
matters because section 2 promises the `liencam-3d-zip` format is reused
**unchanged**, and an "absent field" requirement would break that promise.
`createDocumentArchive` normalizes an omitted input to `[]`
(`format.ts:93`) and **always** serializes `document.bodyCaches`
(`format.ts:102`); the reader requires an array and throws otherwise
(`format.ts:138`, `:240-245`). Passing no `bodyCaches` therefore produces
**`document.bodyCaches === []` with zero `bodies/*.brep` entries** - not a
document missing the field, which this format cannot produce or load.

The decision is stated to match: **`bodyCaches: []` + zero body entries**,
which the unchanged format already supports natively. No format or parser
change is owned by this ADR, and none is needed. (An earlier draft
required field absence; that was unsatisfiable against the live format and
is withdrawn - INT-13D acceptance D4a asserts the `[]` + zero-entries form
instead.)

The archive therefore carries dag + elementMapDeltas + sketches +
parameters + rollback + folders + an empty `bodyCaches` array - all small
JSON.

The cost is regeneration time on load, which is **measured, not assumed**
(INT-13D acceptance D4a). If regen proves too slow, re-introducing
`bodyCaches` is backward-compatible and additive: the input field is
already optional (`format.ts:31`, `bodyCaches?: BodyCacheInput[]` on
`DocumentSaveInput`) and an empty array is already legal on the read side
(`parseBodyCaches` maps any array, `format.ts:239-245`), so a later
archive carrying populated caches loads on a build that wrote none, and
**no `.camproject` version bump would be needed**. That reversibility is
what makes omission the right default.

### 5. Rehydration is a load-boundary concern, not a mount concern

`reresolveCamModelRefs` is defined inside `SolidsWorkbenchPage`
(`:3038-3118`) because that component owns the `GeomClient` and
`bodyHandles`; its sole production call site is `:3216` inside
`fullResync`, after `scheduler.run` (`:3190`) settles. Model references
therefore resolve **only while the workbench is mounted**, and only on a
regen pass.

**Current load behavior, stated exactly.** `loadProjectFromFile`
(`store/index.ts:3513`) does **not** invoke the resolver - the production
call-site census (`rg -n 'reresolveCamModelRefs' src -g '!src/tests/**'`)
returns `:3216` and nothing else. So loading a project today marks nothing
degraded; it leaves every model-bound op carrying its **saved** status,
**unverified** against the current kernel. The op may render green against
a body that no longer exists. That unverified state is what this ADR's
target has to fix.

**The hazard the fix introduces.** The degrade gate at `:3087-3092` emits
all-`'lost'` resolutions for any reference whose body is not live, and it
is unconditional on cause - an empty kernel is indistinguishable from a
deleted body. Under the INT-13 spec's lazy mount, the obvious
implementation ("resolve at load so statuses are real") would call the
resolver **before** the part document rehydrates, against an empty kernel,
and mark **every model-bound op degraded by the act of loading the file**.
That is a silent fallback (ADR-0003) and it fails the target.

To be unambiguous: that degradation is **not** current behavior. It is the
failure mode of a load-boundary resolve call ordered before rehydration -
which is precisely why this decision is about **ordering**, not about
adding a call.

Therefore the dag and `GeomClient` rehydrate at the **project-load
boundary**, owned by a `PartDocumentService` independent of the React
mount. CAM operations depend on the kernel, so kernel liveness cannot be a
function of which workspace the user is looking at. `SolidsWorkbenchPage`
becomes a consumer of that service rather than its owner (INT-13E-a).

**Interim rule until that lands: `pending` is not `lost`.** Ops whose
references have not yet had a chance to resolve render as
pending/unresolved with a stated reason, never `degraded`. `'lost'` means
"the kernel looked and it is gone"; it must not also mean "nobody has
looked yet". Same discipline as the existing interim at
`SolidsWorkbenchPage.tsx:3081-3086` ("degrade-to-lost is the fail-loud
interim (ADR-0003)"), applied one level up.

### 6. Autosave is not adopted here

`AutosaveController` (`autosave.ts:22-136`) is format-agnostic (an opaque
`save: () => Promise<Uint8Array>` producer over a `BinaryDocumentStorage`
seam) and encodes three audit-hardened concurrency invariants: lost-update
(`:88-103`), clean-clobbers-unclean (`:31-35`), and total write order
(`:36-51`, with a generation re-check inside the write's own turn at
`:114`).

But it is **document-scoped**, and after this ADR the part document is not a
document - it is a field inside a `.camproject`, which has never had
autosave. Wiring part-only autosave produces the worst outcome: users learn
that 3D modeling workspace work autosaves and CAM work does not, when the same file
holds both.

Autosave is coherent only as a **project-level** capability, with its own
design (crash-recovery UX, storage backend, conflict-on-reopen). INT-13G
files that follow-up naming `AutosaveController` as the intended engine and
`recoverAutosave` (`:138`) as the recovery entry, so the asset is not lost
a second time.

## Alternatives considered

### A. Inline `document.json` directly into `.camproject` as a JSON field

Rejected. It re-implements a format that already exists and is tested
(`format.ts`), discards its migration chain and its per-step version
enforcement (`versioning.ts:59-65`), and forces a decision about binary
`bodyCaches` bytes in a JSON field. The zip envelope is not incidental
packaging - it is where the determinism guarantees live (`ZIP_OPTIONS`
`:89`, path-sorted entries `:194`, path-sorted manifest `:115`).

### B. Cross-referenced sidecar file (`foo.camproject` + `foo.liencam3d`)

Rejected. It breaks single-file portability, which is a real property users
rely on - a `.camproject` is a thing you email or drop in a folder. It
introduces a whole class of failures the app has no answer for: the sidecar
missing, renamed, stale, or from a different project. `.camproject`
already chose single-file-with-embedded-binaries at schema v4
(`collectProjectBinaries`, `store/index.ts:3483`); a sidecar would reverse
a shipped decision for the part document alone.

### C. Converge the two migration engines, then persist through the unified one

Rejected **for this work**, and not on merit. It is the architecturally
tidiest end state, and the divergence table above is a real debt. But the
engines disagree on five independent dimensions, the `.camproject` engine
guards all live user data across 8 versions, and the WO's scope explicitly
excludes re-deciding shipped architecture. Nesting the axes (decision 2)
gets the target shipped without the fight, and leaves convergence available
later - the nesting does not foreclose it. Worth its own WO.

### D. Adopt the zip format wholesale - make `.camproject` a zip

Rejected. Strictly larger than C: it changes the container for every
existing user file, requires a migration of the live format's own envelope,
and risks all CAM data to deliver a part-model feature. The payoff
(canonical bytes for the CAM half) is real but unrelated to this target.

### E. Persist `bodyCaches` for load speed

Rejected as the default (decision 4), on file size, cache/dag disagreement
risk, and the staleness class. Reversible additively without a version bump
if the measured regen time (D4a) demands it - which is why deferring costs
nothing.

### F. Populate the existing `camBindings` field as the CAM link

Rejected. It has no reader anywhere (`format.ts:101` is the only writer;
`LoadedDocument` has no member for it), and the link it reserved is already
built as `ModelReference` on the live `.camproject` path
(`src/lib/cam/types.ts:22-34`). Populating it would create a **second,
competing** CAM binding with no consumer. Its only current function is as a
determinism canary - the fixture at `persist.test.ts:142` supplies it in
two key orders to prove `stableStringify` canonicalizes them identically.
INT-13D either deletes it or documents it as canary-only.

## Consequences

### Good

- The whole tested `liencam-3d-zip` format and its migration chain go live
  **unchanged** - a dormant, well-built asset becomes the shipping path
  with no rewrite.
- Single-file portability preserved. Save in either workspace writes one
  `.camproject` holding both the CAM project and the part model; Open
  restores both.
- The two version axes evolve independently. Neither format's changes force
  the other's hand.
- Save size is bounded by construction (decision 4), not by a mitigation.
- Older builds **fail loud** on a v9 file (`UnknownSchemaVersionError`)
  rather than silently editing CAM ops that depend on a `partDocument`
  they cannot read or honor (decision 3) - not a data-stripping risk
  (the v8 path already preserves unknown fields untouched), but a
  semantic-incompatibility one, the same class v5 shipped on.
- `pending` vs `lost` (decision 5) closes a silent-fallback hole that a
  naive implementation would have shipped.

### Bad / accepted

- **The engine divergence stands.** Two migration systems, two error
  taxonomies, two answers to a missing version stamp. This ADR nests around
  the problem rather than solving it, and future readers will meet both.
  Accepted deliberately, with alternative C recorded so the debate is not
  re-opened from scratch.
- **Base64 costs ~33% over raw bytes.** Accepted: the payload is small JSON
  after decision 4, and `.camproject` already made this exact trade at
  schema v4 for geometry binaries.
- **`.camproject` still has no canonical serialization** (`JSON.stringify(
  ..., null, 2)`, `store/index.ts:3502`). The inner archive's bytes are
  canonical, so the part document's determinism is preserved inside a
  non-deterministic envelope. Odd, and harmless, and worth knowing before
  anyone writes a byte-comparison test against a whole `.camproject`.
- **Regeneration on load is now on the critical path** for projects with a
  part model. Measured at INT-13D/D4a; reversible via decision 4's fallback.
- **`PartDocumentService` is a real extraction** out of a 6,603-line
  component (decision 5), and it is the largest single lift in the INT-13
  plan. It is what target 4 costs.

### Neutral / follow-ups

- Project-level autosave (decision 6) - INT-13G files it.
- `types/index.ts:597-601`'s stale "no bump needed" comment - corrected in
  INT-13D.
- `camBindings` - deleted or documented as canary-only in INT-13D.
- `src/tests/store/modelReferenceReresolve.test.ts:191` re-implements
  `reresolveCamModelRefs` rather than importing it; the INT-13E-a extraction
  lets it import the real service.
