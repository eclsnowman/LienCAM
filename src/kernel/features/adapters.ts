// WO-3002 (A3-09 steps 3 and 5): adapters from each as-built recogniser's own
// output onto the one feature contract. The recognisers stay split and are not
// imported here (kernel boundary, WO-2904): each adapter takes the recogniser's
// output SHAPE, which src/tests/kernel/featureInterface.wo3002.test.ts pins to
// the real types. GAP-013 (src/tests/evidence/WO-3002/GAP-013.md) is the record
// of what each source can and cannot tell apart.
import type { CylinderFeature, HoleFeature, Vec2, Vec3 } from '../../types'
import { axisFoot, canonicalAxis, canonicalRing, dot, qPoint, unit, unorderedPair, type P3 } from './signature'
import type { AxialBand, EdgeDescriptor, FaceDescriptor, FeatureCandidate, FeatureGeometry, FeatureType } from './types'

export interface AdapterResult {
  readonly candidates: FeatureCandidate[]
  /** one line per output the adapter could not read; recognition never throws past here */
  readonly notes: string[]
}

/** Every type text each recogniser emits today. A recogniser that adds one
 *  breaks the type pin in featureInterface.wo3002.test.ts until it is mapped. */
export const STEP_CYLINDER_KINDS = ['bore', 'boss'] as const
export const MODEL_FEATURE_CLASSES = [
  'throughHole', 'blindHole', 'counterboreStack', 'pocket', 'engravedText', 'boss',
  'filletPlanar', 'chamferPlanar', 'filletCurvedCorner', 'sliver', 'filletChain', 'chamferChain',
] as const
export const MESH_ROUND_KINDS = ['through-hole', 'blind-hole', 'boss', 'counterbore', 'countersink', 'chamfered-hole'] as const
export const MESH_REGION_KINDS = ['rectangular-pocket', 'slot', 'drafted-pocket'] as const
export const MESH_BLEND_KINDS = ['fillet', 'chamfer'] as const
export const LOOP_TYPES = ['contour', 'hole', 'open'] as const

/**
 * THE FIELD TABLE (fix round 2): every field of every recogniser output that
 * defines a feature's geometry, per source and source type, and where the
 * adapter puts it. Each one enters the id: `geometry` is signed whole
 * (identity.ts geometrySignature), `dimensions` is signed by name, and a
 * measured depth is signed. featureIdentity.wo3002.test.ts changes each field
 * alone and expects a new id, so a field listed here that no adapter carries
 * fails a test. Fields left out are listed with the reason in
 * DEFINING_FIELDS_LEFT_OUT.
 */
