// WO-1846: what LienCAM can PROVE about the round features in an imported STL.
//
// Port of LienCAM-next's cylinder/cone fit + feature recognition cluster
// (meshCylinderSupport/Inference/Ends/Coverage, meshCylindricalFeature-
// Recognition, meshCounterbore, meshChamferedHole and the region topology
// under them) onto our own `MeshBuffers`.
//
// DECIDE-AND-LOG (WO-1846 fence, LIENCAM.md rule 3): Next's bigint exact
// predicate layer (exactCoordinates/exactBounds/meshPredicates/
// meshRadialBounds) is NOT ported. It is replaced by float64 arithmetic with
// an explicit, caller-visible tolerance. The reasons, so a later slice can
// reverse this deliberately rather than by accident:
//   - Next's exact layer is exact about the SOURCE COORDINATES, but every
//     number that matters here (the fitted axis, centre and radius) comes out
//     of a least-squares solve in float64 anyway. Exact predicates downstream
//     of an inexact surface buy an exact answer to the wrong question.
//   - The honest output this order owes Operator is the FIT ERROR - how far the
//     worst facet sits from the fitted surface - and that is a measured
//     float64 distance in both designs.
//   - Porting the exact layer means porting Next's whole mesh model
//     (TriangleMesh, string vertex/triangle ids, meshSelection, meshDiagnosis)
//     which our MeshBuffers + WO-1845 facet-id view already replace.
// What is NOT given up: the conservative WHOLE-FACET acceptance. Every facet
// of a region must lie inside the tolerance band of the fitted surface across
// its ENTIRE area, not at its vertices - see `facetRadialBounds` in
// surfaces.ts. No outlier is trimmed, no facet is relabelled, and a region
// with one bad facet is not a cylinder.

import type { Vec3 } from '../types';

/** What a proved feature is. Nothing else is ever listed. */
export type FeatureKind =
  | 'through-hole'
  | 'blind-hole'
  | 'boss'
  | 'counterbore'
  | 'countersink'
  | 'chamfered-hole';

/** One fitted surface inside a feature, in axial order (low station first). */
export interface FeatureBand {
  surface: 'cylinder' | 'cone';
  /** cylinder: the fitted diameter. cone: the diameter at `axialRangeMm[0]`. */
  diameterMm: number;
  /** cone only: the diameter at `axialRangeMm[1]`. */
  endDiameterMm?: number;
  /** cone only: the full included angle of the cone, degrees. */
  includedAngleDeg?: number;
  /** [low, high] station along `axis.direction`, measured from `axis.origin`. */
  axialRangeMm: [number, number];
  /** worst distance from any point of any facet in this band to the fitted
   *  surface. This is the fit error, not a machining tolerance. */
  maxDeviationMm: number;
  /** WO-1845 source-facet ids of this band's facets, ascending. */
  sourceFacetIds: number[];
}

export interface FeatureAxis {
  /** a point on the axis (the fitted centre of the seeding cylinder) */
  origin: Vec3;
  /** unit direction; stations increase along it */
  direction: Vec3;
}

export interface RecognizedFeature {
  /** stable within one query result: `${kind}-${smallest source facet id}` */
  id: string;
  kind: FeatureKind;
  axis: FeatureAxis;
  /** the functional bore/boss diameter: the SMALLEST cylinder for a hole or a
   *  counterbore (the part a cutter has to fit), the boss diameter for a boss. */
  diameterMm: number;
  /** every fitted diameter in the feature, axial order, cylinders and cone
   *  ends alike - so a counterbore reads "10 then 6" and a countersink reads
   *  "12 down to 6". */
  diametersMm: number[];
  /** total axial extent of the feature, high station minus low station. */
  depthMm: number;
  /** worst fit error over every band in the feature. */
  maxDeviationMm: number;
  bands: FeatureBand[];
  /** every facet that supports this feature - walls, cones, floor/cap - as
   *  WO-1845 source-facet ids, ascending. Selecting the feature highlights
   *  exactly these. */
  sourceFacetIds: number[];
  /** the conservative clear radius through the bore: fitted radius minus the
   *  measured deviation, rounded DOWN. Undefined for a boss. */
  coreRadiusMm?: number;
}

/**
 * WO-1908: a pocket family, proved the way a hole's diameter is proved.
 *
 * Deliberately NOT a member of `FeatureKind`. Every consumer of that union
 * (the panel's round-feature list, removal, boring) is a ROUND operation keyed
 * by it, and a pocket has no axis or diameter for any of them to act on.
 * Pockets ride in their own list, `MeshFeatureRecognition.pockets`, so the
 * round answer is exactly what it was before this family existed.
 */
