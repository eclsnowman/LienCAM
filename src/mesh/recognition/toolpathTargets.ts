// WO-1851: a hole found in an STL can be drilled.
//
// WO-1846 proves what round features an imported STL contains. This file is
// the only place that turns those proofs into things a TOOLPATH can aim at:
// a drillable hole with a real centre, diameter and depth, and - where the
// same proof carries a flat floor - a pocket boundary with a floor depth.
//
// Two things this file owes its callers, and neither is negotiable:
//
//   1. THE FRAME. Recognition runs on the STL's own raw file coordinates.
//      Everything the viewport draws, and every edge chain the store already
//      offers, lives in the RECENTRED local frame CNCViewport.addSTL puts the
//      mesh in: XY bounding-box centre to the origin, bottom face to Z 0. A
//      centre reported in the file's frame lands the drill off the part by
//      exactly the recentring shift - the same defect WO-319 fixed for edge
//      chains. Every coordinate that leaves this file is recentred.
//   2. NO GUESSING (LIENCAM.md 11 and WO-1846's own contract). A feature that
//      is not proved is not listed, and a proved feature whose axis is not
//      parallel to Z is reported as a REFUSAL with its reason, not silently
//      dropped and not bent onto Z. Drill and bore are Z-axis operations here;
//      a tilted bore is a thing the software cannot do today, so it says so.

import type { MeshBuffers, Vec3 } from '../types';
import { recognizeMeshFeatures } from './index';
import type {
  DraftedPocketKind,
  FeatureKind,
  MeshFeatureOptions,
  PocketKind,
  RecognizedFeature,
  SlotEndStyle,
  SlotKind,
} from './types';

/** WO-1909: every kind of floor a pocket target can stand on. */
export type MeshCavityKind = FeatureKind | PocketKind | SlotKind | DraftedPocketKind;

/** The recentring CNCViewport.addSTL applies to every imported STL, as a
 *  translation to ADD to a raw-file coordinate.
 *
 *  Deliberately computed here rather than imported from the store: this is the
 *  third statement of the same mirror (addSTL itself, meshContourLoops in
 *  store/index.ts, and this), and WO-1851's contract is that the edge chains
 *  meshContourLoops already produces are left BYTE-IDENTICAL. Sharing the
 *  helper would have meant editing that function. The cross-check that the two
 *  frames really do agree is behavioural instead, and lives in
 *  src/tests/mesh/stlFeatureTargets.wo1851.test.ts: a recognised hole's centre
 *  must land on the centre of the edge chain around the same bore. */
