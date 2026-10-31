// WO-1849 / ADR-0051 s3: push or pull a flat face of an STL along its own
// normal, and let the faces beside it stretch to meet it.
//
// The commonest fix in a shop: a pocket floor a bit deep, a boss a bit tall, a
// part a bit thick. Next does it (`offsetMeshPlanarRegion`) without a boolean
// and so does this: the picked face's vertices MOVE, every facet keeps its
// index, and the faces around the rim follow because they already own those
// vertices. No kernel, no re-tessellation, no new triangle.
//
// WHICH OF NEXT'S THREE MODES IS PORTED, said plainly because the work order
// asks for it. All three, as ONE mechanism with no mode to pick:
//   - `normal`   - the walls around the face run parallel to the move, so
//                  every vertex just translates. This is what a square pocket
//                  or a plain step does, and the formula below reduces to
//                  exactly that translation when it holds.
//   - `reconstruct` - a rim vertex where TWO faces meet the picked one (a
//                  corner) is re-solved as the point where those two planes
//                  and the MOVED plane meet. A drafted wall's corner slides
//                  along the draft instead of tearing off it.
//   - `interpolate` - a rim vertex with only ONE face beside it (a vertex part
//                  way along a tessellated wall) is slid along the line where
//                  that wall meets the moved plane. Next interpolates it
//                  between its loop's reconstructed corners to keep its bigint
//                  arithmetic exact; the corners and every vertex between them
//                  lie on that one line either way, so this takes the shortest
//                  slide onto it, which needs no boundary loop and gives the
//                  same straight rim.
// Written as one rule: a rim vertex slides along the direction that keeps it
// on EVERY face it already touches while the picked plane moves 1 mm. A proved
// chamfer is different: it belongs to the moved edge, so its whole band rides
// with the picked face at its existing size and the wall beyond it stretches.
// When neither construction exists - an unproved curved rim, or faces running
// along the picked face instead of away from it - the software genuinely
// cannot work out where the rim goes, and it says so in one sentence and
// changes nothing (LIENCAM.md rule 11).
//
// HOW FAR IT GOES. A distance that would drive the face through another face
// does NOT refuse the move (architect ruling, WO-1849 audit item 3). Two
// limits are measured, both from the part itself:
//   - it FOLDS. Every vertex moves affinely in the distance, so every facet's
//     normal is a QUADRATIC in it: the distance at which a facet beside the
//     face closes up is a root of that quadratic, computed, not searched.
//   - it ARRIVES. The face runs into one that is not its neighbour at all -
//     the pocket floor reaching the bottom of the block. Each moving corner is
//     cast along its own slide to find where (`pierceLimit`).
// The move stops a hundredth of a millimetre short of the nearer of the two,
// so the part is still a solid, and `flatFaceMoveOutcome` hands the panel a
// sentence with the number in it: "moved 3.20 mm, not the 5.00 mm asked for:
// it reaches the face in front of it at 3.21 mm". Nothing is refused that the
// software can do, and nothing asks the operator to re-model his file.
//
// LAYERING. This reaches sideways to `../../recognition/topology` for the weld
// and the facet adjacency, exactly as `boundaryCap.ts` and
// `sharpEdgeRestoration.ts` already document: the recognition DOOR answers
// "what does this part prove?", and an edit applying a selection the operator
// already made is not asking that question. It does NOT import
// `recognition/flatFaces`, whose own door pulls in the whole recognition index
// through `toolpathTargets`; the face's plane is measured here from the picked
// facets instead, which is the only truth this edit may stand on anyway.

import { analyzeAndMeasure } from '../../analysis';
import type { MeshBuffers, Vec3 } from '../../types';
import { recognizeEdgeBlends } from '../../recognition/edgeBlends';
import { recognizeMeshFeatures } from '../../recognition/recognize';
import { faceRegions } from '../../recognition/tangentRim';
import { facetNormal, facetPoints, normalsWithin, vertexAt, weldMesh, type WeldedMesh } from '../../recognition/topology';
import { cross, dot, length, normalize, sub } from '../../recognition/types';
import { facetCount, vertexCount } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type {
  MeshEditAncestry,
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
} from '../types';
import { facetSoup } from './boundaryCap';
import { moveBesideSphericalBoss } from './sphericalRimOffset';

export const MOVE_FLAT_FACE_KIND = 'move-flat-face';
export const MOVE_FLAT_FACE_VERSION = 1;

export interface MoveFlatFaceParameters {
  /** how far along the face's own outward normal it moves, mm. Positive adds
   *  material (pull), negative takes it away (push). */
  distanceMm: number;
  /** how far it ACTUALLY went, when the face met the one beside it before it
   *  got there. Recorded by the panel for its own line, never used to cut -
   *  replay re-measures the limit from the mesh and reaches the same number. */
  reachedMm?: number;
}

const PARAMETER_KEYS = new Set(['distanceMm', 'reachedMm']);

/** How far a picked facet may sit off the face's plane and still belong to it,
 *  mm. The flatness budget `recognizeFlatFaces` grows a face with
 *  (`DEFAULT_FLAT_FACE_OPTIONS.planarityMm`), stated here rather than imported
 *  so this file never reaches through the recognition door. */
const FACE_FLATNESS_MM = 0.05;

/** Region growing's own budget: the tangent of the angle two facets of one
 *  face may differ by (`DEFAULT_FLAT_FACE_OPTIONS.flatnessSlope`). */
const FACE_SLOPE = 0.01;

/** A facet with less area than this has closed up and is gone, mm^2. */
const DEGENERATE_AREA_MM2 = 1e-9;

