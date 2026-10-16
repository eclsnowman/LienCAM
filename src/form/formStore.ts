// Form - the Form screen's own state: the cage being shaped, its undo/redo,
// the display mode and the selection. Kept out of the CAM project store on
// purpose: a form in progress is transient until Finish Form writes a body
// into the project (stage 4), exactly as a sketch in progress is.

import { create } from 'zustand'
import { Matrix4, Vector3 } from 'three'
import type { Cage } from './cage'
import { cageBounds, cloneCage, edgeKey, parseEdgeKey } from './cage'
import { validateCage } from './halfEdge'
import { emptyHistory, pushHistory, redoCage, undoCage, type FormHistory } from './history'
import { STARTER_DEFAULTS, starterCage, type StarterKind, type StarterOptions } from './starters'
import { EMPTY_SELECTION, extrudeFaces, selectionPoints, softWeights, transformPoints, type CageSelection } from './topology'
import { creaseTargets, edgeRing, insertEdgeLoop, ringSides, setCreased } from './edgeLoop'
import { deleteFaces, dissolveEdges, edgeLoop, pointLoop, fillHole, growSelection, openLoopThrough, regionBorder, selectAll, shrinkSelection, splitEdges, subdivideFaces, thicken, unweldEdges, weldByDistance, weldPoints } from './topoTools'
import { edgeChains, flattenPoints, makeUniform, principalAxes, pullOntoMesh, pullToLimit, straightenChains } from './shapeTools'
import { closestPointIndex, type MeshLike } from './closestPoint'
import { bridgeFaceSets, bridgeOpenings, faceSets, openLoops } from './bridgeLoops'
import { mirrorDuplicate } from './mirrorDuplicate'
import { circularCount, findPairs, mirrorNormal, mirrorPlaneFrom, mirrorSelection, symmetrize, unpairedCount, type SymmetryMode, type SymmetryPairs } from './symmetry'
import type { Vec3 } from './cage'
import type { CagePick } from './pick'
import { addClickedFace, type FaceClick, type WorkPlane } from './faceByClicks'
import { cageObj } from './cageObj'
import { saveFile } from '../lib/saveFile'

export type FormDisplayMode = 'cage' | 'both' | 'smooth'
export type FormTransformMode = 'translate' | 'rotate' | 'scale'
export type RotationPick = 'edge' | 'x' | 'y' | 'z'
/** A session-only fixed line: subsequent turns use the same hinge, not a moving centroid. */
export interface RotationAxis { origin: Vec3; direction: Vec3; label: string }

/** What a tool just changed (the points that moved or are new, the edges and faces it made or creased), drawn in its own colour for a moment (WO-2497). Display only: never in the cage or the saved form. */
export interface ResultFlash { points: number[]; edges: string[]; faces: number[] }

/** How long a tool's result is drawn in the change colour before the move arrows return, ms. */
export const RESULT_FLASH_MS = 2000

/** Below this a point has not moved (mm; the status line shows 2 decimals). */
const MOVED_MM = 0.005

/** The points of `after` more than MOVED_MM from where they are in `before`, and the farthest move. */
export function movedPoints(before: Cage, after: Cage): { points: number[]; farthest: number } {
  const points: number[] = []
  let farthest = 0
  after.positions.forEach((q, i) => {
    const p = before.positions[i]
    if (p === undefined) return
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
    if (d > farthest) farthest = d
    if (d >= MOVED_MM) points.push(i)
  })
  return { points, farthest }
}
/** what a form session was started from, for the Start-from rail's lit button (WO-2232) */
export type StartFromKind = StarterKind | 'pipe' | 'extrude' | 'revolve' | 'loft' | 'face' | 'body'

/** Keep only selection entries that still exist in `cage` (after undo/redo or a topology change). */
export function pruneSelection(cage: Cage, s: CageSelection): CageSelection {
  const n = cage.positions.length
  const edges = new Set<string>()
  for (const f of cage.faces) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length]
    edges.add(a < b ? `${a}:${b}` : `${b}:${a}`)
  }
  return {
    points: s.points.filter((p) => p < n),
    edges: s.edges.filter((e) => edges.has(e)),
    faces: s.faces.filter((f) => f < cage.faces.length),
  }
}

/** Add a pick to a selection (additive) or make it the whole selection; an additive pick of a selected item removes it. */
export function applyPick(s: CageSelection, pick: CagePick | null, additive: boolean): CageSelection {
  if (!pick) return additive ? s : EMPTY_SELECTION
  const base = additive ? s : EMPTY_SELECTION
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? (additive ? list.filter((x) => x !== item) : list) : [...list, item])
  if (pick.kind === 'point') return { ...base, points: toggle(base.points, pick.index) }
  if (pick.kind === 'edge') return { ...base, edges: toggle(base.edges, pick.key) }
  return { ...base, faces: toggle(base.faces, pick.index) }
}

/** replace: a plain box drag; add: Shift; remove: Ctrl */
export type BoxSelectMode = 'replace' | 'add' | 'remove'

/** The selection after a box takes `points`: the new selection, added to the old, or taken out of it. */
export function applyPoints(s: CageSelection, points: readonly number[], mode: BoxSelectMode): CageSelection {
  if (mode === 'replace') return { points: [...new Set(points)], edges: [], faces: [] }
  if (mode === 'remove') { const out = new Set(points); return { ...s, points: s.points.filter((p) => !out.has(p)) } }
  return { ...s, points: [...new Set([...s.points, ...points])] }
}

export interface FormState {
  cage: Cage
  /** bumps when faces or creases change (the skin must be recompiled) */
  topologyVersion: number
  /** bumps when any point moves */
  positionsVersion: number
  history: FormHistory
  /** Recorded edits excluding Start-from creation; reset for each session. */
  editVersion: number
  /** Session-only rail choice, retained if the rail remounts; never persisted. */
  startFromRail: { checkedEdit: number; folded: boolean; manual: boolean }
  displayMode: FormDisplayMode
  /** true while a drag is live: the skin shows its coarser level */
  dragging: boolean
  starterKind: StarterKind
  starterSegments: Record<StarterKind, { x: number; y: number; z: number }>
  /** what the open session was started from (Box..From body); null while none of them has run this session, or the form was opened from a feature that does not record it. Drives the Start-from rail's lit button */
  startedFrom: StartFromKind | null
  /** form mode is open inside the Model screen */
  active: boolean
  /** the Model-history feature being edited (null: a new form) */
  featureId: string | null
  /** the name the finished body gets */
  name: string
  /** requested chord tolerance for the finished body, mm */
  tolerance: number
  /** plain words for the last thing the screen did (shown in the Form status line) */
  notice: string | null
  selection: CageSelection
  transformMode: FormTransformMode
  rotationAxis: RotationAxis | null
  rotationPick: RotationPick | null
  rotationCentreAxis: 'x' | 'y' | 'z'
  rotationAngle: number
  chooseRotationAxis: (pick: RotationPick | null) => void
  pickRotationAxis: (pick: CagePick | null) => void
  setRotationCentreAxis: (axis: 'x' | 'y' | 'z') => void
  setRotationAngle: (degrees: number) => void
  rotateSelection: () => void
  /** a mirror across the plane n . p = symmetryAt (n: the X, Y or Z axis, or symmetryNormal for 'p'); `c<N>` circular round the Z axis; or off */
  symmetry: SymmetryMode | null
  /** where the mirror plane sits along its normal (a Z mirror starts at the cage's mid-height, X and Y at 0) */
  symmetryAt: number
  /** a placed mirror plane's unit normal ('p'); null for the others */
  symmetryNormal: Vec3 | null
  /** move the mirror plane along its normal to n . p = mm (a mirror must be on) */
  setSymmetryAt: (mm: number) => void
  /**
   * Place the mirror plane from the selection: two points - halfway between
   * them, mapping one onto the other; three or more (or edges, faces) - the
   * plane through their points.
   */
  mirrorFromSelection: () => void
  /** the form and its mirror image across the mirror plane (X = 0 when no mirror is on), joined along it; the mirror stays on */
  mirrorDuplicateForm: () => void
  /** copies round the Z axis the Circular tool makes (2..24) */
  circularCopies: number
  setCircularCopies: (n: number) => void
  /** Circular on (with circularCopies when the cage fits that many copies, else the most it fits) or off */
  toggleCircular: () => void

