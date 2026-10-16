// WO-1846: THE query. "What round features can LienCAM prove in this STL?"
//
// Port of Next's meshCylindricalFeatureRecognition + meshCounterbore +
// meshChamferedHole, assembled into one entry point over MeshBuffers so the
// slices that consume it (WO-1847 removal, WO-1851 toolpaths) have one door.
//
// The shape of the proof, unchanged from Next:
//   1. segment the mesh into smoothly connected regions;
//   2. fit a cylinder to each and REQUIRE every facet of it to lie inside the
//      tolerance band across its whole area (surfaces.ts);
//   3. require both end rings to close round the axis and lie flat across it
//      (ends.ts);
//   4. require the neighbouring material at each end to say what the feature
//      is - open face, floor, cap, shoulder or chamfer cone;
//   5. require the bore itself to be CLEAR: nothing may stand in the corridor
//      between the ends (ends.ts corridorObstructions). A rib across the bore
//      is why a hole is not a hole.
// A region that fails any of these is not listed. It is not downgraded to a
// guess, and it is not listed with a caveat.
//
// WO-1908 adds one non-round family, asked of the same welded mesh after the
// round answer is complete: the rectangular pocket (`proveRectangularPockets`
// at the foot of this file). It never touches a round feature or a refusal.

import type { MeshBuffers, Vec3 } from '../types';
import { NO_SOURCE_FACET } from '../edit/idView';
import {
  DEFAULT_FEATURE_OPTIONS,
  SLOT_MIN_LENGTH_RATIO,
  add,
  dot,
  length,
  normalize,
  scale,
  sub,
  type FeatureBand,
  type FeatureRefusal,
  type MeshFeatureOptions,
  type MeshFeatureRecognition,
  type RecognizedFeature,
  type RecognizedDraftedPocket,
  type RecognizedPocket,
  type RecognizedSlot,
} from './types';
import {
  ambiguousTopology,
  boundaryCycles,
  buildAdjacency,
  facetNormal,
  facetPoints,
  internalSlopeCuts,
  partitionFacets,
  planarRegions,
  regionBoundaryEdges,
  splitRegionAtSlope,
  vertexAt,
  weldMesh,
  type WeldedMesh,
} from './topology';
import {
  axisFrame,
  inferCoaxialCone,
  inferCylinder,
  type ConeSurface,
  type CylinderSurface,
  type SurfaceInspection,
} from './surfaces';
import { provePlateBosses } from './plateBosses';
import { corridorObstructions, inspectCylinderEnds, type CylinderEnd } from './ends';

interface Wall {
  facets: number[];
  surface: CylinderSurface;
  inspection: SurfaceInspection;
  ends: [CylinderEnd, CylinderEnd];
}

interface Cone {
  facets: number[];
  surface: ConeSurface;
  inspection: SurfaceInspection;
  /** the ring shared with the cylinder, and the ring on its far side */
  innerRing: number[];
  outerRing: number[];
}

type EndContext =
  | { kind: 'planar'; patch: number; facets: number[]; away: boolean; stationMm: number }
  /** WO-1889: a countersink an exporter split into bands is a STACK of coaxial
   *  cones, innermost first; the ordinary single cone is a stack of one. */
  | { kind: 'cone'; cones: Cone[] }
  | { kind: 'unsupported'; reason: string };

/** How many actual partitions of a region are proved before giving up.
 *  A threshold that leaves the region whole proposes no surface boundary and
 *  does not spend a proof attempt. Three partitions bound surface fitting on
 *  a freeform patch that will never split into anything provable. */
const MAX_SPLIT_CUTS = 3;

const ringKey = (ids: readonly number[]): string => [...ids].sort((a, b) => a - b).join(',');

/** Round a clear radius DOWN. A bore's guaranteed core must never be reported
 *  larger than it is; a float subtraction alone can round it up. */
const roundDown = (value: number): number => value - Math.abs(value) * 4 * Number.EPSILON;

/**
 * Every round feature this mesh PROVES.
 *
 * `sourceFacetIds` is WO-1845's id view: facet i of `mesh` descends from
 * source-file triangle `sourceFacetIds[i]`. Pass the one `resolveEditedStlMesh`
 * returns and the ids in the result survive save/reload, because they name
 * triangles of the imported bytes rather than positions in whatever mesh the
 * journal happens to have produced. Omit it and facet indices are used as-is
 * (correct only for an unedited STL).
 */
