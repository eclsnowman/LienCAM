// WO-3002 (A3-09 step 2): one identity scheme for faces, edges and features.
// Today's 2D loop ids are NOT touched: this scheme applies to new face, edge
// and feature ids only (draft open item, order "Boundaries").
import {
  AREA_QUANTUM_MM2, COORD_QUANTUM_MM, DIRECTION_QUANTUM, assignIds, canonicalAxis, exactText,
  qPoint, quantize, unit, unorderedPair, type P3,
} from './signature'
import type {
  EdgeDescriptor, FaceDescriptor, FeatureCandidate, FeatureGeometry, FeatureSource, IdentifiedEntity,
  PartFeature, PartFeatureList, PartFrame,
} from './types'

const q = (value: number) => quantize(value, COORD_QUANTUM_MM)
const qDir = (direction: P3) => qPoint(unit(direction), DIRECTION_QUANTUM)

export function faceSignature(face: FaceDescriptor): { signature: string; exact: string } {
  const parts = [`face|${face.surface}`, `a:${quantize(face.areaMm2, AREA_QUANTUM_MM2)}`, `c:${qPoint(face.centroid)}`]
  // A plane's normal keeps its sign (it says which side is material); an
  // axis has none, so it is canonicalised.
  if (face.normal) parts.push(`n:${qDir(face.normal)}`)
  if (face.axis) parts.push(`ax:${qPoint(canonicalAxis(face.axis), DIRECTION_QUANTUM)}`)
  return { signature: parts.join('|'), exact: exactText([face.areaMm2, ...face.centroid, ...(face.normal ?? []), ...(face.axis ?? [])]) }
}

/** Length, length-weighted centre and (open edges) unordered ends: none of them
 *  depends on which end the polyline starts from or where a closed one starts. */
export function edgeMeasure(edge: EdgeDescriptor): { lengthMm: number; centroid: P3; ends?: [P3, P3] } {
  const points = edge.points
  if (points.length < 2) throw new RangeError('An edge needs at least two points')
  const segments = edge.closed ? points.length : points.length - 1
  let length = 0
  const sum = [0, 0, 0]
  for (let i = 0; i < segments; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    length += l
    for (let k = 0; k < 3; k++) sum[k] += l * (a[k] + b[k]) / 2
  }
  // A degenerate edge (a sphere pole, a collapsed seam) is known by its point.
  const centroid: P3 = length > 0 ? [sum[0] / length, sum[1] / length, sum[2] / length] : points[0]
  return edge.closed ? { lengthMm: length, centroid } : { lengthMm: length, centroid, ends: unorderedPair(points[0], points[points.length - 1]) }
}

export function edgeSignature(edge: EdgeDescriptor): { signature: string; exact: string } {
  const { lengthMm, centroid, ends } = edgeMeasure(edge)
  const parts = [`edge|${edge.closed ? 'closed' : 'open'}`, `L:${q(lengthMm)}`, `m:${qPoint(centroid)}`]
  if (ends) parts.push(`e:${qPoint(ends[0])};${qPoint(ends[1])}`)
  return { signature: parts.join('|'), exact: exactText([lengthMm, ...centroid, ...(ends ? [...ends[0], ...ends[1]] : [])]) }
}