  newFromStarter: (kind: StarterKind, opts?: StarterOptions) => void
  setStarterKind: (kind: StarterKind) => void
  setStarterSegments: (kind: StarterKind, segments: { x: number; y: number; z: number }) => void
  /**
   * Replace the cage. `topology` says faces/creases changed (recompile the
   * skin). `record` pushes an undo step first. A topology change that fails
   * validation is refused and the cage is left as it was.
   * `startFrom` keeps creation undoable without counting it as a shaping edit.
   */
  applyCage: (next: Cage, opts: { topology: boolean; record: boolean; notice?: string; startFrom?: boolean }) => boolean
  /** live drag update: positions only, no undo step (beginDrag recorded it) */
  dragCage: (next: Cage) => void
  /** start a live drag; `record` false when the operation that started it already recorded (extrude) */
  beginDrag: (opts?: { record?: boolean }) => void
  endDrag: () => void
  undo: () => void
  redo: () => void
  setDisplayMode: (mode: FormDisplayMode) => void
  /** enter form mode: a new form (featureId null, starter cage) or an existing feature's cage */
  openSession: (opts: { featureId: string | null; name: string; cage?: Cage; tolerance?: number; symmetry?: SymmetryMode | null; symmetryAt?: number; symmetryNormal?: Vec3 | null }) => void
  /** leave form mode (Finish or Cancel); the cage is kept only in the feature Finish committed */
  closeSession: () => void
  setName: (name: string) => void
  /** Save the current control cage as OBJ, without finishing or changing the form. */
  exportCageObj: () => Promise<string | null>
  setTolerance: (tolerance: number) => void
  setNotice: (notice: string | null) => void
  select: (pick: CagePick | null, additive: boolean) => void
  /** many points at once (a box drag): they become the selection, or are added to it, or taken out of it */
  selectPoints: (points: readonly number[], mode: BoxSelectMode) => void
  setSelection: (selection: CageSelection) => void
  setTransformMode: (mode: FormTransformMode) => void
  /** extrude the selected faces in place (records one undo step); returns the points that ride with them, or null */
  extrudeSelection: () => number[] | null
  /**
   * Start a gizmo move of the selection (one undo step). `extrude` first
   * extrudes the selected faces so the move pulls the new faces out. With
   * symmetry on, the mirror side follows (moveBy).
   */
  beginMove: (opts: { extrude: boolean }) => void
  /** apply the gizmo's delta (4x4 column-major, relative to the move start) */
  moveBy: (matrix: ArrayLike<number>) => void
  /** insert an edge loop across the ring of the first selected edge (and its mirror) */
  insertLoop: () => void
  /** where Insert loop cuts each ring edge: 0..1 from the selected edge's lower end (0.5 = the middle) */
  loopPosition: number
  /** the loop Insert loop just made: the form before it, and the form with it; the Loop slider moves it while the form is still that */
  liveLoop: { before: Cage; selection: CageSelection; cage: Cage } | null
  setLoopPosition: (t: number) => void
  /** crease (true) or uncrease (false) the selected edges and the edges of selected faces */
  crease: (creased: boolean) => void
  setSymmetry: (mode: SymmetryMode | null) => void
  /** add the edge loop (straight on through ordinary points) of every selected edge */
  selectLoop: () => void
  /** add the edge ring (across the quads) of every selected edge */
  selectRing: () => void
  /** remove the selected faces (and their mirrors): an opening */
  deleteSelectedFaces: () => void
  /** Delete: the selected faces (an opening), or with only edges selected those edges (their faces merge) */
  deleteSelection: () => void
  /** cap the open loop through the first selected edge */
  fillHoleAtSelection: () => void
  /** join the two selected faces with a tube of quads */
  bridgeSelection: () => void
  /** how many rings long Bridge makes its band */
  bridgeSegments: number
  /** points a closed bridge turns round (a spiral band); 0: lined up */
  bridgeTwist: number
  setBridgeTwist: (n: number) => void
  setBridgeSegments: (n: number) => void
  /** close an open form with an inner skin `thickness` inside */
  thickenForm: () => void
  /** the selection one ring wider / narrower, or every element of its kind */
  growSelection: () => void
  shrinkSelection: () => void
  selectAll: () => void
  /** a point in the middle of each selected edge (Insert point) */
  insertPointOnSelection: () => void
  /** the selected faces become quads round their centres (Subdivide) */
  subdivideSelection: () => void
  /** merge the selected points (and the corners of selected edges and faces) into one (Weld) */
  weldSelection: () => void
  /** weld the selected points (every point when nothing is selected) closer than weldDistance */
  weldCloseSelection: () => void
  /** the selected points (and the corners of selected edges and faces) onto their best-fit plane (Flatten) */
  flattenSelection: () => void
  /** the plane Flatten puts points on: their best fit, an axis plane (normal X, Y or Z), the first selected face's plane, or the mirror plane */
  flattenOnto: FlattenOnto
  /** where an axis plane sits on its axis; null: through the centre of the points flattened */
  flattenAt: number | null
  setFlattenOnto: (onto: FlattenOnto) => void
  setFlattenAt: (mm: number | null) => void
  /** each selected edge chain onto the line between its ends; selected points onto their best-fit line (Straighten) */
  straightenSelection: () => void
  /** even out the spacing of the selected points (every point when nothing is selected) over the surface (Make uniform) */
  makeUniformSelection: () => void
  /** Pull: the surface through the selected points (the whole form when nothing is selected), where they are now */
  pullSelection: () => void
  /** Pull onto a body: the surface at the selected points (all when nothing is selected) onto `mesh`, the body `name` */
  pullOntoBody: (mesh: MeshLike, name: string) => void
  /** cut the form open along the selected edges, or round the selected faces (Unweld) */
  unweldSelection: () => void
  /** Weld close's distance, mm */
  weldDistance: number
  setWeldDistance: (mm: number) => void
  /** how far Extrude takes a sketch profile along its plane's normal, mm (negative: the other way) */
  profileHeight: number
  setProfileHeight: (mm: number) => void
  /**
   * Face by clicks: corners clicked on the work plane (or on the form's points)
   * make a face every 4 clicks (Enter: 3 make a triangle). `replace`: the first
   * face becomes a new form. Null when the tool is off. `carried`: how many of
   * `clicks` a chained tool carried over from the last face (the operator did
   * not click them); `added`: faces this run of the tool made (Esc reports it).
   */
  faceTool: { replace: boolean; plane: WorkPlane; planeWords: string; clicks: FaceClick[]; chain: boolean; carried: number; added: number } | null
  startFaceTool: (opts: { replace: boolean; plane?: WorkPlane; planeWords?: string; chain?: boolean }) => void
  /** Chain: each face starts the next from its last edge (the last two corners clicked), so a strip takes two
   *  clicks a face. Starts Add face chained when the Face tool is off. */
  toggleFaceChain: () => void
  /** the work plane from one of the form's own faces (Alt+click a face while the Face tool is on) */
  setFacePlaneFromFace: (face: number) => void
  addFaceClick: (click: FaceClick) => void
  /** Enter: a face from the corners clicked so far (3 or more) */
  finishFaceDraft: () => void
  stopFaceTool: () => void
  /** Pipe's tube radius, mm; 0: automatic (from the path's tightest bend) */
  pipeRadius: number
  setPipeRadius: (mm: number) => void
  /** how far Revolve turns a profile, degrees (1..360; short of 360 a closed profile gets flat end caps) */
  revolveAngle: number
  setRevolveAngle: (deg: number) => void
  /** cage spans round a revolve (3..64) */
  revolveSegments: number
  setRevolveSegments: (n: number) => void
  /** wall thickness for Thicken, mm */
  thickness: number
  setThickness: (mm: number) => void
  /** soft modification: points within this distance of the selection follow a move part of the way (0 = off) */
  softRadius: number
  setSoftRadius: (mm: number) => void
  /** Crease makes edges semi-sharp with this weight (subdivision steps they stay sharp); 0 = fully sharp */
  creaseWeight: number
  setCreaseWeight: (w: number) => void
  /** the Model body this form was started from (hidden while form mode is open; Finish leaves it hidden) */
  sourceBodyId: string | null
  setSourceBodyId: (id: string | null) => void
  /** the smooth skin's display level at rest (0 = automatic) */
  skinLevel: number
  setSkinLevel: (level: number) => void
  /** what the last tool changed, drawn in the change colour (the move arrows held back) until RESULT_FLASH_MS pass or anything else happens; null otherwise */
  resultFlash: ResultFlash | null
  /** show what a tool changed (nothing to show: no flash) */
  flashResult: (changed: Partial<ResultFlash>) => void
  /** end the flash now (a click, a drag, another tool) */
  clearResultFlash: () => void
}

/** The result flash's timer: not state anyone renders, so kept outside the store. */
let flashTimer: ReturnType<typeof setTimeout> | null = null

/** The live gizmo move: not state anyone renders, so kept outside the store. */
let moveSession: { points: number[]; primary: number[]; from: Vec3[]; weights: number[]; pairs: SymmetryPairs | null } | null = null

function describeSelection(s: CageSelection): string {
  const part = (n: number, one: string) => (n > 0 ? [`${n} ${one}${n === 1 ? '' : 's'}`] : [])
  const words = [...part(s.faces.length, 'face'), ...part(s.edges.length, 'edge'), ...part(s.points.length, 'point')]
  return words.length > 0 ? words.join(', ') : 'nothing selected'
}