export function recognizeMeshFeatures(
  mesh: MeshBuffers,
  sourceFacetIds?: Uint32Array,
  options: MeshFeatureOptions = {},
): MeshFeatureRecognition {
  const settings = { ...DEFAULT_FEATURE_OPTIONS, ...options };
  const {
    toleranceMm,
    maxNormalSlope,
    minRegionFacets,
    weldToleranceMm,
    fitSubdivisionLevels,
    splitMergedRegions,
  } = settings;
  const w = weldMesh(mesh, weldToleranceMm);
  const toSource = (facets: readonly number[]): number[] => {
    const out = new Set<number>();
    for (const f of facets) {
      const id = sourceFacetIds ? sourceFacetIds[f] : f;
      if (id !== undefined && id !== NO_SOURCE_FACET) out.add(id);
    }
    return [...out].sort((a, b) => a - b);
  };
  const empty = (refusals: FeatureRefusal[] = []): MeshFeatureRecognition => ({
    features: [],
    pockets: [],
    slots: [],
    draftedPockets: [],
    refusals,
    toleranceMm,
    facetCount: w.facetCount,
    crackWeldsClosed: w.crackWelds,
    ambiguousCrackWelds: w.ambiguousWelds,
  });

  if (w.facetCount === 0) return empty();
  if (ambiguousTopology(w)) {
    return empty([{ reason: 'ambiguous-topology', facetCount: w.facetCount, sourceFacetIds: [] }]);
  }

  const refusals: FeatureRefusal[] = [];
  const refuse = (reason: string, facets: readonly number[]) =>
    refusals.push({ reason, facetCount: facets.length, sourceFacetIds: toSource(facets) });

  const { smooth, blocked } = buildAdjacency(w, maxNormalSlope);
  const grown = partitionFacets(w.facetCount, (f) => w.areas[f] > 0, smooth, blocked);
  // WO-1889: a region that proves as nothing may be two surfaces region growing
  // could not tell apart - a bore and the shallow chamfer on its lip. Cutting
  // it at its own sharpest internal dihedral is tried ONLY there, so every
  // region that already proves keeps the facets, the fit and the fit error it
  // had before this order.
  // Proved splits may recover tiny seam fragments excluded by normal-angle
  // growing. Claim them once, before publishing region ownership; never leave
  // a recovered facet simultaneously in its old singleton and its new wall.
  const splitClaims = new Set<number>();
  const splitRegions = new Map<number, number[][]>();
  for (const index of grown.map((_,i)=>i).sort((a,b)=>grown[b].length-grown[a].length)) {
    const facets = grown[index].filter(f=>!splitClaims.has(f));
    const split = shallowTransitionSplit(facets);
    if (!split) continue;
    splitRegions.set(index,split);
    for (const part of split) for (const f of part) splitClaims.add(f);
  }
  const regions = grown.flatMap((facets,i) => splitRegions.get(i) ?? [facets.filter(f=>!splitClaims.has(f))]).filter(part=>part.length);
  const regionOf = new Int32Array(w.facetCount).fill(-1);
  regions.forEach((group, i) => group.forEach((f) => (regionOf[f] = i)));

  const patches = planarRegions(w, toleranceMm, maxNormalSlope);
  const patchOf = new Int32Array(w.facetCount).fill(-1);
  patches.forEach((group, i) => group.forEach((f) => (patchOf[f] = i)));
  const patchLoops = patches.map((group) => boundaryCycles(regionBoundaryEdges(w, new Set(group))).loops);

  // ---- 1. walls -----------------------------------------------------------
  const walls: Wall[] = [];
  for (const facets of regions) {
    if (facets.length < minRegionFacets) continue;
    const inference = inferCylinder(w, facets, toleranceMm, fitSubdivisionLevels);
    if (inference.status !== 'candidate') {
      if (inference.reason !== 'insufficient-normal-spread') refuse(inference.reason, facets);
      continue;
    }
    const ends = inspectCylinderEnds(
      w,
      facets,
      inference.surface.origin,
      inference.surface.axis,
      inference.surface.radiusMm,
      inference.inspection.maxDeviationMm,
      toleranceMm,
    );
    if (ends.status !== 'supported') {
      refuse(ends.reason, facets);
      continue;
    }
    walls.push({ facets, surface: inference.surface, inspection: inference.inspection, ends: ends.ends });
  }

  // ---- 2. what sits at each end ------------------------------------------
  const contexts = walls.map((wall) => wall.ends.map((end, side) => endContext(wall, end, side as 0 | 1)));

  function endContext(wall: Wall, end: CylinderEnd, side: 0 | 1): EndContext {
    const facets = neighbourFacets(w, new Set(wall.facets), new Set(end.vertexIds));
    if (!facets.length) return { kind: 'unsupported', reason: 'unsupported-opening' };
    const patch = patchOf[facets[0]];
    if (patch >= 0 && facets.every((f) => patchOf[f] === patch)) {
      const axialSigns = facets.map((f) => dot(facetNormal(w, f), wall.surface.axis));
      if (axialSigns.some((s) => s === 0)) return { kind: 'unsupported', reason: 'unsupported-opening' };
      const away = side === 0 ? axialSigns.every((s) => s < 0) : axialSigns.every((s) => s > 0);
      const toward = side === 0 ? axialSigns.every((s) => s > 0) : axialSigns.every((s) => s < 0);
      if (!away && !toward) return { kind: 'unsupported', reason: 'unsupported-opening' };
      // the whole patch must be flat at this end's station
      const flat = patches[patch].every((f) =>
        facetPoints(w, f).every(
          (p) => Math.abs(dot(sub(p, wall.surface.origin), wall.surface.axis) - end.stationMm) <= toleranceMm,
        ),
      );
      if (!flat) return { kind: 'unsupported', reason: 'nonplanar-opening' };
      return { kind: 'planar', patch, facets, away, stationMm: end.stationMm };
    }
    // Not one flat patch: the only other thing we will prove is a coaxial cone,
    // or (WO-1889) a stack of them the exporter wrote as separate bands.
    const region = regionOf[facets[0]];
    if (region < 0 || !facets.every((f) => regionOf[f] === region)) {
      return { kind: 'unsupported', reason: 'unsupported-opening' };
    }
    const band = regions[region];
    const single = proveCone(band, wall, end.vertexIds);
    if (single.status === 'cone') return { kind: 'cone', cones: [single.cone] };
    if (!splitMergedRegions) return { kind: 'unsupported', reason: single.reason };
    const stacked = bandedConeStack(band, wall, end.vertexIds);
    if (stacked) return { kind: 'cone', cones: stacked };
    return { kind: 'unsupported', reason: single.reason };
  }

  /** One band as a coaxial cone about this wall, seated on `innerRingIds`. */
  function proveCone(
    band: readonly number[],
    wall: Wall,
    innerRingIds: readonly number[],
    coneToleranceMm = toleranceMm,
  ): { status: 'cone'; cone: Cone } | { status: 'no'; reason: string } {
    const inferred = inferCoaxialCone(
      w,
      band,
      wall.surface.origin,
      wall.surface.axis,
      wall.surface.materialSide,
      coneToleranceMm,
      fitSubdivisionLevels,
    );
    if (inferred.status !== 'candidate') return { status: 'no', reason: inferred.reason };
    const loops = boundaryCycles(regionBoundaryEdges(w, new Set(band))).loops;
    if (loops.length !== 2) return { status: 'no', reason: 'unsupported-seam' };
    const innerIndex = loops.findIndex((loop) => ringKey(loop) === ringKey(innerRingIds));
    if (innerIndex < 0) return { status: 'no', reason: 'unsupported-seam' };
    return {
      status: 'cone',
      cone: {
        facets: [...band],
        surface: inferred.surface,
        inspection: inferred.inspection,
        innerRing: loops[innerIndex],
        outerRing: loops[1 - innerIndex],
      },
    };
  }

  /**
   * WO-2080: an entry chamfer whose radial change is exactly the recogniser's
   * 2 x tolerance guard is still provable on a blind hole. Retry only that end
   * band, with a tighter fit budget: this lowers the minimum radius change
   * without weakening whole-facet acceptance. The band must still be one
   * coaxial cone seated on the wall and open onto a face.
   */
  function smallBlindHoleEntryCone(wallIndex: number, side: 0 | 1): Cone | undefined {
    const wall = walls[wallIndex];
    const end = wall.ends[side];
    const facets = neighbourFacets(w, new Set(wall.facets), new Set(end.vertexIds));
    if (!facets.length) return undefined;
    const region = regionOf[facets[0]];
    if (region < 0 || !facets.every((f) => regionOf[f] === region)) return undefined;
    const proof = proveCone(regions[region], wall, end.vertexIds, toleranceMm / 2);
    return proof.status === 'cone' && coneOpensToFace(proof.cone) ? proof.cone : undefined;
  }

  /** WO-2804: skinny seam triangles can put many high dihedral thresholds
   * before the first actual partition. Both cone and cylinder/cone searches
   * spend their bounded proof budget only on cuts that separate facets. */
  function* candidatePartitions(facets: readonly number[]): Generator<number[][]> {
    let attempts = 0;
    for (const cut of internalSlopeCuts(w, facets)) {
      const parts = splitRegionAtSlope(w, facets, cut);
      if (parts.length < 2) continue;
      yield parts;
      if (++attempts === MAX_SPLIT_CUTS) return;
    }
  }

  /**
   * WO-1889: the same region as a STACK of coaxial cones.
   *
   * A real exporter writes a countersink as several conical bands of slightly
   * different angle, and region growing - which only ever looks at the angle
   * between two neighbouring facets - hands the recogniser all of them as one
   * region that then fits no single cone. Cut it at its own sharpest internal
   * dihedral and every part must prove a coaxial cone in its own right, seated
   * ring to ring in an unbroken chain from the bore outwards. Nothing is
   * averaged and no band is dropped: if one part fails, or a ring does not
   * meet, there is no stack and the feature stays refused.
   */
  function bandedConeStack(band: readonly number[], wall: Wall, innerRingIds: readonly number[]): Cone[] | undefined {
    for (const parts of candidatePartitions(band)) {
      const remaining = [...parts];
      const chain: Cone[] = [];
      let ring: readonly number[] = innerRingIds;
      while (remaining.length) {
        let matched: { index: number; cone: Cone } | undefined;
        for (let index = 0; index < remaining.length && !matched; index++) {
          const proof = proveCone(remaining[index], wall, ring);
          if (proof.status === 'cone') matched = { index, cone: proof.cone };
        }
        if (!matched) break;
        chain.push(matched.cone);
        ring = matched.cone.outerRing;
        remaining.splice(matched.index, 1);
      }
      if (!remaining.length && chain.length >= 2) return chain;
    }
    return undefined;
  }

  /**
   * WO-1889: a region that proves as no cylinder, cut into a cylinder and the
   * coaxial cone welded to it by region growing.
   *
   * This is the shallow chamfer of the WO: below `maxNormalSlope` off its bore
   * (26.6 degrees by default) the chamfer's facets are smoothly adjacent to the
   * wall's, so the pair arrives as one region and fits nothing. The cut is a
   * dihedral the mesh itself contains; every part must then prove as a
   * cylinder or coaxial cone, on a cylinder's own axis and material side.
   * All parts go on to face every end, corridor and
   * opening check unchanged. A region that proves as a cylinder already is
   * never cut.
   */
  function shallowTransitionSplit(facets: readonly number[]): number[][] | undefined {
    if (!splitMergedRegions || facets.length < 2 * minRegionFacets) return undefined;
    const direct = inferCylinder(w, facets, toleranceMm, fitSubdivisionLevels);
    if (direct.status === 'candidate' || direct.reason !== 'surface-mismatch') return undefined;
    const proveParts = (parts: number[][]): boolean => {
      if (parts.length < 2 || parts.some(part => part.length < minRegionFacets)) return false;
      const cylinders = parts.map(part => inferCylinder(w, part, toleranceMm, fitSubdivisionLevels));
      return cylinders.some(cylinder => {
        if (cylinder.status !== 'candidate') return false;
        let hasCone = false;
        const proven = parts.every((part, index) => {
          const other = cylinders[index];
          if (other.status === 'candidate') return other.surface.materialSide === cylinder.surface.materialSide &&
            collinearAxes(cylinder.surface, other.surface, toleranceMm);
          const cone = inferCoaxialCone(w, part, cylinder.surface.origin, cylinder.surface.axis,
            cylinder.surface.materialSide, toleranceMm, fitSubdivisionLevels);
          if (cone.status !== 'candidate') return false;
          hasCone = true;
          return true;
        });
        return proven && hasCone;
      });
    };
    for (const parts of candidatePartitions(facets)) {
      if (proveParts(parts)) return parts;
      // An adaptive tessellator can use skinny triangles near a taper seam:
      // total normal angles then vary around the ring. A proved partial
      // cylinder supplies an AXIS HYPOTHESIS for another connected partition.
      // Axial normal components separate cylinder/cone slopes independently
      // of tangential tessellation angles. 0.01 proposes groups only; every
      // facet in every group still has to prove its surface below, followed
      // by the same closed-ring, material-side and corridor checks.
      const seed = parts.map(part => inferCylinder(w, part, toleranceMm, fitSubdivisionLevels))
        .find(fit => fit.status === 'candidate');
      if (seed?.status !== 'candidate') continue;
      const inside = new Set(facets);
      const projection = (f: number) => dot(facetNormal(w, f), seed.surface.axis);
      // Tiny float32 seam triangles can have a tangential normal jump and be
      // stranded by region growing. Recover only adjacent tiny regions with
      // the same axial component; the complete groups still face full proof.
      const tiny = new Set(grown.filter(part=>part.length<minRegionFacets).flat().filter(f=>!splitClaims.has(f)));
      let extended = true;
      while (extended) {
        extended = false;
        for (const edge of w.edges) {
          if (edge.facets.length !== 2) continue;
          for (const [a,b] of [edge.facets,[edge.facets[1],edge.facets[0]]]) {
            if (inside.has(a) && !inside.has(b) && tiny.has(b) && Math.abs(projection(a)-projection(b))<0.01) {
              inside.add(b); extended = true;
            }
          }
        }
      }
      const links: number[][] = Array.from({length:w.facetCount},()=>[]);
      for (const edge of w.edges) {
        if (edge.facets.length !== 2) continue;
        const [a,b] = edge.facets;
        if (inside.has(a) && inside.has(b)) { links[a].push(b); links[b].push(a); }
      }
      // Tangential normal jumps do not describe a cylinder/cone transition.
      // Use all manifold adjacency for this hypothesis, then prove each part.
      const axialParts = partitionFacets(w.facetCount, f => inside.has(f), links,
        Array.from({length:w.facetCount},()=>[]),
        (anchor, candidate) => Math.abs(projection(anchor) - projection(candidate)) < 0.01);
      if (proveParts(axialParts)) return axialParts;
    }
    return undefined;
  }

  // ---- 3. classify --------------------------------------------------------
  const features: RecognizedFeature[] = [];
  const consumed = new Set<number>();

  // WO-2804: a stepped hole is ONE connected void, not a pair of walls.
  // Follow exact ring adjacency through every shoulder and coaxial cone. Do
  // not group merely collinear holes: a disk floor ends this void, and a host
  // face with several openings is not a shoulder connecting those openings.
  for (let i = 0; i < walls.length; i++) {
    if (consumed.has(i) || walls[i].surface.materialSide !== 'inward') continue;
    const stack = assembleHoleStack(i);
    if (!stack) continue;
    // Classification names the complete proved void; it never limits how
    // many cones or shoulders that void may contain. Boss proof stays below.
    const kind = stack.walls.length > 1 ? 'counterbore' : stack.floors > 0 ? 'blind-hole'
      : stack.cones.length > 0 ? stack.coneOpenings === 2 ? 'chamfered-hole' : 'countersink' : 'through-hole';
    const feature = buildComposite(stack.walls, stack.cones, stack.support, kind);
    if (!feature) continue;
    for (const wall of stack.walls) consumed.add(wall);
    features.push(feature);
  }

  // 3b. chamfered / countersunk holes, then the plain ones.
  for (let i = 0; i < walls.length; i++) {
    if (consumed.has(i)) continue;
    const wall = walls[i];
    const [low, high] = contexts[i];
    const coneContexts = ([low, high] as const).flatMap((context, side) => {
      if (context.kind === 'cone') return [context];
      if (context.kind !== 'unsupported' || context.reason !== 'insufficient-radius-change') return [];
      const cone = smallBlindHoleEntryCone(i, side as 0 | 1);
      return cone ? [{ kind: 'cone' as const, cones: [cone] }] : [];
    });
    const cones = coneContexts as Array<Extract<EndContext, { kind: 'cone' }>>;
    if (wall.surface.materialSide === 'inward' && cones.length > 0) {
      // every cone must itself open onto a flat face, or we have not reached
      // the outside of the part and cannot call this a hole. For a stack of
      // bands that is the OUTERMOST band's far ring.
      const opens = cones.every((c) => coneOpensToFace(c.cones[c.cones.length - 1]));
      const plainEnds = [low, high].filter((c) => c.kind === 'planar' && c.away).length;
      if (opens && cones.length + plainEnds === 2) {
        const feature = buildComposite(
          [i],
          cones.flatMap((c) => c.cones),
          [],
          cones.length === 2 ? 'chamfered-hole' : 'countersink',
        );
        if (feature) {
          consumed.add(i);
          features.push(feature);
          continue;
        }
      }
      // WO-2080: the app's Step Test export is a blind cylindrical bore with
      // a disk floor and a chamfered entry. It is still a blind hole; the cone
      // and floor are support facets of the same editable feature.
      const floor = ([low, high] as const)
        .map((context, side) => ({ context, side: side as 0 | 1 }))
        .find(({ context, side }) =>
          context.kind === 'planar' && !context.away && isDisk(context.patch, wall.ends[side]),
        );
      if (opens && cones.length === 1 && floor?.context.kind === 'planar') {
        const feature = buildComposite(
          [i],
          cones[0].cones,
          patches[floor.context.patch],
          'blind-hole',
        );
        if (feature) {
          consumed.add(i);
          features.push(feature);
          continue;
        }
      }
      refuse('unsupported-transition', wall.facets);
      consumed.add(i);
      continue;
    }

    if (low.kind !== 'planar' || high.kind !== 'planar') {
      refuse(low.kind === 'unsupported' ? low.reason : (high as { reason: string }).reason, wall.facets);
      consumed.add(i);
      continue;
    }

    if (wall.surface.materialSide === 'inward') {
      if (low.away && high.away) {
        const feature = buildComposite([i], [], [], 'through-hole');
        if (feature) features.push(feature);
        else refuse('possible-bore-obstruction', wall.facets);
      } else if (low.away !== high.away) {
        const floor = low.away ? high : low;
        if (isDisk(floor.patch, wall.ends[low.away ? 1 : 0])) {
          const feature = buildComposite([i], [], patches[floor.patch], 'blind-hole');
          if (feature) features.push(feature);
          else refuse('possible-bore-obstruction', wall.facets);
        } else refuse('unsupported-floor', wall.facets);
      } else refuse('not-blind', wall.facets);
    } else {
      // outward wall: a boss. The cap is the end that points AWAY.
      if (low.away === high.away) {
        refuse('not-boss', wall.facets);
      } else {
        const cap = low.away ? low : high;
        if (isDisk(cap.patch, wall.ends[low.away ? 0 : 1])) {
          const feature = buildComposite([i], [], patches[cap.patch], 'boss');
          if (feature) features.push(feature);
          else refuse('possible-core-boundary', wall.facets);
        } else refuse('unsupported-cap', wall.facets);
      }
    }
    consumed.add(i);
  }

  // WO-2802: a boss may have a foot blend or a spherical cap. Prefer its
  // complete connected surface over a partial cylinder-only recognition.
  for (const boss of provePlateBosses(w, toleranceMm)) {
    // Keep the foot as a separately pickable blend. Removal completes the
    // selection before recording its witness, so that one boss edit still
    // includes the entire foot while Fillet/Defeature can edit the foot alone.
    const foot = new Set(boss.footFacets ?? []);
    const sourceIds = toSource(boss.facets.filter((f) => !foot.has(f)));
    if (!sourceIds.length) continue;
    const ids = new Set(sourceIds);
    // Keep established plain-cylinder bands when already proved. The plate
    // proof fills a missing plain boss too (including after foot removal).
    if (!boss.sphere && !foot.size && features.some((f) => f.kind === 'boss' && f.sourceFacetIds.every((id) => ids.has(id)))) continue;
    for (let i = features.length - 1; i >= 0; i--) {
      if (features[i].kind === 'boss' && features[i].sourceFacetIds.every((id) => ids.has(id))) features.splice(i, 1);
    }
    features.push({
      id: `boss-${sourceIds[0]}`, kind: 'boss',
      axis: { origin: boss.origin, direction: boss.normal },
      diameterMm: 2 * boss.radiusMm, diametersMm: [2 * boss.radiusMm],
      depthMm: boss.heightMm, maxDeviationMm: boss.maxDeviationMm,
      bands: [], sourceFacetIds: sourceIds,
      ...(boss.sphere ? { profile: 'spherical-cap' as const } : {}),
    });
  }

  features.sort((a, b) => (a.sourceFacetIds[0] ?? 0) - (b.sourceFacetIds[0] ?? 0));
  // A chamfer cone is tried as a cylinder first and honestly fails; once it
  // has been proved as part of a countersink, saying "could not prove this
  // region" about it as well would be a lie of omission's opposite.
  const claimed = new Set(features.flatMap((f) => f.sourceFacetIds));
  const kept = refusals.filter((r) => !r.sourceFacetIds.length || !r.sourceFacetIds.every((id) => claimed.has(id)));
  // WO-1908: pockets are proved AFTER, and apart from, the round features -
  // they read the same welded mesh and planar patches and change nothing above.
  const rectangles = proveRectangularPockets(w, patches, patchLoops, toleranceMm, toSource);
  // WO-1909: slots and drafted pockets, proved after (and apart from) both. A
  // rectangle long enough to be a flat-ended slot is named a slot instead of a
  // pocket; every other rectangle reads exactly as WO-1908 listed it.
  const pockets = rectangles.filter((pocket) => pocket.lengthMm < SLOT_MIN_LENGTH_RATIO * pocket.widthMm);
  const slots = [
    ...rectangles.filter((pocket) => pocket.lengthMm >= SLOT_MIN_LENGTH_RATIO * pocket.widthMm).map(flatEndedSlot),
    ...proveRoundEndedSlots(w, patches, patchLoops, toleranceMm, toSource),
  ].sort((a, b) => (a.sourceFacetIds[0] ?? 0) - (b.sourceFacetIds[0] ?? 0));
  const draftedPockets = proveDraftedPockets(w, patches, patchLoops, toleranceMm, toSource);
  // A wall region the round pass refused and a slot or drafted pocket then
  // proved is not "could not prove": same rule as a chamfer claimed above.
  const shaped = new Set([...slots, ...draftedPockets].flatMap((found) => found.sourceFacetIds));
  const stillRefused = shaped.size
    ? kept.filter((r) => !r.sourceFacetIds.length || !r.sourceFacetIds.every((id) => shaped.has(id)))
    : kept;
  return {
    features,
    pockets,
    slots,
    draftedPockets,
    refusals: stillRefused,
    toleranceMm,
    facetCount: w.facetCount,
    crackWeldsClosed: w.crackWelds,
    ambiguousCrackWelds: w.ambiguousWelds,
  };

  // ---- helpers ------------------------------------------------------------

  function isDisk(patch: number, end: CylinderEnd): boolean {
    const loops = patchLoops[patch];
    return loops.length === 1 && ringKey(loops[0]) === ringKey(end.vertexIds);
  }

  function coneOpensToFace(cone: Cone): boolean {
    const facets = neighbourFacets(w, new Set(cone.facets), new Set(cone.outerRing));
    if (!facets.length) return false;
    const patch = patchOf[facets[0]];
    return patch >= 0 && facets.every((f) => patchOf[f] === patch);
  }

  /** Assemble all ring-connected inward walls, with no wall/step-count limit.
   * Each terminal must be a proved outside opening or a disk floor. Every
   * shoulder is an annulus with exactly the two rings it actually connects.
   * Return no partial profile when one transition cannot be proved. */
  function assembleHoleStack(seedIndex: number): { walls: number[]; cones: Cone[]; support: number[]; floors: number; coneOpenings: number } | undefined {
    const members = new Set<number>([seedIndex]);
    const pending = [seedIndex];
    const cones = new Map<string, Cone>();
    const support = new Set<number>();
    let openings = 0, floors = 0, coneOpenings = 0;
    const partnerAtRing = (wall: number, ring: readonly number[]) => {
      const key = ringKey(ring);
      const matches = walls.flatMap((candidate, j) => {
        if (j === wall || candidate.surface.materialSide !== 'inward' ||
            !collinearAxes(walls[wall].surface, candidate.surface, toleranceMm)) return [];
        return candidate.ends.filter(end => ringKey(end.vertexIds) === key).map(() => j);
      });
      return matches.length === 1 ? matches[0] : undefined;
    };
    const connect = (j: number) => {
      if (consumed.has(j)) return false;
      if (!members.has(j)) { members.add(j); pending.push(j); }
      return true;
    };
    const traceEnd = (wallIndex: number, side: 0 | 1): boolean => {
      const wall = walls[wallIndex];
      let ring: readonly number[] = wall.ends[side].vertexIds;
      let previous: readonly number[] = wall.facets;
      const visited = new Set<number>();
      const crossCone = (atRing: readonly number[], neighbours: readonly number[]): boolean => {
        if (!neighbours.length) return false;
        const region = regionOf[neighbours[0]];
        if (region < 0 || visited.has(region) || !neighbours.every(f => regionOf[f] === region)) return false;
        visited.add(region);
        const band = regions[region];
        const single = proveCone(band, wall, atRing);
        let chain = single.status === 'cone' ? [single.cone]
          : splitMergedRegions ? bandedConeStack(band, wall, atRing) : undefined;
        // WO-2080's tight-budget small entry chamfer remains a whole-facet
        // proof, restricted to a cone actually opening onto the host face.
        if (!chain && single.status === 'no' && single.reason === 'insufficient-radius-change') {
          const small = proveCone(band, wall, atRing, toleranceMm / 2);
          if (small.status === 'cone' && coneOpensToFace(small.cone)) chain = [small.cone];
        }
        if (!chain) return false;
        for (const cone of chain) cones.set(ringKey(cone.facets), cone);
        const last = chain[chain.length - 1];
        ring = last.outerRing;
        previous = last.facets;
        return true;
      };
      while (true) {
        const direct = partnerAtRing(wallIndex, ring);
        if (direct !== undefined) return connect(direct);
        const neighbours = neighbourFacets(w, new Set(previous), new Set(ring));
        if (!neighbours.length) return false;
        const patch = patchOf[neighbours[0]];
        if (patch >= 0 && neighbours.every(f => patchOf[f] === patch)) {
          const station = dot(sub(vertexAt(w, ring[0]), wall.surface.origin), wall.surface.axis);
          if (!patches[patch].every(f => facetPoints(w, f).every(p =>
            Math.abs(dot(sub(p, wall.surface.origin), wall.surface.axis) - station) <= toleranceMm))) return false;
          const signs = neighbours.map(f => dot(facetNormal(w, f), wall.surface.axis));
          if (signs.some(s => s === 0)) return false;
          const loops = patchLoops[patch];
          const key = ringKey(ring);
          if (!loops.some(loop => ringKey(loop) === key)) return false;
          if (loops.length === 2) {
            const other = loops.find(loop => ringKey(loop) !== key);
            const partner = other && partnerAtRing(wallIndex, other);
            if (partner !== undefined) {
              if (!connect(partner)) return false;
              for (const f of patches[patch]) support.add(f);
              return true;
            }
            // WO-2804: an annular shoulder can meet a cone directly. Trace
            // its other ring through the SAME whole-facet/coaxial proof as a
            // wall/cone seam; axis alignment alone never joins two openings.
            if (other && crossCone(other, neighbourFacets(w, new Set(patches[patch]), new Set(other)))) {
              for (const f of patches[patch]) support.add(f);
              continue;
            }
          }
          // Same endpoint/flatness proof as endContext. A shoulder leading to
          // another bore was consumed above, regardless of its normal sign.
          const away = signs.every(s => side === 0 ? s < 0 : s > 0);
          const toward = signs.every(s => side === 0 ? s > 0 : s < 0);
          if (away) { openings++; if (previous !== wall.facets) coneOpenings++; return true; }
          if (toward && loops.length === 1) {
            floors++;
            for (const f of patches[patch]) support.add(f);
            return true;
          }
          return false;
        }
        if (!crossCone(ring, neighbours)) return false;
      }
    };
    for (let p = 0; p < pending.length; p++) {
      const wall = pending[p];
      if (!traceEnd(wall, 0) || !traceEnd(wall, 1)) return undefined;
    }
    if (openings < 1 || openings + floors !== 2) return undefined;
    return { walls: [...members], cones: [...cones.values()], support: [...support], floors, coneOpenings };
  }

  /**
   * Turn a proved wall set (plus any cone bands and a floor/cap/shoulder
   * patch) into a listed feature - AFTER the corridor between its outermost
   * ends is proved clear. Returns undefined when it is not.
   */
  function buildComposite(
    wallIndices: number[],
    cones: Cone[],
    disk: readonly number[],
    kind: RecognizedFeature['kind'],
  ): RecognizedFeature | undefined {
    // Preserve the established counterbore seed/station frame for existing
    // consumers and serialized recognition baselines. Complete support does
    // not require changing that frame to whichever pilot was visited first.
    const seed = walls[kind === 'counterbore' ? wallIndices.reduce((a, b) =>
      walls[b].surface.radiusMm > walls[a].surface.radiusMm ? b : a) : wallIndices[0]];
    const axis = seed.surface.axis;
    const origin = seed.surface.origin;
    const station = (point: Vec3) => dot(sub(point, origin), axis);

    const bands: FeatureBand[] = [];
    for (const index of wallIndices) {
      const wall = walls[index];
      const stations = [station(ringPoint(wall.ends[0])), station(ringPoint(wall.ends[1]))].sort((a, b) => a - b);
      bands.push({
        surface: 'cylinder',
        diameterMm: wall.surface.radiusMm * 2,
        axialRangeMm: [stations[0], stations[1]],
        maxDeviationMm: wall.inspection.maxDeviationMm,
        sourceFacetIds: toSource(wall.facets),
      });
    }
    for (const cone of cones) {
      const inner = station(ringPoint({ vertexIds: cone.innerRing } as CylinderEnd));
      const outer = station(ringPoint({ vertexIds: cone.outerRing } as CylinderEnd));
      const lowStation = Math.min(inner, outer);
      const highStation = Math.max(inner, outer);
      // Each fitted wall/cone has its OWN origin and possibly reversed axis.
      // Convert the composite station to that cone's frame before evaluating
      // its radius; another wall's station is not interchangeable (WO-2804).
      const radiusAt = (s: number) => {
        const coneStation = dot(sub(origin, cone.surface.origin), cone.surface.axis) + s * dot(axis, cone.surface.axis);
        return cone.surface.radiusMm + cone.surface.radialSlope * (coneStation - cone.surface.referenceStationMm);
      };
      bands.push({
        surface: 'cone',
        diameterMm: Math.abs(radiusAt(lowStation)) * 2,
        endDiameterMm: Math.abs(radiusAt(highStation)) * 2,
        includedAngleDeg: 2 * Math.atan(Math.abs(cone.surface.radialSlope)) * (180 / Math.PI),
        axialRangeMm: [lowStation, highStation],
        maxDeviationMm: cone.inspection.maxDeviationMm,
        sourceFacetIds: toSource(cone.facets),
      });
    }
    bands.sort((a, b) => a.axialRangeMm[0] - b.axialRangeMm[0]);

    const supportFacets = new Set<number>();
    for (const index of wallIndices) for (const f of walls[index].facets) supportFacets.add(f);
    for (const cone of cones) for (const f of cone.facets) supportFacets.add(f);
    for (const f of disk) supportFacets.add(f);

    const lowStation = Math.min(...bands.map((b) => b.axialRangeMm[0]));
    const highStation = Math.max(...bands.map((b) => b.axialRangeMm[1]));
    const radii = wallIndices.map((index) => walls[index].surface.radiusMm);
    const deviation = Math.max(...bands.map((b) => b.maxDeviationMm));
    const coreRadiusMm = roundDown(Math.min(...radii) - deviation);
    if (!(coreRadiusMm > 0)) return undefined;
    const envelopeRadiusMm = Math.max(...radii, ...bands.map((b) => Math.max(b.diameterMm, b.endDiameterMm ?? 0) / 2)) + deviation;
    const obstruction = corridorObstructions(
      w,
      origin,
      axis,
      lowStation,
      highStation,
      coreRadiusMm,
      envelopeRadiusMm,
      supportFacets,
    );
    if (obstruction.length) return undefined;

    const diameters = bands.flatMap((b) => (b.surface === 'cone' ? [b.diameterMm, b.endDiameterMm as number] : [b.diameterMm]));
    const functional = kind === 'boss' ? Math.max(...radii) * 2 : Math.min(...radii) * 2;
    const sourceIds = toSource([...supportFacets]);
    return {
      id: `${kind}-${sourceIds[0] ?? 0}`,
      kind,
      axis: { origin, direction: axis },
      diameterMm: functional,
      diametersMm: diameters,
      depthMm: highStation - lowStation,
      maxDeviationMm: deviation,
      bands,
      sourceFacetIds: sourceIds,
      ...(kind === 'boss' ? {} : { coreRadiusMm }),
    };
  }

  function ringPoint(end: Pick<CylinderEnd, 'vertexIds'>): Vec3 {
    return vertexAt(w, end.vertexIds[0]);
  }
}

