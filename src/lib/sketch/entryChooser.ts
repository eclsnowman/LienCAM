// Sketch entry chooser logic (PLAN.md 3.2, Stage 5).
//
// The Sketch TAB is ambiguous when no document is active: the user may
// want a NEW sketch or to edit an EXISTING layer. The chooser modal
// resolves that; this module holds its headless logic so the decision
// rules are testable without the UI:
//
//   - sketchTabNeedsChooser: tab click with an active document BYPASSES
//     the chooser (so do direct entries like the per-layer Edit-sketch
//     button and finish-related transitions — they set the document
//     before switching modes and never consult the tab).
//   - listSketchEntryCandidates: every 2D layer the chooser can OPEN.
//     Projection layers (read-only per ADR-0011, from STL, STEP or model
//     parts alike) and locked layers are NOT listed (WO-2854, rule 11 -
//     The operator, 2026-10-15: "are we going to allow editing of STL projections?
//     If not why is it in there?"); a part with no openable layer has no
//     group at all.
//   - resolveSketchTabSelection (NAV-SKETCH-TAB-SELECTION, GEO-UNIFY
//     Stage 5): the sketch-side mirror of the Model tab's selection-aware
//     routing (UI-EDIT-MODEL-FROM-BODY). Reads the tree/CAM selection and
//     narrows it to that ONE part's sketch-editable layers — exactly one
//     candidate is unambiguous (direct open), 2+ is ambiguous (pre-filtered
//     chooser), 0 (including no selection at all) falls through to today's
//     plain tab behavior. Store action `enterSketchWorkspace` is the only
//     caller (store/index.ts) — it owns the whole decision, keeping this a
//     pure/testable resolver and the UI thin.

import type { ImportedGeometry } from '../../types'
import type { Sketch } from './types'

export interface SketchEntryCandidate {
  /** Owning geometry id — REQUIRED to disambiguate the open. DXF layer ids
   *  are the layer NAME (and SVG ids collide on re-import), so two parts can
   *  share a layerId; geoId is what tells openSketchForLayer which part the
   *  user actually picked. */
  geoId: string
  layerId: string
  layerName: string
  /** Owning geometry container name (e.g. the DXF filename or "Sketches"). */
  containerName: string
  loopCount: number
  /** True when a stored parametric document exists (re-edit, not lift). */
  hasStoredSketch: boolean
  /** Always null: only openable layers are listed (WO-2854). Kept so
   *  existing callers that test it stay well-typed. */
  disabledReason: null
}

/** A layer the sketch editor can open: not a projection (ADR-0011 read-only;
 *  every layer of an STL part is one) and not locked. openSketchForLayer
 *  refuses exactly these, so the chooser never offers a row that refuses. */
function isSketchEditableLayer(
  geo: ImportedGeometry,
  layer: NonNullable<ImportedGeometry['layers2d']>[number],
): boolean {
  return !layer.projectionPlane && geo.format !== 'stl' && !layer.locked
}

/** The Sketch tab opens the chooser ONLY when no document is active.
 *  Direct entries set the document first, so they bypass it. */
export function sketchTabNeedsChooser(activeSketch: Sketch | null): boolean {
  return activeSketch === null
}

export function listSketchEntryCandidates(
  geometry: ImportedGeometry[],
): SketchEntryCandidate[] {
  const out: SketchEntryCandidate[] = []
  for (const geo of geometry) {
    for (const layer of geo.layers2d ?? []) {
      if (!isSketchEditableLayer(geo, layer)) continue
      out.push({
        geoId: geo.id,
        layerId: layer.id,
        layerName: layer.name,
        containerName: geo.name,
        loopCount: (geo.loops ?? []).filter((lp) => lp.layerId === layer.id).length,
        hasStoredSketch:
          geo.sketches?.some((sk) => sk.layerId === layer.id) ?? false,
        disabledReason: null,
      })
    }
  }
  return out
}