export type PocketKind = 'rectangular-pocket';

/**
 * A pocket this mesh PROVES: one flat floor whose only boundary is a
 * rectangle, straight walls standing square to that floor on every side of it,
 * rising to one flat rim face parallel to the floor - and nothing else inside
 * the box they enclose. A floor with an island, a drafted or curved wall, a
 * rim that steps, or anything standing in the pocket is not listed.
 */
export interface RecognizedPocket {
  /** stable within one query result: `${kind}-${smallest source facet id}` */
  id: string;
  kind: PocketKind;
  /** unit normal of the floor, pointing OUT of the material - up out of the
   *  pocket towards its open rim */
  floorNormal: Vec3;
  /** the floor's four corners in the file's own frame, counter-clockwise seen
   *  from the open side (looking back along `floorNormal`) */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** the longer side of the rectangle */
  lengthMm: number;
  /** the shorter side of the rectangle */
  widthMm: number;
  /** rim height above the floor, measured along `floorNormal` */
  depthMm: number;
  /** worst distance of any floor, wall or rim point from the proved box: the
   *  fit error, stated rather than folded into the size */
  maxDeviationMm: number;
  /** WO-1845 source-facet ids of the floor alone, ascending */
  floorSourceFacetIds: number[];
  /** floor and walls, as WO-1845 source-facet ids, ascending */
  sourceFacetIds: number[];
}

/**
 * WO-1909: a slot - two parallel walls closed by round or flat ends, standing
 * on one flat floor. Like a pocket, its own list and never a `FeatureKind`.
 *
 * Round ends are proved from the floor's own outline (every point of it at one
 * distance from one straight centre segment). A flat-ended slot is a
 * rectangular pocket at least `SLOT_MIN_LENGTH_RATIO` times as long as it is
 * wide: the same proof as WO-1908's, named for what it is.
 */
export type SlotKind = 'slot';
export type SlotEndStyle = 'round' | 'flat';

/** WO-1909 (decide-and-log): a proved rectangle this many times longer than it
 *  is wide reads as a flat-ended slot rather than a pocket. WO-1908's 40 x 20
 *  pocket (2:1) stays a pocket. */
export const SLOT_MIN_LENGTH_RATIO = 3;

export interface RecognizedSlot {
  /** stable within one query result: `slot-${smallest source facet id}` */
  id: string;
  kind: SlotKind;
  endStyle: SlotEndStyle;
  /** unit normal of the floor, pointing up out of the slot to its open rim */
  floorNormal: Vec3;
  /** the slot's centreline ON THE FLOOR, file frame: where the centre of a
   *  cutter exactly as wide as the slot runs, end to end. For round ends these
   *  are the centres of the end arcs. */
  centerline: [Vec3, Vec3];
  /** overall length, end wall to end wall (centreline length + width) */
  lengthMm: number;
  /** distance between the two parallel walls */
  widthMm: number;
  /** rim height above the floor, along `floorNormal` */
  depthMm: number;
  /** worst distance of any floor, wall or rim point from the proved shape */
  maxDeviationMm: number;
  /** WO-1845 source-facet ids of the floor alone, ascending */
  floorSourceFacetIds: number[];
  /** floor and walls, as WO-1845 source-facet ids, ascending */
  sourceFacetIds: number[];
}

/**
 * WO-1909: a rectangular pocket whose walls LEAN - each wall a plane through
 * one side of a rectangular floor, tilted by its own draft angle, rising to one
 * flat rim. A pocket whose every wall stands square is WO-1908's family and is
 * never listed here.
 */
export type DraftedPocketKind = 'drafted-pocket';

export interface RecognizedDraftedPocket {
  /** stable within one query result: `drafted-pocket-${smallest source facet id}` */
  id: string;
  kind: DraftedPocketKind;
  floorNormal: Vec3;
  /** the floor's four corners, file frame, counter-clockwise from the open side */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** the lean of the wall standing on side k (`corners[k]` -> `corners[k+1]`),
   *  degrees from square to the floor. POSITIVE leans away from the pocket (it
   *  opens wider towards the rim - an ordinary draft); NEGATIVE leans over the
   *  pocket (the rim overhangs the floor - an undercut). */
  wallDraftDeg: [number, number, number, number];
  /** the largest rectangle, ON THE FLOOR, a straight cutter coming down along
   *  `floorNormal` can reach over the whole depth without cutting into a wall:
   *  the floor with every undercut side pulled in by depth x tan(its angle).
   *  Equals `corners` when no wall is undercut. File frame, counter-clockwise. */
  clearCorners: [Vec3, Vec3, Vec3, Vec3];
  /** longer and shorter side of the FLOOR rectangle */
  lengthMm: number;
  widthMm: number;
  depthMm: number;
  maxDeviationMm: number;
  floorSourceFacetIds: number[];
  sourceFacetIds: number[];
}