/** Facets outside `region` sharing a boundary edge whose BOTH ends are in `ring`. */
function neighbourFacets(w: WeldedMesh, region: ReadonlySet<number>, ring: ReadonlySet<number>): number[] {
  const out = new Set<number>();
  for (const edge of w.edges) {
    if (edge.facets.length !== 2) continue;
    if (!ring.has(edge.a) || !ring.has(edge.b)) continue;
    const inside = edge.facets.filter((f) => region.has(f));
    if (inside.length !== 1) continue;
    out.add(edge.facets.find((f) => !region.has(f)) as number);
  }
  return [...out].sort((a, b) => a - b);
}

/** Do these two cylinders share one axis LINE (parallel, and each origin on
 *  the other's axis) within tolerance? */
function collinearAxes(a: CylinderSurface, b: CylinderSurface, toleranceMm: number): boolean {
  if (1 - Math.abs(dot(a.axis, b.axis)) > 1e-6) return false;
  const d = sub(b.origin, a.origin);
  const along = dot(d, a.axis);
  const perpendicular = length([d[0] - along * a.axis[0], d[1] - along * a.axis[1], d[2] - along * a.axis[2]]);
  return perpendicular <= toleranceMm;
}

// ---- WO-1908: rectangular pockets -----------------------------------------
//
// The same kind of proof a hole gets, for the box a pocket is:
//   1. the floor is ONE flat patch whose only boundary is a rectangle - every
//      boundary vertex within tolerance of it, opposite sides and diagonals
//      equal within tolerance. A floor with an island has a second boundary
//      and is not this family;
//   2. across every edge of that rectangle stands a wall: facets lying WHOLE
//      within tolerance of one side's plane, rising from the floor, facing
//      into the pocket. A drafted or curved wall leaves that band and the
//      pocket is not listed;
//   3. the walls close between exactly two rings - the floor's and a rim ring
//      at one height above it - and every facet across the rim ring is flat
//      at that height and faces the floor's way: the face the pocket is cut
//      down from;
//   4. nothing else of the part reaches into the box the four walls enclose.
// Fail any one and nothing is listed. The fit error is measured and stated.