export function meshRecenterShift(mesh: MeshBuffers): Vec3 {
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;
  for (let offset = 0; offset + 2 < mesh.positions.length; offset += 3) {
    minX = Math.min(minX, mesh.positions[offset]); maxX = Math.max(maxX, mesh.positions[offset]);
    minY = Math.min(minY, mesh.positions[offset + 1]); maxY = Math.max(maxY, mesh.positions[offset + 1]);
    minZ = Math.min(minZ, mesh.positions[offset + 2]);
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [-(minX + maxX) / 2, -(minY + maxY) / 2, -minZ];
}

/** A hole a drill or a bore can be pointed at. Field-for-field the facts
 *  `HoleFeature` carries for a solid, so the store can hand the same shape to
 *  the same dispatch, plus the provenance an STL has and a solid does not. */
export interface MeshHoleTarget {
  /** WO-1846's feature id: stable for an unchanged mesh, and the only name
   *  this target is ever referred to by. */
  featureId: string;
  kind: FeatureKind;
  /** hole axis, RECENTRED local XY (axis is parallel to Z) */
  center: [number, number];
  /** the functional bore diameter - the size a cutter has to fit through */
  diameterMm: number;
  /** RECENTRED local Z of the top of the feature */
  topZ: number;
  /** RECENTRED local Z of the bottom of the feature */
  bottomZ: number;
  /** topZ - bottomZ. Equals WO-1846's measured depthMm. */
  depthMm: number;
  /** true only for a proved through hole */
  through: boolean;
  /** the conservative clear radius through the bore (WO-1846), when measured */
  coreRadiusMm?: number;
  /** worst fit error over the feature. Stated, never folded into a diameter. */
  maxDeviationMm: number;
  /** WO-1845 source-facet ids supporting the feature, ascending */
  sourceFacetIds: number[];
}

/** A flat floor a pocket can be cut down to, with the boundary round it. */
export interface MeshPocketTarget {
  featureId: string;
  /** WO-1908: which proved feature this floor belongs to. A round floor (a
   *  blind hole's, a counterbore's shoulder) is bounded by a circle; a
   *  'rectangular-pocket', a 'slot' and a 'drafted-pocket' (WO-1909) are
   *  bounded by `outline`. */
  kind: MeshCavityKind;
  /** RECENTRED local XY of the boundary centre */
  center: [number, number];
  /** the boundary diameter - the widest bore standing over this floor. For a
   *  rectangular pocket, the diagonal: the circle its corners sit on. */
  diameterMm: number;
  /** WO-1908, rectangular pocket: the boundary itself, its four corners in
   *  RECENTRED local XY, counter-clockwise seen from above. WO-1909: a slot's
   *  outline (round ends as 32-chord arcs, every chord inside the true arc);
   *  a drafted pocket's CLEAR outline - the floor less every undercut, the
   *  most a straight cutter reaches without cutting into a wall. */
  outline?: Array<[number, number]>;
  /** WO-1908: [longer side, shorter side], mm. A slot: [overall length,
   *  width]. A drafted pocket: the floor's own sides. */
  sizeMm?: [number, number];
  /** WO-1909, slot only: round or flat ends */
  endStyle?: SlotEndStyle;
  /** WO-1909, slot only: where the centre of a cutter as wide as the slot
   *  runs, end to end, RECENTRED local XY */
  centerline?: [[number, number], [number, number]];
  /** WO-1909, drafted pocket only: each wall's lean, degrees, in floor-side
   *  order; positive opens out (draft), negative overhangs (undercut) */
  wallDraftDeg?: [number, number, number, number];
  /** WO-1909, drafted pocket only: the floor rectangle itself, RECENTRED */
  floorOutline?: Array<[number, number]>;
  /** WO-1909, drafted pocket only: [longer, shorter] side of `outline` */
  clearSizeMm?: [number, number];
  /** RECENTRED local Z of the floor */
  floorZ: number;
  /** RECENTRED local Z of the rim the pocket is entered from */
  topZ: number;
  maxDeviationMm: number;
  sourceFacetIds: number[];
}

/** A feature LienCAM proved but cannot aim a Z-axis toolpath at, and why.
 *  Kept rather than dropped: the operator is told what was found and what
 *  stopped it, never left with a silently shorter list. */
export interface MeshTargetRefusal {
  featureId: string;
  kind: MeshCavityKind;
  reason: string;
}

export interface MeshFeatureTargets {
  holes: MeshHoleTarget[];
  pockets: MeshPocketTarget[];
  refusals: MeshTargetRefusal[];
  /** the tolerance recognition actually ran at, echoed so a report can state it */
  toleranceMm: number;
}

/** Axis directions this far off vertical are still vertical. A 64-sided bore
 *  fits an axis to well under a thousandth of a degree; this admits real
 *  tessellation noise and nothing that is actually tilted. */
const VERTICAL_TOLERANCE = 1e-6;

/** A boss stands proud of the face. It is not a hole and it is not a pocket
 *  floor, so it is not a target here - and it is not a refusal either, because
 *  nothing was refused: it simply is not this kind of thing. */
const TARGET_KINDS: ReadonlySet<FeatureKind> = new Set<FeatureKind>([
  'through-hole', 'blind-hole', 'counterbore', 'countersink', 'chamfered-hole',
]);

/** [low, high] station along the feature axis, over every band. */
function axialSpan(feature: RecognizedFeature): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const band of feature.bands) {
    low = Math.min(low, band.axialRangeMm[0]);
    high = Math.max(high, band.axialRangeMm[1]);
  }
  return [low, high];
}

/** The shoulder target of a recognized counterbore, in the caller's frame. */
export function counterborePocketTarget(feature: RecognizedFeature, shift: Vec3): MeshPocketTarget {
  const widest = feature.bands.filter(b => b.surface === 'cylinder').reduce((a, b) => (b.diameterMm > a.diameterMm ? b : a));
  const ends = widest.axialRangeMm.map(t => feature.axis.origin[2] + feature.axis.direction[2] * t + shift[2]);
  return {
    featureId: feature.id, kind: 'counterbore',
    center: [feature.axis.origin[0] + shift[0], feature.axis.origin[1] + shift[1]],
    diameterMm: widest.diameterMm, floorZ: Math.min(...ends), topZ: Math.max(...ends),
    maxDeviationMm: widest.maxDeviationMm, sourceFacetIds: widest.sourceFacetIds,
  };
}