/** The selection a command acts on: mirrored when symmetry is on. */
function effectiveSelection(s: Pick<FormState, 'cage' | 'selection' | 'symmetry' | 'symmetryAt' | 'symmetryNormal'>): CageSelection {
  return s.symmetry === null ? s.selection : mirrorSelection(s.cage, findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal), s.selection)
}

/** plain words for a mirror plane */
function planeWords(mode: SymmetryMode, at: number, normal: Vec3 | null): string {
  const r = (v: number) => +v.toFixed(3)
  if (mode === 'p' && normal !== null) return `Mirror plane ${r(normal[0])}x + ${r(normal[1])}y + ${r(normal[2])}z = ${r(at)}`.replace(/\+ -/g, '- ')
  return `Mirror ${mode.toUpperCase()} at ${mode.toUpperCase()} = ${r(at)}`
}

/** the state for a symmetry on at the given plane, with its notice (seam points, points without an image) */
function symmetryOn(cage: Cage, mode: SymmetryMode, at: number, normal: Vec3 | null, extra = '', requestedCopies?: number): Partial<FormState> {
  const pairs = findPairs(cage, mode, at, normal)
  const lone = unpairedCount(pairs)
  const seam = pairs.seam.reduce((n, v) => n + v, 0)
  const n = circularCount(mode)
  const what = n !== null
    ? `Circular ${n}: ${n} copies round the Z axis; ${seam} point${seam === 1 ? ' stays' : 's stay'} on the axis`
    : `${planeWords(mode, at, pairs.normal)}${extra}: ${seam} seam point${seam === 1 ? ' stays' : 's stay'} on the plane`
  return {
    symmetry: mode,
    symmetryAt: n !== null ? 0 : at,
    symmetryNormal: mode === 'p' ? pairs.normal : null,
    ...(n !== null ? { circularCopies: n } : {}),
    notice: what + (n !== null && requestedCopies !== undefined && requestedCopies !== n ? `; ${requestedCopies} copies do not fit this ${cage.positions.length}-point cage` : '')
      + (lone > 0 ? `; ${lone} point${lone === 1 ? ' has' : 's have'} no ${n !== null ? 'copies' : 'mirror partner'} and move${lone === 1 ? 's' : ''} alone` : ''),
  }
}

export type FlattenOnto = 'fit' | 'x' | 'y' | 'z' | 'face' | 'mirror'

/** The plane Flatten uses (null: the points' best fit), or what to pick first. */
function flattenPlane(s: Pick<FormState, 'cage' | 'selection' | 'flattenOnto' | 'flattenAt' | 'symmetry' | 'symmetryAt' | 'symmetryNormal'>, points: readonly number[]): { plane: { origin: Vec3; normal: Vec3 }; words: string } | null | string {
  const r = (v: number) => +v.toFixed(3)
  if (s.flattenOnto === 'fit' || points.length === 0) return null
  if (s.flattenOnto === 'x' || s.flattenOnto === 'y' || s.flattenOnto === 'z') {
    const k = { x: 0, y: 1, z: 2 }[s.flattenOnto]
    const at = s.flattenAt ?? points.reduce((a, p) => a + s.cage.positions[p][k], 0) / points.length
    const normal: Vec3 = [0, 0, 0]
    normal[k] = 1
    const origin: Vec3 = [0, 0, 0]
    origin[k] = at
    return { plane: { origin, normal }, words: `the ${s.flattenOnto.toUpperCase()} plane at ${s.flattenOnto.toUpperCase()} = ${r(at)}` }
  }
  if (s.flattenOnto === 'face') {
    const f = s.selection.faces[0]
    if (f === undefined || s.cage.faces[f] === undefined) return 'Select a face: its plane is the one the points go onto'
    const corners = s.cage.faces[f].map((p) => s.cage.positions[p])
    const fit = principalAxes(corners)
    return { plane: { origin: fit.centre, normal: fit.axes[0] }, words: 'the selected face\'s plane' }
  }
  const normal = s.symmetry === null ? null : mirrorNormal(s.symmetry, s.symmetryNormal)
  // No plain mirror on: the list shows (and does) best fit, not a stale "mirror".
  if (normal === null) return null
  return { plane: { origin: [normal[0] * s.symmetryAt, normal[1] * s.symmetryAt, normal[2] * s.symmetryAt], normal }, words: 'the mirror plane' }
}

/** A new topology (Undo, Redo, Delete, Weld close, a starter ...) under a face draft: its corners named the old
 *  cage's points, so they start again. */
function clearedFaceDraft(t: FormState['faceTool']): FormState['faceTool'] {
  return t === null || t.clicks.length === 0 ? t : { ...t, clicks: [], carried: 0 }
}

/** The corners the operator has clicked for this face, out of the corners it still needs (a chained face
 *  starts with its last edge's two carried). */
function faceCount(t: NonNullable<FormState['faceTool']>, clicks = t.clicks.length): string {
  return `${clicks - t.carried} of ${4 - t.carried} corners`
}

/** A face from the clicks, added to the form (or starting a new one); the tool stays on for the next. */
function commitFace(get: () => FormState, set: (partial: Partial<FormState>) => void, clicks: FaceClick[]): void {
  const t = get().faceTool!
  const r = addClickedFace(get().cage, clicks, t.plane, t.replace)
  if ('reason' in r) { set({ faceTool: { ...t, clicks: [], carried: 0 }, notice: `${r.reason}; the corners are cleared, click again` }); return }
  const startingNewForm = t.replace
  const next = t.chain ? 'chained on its last edge: click the next 2 corners, or Esc' : 'click the next 4 corners, or Esc'
  const ok = get().applyCage(r.cage, { topology: true, record: true, startFrom: startingNewForm, notice: `Added a face with ${r.face.length} corners${t.replace ? ' as a new form' : ''}; ${next}` })
  // the next face joins this form (a click on one of its points shares it); chained, it starts on this face's
  // last edge (its last two corners, in the order clicked), so its next corner goes beside the last one clicked:
  // a strip is clicked back and forth
  const n = r.corners.length
  const carried: FaceClick[] = ok && t.chain ? [{ point: r.corners[n - 2] }, { point: r.corners[n - 1] }] : []
  set({
    faceTool: { ...t, replace: t.replace && !ok, clicks: carried, carried: carried.length, added: t.added + (ok ? 1 : 0) },
    ...(ok ? { selection: { points: [], edges: [], faces: [r.cage.faces.length - 1] } } : {}),
    ...(startingNewForm && ok ? { startedFrom: 'face' } : {}),
  })
}

/**
 * An edge loop across the ring of the first selected edge (and its symmetry
 * images) at `t` of each edge from the edge's lower end, or null. Insert loop
 * uses it, and so does moving the Loop slider while that loop is live.
 */
function loopInsertion(s: Pick<FormState, 'cage' | 'selection' | 'symmetry' | 'symmetryAt' | 'symmetryNormal'>, t: number): { cage: Cage; loopEdges: string[] } | null {
const first = s.selection.edges[0]
if (first === undefined) return null
  // measured from the edge's lower end (then -Y, then -X); each symmetry image from its image of that end
  const [a, b] = parseEdgeKey(first)
  const pa = s.cage.positions[a], pb = s.cage.positions[b]
  const lower = pa[2] !== pb[2] ? (pa[2] < pb[2] ? a : b) : pa[1] !== pb[1] ? (pa[1] < pb[1] ? a : b) : pa[0] <= pb[0] ? a : b
  // the first selected edge, then its images. An image on the first edge's own ring measured from the
  // same side is the same loop (skipped); measured from the other side (an edge crossing the mirror plane
  // is its own image, ends swapped) it needs a second loop on that ring at 1 - t, so the two mirror.
  const ring = edgeRing(s.cage, first)
  const sides = ringSides(s.cage, first, ring.steps, lower)
  let pairOnRing = false
  const targets: Array<{ key: string; from: number }> = [{ key: first, from: lower }]
  if (s.symmetry !== null) {
    const pairs = findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal)
    for (const img of pairs.images) {
      const [ia, ib, io] = [img[a], img[b], img[lower]]
      if (ia < 0 || ib < 0 || io < 0) continue
      const key = edgeKey(ia, ib)
      if (sides.has(key)) { if (sides.get(key) !== io && t !== 0.5) pairOnRing = true; continue }
      if (!targets.some((x) => x.key === key)) targets.push({ key, from: io })
    }
  }
  let cage = s.cage
  const loopEdges: string[] = []
  for (const { key, from } of targets) {
    if (key === first && pairOnRing) {
      // the far loop first, then the near one on the start edge's near half
      const hi = Math.max(t, 1 - t), lo = Math.min(t, 1 - t)
      const r1 = insertEdgeLoop(cage, key, hi, from)
      if (!r1) continue
      const other = from === a ? b : a
      // the new point on the start edge: the one at `hi` of the way from `from` to `other`
      const P = cage.positions, f0 = P[from], f1 = P[other]
      const want = [0, 1, 2].map((k) => f0[k] + (f1[k] - f0[k]) * hi)
      const near = r1.newPoints.find((m) => Math.hypot(...[0, 1, 2].map((k) => r1.cage.positions[m][k] - want[k])) < 1e-9 * (1 + Math.hypot(...[0, 1, 2].map((k) => f1[k] - f0[k]))))
      cage = r1.cage
      loopEdges.push(...r1.loopEdges)
      if (near === undefined) continue
      const r2 = insertEdgeLoop(cage, edgeKey(from, near), lo / hi, from)
      if (!r2) continue
      cage = r2.cage
      loopEdges.push(...r2.loopEdges)
      continue
    }
    const r = insertEdgeLoop(cage, key, t, from)
    if (!r) continue
    cage = r.cage
    loopEdges.push(...r.loopEdges)
  }
  return loopEdges.length === 0 ? null : { cage, loopEdges }
}

