// WO-1936: the Model screen's own tools edit an STL part's features.
//
// Operator ruling 2026-09-23: STL edits run through the Model screen's EXISTING tools and
// workflow - Defeature, Resize Hole, Push/Pull and Fillet, in their normal
// dialogs, with preview, apply and the Model screen's undo. No new panel.
//
// This module is the seam between those tools and the STL edit journal
// (ADR-0051). It owns three things:
//   1. which picked STL feature each tool accepts (`stlToolAccepts`);
//   2. the plan - a picked feature + the tool's field value turned into the
//      SAME `{ kind, facets, parameters }` Setup's old buttons handed `addMeshEdit`
//      (Setup's STL feature lists, removed by WO-1933), the
//      same "can it be done?" question asked first, and the resulting mesh for
//      the preview. Facets are chosen the way Setup chose them: every facet of
//      the mesh as it stands whose source-facet id the recogniser named.
//   3. the undo step - `StlMeshEditCommand`, a CommandHistory command whose do
//      is `addMeshEdit` and whose undo is `removeMeshEdit`.
//
// Nothing here writes the journal directly; the store does, through its own
// actions, so CAM sees the edited part exactly as it did from Setup.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type { Command } from '../../../doc'
import { enqueueStlJournalMutation } from './stlJournalQueue'
import type { FeatureClass, FeatureVerdict } from '../../../geom/geom-service'
import {
  blendRadiusChangeRefusal,
  BOOLEAN_BODY_KIND,
  booleanBodyRefusal,
  booleanBodySelection,
  CHANGE_BLEND_RADIUS_KIND,
  CHANGE_CHAMFER_SIZE_KIND,
  chamferSizeChangeRefusal,
  createMeshEditRecord,
  ENLARGE_HOLE_KIND,
  enlargeHoleRefusal,
  flatFaceMoveOutcome,
  holeBreaksInto,
  MOVE_FLAT_FACE_KIND,
  MOVE_HOLE_KIND,
  NO_SOURCE_FACET,
  REMOVE_ROUND_FEATURE_KIND,
  replayMeshEdits,
  RESTORE_SHARP_EDGE_KIND,
  roundFeatureRemovalRefusal,
  sharpEdgeRestorationRefusal,
  type BooleanBodyParameters,
  type MeshEditRecord,
} from '../../../mesh/edit'
import { holeDepthFacts } from '../../../mesh/edit/operations/enlargeHole'
import { describeFeature, type FeatureKind, type RecognizedFeature } from '../../../mesh/recognition'
import { weldMesh, type WeldedMesh } from '../../../mesh/recognition/topology'
import type { MeshBuffers } from '../../../mesh/types'
import type { StlModelFeature } from './stlModelBody'

export type StlEditTool = 'defeature' | 'resize-hole' | 'move-hole' | 'push-pull' | 'fillet' | 'chamfer'

/** One edit, exactly the argument Setup's buttons gave `addMeshEdit`. */
export interface StlMeshEditInput {
  id?: string
  kind: string
  facets: number[]
  parameters: Record<string, unknown>
}

export type StlFeatureEditRequest =
  | { tool: 'move-hole'; feature: StlModelFeature; translation: [number, number, number] }
  | { tool: 'defeature'; feature: StlModelFeature }
  /** WO-2117: with `depth`, Hole depth - the diameter stays `diameterMm`.
   *  WO-2762: with `step` 'counterbore', `diameterMm` is the counterbore's and
   *  only that step is bored; the pilot is left as it is. */
  | { tool: 'resize-hole'; feature: StlModelFeature; diameterMm: number; depth?: number | 'through'; step?: 'counterbore' }
  | { tool: 'push-pull'; feature: StlModelFeature; distanceMm: number }
  | { tool: 'fillet'; feature: StlModelFeature; radiusMm: number }
  | { tool: 'chamfer'; feature: StlModelFeature; distanceMm: number }

export interface PlannedStlEdit {
  edit: StlMeshEditInput
  /** the plain sentence to say after it lands (a bore that breaks into a
   *  neighbour, a face that stopped short), or undefined */
  note?: string
}

export type StlEditPlan =
  | { ok: true; edits: PlannedStlEdit[]; mesh: MeshBuffers; sourceFacetIds: Uint32Array }
  | { ok: false; feature: StlModelFeature; reason: string }

/** Does `tool` edit this picked feature? A feature a tool does not accept is
 *  simply not offered to it - the pick falls through to the tool's own path. */
export function stlToolAccepts(tool: StlEditTool, feature: StlModelFeature): boolean {
  const target = feature.target
  switch (tool) {
    case 'defeature':
      return target.family === 'round' || target.family === 'blend'
    case 'move-hole':
    case 'resize-hole':
      return target.family === 'round' && target.feature.kind !== 'boss'
    case 'push-pull':
      return target.family === 'flat'
    case 'chamfer':
      return target.family === 'blend' && target.blend.kind === 'chamfer'
    case 'fillet':
      return target.family === 'blend' && target.blend.kind === 'fillet'
  }
}

/**
 * WO-2762: the counterbore step of a mesh counterbore - its wider bore and
 * the flat shoulder that bore stands on - or null when `feature` is not a
 * counterbore. Boring just these facets cuts from the shoulder out through
 * the top (the shoulder closes that end, as a blind hole's floor does), so
 * the step is kept and the pilot below it is not touched.
 */