/** A region the recogniser looked at and could not prove. Kept so the panel
 *  can stay silent about it honestly rather than guessing (LIENCAM.md 11:
 *  we say what we did, we do not invent what we could not measure). */
export interface FeatureRefusal {
  reason: string;
  facetCount: number;
  /** the region's facets, as source-facet ids - for a diagnostic, not the UI */
  sourceFacetIds: number[];
}

export interface MeshFeatureOptions {
  /**
   * The chord-deviation budget, mm. A facet of a tessellated hole is a CHORD:
   * on a 16-sided 6 mm hole its midpoint sits 0.058 mm inside the true bore.
   * This number is how much of that a region is allowed before we refuse to
   * call it a cylinder - it is NOT a machining tolerance and it is not what
   * gets reported. `maxDeviationMm` is the measured truth.
   * Default 0.25 mm: admits a 16-sided 12 mm boss (0.115 mm) with room, and
   * still refuses anything that is not round.
   */
  toleranceMm?: number;
  /**
   * Region growing: two adjacent facets join one region when the tangent of
   * the angle between their normals is <= this. Default 0.5 (26.6 degrees).
   * Loose enough to walk a coarse 16-sided bore (11.25 deg per step, slope
   * 0.199); tight enough that a 90-degree countersink's cone (45 deg off its
   * bore, slope 1.0) stays a SEPARATE region instead of being swallowed into
   * the cylinder. Known limit of that choice, stated rather than hidden: a
   * chamfer shallower than 26.6 degrees off its bore merges with it. WO-1889
   * no longer leaves the pair refused: a region that proves as nothing is cut
   * again at its own sharpest internal dihedral and the halves are re-proved
   * (see `splitMergedRegions`), so the 20-degree chamfer real exporters write
   * is recognised as a chamfer rather than swallowed by its bore.
   */
  maxNormalSlope?: number;
  /** A region below this many facets cannot spread its normals enough to seed
   *  an axis honestly. Default 6. */
  minRegionFacets?: number;
  /**
   * WO-1889. Vertices this far apart or closer, when BOTH sit on an open
   * boundary, are one point: that is a crack in the export, not a feature.
   * Default 0.001 mm. A closed solid has no open boundary and is untouched.
   * Set to 0 to weld by exact coordinate only, as WO-1846 did.
   */
  weldToleranceMm?: number;
  /**
   * WO-1889. How many levels a facet may be subdivided to re-prove a cylinder
   * or cone fit that a COARSE tessellation put just outside tolerance. Default
   * 2. The subdivision only improves the fitted surface - acceptance stays
   * whole-facet over the original facets - so 0 gives WO-1846's answer.
   */
  fitSubdivisionLevels?: number;
  /**
   * WO-1889. May a region that proves as nothing be cut at its own sharpest
   * internal dihedral and its parts re-proved? Default true. This is what finds
   * a shallow chamfer that region growing merged into its bore, and a
   * countersink an exporter wrote as several cone bands. It never runs on a
   * region that already proves - only where LienCAM would otherwise refuse.
   */
  splitMergedRegions?: boolean;
}

export interface MeshFeatureRecognition {
  features: RecognizedFeature[];
  /** WO-1908: the flat-bottomed pockets this mesh proves, by first source
   *  facet id. Separate from `features`, which stays round-only. */
  pockets: RecognizedPocket[];
  /** WO-1909: slots (round or flat ends), by first source facet id */
  slots: RecognizedSlot[];
  /** WO-1909: rectangular pockets with at least one leaning wall */
  draftedPockets: RecognizedDraftedPocket[];
  refusals: FeatureRefusal[];
  /** the tolerance actually used, echoed so a report can state it */
  toleranceMm: number;
  /** facets the query examined (the whole mesh) */
  facetCount: number;
  /** WO-1889: cracked vertex pairs welded shut before recognition ran. The
   *  import is untouched; this is what the recogniser treated as one point. */
  crackWeldsClosed: number;
  /** WO-1889: cracks left open because more than one vertex was within the
   *  weld tolerance and picking one would have been a guess. */
  ambiguousCrackWelds: number;
}

export const DEFAULT_FEATURE_OPTIONS: Required<MeshFeatureOptions> = {
  toleranceMm: 0.25,
  maxNormalSlope: 0.5,
  minRegionFacets: 6,
  weldToleranceMm: 0.001,
  fitSubdivisionLevels: 2,
  splitMergedRegions: true,
};

// ---- small float64 vector helpers (shared by the whole directory) ----------

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}