function loopNotice(edges: number, t: number): string {
  return `Inserted an edge loop (${edges} edges)${t === 0.5 ? '' : ` at ${t} of each edge from the selected edge's lower end`}; the Loop slider moves it until the next change`
}

const initialKind: StarterKind = 'box'

function initialSegments(): Record<StarterKind, { x: number; y: number; z: number }> {
  return {
    box: { ...STARTER_DEFAULTS.box.segments },
    cylinder: { ...STARTER_DEFAULTS.cylinder.segments },
    sphere: { ...STARTER_DEFAULTS.sphere.segments },
    torus: { ...STARTER_DEFAULTS.torus.segments },
    plane: { ...STARTER_DEFAULTS.plane.segments },
  }
}

function rotationPickNotice(pick: RotationPick): string {
  return pick === 'edge' ? 'Click a cage edge for the rotation axis; Esc cancels' : `Click a cage point for the ${pick.toUpperCase()} axis; Esc cancels`
}

// The status line is shared by every tool. Cancel only the instruction owned by
// the current axis choice, keeping newer tool results and completed-turn feedback.
function hasRotationInstruction(s: FormState): boolean {
  return s.rotationPick !== null ? s.notice === rotationPickNotice(s.rotationPick)
    : s.rotationAxis !== null && s.notice === `Rotate about ${s.rotationAxis.label}`
}