export function stlCounterboreStep(feature: StlModelFeature, mesh?: MeshBuffers, sourceIds?: Uint32Array): { diameterMm: number; wallSourceFacetIds: number[]; sourceFacetIds: number[]; boreRangeMm: [number, number]; boreOpenEnd?: 'low' | 'high' } | null {
  const target = feature.target
  if (target.family !== 'round' || target.feature.kind !== 'counterbore') return null
  const walls = target.feature.bands.filter((band) => band.surface === 'cylinder')
  if (walls.length < 2) return null
  const wide = walls.reduce((a, b) => (b.diameterMm > a.diameterMm ? b : a))
  if (wide.diameterMm <= target.feature.diameterMm + 1e-6) return null
  const inBands = new Set(target.feature.bands.flatMap((band) => band.sourceFacetIds))
  // Complete support includes blind floors and OTHER shoulders. A step's
  // shoulder is planar, at this cylinder's endpoint, and reaches its rim.
  // No mesh is needed by pick/title consumers, which use only the wall IDs.
  const shoulder: number[] = []
  const supportPlanes: number[] = []
  if (mesh && sourceIds) {
    const { origin, direction } = target.feature.axis
    for (const f of currentFacetsOf(sourceIds, target.feature.sourceFacetIds.filter(id => !inBands.has(id)))) {
      const points = [0, 1, 2].map(k => {
        const i = mesh.indices[f * 3 + k] * 3
        const v = [mesh.positions[i] - origin[0], mesh.positions[i + 1] - origin[1], mesh.positions[i + 2] - origin[2]]
        const t = v.reduce((n, x, a) => n + x * direction[a], 0)
        return { t, r: Math.hypot(...v.map((x, a) => x - t * direction[a])) }
      })
      if (points.every(p => Math.abs(p.t - points[0].t) < 1e-3)) supportPlanes.push(points[0].t)
      const atEnd = wide.axialRangeMm.some(t => points.every(p => Math.abs(p.t - t) < 1e-3))
      if (atEnd && points.some(p => Math.abs(p.r - wide.diameterMm / 2) < .02)) shoulder.push(sourceIds[f])
    }
  }
  // WO-2804 round 6: a cylinder/cone seam is not a floor. Follow only
  // mouth cones to a terminal opening; another cylinder or a supported
  // floor keeps that side bounded. Pick/title
  // consumers need no mesh; only the planner records this geometric proof.
  const opensAt = (side: 'low' | 'high'): boolean => {
    const bands = target.feature.bands.filter(b => b !== wide && (side === 'low'
      ? b.axialRangeMm[1] <= wide.axialRangeMm[0] + 1e-3
      : b.axialRangeMm[0] >= wide.axialRangeMm[1] - 1e-3))
    if (!bands.every(b => b.surface === 'cone')) return false
    const end = side === 'low'
      ? Math.min(...target.feature.bands.map(b => b.axialRangeMm[0]))
      : Math.max(...target.feature.bands.map(b => b.axialRangeMm[1]))
    return !supportPlanes.some(t => Math.abs(t - end) < 1e-3)
  }
  let boreOpenEnd: 'low' | 'high' | undefined
  if (mesh && sourceIds) {
    if (opensAt('low')) boreOpenEnd = 'low'
    else if (opensAt('high')) boreOpenEnd = 'high'
  }
  return {
    diameterMm: wide.diameterMm,
    wallSourceFacetIds: wide.sourceFacetIds,
    boreRangeMm: [...wide.axialRangeMm],
    ...(boreOpenEnd ? { boreOpenEnd } : {}),
    sourceFacetIds: [...wide.sourceFacetIds, ...shoulder].sort((a, b) => a - b),
  }
}

/** The facets of `mesh` whose source-facet id the recogniser named - the same
 *  selection rule Setup's lists used. */
export function currentFacetsOf(sourceFacetIds: Uint32Array, wantedSourceIds: readonly number[]): number[] {
  const wanted = new Set(wantedSourceIds)
  const facets: number[] = []
  sourceFacetIds.forEach((id, facet) => { if (wanted.has(id)) facets.push(facet) })
  return facets
}

/** The edit for one request against the mesh as it stands, or the sentence the
 *  operation says when it cannot do it. */
function editFor(
  mesh: MeshBuffers,
  facets: number[],
  request: StlFeatureEditRequest,
  roundFeatures: readonly RecognizedFeature[],
  counterbore: ReturnType<typeof stlCounterboreStep>,
): { edit: StlMeshEditInput; note?: string } | { refusal: string } {
  const target = request.feature.target
  if (request.tool === 'move-hole' && target.family === 'round') {
    return { edit: { kind: MOVE_HOLE_KIND, facets,
      parameters: { translation: request.translation, axisDirection: [...target.feature.axis.direction] } } }
  }
  if (request.tool === 'defeature' && target.family === 'round') {
    const refusal = roundFeatureRemovalRefusal(mesh, facets)
    if (refusal) return { refusal }
    return {
      edit: {
        kind: REMOVE_ROUND_FEATURE_KIND,
        facets,
        parameters: { feature: target.feature.kind, diameterMm: target.feature.diameterMm },
      },
    }
  }
  if (request.tool === 'defeature' && target.family === 'blend') {
    const refusal = sharpEdgeRestorationRefusal(mesh, facets)
    if (refusal) return { refusal }
    const blend = target.blend
    return {
      edit: {
        kind: RESTORE_SHARP_EDGE_KIND,
        facets,
        parameters: { blend: blend.kind, sizeMm: blend.kind === 'fillet' ? blend.radiusMm : blend.setbackMm?.[0] },
      },
    }
  }
  if (request.tool === 'resize-hole' && target.family === 'round' && request.depth !== undefined) {
    const feature = target.feature
    const facts = holeDepthFacts(mesh, facets, feature.axis.origin, feature.axis.direction)
    if (facts === null) return { refusal: workbenchText('stlFeatureEdits.neitherEndOfThisHoleOpensOntoThePart') }
    const parameters = {
      feature: feature.kind,
      fromDiameterMm: feature.diameterMm,
      diameterMm: feature.diameterMm,
      axisOrigin: [...feature.axis.origin],
      axisDirection: facts.axisDirection,
      fromDepthMm: facts.depthMm,
      ...(facts.through ? { fromThrough: true } : {}),
      ...(request.depth === 'through' ? { through: true } : { depthMm: request.depth }),
    }
    const refusal = enlargeHoleRefusal(mesh, facets, parameters)
    if (refusal) return { refusal }
    return { edit: { kind: ENLARGE_HOLE_KIND, facets, parameters } }
  }
  if (request.tool === 'resize-hole' && target.family === 'round') {
    const feature = target.feature
    // WO-2762: a counterbore at or under its pilot's diameter is cut as asked
    // (LIENCAM.md rule 11) and the console says what the hole became.
    const pilotText = String(Number(feature.diameterMm.toFixed(3)))
    const stepNote: string | null = counterbore === null ? null
      : Math.abs(request.diameterMm - feature.diameterMm) <= 1e-6 ? workbenchText('stlFeatureEdits.counterboreIsNowThePilot', { value1: pilotText })
        : request.diameterMm < feature.diameterMm ? workbenchText('stlFeatureEdits.counterboreNowNarrowerThanPilot', { value1: pilotText })
          : null
    const parameters = {
      feature: feature.kind,
      fromDiameterMm: counterbore?.diameterMm ?? feature.diameterMm,
      diameterMm: request.diameterMm,
      ...(counterbore ? { boreRangeMm: counterbore.boreRangeMm, ...(counterbore.boreOpenEnd ? { boreOpenEnd: counterbore.boreOpenEnd } : {}) } : {}),
      axisOrigin: [...feature.axis.origin],
      axisDirection: [...feature.axis.direction],
    }
    const refusal = enlargeHoleRefusal(mesh, facets, parameters)
    if (refusal) return { refusal }
    const into = holeBreaksInto(feature, roundFeatures, request.diameterMm)
    const breaksInto: string | null = into.length > 0
      ? workbenchText('stlFeatureEdits.atMmTheHoleNowBreaksIntoThe', { value1: String(request.diameterMm.toFixed(2)), value2: String(into.map((f) => describeFeature(f)).join(workbenchText('stlFeatureEdits.the'))) })
      : null
    const note = [stepNote, breaksInto].filter((n): n is string => n !== null).join(' ')
    return {
      edit: { kind: ENLARGE_HOLE_KIND, facets, parameters },
      ...(note !== '' ? { note } : {}),
    }
  }
  if (request.tool === 'push-pull' && target.family === 'flat') {
    const outcome = flatFaceMoveOutcome(mesh, facets, request.distanceMm)
    if (outcome.refusal) return { refusal: outcome.refusal }
    return {
      edit: {
        kind: MOVE_FLAT_FACE_KIND,
        facets,
        parameters: outcome.note
          ? { distanceMm: request.distanceMm, reachedMm: outcome.appliedMm }
          : { distanceMm: request.distanceMm },
      },
      ...(outcome.note ? { note: outcome.note } : {}),
    }
  }
  if (request.tool === 'chamfer' && target.family === 'blend') {
    const refusal = chamferSizeChangeRefusal(mesh, facets, request.distanceMm)
    if (refusal) return { refusal }
    return { edit: { kind: CHANGE_CHAMFER_SIZE_KIND, facets, parameters: { distanceMm: request.distanceMm } } }
  }
  if (request.tool === 'fillet' && target.family === 'blend') {
    const refusal = blendRadiusChangeRefusal(mesh, facets, request.radiusMm)
    if (refusal) return { refusal }
    return {
      edit: {
        kind: CHANGE_BLEND_RADIUS_KIND,
        facets,
        parameters: { radiusMm: request.radiusMm, fromRadiusMm: target.blend.radiusMm },
      },
    }
  }
  return { refusal: workbenchText('stlFeatureEdits.doesNotEditA', { value1: String(toolWord(request.tool)), value2: String(request.feature.kind.replace(/-/g, ' ')) }) }
}