type Point2 = [number, number];

function proveRectangularPockets(
  w: WeldedMesh,
  patches: readonly number[][],
  patchLoops: readonly number[][][],
  toleranceMm: number,
  toSource: (facets: readonly number[]) => number[],
): RecognizedPocket[] {
  const pockets: RecognizedPocket[] = [];
  for (let patch = 0; patch < patches.length; patch++) {
    const loops = patchLoops[patch];
    if (loops.length !== 1 || loops[0].length < 4) continue;
    const pocket = pocketOnFloor(w, patches[patch], loops[0], toleranceMm, toSource);
    if (pocket) pockets.push(pocket);
  }
  return pockets.sort((a, b) => (a.sourceFacetIds[0] ?? 0) - (b.sourceFacetIds[0] ?? 0));
}

function pocketOnFloor(
  w: WeldedMesh,
  floorFacets: readonly number[],
  loop: readonly number[],
  toleranceMm: number,
  toSource: (facets: readonly number[]) => number[],
): RecognizedPocket | undefined {
  // The floor plane: its area-weighted normal, through its boundary's centroid.
  let summed: Vec3 = [0, 0, 0];
  for (const f of floorFacets) summed = add(summed, scale(facetNormal(w, f), w.areas[f]));
  const normal = normalize(summed);
  if (length(normal) === 0) return undefined;
  const origin = scale(loop.reduce<Vec3>((sum, i) => add(sum, vertexAt(w, i)), [0, 0, 0]), 1 / loop.length);
  const { u, v } = axisFrame(normal);
  const height = (p: Vec3): number => dot(sub(p, origin), normal);
  const flat = (p: Vec3): Point2 => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  };

  // 1. a rectangle, and a flat one
  const rectangle = rectangleOf(loop.map((i) => flat(vertexAt(w, i))), toleranceMm);
  if (!rectangle) return undefined;
  let deviationMm = rectangle.deviationMm;
  for (const f of floorFacets) {
    for (const p of facetPoints(w, f)) deviationMm = Math.max(deviationMm, Math.abs(height(p)));
  }
  if (deviationMm > toleranceMm) return undefined;
  const corners = rectangle.corners;
  const sides = corners.map((a, k) => {
    const b = corners[(k + 1) % 4];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const along: Point2 = [(b[0] - a[0]) / run, (b[1] - a[1]) / run];
    // counter-clockwise, so the pocket's inside is on the LEFT of every side
    return { a, b, run, along, inward: [-along[1], along[0]] as Point2 };
  });

  // 2. walls. A facet is wall when it lies whole within tolerance of ONE
  // side's plane, at or above the floor, and faces into the pocket.
  const floorSet = new Set(floorFacets);
  const wallDeviation = (f: number): number | undefined => {
    const n = facetNormal(w, f);
    if (Math.abs(dot(n, normal)) > 0.5) return undefined;
    const points = facetPoints(w, f);
    if (points.some((p) => height(p) < -toleranceMm)) return undefined;
    const projected = points.map(flat);
    const facing: Point2 = [dot(n, u), dot(n, v)];
    for (const side of sides) {
      const off = Math.max(...projected.map((q) => segmentDistance(q, side.a, side.b)));
      if (off <= toleranceMm && facing[0] * side.inward[0] + facing[1] * side.inward[1] > 0) return off;
    }
    return undefined;
  };
  const walls = new Set<number>();
  const pending: number[] = [];
  const admit = (f: number): boolean => {
    const off = wallDeviation(f);
    if (off === undefined) return false;
    deviationMm = Math.max(deviationMm, off);
    walls.add(f);
    pending.push(f);
    return true;
  };
  for (const f of floorFacets) {
    for (let k = 0; k < 3; k++) {
      const edge = w.edges[w.facetEdges[f * 3 + k]];
      if (edge.facets.length !== 2) return undefined;
      const across = edge.facets.find((g) => !floorSet.has(g));
      if (across === undefined || walls.has(across)) continue;
      // every edge of the floor's rectangle must have a wall standing on it
      if (!admit(across)) return undefined;
    }
  }
  while (pending.length) {
    const f = pending.pop() as number;
    for (let k = 0; k < 3; k++) {
      for (const g of w.edges[w.facetEdges[f * 3 + k]].facets) {
        if (g !== f && !floorSet.has(g) && !walls.has(g)) admit(g);
      }
    }
  }

  // 3. the walls close between the floor ring and ONE rim ring at one height,
  // and the face across that rim is flat there and faces the floor's way.
  const rings = boundaryCycles(regionBoundaryEdges(w, walls));
  if (rings.ambiguous.length || rings.loops.length !== 2) return undefined;
  const floorRing = rings.loops.findIndex((ring) => ringKey(ring) === ringKey(loop));
  if (floorRing < 0) return undefined;
  const rim = rings.loops[1 - floorRing];
  const rimHeights = rim.map((i) => height(vertexAt(w, i)));
  const depthMm = rimHeights.reduce((sum, h) => sum + h, 0) / rimHeights.length;
  if (!(depthMm > 2 * toleranceMm)) return undefined;
  for (const h of rimHeights) deviationMm = Math.max(deviationMm, Math.abs(h - depthMm));
  for (const f of walls) {
    for (const p of facetPoints(w, f)) {
      if (height(p) > depthMm + toleranceMm) return undefined;
    }
  }
  const rimFace = neighbourFacets(w, walls, new Set(rim));
  if (!rimFace.length) return undefined;
  for (const f of rimFace) {
    if (dot(facetNormal(w, f), normal) <= 0) return undefined;
    for (const p of facetPoints(w, f)) deviationMm = Math.max(deviationMm, Math.abs(height(p) - depthMm));
  }
  if (deviationMm > toleranceMm) return undefined;

  // 4. the box is clear. Measured in the rectangle's own frame, inset by the
  // tolerance so the floor, walls and rim that bound it never count.
  const lengths = sides.map((side) => side.run);
  const firstCorner = corners[0];
  const boxFrame = (p: Vec3): Vec3 => {
    const q = flat(p);
    const d: Point2 = [q[0] - firstCorner[0], q[1] - firstCorner[1]];
    return [
      d[0] * sides[0].along[0] + d[1] * sides[0].along[1],
      d[0] * sides[0].inward[0] + d[1] * sides[0].inward[1],
      height(p),
    ];
  };
  const box: Array<[number, number]> = [
    [toleranceMm, lengths[0] - toleranceMm],
    [toleranceMm, lengths[3] - toleranceMm],
    [toleranceMm, depthMm - toleranceMm],
  ];
  for (let f = 0; f < w.facetCount; f++) {
    if (floorSet.has(f) || walls.has(f)) continue;
    let polygon: Vec3[] = facetPoints(w, f).map(boxFrame);
    for (let axis = 0; axis < 3 && polygon.length; axis++) {
      polygon = clipPolygon(polygon, axis, box[axis][0], true);
      polygon = clipPolygon(polygon, axis, box[axis][1], false);
    }
    if (polygon.length) return undefined;
  }

  const inSpace = (q: Point2): Vec3 => add(origin, add(scale(u, q[0]), scale(v, q[1])));
  const alongFirst = (lengths[0] + lengths[2]) / 2;
  const alongSecond = (lengths[1] + lengths[3]) / 2;
  const sourceFacetIds = toSource([...floorFacets, ...walls]);
  return {
    id: `rectangular-pocket-${sourceFacetIds[0] ?? 0}`,
    kind: 'rectangular-pocket',
    floorNormal: normal,
    corners: corners.map(inSpace) as [Vec3, Vec3, Vec3, Vec3],
    lengthMm: Math.max(alongFirst, alongSecond),
    widthMm: Math.min(alongFirst, alongSecond),
    depthMm,
    maxDeviationMm: deviationMm,
    floorSourceFacetIds: toSource(floorFacets),
    sourceFacetIds,
  };
}