export const useFormStore = create<FormState>()((set, get) => ({
  cage: starterCage(initialKind),
  topologyVersion: 1,
  positionsVersion: 1,
  history: emptyHistory(),
  editVersion: 0,
  startFromRail: { checkedEdit: 0, folded: false, manual: false },
  displayMode: 'both',
  dragging: false,
  starterKind: initialKind,
  starterSegments: initialSegments(),
  startedFrom: null,
  active: false,
  featureId: null,
  name: 'Form',
  tolerance: 0.01,
  notice: null,
  selection: EMPTY_SELECTION,
  transformMode: 'translate',
  rotationAxis: null,
  rotationPick: null,
  rotationCentreAxis: 'z',
  rotationAngle: 90,
  chooseRotationAxis: (pick) => {
    if (get().dragging) return
    get().clearResultFlash()
    const s = get()
    const notice = pick !== null ? rotationPickNotice(pick)
      : hasRotationInstruction(s) || s.notice === null ? 'Rotate about the selection centre' : s.notice
    set({ rotationPick: pick, rotationAxis: null, notice })
  },
  pickRotationAxis: (pick) => {
    const s = get(), mode = s.rotationPick
    if (mode === null) return
    let axis: RotationAxis | null = null
    if (mode === 'edge' && pick?.kind === 'edge') {
      const [a, b] = parseEdgeKey(pick.key), p = s.cage.positions[a], q = s.cage.positions[b]
      if (p && q) {
        const d = new Vector3(...q).sub(new Vector3(...p))
        if (d.lengthSq() > 1e-18) axis = { origin: [...p], direction: d.normalize().toArray() as Vec3, label: `edge ${pick.key}` }
      }
    } else if (mode !== 'edge' && pick?.kind === 'point' && s.cage.positions[pick.index]) {
      const direction: Vec3 = [0, 0, 0]
      direction[{ x: 0, y: 1, z: 2 }[mode]] = 1
      axis = { origin: [...s.cage.positions[pick.index]], direction, label: `${mode.toUpperCase()} through point ${pick.index}` }
    }
    if (axis) set({ rotationAxis: axis, rotationPick: null, notice: `Rotate about ${axis.label}` })
  },
  setRotationCentreAxis: (rotationCentreAxis) => set({ rotationCentreAxis }),
  setRotationAngle: (rotationAngle) => { if (Number.isFinite(rotationAngle)) set({ rotationAngle }) },
  rotateSelection: () => {
    const s = get(), points = selectionPoints(s.cage, s.selection)
    if (s.transformMode !== 'rotate' || s.rotationPick !== null || s.dragging || points.length === 0 || s.rotationAngle === 0) return
    const direction: Vec3 = [0, 0, 0]
    direction[{ x: 0, y: 1, z: 2 }[s.rotationCentreAxis]] = 1
    const origin = s.rotationAxis?.origin ?? points.reduce<Vec3>((c, p) => c.map((v, k) => v + s.cage.positions[p][k] / points.length) as Vec3, [0, 0, 0])
    const matrix = new Matrix4().makeTranslation(...origin)
      .multiply(new Matrix4().makeRotationAxis(new Vector3(...(s.rotationAxis?.direction ?? direction)), s.rotationAngle * Math.PI / 180))
      .multiply(new Matrix4().makeTranslation(-origin[0], -origin[1], -origin[2]))
    get().beginMove({ extrude: false })
    get().moveBy(matrix.elements)
    get().endDrag()
    set({ notice: `Rotated ${s.rotationAngle} deg about ${s.rotationAxis?.label ?? `${s.rotationCentreAxis.toUpperCase()} through the selection centre`}` })
  },
  symmetry: null,
  symmetryAt: 0,
  symmetryNormal: null,
  circularCopies: 6,
  setCircularCopies: (n) => {
    const copies = Math.max(2, Math.min(24, Math.round(n)))
    set({ circularCopies: copies })
    if (circularCount(get().symmetry ?? 'x') !== null) get().setSymmetry(`c${copies}`)
  },

  toggleCircular: () => {
    const s = get()
    if (s.symmetry !== null && circularCount(s.symmetry) !== null) { get().setSymmetry(null); return }
    const fits = (n: number) => unpairedCount(findPairs(s.cage, `c${n}`)) === 0
    let n = s.circularCopies
    if (!fits(n)) for (let k = 24; k >= 2; k--) if (fits(k)) { n = k; break }
    set(symmetryOn(s.cage, `c${n}`, 0, null, '', s.circularCopies))
  },

  newFromStarter: (kind, opts) => {
    const segments = opts?.segments ?? get().starterSegments[kind]
    const cage = starterCage(kind, { ...opts, segments })
    set({ sourceBodyId: null })
    const ok = get().applyCage(cage, { topology: true, record: true, startFrom: true, notice: `New ${kind} (${cage.faces.length} faces)` })
    set({ starterKind: kind, selection: EMPTY_SELECTION, ...(ok ? { startedFrom: kind } : {}) })
  },
  setStarterKind: (kind) => set({ starterKind: kind }),
  setStarterSegments: (kind, segments) => set((s) => ({ starterSegments: { ...s.starterSegments, [kind]: segments } })),

  applyCage: (next, opts) => {
    if (opts.topology) {
      const check = validateCage(next)
      if (!check.ok) {
        set({ notice: `Not applied: ${check.problems[0]}` })
        return false
      }
    }
    const s = get()
    set({
      cage: cloneCage(next),
      history: opts.record ? pushHistory(s.history, s.cage) : s.history,
      editVersion: opts.record && !opts.startFrom ? s.editVersion + 1 : s.editVersion,
      topologyVersion: opts.topology ? s.topologyVersion + 1 : s.topologyVersion,
      positionsVersion: s.positionsVersion + 1,
      notice: opts.notice ?? s.notice,
      selection: opts.topology ? pruneSelection(next, s.selection) : s.selection,
      // any new topology (Delete, Weld close, a starter ...) renumbers the points a face draft named
      faceTool: opts.topology ? clearedFaceDraft(s.faceTool) : s.faceTool,
    })
    return true
  },
  dragCage: (next) => set((s) => ({ cage: next, positionsVersion: s.positionsVersion + 1 })),
  beginDrag: (opts) => set((s) => ({ history: opts?.record === false ? s.history : pushHistory(s.history, s.cage), editVersion: opts?.record === false ? s.editVersion : s.editVersion + 1, dragging: true })),
  endDrag: () => set((s) => ({ dragging: false, positionsVersion: s.positionsVersion + 1 })),
  undo: () => {
    const s = get()
    const r = undoCage(s.history, s.cage)
    if (!r) return
    set({ cage: r.cage, history: r.history, topologyVersion: s.topologyVersion + 1, positionsVersion: s.positionsVersion + 1, notice: 'Undo', selection: pruneSelection(r.cage, s.selection), faceTool: clearedFaceDraft(s.faceTool) })
  },
  redo: () => {
    const s = get()
    const r = redoCage(s.history, s.cage)
    if (!r) return
    set({ cage: r.cage, history: r.history, topologyVersion: s.topologyVersion + 1, positionsVersion: s.positionsVersion + 1, notice: 'Redo', selection: pruneSelection(r.cage, s.selection), faceTool: clearedFaceDraft(s.faceTool) })
  },
  setDisplayMode: (mode) => set({ displayMode: mode }),
  openSession: ({ featureId, name, cage, tolerance, symmetry, symmetryAt, symmetryNormal }) => {
    const s = get()
    set({
      active: true,
      featureId,
      name,
      tolerance: tolerance ?? 0.01,
      cage: cloneCage(cage ?? starterCage(s.starterKind, { segments: s.starterSegments[s.starterKind] })),
      history: emptyHistory(),
      editVersion: 0,
      startFromRail: { checkedEdit: 0, folded: false, manual: false },
      topologyVersion: s.topologyVersion + 1,
      positionsVersion: s.positionsVersion + 1,
      dragging: false,
      notice: null,
      selection: EMPTY_SELECTION,
      // A transform choice belongs to this session, including when editing a saved feature.
      transformMode: 'translate',
      rotationAxis: null, rotationPick: null, rotationAngle: 90, rotationCentreAxis: 'z',
      symmetry: symmetry ?? null,
      symmetryAt: symmetryAt ?? 0,
      symmetryNormal: symmetry === 'p' ? (symmetryNormal ?? null) : null,
      faceTool: null,
      // a new form starts from the current starter (the cage it just got); an existing feature's cage does
      // not record what it was started from yet, so none of the Start-from buttons light for it
      startedFrom: cage === undefined ? s.starterKind : null,
    })
  },
  closeSession: () => set({ active: false, featureId: null, sourceBodyId: null, dragging: false, selection: EMPTY_SELECTION, history: emptyHistory(), notice: null, faceTool: null, startedFrom: null }),
  setName: (name) => set({ name }),
  exportCageObj: () => {
    const { cage, name } = get()
    const filename = name.split('').map((char) =>
      char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char,
    ).join('').trim().replace(/[. ]+$/g, '') || 'Form'
    return saveFile(`${filename}.obj`, cageObj(cage), 'model/obj')
  },
  setTolerance: (tolerance) => set({ tolerance }),
  setNotice: (notice) => set({ notice }),
  select: (pick, additive) => set((s) => ({ selection: applyPick(s.selection, pick, additive) })),
  selectPoints: (points, mode) => set((s) => ({ selection: applyPoints(s.selection, points, mode) })),
  setSelection: (selection) => set({ selection }),
  setTransformMode: (mode) => {
    // pressing Move / Rotate / Scale asks for the arrows: a flash gives way even when the mode is unchanged
    get().clearResultFlash()
    set({ transformMode: mode })
  },
  extrudeSelection: () => {
    const s = get()
    if (s.selection.faces.length === 0) return null
    const userFaces = s.selection.faces
    const result = extrudeFaces(s.cage, effectiveSelection(s).faces)
    const n = result.faces.length
    const ok = get().applyCage(result.cage, { topology: true, record: true, notice: `Extruded ${n} face${n === 1 ? '' : 's'}` })
    if (!ok) return null
    // the operator's own faces stay selected (they keep their indices); the mirror side follows via symmetry
    set({ selection: { points: [], edges: [], faces: userFaces } })
    return result.movedPoints
  },
  beginMove: ({ extrude }) => {
    let points: number[] | null = null
    if (extrude) {
      points = get().extrudeSelection()
      if (points !== null) get().beginDrag({ record: false })
    }
    const s = get()
    if (points === null) {
      points = selectionPoints(s.cage, effectiveSelection(s))
      get().beginDrag()
    }
    const cage = get().cage
    const primary = selectionPoints(cage, get().selection)
    // soft modification (not for an extrude: its new faces move rigidly)
    const soft = extrude ? new Map<number, number>() : softWeights(cage, points, get().softRadius)
    const moving = [...points, ...soft.keys()]
    moveSession = {
      points: moving,
      // after an extrude the operator's faces ride on new points: those are the primary side
      primary: extrude ? points.filter((p) => primary.includes(p)) : primary,
      from: moving.map((p) => [...cage.positions[p]] as Vec3),
      weights: [...points.map(() => 1), ...soft.values()],
      pairs: s.symmetry === null ? null : findPairs(cage, s.symmetry, s.symmetryAt, s.symmetryNormal),
    }
  },
  moveBy: (matrix) => {
    const m = moveSession
    if (!m) return
    let next = transformPoints(get().cage, m.from, m.points, matrix, m.weights)
    if (m.pairs) next = symmetrize(next, m.pairs, m.points, m.primary)
    get().dragCage(next)
  },
  insertLoop: () => {
    const s = get()
    if (s.selection.edges[0] === undefined) {
      set({ notice: 'Select an edge first: the loop runs across the ring of faces through it' })
      return
    }
    const r = loopInsertion(s, s.loopPosition)
    if (r === null) return
    if (get().applyCage(r.cage, { topology: true, record: true, notice: loopNotice(r.loopEdges.length, s.loopPosition) })) {
      // live: the Loop slider moves this loop until anything else changes the form
      set({ selection: { points: [], edges: r.loopEdges, faces: [] }, liveLoop: { before: s.cage, selection: s.selection, cage: get().cage } })
      get().flashResult({ edges: r.loopEdges })
    }
  },
  loopPosition: 0.5,
  liveLoop: null,
  setLoopPosition: (t) => {
    const loopPosition = Number.isFinite(t) ? Math.min(0.99, Math.max(0.01, t)) : 0.5
    set({ loopPosition })
    // the loop just inserted, with nothing changed since: put it at the new position (no new undo step)
    const s = get()
    const live = s.liveLoop
    if (live === null || s.cage !== live.cage) return
    const r = loopInsertion({ ...s, cage: live.before, selection: live.selection }, loopPosition)
    if (r === null || !get().applyCage(r.cage, { topology: true, record: false, notice: loopNotice(r.loopEdges.length, loopPosition) })) return
    set({ selection: { points: [], edges: r.loopEdges, faces: [] }, liveLoop: { ...live, cage: get().cage } })
  },
  crease: (creased) => {
    const s = get()
    const targets = creaseTargets(s.cage, effectiveSelection(s))
    if (targets.length === 0) {
      set({ notice: `Select edges or faces to ${creased ? 'crease' : 'uncrease'}` })
      return
    }
    const w = creased ? s.creaseWeight : 0
    const next = setCreased(s.cage, targets, creased, w)
    // only the edges whose crease (or its weight) is different now changed
    const sharpBefore = new Set(s.cage.creases), sharpAfter = new Set(next.creases)
    const changed = targets.filter((k) => sharpBefore.has(k) !== sharpAfter.has(k) || (s.cage.weights?.[k] ?? 0) !== (next.weights?.[k] ?? 0))
    if (changed.length === 0) {
      set({ notice: `${creased ? 'Crease' : 'Uncrease'}: already ${creased ? 'creased' : 'smooth'} - nothing changed` })
      return
    }
    if (get().applyCage(next, {
      topology: true, record: true,
      notice: `${creased ? 'Creased' : 'Uncreased'} ${changed.length} edge${changed.length === 1 ? '' : 's'}${w > 0 ? ` (weight ${w}: soft, sharp for ${w} step${w === 1 ? '' : 's'})` : ''}`,
    })) get().flashResult({ edges: changed })
  },
  thickness: 2,
  setThickness: (mm) => set({ thickness: mm }),
  softRadius: 0,
  setSoftRadius: (mm) => set({ softRadius: mm }),
  creaseWeight: 0,
  setCreaseWeight: (w) => set({ creaseWeight: Math.max(0, w) }),
  sourceBodyId: null,
  setSourceBodyId: (id) => set({ sourceBodyId: id }),
  skinLevel: 0,
  setSkinLevel: (level) => set({ skinLevel: Math.max(0, Math.round(level)) }),
  resultFlash: null,
  flashResult: (changed) => {
    get().clearResultFlash()
    const flash: ResultFlash = { points: changed.points ?? [], edges: changed.edges ?? [], faces: changed.faces ?? [] }
    if (flash.points.length + flash.edges.length + flash.faces.length === 0) return
    set({ resultFlash: flash })
    flashTimer = setTimeout(() => {
      flashTimer = null
      if (get().resultFlash === flash) set({ resultFlash: null })
    }, RESULT_FLASH_MS)
  },
  clearResultFlash: () => {
    if (flashTimer !== null) { clearTimeout(flashTimer); flashTimer = null }
    if (get().resultFlash !== null) set({ resultFlash: null })
  },
  selectLoop: () => {
    const s = get()
    if (s.selection.edges.length === 0 && s.selection.points.length > 0) {
      // points: the whole ring of points through them (a cylinder's cap ring from one of its points)
      const ring = pointLoop(s.cage, s.selection.points)
      if (ring === null) { set({ notice: 'No single ring runs through these points: select two neighbours on the ring you want' }); return }
      set({ selection: { ...s.selection, points: ring }, notice: `Selected ${ring.length} points round the ring` })
      return
    }
    if (s.selection.edges.length === 0) { set({ notice: 'Select an edge or a point first: its loop runs straight on through the points around it' }); return }
    const edges = new Set(s.selection.edges)
    for (const e of s.selection.edges) for (const k of edgeLoop(s.cage, e)) edges.add(k)
    set({ selection: { ...s.selection, edges: [...edges] }, notice: `Selected ${edges.size} edge${edges.size === 1 ? '' : 's'} along the loop` })
  },
  selectRing: () => {
    const s = get()
    if (s.selection.edges.length === 0) { set({ notice: 'Select an edge first: its ring runs across the faces beside it' }); return }
    const edges = new Set(s.selection.edges)
    for (const e of s.selection.edges) for (const k of edgeRing(s.cage, e).edges) edges.add(k)
    set({ selection: { ...s.selection, edges: [...edges] }, notice: `Selected ${edges.size} edge${edges.size === 1 ? '' : 's'} across the ring` })
  },
  deleteSelectedFaces: () => {
    const s = get()
    const faces = effectiveSelection(s).faces
    if (faces.length === 0) { set({ notice: 'Select faces to delete' }); return }
    if (get().applyCage(deleteFaces(s.cage, faces), { topology: true, record: true, notice: `Deleted ${faces.length} face${faces.length === 1 ? '' : 's'}: the form is open there (Fill hole or Thicken closes it)` })) {
      set({ selection: EMPTY_SELECTION })
    }
  },
  deleteSelection: () => {
    const s = get()
    const eff = effectiveSelection(s)
    if (eff.faces.length === 0 && eff.edges.length === 0 && eff.points.length > 0) {
      // points: every edge through each one dissolves, so the faces round it merge into one and the point goes
      const picked = new Set(eff.points)
      const through = new Set<string>()
      for (const f of s.cage.faces) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; if (picked.has(a) || picked.has(b)) through.add(edgeKey(a, b)) }
      const r = dissolveEdges(s.cage, [...through])
      const key = (p: readonly number[]) => p.join(',')
      const left = r === null ? eff.points.length : (() => { const at = new Set(r.cage.positions.map(key)); return eff.points.filter((p) => at.has(key(s.cage.positions[p]))).length })()
      if (r === null || left === eff.points.length) { set({ notice: 'Nothing to delete there: a point on the form\'s open border keeps its border edges (Delete faces opens the form)' }); return }
      const gone = eff.points.length - left
      const extra = [left > 0 ? `${left} on the open border stay (their border edges hold them)` : '', r.skipped > 0 ? `${r.skipped} group${r.skipped === 1 ? '' : 's'} of faces left as ${r.skipped === 1 ? 'it was' : 'they were'} (they would not merge into one outline)` : ''].filter(Boolean).join('; ')
      if (get().applyCage(r.cage, { topology: true, record: true, notice: `Deleted ${gone} point${gone === 1 ? '' : 's'}: the faces round ${gone === 1 ? 'it' : 'each'} merged into one${extra ? `; ${extra}` : ''}` })) {
        set({ selection: EMPTY_SELECTION })
      }
      return
    }
    if (eff.faces.length > 0 || eff.edges.length === 0) { get().deleteSelectedFaces(); return }
    const r = dissolveEdges(s.cage, eff.edges)
    if (r === null) { set({ notice: 'Nothing to delete there: an edge on the form\'s open border has only one face (Delete faces opens the form)' }); return }
    const extra = [r.points > 0 ? `${r.points} point${r.points === 1 ? '' : 's'} left between two edges removed` : '', r.skipped > 0 ? `${r.skipped} group${r.skipped === 1 ? '' : 's'} left as ${r.skipped === 1 ? 'it was' : 'they were'} (the faces would not merge into one outline)` : ''].filter(Boolean).join('; ')
    if (get().applyCage(r.cage, { topology: true, record: true, notice: `Deleted ${r.removed} edge${r.removed === 1 ? '' : 's'}: the faces either side merged${extra ? `; ${extra}` : ''}` })) {
      set({ selection: EMPTY_SELECTION })
    }
  },
  fillHoleAtSelection: () => {
    const s = get()
    const edge = s.selection.edges.find((e) => openLoopThrough(s.cage, e) !== null)
    if (edge === undefined) { set({ notice: 'Select an edge on the rim of an opening to fill it' }); return }
    const next = fillHole(s.cage, edge)!
    if (get().applyCage(next, { topology: true, record: true, notice: `Filled the opening with one ${next.faces[next.faces.length - 1].length}-sided face` })) {
      set({ selection: { points: [], edges: [], faces: [next.faces.length - 1] } })
      get().flashResult({ faces: [next.faces.length - 1] })
    }
  },
  bridgeSelection: () => {
    const s = get()
    const seg = s.bridgeSegments
    let r: { cage: Cage; faces: number[] } | null
    let what: string
    if (s.selection.faces.length > 0) {
      const sets = faceSets(s.cage, s.selection.faces)
      if (sets.length !== 2) { set({ notice: `Bridge joins two separate face sets; the selected faces make ${sets.length}` }); return }
      r = bridgeFaceSets(s.cage, sets[0], sets[1], seg, s.bridgeTwist)
      if (r === null) { set({ notice: 'Bridge needs each face set to have one outline (a band round the form has two) and the two sets not to share a point' }); return }
      what = sets[0].length === 1 && sets[1].length === 1 ? 'the two faces' : `the two face sets (${sets[0].length} and ${sets[1].length} faces)`
    } else {
      const loops = openLoops(s.cage, s.selection.edges)
      if (loops.length !== 2) { set({ notice: loops.length === 0 ? 'Select two faces, two face sets, or the edges of two openings (or two open borders) to bridge' : `Bridge joins two openings; the selected open edges make ${loops.length}` }); return }
      r = bridgeOpenings(s.cage, loops[0], loops[1], seg, s.bridgeTwist)
      if (r === null) { set({ notice: 'Bridge joins two closed openings or two open borders, not one of each, and not sharing a point' }); return }
      what = loops[0].closed ? `the two openings (${loops[0].points.length} and ${loops[1].points.length} edges round)` : `the two open borders (${loops[0].points.length - 1} and ${loops[1].points.length - 1} edges)`
    }
    const tris = r.faces.filter((f) => r!.cage.faces[f].length === 3).length
    const twist = s.bridgeTwist !== 0 && (s.selection.faces.length > 0 || openLoops(s.cage, s.selection.edges)[0]?.closed) ? `, twisted ${s.bridgeTwist} point${Math.abs(s.bridgeTwist) === 1 ? '' : 's'} round` : ''
    if (get().applyCage(r.cage, { topology: true, record: true, notice: `Bridged ${what} with ${r.faces.length} faces, ${seg} segment${seg === 1 ? '' : 's'} long${twist}${tris > 0 ? ` (${tris} triangles where the two differ in length)` : ''}` })) {
      set({ selection: { points: [], edges: [], faces: r.faces } })
      get().flashResult({ faces: r.faces })
    }
  },
  bridgeSegments: 1,
  bridgeTwist: 0,
  setBridgeTwist: (n) => set({ bridgeTwist: Number.isFinite(n) ? Math.max(-64, Math.min(64, Math.round(n))) : 0 }),
  setBridgeSegments: (n) => set({ bridgeSegments: Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : 1 }),
  thickenForm: () => {
    const s = get()
    const next = thicken(s.cage, s.thickness)
    if (next === null) { set({ notice: 'Thicken closes an open form; this form has no opening' }); return }
    if (get().applyCage(next, { topology: true, record: true, notice: `Thickened by ${s.thickness} mm: the form is closed` })) set({ selection: EMPTY_SELECTION })
  },
  growSelection: () => {
    const s = get()
    const next = growSelection(s.cage, s.selection)
    set({ selection: next, notice: `Grown to ${describeSelection(next)}` })
  },
  shrinkSelection: () => {
    const s = get()
    const next = shrinkSelection(s.cage, s.selection)
    set({ selection: next, notice: `Shrunk to ${describeSelection(next)}` })
  },
  selectAll: () => {
    const s = get()
    const next = selectAll(s.cage, s.selection)
    set({ selection: next, notice: `Selected all: ${describeSelection(next)}` })
  },
  insertPointOnSelection: () => {
    const s = get()
    const edges = s.selection.edges
    if (edges.length === 0) { set({ notice: 'Select edges to insert a point in the middle of each' }); return }
    const { cage, mid } = splitEdges(s.cage, edges)
    if (get().applyCage(cage, { topology: true, record: true, notice: `Inserted ${mid.size} point${mid.size === 1 ? '' : 's'}: the faces beside ${mid.size === 1 ? 'that edge' : 'those edges'} gained a side` })) {
      set({ selection: { points: [...mid.values()], edges: [], faces: [] } })
      get().flashResult({ points: [...mid.values()] })
    }
  },
  subdivideSelection: () => {
    const s = get()
    const faces = effectiveSelection(s).faces
    if (faces.length === 0) { set({ notice: 'Select faces to subdivide' }); return }
    const { cage, faces: made } = subdivideFaces(s.cage, faces)
    if (get().applyCage(cage, { topology: true, record: true, notice: `Subdivided ${faces.length} face${faces.length === 1 ? '' : 's'} into ${made.length} quads` })) {
      set({ selection: { points: [], edges: [], faces: made } })
      get().flashResult({ faces: made })
    }
  },
  weldSelection: () => {
    const s = get()
    const points = selectionPoints(s.cage, s.selection)
    const welded = weldPoints(s.cage, points)
    if (welded === null) { set({ notice: 'Select two or more points (or an edge) to weld' }); return }
    if (get().applyCage(welded.cage, { topology: true, record: true, notice: `Welded ${new Set(points).size} points into one` })) {
      set({ selection: { points: welded.point >= 0 ? [welded.point] : [], edges: [], faces: [] } })
      get().flashResult({ points: welded.point >= 0 ? [welded.point] : [] })
    }
  },
  flattenOnto: 'fit',
  flattenAt: null,
  setFlattenOnto: (onto) => set({ flattenOnto: onto, flattenAt: null }),
  setFlattenAt: (mm) => set({ flattenAt: mm !== null && Number.isFinite(mm) ? mm : null }),
  flattenSelection: () => {
    const s = get()
    const points = selectionPoints(s.cage, s.selection)
    const target = flattenPlane(s, points)
    if (typeof target === 'string') { set({ notice: target }); return }
    const r = flattenPoints(s.cage, points, target?.plane)
    if (r === null) { set({ notice: 'Select three or more points (or a face, or edges) to flatten' }); return }
    const next = s.symmetry === null ? r.cage : symmetrize(r.cage, findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal), points)
    if (get().applyCage(next, { topology: false, record: true, notice: `Flattened ${points.length} point${points.length === 1 ? '' : 's'} onto ${target?.words ?? 'their plane'} (the farthest was ${r.before.toFixed(2)} mm off it)` })) get().flashResult({ points: movedPoints(s.cage, next).points })
  },
  straightenSelection: () => {
    const s = get()
    const r = straightenChains(s.cage, s.selection.edges, s.selection.points)
    if (r === null) {
      const chains = edgeChains(s.selection.edges)
      let notice = 'Select a chain of edges (or three or more points) to straighten'
      if (chains.length > 0 && chains.every((c) => c.kind === 'loop')) {
        notice = 'A closed loop has no two ends to run a line between; Flatten makes it planar'
      } else if (chains.length === 1 && chains[0].kind === 'open' && chains[0].points.length === 2) {
        notice = 'One edge is already straight - select two or more edges in a row (or three or more points).'
      } else if (chains.some((c) => c.kind === 'open' && c.points.length >= 3)) {
        notice = 'The chain ends are in the same place - move an end to define a line to straighten along.'
      }
      set({ notice })
      return
    }
    const moved = [...new Set([...selectionPoints(s.cage, { points: s.selection.points, edges: s.selection.edges, faces: [] })])]
    const next = s.symmetry === null ? r.cage : symmetrize(r.cage, findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal), moved)
    const skipped = r.loops > 0 ? `; ${r.loops} closed loop${r.loops === 1 ? '' : 's'} left as ${r.loops === 1 ? 'it was' : 'they were'} (Flatten makes a loop planar)` : ''
    if (get().applyCage(next, { topology: false, record: true, notice: `Straightened ${r.lines} line${r.lines === 1 ? '' : 's'}, ${r.moved} point${r.moved === 1 ? '' : 's'} moved (the farthest was ${r.before.toFixed(2)} mm off)${skipped}` })) get().flashResult({ points: movedPoints(s.cage, next).points })
  },
  pullOntoBody: (mesh, name) => {
    const s = get()
    const picked = selectionPoints(s.cage, s.selection)
    const points = picked.length > 0 ? picked : s.cage.positions.map((_, i) => i)
    const r = pullOntoMesh(s.cage, points, closestPointIndex(mesh))
    if (r === null) return
    const next = s.symmetry === null ? r.cage : symmetrize(r.cage, findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal), points)
    const where = picked.length > 0 ? `the ${points.length} selected point${points.length === 1 ? '' : 's'}` : `all ${points.length} points`
    if (get().applyCage(next, { topology: false, record: true, notice: `Pulled the surface at ${where} onto ${name}: within ${r.after.toFixed(2)} mm of its display mesh (it was up to ${r.before.toFixed(2)} mm off)` })) get().flashResult({ points: movedPoints(s.cage, next).points })
  },
  pullSelection: () => {
    const s = get()
    const picked = selectionPoints(s.cage, s.selection)
    const points = picked.length > 0 ? picked : s.cage.positions.map((_, i) => i)
    const r = pullToLimit(s.cage, points)
    if (r === null) return
    const next = s.symmetry === null ? r.cage : symmetrize(r.cage, findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal), points)
    const where = picked.length > 0 ? `the ${points.length} selected point${points.length === 1 ? '' : 's'}` : `all ${points.length} points`
    if (get().applyCage(next, { topology: false, record: true, notice: `Pulled the surface through ${where} (it was up to ${r.before.toFixed(2)} mm off them)` })) get().flashResult({ points: movedPoints(s.cage, next).points })
  },
  makeUniformSelection: () => {
    const s = get()
    const picked = selectionPoints(s.cage, s.selection)
    const points = picked.length > 0 ? picked : s.cage.positions.map((_, i) => i)
    const where = picked.length > 0 ? 'selected' : 'form\'s'
    const r = makeUniform(s.cage, points)
    if (r === null) { set({ notice: `Nothing to even out: the ${where} points are all on the open border or on creases, which stay put` }); return }
    const next = s.symmetry === null ? r.cage : symmetrize(r.cage, findPairs(s.cage, s.symmetry, s.symmetryAt, s.symmetryNormal), points)
    // decided on distance, not on how many points were free to move: an even form moves none of them
    const moved = movedPoints(s.cage, next)
    if (moved.points.length === 0) { set({ notice: 'Uniform: already even - nothing moved' }); return }
    const given = new Set(points)
    if (get().applyCage(next, { topology: false, record: true, notice: `Made ${moved.points.filter((p) => given.has(p)).length} of the ${where} points uniform: edge length spread ${r.before.toFixed(2)} -> ${r.after.toFixed(2)}, the farthest moved ${moved.farthest.toFixed(2)} mm (points on the open border or on creases stay)` })) {
      get().flashResult({ points: moved.points })
    }
  },
  unweldSelection: () => {
    const s = get()
    const edges = [...new Set([...s.selection.edges, ...regionBorder(s.cage, s.selection.faces)])]
    if (edges.length === 0) { set({ notice: 'Select edges (a chain, or a loop) or faces to unweld' }); return }
    const r = unweldEdges(s.cage, edges)
    if (r === null) { set({ notice: 'Nothing to open there: edges open along a chain of two or more, or where they reach the form\'s open border' }); return }
    const pieces = s.selection.faces.length > 0 && s.selection.edges.length === 0 ? `the ${s.selection.faces.length} selected face${s.selection.faces.length === 1 ? '' : 's'} cut free` : `${r.opened.length / 2} edge${r.opened.length === 2 ? '' : 's'} opened`
    if (get().applyCage(r.cage, { topology: true, record: true, notice: `Unwelded: ${pieces} (${r.split} point${r.split === 1 ? '' : 's'} doubled)` })) {
      set({ selection: { points: [], edges: r.opened, faces: [] } })
      get().flashResult({ edges: r.opened })
    }
  },
  weldDistance: 1,
  setWeldDistance: (mm) => set({ weldDistance: Math.max(0, mm) }),
  profileHeight: 20,
  setProfileHeight: (mm) => set({ profileHeight: Number.isFinite(mm) && mm !== 0 ? mm : 20 }),
  faceTool: null,
  startFaceTool: ({ replace, plane, planeWords, chain }) => set({
    faceTool: { replace, plane: plane ?? { origin: [0, 0, 0], normal: [0, 0, 1] }, planeWords: planeWords ?? 'the XY plane at Z = 0', clicks: [], chain: chain === true, carried: 0, added: 0 },
    selection: EMPTY_SELECTION,
    notice: `Face: click 4 corners on ${planeWords ?? 'the XY plane at Z = 0'}, or on the form's points to share them${replace ? ' (the first face starts a new form)' : ''}${chain === true ? '; chained: each next face starts on the last one\'s edge' : ''}; Alt+click a face of the form to work on its plane; Enter makes a triangle of 3, Esc stops`,
  }),
  toggleFaceChain: () => {
    const t = get().faceTool
    if (t === null) { get().startFaceTool({ replace: false, chain: true }); return }
    set({ faceTool: { ...t, chain: !t.chain }, notice: t.chain ? 'Face: chain off, each face takes 4 corners' : 'Face: chained, each next face starts on the last one\'s edge (2 corners a face)' })
  },
  setFacePlaneFromFace: (face) => {
    const s = get(), t = s.faceTool, f = s.cage.faces[face]
    if (t === null || f === undefined) return
    const P = f.map((i) => s.cage.positions[i])
    const origin = [0, 1, 2].map((c) => P.reduce((a, p) => a + p[c], 0) / P.length) as Vec3
    const n: Vec3 = [0, 0, 0]
    P.forEach((a, i) => { const b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]) })
    const l = Math.hypot(n[0], n[1], n[2])
    if (!(l > 1e-12)) return
    const planeWords = `the plane of face ${face + 1}`
    set({ faceTool: { ...t, plane: { origin, normal: [n[0] / l, n[1] / l, n[2] / l] }, planeWords }, notice: `Face: the work plane is now ${planeWords} (${faceCount(t)} so far)` })
  },
  addFaceClick: (click) => {
    const t = get().faceTool
    if (t === null) return
    const clicks = [...t.clicks, click]
    if (clicks.length < 4) {
      const how = t.carried > 0 ? 'chained on the last face\'s edge; Enter makes a triangle, Esc stops' : 'Enter makes a triangle of 3, Esc stops'
      set({ faceTool: { ...t, clicks }, notice: `Face: ${faceCount(t, clicks.length)} (${how})` })
      return
    }
    commitFace(get, set, clicks)
  },
  finishFaceDraft: () => {
    const t = get().faceTool
    if (t === null) return
    if (t.clicks.length < 3) { set({ notice: `Face: ${faceCount(t)}; a face needs at least ${t.carried > 0 ? `${3 - t.clicks.length} more` : '3'}` }); return }
    commitFace(get, set, t.clicks)
  },
  stopFaceTool: () => {
    const t = get().faceTool
    if (t === null) return
    // the result stays in the status line: what this run of the tool made
    set({ faceTool: null, notice: t.added === 0 ? 'Face tool off' : `Face tool off - ${t.added} face${t.added === 1 ? '' : 's'} added` })
  },
  pipeRadius: 0,
  setPipeRadius: (mm) => set({ pipeRadius: Number.isFinite(mm) && mm > 0 ? mm : 0 }),
  revolveAngle: 360,
  setRevolveAngle: (deg) => set({ revolveAngle: Number.isFinite(deg) ? Math.min(360, Math.max(1, deg)) : 360 }),
  revolveSegments: 16,
  setRevolveSegments: (n) => set({ revolveSegments: Number.isFinite(n) ? Math.min(64, Math.max(3, Math.round(n))) : 16 }),
  weldCloseSelection: () => {
    const s = get()
    const candidates = selectionPoints(s.cage, s.selection)
    const r = weldByDistance(s.cage, candidates, s.weldDistance)
    const where = candidates.length > 0 ? 'among the selected points' : 'in the form'
    if (r === null) { set({ notice: `No two points ${where} are within ${s.weldDistance} mm; raise Weld distance to join them` }); return }
    const n = s.cage.positions.length - r.cage.positions.length
    if (get().applyCage(r.cage, { topology: true, record: true, notice: `Welded ${r.groups} group${r.groups === 1 ? '' : 's'} of close points ${where} (${n} point${n === 1 ? '' : 's'} fewer)` })) {
      set({ selection: { points: r.points.filter((p) => p >= 0), edges: [], faces: [] } })
      get().flashResult({ points: r.points.filter((p) => p >= 0) })
    }
  },
  setSymmetry: (mode) => {
    if (mode === null) {
      set({ symmetry: null, symmetryAt: 0, symmetryNormal: null, notice: 'Symmetry off' })
      return
    }
    const { min, max } = cageBounds(get().cage)
    set(symmetryOn(get().cage, mode, mode === 'z' ? (min[2] + max[2]) / 2 : 0, null))
  },
  setSymmetryAt: (mm) => {
    const s = get()
    if (!Number.isFinite(mm)) return
    if (s.symmetry === null || circularCount(s.symmetry) !== null) { set({ notice: 'Turn on a mirror (X, Y, Z or Mirror from selection) to place its plane' }); return }
    set(symmetryOn(s.cage, s.symmetry, mm, s.symmetryNormal))
  },
  mirrorDuplicateForm: () => {
    const s = get()
    const mirror = s.symmetry !== null && circularCount(s.symmetry) === null
    const mode = mirror ? s.symmetry! : 'x'
    const normal = mirrorNormal(mode, s.symmetryNormal) ?? [1, 0, 0]
    const at = mirror ? s.symmetryAt : 0
    const r = mirrorDuplicate(s.cage, normal, at)
    const where = mirror ? 'the mirror plane' : 'the YZ plane (X = 0; no mirror was on)'
    const parts = [
      `${r.seam} seam point${r.seam === 1 ? '' : 's'} shared`,
      ...(r.dropped > 0 ? [`${r.dropped} face${r.dropped === 1 ? '' : 's'} on the plane joined away`] : []),
      ...(r.across > 0 ? [`${r.across} point${r.across === 1 ? ' lies' : 's lie'} across the plane, so the copy overlaps there`] : []),
    ]
    if (!get().applyCage(r.cage, { topology: true, record: true, notice: `Mirrored a copy across ${where}: ${parts.join('; ')}` })) {
      if (r.across > 0) {
        const plane = planeWords(mode, at, mode === 'p' ? normal : null).replace(/^Mirror .* at /, '').replace(/^Mirror plane /, '')
        set({ notice: `Duplicate mirrors half a form: this form already reaches across ${plane}, so the copy would overlap it. Delete the faces on one side first, or move the mirror plane.` })
      }
      return
    }
    const notice = get().notice
    set({ ...symmetryOn(r.cage, mode, at, mode === 'p' ? normal : null), notice, selection: EMPTY_SELECTION })
  },
  mirrorFromSelection: () => {
    const s = get()
    const ids = s.selection.points.length === 2 && s.selection.edges.length === 0 && s.selection.faces.length === 0 ? s.selection.points : selectionPoints(s.cage, s.selection)
    const plane = mirrorPlaneFrom(ids.map((p) => s.cage.positions[p]))
    if (plane === null) {
      set({ notice: ids.length < 2 ? 'Select two points to mirror onto each other, or three or more on the plane you want' : 'Those points do not fix a plane (they are on one line or in one place): add a point off the line' })
      return
    }
    set(symmetryOn(s.cage, plane.mode, plane.at, plane.mode === 'p' ? plane.normal : null, plane.deviation > 1e-6 ? ` (a best fit: the farthest point is ${plane.deviation.toFixed(2)} mm off it)` : ''))
  },
}))

