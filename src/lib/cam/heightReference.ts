// Single-source ref-plane -> heights/params mapping (UI-STANDARD sec 11.6).
//
// Both the NewOperationModal (setOpHeightReference / setOpHeightReferenceAny) and
// the PropertiesPanel Heights quick-edit route a "reference plane changed" event
// through the SAME pure function here, so the two surfaces cannot diverge on:
//   1. which heightReference value is stored (trivial passthrough),
//   2. whether the edit marks the bottom of cut MANUAL (bottomManual), and
//   3. the picked-datum referencePlaneGeo carried on a 'picked_plane' pick.
//
// The bottomManual rule is the part that used to live only inside the modal:
//   - chamfer: never sets bottomManual (its Z depth is computed from width/angle,
//     the bottom-of-cut is not a manual field there).
//   - every other op: sets bottomManual when the reference governs the BOTTOM of
//     cut (i.e. NOT top-governed). Face/engrave and top-referenced thread mills
//     are top-governed, so they do NOT mark the bottom manual. Pocket is
//     bottom-governed, so it always does. This matches the modal's
//     !refGovernsTop branch (setOpHeightReference / pocket onChange) exactly.

import type { HeightParams, HeightPlaneName, HeightReference, OperationType } from '../../types'
import type { ChamferHeightReference } from './types'
import { heightIntentAfterReferenceEdit } from './heightIntent'

/** Op-type members that carry a ref-plane governed height: the 2.5D families
 *  whose modal / PropertiesPanel exposes a reference-plane control. WO-1903:
 *  derived from the ONE OperationType union by `Extract`, never hand-typed and
 *  no longer widened with `| string` - a caller passing a type outside this set
 *  is now a compile error, and adding a member to OperationType cannot silently
 *  slip past this file. (vcarve is included: the modal's height-reference
 *  selector maps it to 'vcarve'.) */
export type HeightRefOpType = Extract<
  OperationType,
  | 'contour_2d' | 'pocket_2d' | 'drill' | 'bore' | 'thread_mill'
  | 'chamfer' | 'face' | 'engrave' | 'adaptive_clearing_2d' | 'vcarve'
>

/** Runtime companion to HeightRefOpType, for callers (the PropertiesPanel) that
 *  hold a plain OperationType and must narrow it. */
const HEIGHT_REF_OP_TYPES: readonly HeightRefOpType[] = [
  'contour_2d', 'pocket_2d', 'drill', 'bore', 'thread_mill',
  'chamfer', 'face', 'engrave', 'adaptive_clearing_2d', 'vcarve',
]

/** Is this OperationType one whose height reference this module governs? A type
 *  guard so callers can hand the shared mapping a HeightRefOpType. */
export function isHeightRefOpType(type: OperationType): type is HeightRefOpType {
  return (HEIGHT_REF_OP_TYPES as readonly string[]).includes(type)
}

/** The picked-datum surface stored on params.referencePlaneGeo for 'picked_plane'. */
export interface ReferencePlaneGeo {
  geoId: string
  faceIndex: number
  localZ: number
}

/** Only the params fields this mapping reads (thread-mill direction) or writes. */
export interface HeightRefParams {
  heightReference?: ChamferHeightReference
  planeOffset?: number
  referencePlaneGeo?: ReferencePlaneGeo
  // thread-mill only; read to decide top- vs bottom-governed
  threadKind?: 'internal' | 'external'
  externalReference?: 'top' | 'base'
}

/** The subset the mapping produces for params (merge onto the op's full params). */
export interface HeightRefParamsUpdate {
  heightReference: ChamferHeightReference
  referencePlaneGeo?: ReferencePlaneGeo
}

export interface HeightRefUpdate {
  heights: Partial<HeightParams>
  params: HeightRefParamsUpdate
}

function governedIntentPlane(opType: HeightRefOpType, params: HeightRefParams): HeightPlaneName {
  return opType === 'chamfer' || heightRefGovernsTop(opType, params) ? 'top' : 'bottom'
}

