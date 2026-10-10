# 0027 — Versioned project/settings schema with migrate-on-load

Date: 2026-06-20
Status: Accepted

## Context

A saved `.camproject` is a serialized `Project` object (`src/types/index.ts`),
written verbatim by `saveProjectToFile` and read by `loadProjectFromFile`
(`src/store/index.ts`). The persisted localStorage blob is the `partialize`d
store slice (`machineLibrary`, `toolLibrary`, `appSettings`, `project`),
rehydrated by the Zustand `persist` middleware.

Today there is exactly ONE migration: `migrateProjectToHierarchy`
(`src/store/migrateHierarchy.ts`), a pure/idempotent additive backfill of the
coordinate-hierarchy fields (`Project.stocks`, `geometry.stockId`,
`wcs.originBinding`). It runs UNCONDITIONALLY on both the file-load path and the
persist-rehydrate path, detecting "already migrated" by field presence
(`isFullyMigrated`). There is:

- **No schema version on the project document.** `Project.version` is the string
  `'1.0.0'` — human metadata, never used to gate migration.
- **No ordered migration chain.** A second format change would mean a second
  ad-hoc idempotent backfill, with ordering and "did this already run?" logic
  re-invented each time.
- **No fail-loud on an unknown/newer version.** A `.camproject` written by a
  FUTURE app version (fields renamed/removed) would be `as Project`-cast and
  silently half-loaded — a direct ADR-0003 (no silent fallbacks) violation: the
  user gets a plausible-looking but wrong project instead of an explicit "this
  file is from a newer version" error.

The Zustand `persist` config already carries `version: 2` + a `migrate`
callback, but that version axis governs the localStorage BLOB ENVELOPE (slice
layout — e.g. v2 lifted the tool library out of `project` to the root). It is a
different concern from the portable PROJECT DOCUMENT shape. We want a general,
reusable versioning framework before the next data-format change forces another
one-off — the operator prioritized this 2026-06-20 (build it proactively).

## Decision

Introduce a **general, document-agnostic migration-chain engine** and apply it to
the project document as the first concrete instance. Two version axes coexist and
are documented as distinct:

1. **`Project.schemaVersion: number`** — the portable PROJECT DOCUMENT version
   (the `.camproject` file). Owned by this framework.
2. **Zustand `persist` `version`** — the localStorage STORE-BLOB envelope (slice
   layout). Unchanged; continues to govern partialize/merge shape.

### The engine — `src/store/migrations/`

`schemaMigration.ts` (engine, document-agnostic):

```ts
export interface Migration<T> {
  to: number            // the version this step PRODUCES (migrates (to-1) -> to)
  description: string
  up: (data: T) => T    // pure; never mutate the input
}

export class UnknownSchemaVersionError extends Error {}   // data newer than we know
export class MissingMigrationError extends Error {}       // a gap in the chain (dev bug)

// Applies steps from+1..current in order. Fail-loud both ways (ADR-0003):
//  - from > current        -> UnknownSchemaVersionError (file from a newer app)
//  - no step produces v     -> MissingMigrationError (chain gap)
//  - from === current       -> no-op (returns input untouched -> byte-identical)
export function runMigrationChain<T>(
  data: T, from: number, current: number, migrations: Migration<T>[],
): T
```

`projectMigrations.ts` (the project chain):

```ts
export const CURRENT_PROJECT_SCHEMA_VERSION = 1
export const projectMigrations: Migration<RawProject>[] = [
  // v0 (pre-stamp legacy file / persisted blob) -> v1: coordinate hierarchy +
  // sceneStock/fixedStocks defaults. Wraps the existing migrateProjectToHierarchy
  // so file-load and rehydrate share ONE path. Behavior byte-identical to today.
  { to: 1, description: 'coordinate hierarchy + scene-stock defaults',
    up: (p) => migrateProjectToHierarchy(applySceneStockDefaults(p)) },
]

// Files predating the stamp have no schemaVersion -> they are version 0.
export function readProjectSchemaVersion(raw: unknown): number
// Runs the chain from the read version to CURRENT and stamps schemaVersion=CURRENT.
export function migrateProjectData(raw: unknown): Project
```

