# 0011 — 2D layer editing tools (Sketch mode)

Date: 2026-05-18
Status: Superseded by ADR-0016

## Context

LienCAM imports 2D geometry from three sources: STL slice-and-project, DXF files with native layers, and SVG files with native groups. In practice, imported geometry frequently needs cleanup or augmentation before it is ready for defining operations. A DXF exported from a CAD system may have near-coincident endpoints that the loop optimizer handles as disconnected segments. An SVG tracing may have open paths that need closing. A user may want to add a feature — a hole, a slot, a pocket boundary — that was not in the original design file.

LienCAM currently has no mechanism for modifying or extending 2D layer geometry inside the application. The loop optimizer handles some classes of noisy geometry automatically, but it operates on loop topology, not on individual segments. Users who need to edit geometry must return to their source CAD application, modify the file, re-export, and re-import — a round-trip disproportionately expensive for what is often a one-segment fix.

docs/UI-ARCHITECTURE.md §6.6 identifies 2D layer editing as **high-priority work to land before 3D toolpath operations begin**, because it unlocks meaningful productivity on the existing 2D-operation foundation while deeper B-rep / 3D-toolpath infrastructure matures. docs/UI-ARCHITECTURE.md §15.6 restates the dependency: 3D toolpath operations require reliably clean geometry that the current import path cannot guarantee.

The existing view mode system (docs/UI-ARCHITECTURE.md §4) defines three top-level modes — Setup, Toolpath, and Simulation — each with a mode badge and a distinct visualization stack. Layer editing requires a context separated from Setup mode's "configure operations" purpose. Combining drawing and editing tools into Setup mode would create an ambiguous interaction surface in a mode already managing geometry selection, WCS positioning, stock configuration, and viewport interaction modes.

## Decision

Introduce **Sketch mode** as a new top-level view mode alongside Setup, Toolpath, and Simulation, accessible via the top bar mode selector. Sketch mode has its own mode badge and its own mode-specific toolbar, following the pattern established by the existing three modes.

Sketch mode supports two primary workflows:

1. **Edit existing layer geometry.** The user selects an existing layer from the design tree and enters Sketch mode to modify its geometry — extending lines, trimming intersections, joining disconnected segments, correcting near-coincident points.

2. **Create new blank geometry.** The user creates a new empty layer and enters Sketch mode to draw geometry from scratch — pocket boundaries, contour profiles, drill hole patterns that were not part of any imported file.

Sketch mode operates on the `layers2d` data unit (docs/UI-ARCHITECTURE.md §3.1) — the same loops consumed by operations. It does not operate on raw imported mesh data or STL projections; STL projections remain point-in-time snapshots of the projection operation and are not subject to sketch editing.

The mode-specific toolbar includes drawing and modification tools. The initial toolset candidates are: **Lines, Circles, Arcs, Extend, Trim, Array**, and similar CAM-prep tools. The complete toolset inventory is an implementation decision for when this ADR is executed. This ADR establishes the mode and its design intent, not the final inventory.

This expands the original "targeted in-viewport cleanup" framing to a **purpose-built 2D sketcher for CAM layer preparation** — occupying the space between simple cleanup and full parametric 2D CAD. Sketch mode is not parametric: geometry is direct-manipulation, not constraint-driven. The toolset is practical for CAM layer preparation, not comprehensive for general drafting.

## Alternatives considered

**No in-app editing — rely on external CAD for all modification.** Keep the round-trip to external CAD as the only editing path. Rejected: the round-trip cost is disproportionate for routine cleanup. Reconnecting a broken endpoint, trimming an overshoot, or adding a simple circle takes seconds in a drawing tool and should take seconds in LienCAM.

**Full 2D CAD module with parametric constraints.** Implement a constraint-based parametric 2D CAD system inside LienCAM. Rejected: parametric constraints represent substantial additional scope — constraint solver, constraint UI, history-based modification — not required for the use case. The use case is CAM layer preparation, not parametric design.

**Targeted in-viewport editing within Setup mode.** Add drawing tools directly to Setup mode rather than creating a separate top-level mode. Rejected: Setup mode already manages geometry selection, WCS positioning, stock configuration, and multiple viewport interaction modes (docs/UI-ARCHITECTURE.md §6.1). Adding drawing tools to this context creates an ambiguous interaction state machine where clicking in the viewport could mean WCS snapping, geometry selection, loop picking, or drawing, with no clean modal boundary between them. The conceptual mismatch is also significant: Setup mode's purpose is "configure operations," not "author geometry."