export function geometrySignature(geometry: FeatureGeometry): { signature: string; exact: string } {
  switch (geometry.kind) {
    // Every measured diameter is part of the id (a counterbore resized at its
    // major diameter is new geometry, audit F1). Sorted, so sources that list
    // bands in different orders agree. The band profile carries every station
    // and every diameter at it (a moved shoulder is new geometry, audit F2).
    case 'axial': {
      const diameters = geometry.diametersMm.slice().sort((a, b) => b - a)
      const bands = geometry.bands.map(b => `${b.surface === 'cone' ? 'k' : 'c'}${q(b.stationsMm[0])},${q(b.stationsMm[1])},${q(b.diametersMm[0])},${q(b.diametersMm[1])}`)
      return {
        signature: `axial|p:${qPoint(geometry.axisPoint)}|d:${qPoint(geometry.direction, DIRECTION_QUANTUM)}` +
          `|s:${q(geometry.stationsMm[0])},${q(geometry.stationsMm[1])}|D:${q(geometry.diameterMm)}|Ds:${diameters.map(q).join(',')}|b:${bands.join(';')}`,
        exact: exactText([...geometry.axisPoint, ...geometry.direction, ...geometry.stationsMm, geometry.diameterMm, ...diameters,
          ...geometry.bands.flatMap(b => [...b.stationsMm, ...b.diametersMm])]),
      }
    }
    case 'region': return {
      signature: `region|c:${qPoint(geometry.centroid)}${geometry.normal ? `|n:${qDir(geometry.normal)}` : ''}|z:${geometry.sizeMm.map(q).join(',')}` +
        (geometry.areaMm2 === undefined ? '' : `|a:${quantize(geometry.areaMm2, AREA_QUANTUM_MM2)}`) +
        (geometry.outline === undefined ? '' : `|o:${geometry.outline.map(p => qPoint(p)).join(';')}`),
      exact: exactText([...geometry.centroid, ...(geometry.normal ?? []), ...geometry.sizeMm, ...(geometry.areaMm2 === undefined ? [] : [geometry.areaMm2]),
        ...(geometry.outline ?? []).flat()]),
    }
    case 'line': return {
      signature: `line|e:${qPoint(geometry.ends[0])};${qPoint(geometry.ends[1])}|z:${geometry.sizeMm.map(q).join(',')}`,
      exact: exactText([...geometry.ends[0], ...geometry.ends[1], ...geometry.sizeMm]),
    }
    case 'source-key': return { signature: `key|${geometry.key}`, exact: geometry.key }
  }
}

/** Named dimensions as signature text: numbers quantised like lengths (angles
 *  in degrees share the 0.01 quantum), text verbatim, keys sorted. */
function dimensionText(dimensions: Readonly<Record<string, number | string>>): { signature: string; exact: string } {
  const keys = Object.keys(dimensions).sort()
  if (keys.length === 0) return { signature: '', exact: '' }
  const value = (v: number | string, exact: boolean) => (typeof v === 'number' ? (exact ? exactText([v]) : String(q(v))) : JSON.stringify(v))
  return {
    signature: `|m:${keys.map(k => `${k}=${value(dimensions[k], false)}`).join(';')}`,
    exact: `|${keys.map(k => `${k}=${value(dimensions[k], true)}`).join(';')}`,
  }
}

/** Faces keyed by the source's own ids (e.g. an ImportedBody elementMap's
 *  `geometry`): returns `face:<hash>` ids, sorted by id. */
export function identifyFaces(faces: Readonly<Record<string, FaceDescriptor>>): IdentifiedEntity<FaceDescriptor>[] {
  return assignIds('face', Object.entries(faces).map(([sourceId, descriptor]) => ({ item: { sourceId, descriptor }, ...faceSignature(descriptor) })))
    .map(({ id, item }) => ({ id, ...item }))
}

export function identifyEdges(edges: Readonly<Record<string, EdgeDescriptor>>): IdentifiedEntity<EdgeDescriptor>[] {
  return assignIds('edge', Object.entries(edges).map(([sourceId, descriptor]) => ({ item: { sourceId, descriptor }, ...edgeSignature(descriptor) })))
    .map(({ id, item }) => ({ id, ...item }))
}

/** The feature list of one part from one source. The type is part of the
 *  signature, so a hole re-recognised as another type is a new feature. */
export function partFeatureList(frame: PartFrame, source: FeatureSource, candidates: readonly FeatureCandidate[], notes: readonly string[] = []): PartFeatureList {
  if (frame.kind !== 'geometry-native' || !frame.entityId) throw new Error('A part feature list needs its geometry-native part frame')
  const left: string[] = []
  const signed = candidates.flatMap(candidate => {
    try {
      const { signature, exact } = geometrySignature(candidate.geometry)
      // A measured depth the source carries is a defining dimension too, and
      // so is every named dimension the adapter carried (sorted by name).
      const depth = candidate.depth.evidence === 'measured' ? candidate.depth.depthMm : undefined
      const named = dimensionText(candidate.dimensions)
      return [{
        item: candidate,
        signature: `${candidate.type}|${signature}${depth === undefined ? '' : `|h:${q(depth)}`}${named.signature}`,
        exact: `${depth === undefined ? exact : `${exact},${exactText([depth])}`}${named.exact}`,
      }]
    } catch (error) {
      left.push(`${source} ${candidate.sourceType} ${candidate.sourceKey}: left out (${error instanceof Error ? error.message : String(error)})`)
      return []
    }
  })
  const features: PartFeature[] = assignIds('feature', signed).map(({ id, item }) => ({ ...item, id, source }))
  return { frame: { kind: frame.kind, entityId: frame.entityId }, source, features, notes: [...notes, ...left.sort()] }
}