/**
 * Every recognised feature of `mesh`, restated as something a drill, a bore or
 * a pocket can be aimed at, in the RECENTRED local frame.
 *
 * `sourceFacetIds` is WO-1845's id view - pass the one `resolveEditedStlMesh`
 * returns, so an edited part's targets name triangles of the imported bytes.
 */
export function meshFeatureTargets(
  mesh: MeshBuffers,
  sourceFacetIds?: Uint32Array,
  options: MeshFeatureOptions = {},
): MeshFeatureTargets {
  const recognition = recognizeMeshFeatures(mesh, sourceFacetIds, options);
  const [shiftX, shiftY, shiftZ] = meshRecenterShift(mesh);

  const holes: MeshHoleTarget[] = [];
  const pockets: MeshPocketTarget[] = [];
  const refusals: MeshTargetRefusal[] = [];

  for (const feature of recognition.features) {
    if (!TARGET_KINDS.has(feature.kind)) continue;

    const [dx, dy, dz] = feature.axis.direction;
    if (Math.hypot(dx, dy) > VERTICAL_TOLERANCE) {
      // LIENCAM.md 11: say what we cannot do, in the operator's words, and say
      // it about THIS feature rather than shortening the list in silence.
      const tiltDeg = (Math.atan2(Math.hypot(dx, dy), Math.abs(dz)) * 180) / Math.PI;
      refusals.push({
        featureId: feature.id,
        kind: feature.kind,
        reason:
          `its axis is ${tiltDeg.toFixed(1)} degrees off vertical - drill and bore cut ` +
          'along Z, so a tilted bore needs the part re-fixtured or a 4th axis.',
      });
      continue;
    }

    // The axis may point either way; stations run along it. Both ends, mapped
    // to raw-file Z and then recentred, give the real top and bottom.
    const [lowStation, highStation] = axialSpan(feature);
    const zAt = (station: number): number =>
      feature.axis.origin[2] + dz * station + shiftZ;
    const zEnds = [zAt(lowStation), zAt(highStation)];
    const topZ = Math.max(...zEnds);
    const bottomZ = Math.min(...zEnds);

    holes.push({
      featureId: feature.id,
      kind: feature.kind,
      center: [feature.axis.origin[0] + shiftX, feature.axis.origin[1] + shiftY],
      diameterMm: feature.diameterMm,
      topZ,
      bottomZ,
      depthMm: topZ - bottomZ,
      through: feature.kind === 'through-hole',
      ...(feature.coreRadiusMm !== undefined ? { coreRadiusMm: feature.coreRadiusMm } : {}),
      maxDeviationMm: feature.maxDeviationMm,
      sourceFacetIds: feature.sourceFacetIds,
    });

    // A pocket target is a PROVED flat floor with a proved boundary over it.
    // WO-1846's door proves exactly two of those, and this file offers neither
    // more nor less (decide-and-log, LIENCAM.md 3 - see the WO result):
    //   - a blind hole: its floor, inside its own bore;
    //   - a counterbore: the shoulder, inside the LARGE bore.
    // A through hole has no floor. A countersink's cone is not flat. A general
    // flat-face recogniser is not behind WO-1846's one door; the rectangular
    // machined pocket is WO-1908's own proof, below.
    if (feature.kind === 'blind-hole') {
      pockets.push({
        featureId: feature.id,
        kind: feature.kind,
        center: [feature.axis.origin[0] + shiftX, feature.axis.origin[1] + shiftY],
        diameterMm: feature.diameterMm,
        floorZ: bottomZ,
        topZ,
        maxDeviationMm: feature.maxDeviationMm,
        sourceFacetIds: feature.sourceFacetIds,
      });
    } else if (feature.kind === 'counterbore') {
      pockets.push(counterborePocketTarget(feature, [shiftX, shiftY, shiftZ]));
    }
  }

  // WO-1908: a proved rectangular pocket is a floor with its OWN measured
  // height and a rectangle round it - the operation bottoms on the floor that
  // was measured, not on whatever plane a picked rim chain happens to sit at.
  for (const pocket of recognition.pockets) {
    const refusal = floorRefusal(pocket.floorNormal);
    if (refusal) {
      refusals.push({ featureId: pocket.id, kind: pocket.kind, reason: refusal });
      continue;
    }
    const outline = pocket.corners.map(
      (corner) => [corner[0] + shiftX, corner[1] + shiftY] as [number, number],
    );
    const floorZ = pocket.corners.reduce((sum, corner) => sum + corner[2], 0) / 4 + shiftZ;
    pockets.push({
      featureId: pocket.id,
      kind: pocket.kind,
      center: [
        outline.reduce((sum, corner) => sum + corner[0], 0) / 4,
        outline.reduce((sum, corner) => sum + corner[1], 0) / 4,
      ],
      diameterMm: Math.hypot(pocket.lengthMm, pocket.widthMm),
      outline,
      sizeMm: [pocket.lengthMm, pocket.widthMm],
      floorZ,
      topZ: floorZ + pocket.depthMm,
      maxDeviationMm: pocket.maxDeviationMm,
      sourceFacetIds: pocket.sourceFacetIds,
    });
  }

  // WO-1909: a slot is cut down to its own floor, bounded by its own outline,
  // and carries the centreline a cutter as wide as the slot would follow.
  for (const slot of recognition.slots) {
    const refusal = floorRefusal(slot.floorNormal);
    if (refusal) {
      refusals.push({ featureId: slot.id, kind: slot.kind, reason: refusal });
      continue;
    }
    const [a, b] = slot.centerline.map(
      (point) => [point[0] + shiftX, point[1] + shiftY] as [number, number],
    );
    const floorZ = (slot.centerline[0][2] + slot.centerline[1][2]) / 2 + shiftZ;
    pockets.push({
      featureId: slot.id,
      kind: slot.kind,
      center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      diameterMm: slot.lengthMm,
      outline: slotOutline(a, b, slot.widthMm / 2, slot.endStyle),
      sizeMm: [slot.lengthMm, slot.widthMm],
      endStyle: slot.endStyle,
      centerline: [a, b],
      floorZ,
      topZ: floorZ + slot.depthMm,
      maxDeviationMm: slot.maxDeviationMm,
      sourceFacetIds: slot.sourceFacetIds,
    });
  }

  // WO-1909: a drafted pocket is bounded by what a straight cutter can reach
  // over its whole depth - so an undercut wall is never cut into - with the
  // floor rectangle and every wall's lean carried alongside.
  for (const drafted of recognition.draftedPockets) {
    const refusal = floorRefusal(drafted.floorNormal);
    if (refusal) {
      refusals.push({ featureId: drafted.id, kind: drafted.kind, reason: refusal });
      continue;
    }
    const recentre = (corner: Vec3): [number, number] => [corner[0] + shiftX, corner[1] + shiftY];
    const outline = drafted.clearCorners.map(recentre);
    const clearSides = [0, 1].map((k) => Math.hypot(
      outline[k + 1][0] - outline[k][0], outline[k + 1][1] - outline[k][1],
    ));
    if (Math.min(...clearSides) <= recognition.toleranceMm) {
      refusals.push({
        featureId: drafted.id,
        kind: drafted.kind,
        reason: 'its undercut walls close over the whole floor - a straight cutter coming down ' +
          'along Z cannot reach it without cutting into them.',
      });
      continue;
    }
    const floorZ = drafted.corners.reduce((sum, corner) => sum + corner[2], 0) / 4 + shiftZ;
    pockets.push({
      featureId: drafted.id,
      kind: drafted.kind,
      center: [
        outline.reduce((sum, corner) => sum + corner[0], 0) / 4,
        outline.reduce((sum, corner) => sum + corner[1], 0) / 4,
      ],
      diameterMm: Math.hypot(clearSides[0], clearSides[1]),
      outline,
      sizeMm: [drafted.lengthMm, drafted.widthMm],
      wallDraftDeg: drafted.wallDraftDeg,
      floorOutline: drafted.corners.map(recentre),
      clearSizeMm: [Math.max(...clearSides), Math.min(...clearSides)],
      floorZ,
      topZ: floorZ + drafted.depthMm,
      maxDeviationMm: drafted.maxDeviationMm,
      sourceFacetIds: drafted.sourceFacetIds,
    });
  }

  return { holes, pockets, refusals, toleranceMm: recognition.toleranceMm };
}

