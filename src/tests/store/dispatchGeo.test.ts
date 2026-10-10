// Dispatch-time geometry transform helpers (B-rep derived layers follow the
// model transform). Covers the F1 fix: geometry_local loop transform
// (rotation.z + position, the DXF-branch math), selected-face / hole-bottom Z
// offsets, untouched legacy paths, and the ADR 0003 non-Z-rotation loud guard.

import { describe, it, expect } from 'vitest'
import {
  transformLoopPoints, bossIslandLoops, isWorldBakedLayer, layerPlaneWorldZ,
  selectedFaceWorldZ, holeBottomWorldZ, findTiltedGeometryLocalSource,
  isTiltedOffZ, classifyRotationOffZ, effectiveZRotationDeg, rotatedZAxis,
  tiltAngleDeg, TILT_TOLERANCE_DEG, resolveTopZ,
} from '../../store/dispatchGeo'
import type { ImportedGeometry, Layer2D, HoleFeature, Setup, SceneStock, CylinderFeature } from '../../types'

const PLANE = {
  origin: { x: 0, y: 0, z: 7 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
}

function makeLayer(over: Partial<Layer2D> = {}): Layer2D {
  return { id: 'layer-1', name: 'L', color: '#00e5ff', visible: true, ...over }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  }
}

function makeHole(over: Partial<HoleFeature> = {}): HoleFeature {
  return { center: [5, 5], diameter: 6, topZ: 10, bottomZ: 2, through: false, ...over }
}

describe('transformLoopPoints', () => {
  it('identity transform returns the points unchanged', () => {
    const pts = [{ x: 1, y: 2 }, { x: -3, y: 4.5 }]
    const out = transformLoopPoints(pts, makeGeo())
    expect(out).toEqual(pts)
  })

  it('applies pure translation (position.x/y, no rotation)', () => {
    const out = transformLoopPoints(
      [{ x: 1, y: 2 }],
      makeGeo({ position: { x: 10, y: -5, z: 99 } }),  // z must be ignored for XY
    )
    expect(out[0].x).toBeCloseTo(11, 9)
    expect(out[0].y).toBeCloseTo(-3, 9)
  })

  it('rotates 90 deg about Z then translates (DXF-branch math)', () => {
    // (1, 0) rotated +90 deg -> (0, 1); plus position (10, 20) -> (10, 21)
    const out = transformLoopPoints(
      [{ x: 1, y: 0 }, { x: 0, y: 1 }],
      makeGeo({ position: { x: 10, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 90 } }),
    )
    expect(out[0].x).toBeCloseTo(10, 9)
    expect(out[0].y).toBeCloseTo(21, 9)
    // (0, 1) rotated +90 deg -> (-1, 0) -> (9, 20)
    expect(out[1].x).toBeCloseTo(9, 9)
    expect(out[1].y).toBeCloseTo(20, 9)
  })

  it('treats a missing rotation object as zero (older saved projects)', () => {
    const geo = makeGeo({ position: { x: 10, y: -5, z: 0 } })
    delete (geo as Partial<ImportedGeometry>).rotation
    const out = transformLoopPoints([{ x: 1, y: 2 }], geo)
    expect(out[0].x).toBeCloseTo(11, 9)
    expect(out[0].y).toBeCloseTo(-3, 9)
  })

  it('flipped Euler representation (180, 180, -10) transforms identically to Rz(170)', () => {
    // Euler XYZ (180, 180, theta) === Rz(theta + 180): Rx(180)*Ry(180) = Rz(180).
    // The viewport renders both identically; dispatch must too (user repro
    // 2026-06-11: tilt guard + wrong-by-180 rotation on a gyro-rotated plate).
    const pts = [{ x: 20, y: 20 }, { x: 90, y: 40 }, { x: -7, y: 13.5 }]
    const flipped = transformLoopPoints(
      pts, makeGeo({ position: { x: 25, y: 13, z: 0 }, rotation: { x: 180, y: 180, z: -10 } }))
    const canonical = transformLoopPoints(
      pts, makeGeo({ position: { x: 25, y: 13, z: 0 }, rotation: { x: 0, y: 0, z: 170 } }))
    for (let i = 0; i < pts.length; i++) {
      expect(flipped[i].x).toBeCloseTo(canonical[i].x, 9)
      expect(flipped[i].y).toBeCloseTo(canonical[i].y, 9)
    }
  })
})