/**
 * The four corners of the rectangle a closed outline IS, counter-clockwise, or
 * undefined. A vertex sitting on the straight line between its neighbours (a
 * side an exporter wrote in pieces) is dropped, flattest first, while it stays
 * within tolerance of that line. Exactly four corners must survive, opposite
 * sides and both diagonals must agree within tolerance, and EVERY original
 * vertex must lie within tolerance of the rectangle - so a corner rounded
 * tighter than the tolerance reads as the corner it rounds, and one rounded
 * wider than that is not a rectangle.
 */
function rectangleOf(
  outline: readonly Point2[],
  toleranceMm: number,
): { corners: Point2[]; deviationMm: number } | undefined {
  if (outline.length < 4) return undefined;
  let twiceArea = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  const kept = twiceArea > 0 ? [...outline] : [...outline].reverse();
  while (kept.length > 4) {
    let flattest = -1;
    let least = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const off = segmentDistance(kept[i], kept[(i + kept.length - 1) % kept.length], kept[(i + 1) % kept.length]);
      if (off < least) {
        least = off;
        flattest = i;
      }
    }
    if (least > toleranceMm) break;
    kept.splice(flattest, 1);
  }
  if (kept.length !== 4) return undefined;
  const gap = (a: Point2, b: Point2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const sides = kept.map((a, i) => gap(a, kept[(i + 1) % 4]));
  if (Math.min(...sides) <= 2 * toleranceMm) return undefined;
  if (Math.abs(sides[0] - sides[2]) > toleranceMm || Math.abs(sides[1] - sides[3]) > toleranceMm) return undefined;
  if (Math.abs(gap(kept[0], kept[2]) - gap(kept[1], kept[3])) > toleranceMm) return undefined;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [kept[i], kept[(i + 1) % 4], kept[(i + 2) % 4]];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return undefined;
  }
  let deviationMm = 0;
  for (const p of outline) {
    deviationMm = Math.max(deviationMm, Math.min(...kept.map((a, i) => segmentDistance(p, a, kept[(i + 1) % 4]))));
  }
  return deviationMm > toleranceMm ? undefined : { corners: kept, deviationMm };
}

