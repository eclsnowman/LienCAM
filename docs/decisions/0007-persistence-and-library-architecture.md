# 0007 — Persistence and library architecture

Date: 2026-05-18
Status: Accepted (2026-07-02 — the store implements this: root `toolLibrary`/`machineLibrary` slices, v2 migration lifts the tool library out of `project`, `.camproject` embeds used tools + machine + geometry binaries (schema v4); the save path in src/store/index.ts cites this ADR. Status bumped by housekeeping sweep; decision content unchanged.)

## Context

The tool library and machine library currently live inside the `project` slice of the Zustand store. Every project carries its own copy of every tool and machine the user has configured. The practical consequence: starting a new project means starting from scratch. The user loses all tool definitions and machine configurations accumulated in previous projects. The documented workaround is to manually export tools and machines from one project and re-import them into the next — friction-heavy for what should be routine continuity.

The default machine at first launch is a hardcoded `defaultMachine: MachineConfig` constant in `src/store/index.ts`. This constant is not configurable through the UI and represents an implicit scoping decision: the machine is a project-level concern, seeded once from a hardcoded default. There is no guided first-run experience that asks the user to configure their shop before creating their first project.

Binary geometry presents a related but distinct portability problem. A `.camproject` file is metadata-only — it references geometry by ID but does not embed the binary geometry. The actual STL `ArrayBuffer` and computed 2D loop arrays live in IndexedDB, which is per-browser-and-machine. Transporting a project file to a different browser, incognito session, or different machine leaves the geometry references unresolvable. The project appears to open but the geometry is missing (docs/UI-ARCHITECTURE.md §5.5).

These pain points share a root cause: the scope of each persisted entity — what belongs to the project, what belongs to a shared library, what belongs to the user's global configuration — has never been formally decided. Each piece was designed in isolation with a locally-reasonable default. The aggregate is a system where nothing is truly portable and every fresh project starts empty.

## Decision

Three distinct scopes govern persisted entities in LienCAM:

1. **Project-scoped** — data specific to this CNC job that travels with the `.camproject` file. Geometry references, setups, and operations are project-scoped. A project without these is not a project.

2. **Library-scoped** — data shared across projects and persisted separately from any individual project. The tool library and machine library are library-scoped. The user configures them once; every project can draw from them. The storage mechanism for library-scoped data is specified in ADR 0008.

3. **User-scoped** — defaults and preferences that seed new projects and inform first-run setup. The default machine, unit preferences, and similar settings are user-scoped. These are the user's shop context — they do not belong to any individual project. The first-run wizard (ADR 0009) is responsible for initially populating user-scoped entities.

**Project files are self-contained.** A `.camproject` file embeds snapshots of the tools, machines, and binary geometry it references — not just library IDs. This snapshot-plus-reference approach means the file round-trips correctly across browsers and machines: the geometry binaries are embedded, the tool and machine configs are embedded. Separately, each embedded entity carries the library ID of its source so that "update to the latest version of this tool" workflows are possible at the user's discretion. Projects do not depend on the user's library being present to open correctly.

The mechanism for embedding binary geometry (previously cached only in IndexedDB) is the subject of ADR 0008.

**Workspace concept is deferred.** A workspace — a shared context grouping multiple users or shop stations — is a natural future extension to the library scope, but is not addressed by this ADR. The current model is single-user, single-shop; the user-scoped library acts as the shop context. The scoping architecture does not preclude workspace support as a later layer.

## Alternatives considered

**Status quo — everything project-scoped.** Keep the tool and machine library inside the project state as today. Rejected: the fresh-project-loses-tools problem is real, recurring user friction with no path to cross-project library sharing without a scope redesign.

**User library files alongside projects — simple external persistence.** Persist the library as a separate JSON file that the user manages alongside their projects. Viable in principle, but creates a manual file-management burden and does not solve the IndexedDB binary geometry portability problem. Doesn't materially reduce fresh-project friction — the user still must explicitly import their library file each time.

**Project embeds library snapshot + library is source for new projects.** Selected. The project is fully self-contained via embedded snapshots; the library is the canonical source for new projects and library-managed updates. This approach solves both the portability fragility (binaries travel with the project) and the fresh-project friction (new projects inherit the library).

**Cloud-backed shared library.** A user account with cloud-backed tool and machine libraries, accessible from any browser. Rejected: the no-backend architectural principle (see ADR 0008) is in effect for this milestone. The storage interface is designed to be substitutable, leaving this path open for a future decision.

## Consequences

**Positive:**
- `.camproject` files become genuinely portable — they round-trip across browsers, machines, and browser data-clear events without loss.
- Fresh projects inherit the user's tool and machine library rather than starting empty.
- Library-scoped entities evolve independently of individual projects — tool updates don't require touching every project file.
- The snapshot-plus-library-ID pattern enables a "use latest version of this tool" workflow at apply-time, analogous to how recipes reference tools (ADR 0005).

**Negative:**
- `.camproject` files grow larger once binary geometry is embedded. Projects with many large STL files will produce substantially larger files than today.
- The three-scope model introduces new complexity: code that writes to the store must explicitly decide which scope an entity belongs to.
- Existing `.camproject` files (metadata-only, no embedded binaries) require a migration or compatibility path on import.

## Open consequences

**Format version bump and migration.** The `.camproject` format requires a version field increment and an explicit migration path for files produced under the current format. The most likely approach is to accept existing files — treating absent embedded geometry as a "binaries not embedded; re-import source files to restore" state — and write all new saves in the updated format. The exact migration behavior is an implementation decision for when this ADR is executed.

**Recipe portability coordination.** ADR 0005 defers the recipe system to a future milestone. When recipes are implemented, they will need to coordinate with the library ID model: do recipes reference tools by library ID (pointing at the library for resolution at apply-time) or embed a tool snapshot? The intent of this ADR is that library IDs are the canonical cross-reference mechanism; recipes should use library IDs and let the library resolve them at apply-time. Confirm and document this at recipe implementation time.

## References

- docs/UI-ARCHITECTURE.md §3.1 — current `project` slice shape; `machineLibrary[]` and `toolLibrary[]` noted as scope under review
- docs/UI-ARCHITECTURE.md §5.5 — IndexedDB cache fragility; the portability problem this ADR resolves
- docs/UI-ARCHITECTURE.md §13 — persistence and library architecture (under review)
- ADR 0005 — recipe / template system; coordinates with library ID model
- ADR 0008 — persistent user-space storage (specifies the storage mechanism for library-scoped entities)
- ADR 0009 — first-run wizard (populates user-scoped entities on initial setup)
- ADR 0010 — flexible import system (import pipeline used by wizard and direct library import)
