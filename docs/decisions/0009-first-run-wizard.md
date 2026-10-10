# 0009 — First-run wizard

Date: 2026-05-18
Status: Proposed

## Context

When a new user opens LienCAM for the first time, they arrive at an empty project backed by a hardcoded `defaultMachine: MachineConfig` constant in `src/store/index.ts`. The machine is not configured to any real shop; the tool library is empty. The user must discover through exploration that machine and tool configuration exists, find the relevant modals, configure their shop, and only then begin creating a project. There is no guided path from "blank browser tab" to "first productive operation."

There is no explicit distinction in the current UI between "open an existing project" and "start a new project." From the top toolbar, both paths look similar — the user can import a `.camproject` file or simply start editing the empty state directly. A new user with no existing project file has no obvious entry point beyond poking at the UI.

The UI is explicitly committed to encoding CNC knowledge inline rather than assuming user expertise (docs/UI-ARCHITECTURE.md §14) — detailed help text on every field, diagrams for spatial concepts, explanations of conventions. This commitment applies throughout the operation wizard and configuration modals. It has no analog for the threshold experience: how a new user gets from an empty browser tab to their first successfully generated toolpath.

## Decision

When no project is loaded, the application shows a **landing screen** rather than the empty project shell. The landing screen presents two primary actions:

- **Open Existing Project** — opens a file picker for a `.camproject` file
- **New Project** — proceeds to a new project, with the option to enter the first-run wizard

Selecting "New Project" offers the first-run wizard for users who want guided setup. A **"Skip to empty project"** path exits the wizard immediately for power users and returning users who already have a configured library. The wizard is not blocking: a user who skips can access all wizard functionality later through the machine and tool library modals.

The first-run wizard covers minimum-viable shop configuration in two steps:

1. **Machine setup** — configure the active machine or import one from a file
2. **Optional tool seed** — optionally add initial tools, either by importing an existing library export or by defining a minimal set inline

Both outputs are written to user-scoped storage (ADR 0008) as library-scoped entities (ADR 0007), making them available across all future projects rather than just the current session.

The wizard's import step — loading an existing tool library from a previous LienCAM export or from a timeline-based CAD/CAM system tool library — delegates to the import pipeline defined in ADR 0010. The wizard does not design its own import UX; it provides an entry point into the shared import pipeline.

## Alternatives considered

**Blocking modal on first launch.** Detect "first ever run" and require completing a configuration modal before any other UI is accessible. Rejected: first-run detection via localStorage or site data is unreliable — clearing site data re-triggers it, which disrupts returning users who have cleared their browser. A blocking modal with no recovery mechanism creates a degraded experience in common browser hygiene scenarios.

**Stepped wizard for every new project.** Show the wizard each time the user clicks "New Project," not just on first run. Rejected: too heavy for experienced users creating their second, fifth, or twentieth project. The wizard is appropriate for initial setup; subsequent new projects should inherit the configured library without ceremony.

**Landing screen with optional wizard from New Project.** Selected. The landing screen creates an explicit "no project loaded" state distinct from "project open." The wizard is opt-in from "New Project" rather than forced. The "Skip to empty project" path ensures power users are not delayed. The pattern degrades gracefully: users who skip the wizard on first run can always return to library configuration through the machine and tool modals.

**No wizard — configure via Settings only.** Leave machine and tool configuration entirely to the user discovering the relevant modals. Rejected: this is the status quo, and it fails first-run users. The modals exist but are not discoverable as "first steps." The wizard provides intentional first-run pathfinding without restructuring the underlying modals.

## Consequences

**Positive:**
- New users have a discoverable path from blank application to a configured shop before creating their first project.
- "Open Existing Project" and "New Project" are explicit first actions rather than ambiguously blended under the top toolbar.
- Wizard outputs (machine and tool seed) land in library-scoped storage, benefiting all future projects, not just the one the wizard is associated with.
- The inline educational tone (§14) extends to the threshold experience, not just within the operation workflow.

**Negative:**
- The landing screen adds an extra step before a returning user can reach their project. Mitigation: "Open Existing Project" at the landing screen is a one-click path back, and a recent-projects list would further reduce this friction.
- The wizard adds a UI scope commitment for first-run design that is not yet resourced. Minimum viable and full-featured implementations span a wide range.

## Open consequences

**Minimum viable wizard step.** Machine configuration is a prerequisite for generating operations — the operation contract requires a machine for work envelope checking. Whether at least one tool must also be defined before the wizard exits, or whether the user can proceed to an empty tool library and add tools later, is an implementation decision. Both are defensible; the wizard UX should state the consequence clearly ("you will need to add a tool before generating your first toolpath").

**Sample projects and templates.** The wizard may offer to load a sample project as a starting point for new users who want to explore before configuring their own shop. Sample management is a separate concern from the wizard itself — the wizard can include a "Load a sample project" shortcut without owning the sample library.

**Re-run access.** Users who skipped the wizard on first run, or who want to reconfigure their shop context after the fact, need a permanent re-entry point. A "Reconfigure Setup" or equivalent option under Help or Settings provides this without requiring the user to clear their library to start over.

## References

- docs/UI-ARCHITECTURE.md §2 — top-level layout; the landing screen replaces the empty-project default as the entry state
- docs/UI-ARCHITECTURE.md §13.1 — `defaultMachine` is currently a hardcoded constant; the wizard-configured user-scoped entity replaces it
- docs/UI-ARCHITECTURE.md §14 — UI educational commitment; the wizard extends this commitment to first-run
- ADR 0007 — defines user-scoped and library-scoped entities that the wizard populates
- ADR 0008 — storage layer that the wizard writes to
- ADR 0010 — flexible import pipeline that the wizard's import step delegates to