describe('effectiveZRotationDeg (matrix-extracted Z angle)', () => {
  it('matches rotation.z for canonical representations', () => {
    expect(effectiveZRotationDeg({ x: 0, y: 0, z: 35 })).toBeCloseTo(35, 9)
    expect(effectiveZRotationDeg({ x: 0, y: 0, z: -120 })).toBeCloseTo(-120, 9)
    expect(effectiveZRotationDeg(undefined)).toBeCloseTo(0, 12)
  })

  it('extracts the true angle from flipped representations (180, 180, theta)', () => {
    // Euler XYZ (180, 180, theta) === Rz(theta + 180)
    expect(effectiveZRotationDeg({ x: 180, y: 180, z: -10 })).toBeCloseTo(170, 9)
    expect(effectiveZRotationDeg({ x: 180, y: 180, z: 0 })).toBeCloseTo(180, 9)
    expect(effectiveZRotationDeg({ x: 180, y: 180, z: -90 })).toBeCloseTo(90, 9)
    expect(effectiveZRotationDeg({ x: 180, y: 180, z: 45 })).toBeCloseTo(-135, 9)
  })
})

describe('classifyRotationOffZ (geometric tilt predicate, v = R*(0,0,1))', () => {
  it('missing rotation object reads as zero', () => {
    expect(classifyRotationOffZ(undefined)).toBe('aligned')
    expect(isTiltedOffZ(undefined)).toBe(false)
  })

  it('missing x/y fields read as zero', () => {
    expect(classifyRotationOffZ({})).toBe('aligned')
    expect(classifyRotationOffZ({ z: 30 })).toBe('aligned')
  })

  it('gizmo float residue stays under the tolerance', () => {
    expect(isTiltedOffZ({ x: 1e-9, y: 0, z: 0 })).toBe(false)
    expect(isTiltedOffZ({ x: 2e-7, y: -1e-8, z: 15 })).toBe(false)
    expect(isTiltedOffZ({ x: 0, y: TILT_TOLERANCE_DEG * 0.9, z: 0 })).toBe(false)
  })

  it('flipped Euler representations of pure Z rotations are NOT tilted', () => {
    // (180, 180, theta) === Rz(theta + 180): per-component checks wrongly
    // refused these (the user-reported recurrence after fc4650b).
    for (const theta of [-10, 0, 45, -90, 170]) {
      expect(classifyRotationOffZ({ x: 180, y: 180, z: theta })).toBe('aligned')
    }
    const v = rotatedZAxis({ x: 180, y: 180, z: -10 })
    expect(v.z).toBeCloseTo(1, 12)
  })

  it('genuine tilt (either axis, either sign) is flagged', () => {
    expect(classifyRotationOffZ({ x: 5, y: 0, z: 0 })).toBe('tilted')
    expect(classifyRotationOffZ({ x: 0, y: -0.3, z: 0 })).toBe('tilted')
    expect(isTiltedOffZ({ x: TILT_TOLERANCE_DEG * 2, y: 0, z: 0 })).toBe(true)
    expect(tiltAngleDeg({ x: 5, y: 0, z: 0 })).toBeCloseTo(5, 9)
  })

  it('upside-down rotations are classified flipped (mirror, refused in v1)', () => {
    expect(classifyRotationOffZ({ x: 180, y: 0, z: 0 })).toBe('flipped')
    expect(classifyRotationOffZ({ x: 0, y: 180, z: 25 })).toBe('flipped')
    expect(rotatedZAxis({ x: 180, y: 0, z: 0 }).z).toBeCloseTo(-1, 12)
    expect(tiltAngleDeg({ x: 180, y: 0, z: 0 })).toBeCloseTo(180, 9)
  })
})

describe('isWorldBakedLayer (legacy paths untouched)', () => {
  it('STL projection layer (projectionPlane, no frame) is world-baked: sent as-is', () => {
    expect(isWorldBakedLayer(makeLayer({ projectionPlane: PLANE }))).toBe(true)
  })

  it('geometry_local layer is NOT world-baked even though it has a projectionPlane', () => {
    expect(isWorldBakedLayer(makeLayer({ projectionPlane: PLANE, frame: 'geometry_local' }))).toBe(false)
  })

  it('plain DXF/SVG layer (no projectionPlane) is not world-baked: DXF branch transforms it', () => {
    expect(isWorldBakedLayer(makeLayer())).toBe(false)
  })
})