export const DEFINING_FIELDS = {
  'step-cylinder-scan': {
    // one cylinder; a bore stack is the same fields per cylinder (one band each)
    bore: ['center[0]', 'center[1]', 'diameter', 'topZ', 'bottomZ', 'through'],
    boss: ['center[0]', 'center[1]', 'diameter', 'topZ', 'bottomZ'],
    'bore stack': ['center[0]', 'center[1]', 'diameter (top bore)', 'diameter (bottom bore)', 'topZ (top bore)', 'shoulder (top bottomZ = bottom topZ)', 'bottomZ (bottom bore)'],
  },
  'model-kernel': {
    throughHole: ['rim (featureKey)', 'axisX', 'axisY', 'axisZ', 'diameter', 'depth'],
    blindHole: ['rim (featureKey)', 'axisX', 'axisY', 'axisZ', 'diameter', 'depth'],
    counterboreStack: ['rim (featureKey)', 'axisX', 'axisY', 'axisZ', 'diameter', 'depth', 'counterboreDiameter', 'counterboreDepth'],
    pocket: ['centre (featureKey, centerX/Y/Z)', 'spanX', 'spanY', 'depth'],
    boss: ['centre (featureKey, centerX/Y/Z)', 'spanX', 'spanY', 'depth'],
    engravedText: ['centre (featureKey, centerX/Y/Z)', 'spanX', 'spanY', 'depth'],
    sliver: ['centre (featureKey, centerX/Y/Z)', 'area'],
    filletPlanar: ['centre (featureKey, centerX/Y/Z)', 'radius'],
    chamferPlanar: ['centre (featureKey, centerX/Y/Z)', 'width'],
    filletCurvedCorner: ['centre (featureKey, centerX/Y/Z)', 'area', 'radius', 'cylinderRadius'],
    'filletPlanar / filletCurvedCorner absorbed': ['centre (featureKey, centerX/Y/Z)', 'area', 'surfaceKind'],
    filletChain: ['centre (featureKey, centerX/Y/Z)', 'area', 'radius'],
    chamferChain: ['centre (featureKey, centerX/Y/Z)', 'area', 'distance', 'distanceA', 'distanceB'],
  },
  'stl-mesh': {
    'through-hole': ['axis.origin', 'axis.direction', 'bands[].axialRangeMm', 'bands[].diameterMm'],
    'blind-hole': ['axis.origin', 'axis.direction', 'bands[].axialRangeMm', 'bands[].diameterMm'],
    counterbore: ['axis.origin', 'axis.direction', 'bands[].axialRangeMm', 'bands[].diameterMm'],
    countersink: ['axis.origin', 'axis.direction', 'bands[].axialRangeMm', 'bands[].diameterMm', 'bands[].endDiameterMm'],
    'chamfered-hole': ['axis.origin', 'axis.direction', 'bands[].axialRangeMm', 'bands[].diameterMm', 'bands[].endDiameterMm'],
    boss: ['axis.origin', 'axis.direction', 'bands[].axialRangeMm', 'bands[].diameterMm'],
    'boss (dome)': ['axis.origin', 'axis.direction', 'diameterMm', 'depthMm', 'profile'],
    'rectangular-pocket': ['floorNormal', 'corners', 'lengthMm', 'widthMm', 'depthMm'],
    slot: ['floorNormal', 'centerline', 'lengthMm', 'widthMm', 'depthMm', 'endStyle'],
    'drafted-pocket': ['floorNormal', 'corners', 'wallDraftDeg', 'lengthMm', 'widthMm', 'depthMm'],
    fillet: ['edgeLine.ends', 'radiusMm', 'shape', 'includedAngleDeg'],
    chamfer: ['edgeLine.ends', 'setbackMm', 'shape', 'includedAngleDeg'],
  },
  'sketch-2d': {
    'closed loop': ['points'],
  },
} as const

/** Output fields that are NOT part of a feature's geometry, and why. */
export const DEFINING_FIELDS_LEFT_OUT = {
  'model-kernel': {
    openings: 'how many planar loops the hole met (rim, shoulder, exit; defeature.ts:784): a count of crossings the band profile and the body already fix',
    radiusCount: 'how many bore radii: decides the type (counterbore or cone hole)',
    faceCount: 'a count of faces, not a dimension', neighbours: 'a count of faces, not a dimension',
    removedFaces: 'a count of faces', wallFaces: 'a count of faces',
    chain: 'fillet or chamfer: already the class', sharp: 'how the heal rebuilds the edge, not the feature',
    absorbedBy: "the host feature's key: a reference, not this feature's geometry",
  },
  'stl-mesh': {
    id: 'order-dependent (GAP-013 G-12): the source key only', maxDeviationMm: 'fit error, not geometry',
    coreRadiusMm: 'derived from the bands and the fit error', diameterMm: 'derived from the bands (still signed)',
    diametersMm: 'derived from the bands (still signed)', depthMm: 'derived from the bands (still signed)',
    'bands[].includedAngleDeg': 'derived from the cone band ends', clearCorners: 'derived from corners, drafts and depth',
    angleDeg: "a chamfer's angle to its first face: derived from the setbacks and included angle",
    'setbackMm order': 'which face is "first" follows facet order; the setbacks are signed as an unordered pair',
  },
} as const

/** Model-kernel params that are bookkeeping, not geometry (DEFINING_FIELDS_LEFT_OUT). */
const MODEL_BOOKKEEPING = new Set(Object.keys(DEFINING_FIELDS_LEFT_OUT['model-kernel']))
/** The params each model-kernel class must carry for its type to stand; any
 *  one variant will do. A verdict without them is `unclassified`, never a
 *  lossy fillet or hole. */