/** A facet may not flip: its new normal must still point the old way within
 *  this tangent. The same 1e-3 the shared rebuild in sharpEdgeRestoration.ts
 *  uses for the same question. */
const WINDING_SLOPE = 1e-3;

/** A vertex's slide direction has to zero every plane it sits on; this is how
 *  close to zero counts, against unit normals. */
const PLANE_SLOPE = 1e-6;

/** How far short of the face it meets the move stops, mm. See `moveDetailed`:
 *  a hundredth of a millimetre leaves the part a solid instead of a shape with
 *  a zero-area wall in it, and leaves the operator a round number. */
const STOP_SHORT_MM = 0.01;

/** Where a face is, as a plane equation: `dot(normal, x) === offset`. */
interface FacePlane {
  normal: Vec3;
  offset: number;
}

/** Everything the move is worked out from, measured once. */
interface PreparedFaceMove {
  welded: WeldedMesh;
  selected: Set<number>;
  plane: FacePlane;
  /** the picked face's own area, mm^2 - the number the volume change divides by */
  areaMm2: number;
  /** welded vertex id -> how far it travels for each mm the face moves */
  slide: Map<number, Vec3>;
  /** proved chamfer facets carried rigidly with the picked face */
  carried: Set<number>;
  /** every facet that uses at least one of those vertices */
  touched: number[];
  /** how far a facet may end up off its own plane, mm. Float32 storage rounds
   *  every coordinate, so this is measured in the part's own size rather than
   *  as an absolute nanometre. */
  toleranceMm: number;
}

/** How far the face can go each way before something beside it closes up. */
interface FaceMoveLimits {
  /** largest positive distance, +Infinity when nothing stops it */
  out: number;
  /** most negative distance, -Infinity when nothing stops it */
  in: number;
  /** was the limiting facet part of the picked face itself? */
  outIsOwnFace: boolean;
  inIsOwnFace: boolean;
}

export interface FlatFaceMoveOutcome {
  /** what the operator asked for, mm */
  requestedMm: number;
  /** what the face actually does, mm */
  appliedMm: number;
  /** the plain sentence to say when those two differ; null when they do not */
  note: string | null;
  /** the plain sentence naming what the software cannot do, when there is no
   *  move at all. Nothing is changed in that case. */
  refusal: string | null;
}

// ------------------------------------------------------------------ measuring

function planeOf(w: WeldedMesh, facet: number): FacePlane {
  const normal = facetNormal(w, facet);
  return { normal, offset: dot(normal, facetPoints(w, facet)[0]) };
}

/** The picked face's own plane: area-weighted, so a face tessellated into
 *  slivers is not out-voted by them. */
function pickedFacePlane(w: WeldedMesh, facets: readonly number[]): { plane: FacePlane; areaMm2: number } {
  let areaMm2 = 0;
  const n: Vec3 = [0, 0, 0];
  const c: Vec3 = [0, 0, 0];
  for (const f of facets) {
    const area = w.areas[f];
    areaMm2 += area;
    const fn = facetNormal(w, f);
    const [p0, p1, p2] = facetPoints(w, f);
    for (let i = 0; i < 3; i++) {
      n[i] += fn[i] * area;
      c[i] += ((p0[i] + p1[i] + p2[i]) / 3) * area;
    }
  }
  const scale = areaMm2 === 0 ? 0 : 1 / areaMm2;
  const normal = normalize(n);
  const centroid: Vec3 = [c[0] * scale, c[1] * scale, c[2] * scale];
  return { plane: { normal, offset: dot(normal, centroid) }, areaMm2 };
}

/** Float32 positions round; "still on its own plane" has to be read in those
 *  units or a part 100 mm across fails a check it passed at 1 mm. */
function toleranceFor(w: WeldedMesh): number {
  let worst = 1;
  for (let i = 0; i < w.positions.length; i++) worst = Math.max(worst, Math.abs(w.positions[i]));
  return worst * 1e-5;
}

// --------------------------------------------------------- the slide of a rim

/**
 * The direction one vertex travels for each mm the picked face moves.
 *
 * It has to stay on every face it already touches (`dot(planeNormal, d) === 0`
 * for each) while the picked plane moves by 1 (`dot(faceNormal, d) === 1`).
 * With no faces beside it that is the face normal itself - the translation
 * Next calls `normal` mode. With one it is the slide along that wall; with two
 * it is the corner where both walls and the moved plane meet.
 *
 * WO-2119: a vertex on a CURVED wall that runs along the move - a round
 * pocket's side, a hole's bore - touches several chords of that wall, and an
 * STL rarely lines their top and bottom stations up, so no one direction
 * holds every chord exactly. The wall itself is swept along the move, so the
 * vertex rides the sweep (the face normal) and the chords stretch; `proveFacet`
 * holds each of them to that same sweep.
 *
 * Throws a plain sentence when no such direction exists; `cornerSlide` adds
 * where that corner is.
 */