describe('layerPlaneWorldZ', () => {
  const geoAtZ = makeGeo({ position: { x: 1, y: 2, z: 12.5 } })

  it('adds geometry position.z for geometry_local planes', () => {
    const layer = makeLayer({ projectionPlane: PLANE, frame: 'geometry_local' })
    expect(layerPlaneWorldZ(layer, geoAtZ)).toBeCloseTo(19.5, 9)
  })

  it('returns world-baked plane Z verbatim (STL projection)', () => {
    const layer = makeLayer({ projectionPlane: PLANE })
    expect(layerPlaneWorldZ(layer, geoAtZ)).toBe(7)
  })

  it('returns undefined when the layer has no projectionPlane', () => {
    expect(layerPlaneWorldZ(makeLayer(), geoAtZ)).toBeUndefined()
  })
})

describe('selectedFaceWorldZ', () => {
  it('adds position.z for a step source geometry', () => {
    const geo = makeGeo({ position: { x: 0, y: 0, z: -4 } })
    expect(selectedFaceWorldZ(10, geo)).toBeCloseTo(6, 9)
  })

  // H0 (escape-hatch E2): the position.z add was UNIVERSALIZED off the legacy
  // `format === 'step'` proxy onto `geo !== undefined` (isGeometryLocalSource),
  // unifying it with layerPlaneWorldZ / holeBottomWorldZ. Byte-identical for
  // every REACHABLE case (selectedFaceZ is only ever captured from a step
  // source) but a defined non-step source now also gets the offset. This
  // assertion was previously `.toBe(10)` (the old step-only behavior).
  it('adds position.z for any defined source, incl. non-step (H0 universalized)', () => {
    const geo = makeGeo({ format: 'dxf', type: 'curves_2d', position: { x: 0, y: 0, z: 3 } })
    expect(selectedFaceWorldZ(10, geo)).toBe(13)
  })

  it('leaves the value unchanged when the source geometry is missing', () => {
    expect(selectedFaceWorldZ(10, undefined)).toBe(10)
  })
})

describe('holeBottomWorldZ', () => {
  it('adds geometry position.z on geometry_local layers', () => {
    const layer = makeLayer({ frame: 'geometry_local' })
    const geo = makeGeo({ position: { x: 5, y: 5, z: 3.25 } })
    expect(holeBottomWorldZ(makeHole({ bottomZ: 2 }), layer, geo)).toBeCloseTo(5.25, 9)
  })

  it('leaves legacy untagged layers verbatim', () => {
    const geo = makeGeo({ position: { x: 5, y: 5, z: 3.25 } })
    expect(holeBottomWorldZ(makeHole({ bottomZ: 2 }), makeLayer(), geo)).toBe(2)
  })
})