const MODEL_REQUIRED: Record<typeof MODEL_FEATURE_CLASSES[number], ReadonlyArray<readonly string[]>> = {
  throughHole: [['axisX', 'axisY', 'axisZ', 'diameter', 'depth']],
  blindHole: [['axisX', 'axisY', 'axisZ', 'diameter', 'depth']],
  counterboreStack: [['axisX', 'axisY', 'axisZ', 'diameter', 'depth', 'counterboreDiameter', 'counterboreDepth']],
  pocket: [['spanX', 'spanY', 'depth']], boss: [['spanX', 'spanY', 'depth']], engravedText: [['spanX', 'spanY', 'depth']],
  sliver: [['area']],
  filletPlanar: [['radius'], ['area', 'surfaceKind']],
  chamferPlanar: [['width']],
  filletCurvedCorner: [['area', 'radius', 'cylinderRadius'], ['area', 'surfaceKind']],
  filletChain: [['area', 'radius']],
  chamferChain: [['area', 'distance'], ['area', 'distanceA', 'distanceB']],
}

const MODEL_TYPE: Record<typeof MODEL_FEATURE_CLASSES[number], FeatureType> = {
  throughHole: 'throughHole', blindHole: 'blindHole',
  counterboreStack: 'counterbore', // refined below: one radius means a cone hole R2 cannot name
  pocket: 'pocket', engravedText: 'engravedText', boss: 'boss',
  filletPlanar: 'fillet', filletCurvedCorner: 'fillet', filletChain: 'fillet',
  chamferPlanar: 'chamfer', chamferChain: 'chamfer', sliver: 'sliver',
}
const MESH_ROUND_TYPE: Record<typeof MESH_ROUND_KINDS[number], FeatureType> = {
  'through-hole': 'throughHole', 'blind-hole': 'blindHole', boss: 'boss',
  counterbore: 'counterbore', countersink: 'countersink', 'chamfered-hole': 'chamferedHole',
}
const MESH_REGION_TYPE: Record<typeof MESH_REGION_KINDS[number], FeatureType> = {
  'rectangular-pocket': 'pocket', slot: 'slot', 'drafted-pocket': 'draftedPocket',
}
const MESH_BLEND_TYPE: Record<typeof MESH_BLEND_KINDS[number], FeatureType> = { fillet: 'fillet', chamfer: 'chamfer' }

function lookup<K extends string>(table: Record<K, FeatureType>, sourceType: string): FeatureType | undefined {
  return Object.prototype.hasOwnProperty.call(table, sourceType) ? table[sourceType as K] : undefined
}
const notInSet = (source: string, sourceType: string) => `${source} type "${sourceType}" is not in the closed feature set`

/** One surface of a round feature, between two points on its axis, with its
 *  diameter at each of them. */
interface BandAt { readonly surface: AxialBand['surface']; readonly from: P3; readonly to: P3; readonly diameters: readonly [number, number] }

/** Axial geometry from any two points on the axis, in the part frame, and the
 *  feature's surfaces as bands (stations along the canonical axis, low first). */
function axial(pointA: P3, pointB: P3, direction: P3, diameterMm: number, diametersMm: readonly number[], bandsAt: readonly BandAt[]): FeatureGeometry {
  if (!(diameterMm > 0) || !Number.isFinite(diameterMm)) throw new RangeError('no finite positive diameter')
  const d = canonicalAxis(direction)
  const a = dot(pointA, d), b = dot(pointB, d)
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError('no finite axial extent')
  const bands = bandsAt.map((band): AxialBand => {
    const s0 = dot(band.from, d), s1 = dot(band.to, d)
    if (![s0, s1, ...band.diameters].every(Number.isFinite) || !band.diameters.every(v => v >= 0)) throw new RangeError('a band with no finite extent or diameter')
    return s0 <= s1
      ? { surface: band.surface, stationsMm: [s0, s1], diametersMm: [band.diameters[0], band.diameters[1]] }
      : { surface: band.surface, stationsMm: [s1, s0], diametersMm: [band.diameters[1], band.diameters[0]] }
  }).sort((x, y) => x.stationsMm[0] - y.stationsMm[0] || x.stationsMm[1] - y.stationsMm[1] || x.diametersMm[0] - y.diametersMm[0])
  return { kind: 'axial', axisPoint: axisFoot(pointA, d), direction: d, stationsMm: [Math.min(a, b), Math.max(a, b)], diameterMm, diametersMm: [...diametersMm], bands }
}
const cylinderBand = (from: P3, to: P3, diameter: number): BandAt => ({ surface: 'cylinder', from, to, diameters: [diameter, diameter] })
const sorted = (values: Iterable<string | number>) => [...values].map(String).sort()
const sizes = (...values: number[]) => values.slice().sort((a, b) => b - a)