function slideDirection(face: FacePlane, planes: readonly FacePlane[]): Vec3 {
  if (planes.length === 0) return face.normal;
  if (planes.length === 1) {
    const c = dot(face.normal, planes[0].normal);
    const span = 1 - c * c;
    if (span <= 1e-12) {
      throw new Error(
        'The face beside this one lies in the same plane as the face being moved, so LienCAM ' +
          'cannot work out where their shared corner would go. Nothing was changed.',
      );
    }
    const p = planes[0].normal;
    return [
      (face.normal[0] - c * p[0]) / span,
      (face.normal[1] - c * p[1]) / span,
      (face.normal[2] - c * p[2]) / span,
    ];
  }

  // Two or more: solve with the pair that meets the moved plane most squarely,
  // then hold every remaining plane to the same answer.
  let best: { a: FacePlane; b: FacePlane; det: number } | null = null;
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const det = dot(cross(planes[i].normal, planes[j].normal), face.normal);
      if (best === null || Math.abs(det) > Math.abs(best.det)) {
        best = { a: planes[i], b: planes[j], det };
      }
    }
  }
  const pair = best as { a: FacePlane; b: FacePlane; det: number };
  const sweptWall = planes.every((plane) => runsAlongMove(plane.normal, face.normal));
  if (Math.abs(pair.det) <= PLANE_SLOPE) {
    if (sweptWall) return face.normal;
    throw new Error(
      'The faces that meet this one at its rim run along it rather than away from it, so LienCAM ' +
        'cannot work out where that corner would go. Nothing was changed.',
    );
  }
  // Cramer against [a.normal; b.normal; face.normal] x = (0, 0, 1): the only
  // column that survives is the cross product of the two wall normals.
  const line = cross(pair.a.normal, pair.b.normal);
  const direction: Vec3 = [line[0] / pair.det, line[1] / pair.det, line[2] / pair.det];
  const scale = Math.max(1, length(direction));
  for (const plane of planes) {
    if (Math.abs(dot(plane.normal, direction)) > PLANE_SLOPE * scale) {
      if (sweptWall) return face.normal;
      throw new Error(
        `This face meets ${planes.length} faces at one of its corners and they do not stay met when ` +
          'it moves - a curved rim reads this way. LienCAM cannot work out where that corner would ' +
          'go. Nothing was changed.',
      );
    }
  }
  return direction;
}

/** Does a face with this normal run along the move - a wall the move stretches
 *  rather than one it slides across? Within the slope region growing lets two
 *  facets of one face differ by, so a chord of a round wall counts. */
function runsAlongMove(normal: Vec3, move: Vec3): boolean {
  return Math.abs(dot(normal, move)) <= FACE_SLOPE;
}

/** A wall's normal seen along the move: its part across the move, unit. */
function acrossMove(normal: Vec3, move: Vec3): Vec3 {
  const along = dot(normal, move);
  return normalize([normal[0] - along * move[0], normal[1] - along * move[1], normal[2] - along * move[2]]);
}

/** `slideDirection` for the vertex at `at`, its sentence naming WHERE that
 *  corner is in the part's own coordinates (WO-2119; Operator: "showing or
 *  highlighting where things fail is always useful for a user"). */
function cornerSlide(face: FacePlane, planes: readonly FacePlane[], at: Vec3): Vec3 {
  try {
    return slideDirection(face, planes);
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    const where = `(at X ${at[0].toFixed(2)} Y ${at[1].toFixed(2)} Z ${at[2].toFixed(2)})`;
    throw new Error(said.replace(/ would go\. /, ` would go ${where}. `));
  }
}

/** Are these the same plane? Two facets sharing a vertex cannot be parallel
 *  and apart, so agreeing normals are enough. */
function samePlane(a: FacePlane, b: FacePlane): boolean {
  return normalsWithin(a.normal, b.normal, PLANE_SLOPE);
}

/** Do two facet regions meet along a real mesh edge (not merely at a point)? */
function regionsShareEdge(
  w: WeldedMesh,
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): boolean {
  for (const edge of w.edges) {
    if (edge.facets.length !== 2) continue;
    const [left, right] = edge.facets;
    if ((a.has(left) && b.has(right)) || (a.has(right) && b.has(left))) return true;
  }
  return false;
}

/**
 * Chamfers belong to an edge, not to either support face alone. When the
 * picked face moves, every proved chamfer band directly on its rim travels
 * with it at the same size; the support wall beyond the band stretches.
 *
 * Both recognisers return current facet indices when no source-id view is
 * supplied. Straight edge chamfers come from the edge-blend proof; circular
 * chamfers on holes come from its proved cone bands. Requiring a shared edge
 * with the picked face prevents a chamfer elsewhere on the part from moving.
 */