/** Why a floor facing this way cannot be cut by a Z-down pocket op, or
 *  undefined when it can (WO-1908's wording, shared by WO-1909's families). */
function floorRefusal(floorNormal: Vec3): string | undefined {
  const [nx, ny, nz] = floorNormal;
  if (Math.hypot(nx, ny) <= VERTICAL_TOLERANCE && nz >= 0) return undefined;
  const offDeg = (Math.acos(Math.max(-1, Math.min(1, nz))) * 180) / Math.PI;
  return nz < 0 && Math.hypot(nx, ny) <= VERTICAL_TOLERANCE
    ? 'it opens downward - a pocket is cut from above, so the part needs turning over first.'
    : `its floor is ${offDeg.toFixed(1)} degrees off level - a pocket cuts along Z, ` +
      'so a tilted floor needs the part re-fixtured or a 4th axis.';
}

/** Chords per round slot end. Each sits inside its arc (sagitta 0.005 mm on
 *  an 8 mm slot), so the outline never reaches past the real wall. */
const SLOT_END_CHORDS = 32;

/** A slot's outline in local XY, counter-clockwise from above, from its
 *  centreline `a` -> `b` and half-width. */
function slotOutline(
  a: readonly [number, number],
  b: readonly [number, number],
  halfWidth: number,
  endStyle: SlotEndStyle,
): Array<[number, number]> {
  const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d: [number, number] = [(b[0] - a[0]) / run, (b[1] - a[1]) / run];
  const e: [number, number] = [-d[1], d[0]];
  const at = (c: readonly [number, number], along: number, across: number): [number, number] =>
    [c[0] + d[0] * along + e[0] * across, c[1] + d[1] * along + e[1] * across];
  if (endStyle === 'flat') {
    return [
      at(a, -halfWidth, -halfWidth), at(b, halfWidth, -halfWidth),
      at(b, halfWidth, halfWidth), at(a, -halfWidth, halfWidth),
    ];
  }
  const arc = (c: readonly [number, number], from: number): Array<[number, number]> =>
    Array.from({ length: SLOT_END_CHORDS + 1 }, (_, i) => {
      const angle = from + (Math.PI * i) / SLOT_END_CHORDS;
      return at(c, halfWidth * Math.cos(angle), halfWidth * Math.sin(angle));
    });
  return [...arc(b, -Math.PI / 2), ...arc(a, Math.PI / 2)];
}