export function intentReferenceForUiReference(
  reference: ChamferHeightReference,
  plane: HeightPlaneName,
): HeightReference {
  switch (reference) {
    case 'absolute':
    case 'wcs_plane': return 'wcs_plane'
    case 'geometry_face': return 'geometry_plane'
    case 'machine_floor': return 'machine_plane'
    case 'picked_plane': return 'picked_surface'
    case 'selected_face': return plane === 'top' ? 'selected_feature_top' : 'selected_feature_bottom'
    default: return reference
  }
}

/** Map semantic references onto the legacy resolver used by today's UI. */
export function uiReferenceForIntentReference(
  reference: Exclude<HeightReference, HeightPlaneName>,
): ChamferHeightReference | undefined {
  switch (reference) {
    case 'wcs_plane': return 'wcs_plane'
    case 'stock_top': return 'stock_top'
    case 'stock_bottom': return 'stock_bottom'
    case 'model_top': return 'model_top'
    case 'geometry_plane': return 'geometry_face'
    case 'selected_feature_top':
    case 'selected_feature_bottom': return 'selected_face'
    case 'picked_surface': return 'picked_plane'
    case 'machine_plane': return 'machine_floor'
    default: return undefined
  }
}

/**
 * Does the reference plane govern the TOP of cut for this op (vs the BOTTOM)?
 * Mirrors NewOperationModal's `refGovernsTop`:
 *   face || engrave || (thread_mill top-referenced)
 * A thread mill is top-governed unless it is EXTERNAL with externalReference
 * 'base' (thread climbs UP from the base).
 */
export function heightRefGovernsTop(
  opType: HeightRefOpType, params: HeightRefParams,
): boolean {
  if (opType === 'face' || opType === 'engrave') return true
  if (opType === 'thread_mill') {
    return params.threadKind !== 'external'
      || (params.externalReference ?? 'top') === 'top'
  }
  return false
}

/**
 * Should a ref-plane / plane-offset edit mark the bottom of cut MANUAL?
 * chamfer never does; every other op does when it is bottom-governed. Exported
 * so a plane-offset edit (which has no heightReference change) reuses the exact
 * same rule as a reference change.
 */
export function heightRefMarksBottomManual(
  opType: HeightRefOpType, params: HeightRefParams,
): boolean {
  if (opType === 'chamfer') return false
  return !heightRefGovernsTop(opType, params)
}

/**
 * Pure mapping: a chosen reference plane (and optional picked datum) -> the
 * heights + params patch to persist. Callers merge `.params` onto the op's full
 * params and `.heights` onto op.heights. No behavior change vs the modal's
 * original inline setters — this is the single source both surfaces call.
 */
export function deriveHeightRefUpdate(
  opType: HeightRefOpType,
  _currentHeights: HeightParams,
  currentParams: HeightRefParams,
  newRef: ChamferHeightReference,
  pickedDatum?: ReferencePlaneGeo,
): HeightRefUpdate {
  const params: HeightRefParamsUpdate = { heightReference: newRef }
  if (pickedDatum !== undefined) params.referencePlaneGeo = pickedDatum

  const intentPlane = governedIntentPlane(opType, currentParams)
  const heights: Partial<HeightParams> = {
    heightIntent: heightIntentAfterReferenceEdit(
      _currentHeights,
      intentPlane,
      intentReferenceForUiReference(newRef, intentPlane),
      currentParams.planeOffset ?? 0,
    ),
  }
  // Decide bottomManual against the NEW params (thread-mill direction is on the
  // params being edited, but a ref-plane change never touches threadKind, so
  // current + new agree here — read current for the direction fields).
  if (heightRefMarksBottomManual(opType, currentParams)) heights.bottomManual = true

  return { heights, params }
}

/** Plane-offset edits keep the selected reference and update the same semantic
 * top/bottom entry as a dropdown change. */
export function deriveHeightPlaneOffsetUpdate(
  opType: HeightRefOpType,
  currentHeights: HeightParams,
  currentParams: HeightRefParams,
  currentRef: ChamferHeightReference,
  newOffset: number,
): Partial<HeightParams> {
  const plane = governedIntentPlane(opType, currentParams)
  return {
    ...(heightRefMarksBottomManual(opType, currentParams) ? { bottomManual: true } : {}),
    heightIntent: heightIntentAfterReferenceEdit(
      currentHeights,
      plane,
      intentReferenceForUiReference(currentRef, plane),
      newOffset,
    ),
  }
}