function carriedChamferFacets(
  mesh: MeshBuffers,
  w: WeldedMesh,
  selected: ReadonlySet<number>,
  face: FacePlane,
): Set<number> {
  const carried = new Set<number>();
  for (const blend of recognizeEdgeBlends(mesh).blends) {
    if (blend.kind !== 'chamfer') continue;
    // WO-3113: a vertical corner bevel beside a plate's top is a wall along
    // this move, not a top-edge band to carry. Carrying it also lifts its
    // bottom vertices, and its full-thickness slab can grow across the bottom
    // face until that face falsely meets a counterbore shoulder. Let these
    // facets stretch with the other swept walls; keep carrying rim chamfers
    // whose normals lean into the move (WO-2082 / WO-2119).
    if (blend.sourceFacetIds.every((facet) => runsAlongMove(facetNormal(w, facet), face.normal))) continue;
    const band = new Set(blend.sourceFacetIds);
    if (regionsShareEdge(w, selected, band)) for (const facet of band) carried.add(facet);
  }
  for (const feature of recognizeMeshFeatures(mesh).features) {
    for (const band of feature.bands) {
      if (band.surface !== 'cone') continue;
      const facets = new Set(band.sourceFacetIds);
      if (regionsShareEdge(w, selected, facets)) for (const facet of facets) carried.add(facet);
    }
  }
  // A chamfer turning a sharp corner can have junction triangles that are not
  // themselves a straight blend or a cone. Grow from the proved bands only
  // through facets inside those bands' measured depth from the picked plane.
  // A drafted wall extends beyond that shallow slab, while a corner cap does
  // not; a wall parallel to the move is also excluded by its zero projection.
  // WO-2119: an edge chamfer whose ends close on corner caps rather than on end
  // faces is not a blend the recogniser proves (Step Test With Holes' 0.5 mm
  // outer ring), and no proved band touches it. It still lies on the picked
  // face's rim inside that same slab, so the growth also starts from the
  // picked face - through LEANING facets only: a wall running along the move is
  // a shallow step, not a chamfer, and it stretches as before.
  if (carried.size > 0) {
    let low = Infinity;
    let high = -Infinity;
    for (const facet of carried) {
      for (const point of facetPoints(w, facet)) {
        const station = dot(face.normal, point) - face.offset;
        low = Math.min(low, station);
        high = Math.max(high, station);
      }
    }
    const slabTolerance = FACE_FLATNESS_MM;
    const across: number[][] = Array.from({ length: w.facetCount }, () => []);
    for (const edge of w.edges) {
      if (edge.facets.length !== 2) continue;
      across[edge.facets[0]].push(edge.facets[1]);
      across[edge.facets[1]].push(edge.facets[0]);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let facet = 0; facet < w.facetCount; facet++) {
        if (selected.has(facet) || carried.has(facet) || w.areas[facet] <= 0) continue;
        if (Math.abs(dot(facetNormal(w, facet), face.normal)) <= PLANE_SLOPE) continue;
        if (!facetPoints(w, facet).every((point) => {
          const station = dot(face.normal, point) - face.offset;
          return station >= low - slabTolerance && station <= high + slabTolerance;
        })) continue;
        const besideCarried = across[facet].some((other) => carried.has(other));
        const leansOffRim = !runsAlongMove(facetNormal(w, facet), face.normal) &&
          across[facet].some((other) => selected.has(other));
        if (!besideCarried && !leansOffRim) continue;
        carried.add(facet);
        changed = true;
      }
    }
  }
  return carried;
}

/**
 * WO-2798: blends belong to the edge they round, exactly as a chamfer does
 * (WO-2767 gave the STEP route the same rule). Every fillet the picked face
 * runs TANGENT into - the foot fillet round a boss, the r2 chain round a top,
 * the floor fillets of a pocket - rides with the face at its own radius, and
 * the wall beyond it stretches.
 *
 * The band is grown from the face's smooth rim across smoothly-joined facets.
 * It stops at a wall that runs along the move (that wall stretches: a bore, a
 * flank, a round corner standing along the move) and at any other real flat
 * face (one `tangentRim.ts` would offer). A tangent wall that is neither - a
 * drafted wall a fillet runs into - is left where it is, so the band's rigid
 * edge drags it off its plane and `proveFacet` says so in one sentence
 * instead of building a wrong shape.
 */
function carriedBlendFacets(w: WeldedMesh, selected: ReadonlySet<number>, face: FacePlane): Set<number> {
  const carried = new Set<number>();
  const faces = faceRegions(w);
  const seeds: number[] = [];
  for (const f of selected) for (const next of faces.smooth[f]) if (!selected.has(next)) seeds.push(next);
  if (seeds.length === 0) return carried;
  const eligible = (facet: number): boolean =>
    !selected.has(facet) && !carried.has(facet) && w.areas[facet] > 0 &&
    !runsAlongMove(facetNormal(w, facet), face.normal) && !faces.isFace(faces.regionOf[facet]);

  const queue = seeds.filter(eligible);
  for (const f of queue) carried.add(f);
  while (queue.length > 0) {
    const f = queue.pop() as number;
    for (const next of faces.smooth[f]) {
      if (!eligible(next)) continue;
      carried.add(next);
      queue.push(next);
    }
  }
  return carried;
}

// ------------------------------------------------------------------ preparing