### Wiring (both load paths route through `migrateProjectData`)

- **`saveProjectToFile`** stamps `schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION`
  onto the snapshot. `defaultProject` carries it too.
- **`loadProjectFromFile`** replaces the inline `sceneStock` defaults +
  `migrateProjectToHierarchy` call with a single `migrateProjectData(parsed)`,
  wrapped in try/catch: `UnknownSchemaVersionError` surfaces an explicit alert
  ("this project was made with a newer version of LienCAM — please update") and
  aborts the load (ADR-0003). The downstream `assignStocks` /
  `rederiveDerivedStockBounds` LOAD processing stays as-is, after migration.
- **`persistMigrate`** delegates its project migration to `migrateProjectData`
  (then keeps its existing `assignStocks` + tool-library lift). The Zustand
  `version` stays `2`.

### Settings

`appSettings` is a flat preferences object merged spread-over-defaults in
`persistMerge` (forward-compatible for additive fields). The SAME engine applies
if a settings field ever needs a real transform (rename/restructure); until then
no settings migrations are registered. The framework covers project + settings;
the project is the concrete instance built now.

## Alternatives considered

- **Keep adding one-off idempotent backfills.** Rejected: ordering and
  already-applied detection get re-invented per change; no newer-version guard;
  the ADR-0003 silent-half-load risk persists.
- **Reuse the Zustand `persist` version for the project document.** Rejected:
  that axis is the localStorage blob envelope (slice layout), not the portable
  file; a `.camproject` has no Zustand envelope. Conflating them couples file
  compatibility to localStorage internals.
- **An envelope `{ schemaVersion, project }` on disk.** Rejected for v1: it
  breaks every existing file (no envelope) and complicates the persist blob
  (which is a multi-slice object, not a bare project). An additive
  `schemaVersion` FIELD on the project is backward-compatible (absent -> v0) and
  works identically for the file and the persisted project slice.
- **Semantic-version (`Project.version` string) gating.** Rejected: a monotonic
  integer is unambiguous for an ordered chain; the semver string stays as display
  metadata.

## Consequences

Positive:
- The next format change is a ONE-LINE registry entry (`{ to: 2, ... }`) plus a
  round-trip test — ordering, idempotency, and the newer-version guard are
  handled by the engine.
- Loading a newer-than-supported file fails LOUD with a clear message instead of
  silently half-loading (closes the ADR-0003 gap on the load boundary).
- File-load and persist-rehydrate share one migration path -> a rehydrated and a
  freshly-opened project provably agree.

Negative / watch-items:
- The v0->v1 step MUST be byte-identical to today's behavior on existing data —
  gated by a no-op/round-trip regression test and the existing
  `projectOpen.test.ts`. The whole point is zero behavior change at v1.
- Every future migration `up` must be PURE and idempotent on its own output, and
  ship with an old-fixture round-trip test (the seed's gate).
- `schemaVersion` is additive/optional on `Project`; readers must treat absent as
  v0, never assume current.

## References

- `docs/planning/MIGRATION-FRAMEWORK-PLAN.md` — recon map, phasing, test gates.
- `src/store/migrations/schemaMigration.ts` + `projectMigrations.ts` (new);
  `src/store/migrateHierarchy.ts` (the v0->v1 step, wrapped); `src/store/index.ts`
  `saveProjectToFile` / `loadProjectFromFile` / `persistMigrate` / persist config;
  `src/types/index.ts` `Project.schemaVersion` (new).
- ADR-0003 (no silent fallbacks — the newer-version fail-loud), ADR-0007 /
  ADR-0008 (persistence + user-space storage, Proposed), ADR-0020 (coordinate
  hierarchy — the v0->v1 migration's content), ADR-0022 (units are app-global and
  deliberately NOT project-migrated).