describe('findTiltedGeometryLocalSource (ADR 0003 loud guard)', () => {
  const heightsNoFace = { bottomHeightMode: 'absolute' as const, selectedFaceZ: undefined }
  const heightsFace = { bottomHeightMode: 'selected_face' as const, selectedFaceZ: 5 }

  it('flags a tilted geometry with a geometry_local layer', () => {
    const geo = makeGeo({
      rotation: { x: 15, y: 0, z: 0 },
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local' })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsNoFace)).toEqual({ geo, kind: 'tilted' })
  })

  it('flags a tilted geometry with a holes layer (legacy untagged)', () => {
    const geo = makeGeo({
      rotation: { x: 0, y: -30, z: 0 },
      layers2d: [makeLayer({ projectionPlane: PLANE, holes: [makeHole()] })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsNoFace)).toEqual({ geo, kind: 'tilted' })
  })

  it('flags a tilted step geometry when the op uses selected_face', () => {
    const geo = makeGeo({ rotation: { x: 10, y: 0, z: 0 } })
    expect(findTiltedGeometryLocalSource([geo], heightsFace)).toEqual({ geo, kind: 'tilted' })
  })

  it('flags an upside-down geometry as flipped (clearer v1 refusal message)', () => {
    const geo = makeGeo({
      rotation: { x: 180, y: 0, z: 0 },
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local' })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsNoFace)).toEqual({ geo, kind: 'flipped' })
  })

  it('does not flag Z-only rotation (geometry_local layers stay valid)', () => {
    const geo = makeGeo({
      rotation: { x: 0, y: 0, z: 45 },
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local' })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsFace)).toBeNull()
  })

  it('does not flag the flipped Euler representation of a pure Z rotation', () => {
    const geo = makeGeo({
      rotation: { x: 180, y: 180, z: -10 },  // === Rz(170), zero tilt
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local', holes: [makeHole()] })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsFace)).toBeNull()
  })

  it('does not flag a tilted plain-2D source (no geometry_local data consumed)', () => {
    const geo = makeGeo({
      format: 'dxf', type: 'curves_2d',
      rotation: { x: 20, y: 0, z: 0 },
      layers2d: [makeLayer()],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsNoFace)).toBeNull()
  })

  it('does not flag a tilted STL with world-baked projection layers', () => {
    const geo = makeGeo({
      format: 'stl', type: 'mesh',
      rotation: { x: 20, y: 0, z: 0 },
      layers2d: [makeLayer({ projectionPlane: PLANE })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsFace)).toBeNull()
  })

  it('does not flag a geometry with NO rotation object (older saved project)', () => {
    const geo = makeGeo({
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local', holes: [makeHole()] })],
    })
    delete (geo as Partial<ImportedGeometry>).rotation
    expect(findTiltedGeometryLocalSource([geo], heightsFace)).toBeNull()
  })

  it('does not flag gizmo float residue in rotation.x/y (user repro 2026-06-11)', () => {
    const geo = makeGeo({
      rotation: { x: 2e-7, y: -1e-8, z: 0 },
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local', holes: [makeHole()] })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsFace)).toBeNull()
  })

  it('still flags a genuine small tilt (0.3 deg, the movefix-gate case)', () => {
    const geo = makeGeo({
      rotation: { x: 0.3, y: 0, z: 0 },
      layers2d: [makeLayer({ projectionPlane: PLANE, frame: 'geometry_local' })],
    })
    expect(findTiltedGeometryLocalSource([geo], heightsNoFace)).toEqual({ geo, kind: 'tilted' })
  })
})

describe('resolveTopZ - consolidated reference set (B17, Operator 2026-06-13)', () => {
  // resolveTopZ reads only setup.wcs.origin.z + setup.wcs.stockId.
  const setupAtWcsZ = (z: number) =>
    ({ wcs: { origin: { x: 0, y: 0, z }, stockId: undefined } } as unknown as Setup)
  const noStock = { mode: 'fixed', fixedStocks: [], autoOffsetXY: 0, autoOffsetZTop: 0 } as unknown as SceneStock

  it('machine_floor returns -wcsZ + offset, so machine Z lands on the offset (0 = the table)', () => {
    // resolveHeights later adds wcsZ back: (-12 + 0) + 12 = 0 (machine floor).
    expect(resolveTopZ('machine_floor', 0, setupAtWcsZ(12), noStock, [], 'g')).toBeCloseTo(-12, 9)
    // Offset -0.5 -> machine Z -0.5 (0.5 below the table): (-12.5) + 12.
    expect(resolveTopZ('machine_floor', -0.5, setupAtWcsZ(12), noStock, [], 'g')).toBeCloseTo(-12.5, 9)
  })

  it('wcs_plane is the WCS origin plane; the offset is the WCS Z verbatim (old "absolute")', () => {
    expect(resolveTopZ('wcs_plane', -3, setupAtWcsZ(12), noStock, [], 'g')).toBeCloseTo(-3, 9)
  })

  it('geometry_face = the LOOP plane (position.z), NOT bbox.max.z (B17, Operator 2026-06-13)', () => {
    // Part placed at z=5 with a TALL bbox (max.z=10). The reference must be the
    // plane the lines sit on (5), not the bbox top (15). wcsZ=2 -> 5-2 = 3.
    const geo = makeGeo({ position: { x: 0, y: 0, z: 5 } }) // bbox.max.z 10 (ignored)
    expect(resolveTopZ('geometry_face', 0, setupAtWcsZ(2), noStock, [geo], 'geo-1')).toBeCloseTo(3, 9)
    // Offset rides on the plane: -0.5 below the geometry plane.
    expect(resolveTopZ('geometry_face', -0.5, setupAtWcsZ(2), noStock, [geo], 'geo-1')).toBeCloseTo(2.5, 9)
  })

  it('geometry_face tracks a moved part (position.z), so "0.5 below the geometry" follows it', () => {
    const at0  = makeGeo({ position: { x: 0, y: 0, z: 0 } })
    const at12 = makeGeo({ position: { x: 0, y: 0, z: 12 } })
    expect(resolveTopZ('geometry_face', -0.5, setupAtWcsZ(0), noStock, [at0], 'geo-1')).toBeCloseTo(-0.5, 9)
    expect(resolveTopZ('geometry_face', -0.5, setupAtWcsZ(0), noStock, [at12], 'geo-1')).toBeCloseTo(11.5, 9)
  })

  it("picked_plane = the picked face's model-local Z (planeOffset on top), WCS-relative", () => {
    // MANUAL datum: operator clicked a face at localZ=34 on a part at position.z=0.
    // wcsZ=49 -> WCS-relative = (34 + 0 - 49) + offset. offset 2 -> -13; offset 0 -> -15.
    const geo = makeGeo({ position: { x: 0, y: 0, z: 0 } })
    const pick = { geoId: 'geo-1', faceIndex: 0, localZ: 34 }
    expect(resolveTopZ('picked_plane', 2, setupAtWcsZ(49), noStock, [geo], 'geo-1', [], [], pick)).toBeCloseTo(-13, 9)
    expect(resolveTopZ('picked_plane', 0, setupAtWcsZ(49), noStock, [geo], 'geo-1', [], [], pick)).toBeCloseTo(-15, 9)
  })

  it('picked_plane FAILS LOUD (ADR 0003) when no surface was picked', () => {
    const geo = makeGeo({ position: { x: 0, y: 0, z: 0 } })
    // No referencePlaneGeo at all.
    expect(() => resolveTopZ('picked_plane', 0, setupAtWcsZ(49), noStock, [geo], 'geo-1'))
      .toThrow(/Picked surface/)
    // Picked geometry was deleted (geoId not found).
    expect(() => resolveTopZ('picked_plane', 0, setupAtWcsZ(49), noStock, [geo], 'geo-1', [], [],
      { geoId: 'gone', faceIndex: 0, localZ: 34 })).toThrow(/Picked surface/)
  })
})

// Auto-island standing bosses for stock-boundary pockets: bossIslandLoops turns
// boss cylinders into world-frame type:'hole' islands (so a stock pocket clears
// AROUND them); bores produce nothing. Geometry/avoidance ONLY -- no depth here.
function makeCyl(over: Partial<CylinderFeature> = {}): CylinderFeature {
  return {
    center: [0, 0], diameter: 4, topZ: 5, bottomZ: 0, through: false, kind: 'boss',
    ...over,
  }
}

describe('bossIslandLoops (auto-island standing bosses)', () => {
  it('emits ONE island per BOSS and ignores BORES', () => {
    const feats: CylinderFeature[] = [
      makeCyl({ kind: 'boss', center: [1, 2], diameter: 6 }),
      makeCyl({ kind: 'bore', center: [9, 9], diameter: 3 }),
      makeCyl({ kind: 'boss', center: [-4, 5], diameter: 2 }),
    ]
    const loops = bossIslandLoops(feats, { position: { x: 0, y: 0, z: 0 } })
    expect(loops).toHaveLength(2) // two bosses, the bore is dropped
  })

  it('bore-only input yields no loops', () => {
    const loops = bossIslandLoops([makeCyl({ kind: 'bore' })], { position: { x: 0, y: 0, z: 0 } })
    expect(loops).toHaveLength(0)
  })

  it('each loop is a closed type:hole island with an id and the default 64 points', () => {
    const [loop] = bossIslandLoops([makeCyl()], { position: { x: 0, y: 0, z: 0 } })
    expect(loop.type).toBe('hole')        // classifyLoops routes hole -> island
    expect(loop.closed).toBe(true)
    expect(loop.id).toBe('__boss_island_0__')
    expect(loop.points).toHaveLength(64)
  })

  it('segments arg controls point count', () => {
    const [loop] = bossIslandLoops([makeCyl()], { position: { x: 0, y: 0, z: 0 } }, 8)
    expect(loop.points).toHaveLength(8)
  })

  it('applies the part POSE: a position offset shifts every point by that offset', () => {
    // center [0,0], r=2, no rotation: with no offset the first point sits at (+r, 0).
    const base = bossIslandLoops([makeCyl({ center: [0, 0], diameter: 4 })],
      { position: { x: 0, y: 0, z: 0 } })[0]
    expect(base.points[0].x).toBeCloseTo(2, 9)
    expect(base.points[0].y).toBeCloseTo(0, 9)
    // Same boss, part moved to (10, -3): every point is shifted by exactly that.
    const moved = bossIslandLoops([makeCyl({ center: [0, 0], diameter: 4 })],
      { position: { x: 10, y: -3, z: 0 } })[0]
    expect(moved.points[0].x).toBeCloseTo(12, 9)
    expect(moved.points[0].y).toBeCloseTo(-3, 9)
    for (let i = 0; i < base.points.length; i++) {
      expect(moved.points[i].x).toBeCloseTo(base.points[i].x + 10, 9)
      expect(moved.points[i].y).toBeCloseTo(base.points[i].y - 3, 9)
    }
  })
})