function prepare(
  mesh: MeshBuffers,
  facets: readonly number[],
  options: { resolveNeighbours?: boolean } = {},
): PreparedFaceMove {
  const total = facetCount(mesh);
  if (!Array.isArray(facets) || facets.length === 0) {
    throw new Error('No face was picked, so there was nothing to move. Nothing was changed.');
  }
  for (const f of facets) {
    if (!Number.isInteger(f) || f < 0 || f >= total) {
      throw new Error(
        `The picked face names facet ${String(f)}, which this part does not have (${total} facets). ` +
          'Nothing was changed.',
      );
    }
  }
  const welded = weldMesh(mesh);
  const selected = new Set(facets);
  for (const f of selected) {
    if (welded.areas[f] <= 0) {
      throw new Error('One of the picked facets has no area, so LienCAM cannot tell which way this face points. Nothing was changed.');
    }
  }

  const { plane, areaMm2 } = pickedFacePlane(welded, [...selected]);
  const toleranceMm = toleranceFor(welded);
  let worstOff = 0;
  for (const f of selected) {
    if (!normalsWithin(plane.normal, facetNormal(welded, f), FACE_SLOPE)) {
      throw new Error(
        'The picked facets do not all face the same way, so they are not one flat face. Nothing was changed.',
      );
    }
    for (const p of facetPoints(welded, f)) worstOff = Math.max(worstOff, Math.abs(dot(plane.normal, p) - plane.offset));
  }
  if (worstOff > Math.max(FACE_FLATNESS_MM, toleranceMm)) {
    throw new Error(
      `The picked facets are not flat: the worst of them sits ${worstOff.toFixed(3)} mm off the ` +
        'plane of the rest, so LienCAM cannot move them as one face. Nothing was changed.',
    );
  }

  // Which vertices move, and which faces beside them hold them. A proved
  // chamfer directly on the rim rides with the face as one rigid band, and so
  // does a fillet the face runs tangent into (WO-2798).
  const carried = carriedChamferFacets(mesh, welded, selected, plane);
  for (const f of carriedBlendFacets(welded, selected, plane)) carried.add(f);
  const moving = new Set<number>();
  for (const f of selected) for (let c = 0; c < 3; c++) moving.add(welded.facets[f * 3 + c]);
  for (const f of carried) for (let c = 0; c < 3; c++) moving.add(welded.facets[f * 3 + c]);

  const beside = new Map<number, FacePlane[]>();
  const touched: number[] = [];
  for (let f = 0; f < welded.facetCount; f++) {
    const ids = [welded.facets[f * 3], welded.facets[f * 3 + 1], welded.facets[f * 3 + 2]];
    const mine = ids.filter((id) => moving.has(id));
    if (mine.length === 0) continue;
    touched.push(f);
    if (selected.has(f) || carried.has(f) || welded.areas[f] <= 0) continue;
    const own = planeOf(welded, f);
    for (const id of mine) {
      const list = beside.get(id) ?? [];
      if (!list.some((other) => samePlane(other, own))) list.push(own);
      beside.set(id, list);
    }
  }

  const slide = new Map<number, Vec3>();
  const carriedVertices = new Set<number>();
  for (const f of carried) for (let c = 0; c < 3; c++) carriedVertices.add(welded.facets[f * 3 + c]);
  for (const id of moving) {
    // The NEGATIVE CONTROL (WO-1849 acceptance): skip the re-solve and every
    // vertex just translates. On a part whose walls are drafted that drags
    // them off their own planes, which is what the side-planarity proof below
    // must fail on.
    slide.set(
      id,
      options.resolveNeighbours === false || carriedVertices.has(id)
        ? plane.normal
        : cornerSlide(plane, beside.get(id) ?? [], vertexAt(welded, id)),
    );
  }

  return { welded, selected, plane, areaMm2, slide, carried, touched, toleranceMm };
}

// -------------------------------------------------------------- how far it goes

/** The three corners of a facet as (position, slide) pairs. */
function facetMotion(prepared: PreparedFaceMove, facet: number): { at: Vec3[]; by: Vec3[] } {
  const w = prepared.welded;
  const at: Vec3[] = [];
  const by: Vec3[] = [];
  for (let c = 0; c < 3; c++) {
    const id = w.facets[facet * 3 + c];
    at.push(vertexAt(w, id));
    by.push(prepared.slide.get(id) ?? [0, 0, 0]);
  }
  return { at, by };
}

/**
 * How far the face can travel each way before a facet beside it (or one of its
 * own) closes up and would fold through itself.
 *
 * Every vertex moves affinely in the distance, so a facet's normal
 * `cross(B - A, C - A)` is a quadratic in it. Measured along the facet's
 * ORIGINAL normal, that quadratic is positive while the facet still faces the
 * way it did and zero exactly where it closes up, so the limit is a root - not
 * a search and not a guess.
 */
function foldLimits(prepared: PreparedFaceMove): FaceMoveLimits {
  const limits: FaceMoveLimits = { out: Infinity, in: -Infinity, outIsOwnFace: false, inIsOwnFace: false };
  for (const facet of prepared.touched) {
    const w = prepared.welded;
    if (w.areas[facet] <= 0) continue;
    const { at, by } = facetMotion(prepared, facet);
    const u0 = sub(at[1], at[0]);
    const v0 = sub(at[2], at[0]);
    const u1 = sub(by[1], by[0]);
    const v1 = sub(by[2], by[0]);
    const n0 = facetNormal(w, facet);
    const a = dot(cross(u1, v1), n0);
    const b = dot(cross(u0, v1), n0) + dot(cross(u1, v0), n0);
    const c = dot(cross(u0, v0), n0);
    for (const root of quadraticRoots(a, b, c)) {
      if (root > 0 && root < limits.out) {
        limits.out = root;
        limits.outIsOwnFace = prepared.selected.has(facet);
      }
      if (root < 0 && root > limits.in) {
        limits.in = root;
        limits.inIsOwnFace = prepared.selected.has(facet);
      }
    }
  }
  return limits;
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  if (Math.abs(a) <= scale * 1e-12) {
    return Math.abs(b) <= scale * 1e-12 ? [] : [-c / b];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  // the numerically stable pair, so a tiny `a` does not eat the near root
  const q = -0.5 * (b + Math.sign(b || 1) * root);
  return [q / a, c / q].filter((value) => Number.isFinite(value));
}

/**
 * How far the face travels before it runs INTO the part instead of alongside
 * it - the pocket floor that reaches the bottom of the block, the boss that
 * reaches the face above it. Nothing folds in that case, because the face it
 * meets is not one of its neighbours; the face simply arrives.
 *
 * Each moving corner is cast along its own slide against every facet the move
 * does not touch, inside the box the move actually sweeps. The answer is the
 * nearest hit, in mm of face travel.
 *
 * THE STATED LIMIT (WO-1854 says its own the same way rather than hiding it):
 * this asks where the face's CORNERS go. A face swept past something narrower
 * than the gap between its own corners - a thin rib standing in the middle of
 * an otherwise clear pocket - is not caught here, and the part it produces is
 * closed and outward but has that rib inside it. Catching that needs a swept
 * solid, which is WO-1852's country, not this edit's.
 */
function pierceLimit(prepared: PreparedFaceMove, sign: number, reachMm: number): number {
  const w = prepared.welded;
  const touched = new Set(prepared.touched);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const rays: Array<{ from: Vec3; along: Vec3 }> = [];
  for (const [id, slide] of prepared.slide) {
    const from = vertexAt(w, id);
    const along: Vec3 = [slide[0] * sign, slide[1] * sign, slide[2] * sign];
    rays.push({ from, along });
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], from[i], from[i] + along[i] * reachMm);
      hi[i] = Math.max(hi[i], from[i], from[i] + along[i] * reachMm);
    }
  }
  if (rays.length === 0) return Infinity;

  let limit = Infinity;
  for (let f = 0; f < w.facetCount; f++) {
    if (touched.has(f) || w.areas[f] <= 0) continue;
    const corners = facetPoints(w, f);
    let outside = false;
    for (let i = 0; i < 3 && !outside; i++) {
      const least = Math.min(corners[0][i], corners[1][i], corners[2][i]);
      const most = Math.max(corners[0][i], corners[1][i], corners[2][i]);
      outside = least > hi[i] || most < lo[i];
    }
    if (outside) continue;
    for (const ray of rays) {
      const hit = rayHitsTriangle(ray.from, ray.along, corners);
      if (hit !== null && hit > 1e-9 && hit < limit) limit = hit;
    }
  }
  return limit;
}