/** Result of resolving the Sketch tab against the current selection.
 *  - 'direct': exactly one sketch-editable layer on the selected part —
 *    open it immediately (openSketchForLayer).
 *  - 'ambiguous': 2+ sketch-editable layers on the selected part — open
 *    the chooser pre-filtered to `geoId`.
 *  - 'none': no selection, an unknown id, or a selection with zero
 *    sketch-editable layers — fall through to today's plain tab behavior
 *    (chooser when no document is active, otherwise show what's open). */
export type SketchTabRoute =
  | { kind: 'direct'; geoId: string; layerId: string }
  | { kind: 'ambiguous'; geoId: string }
  | { kind: 'none' }

export function resolveSketchTabSelection(
  geometry: ImportedGeometry[],
  selectedGeometryId: string | null,
): SketchTabRoute {
  if (!selectedGeometryId) return { kind: 'none' }
  const geo = geometry.find((g) => g.id === selectedGeometryId)
  if (!geo) return { kind: 'none' }
  const candidates = listSketchEntryCandidates([geo])
  if (candidates.length === 0) return { kind: 'none' }
  if (candidates.length === 1) {
    return { kind: 'direct', geoId: candidates[0].geoId, layerId: candidates[0].layerId }
  }
  return { kind: 'ambiguous', geoId: selectedGeometryId }
}

/** Result of resolving the MODEL tab against the current selection for a
 *  PROMOTE ("Convert to model" / select-then-Model-tab, NAV-PARITY-AUDIT
 *  path 3). Mirrors SketchTabRoute:
 *  - 'direct': exactly one sketch-editable layer is identified — promote it
 *    (promoteSketchLayerToModel).
 *  - 'ambiguous': a whole part with 2+ sketch-editable layers is selected —
 *    there is no single sketch to promote; caller refuses in plain words.
 *  - 'none': no sketch selection at all — caller falls through to today's plain
 *    Model-tab behavior (enterModelWorkspace's own resolution). */
export type PromoteTabRoute =
  | { kind: 'direct'; geoId: string; layerId: string }
  | { kind: 'ambiguous'; geoId: string }
  | { kind: 'none' }

/** NAV-PARITY path 3 for PROMOTE (PROMOTE-SKETCH-FAIL round 2, Model-tab silent
 *  no-op). When a sketch LAYER is selected (selectedLayerId set) OR a whole
 *  sketch/DXF part is selected (selectedGeometryId set), clicking the Model tab
 *  should MOVE that sketch into a new model — not silently navigate away. This
 *  is the promote-side mirror of resolveSketchTabSelection; the store action
 *  promoteSelectedSketchToModel is its only caller and owns the whole decision
 *  (direct promote / plain-words refusal / today's plain nav), keeping the UI
 *  thin. A specific selected layer wins over a whole-part selection. */
export function resolvePromoteTabSelection(
  geometry: ImportedGeometry[],
  selectedGeometryId: string | null,
  selectedLayerId: string | null,
  selectedLayerGeoId: string | null,
): PromoteTabRoute {
  // A specific sketch layer selected (setSelectedLayer clears selectedGeometryId,
  // so this is the dominant case when a sketch ROW is picked in the tree).
  if (selectedLayerId) {
    const geo = selectedLayerGeoId
      ? geometry.find((g) => g.id === selectedLayerGeoId)
      : geometry.find((g) => g.layers2d?.some((l) => l.id === selectedLayerId))
    if (geo) {
      const cand = listSketchEntryCandidates([geo]).find(
        (c) => c.layerId === selectedLayerId,
      )
      if (cand) return { kind: 'direct', geoId: cand.geoId, layerId: cand.layerId }
    }
    return { kind: 'none' }
  }
  // A whole part selected: promote its sole sketch-editable layer, else ambiguous.
  if (selectedGeometryId) {
    const geo = geometry.find((g) => g.id === selectedGeometryId)
    if (!geo) return { kind: 'none' }
    const candidates = listSketchEntryCandidates([geo])
    if (candidates.length === 1) return { kind: 'direct', geoId: candidates[0].geoId, layerId: candidates[0].layerId }
    if (candidates.length >= 2) return { kind: 'ambiguous', geoId: geo.id }
  }
  return { kind: 'none' }
}