function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** One Sutherland-Hodgman step: keep the part of `polygon` on one side of
 *  `coordinate[axis] = bound`. An empty result means nothing is left. */
function clipPolygon(polygon: readonly Vec3[], axis: number, bound: number, keepAbove: boolean): Vec3[] {
  const inside = (p: Vec3): boolean => (keepAbove ? p[axis] >= bound : p[axis] <= bound);
  const out: Vec3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (inside(p)) out.push(p);
    if (inside(p) !== inside(q)) {
      const t = (bound - p[axis]) / (q[axis] - p[axis]);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
    }
  }
  return out;
}

// ---- WO-1909: slots and drafted pockets ------------------------------------
//
// Two more cavity families, proved the way WO-1908 proves a rectangular pocket
// and sharing its last two steps (`closeCavity`, `cavityObstructed`):
//   - a ROUND-ENDED SLOT: one flat floor whose only boundary is a stadium -
//     every point of it, vertices and chord midpoints alike, at one distance
//     (half the width) from one straight centre segment - with walls standing
//     square on that outline. A flat-ended slot is WO-1908's rectangle, long
//     enough (`flatEndedSlot`);
//   - a DRAFTED POCKET: WO-1908's rectangular floor, but each wall is a plane
//     through its side of the floor LEANING by its own angle, read from the
//     facet standing on that side and then demanded of every facet on it. If
//     every wall stands square it is WO-1908's pocket and is not listed here.
// `pocketOnFloor` above is deliberately left as it was.

interface FloorFrame {
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  height: (p: Vec3) => number;
  flat: (p: Vec3) => Point2;
  inSpace: (q: Point2) => Vec3;
}

/** The floor plane - area-weighted normal through the boundary's centroid -
 *  with the floor's worst deviation from it, or undefined. */
function floorFrameOf(
  w: WeldedMesh,
  floorFacets: readonly number[],
  loop: readonly number[],
): { frame: FloorFrame; flatnessMm: number } | undefined {
  let summed: Vec3 = [0, 0, 0];
  for (const f of floorFacets) summed = add(summed, scale(facetNormal(w, f), w.areas[f]));
  const normal = normalize(summed);
  if (length(normal) === 0) return undefined;
  const origin = scale(loop.reduce<Vec3>((sum, i) => add(sum, vertexAt(w, i)), [0, 0, 0]), 1 / loop.length);
  const { u, v } = axisFrame(normal);
  const height = (p: Vec3): number => dot(sub(p, origin), normal);
  const flat = (p: Vec3): Point2 => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  const inSpace = (q: Point2): Vec3 => add(origin, add(scale(u, q[0]), scale(v, q[1])));
  let flatnessMm = 0;
  for (const f of floorFacets) {
    for (const p of facetPoints(w, f)) flatnessMm = Math.max(flatnessMm, Math.abs(height(p)));
  }
  return { frame: { normal, u, v, height, flat, inSpace }, flatnessMm };
}

/**
 * Steps 2 and 3 of WO-1908's proof, for any outline: every facet across the
 * floor boundary must be wall (`wallDeviation` says whether a facet lies whole
 * on the wall, and how far off), walls grow over every neighbour that is wall
 * too, and they must close between exactly the floor ring and one rim ring at
 * one height, across which the part is flat and faces the floor's way.
 */
function closeCavity(
  w: WeldedMesh,
  floorFacets: readonly number[],
  loop: readonly number[],
  frame: FloorFrame,
  toleranceMm: number,
  wallDeviation: (f: number) => number | undefined,
): { walls: Set<number>; depthMm: number; deviationMm: number } | undefined {
  const { normal, height } = frame;
  let deviationMm = 0;
  const floorSet = new Set(floorFacets);
  const walls = new Set<number>();
  const pending: number[] = [];
  const admit = (f: number): boolean => {
    const off = wallDeviation(f);
    if (off === undefined) return false;
    deviationMm = Math.max(deviationMm, off);
    walls.add(f);
    pending.push(f);
    return true;
  };
  for (const f of floorFacets) {
    for (let k = 0; k < 3; k++) {
      const edge = w.edges[w.facetEdges[f * 3 + k]];
      if (edge.facets.length !== 2) return undefined;
      const across = edge.facets.find((g) => !floorSet.has(g));
      if (across === undefined || walls.has(across)) continue;
      if (!admit(across)) return undefined;
    }
  }
  while (pending.length) {
    const f = pending.pop() as number;
    for (let k = 0; k < 3; k++) {
      for (const g of w.edges[w.facetEdges[f * 3 + k]].facets) {
        if (g !== f && !floorSet.has(g) && !walls.has(g)) admit(g);
      }
    }
  }

  const rings = boundaryCycles(regionBoundaryEdges(w, walls));
  if (rings.ambiguous.length || rings.loops.length !== 2) return undefined;
  const floorRing = rings.loops.findIndex((ring) => ringKey(ring) === ringKey(loop));
  if (floorRing < 0) return undefined;
  const rim = rings.loops[1 - floorRing];
  const rimHeights = rim.map((i) => height(vertexAt(w, i)));
  const depthMm = rimHeights.reduce((sum, h) => sum + h, 0) / rimHeights.length;
  if (!(depthMm > 2 * toleranceMm)) return undefined;
  for (const h of rimHeights) deviationMm = Math.max(deviationMm, Math.abs(h - depthMm));
  for (const f of walls) {
    for (const p of facetPoints(w, f)) {
      if (height(p) > depthMm + toleranceMm) return undefined;
    }
  }
  const rimFace = neighbourFacets(w, walls, new Set(rim));
  if (!rimFace.length) return undefined;
  for (const f of rimFace) {
    if (dot(facetNormal(w, f), normal) <= 0) return undefined;
    for (const p of facetPoints(w, f)) deviationMm = Math.max(deviationMm, Math.abs(height(p) - depthMm));
  }
  return { walls, depthMm, deviationMm };
}