function each<T>(outputs: readonly T[], label: (output: T) => string, map: (output: T) => FeatureCandidate): AdapterResult {
  const candidates: FeatureCandidate[] = [], notes: string[] = []
  for (const output of outputs) {
    try { candidates.push(map(output)) } catch (error) {
      notes.push(`${label(output)}: left out (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { candidates, notes }
}

// ---- faces and edges of a B-rep body (modelling kernel import / tessellation) ----

export interface FaceSnapshotLike {
  readonly surfaceType: string
  readonly centroid: Vec3
  readonly area: number
  readonly normal?: Vec3
  readonly axis?: Vec3
}
const tuple = (v: Vec3): P3 => [v.x, v.y, v.z]

/** An ImportedBody elementMap's `geometry` (GeometrySnapshot per face stable
 *  id) as face descriptors. The stable ids (`IMPn:step:face#i`) follow entity
 *  order; the descriptors do not. */
export function facesFromSnapshots(snapshots: Readonly<Record<string, FaceSnapshotLike>>): Record<string, FaceDescriptor> {
  return Object.fromEntries(Object.entries(snapshots).map(([id, s]) => [id, {
    surface: s.surfaceType, areaMm2: s.area, centroid: tuple(s.centroid),
    ...(s.normal ? { normal: tuple(s.normal) } : {}), ...(s.axis ? { axis: tuple(s.axis) } : {}),
  }]))
}

export interface TessEdgesLike {
  readonly edgePositions: ArrayLike<number>
  /** CSR offsets in points, with the trailing sentinel (geom-engine BK-18) */
  readonly edgeOffsets: ArrayLike<number>
  readonly edgeIds: readonly string[]
}

/** Tessellated B-rep edges by edge stable id. A polyline that returns to its
 *  first point is a closed edge (the repeated point is dropped). */
export function edgesFromTessellation(t: TessEdgesLike): Record<string, EdgeDescriptor> {
  const out: Record<string, EdgeDescriptor> = {}
  t.edgeIds.forEach((id, i) => {
    const start = t.edgeOffsets[i], end = t.edgeOffsets[i + 1]
    if (start === undefined || end === undefined || end - start < 2) return
    const points: P3[] = []
    for (let k = start; k < end; k++) points.push([t.edgePositions[3 * k], t.edgePositions[3 * k + 1], t.edgePositions[3 * k + 2]])
    const first = points[0], last = points[points.length - 1]
    const closed = points.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < 1e-6
    out[id] = { points: closed ? points.slice(0, -1) : points, closed }
  })
  return out
}

// ---- R1: STEP cylinder scan (derive.ts holeFeatures / cylinderFeatures) ----

type StepCylinderLike = Pick<HoleFeature, 'center' | 'diameter' | 'topZ' | 'bottomZ' | 'through'> & { kind?: CylinderFeature['kind'] }

/** R1 reports one cylinder per radius, so a counterbore arrives as two bores on
 *  one axis that meet end to end (GAP-013 G-102). Those are joined into one
 *  counterbore; everything else maps one to one. R1 never reads cones, so it
 *  cannot report a countersink. */
export function fromStepCylinders(cylinders: readonly StepCylinderLike[]): AdapterResult {
  const key = (c: StepCylinderLike) => `${c.kind ?? 'bore'}|${Math.round(c.center[0] / 0.01)},${Math.round(c.center[1] / 0.01)}`
  const axes = new Map<string, StepCylinderLike[]>()
  for (const c of cylinders) axes.set(key(c), [...(axes.get(key(c)) ?? []), c])
  const stacks: StepCylinderLike[][] = []
  for (const group of axes.values()) {
    const byTop = group.slice().sort((a, b) => b.topZ - a.topZ || b.diameter - a.diameter || a.bottomZ - b.bottomZ)
    for (const c of byTop) {
      const below = c.kind === 'boss' ? undefined
        : stacks.find(stack => stack[0].kind !== 'boss' && key(stack[0]) === key(c) && Math.abs(stack[stack.length - 1].bottomZ - c.topZ) <= 1e-3 && stack[stack.length - 1].diameter > c.diameter)
      if (below) below.push(c)
      else stacks.push([c])
    }
  }
  return each(stacks, stack => `STEP cylinder at (${stack[0].center.join(', ')})`, stack => {
    const top = stack[0], bottom = stack[stack.length - 1]
    const narrow = stack.reduce((a, b) => (b.diameter < a.diameter ? b : a))
    const type: FeatureType = top.kind === 'boss' ? 'boss' : stack.length > 1 ? 'counterbore' : top.through ? 'throughHole' : 'blindHole'
    const [x, y] = top.center
    return {
      type,
      geometry: axial([x, y, bottom.bottomZ], [x, y, top.topZ], [0, 0, 1], narrow.diameter, stack.map(c => c.diameter),
        stack.map(c => cylinderBand([x, y, c.bottomZ], [x, y, c.topZ], c.diameter))),
      depth: { evidence: 'measured', depthMm: top.topZ - bottom.bottomZ },
      dimensions: {},
      sourceType: stack.map(c => `${c.kind ?? 'bore'}${c.through ? ' through' : ''}`).join(' + '),
      sourceKey: stack.map(c => `${c.kind ?? 'bore'}:${x},${y},${c.diameter}`).join(' + '),
      references: [],
    }
  })
}

// ---- R2: model-kernel recogniser (defeature.ts recognizeFeatures -> FeatureVerdict) ----

export interface ModelVerdictLike {
  readonly featureKey: string
  readonly featureClass: string
  readonly removable: boolean
  readonly refuseReason?: string
  readonly faceIds: readonly string[]
  readonly params: Readonly<Record<string, number | string>>
  /** a counterbore's wide wall faces (a subset of faceIds) */
  readonly counterboreFaceIds?: readonly string[]
}

/** Hole keys carry the rim centre (`hole:cx:cy:cz:ax:ay:az:r`, defeature.ts:799). */
function holeRim(key: string): P3 | undefined {
  const parts = key.split(':')
  if (parts[0] !== 'hole' || parts.length < 4) return undefined
  const p = parts.slice(1, 4).map(Number)
  return p.every(Number.isFinite) ? [p[0], p[1], p[2]] : undefined
}

/** `faces` is the body's face geometry by stable id (an ImportedBody
 *  elementMap's `geometry`); without it, a non-hole feature falls back to the
 *  recogniser's own key, which is geometry-derived and stated as such. */
export function fromModelVerdicts(verdicts: readonly ModelVerdictLike[], faces?: Readonly<Record<string, FaceDescriptor>>): AdapterResult {
  return each(verdicts, v => `model feature ${v.featureKey}`, v => {
    let type = lookup(MODEL_TYPE, v.featureClass) ?? 'unclassified'
    let note = type === 'unclassified' ? notInSet('model kernel', v.featureClass) : undefined
    const n = (name: string) => Number(v.params[name])
    const has = (name: string) => typeof v.params[name] === 'string' ? v.params[name] !== '' : Number.isFinite(n(name))
    if (v.featureClass === 'counterboreStack' && !(n('radiusCount') > 1)) {
      type = 'unclassified'
      note = 'a cone hole: the model kernel does not say whether it is a countersink or a chamfered hole'
    }
    // R2 files every curved face it could not prove (an unread, unsupported or
    // absorbed surface) as a refused `filletCurvedCorner`, and a hole with an
    // unread face as a refused `blindHole` (defeature.ts refuseCurved,
    // refuseUnsupportedKind, refuseAbsorbedUnsupportedKind, refuseHole). Those
    // are not proved fillets or holes.
    if (!v.removable && (v.featureClass === 'filletCurvedCorner' || v.featureKey.startsWith('hole-refused:'))) {
      type = 'unclassified'
      note = `the model kernel could not prove this ${v.featureClass === 'filletCurvedCorner' ? 'curved face' : 'hole'}${v.refuseReason ? `: ${v.refuseReason}` : ''}`
    }
    // A class whose defining params are missing (a band refused as
    // unmeasurable) cannot stand as that type: its size is unknown.
    const required = Object.prototype.hasOwnProperty.call(MODEL_REQUIRED, v.featureClass) ? MODEL_REQUIRED[v.featureClass as keyof typeof MODEL_REQUIRED] : undefined
    if (type !== 'unclassified' && required && !required.some(variant => variant.every(has))) {
      type = 'unclassified'
      note = `the model kernel gave no ${required[0].filter(name => !has(name)).join(', ')} for this ${v.featureClass}${v.refuseReason ? `: ${v.refuseReason}` : ''}`
    }
    // Every param that is not bookkeeping is a defining dimension: the ones
    // placed on the geometry are signed there, the rest by name.
    const placed = new Set<string>()
    const rim = holeRim(v.featureKey)
    let geometry: FeatureGeometry
    if (rim && n('diameter') > 0 && n('depth') > 0) {
      const opening: P3 = unit([n('axisX'), n('axisY'), n('axisZ')])
      const depth = n('depth')
      const at = (t: number): P3 => [rim[0] - opening[0] * t, rim[1] - opening[1] * t, rim[2] - opening[2] * t]
      for (const name of ['axisX', 'axisY', 'axisZ', 'diameter', 'depth']) placed.add(name)
      // An unclassified hole (a cone hole R2 cannot name) claims no profile.
      let bands = type === 'unclassified' ? [] : [cylinderBand(at(0), at(depth), n('diameter'))]
      if (type === 'counterbore') {
        // Only the wide faces' geometry says which end the step is at: R2's
        // rim is whichever loop it seeded from (an exit or the shoulder too).
        const step = n('counterboreDepth'), wide = n('counterboreDiameter')
        if (!(step > 0 && step < depth && wide > n('diameter'))) throw new RangeError('a counterbore step outside its hole')
        const atRim = counterboreAtRim(v, rim, opening, depth, step, faces)
        if (atRim === undefined) {
          bands = []
          note = 'no counterbore face geometry places this step at an end of the hole R2 seeded, so its step is carried unplaced'
        } else {
          bands = atRim
            ? [cylinderBand(at(0), at(step), wide), cylinderBand(at(step), at(depth), n('diameter'))]
            : [cylinderBand(at(0), at(depth - step), n('diameter')), cylinderBand(at(depth - step), at(depth), wide)]
          placed.add('counterboreDepth').add('counterboreDiameter')
        }
      }
      geometry = axial(rim, at(depth), opening, n('diameter'), n('counterboreDiameter') > 0 ? [n('diameter'), n('counterboreDiameter')] : [n('diameter')], bands)
    } else {
      const known = faces && v.faceIds.length > 0 ? v.faceIds.map(id => faces[id]) : []
      if (known.length > 0 && known.every(Boolean)) geometry = facesRegion(known as FaceDescriptor[])
      else {
        geometry = { kind: 'source-key', key: v.featureKey }
        note ??= 'no face geometry was given for this feature; the model kernel key stands in for its geometry'
      }
    }
    const dimensions = Object.fromEntries(Object.entries(v.params).filter(([name]) => !placed.has(name) && !MODEL_BOOKKEEPING.has(name)))
    return {
      type, geometry,
      depth: n('depth') > 0 ? { evidence: 'measured', depthMm: n('depth') } : { evidence: 'none' },
      dimensions,
      sourceType: v.featureClass, sourceKey: v.featureKey, references: sorted(v.faceIds),
      ...(note ? { note } : {}),
    }
  })
}

/** Whether a counterbore's step opens at R2's rim (true) or at the far end
 *  (false), from where its wide faces sit along the axis; unknown without
 *  their geometry, or when they sit at neither end (R2 seeded the hole from
 *  an inner loop, so its rim is not an end). */
function counterboreAtRim(v: ModelVerdictLike, rim: P3, opening: P3, depth: number, step: number, faces?: Readonly<Record<string, FaceDescriptor>>): boolean | undefined {
  const wide = (v.counterboreFaceIds ?? []).map(id => faces?.[id])
  if (wide.length === 0 || !wide.every(Boolean)) return undefined
  const t = (wide as FaceDescriptor[]).reduce((sum, f) => sum + dot([rim[0] - f.centroid[0], rim[1] - f.centroid[1], rim[2] - f.centroid[2]], opening), 0) / wide.length
  const near = (a: number) => Math.abs(t - a) <= 0.05
  return near(step / 2) ? true : near(depth - step / 2) ? false : undefined
}

function facesRegion(faces: readonly FaceDescriptor[]): FeatureGeometry {
  const area = faces.reduce((sum, f) => sum + f.areaMm2, 0)
  if (!(area > 0)) throw new RangeError('feature faces have no area')
  const c = [0, 1, 2].map(k => faces.reduce((sum, f) => sum + f.centroid[k] * f.areaMm2, 0) / area)
  return { kind: 'region', centroid: [c[0], c[1], c[2]], sizeMm: [], areaMm2: area }
}

// ---- R4: STL mesh recogniser (src/mesh/recognition) ----

type MeshP3 = readonly [number, number, number]
export interface MeshRoundLike {
  readonly id: string
  readonly kind: string
  readonly axis: { readonly origin: MeshP3; readonly direction: MeshP3 }
  readonly diameterMm: number
  readonly diametersMm: readonly number[]
  readonly depthMm: number
  readonly bands: readonly {
    readonly surface: AxialBand['surface']
    readonly diameterMm: number
    readonly endDiameterMm?: number
    readonly axialRangeMm: readonly [number, number]
  }[]
  readonly profile?: string
  readonly sourceFacetIds: readonly number[]
}
export interface MeshRegionLike {
  readonly id: string
  readonly kind: string
  readonly floorNormal: MeshP3
  readonly corners?: readonly MeshP3[]
  readonly centerline?: readonly [MeshP3, MeshP3]
  readonly lengthMm: number
  readonly widthMm: number
  readonly depthMm: number
  /** slot only */
  readonly endStyle?: string
  /** drafted pocket only: the lean of the wall on side k (corners[k] -> corners[k+1]) */
  readonly wallDraftDeg?: readonly number[]
  readonly sourceFacetIds: readonly number[]
}
export interface MeshBlendLike {
  readonly id: string
  readonly kind: string
  readonly shape: string
  readonly radiusMm?: number
  readonly setbackMm?: readonly [number, number]
  readonly includedAngleDeg: number
  readonly lengthMm: number
  readonly edgeLine: { readonly ends: readonly [MeshP3, MeshP3] }
  readonly sourceFacetIds: readonly number[]
}
export interface MeshRecognitionLike {
  readonly features: readonly MeshRoundLike[]
  readonly pockets?: readonly MeshRegionLike[]
  readonly slots?: readonly MeshRegionLike[]
  readonly draftedPockets?: readonly MeshRegionLike[]
}

/** Mesh ids are `${kind}-${smallest facet id}` (GAP-013 G-12): kept verbatim as
 *  the source key, never used for identity. Coordinates are the file's own. */
export function fromMeshRecognition(recognition: MeshRecognitionLike, blends: readonly MeshBlendLike[] = []): AdapterResult {
  const round = each(recognition.features, f => `mesh feature ${f.id}`, f => {
    const type = lookup(MESH_ROUND_TYPE, f.kind) ?? 'unclassified'
    // A dome (spherical-cap boss) has no fitted band: it spans its depth from the axis origin.
    const lo = f.bands.length ? Math.min(...f.bands.map(b => b.axialRangeMm[0])) : 0
    const hi = f.bands.length ? Math.max(...f.bands.map(b => b.axialRangeMm[1])) : f.depthMm
    const at = (t: number): P3 => [f.axis.origin[0] + f.axis.direction[0] * t, f.axis.origin[1] + f.axis.direction[1] * t, f.axis.origin[2] + f.axis.direction[2] * t]
    const bands = f.bands.map((b): BandAt => ({
      surface: b.surface, from: at(b.axialRangeMm[0]), to: at(b.axialRangeMm[1]),
      diameters: [b.diameterMm, b.surface === 'cone' ? (b.endDiameterMm ?? Number.NaN) : b.diameterMm],
    }))
    return {
      type, geometry: axial(at(lo), at(hi), f.axis.direction, f.diameterMm, f.diametersMm, bands),
      depth: { evidence: 'measured', depthMm: f.depthMm },
      dimensions: f.profile === undefined ? {} : { profile: f.profile } as Record<string, string>,
      sourceType: f.kind, sourceKey: f.id, references: sorted(f.sourceFacetIds),
      ...(type === 'unclassified' ? { note: notInSet('mesh', f.kind) } : {}),
    }
  })
  const regions = each([...recognition.pockets ?? [], ...recognition.slots ?? [], ...recognition.draftedPockets ?? []], r => `mesh feature ${r.id}`, r => {
    const type = lookup(MESH_REGION_TYPE, r.kind) ?? 'unclassified'
    const points = r.corners ?? r.centerline ?? []
    if (points.length === 0) throw new RangeError('no corners or centreline')
    const c = [0, 1, 2].map(k => points.reduce((sum, p) => sum + p[k], 0) / points.length)
    const dimensions: Record<string, number | string> = {}
    if (r.endStyle !== undefined) dimensions.endStyle = r.endStyle
    // Each wall's draft belongs to its side, named by the side's midpoint (a
    // corner list starting elsewhere names the same sides).
    r.wallDraftDeg?.forEach((deg, k) => {
      const a = points[k], b = points[(k + 1) % points.length]
      if (!a || !b) throw new RangeError('a wall draft with no side')
      dimensions[`draftDeg@${qPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])}`] = deg
    })
    return {
      type, geometry: {
        kind: 'region', centroid: [c[0], c[1], c[2]], normal: unit(r.floorNormal), sizeMm: sizes(r.lengthMm, r.widthMm, r.depthMm),
        outline: canonicalRing(points.map((p): P3 => [p[0], p[1], p[2]])),
      },
      depth: { evidence: 'measured', depthMm: r.depthMm },
      dimensions,
      sourceType: r.kind, sourceKey: r.id, references: sorted(r.sourceFacetIds),
      ...(type === 'unclassified' ? { note: notInSet('mesh', r.kind) } : {}),
    }
  })
  const lines = each(blends, b => `mesh edge blend ${b.id}`, b => {
    const type = lookup(MESH_BLEND_TYPE, b.kind) ?? 'unclassified'
    return {
      type, geometry: { kind: 'line', ends: unorderedPair(b.edgeLine.ends[0], b.edgeLine.ends[1]), sizeMm: sizes(...(b.radiusMm !== undefined ? [b.radiusMm] : b.setbackMm ?? [])) },
      depth: { evidence: 'none' },
      dimensions: { shape: b.shape, includedAngleDeg: b.includedAngleDeg },
      sourceType: b.kind, sourceKey: b.id, references: sorted(b.sourceFacetIds),
      ...(type === 'unclassified' ? { note: notInSet('mesh edge blend', b.kind) } : {}),
    }
  })
  return { candidates: [...round.candidates, ...regions.candidates, ...lines.candidates], notes: [...round.notes, ...regions.notes, ...lines.notes] }
}

// ---- 2D loops: no recogniser; today's loop ids ride along verbatim ----

export interface LoopLike {
  readonly id: string
  readonly points: readonly Vec2[]
  readonly closed: boolean
  readonly type: string
  readonly layerId: string
}

/** A 2D loop has no depth of its own: depth comes from the operation's
 *  parameters (draft A3-09 validate rule) and is never inferred here. 2D gives
 *  no evidence of type, so every region is `unclassified`; its loop id is kept
 *  verbatim as the reference (REQ-WORLD-3). Open loops bound no region. */
export function fromLoops(loops: readonly LoopLike[]): AdapterResult {
  const closed = loops.filter(loop => loop.closed)
  const result = each(closed, loop => `2D loop ${loop.id}`, loop => {
    let twice = 0, cx = 0, cy = 0
    const p = loop.points
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], cross = a.x * b.y - b.x * a.y
      twice += cross; cx += (a.x + b.x) * cross; cy += (a.y + b.y) * cross
    }
    if (!(Math.abs(twice) > 1e-12)) throw new RangeError('no enclosed area')
    const xs = p.map(v => v.x), ys = p.map(v => v.y)
    return {
      type: 'unclassified',
      geometry: {
        kind: 'region', centroid: [cx / (3 * twice), cy / (3 * twice), 0], sizeMm: sizes(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), areaMm2: Math.abs(twice) / 2,
        outline: canonicalRing(p.map((v): P3 => [v.x, v.y, 0])),
      },
      depth: { evidence: 'from-parameters' },
      dimensions: {},
      sourceType: loop.type, sourceKey: loop.id, references: [loop.id],
      note: 'a 2D loop carries no feature type; depth from the operation parameters',
    }
  })
  const open = loops.length - closed.length
  return { candidates: result.candidates, notes: [...result.notes, ...(open > 0 ? [`${open} open 2D path(s) bound no region and are not features`] : [])] }
}