/** Moller-Trumbore, both ways round: the distance along `along` at which the
 *  ray from `from` crosses this triangle, or null when it misses. */
function rayHitsTriangle(from: Vec3, along: Vec3, corners: readonly Vec3[]): number | null {
  const edge1 = sub(corners[1], corners[0]);
  const edge2 = sub(corners[2], corners[0]);
  const h = cross(along, edge2);
  const a = dot(edge1, h);
  if (Math.abs(a) < 1e-12) return null;
  const f = 1 / a;
  const s = sub(from, corners[0]);
  const u = f * dot(s, h);
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(s, edge1);
  const v = f * dot(along, q);
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return f * dot(edge2, q);
}

// ---------------------------------------------------------------- the edit

/** A computed limit can lie just past a hundredth because STL coordinates
 *  are Float32. Check the geometry that will actually be stored, so rounding
 *  a legal double-precision gap cannot close or invert a wall in the result. */
function foldsWhenStored(prepared: PreparedFaceMove, distanceMm: number): boolean {
  for (const facet of prepared.touched) {
    // Facets already below the rebuild's area floor are not caused by this move.
    if (prepared.welded.areas[facet] <= DEGENERATE_AREA_MM2) continue;
    const { at, by } = facetMotion(prepared, facet);
    const corners = at.map((point, corner) => point.map((value, axis) =>
      Math.fround(value + by[corner][axis] * distanceMm)) as Vec3);
    const raw = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    if (length(raw) / 2 <= DEGENERATE_AREA_MM2 || dot(raw, facetNormal(prepared.welded, facet)) <= 0) return true;
  }
  return false;
}

interface DetailedMove extends FlatFaceMoveOutcome {
  result: MeshEditApplyResult;
}

function moveDetailed(
  mesh: MeshBuffers,
  facets: readonly number[],
  distanceMm: number,
  options: { resolveNeighbours?: boolean } = {},
): DetailedMove {
  if (typeof distanceMm !== 'number' || !Number.isFinite(distanceMm) || Math.abs(distanceMm) > 1e6) {
    throw new Error(`"${String(distanceMm)}" is not a distance LienCAM can move a face by. Nothing was changed.`);
  }
  // WO-2802: a spherical rim has a changing intersection with this plane.
  // It must be clipped and re-closed, never solved as several fixed chord planes.
  const curved = options.resolveNeighbours === false ? null
    : moveBesideSphericalBoss(mesh, facets, distanceMm, (m, fs, d) => moveDetailed(m, fs, d));
  if (curved) return { ...curved, requestedMm: distanceMm, refusal: null };
  const prepared = prepare(mesh, facets, options);
  const sign = distanceMm >= 0 ? 1 : -1;
  const folds = foldLimits(prepared);
  const fold = sign > 0 ? folds.out : -folds.in;
  const pierce = distanceMm === 0 ? Infinity : pierceLimit(prepared, sign, Math.abs(distanceMm));
  const limitMm = Math.min(fold, pierce);
  const meets = fold <= pierce
    ? (sign > 0 ? folds.outIsOwnFace : folds.inIsOwnFace)
      ? 'the face closes up on itself'
      : 'the face beside it closes up'
    : 'it reaches the face in front of it';

  let appliedMm = distanceMm;
  let note: string | null = null;
  // `>=`, not `>`: AT the limit the move is already the broken one. A request
  // of exactly the room measured - 8.00 mm into an 8.00 mm plate, the plate
  // thickness read straight off a drawing - is the likeliest number an
  // operator types, and it has to stop short like every larger one.
  if (Math.abs(distanceMm) >= limitMm || (Number.isFinite(limitMm) && foldsWhenStored(prepared, distanceMm))) {
    // As far as it ACTUALLY goes, and said with the number (WO-1849 audit item
    // 3). It stops a hundredth of a millimetre short of the meeting, because
    // AT the meeting the facets there have no area left and the part is no
    // longer a solid - and because a number an operator reads is a number he
    // can type back in.
    let room = Math.floor((limitMm - 1e-9) / STOP_SHORT_MM) * STOP_SHORT_MM;
    // WO-3113: the real plate's 2.200000047 mm double-precision limit rounds
    // a 2.20 mm move onto its shoulder in Float32, leaving degenerate walls.
    // Step back only while the stored geometry actually folds; do not widen
    // a tolerance or remove the analytical fold/pierce constraints.
    while (room > 0 && foldsWhenStored(prepared, sign * room)) {
      room = Number((room - STOP_SHORT_MM).toFixed(2));
    }
    if (!(room > 0)) {
      throw new Error(
        `There is no room to move this face: ${meets} ${limitMm.toFixed(3)} mm away, which is less ` +
          'than the hundredth of a millimetre LienCAM would leave it. Nothing was changed.',
      );
    }
    appliedMm = sign * Number(room.toFixed(2));
    note =
      `LienCAM moved this face ${Math.abs(appliedMm).toFixed(2)} mm, not the ` +
      `${Math.abs(distanceMm).toFixed(2)} mm asked for: ${meets} at ${limitMm.toFixed(2)} mm.`;
  }

  const result = rebuild(mesh, prepared, appliedMm);
  return { result, requestedMm: distanceMm, appliedMm, note, refusal: null };
}