function toolWord(tool: StlEditTool): string {
  if (tool === 'chamfer') return 'Chamfer'
  return tool === 'move-hole' ? workbenchText('MoveHoleEntry.title') : tool === 'defeature' ? workbenchText('stlFeatureEdits.defeature') : tool === 'resize-hole' ? workbenchText('stlFeatureEdits.resizeHole') : tool === 'push-pull' ? workbenchText('stlFeatureEdits.pushPull') : workbenchText('stlFeatureEdits.fillet')
}

/**
 * Plan `requests` in order against the part as it stands (`start`, the row's
 * journal already replayed). Each edit is planned against the mesh the edits
 * before it leave, re-finding its feature by source-facet id - so a Defeature
 * of two features writes two entries that each replay, exactly as two clicks
 * of Setup's buttons would have. Pure: nothing is recorded.
 */
export function planStlFeatureEdits(
  start: { mesh: MeshBuffers; sourceFacetIds: Uint32Array; roundFeatures: readonly RecognizedFeature[] },
  requests: readonly StlFeatureEditRequest[],
): StlEditPlan {
  let mesh = start.mesh
  let sourceFacetIds = start.sourceFacetIds
  const edits: PlannedStlEdit[] = []
  // WO-2802: local to THIS pure preview. A dependent/duplicate removal is
  // satisfied only when successful removal replay actually lost ALL its ids.
  // A stale selection, previous journal or non-removal cannot use this path.
  const removedSourceIds = new Set<number>()
  for (const request of requests) {
    // WO-2762: a counterbore-step resize selects that step's facets alone.
    const step = request.tool === 'resize-hole' && request.step === 'counterbore' && request.depth === undefined
      ? stlCounterboreStep(request.feature, mesh, sourceFacetIds)
      : null
    const facets = currentFacetsOf(sourceFacetIds, step?.sourceFacetIds ?? request.feature.sourceFacetIds)
    if (facets.length === 0) {
      const wanted = request.feature.sourceFacetIds
      if (request.tool === 'defeature' && wanted.length > 0 &&
        wanted.every((id) => id !== NO_SOURCE_FACET && removedSourceIds.has(id))) continue
      return { ok: false, feature: request.feature, reason: workbenchText('stlFeatureEdits.itIsNoLongerOnThisPart') }
    }
    const planned = editFor(mesh, facets, request, start.roundFeatures, step)
    if ('refusal' in planned) return { ok: false, feature: request.feature, reason: planned.refusal }
    // Apply it through the registry exactly as replay will, so the preview is
    // the shape the journal will resolve to.
    const record = createMeshEditRecord(mesh, { ...planned.edit, id: 'wo1936-preview' })
    const replayed = replayMeshEdits(mesh, [record])
    if (replayed.stopped) {
      return { ok: false, feature: request.feature, reason: replayed.stopped.reason }
    }
    const composed = new Uint32Array(replayed.sourceFacetIds.length)
    replayed.sourceFacetIds.forEach((input, output) => {
      composed[output] = input === NO_SOURCE_FACET ? NO_SOURCE_FACET : (sourceFacetIds[input] ?? NO_SOURCE_FACET)
    })
    if (request.tool === 'defeature') {
      const remaining = new Set(composed)
      for (const facet of record.facets) {
        const id = sourceFacetIds[facet]
        if (id !== undefined && id !== NO_SOURCE_FACET && !remaining.has(id)) removedSourceIds.add(id)
      }
    }
    mesh = replayed.mesh
    sourceFacetIds = composed
    edits.push({ edit: planned.edit, ...(planned.note ? { note: planned.note } : {}) })
  }
  return { ok: true, edits, mesh, sourceFacetIds }
}

// ------------------------------------------------------ Boolean with a shape

/**
 * WO-1961: the Model screen's Boolean with the STL as its target and a box or
 * cylinder as its tool - union adds it, subtract cuts it. The plan is the SAME
 * `{ kind, facets, parameters }` Setup's "Add or cut a shape" handed
 * `addMeshEdit` (WO-1910): the parameters in that control's own shape, and the
 * facets `booleanBodySelection` picks on the mesh as it stands. The same "can
 * it be done?" question is asked first; the mesh is the preview. Pure.
 */