// All selection writers (click, box, grow/shrink, loops), cage replacements (tools,
// starters, Undo/Redo), Face, and session/mode exits invalidate a picked line.
// Live moveBy updates keep it fixed, including the typed turn's beginMove/endDrag.
useFormStore.subscribe((s, prev) => {
  if (s.rotationAxis === null && s.rotationPick === null) return
  if (!s.active || s.transformMode !== 'rotate' || s.faceTool !== null || s.selection !== prev.selection
    || s.topologyVersion !== prev.topologyVersion || (s.cage !== prev.cage && !s.dragging)) {
    useFormStore.setState({ rotationAxis: null, rotationPick: null, notice: hasRotationInstruction(s) ? null : s.notice })
  }
})

// The flash shows the form as the tool left it: any other change to the session ends it at once - the form, the
// selection, a drag, the status line (a tool that found nothing to do), choosing Move / Rotate / Scale, the
// display, the mirror, the Face tool or any tool setting (a tool sets its flash after its own changes). Every
// writer of this store is an operator action; hover and the gizmo's live pose live outside it.
useFormStore.subscribe((s, prev) => {
  if (s.resultFlash === null || s.resultFlash !== prev.resultFlash) return
  for (const key of Object.keys(s) as (keyof FormState)[]) {
    if (key !== 'resultFlash' && s[key] !== prev[key] && typeof s[key] !== 'function') { s.clearResultFlash(); return }
  }
})
