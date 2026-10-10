// Document-agnostic versioned migration engine (ADR-0027).
//
// A reusable migration-chain runner: given a document, its read version, the
// current target version, and an ordered list of migration steps, it applies
// each step in strict order from `from+1` up to `current`. It is the generic
// substrate for the project-document chain (projectMigrations.ts) and any future
// versioned document (e.g. settings).
//
// Fail-loud both ways (ADR-0003, no silent fallbacks):
//  - a document NEWER than we support -> UnknownSchemaVersionError
//  - a gap in the registered chain   -> MissingMigrationError (a dev bug)
//  - already current (from === current) -> no-op: returns the input UNCHANGED,
//    so a current document is byte-identical through the engine.

/** One ordered migration step. `to` is the version this step PRODUCES (it
 *  migrates a document at version `to-1` up to `to`). `up` MUST be pure — it
 *  never mutates its input. */
export interface Migration<T> {
  to: number
  description: string
  up: (data: T) => T
}

/** Thrown when a document's version is NEWER than the current target — i.e. it
 *  was written by a future app version we cannot safely read (ADR-0003). Carries
 *  both versions so the caller can surface a precise "please update" message. */
export class UnknownSchemaVersionError extends Error {
  public readonly dataVersion: number
  public readonly currentVersion: number
  constructor(dataVersion: number, currentVersion: number) {
    super(
      `Unknown schema version ${dataVersion}: this document was created with a ` +
        `newer version of the app (this build supports up to version ${currentVersion}).`,
    )
    this.name = 'UnknownSchemaVersionError'
    this.dataVersion = dataVersion
    this.currentVersion = currentVersion
  }
}

/** Thrown when the migration chain has no step producing some version in the
 *  range being applied — a gap in the registered chain (a developer bug, not a
 *  user-data condition). */
export class MissingMigrationError extends Error {
  public readonly missingVersion: number
  constructor(missingVersion: number) {
    super(
      `Missing migration: no step produces schema version ${missingVersion}; ` +
        `the migration chain has a gap.`,
    )
    this.name = 'MissingMigrationError'
    this.missingVersion = missingVersion
  }
}

/**
 * Apply the ordered migration chain to take `data` from version `from` to
 * `current`. Steps are matched by `to === v` for each v in `from+1..current`.
 *
 *  - `from > current`        -> throws UnknownSchemaVersionError(from, current)
 *  - no step produces some v -> throws MissingMigrationError(v)
 *  - `from === current`      -> returns `data` unchanged (byte-identical no-op)
 */
export function runMigrationChain<T>(
  data: T,
  from: number,
  current: number,
  migrations: Migration<T>[],
): T {
  if (from > current) {
    throw new UnknownSchemaVersionError(from, current)
  }
  let d = data
  for (let v = from + 1; v <= current; v++) {
    const step = migrations.find((m) => m.to === v)
    if (!step) {
      throw new MissingMigrationError(v)
    }
    d = step.up(d)
  }
  return d
}