/** Step 4 for any cavity: does any facet other than floor and walls reach into
 *  the open space? `inside` says whether any part of a facet (file-frame
 *  triangle) lies inside that space, inset by the tolerance. */
function cavityObstructed(
  w: WeldedMesh,
  floorFacets: readonly number[],
  walls: ReadonlySet<number>,
  inside: (polygon: Vec3[]) => boolean,
): boolean {
  const floorSet = new Set(floorFacets);
  for (let f = 0; f < w.facetCount; f++) {
    if (floorSet.has(f) || walls.has(f)) continue;
    if (inside(facetPoints(w, f))) return true;
  }
  return false;
}

/** Sutherland-Hodgman against one half-space: keep where `side(p) <= 0`,
 *  `side` affine in p. */
function clipByPlane(polygon: readonly Vec3[], side: (p: Vec3) => number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    const sp = side(p);
    const sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp <= 0) !== (sq <= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
    }
  }
  return out;
}

// ---- round-ended slots -----------------------------------------------------

function proveRoundEndedSlots(
  w: WeldedMesh,
  patches: readonly number[][],
  patchLoops: readonly number[][][],
  toleranceMm: number,
  toSource: (facets: readonly number[]) => number[],
): RecognizedSlot[] {
  const slots: RecognizedSlot[] = [];
  for (let patch = 0; patch < patches.length; patch++) {
    const loops = patchLoops[patch];
    if (loops.length !== 1 || loops[0].length < 6) continue;
    const slot = roundSlotOnFloor(w, patches[patch], loops[0], toleranceMm, toSource);
    if (slot) slots.push(slot);
  }
  return slots;
}

/** The centre segment and half-width of the stadium a closed outline IS, or
 *  undefined. The axis is the outline's own principal axis (its area second
 *  moments); the half-width is half its extent across that axis; the segment
 *  ends sit one half-width in from its extent along it. Then EVERY vertex and
 *  every chord midpoint must lie within tolerance of that half-width from the
 *  segment - a rectangle's corners, a corner rounded tighter than half the
 *  width, or a plain circle all fail here. */
function stadiumOf(
  outline: readonly Point2[],
  toleranceMm: number,
): { ends: [Point2, Point2]; radius: number; deviationMm: number } | undefined {
  const n = outline.length;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  let ixx = 0;
  let iyy = 0;
  let ixy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    const c = x0 * y1 - x1 * y0;
    twiceArea += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
    ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c;
    iyy += (y0 * y0 + y0 * y1 + y1 * y1) * c;
    ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
  }
  const area = twiceArea / 2;
  if (Math.abs(area) < toleranceMm * toleranceMm) return undefined;
  cx /= 6 * area;
  cy /= 6 * area;
  const sxx = ixx / 12 - area * cx * cx;
  const syy = iyy / 12 - area * cy * cy;
  const sxy = ixy / 24 - area * cx * cy;
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: Point2 = [Math.cos(angle), Math.sin(angle)];
  const e: Point2 = [-d[1], d[0]];
  let sMin = Infinity; let sMax = -Infinity; let tMin = Infinity; let tMax = -Infinity;
  for (const [x, y] of outline) {
    const s = (x - cx) * d[0] + (y - cy) * d[1];
    const t = (x - cx) * e[0] + (y - cy) * e[1];
    sMin = Math.min(sMin, s); sMax = Math.max(sMax, s);
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  const radius = (tMax - tMin) / 2;
  const tMid = (tMax + tMin) / 2;
  const sLow = sMin + radius;
  const sHigh = sMax - radius;
  if (!(radius > toleranceMm) || !(sHigh - sLow > 2 * toleranceMm)) return undefined;
  const at = (s: number): Point2 => [cx + d[0] * s + e[0] * tMid, cy + d[1] * s + e[1] * tMid];
  const ends: [Point2, Point2] = [at(sLow), at(sHigh)];
  let deviationMm = 0;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % n];
    const mid: Point2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    deviationMm = Math.max(
      deviationMm,
      Math.abs(segmentDistance(p, ends[0], ends[1]) - radius),
      Math.abs(segmentDistance(mid, ends[0], ends[1]) - radius),
    );
    perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  if (deviationMm > toleranceMm) return undefined;
  // and it goes all the way round: the area of a stadium, not a part of one
  const stadiumArea = 2 * radius * (sHigh - sLow) + Math.PI * radius * radius;
  if (Math.abs(Math.abs(area) - stadiumArea) > toleranceMm * perimeter) return undefined;
  return { ends, radius, deviationMm };
}

function roundSlotOnFloor(
  w: WeldedMesh,
  floorFacets: readonly number[],
  loop: readonly number[],
  toleranceMm: number,
  toSource: (facets: readonly number[]) => number[],
): RecognizedSlot | undefined {
  const floor = floorFrameOf(w, floorFacets, loop);
  if (!floor || floor.flatnessMm > toleranceMm) return undefined;
  const { frame } = floor;
  const { normal, u, v, height, flat } = frame;

  // 1. a stadium, and a flat one
  const stadium = stadiumOf(loop.map((i) => flat(vertexAt(w, i))), toleranceMm);
  if (!stadium) return undefined;
  const [endA, endB] = stadium.ends;
  const { radius } = stadium;

  // 2-3. walls stand square on the outline, face into the slot, close at a rim
  const wallDeviation = (f: number): number | undefined => {
    const n = facetNormal(w, f);
    if (Math.abs(dot(n, normal)) > 0.5) return undefined;
    const points = facetPoints(w, f);
    if (points.some((p) => height(p) < -toleranceMm)) return undefined;
    const projected = points.map(flat);
    const samples = [
      ...projected,
      ...projected.map((p, k) => {
        const q = projected[(k + 1) % 3];
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Point2;
      }),
    ];
    const off = Math.max(...samples.map((q) => Math.abs(segmentDistance(q, endA, endB) - radius)));
    if (off > toleranceMm) return undefined;
    // facing into the slot: towards the nearest point of the centre segment
    const centre: Point2 = [
      (projected[0][0] + projected[1][0] + projected[2][0]) / 3,
      (projected[0][1] + projected[1][1] + projected[2][1]) / 3,
    ];
    const nearest = nearestOnSegment(centre, endA, endB);
    const facing: Point2 = [dot(n, u), dot(n, v)];
    if (facing[0] * (nearest[0] - centre[0]) + facing[1] * (nearest[1] - centre[1]) <= 0) return undefined;
    return off;
  };
  const closed = closeCavity(w, floorFacets, loop, frame, toleranceMm, wallDeviation);
  if (!closed) return undefined;
  const { walls, depthMm } = closed;
  const deviationMm = Math.max(stadium.deviationMm, floor.flatnessMm, closed.deviationMm);
  if (deviationMm > toleranceMm) return undefined;

  // 4. the slot is clear: nothing between tolerance and depth-less-tolerance
  // comes within (half-width less tolerance) of the centre segment
  const clearRadius = radius - toleranceMm;
  const obstructed = cavityObstructed(w, floorFacets, walls, (polygon) => {
    let slab = clipByPlane(polygon, (p) => toleranceMm - height(p));
    slab = clipByPlane(slab, (p) => height(p) - (depthMm - toleranceMm));
    if (!slab.length) return false;
    return polygonSegmentDistance(slab.map(flat), endA, endB) < clearRadius;
  });
  if (obstructed) return undefined;

  const sourceFacetIds = toSource([...floorFacets, ...walls]);
  const width = 2 * radius;
  return {
    id: `slot-${sourceFacetIds[0] ?? 0}`,
    kind: 'slot',
    endStyle: 'round',
    floorNormal: normal,
    centerline: [frame.inSpace(endA), frame.inSpace(endB)],
    lengthMm: Math.hypot(endB[0] - endA[0], endB[1] - endA[1]) + width,
    widthMm: width,
    depthMm,
    maxDeviationMm: deviationMm,
    floorSourceFacetIds: toSource(floorFacets),
    sourceFacetIds,
  };
}

/** A proved rectangle long enough to be a slot, restated as one: the
 *  centreline runs down its middle, half a width in from each end wall. */