/**
 * WO-1908: how a pocket floor reads to the operator - the size he would
 * measure and the height its floor sits at, in the part's own frame (bottom on
 * Z 0), the way a hole already reads with its diameter and depth:
 * "rectangular pocket 40.00 x 20.00 mm, floor Z 6.00".
 */
export function describePocketTarget(target: MeshPocketTarget): string {
  const floor = `floor Z ${target.floorZ.toFixed(2)}`;
  if (target.kind === 'rectangular-pocket' && target.sizeMm) {
    return `rectangular pocket ${target.sizeMm[0].toFixed(2)} x ${target.sizeMm[1].toFixed(2)} mm, ${floor}`;
  }
  // WO-1909: "slot 38.00 x 8.00 mm, round ends, floor Z 6.00"
  if (target.kind === 'slot' && target.sizeMm && target.endStyle) {
    return `slot ${target.sizeMm[0].toFixed(2)} x ${target.sizeMm[1].toFixed(2)} mm, ` +
      `${target.endStyle} ends, ${floor}`;
  }
  // WO-1909: "drafted pocket 40.00 x 20.00 mm, 1 wall 5.0 deg undercut
  // (cutter reach 40.00 x 19.48 mm), floor Z 6.00"
  if (target.kind === 'drafted-pocket' && target.sizeMm && target.wallDraftDeg) {
    const size = `${target.sizeMm[0].toFixed(2)} x ${target.sizeMm[1].toFixed(2)} mm`;
    const byAngle = new Map<string, number>();
    for (const deg of target.wallDraftDeg) {
      if (Math.abs(deg) < 0.05) continue;
      const label = `${Math.abs(deg).toFixed(1)} deg ${deg < 0 ? 'undercut' : 'draft'}`;
      byAngle.set(label, (byAngle.get(label) ?? 0) + 1);
    }
    const walls = [...byAngle].map(([label, count]) => `${count} wall${count === 1 ? '' : 's'} ${label}`);
    const reach = target.wallDraftDeg.some((deg) => deg <= -0.05) && target.clearSizeMm
      ? ` (cutter reach ${target.clearSizeMm[0].toFixed(2)} x ${target.clearSizeMm[1].toFixed(2)} mm)`
      : '';
    return `drafted pocket ${size}, ${walls.join(', ')}${reach}, ${floor}`;
  }
  return `${target.diameterMm.toFixed(2)} mm round pocket floor, ${floor}`;
}
