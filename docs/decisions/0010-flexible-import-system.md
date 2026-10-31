# 0010 — Flexible import system

Date: 2026-05-18
Status: Proposed

## Context

LienCAM currently imports tools and machines via per-format importers. Each importer knows the exact field names and structure of its target format and either maps the input successfully to the internal type or rejects the file. When an imported file has an unexpected field name — from a different timeline-based CAD/CAM system export context, a different schema version, or a different CAM application — the importer fails silently or surfaces a generic error with no recovery path.

The class of problem was documented directly in docs/UI-ARCHITECTURE.md §3.5: `loadProjectFromFile` previously accepted any JSON file (including a bare `tools.json`) and cast it as `Project`, producing a blank-screen render crash when the cast produced invalid state. The subsequent fix added import validation — but validation without a recovery UI still produces a reject-or-nothing outcome. When the input is valid JSON, the intent is clear, and the failure is a field-name mismatch, rejection without recovery is the wrong outcome.

The concrete forcing function is timeline-based CAD/CAM system compatibility. Users commonly export tools and machines from timeline-based CAD/CAM system and want to import them into LienCAM. timeline-based CAD/CAM system uses its own field naming conventions, which do not map directly to LienCAM's internal types. Bridging this today requires either a timeline-based CAD/CAM system-specific importer — brittle to timeline-based CAD/CAM system schema changes — or a general mechanism that surfaces field mapping explicitly to the user.

The destination scope for imported entities is defined by ADR 0007 (project-scoped, library-scoped, or user-scoped). This ADR specifies the pipeline that validates and maps structured data before it reaches that destination.

## Decision

All structured data import (tools, machines, recipes when implemented) passes through a **four-layer pipeline**:

1. **Permissive parse.** Parse the input as JSON without enforcing a schema. Unknown fields are retained, not dropped. Valid JSON that does not match any known LienCAM schema is not rejected at this stage.

2. **Semantic validation.** Verify that required fields are present and carry the correct types. Fields that are present with the correct name and type pass through. Fields that are absent, misnamed, or have the wrong type proceed to the mapping layer.

3. **Field-mapping UI.** When required fields are absent or differently named, present the user with a mapping dialog. The dialog shows the fields detected in the input file alongside the required fields in the LienCAM schema. The user maps unresolved fields, supplies defaults for fields with no input equivalent, or cancels the import. Silent data drop is not acceptable — every unresolved required field becomes an explicit user decision.

4. **Scoped write.** Write validated and mapped entities to the appropriate scope per ADR 0007. Library-scoped entities go to the library; project-scoped entities to the project.

**Format-specific knowledge lives in mapping presets, not in bespoke code paths.** A mapping preset is a JSON file that pre-populates the field mapper for a known input format — naming which input fields correspond to which LienCAM fields and providing default values for fields with no input equivalent. Adding support for a new import format is a mapping preset, not a new code path. The pipeline detects the probable source format from file structure and pre-populates the mapper accordingly; users can override the auto-detected preset.

## Alternatives considered

**Per-format explicit importers — extend the status quo.** Write a dedicated importer for each supported format (LienCAM native, timeline-based CAD/CAM system, engagement-controlled adaptive clearing system, etc.). Rejected: the number of importers grows with the number of supported formats, each with its own maintenance surface. When a format changes schema versions, the corresponding importer must be updated. There is no shared recovery path — each importer either succeeds or produces an opaque failure.

**Generic field mapper only — no presets.** Show the field-mapping dialog for every import with no pre-population. Rejected: for well-known formats (timeline-based CAD/CAM system, LienCAM native export), requiring the user to manually map every field is unnecessary friction. Presets eliminate the friction for common cases while preserving the general mechanism for uncommon ones.

**Four-layer pipeline with presets.** Selected. The pipeline is the general mechanism; presets are the format-specific knowledge. Common formats work with one click; partially-matching or unfamiliar formats engage the mapping UI. New formats are additive — a new preset file, not a structural code change.

**Reject on schema mismatch — stricter validation.** Require an exact schema match and reject anything that does not conform. Rejected: this is the current failure mode that this ADR addresses. Strict rejection is appropriate for malformed or malicious input; it is not appropriate when the input is valid, the intent is clear, and the only obstacle is a field-name mismatch that the user can resolve.

## Consequences

**Positive:**
- Adding support for a new tool or machine format is a preset file, not a code change. Format support grows without code complexity growth.
- Users with valid data in non-matching formats get a recovery path rather than a silent rejection.
- The permissive parse layer provides forward compatibility: when LienCAM's schema adds a new field, existing files with older schemas engage the mapping UI for the new field rather than failing entirely.
- The pipeline is shared across all import entry points — the wizard import step (ADR 0009), the direct library import buttons, and future recipe import (ADR 0005) all use the same infrastructure.

**Negative:**
- The field-mapping dialog adds UI surface that must be designed, tested, and maintained.
- Mapping presets are data files that must be kept accurate as both external formats and LienCAM's internal schema evolve. Stale presets are worse than no preset — they pre-populate the wrong mappings.
- The permissive parse layer passes malformed input further into the pipeline before it fails. The semantic validation layer must reliably catch what the permissive parse layer lets through.

## Open consequences

**timeline-based CAD/CAM system reference schema.** The initial timeline-based CAD/CAM system mapping preset requires deciding which timeline-based CAD/CAM system export context is the baseline — specifically the tool library export ("Manage → Tool Library → Export") from a specific timeline-based CAD/CAM system version. a timeline-based CAD/CAM system's export schema has evolved; the preset should document its source version and export path so it can be updated when the schema changes.

**Partial import UX.** When the user reaches the field-mapping dialog and leaves some required fields unresolved — either no source field maps to them, or the user explicitly skips them — two behaviors are defensible: proceed with schema-default values for unresolved fields, or block the import until all required fields are resolved. The right choice depends on the field: some fields have safe defaults (name, description), others do not (tool diameter, machine travel limits). The UX for partial resolution is an implementation decision.

**Machine import scope.** Third-party machine configuration import — loading a machine from a CNC manufacturer's provided file or from another CAM application's export — is a natural extension of the import pipeline, but the priority and relevant source formats are not yet determined.

## References

- docs/UI-ARCHITECTURE.md §3.5 — import validation history; the class of problem this pipeline addresses
- docs/UI-ARCHITECTURE.md §15.5 — flexible import system noted as already queued from concrete timeline-based CAD/CAM system compatibility pain
- ADR 0007 — persistence and library architecture; defines the scopes that the pipeline writes to
- ADR 0005 — recipe / template system; shares this import pipeline when recipes are implemented
- ADR 0009 — first-run wizard; delegates its import step to this pipeline