/** Move the vertices, keep every facet that still has area, and PROVE the
 *  result before handing it back. */
function rebuild(mesh: MeshBuffers, prepared: PreparedFaceMove, distanceMm: number): MeshEditApplyResult {
  const w = prepared.welded;
  const total = facetCount(mesh);
  const moved = (id: number): Vec3 => {
    const p = vertexAt(w, id);
    const d = prepared.slide.get(id);
    return d ? [p[0] + d[0] * distanceMm, p[1] + d[1] * distanceMm, p[2] + d[2] * distanceMm] : p;
  };

  const shifted: FacePlane = { normal: prepared.plane.normal, offset: prepared.plane.offset + distanceMm };
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  const owner: number[] = [];
  let dropped = 0;

  for (let f = 0; f < total; f++) {
    const ids: [number, number, number] = [w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]];
    const corners = ids.map(moved) as [Vec3, Vec3, Vec3];
    const raw = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    const area = length(raw) / 2;
    if (area <= DEGENERATE_AREA_MM2) {
      // A facet that arrived with no area goes quietly, as every rebuild in
      // this directory drops it. One the MOVE closed up is the limit above
      // being reached, and the part gets re-proved below because of it.
      if (w.areas[f] > 0) dropped++;
      continue;
    }
    if (prepared.slide.has(ids[0]) || prepared.slide.has(ids[1]) || prepared.slide.has(ids[2])) {
      proveFacet(prepared, f, corners, raw, area, shifted);
    }
    triangles.push(corners);
    owner.push(f);
  }

  const result = facetSoup(triangles);
  if (dropped > 0) proveStillSolid(mesh, result);
  return { mesh: result, ancestry: ancestryOf(mesh, owner) };
}

/** One facet, after the move: it kept its direction, and it is where it has to
 *  be - on the MOVED plane when it is part of the picked face, on its OWN
 *  plane when it is a face beside it stretching to meet it. */
function proveFacet(
  prepared: PreparedFaceMove,
  facet: number,
  corners: readonly Vec3[],
  raw: Vec3,
  area: number,
  shifted: FacePlane,
): void {
  const w = prepared.welded;
  const movedMm = shifted.offset - prepared.plane.offset;
  // WHERE it ended up first, HOW IT FACES second. A facet dragged off its own
  // plane has also turned, and "it is 1.41 mm off its own plane" names the
  // defect where "it turned" only names a symptom of it.
  const original = planeOf(w, facet);
  const plane = prepared.selected.has(facet)
    ? shifted
    : prepared.carried.has(facet)
      ? { normal: original.normal, offset: original.offset + dot(original.normal, prepared.plane.normal) * movedMm }
      : original;
  // WO-2119: a chord of a curved wall running along the move (see
  // `slideDirection`) is held to the SWEEP instead: seen along the move, each
  // corner stays exactly where it was, so the wall keeps its outline and only
  // gets taller or shorter. A corner the rim re-solve kept on the chord's own
  // plane passes either way.
  const before = facetNormal(w, facet);
  const swept = !prepared.selected.has(facet) && !prepared.carried.has(facet) &&
    runsAlongMove(before, prepared.plane.normal)
    ? acrossMove(before, prepared.plane.normal)
    : null;
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    const p = corners[c];
    let off = Math.abs(dot(plane.normal, p) - plane.offset);
    if (swept !== null) {
      const moved = sub(p, vertexAt(w, w.facets[facet * 3 + c]));
      const along = dot(moved, prepared.plane.normal);
      off = Math.min(off, length([
        moved[0] - along * prepared.plane.normal[0],
        moved[1] - along * prepared.plane.normal[1],
        moved[2] - along * prepared.plane.normal[2],
      ]));
    }
    worst = Math.max(worst, off);
  }
  if (worst > prepared.toleranceMm) {
    throw new Error(
      prepared.selected.has(facet)
        ? `Part of the picked face ended up ${worst.toFixed(4)} mm off the plane it was moved to, so ` +
          'LienCAM cannot prove it moved as one face. Nothing was changed.'
        : `Moving this face would tilt the face beside it ${worst.toFixed(4)} mm off its own plane, ` +
          'which would change a part of the shape the operator did not ask about. Nothing was changed.',
    );
  }
  const after: Vec3 = [raw[0] / (2 * area), raw[1] / (2 * area), raw[2] / (2 * area)];
  // A swept chord leans a little more or less as it stretches; what may not
  // change is which way it faces seen along the move.
  const turned = swept === null
    ? !normalsWithin(before, after, WINDING_SLOPE)
    : !normalsWithin(swept, acrossMove(after, prepared.plane.normal), WINDING_SLOPE);
  if (turned) {
    throw new Error(
      'Moving this face that far would turn a facet beside it inside out, so LienCAM cannot work ' +
        'out the shape that leaves. Nothing was changed.',
    );
  }
}