**New Sketch top-level mode.** Selected. Follows the established view mode pattern. Keeps editing concerns separated from Setup mode's configuration concerns without restructuring either. Provides a dedicated toolbar surface for the editing toolset.

## Consequences

**Positive:**
- The round-trip to external CAD for single-segment edits is eliminated.
- New geometry can be authored entirely within LienCAM for parts that do not originate from a CAD file.
- Sketch mode's clean separation from Setup mode preserves Setup's existing interaction model without adding state machine complexity.
- The expanded scope — from "targeted cleanup" to "CAM sketcher" — provides a more complete surface for 2D operation workflows before 3D toolpaths require B-rep geometry.

**Negative:**
- A new top-level mode adds navigation to the top bar and increases the conceptual surface area of the application.
- The mode-specific toolbar is a new UI surface that requires design and implementation. The toolbar system is an implementation detail that Sketch mode requires but does not yet exist.
- Sketch mode introduces the concept of "user-authored geometry layers" that must be handled distinctly from "imported geometry layers," particularly at re-import time.

## Open consequences

**Toolbar tool inventory.** Lines, Circles, Arcs, Extend, Trim, Array are the initial toolset candidates. What "Array" covers — linear, radial, or both — and the full toolset beyond these candidates is to be specified during implementation planning. This ADR establishes the mode and its purpose; it does not commit to a final tool count or inventory.

**Polyline join wizard.** Reconnecting near-coincident but disconnected endpoints into closed polylines is a high-value operation for imported geometry cleanup. It is non-trivial: it requires proximity matching (at what tolerance?), ambiguity handling (which segment connects to which when multiple candidates are nearby?), and gap-bridging decisions (fill with a line, extend existing segments, or snap to the nearest point?). Whether the polyline join wizard ships in the first Sketch mode implementation or is deferred as a follow-on is an open prioritization question.

**Edited-layer re-import behavior.** When a user has made sketch edits to a layer derived from a DXF or SVG import, and then re-imports the same source file, the current import model would overwrite the layer. This is destructive without warning. The implementation must decide between: (a) flag user-edited layers and warn before overwrite, (b) offer a merge workflow that preserves user-authored geometry, or (c) prohibit re-import onto edited layers. This behavior is an open implementation decision.

**Source restrictions.** Whether Sketch mode can edit STL-projection layers — currently read-only point-in-time snapshots — or only DXF/SVG-native and user-created layers is an open question. The intent of this ADR is that STL-projected layers remain snapshots; Sketch mode operates on layers not bound to a projection computation. This distinction should be enforced and surfaced clearly in the UI at implementation time.

**Mode transition behavior.** What happens to the current viewport selection, active operation, and active setup when the user enters or exits Sketch mode is an open implementation decision. The view mode system notes that switching modes "preserves selection and camera state where possible" (docs/UI-ARCHITECTURE.md §4); how that principle resolves for Sketch mode transitions requires specification.

## References

- docs/UI-ARCHITECTURE.md §4 — view mode system; Sketch mode joins this system as a fourth top-level mode
- docs/UI-ARCHITECTURE.md §6.1 — active viewport interaction modes; Sketch mode does not conflict with these but is a separate top-level context
- docs/UI-ARCHITECTURE.md §6.6 — DXF/SVG flow and future direction for 2D layer editing; the motivating context
- docs/UI-ARCHITECTURE.md §15.5 — 2D layer editing flagged as high-priority before 3D toolpath work
- docs/UI-ARCHITECTURE.md §15.6 — strategic dependency: 3D toolpath operations depend on 2D layer editing landing first
- ADR 0005 — recipe / template system; loop IDs in sketch-edited layers affect recipe geometry reference portability

## Supersession note (2026-06-09)

ADR-0016 supersedes the "not parametric: geometry is direct-manipulation, not
constraint-driven" scope of this ADR. The remaining decisions carry forward
unchanged: Sketch as a fourth top-level view mode, and STL-projected layers
remaining read-only snapshots. See ADR-0016 for the new context and decision.