export function planStlShapeEdit(
  mesh: MeshBuffers,
  shape: BooleanBodyParameters,
): { ok: true; edits: PlannedStlEdit[]; mesh: MeshBuffers } | { ok: false; reason: string } {
  // Setup's parameter object, key for key: nothing a box does not carry.
  // WO-2089: a hole or a chamfer is plain data already (`stlHoleShape`,
  // `stlChamferShape`); copied, so the record shares no array with the caller.
  // WO-2090: so is a shell or a draft (`stlShellShape`, `stlDraftShape`).
  // WO-3092: and a fillet (`stlFilletShape`).
  const parameters: Record<string, unknown> = shape.shape === 'hole' || shape.shape === 'chamfer' || shape.shape === 'fillet' ||
    shape.shape === 'shell' || shape.shape === 'draft'
    ? JSON.parse(JSON.stringify(shape)) as Record<string, unknown>
    : shape.shape === 'box'
    ? { operation: shape.operation, shape: 'box', center: [...shape.center], size: [...(shape.size ?? [])] }
    : {
        operation: shape.operation,
        shape: 'cylinder',
        center: [...shape.center],
        diameterMm: shape.diameterMm,
        lengthMm: shape.lengthMm,
        axisDirection: [...(shape.axisDirection ?? [])],
      }
  try {
    const refusal = booleanBodyRefusal(mesh, parameters)
    if (refusal) return { ok: false, reason: refusal }
    const edit: StlMeshEditInput = { kind: BOOLEAN_BODY_KIND, facets: booleanBodySelection(mesh, parameters), parameters }
    const replayed = replayMeshEdits(mesh, [createMeshEditRecord(mesh, { ...edit, id: 'wo1961-preview' })])
    if (replayed.stopped) return { ok: false, reason: replayed.stopped.reason }
    return { ok: true, edits: [{ edit }], mesh: replayed.mesh }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Where a new tool shape starts, as Setup's control seeded it: centred on the
 *  part's top face (half in, half out - a union raises a block there, a cut
 *  sinks a pocket), and a cylinder long enough to pass right through. */
export function stlShapeSeed(mesh: MeshBuffers): { center: [number, number, number]; lengthMm: number } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], mesh.positions[i + a])
      max[a] = Math.max(max[a], mesh.positions[i + a])
    }
  }
  if (!Number.isFinite(min[0])) return { center: [0, 0, 0], lengthMm: 10 }
  const round = (n: number) => Math.round(n * 1000) / 1000
  return {
    center: [round((min[0] + max[0]) / 2), round((min[1] + max[1]) / 2), round(max[2])],
    lengthMm: round(max[2] - min[2] + 2),
  }
}

// ------------------------------------------------ Hole and Chamfer (WO-2089)

type Vec3Tuple = [number, number, number]
type XYZ = { x: number; y: number; z: number }

/** How far past the far side of the part a through hole's bore reaches, mm. */
const THROUGH_MARGIN_MM = 1

/** The Hole dialog's fields, as its payload carries them. */
export interface StlHoleRequest {
  points: readonly XYZ[]
  /** the picked face's outward normal: the hole runs the other way */
  normal: XYZ
  style:
    | { kind: 'simple'; diameter: number }
    | { kind: 'counterbore'; diameter: number; cbDiameter: number; cbDepth: number }
    | { kind: 'countersink'; diameter: number; csDiameter: number; csAngleDeg: number }
  depth: { kind: 'blind'; distance: number } | { kind: 'throughAll' }
}

/**
 * The Model screen's Hole on an STL, as the one journal entry it writes: a
 * 'hole' shape of the boolean-body edit (the kernel the bores and Boolean
 * already cut with). A through hole records the depth that reaches right
 * through the part from its point, plus `THROUGH_MARGIN_MM` - the deepest
 * any corner of the part lies below the face along the hole. Pure.
 */
export function stlHoleShape(mesh: MeshBuffers, request: StlHoleRequest): BooleanBodyParameters {
  const n: Vec3Tuple = [request.normal.x, request.normal.y, request.normal.z]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  const axis: Vec3Tuple = [n[0] / l, n[1] / l, n[2] / l]
  const points = request.points.map((p): Vec3Tuple => [p.x, p.y, p.z])
  let lengthMm: number
  if (request.depth.kind === 'blind') {
    lengthMm = request.depth.distance
  } else {
    let reach = 0
    for (const p of points) {
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const below = (p[0] - mesh.positions[i]) * axis[0] + (p[1] - mesh.positions[i + 1]) * axis[1] + (p[2] - mesh.positions[i + 2]) * axis[2]
        if (below > reach) reach = below
      }
    }
    lengthMm = Math.round((reach + THROUGH_MARGIN_MM) * 1000) / 1000
  }
  const style = request.style
  return {
    operation: 'subtract',
    shape: 'hole',
    center: points[0],
    axisDirection: axis,
    points,
    diameterMm: style.diameter,
    lengthMm,
    ...(request.depth.kind === 'throughAll' ? { through: true } : {}),
    ...(style.kind === 'counterbore' ? { counterboreDiameterMm: style.cbDiameter, counterboreDepthMm: style.cbDepth } : {}),
    ...(style.kind === 'countersink' ? { countersinkDiameterMm: style.csDiameter, countersinkAngleDeg: style.csAngleDeg } : {}),
  }
}

/** The outward normal of displayed facet `facet` of `mesh` (a hole's
 *  direction when the operator places it on that facet). */
export function stlFacetNormal(mesh: MeshBuffers, facet: number): XYZ {
  const corner = (k: number): Vec3Tuple => {
    const v = mesh.indices[facet * 3 + k] * 3
    return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]]
  }
  const [a, b, c] = [corner(0), corner(1), corner(2)]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  return { x: n[0] / l, y: n[1] / l, z: n[2] / l }
}

/** Facets meeting at more than this are a sharp edge - the angle the Model
 *  screen draws the STL's outline edges at, so what shows as an edge picks as
 *  one. */
export const STL_SHARP_EDGE_DEG = 25

/** A straight sharp edge of an STL, whole: every collinear mesh edge between
 *  the same two flat faces, end to end. */
export interface StlSharpEdge {
  id: string
  start: Vec3Tuple
  end: Vec3Tuple
  lengthMm: number
  /** unit directions from the edge into each of its two faces */
  faceDirections: [Vec3Tuple, Vec3Tuple]
  /** 'subtract' for an outside edge (a chamfer cuts it), 'add' for an inside
   *  corner (a chamfer fills it) */
  operation: 'add' | 'subtract'
}

interface SharpEdgeIndex {
  welded: WeldedMesh
  /** indexes into `welded.edges` of the sharp ones */
  sharp: number[]
  /** welded vertex -> the sharp edges at it */
  atVertex: Map<number, number[]>
}

const sharpEdgeIndexes = new WeakMap<MeshBuffers, SharpEdgeIndex>()

function sharpEdgeIndex(mesh: MeshBuffers): SharpEdgeIndex {
  const cached = sharpEdgeIndexes.get(mesh)
  if (cached !== undefined) return cached
  const welded = weldMesh(mesh)
  const limit = Math.cos((STL_SHARP_EDGE_DEG * Math.PI) / 180)
  const sharp: number[] = []
  const atVertex = new Map<number, number[]>()
  welded.edges.forEach((edge, index) => {
    if (edge.facets.length !== 2) return
    const [f, g] = edge.facets
    if (welded.areas[f] === 0 || welded.areas[g] === 0) return
    const dot = welded.normals[f * 3] * welded.normals[g * 3] + welded.normals[f * 3 + 1] * welded.normals[g * 3 + 1] +
      welded.normals[f * 3 + 2] * welded.normals[g * 3 + 2]
    if (dot >= limit) return
    sharp.push(index)
    for (const v of [edge.a, edge.b]) {
      const list = atVertex.get(v)
      if (list === undefined) atVertex.set(v, [index])
      else list.push(index)
    }
  })
  const built = { welded, sharp, atVertex }
  sharpEdgeIndexes.set(mesh, built)
  return built
}