/** When the move closed facets up, the part has to still BE a part: as closed
 *  as it was, in as many pieces as it was, still inside out nowhere. Measured
 *  on the result against the input, never assumed - and never held against a
 *  part that arrived open, which is the operator's file, not our doing. */
function proveStillSolid(before: MeshBuffers, after: MeshBuffers): void {
  const options = { checkSelfIntersections: false };
  const was = analyzeAndMeasure(before, options);
  const now = analyzeAndMeasure(after, options);
  const worse =
    (was.report.watertight && !now.report.watertight) ||
    now.measures.componentCount > was.measures.componentCount ||
    (was.measures.signedVolume > 0 && now.measures.signedVolume <= 0);
  if (worse) {
    throw new Error(
      'Moving this face that far would cut the part into a shape LienCAM cannot close up again. ' +
        'Nothing was changed.',
    );
  }
}

/** Who became what (WO-1845's `MeshEditAncestry`). No facet splits and none is
 *  added here, so every surviving facet maps to exactly one output facet and a
 *  facet that closed up maps to nothing. */
function ancestryOf(source: MeshBuffers, owner: readonly number[]): MeshEditAncestry {
  const triangles: number[][] = Array.from({ length: facetCount(source) }, () => []);
  const vertices: number[][] = Array.from({ length: vertexCount(source) }, () => []);
  for (let out = 0; out < owner.length; out++) {
    triangles[owner[out]].push(out);
    for (let c = 0; c < 3; c++) {
      const vertex = source.indices[owner[out] * 3 + c];
      if (vertex !== undefined) vertices[vertex].push(out * 3 + c);
    }
  }
  return { triangles, vertices };
}

// ------------------------------------------------------------------ the doors

/**
 * Move the picked face `distanceMm` along its own outward normal: positive
 * adds material, negative takes it away.
 *
 * Throws a plain sentence naming what LienCAM could not work out; nothing has
 * been changed when it does, so replay stops at this edit and keeps every
 * earlier one (replay.ts).
 *
 * `resolveNeighbours: false` is the NEGATIVE CONTROL: every vertex translates
 * and no rim corner is re-solved, which on a part with a drafted wall drags
 * that wall off its own plane and fails the side-planarity proof.
 */
export function moveFlatFace(
  mesh: MeshBuffers,
  facets: readonly number[],
  distanceMm: number,
  options: { resolveNeighbours?: boolean } = {},
): MeshEditApplyResult {
  return moveDetailed(mesh, facets, distanceMm, options).result;
}

/**
 * What this move would do, asked BEFORE anything is recorded: how far the face
 * actually goes, the sentence to say when that is not what was asked for, and
 * the sentence naming what the software cannot do when there is no move at all.
 */
export function flatFaceMoveOutcome(
  mesh: MeshBuffers,
  facets: readonly number[],
  distanceMm: number,
): FlatFaceMoveOutcome {
  try {
    const { requestedMm, appliedMm, note } = moveDetailed(mesh, facets, distanceMm);
    return { requestedMm, appliedMm, note, refusal: null };
  } catch (err) {
    return {
      requestedMm: distanceMm,
      appliedMm: 0,
      note: null,
      refusal: err instanceof Error ? err.message : String(err),
    };
  }
}

export const moveFlatFaceOperation: MeshEditOperation<MoveFlatFaceParameters> = {
  kind: MOVE_FLAT_FACE_KIND,
  version: MOVE_FLAT_FACE_VERSION,
  label: 'Move flat face',

  describe(record: MeshEditRecord): string {
    const parameters = (record.parameters ?? {}) as Partial<MoveFlatFaceParameters>;
    const asked = typeof parameters.distanceMm === 'number' ? parameters.distanceMm : 0;
    const reached = typeof parameters.reachedMm === 'number' ? parameters.reachedMm : asked;
    const words = reached >= 0 ? 'out' : 'in';
    const verb = reached >= 0 ? 'Pulled' : 'Pushed';
    const line = `${verb} a flat face ${words} ${Math.abs(reached).toFixed(2)} mm`;
    return Math.abs(reached - asked) > 1e-9
      ? `${line} (${Math.abs(asked).toFixed(2)} mm asked for; it reaches the face beside it there)`
      : line;
  },

  validate(parameters: Record<string, unknown>): MoveFlatFaceParameters {
    const given = parameters ?? {};
    const extra = Object.keys(given).filter((key) => !PARAMETER_KEYS.has(key));
    if (extra.length > 0) {
      throw new Error(`"${MOVE_FLAT_FACE_KIND}" does not take ${extra.join(', ')}.`);
    }
    const distanceMm = given.distanceMm;
    if (typeof distanceMm !== 'number' || !Number.isFinite(distanceMm) || Math.abs(distanceMm) > 1e6) {
      throw new Error(
        `"${MOVE_FLAT_FACE_KIND}" was given a distance of "${String(distanceMm)}", which is not a measurement.`,
      );
    }
    const reachedMm = given.reachedMm;
    if (reachedMm !== undefined) {
      if (typeof reachedMm !== 'number' || !Number.isFinite(reachedMm)) {
        throw new Error(
          `"${MOVE_FLAT_FACE_KIND}" was given a reached distance of "${String(reachedMm)}", which is not a measurement.`,
        );
      }
      return { distanceMm, reachedMm };
    }
    return { distanceMm };
  },

  apply({ mesh, facets, parameters }: MeshEditApplyInput<MoveFlatFaceParameters>): MeshEditApplyResult {
    return moveFlatFace(mesh, facets, parameters.distanceMm);
  },
};

registerMeshEditOperation(moveFlatFaceOperation);