function flatEndedSlot(pocket: RecognizedPocket): RecognizedSlot {
  const [c0, c1, c2, c3] = pocket.corners;
  const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);
  // the short sides are the end walls
  const [endA, endB] = length(sub(c1, c0)) >= length(sub(c2, c1))
    ? [mid(c3, c0), mid(c1, c2)]
    : [mid(c0, c1), mid(c2, c3)];
  const along = normalize(sub(endB, endA));
  const half = pocket.widthMm / 2;
  return {
    id: `slot-${pocket.sourceFacetIds[0] ?? 0}`,
    kind: 'slot',
    endStyle: 'flat',
    floorNormal: pocket.floorNormal,
    centerline: [add(endA, scale(along, half)), sub(endB, scale(along, half))],
    lengthMm: pocket.lengthMm,
    widthMm: pocket.widthMm,
    depthMm: pocket.depthMm,
    maxDeviationMm: pocket.maxDeviationMm,
    floorSourceFacetIds: pocket.floorSourceFacetIds,
    sourceFacetIds: pocket.sourceFacetIds,
  };
}

function nearestOnSegment(p: Point2, a: Point2, b: Point2): Point2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Least distance between a (possibly degenerate) polygon and a segment:
 *  0 when they cross or the polygon covers the segment. */
function polygonSegmentDistance(polygon: readonly Point2[], a: Point2, b: Point2): number {
  const n = polygon.length;
  const cross2 = (o: Point2, p: Point2, q: Point2): number =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  let least = Infinity;
  for (let i = 0; i < n; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % n];
    const d1 = cross2(a, b, p);
    const d2 = cross2(a, b, q);
    const d3 = cross2(p, q, a);
    const d4 = cross2(p, q, b);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    least = Math.min(
      least,
      segmentDistance(p, a, b),
      segmentDistance(q, a, b),
      segmentDistance(a, p, q),
      segmentDistance(b, p, q),
    );
  }
  // the segment wholly inside the polygon (even-odd test on one end)
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > a[1]) !== (yj > a[1]) && a[0] < ((xj - xi) * (a[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 0 : least;
}

// ---- drafted pockets -------------------------------------------------------

/** A wall leaning further than this from square is not read as a draft. */
const MAX_DRAFT_SLOPE = 1; // tan 45 degrees

function proveDraftedPockets(
  w: WeldedMesh,
  patches: readonly number[][],
  patchLoops: readonly number[][][],
  toleranceMm: number,
  toSource: (facets: readonly number[]) => number[],
): RecognizedDraftedPocket[] {
  const found: RecognizedDraftedPocket[] = [];
  for (let patch = 0; patch < patches.length; patch++) {
    const loops = patchLoops[patch];
    if (loops.length !== 1 || loops[0].length < 4) continue;
    const pocket = draftedPocketOnFloor(w, patches[patch], loops[0], toleranceMm, toSource);
    if (pocket) found.push(pocket);
  }
  return found.sort((a, b) => (a.sourceFacetIds[0] ?? 0) - (b.sourceFacetIds[0] ?? 0));
}

function draftedPocketOnFloor(
  w: WeldedMesh,
  floorFacets: readonly number[],
  loop: readonly number[],
  toleranceMm: number,
  toSource: (facets: readonly number[]) => number[],
): RecognizedDraftedPocket | undefined {
  const floor = floorFrameOf(w, floorFacets, loop);
  if (!floor || floor.flatnessMm > toleranceMm) return undefined;
  const { frame } = floor;
  const { normal, u, v, height, flat } = frame;

  // 1. a rectangle, and a flat one
  const rectangle = rectangleOf(loop.map((i) => flat(vertexAt(w, i))), toleranceMm);
  if (!rectangle) return undefined;
  const corners = rectangle.corners;
  const sides = corners.map((a, k) => {
    const b = corners[(k + 1) % 4];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const along: Point2 = [(b[0] - a[0]) / run, (b[1] - a[1]) / run];
    const inward: Point2 = [-along[1], along[0]];
    return { a, b, run, along, inward, inward3: add(scale(u, inward[0]), scale(v, inward[1])) };
  });

  // 2a. each side's lean, read from the facet standing on its floor edge. A
  // wall plane through the side that moves OUT by `slope` mm per mm of height
  // has a normal whose (up, inward) parts are in the ratio slope : 1.
  const floorSet = new Set(floorFacets);
  const slopes: Array<number | undefined> = [undefined, undefined, undefined, undefined];
  for (const f of floorFacets) {
    for (let k = 0; k < 3; k++) {
      const edge = w.edges[w.facetEdges[f * 3 + k]];
      if (edge.facets.length !== 2) return undefined;
      const across = edge.facets.find((g) => !floorSet.has(g));
      if (across === undefined) continue;
      const [pa, pb] = [flat(vertexAt(w, edge.a)), flat(vertexAt(w, edge.b))];
      const side = sides.findIndex((s) =>
        segmentDistance(pa, s.a, s.b) <= toleranceMm && segmentDistance(pb, s.a, s.b) <= toleranceMm);
      if (side < 0 || slopes[side] !== undefined) continue;
      const n = facetNormal(w, across);
      const inwardPart = dot(n, sides[side].inward3);
      if (!(inwardPart > 0)) return undefined;
      const slope = dot(n, normal) / inwardPart;
      if (Math.abs(slope) > MAX_DRAFT_SLOPE) return undefined;
      slopes[side] = slope;
    }
  }
  if (slopes.some((slope) => slope === undefined)) return undefined;
  const lean = slopes as number[];
  /** how far `p` sits OUTSIDE side k's leaning wall plane, mm across the side */
  const beyond = (k: number, p: Vec3): number => {
    const q = flat(p);
    const side = sides[k];
    return -((q[0] - side.a[0]) * side.inward[0] + (q[1] - side.a[1]) * side.inward[1]) - height(p) * lean[k];
  };

  // 2b-3. a facet is wall when it lies whole within tolerance of ONE side's
  // leaning plane, inside that wall's extent, at or above the floor, facing in
  const wallDeviation = (f: number): number | undefined => {
    const n = facetNormal(w, f);
    const points = facetPoints(w, f);
    if (points.some((p) => height(p) < -toleranceMm)) return undefined;
    for (let k = 0; k < 4; k++) {
      const side = sides[k];
      if (!(dot(n, side.inward3) > 0)) continue;
      const off = Math.max(...points.map((p) => Math.abs(beyond(k, p))));
      if (off > toleranceMm) continue;
      const within = points.every((p) => {
        const q = flat(p);
        const h = height(p);
        const s = (q[0] - side.a[0]) * side.along[0] + (q[1] - side.a[1]) * side.along[1];
        return s >= -h * lean[(k + 3) % 4] - toleranceMm && s <= side.run + h * lean[(k + 1) % 4] + toleranceMm;
      });
      if (within) return off;
    }
    return undefined;
  };
  const closed = closeCavity(w, floorFacets, loop, frame, toleranceMm, wallDeviation);
  if (!closed) return undefined;
  const { walls, depthMm } = closed;
  const deviationMm = Math.max(rectangle.deviationMm, floor.flatnessMm, closed.deviationMm);
  if (deviationMm > toleranceMm) return undefined;
  // every wall square: that is WO-1908's pocket, not a drafted one
  if (lean.every((slope) => Math.abs(slope) * depthMm <= toleranceMm)) return undefined;

  // 4. nothing reaches into the space inside all four leaning walls
  const obstructed = cavityObstructed(w, floorFacets, walls, (polygon) => {
    let clipped = clipByPlane(polygon, (p) => toleranceMm - height(p));
    clipped = clipByPlane(clipped, (p) => height(p) - (depthMm - toleranceMm));
    for (let k = 0; k < 4 && clipped.length; k++) clipped = clipByPlane(clipped, (p) => beyond(k, p) + toleranceMm);
    return clipped.length > 0;
  });
  if (obstructed) return undefined;

  // 5. what a straight cutter can reach: every undercut side pulled in by
  // depth x its overhang. Corner k starts side k and ends side k-1.
  const inset = lean.map((slope) => depthMm * Math.max(0, -slope));
  const clear = corners.map((corner, k) => {
    const previous = (k + 3) % 4;
    return [
      corner[0] + sides[k].inward[0] * inset[k] + sides[previous].inward[0] * inset[previous],
      corner[1] + sides[k].inward[1] * inset[k] + sides[previous].inward[1] * inset[previous],
    ] as Point2;
  });

  const alongFirst = (sides[0].run + sides[2].run) / 2;
  const alongSecond = (sides[1].run + sides[3].run) / 2;
  const sourceFacetIds = toSource([...floorFacets, ...walls]);
  return {
    id: `drafted-pocket-${sourceFacetIds[0] ?? 0}`,
    kind: 'drafted-pocket',
    floorNormal: normal,
    corners: corners.map(frame.inSpace) as [Vec3, Vec3, Vec3, Vec3],
    wallDraftDeg: lean.map((slope) => (Math.atan(slope) * 180) / Math.PI) as [number, number, number, number],
    clearCorners: clear.map(frame.inSpace) as [Vec3, Vec3, Vec3, Vec3],
    lengthMm: Math.max(alongFirst, alongSecond),
    widthMm: Math.min(alongFirst, alongSecond),
    depthMm,
    maxDeviationMm: deviationMm,
    floorSourceFacetIds: toSource(floorFacets),
    sourceFacetIds,
  };
}