const v3sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const v3dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function v3unit(a: Vec3Tuple): Vec3Tuple {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * The straight sharp edge of `mesh` nearest `point` (part coordinates), when
 * one lies within `toleranceMm` of it - the edge a click on the STL picks for
 * Chamfer. The mesh edge under the click is grown both ways through every
 * collinear sharp mesh edge between the same two faces, so the whole edge is
 * picked however the STL triangulated it. Null when no sharp edge is that
 * close. Pure (the edge index is cached per mesh).
 */
export function findStlSharpEdge(mesh: MeshBuffers, point: XYZ, toleranceMm: number): StlSharpEdge | null {
  const { welded, sharp, atVertex } = sharpEdgeIndex(mesh)
  const at = (v: number): Vec3Tuple => [welded.positions[v * 3], welded.positions[v * 3 + 1], welded.positions[v * 3 + 2]]
  const normal = (f: number): Vec3Tuple => [welded.normals[f * 3], welded.normals[f * 3 + 1], welded.normals[f * 3 + 2]]
  const p: Vec3Tuple = [point.x, point.y, point.z]
  let best = -1
  let bestDistance = toleranceMm
  for (const index of sharp) {
    const a = at(welded.edges[index].a)
    const ab = v3sub(at(welded.edges[index].b), a)
    const t = Math.max(0, Math.min(1, v3dot(v3sub(p, a), ab) / (v3dot(ab, ab) || 1)))
    const q: Vec3Tuple = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
    const distance = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    if (distance <= bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  if (best < 0) return null

  const seed = welded.edges[best]
  const [f1, f2] = seed.facets
  const n1 = normal(f1)
  const n2 = normal(f2)
  const direction = v3unit(v3sub(at(seed.b), at(seed.a)))
  const sameFaces = (index: number): boolean => {
    const [g1, g2] = welded.edges[index].facets
    const m1 = normal(g1)
    const m2 = normal(g2)
    const close = (x: Vec3Tuple, y: Vec3Tuple) => v3dot(x, y) > 0.9999
    return (close(m1, n1) && close(m2, n2)) || (close(m1, n2) && close(m2, n1))
  }
  // Walk from one end of the seed on through collinear sharp edges between
  // the same two faces; returns the far vertex reached.
  const walk = (from: number, previousEdge: number): number => {
    let vertex = from
    let edge = previousEdge
    const seen = new Set<number>([best])
    for (;;) {
      const next = (atVertex.get(vertex) ?? []).find((index) => {
        if (index === edge || seen.has(index)) return false
        const e = welded.edges[index]
        const other = e.a === vertex ? e.b : e.a
        const along = v3unit(v3sub(at(other), at(vertex)))
        return Math.abs(Math.abs(v3dot(along, direction)) - 1) < 1e-6 && sameFaces(index)
      })
      if (next === undefined) return vertex
      seen.add(next)
      const e = welded.edges[next]
      vertex = e.a === vertex ? e.b : e.a
      edge = next
    }
  }
  const startVertex = walk(seed.a, best)
  const endVertex = walk(seed.b, best)
  const start = at(startVertex)
  const end = at(endVertex)
  const axis = v3unit(v3sub(end, start))
  // Into each face: the facet's corner off the edge, square to the edge.
  const into = (f: number): Vec3Tuple => {
    const corners = [0, 1, 2].map((k) => welded.facets[f * 3 + k])
    const off = corners.find((v) => v !== seed.a && v !== seed.b) ?? corners[0]
    const d = v3sub(at(off), at(seed.a))
    const s = v3dot(d, axis)
    return v3unit([d[0] - axis[0] * s, d[1] - axis[1] * s, d[2] - axis[2] * s])
  }
  const t1 = into(f1)
  const t2 = into(f2)
  const round = (v: Vec3Tuple): Vec3Tuple => [0, 1, 2].map((k) => Math.round(v[k] * 1e6) / 1e6) as Vec3Tuple
  const key = (v: Vec3Tuple) => v.map((n) => n.toFixed(3)).join(',')
  return {
    id: `stl-edge:${[key(start), key(end)].sort().join(':')}`,
    start: round(start),
    end: round(end),
    lengthMm: Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    faceDirections: [round(t1), round(t2)],
    // An outside edge: each face lies behind the other's plane.
    operation: v3dot(t1, n2) < 0 ? 'subtract' : 'add',
  }
}

/** The Model screen's Chamfer on an STL, as the one journal entry it writes:
 *  a 'chamfer' shape of the boolean-body edit, `distanceMm` back along both
 *  faces of every picked edge. Pure. */
export function stlChamferShape(edges: readonly StlSharpEdge[], distanceMm: number): BooleanBodyParameters {
  const first = edges[0]
  const mid: Vec3Tuple = first === undefined
    ? [0, 0, 0]
    : [0, 1, 2].map((k) => Math.round(((first.start[k] + first.end[k]) / 2) * 1e6) / 1e6) as Vec3Tuple
  const cuts = edges.some((e) => e.operation === 'subtract')
  return {
    operation: cuts ? 'subtract' : 'add',
    shape: 'chamfer',
    center: mid,
    edges: edges.map((e) => ({
      start: [...e.start] as Vec3Tuple,
      end: [...e.end] as Vec3Tuple,
      faceDirections: [[...e.faceDirections[0]] as Vec3Tuple, [...e.faceDirections[1]] as Vec3Tuple],
      operation: e.operation,
    })),
    distanceMm,
  }
}

// ------------------------------------------------------------ Fillet (WO-3092)

/** A run of sharp edge turns at most this much at each corner and still
 *  reads as one edge to Fillet - a hole's rim, polygon though the STL makes
 *  it, is picked whole; a box's corner (90 deg) ends the edge there. */
export const STL_TANGENT_CHAIN_DEG = 30

/** A sharp edge of an STL as Fillet picks it: the whole tangent-continuous
 *  run of it along one flat face - a straight edge, or a hole's rim all the
 *  way round. */
export interface StlEdgeChain {
  id: string
  /** corners, part coordinates (a closed run does not repeat its first) */
  points: Vec3Tuple[]
  closed: boolean
  lengthMm: number
  /** per point: unit directions into the flat face the run lies in, and into
   *  the other face, square to the run there */
  faceDirections: Array<[Vec3Tuple, Vec3Tuple]>
  /** 'subtract' for an outside edge (rounded off), 'add' for an inside corner (filled) */
  operation: 'add' | 'subtract'
}

/**
 * Which recognised curved surface each facet of the part lies on - one band
 * (cylinder or cone) of a round feature, or a rounded blend. Fillet rounds an
 * edge that runs along a flat face; a fold with a curved surface on both sides
 * (a coarse cone's seam, a bore meeting its chamfer cone) is not one it picks.
 * Undefined for a facet on none.
 */
export function stlCurvedSurfaceOf(part: { features: readonly StlModelFeature[]; sourceFacetIds: Uint32Array }): (facet: number) => string | undefined {
  const bySource = new Map<number, string>()
  part.features.forEach((feature, i) => {
    const target = feature.target
    if (target.family === 'round') {
      target.feature.bands.forEach((band, b) => { for (const id of band.sourceFacetIds) bySource.set(id, `${i}:${b}`) })
    } else if (target.family === 'blend' && target.blend.kind === 'fillet') {
      for (const id of feature.sourceFacetIds) bySource.set(id, `${i}`)
    }
  })
  return (facet) => bySource.get(part.sourceFacetIds[facet])
}

/**
 * The sharp edge of `mesh` nearest `point` (part coordinates) within
 * `toleranceMm` that runs along a flat face, grown both ways for as long as it
 * keeps that face (the same plane) and turns no more than
 * `STL_TANGENT_CHAIN_DEG` at a corner - the edge a click picks for Fillet. A
 * facet `surfaceOf` (from `stlCurvedSurfaceOf`) places on a curved surface is
 * not a flat face, so a fold with curved surfaces on both sides is not picked.
 * Null when no such edge is that close. Pure.
 */
export function findStlEdgeChain(mesh: MeshBuffers, point: XYZ, toleranceMm: number, surfaceOf?: (facet: number) => string | undefined): StlEdgeChain | null {
  const { welded, sharp: folds, atVertex: foldsAt } = sharpEdgeIndex(mesh)
  const flat = (f: number): boolean => surfaceOf?.(f) === undefined
  const alongFlat = (index: number): boolean => welded.edges[index].facets.some(flat)
  const sharp = folds.filter(alongFlat)
  const atVertex = { get: (v: number) => foldsAt.get(v)?.filter(alongFlat) }
  const at = (v: number): Vec3Tuple => [welded.positions[v * 3], welded.positions[v * 3 + 1], welded.positions[v * 3 + 2]]
  const normal = (f: number): Vec3Tuple => [welded.normals[f * 3], welded.normals[f * 3 + 1], welded.normals[f * 3 + 2]]
  const p: Vec3Tuple = [point.x, point.y, point.z]
  let best = -1
  let bestDistance = toleranceMm
  for (const index of sharp) {
    const a = at(welded.edges[index].a)
    const ab = v3sub(at(welded.edges[index].b), a)
    const t = Math.max(0, Math.min(1, v3dot(v3sub(p, a), ab) / (v3dot(ab, ab) || 1)))
    const distance = Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  if (best < 0) return null

  // A face is a plane: its normal and its offset along it.
  type Face = { n: Vec3Tuple; offset: number }
  const faceOf = (f: number): Face => {
    const n = normal(f)
    return { n, offset: v3dot(n, at(welded.facets[f * 3])) }
  }
  const onPlane = (f: number, q: Face) => {
    const own = faceOf(f)
    return v3dot(own.n, q.n) > 0.9999 && Math.abs(own.offset - q.offset) <= 1e-3
  }
  const seed = welded.edges[best]
  // The run keeps a flat face of its first edge.
  const candidates = seed.facets.filter(flat).map(faceOf)
  let shared: Face | null = null
  const limit = Math.cos((STL_TANGENT_CHAIN_DEG * Math.PI) / 180)

  // Walk on from `vertex` (arrived along `direction` by `edge`); the vertices
  // and edges reached, in order. Stops at a corner sharper than the limit,
  // where the face changes, or back at `stopAt` (a closed rim).
  const used = new Set<number>([best])
  const walk = (from: number, edge: number, direction: Vec3Tuple, stopAt: number) => {
    const vertices: number[] = []
    const edges: number[] = []
    let vertex = from
    let dir = direction
    let previous = edge
    for (;;) {
      let next = -1
      let nextDir: Vec3Tuple = dir
      let nextTurn = -2
      for (const index of atVertex.get(vertex) ?? []) {
        if (index === previous || used.has(index)) continue
        const e = welded.edges[index]
        const other = e.a === vertex ? e.b : e.a
        const along = v3unit(v3sub(at(other), at(vertex)))
        const turn = v3dot(along, dir)
        if (turn < limit) continue
        const faces = shared === null ? candidates : [shared]
        if (!faces.some((q) => e.facets.some((f) => onPlane(f, q)))) continue
        if (turn > nextTurn) {
          next = index
          nextDir = along
          nextTurn = turn
        }
      }
      if (next < 0) return { vertices, edges, closed: false }
      const e = welded.edges[next]
      if (shared === null && nextTurn < 1 - 1e-9) {
        // The first corner names the face the run keeps.
        shared = candidates.find((q) => e.facets.some((f) => onPlane(f, q))) ?? null
      }
      used.add(next)
      edges.push(next)
      vertex = e.a === vertex ? e.b : e.a
      dir = nextDir
      previous = next
      if (vertex === stopAt) return { vertices, edges, closed: true }
      vertices.push(vertex)
    }
  }
  const seedDir = v3unit(v3sub(at(seed.b), at(seed.a)))
  const ahead = walk(seed.b, best, seedDir, seed.a)
  const back = ahead.closed ? { vertices: [], edges: [] } : walk(seed.a, best, [-seedDir[0], -seedDir[1], -seedDir[2]], seed.b)
  const vertexRun = [...[...back.vertices].reverse(), seed.a, seed.b, ...ahead.vertices]
  const edgeRun = [...[...back.edges].reverse(), best, ...ahead.edges]
  const closed = ahead.closed
  // The flat face the run lies in: the one its corners kept, else the seed's first.
  const face = shared ?? candidates[0]

  // Into each face of one edge, square to it: the facet's corner off the edge.
  const into = (edgeIndex: number) => {
    const e = welded.edges[edgeIndex]
    const axis = v3unit(v3sub(at(e.b), at(e.a)))
    const towards = (f: number): Vec3Tuple => {
      const corners = [0, 1, 2].map((k) => welded.facets[f * 3 + k])
      const off = corners.find((v) => v !== e.a && v !== e.b) ?? corners[0]
      const d = v3sub(at(off), at(e.a))
      const s = v3dot(d, axis)
      return v3unit([d[0] - axis[0] * s, d[1] - axis[1] * s, d[2] - axis[2] * s])
    }
    const [f1, f2] = e.facets
    const firstIsFace = onPlane(f1, face) || (!onPlane(f2, face) && f1 === seed.facets[0])
    const [inFace, other] = firstIsFace ? [f1, f2] : [f2, f1]
    return { t1: towards(inFace), t2: towards(other), otherNormal: normal(other) }
  }
  const perEdge = edgeRun.map(into)
  const pointCount = closed ? edgeRun.length : edgeRun.length + 1
  const points = Array.from({ length: pointCount }, (_, k) => at(vertexRun[k]))
  const faceDirections = points.map((_, k): [Vec3Tuple, Vec3Tuple] => {
    const before = closed ? perEdge[(k - 1 + perEdge.length) % perEdge.length] : perEdge[k - 1]
    const after = perEdge[k]
    const mix = (pick: (x: { t1: Vec3Tuple; t2: Vec3Tuple }) => Vec3Tuple): Vec3Tuple => {
      const list = [before, after].filter((x): x is NonNullable<typeof x> => x !== undefined).map(pick)
      return v3unit([0, 1, 2].map((a) => list.reduce((sum, v) => sum + v[a], 0)) as Vec3Tuple)
    }
    return [mix((x) => x.t1), mix((x) => x.t2)]
  })
  const round = (v: Vec3Tuple): Vec3Tuple => [0, 1, 2].map((k) => Math.round(v[k] * 1e6) / 1e6) as Vec3Tuple
  const seedInto = perEdge[back.edges.length]
  let lengthMm = 0
  for (let k = 0; k < (closed ? points.length : points.length - 1); k++) {
    const a = points[k]
    const b = points[(k + 1) % points.length]
    lengthMm += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  const key = (v: Vec3Tuple) => v.map((n) => n.toFixed(3)).join(',')
  const ends = closed ? [...points.map(key)].sort().slice(0, 2) : [key(points[0]), key(points[points.length - 1])].sort()
  return {
    id: `stl-edge${closed ? '-loop' : ''}:${ends.join(':')}:${points.length}`,
    points: points.map(round),
    closed,
    lengthMm,
    faceDirections: faceDirections.map(([a, b]) => [round(a), round(b)]),
    // An outside edge: each face lies behind the other's plane.
    operation: v3dot(seedInto.t1, seedInto.otherNormal) < 0 ? 'subtract' : 'add',
  }
}

/** The Model screen's Fillet on an STL's sharp edges, as the one journal
 *  entry it writes: a 'fillet' shape of the boolean-body edit, every picked
 *  run rounded to `radiusMm`. Pure. */
export function stlFilletShape(chains: readonly StlEdgeChain[], radiusMm: number): BooleanBodyParameters {
  const first = chains[0]?.points[0]
  const cuts = chains.some((c) => c.operation === 'subtract')
  return {
    operation: cuts ? 'subtract' : 'add',
    shape: 'fillet',
    center: first === undefined ? [0, 0, 0] : [...first] as Vec3Tuple,
    chains: chains.map((c) => ({
      points: c.points.map((p) => [...p] as Vec3Tuple),
      closed: c.closed,
      faceDirections: c.faceDirections.map(([a, b]) => [[...a] as Vec3Tuple, [...b] as Vec3Tuple]),
      operation: c.operation,
    })),
    radiusMm,
  }
}

// ---------------------------------------------------- Shell and Draft (WO-2090)

/** The part as the Model screen holds it: the resolved mesh and, per facet of
 *  it, the source facet it came from. */
export interface StlPartMesh {
  mesh: MeshBuffers
  sourceFacetIds: Uint32Array
}

/** A picked flat face as a shell or draft records it: the centre of its first
 *  facet on the part as it stands (a point that is ON the face, which the
 *  face's own centroid need not be - a plate's top with holes in it - and in
 *  the part's own coordinates, which the recogniser's recentred plane point
 *  is not) and its outward normal. */
export function stlFaceRef(part: StlPartMesh, feature: StlModelFeature): { point: Vec3Tuple; normal: Vec3Tuple } {
  const target = feature.target
  if (target.family !== 'flat') throw new Error(workbenchText('stlFeatureEdits.theIsNotAFlatFace', { label: String(feature.label) }))
  const [facet] = currentFacetsOf(part.sourceFacetIds, feature.sourceFacetIds)
  if (facet === undefined) throw new Error(workbenchText('stlFeatureEdits.theIsNoLongerOnThisPart', { label: String(feature.label) }))
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  const normal = target.face.plane.normal.map(round) as Vec3Tuple
  const point: Vec3Tuple = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const v = part.mesh.indices[facet * 3 + k] * 3
    for (let a = 0; a < 3; a++) point[a] += part.mesh.positions[v + a] / 3
  }
  return { point: point.map(round) as Vec3Tuple, normal }
}

/** The Model screen's Shell on an STL, as the one journal entry it writes: a
 *  'shell' shape of the boolean-body edit, `thicknessMm` walls, open through
 *  every picked face. Pure. */
export function stlShellShape(part: StlPartMesh, openFaces: readonly StlModelFeature[], thicknessMm: number): BooleanBodyParameters {
  const faces = openFaces.map((face) => stlFaceRef(part, face))
  return { operation: 'subtract', shape: 'shell', center: faces[0]?.point ?? [0, 0, 0], faces, thicknessMm }
}

/** Draft's fields: the angle, the pull direction and a point on the neutral
 *  plane (the Draft dialog's `draftFaceNormalPlane`). */
export interface StlDraftRequest {
  angleDeg: number
  pullDirection: XYZ
  neutralPoint: XYZ
}

/** The Model screen's Draft on an STL, as the one journal entry it writes: a
 *  'draft' shape of the boolean-body edit, every picked face turned to
 *  `angleDeg` about the neutral plane. Pure. */
export function stlDraftShape(part: StlPartMesh, draftFaces: readonly StlModelFeature[], request: StlDraftRequest): BooleanBodyParameters {
  const faces = draftFaces.map((face) => stlFaceRef(part, face))
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  const tuple = (p: XYZ): Vec3Tuple => [round(p.x), round(p.y), round(p.z)]
  return {
    operation: 'subtract',
    shape: 'draft',
    center: faces[0]?.point ?? [0, 0, 0],
    faces,
    angleDeg: request.angleDeg,
    pullDirection: tuple(request.pullDirection),
    neutralPoint: tuple(request.neutralPoint),
  }
}

/** WO-2117: an STL hole's depth as the depth card shows it - from its opening,
 *  and whether it runs right through - or null when neither end opens. */
export function stlHoleDepth(
  part: StlPartMesh,
  feature: StlModelFeature,
): { depthMm: number; through: boolean } | null {
  const target = feature.target
  if (target.family !== 'round') return null
  const facets = currentFacetsOf(part.sourceFacetIds, feature.sourceFacetIds)
  if (facets.length === 0) return null
  const facts = holeDepthFacts(part.mesh, facets, target.feature.axis.origin, target.feature.axis.direction)
  return facts === null ? null : { depthMm: facts.depthMm, through: facts.through }
}

/** The console line for an edit the software cannot make (COHESION-STANDARD
 *  13.2: what did not happen, then the operation's own sentence). */
export function stlEditRefusalLine(partName: string, feature: StlModelFeature, reason: string): string {
  return workbenchText('stlFeatureEdits.notChangedTheOn', { label: String(feature.label), partName: String(partName), reason: String(reason) })
}

/** WO-2120: the tool that does edit a feature Fillet was clicked on. */
function toolForFeature(feature: StlModelFeature): string {
  const target = feature.target
  if (target.family === 'round') {
    return target.feature.kind === 'boss' ? workbenchText('stlFeatureEdits.defeatureRemovesThatBoss') : workbenchText('stlFeatureEdits.resizeHoleOrDefeatureChangesThatHole')
  }
  if (target.family === 'blend') return workbenchText('stlFeatureEdits.defeatureRemovesThat', { kind: String(target.blend.kind) })
  if (target.family === 'flat') return workbenchText('stlFeatureEdits.pushPullMovesThatFace')
  return workbenchText('stlFeatureEdits.thatIs')
}

/** WO-2120: what a Fillet click on the STL says when it lands on something
 *  Fillet does not edit - never silence. On an STL, Fillet changes the radius
 *  of a rounded edge the part already has. The answer leads (the strip is one
 *  line and cuts the end off): whether the part has such an edge, then the
 *  tool that edits what was clicked, then what was clicked. */
export function stlFilletPickLine(features: readonly StlModelFeature[], picked: StlModelFeature | null, partName: string): string {
  const fillets = features.filter((feature) => stlToolAccepts('fillet', feature)).length
  // WO-3092: Fillet rounds a sharp edge along a flat face too, so a click on a
  // face (not near an edge) is told to click an edge - never only about the face.
  const answer = picked === null || picked.target.family === 'flat'
    ? workbenchText('stlFeatureEdits.filletRoundsAnEdgeClickOne', { partName: String(partName) })
    : fillets === 0
    ? workbenchText('stlFeatureEdits.hasNoRoundedEdgeForFilletToChange', { partName: String(partName) })
    : workbenchText('stlFeatureEdits.thatIsNotARoundedEdgeHasClickOne', { partName: String(partName), fillets: String(fillets) })
  return picked === null
    ? workbenchText('stlFeatureEdits.notChanged', { answer: String(answer) })
    : workbenchText('stlFeatureEdits.notChangedThe', { answer: String(answer), value2: String(toolForFeature(picked)), label: String(picked.label) })
}

// ---------------------------------------------------------------- Defeature

const DEFEATURE_CLASS_OF_ROUND: Record<FeatureKind, FeatureClass> = {
  'through-hole': 'throughHole',
  'blind-hole': 'blindHole',
  counterbore: 'counterboreStack',
  countersink: 'throughHole',
  'chamfered-hole': 'throughHole',
  boss: 'boss',
}

/** The Defeature dialog's verdict rows for an STL part: every round feature
 *  and every edge blend it proved, keyed by the recogniser's own id. */
export function stlDefeatureVerdicts(features: readonly StlModelFeature[]): FeatureVerdict[] {
  const verdicts: FeatureVerdict[] = []
  for (const feature of features) {
    const target = feature.target
    if (target.family === 'round') {
      const round = target.feature
      verdicts.push({
        featureKey: feature.id,
        featureClass: DEFEATURE_CLASS_OF_ROUND[round.kind],
        removable: true,
        effect: round.kind === 'boss' ? 'remove' : 'add',
        faceIds: [feature.id],
        neighbourIds: [],
        params: { diameter: round.diameterMm, depth: round.depthMm },
      })
    } else if (target.family === 'blend') {
      const blend = target.blend
      verdicts.push({
        featureKey: feature.id,
        featureClass: blend.kind === 'fillet' ? 'filletPlanar' : 'chamferPlanar',
        removable: true,
        effect: blend.shape === 'convex' ? 'add' : 'remove',
        faceIds: [feature.id],
        neighbourIds: [],
        params: blend.kind === 'fillet'
          ? { radius: blend.radiusMm ?? 0, length: blend.lengthMm }
          : { distance: blend.setbackMm?.[0] ?? 0, length: blend.lengthMm },
      })
    }
  }
  return verdicts
}

// ---------------------------------------------------------------- undo step

/** What the command needs from the store: its own journal actions. */
export interface StlMeshEditPort {
  addMeshEdit(geoId: string, edit: StlMeshEditInput): Promise<MeshEditRecord>
  removeMeshEdit(geoId: string, editId: string): Promise<void>
  /** an undo/redo that could not run, said in the console */
  fail(message: string): void
}

/**
 * One Model-screen undo step for one tool Apply on an STL: do = addMeshEdit
 * (each planned edit, in order), undo = removeMeshEdit (newest first).
 *
 * The first `do` finds the edits already recorded - the tool's Apply records
 * them before the step is pushed, because recording reads the cached bytes and
 * is asynchronous while CommandHistory is not. Later undo/redo calls are
 * queued per part with every creation and replacement, so rapid history
 * requests cannot interleave their store writes across command instances.
 * The journal is the store's; this command holds only ids and plain data.
 */
export class StlMeshEditCommand implements Command {
  readonly label = 'stlMeshEdit'
  readonly geoId: string
  private readonly port: StlMeshEditPort
  private readonly edits: readonly StlMeshEditInput[]
  private recordIds: string[]
  private applied = true
  private chain: Promise<void> = Promise.resolve()

  constructor(
    port: StlMeshEditPort,
    geoId: string,
    edits: readonly StlMeshEditInput[],
    recorded: readonly MeshEditRecord[],
  ) {
    this.port = port
    this.geoId = geoId
    // Tree edits and later replacement commands refer to these stable IDs.
    // Redo of the original creation must restore them, not mint new rows.
    this.edits = edits.map((edit, index) => ({ ...edit, id: recorded[index].id }))
    this.recordIds = recorded.map((r) => r.id)
  }

  /** the journal ids this step currently owns */
  get ids(): readonly string[] {
    return this.recordIds
  }

  /** resolves when every queued undo/redo has reached the store */
  settled(): Promise<void> {
    return this.chain
  }

  do(): void {
    if (this.applied) return
    this.applied = true
    this.chain = enqueueStlJournalMutation(this.geoId, async () => {
      const ids: string[] = []
      for (const edit of this.edits) ids.push((await this.port.addMeshEdit(this.geoId, edit)).id)
      this.recordIds = ids
    }).catch((err: unknown) => this.port.fail(workbenchText('stlFeatureEdits.redoDidNotReApplyTheEdit', { value1: String(err instanceof Error ? err.message : String(err)) })))
  }

  undo(): void {
    if (!this.applied) return
    this.applied = false
    this.chain = enqueueStlJournalMutation(this.geoId, async () => {
      for (const id of [...this.recordIds].reverse()) await this.port.removeMeshEdit(this.geoId, id)
      this.recordIds = []
    }).catch((err: unknown) => this.port.fail(workbenchText('stlFeatureEdits.undoDidNotRemoveTheEdit', { value1: String(err instanceof Error ? err.message : String(err)) })))
  }

  serialize(): unknown {
    return { kind: this.label, geoId: this.geoId, edits: this.edits.map((e) => ({ kind: e.kind, facets: [...e.facets], parameters: e.parameters })) }
  }
}
