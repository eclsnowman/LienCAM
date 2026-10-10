// GEO-1 kernel-free unit tests for the deterministic stable-ID core.
import { describe, it, expect } from 'vitest'
import {
  snap,
  compareSnapshots,
  boxFaceTag,
  assignBoxFaceIds,
  edgeId,
  assignCutFaceIds,
  assignShellFaceIds,
  rebindDraftFaces,
  mintDiscriminatorKey,
  orderMintCandidates,
  EDGE_JOIN as WORKER_EDGE_JOIN,
  EDGE_DISAMB_MARK,
  edgeDisambToken,
  disambiguateEdgeIds,
  edgeIdBase,
  collidingPickedEdgeIds,
  resolvePersistedEdgeId,
  type EdgeGeom,
  type BBox,
} from '../../geom/worker/stable-id.ts'
import { EDGE_JOIN as DOC_EDGE_JOIN } from '../../doc/stable-id.ts'
import type { FaceProbe, GeometrySnapshot } from '../../geom/worker/internal-types.ts'

function snapshot(centroid: [number, number, number], area = 1, type: GeometrySnapshot['type'] = 'plane'): GeometrySnapshot {
  return { type, centroid, normal: [0, 0, 1], area }
}
function probe(hash: number, centroid: [number, number, number], area = 1): FaceProbe {
  return { hash, snapshot: snapshot(centroid, area) }
}

describe('snap + compareSnapshots', () => {
  it('normalizes -0 and quantizes to the 1e-7 grid', () => {
    expect(snap(-0)).toBe(0)
    expect(snap(0)).toBe(0)
    expect(snap(1)).toBe(10_000_000)
    // sub-eps noise collapses to the same grid cell
    expect(snap(1 + 1e-9)).toBe(snap(1))
  })
  it('orders by centroid x,y,z then area then type', () => {
    expect(compareSnapshots(snapshot([0, 0, 0]), snapshot([1, 0, 0]))).toBe(-1)
    expect(compareSnapshots(snapshot([1, 0, 0]), snapshot([1, 0, 0]))).toBe(0)
    expect(compareSnapshots(snapshot([0, 2, 0]), snapshot([0, 1, 0]))).toBe(1)
  })
})

describe('boxFaceTag', () => {
  const bbox: BBox = { min: [0, 0, 0], max: [40, 20, 10] }
  it('tags each axis-aligned side deterministically', () => {
    expect(boxFaceTag([0, 10, 5], bbox)).toBe('xMin')
    expect(boxFaceTag([40, 10, 5], bbox)).toBe('xMax')
    expect(boxFaceTag([20, 0, 5], bbox)).toBe('yMin')
    expect(boxFaceTag([20, 20, 5], bbox)).toBe('yMax')
    expect(boxFaceTag([20, 10, 0], bbox)).toBe('zMin')
    expect(boxFaceTag([20, 10, 10], bbox)).toBe('zMax')
  })
  it('returns null for an interior (non-side) centroid', () => {
    expect(boxFaceTag([20, 10, 5], bbox)).toBeNull()
  })
})

describe('assignBoxFaceIds', () => {
  it('assigns six unique BOX ids with side tags', () => {
    const faces: FaceProbe[] = [
      probe(101, [0, 10, 5], 200),
      probe(102, [40, 10, 5], 200),
      probe(103, [20, 0, 5], 400),
      probe(104, [20, 20, 5], 400),
      probe(105, [20, 10, 0], 800),
      probe(106, [20, 10, 10], 800),
    ]
    const { faceMap, snapshots } = assignBoxFaceIds('F1', faces, { min: [0, 0, 0], max: [40, 20, 10] })
    const ids = [...faceMap.values()].sort()
    expect(new Set(ids).size).toBe(6)
    expect(ids).toContain('F1:BOX:xMin')
    expect(ids).toContain('F1:BOX:zMax')
    expect(snapshots.size).toBe(6)
    // deterministic re-run
    const again = assignBoxFaceIds('F1', faces, { min: [0, 0, 0], max: [40, 20, 10] })
    expect([...again.faceMap.values()].sort()).toEqual(ids)
  })
})

describe('edgeId', () => {
  const J = DOC_EDGE_JOIN // U+2227 wedge, per docs/stable-id-spec.md
  it('cross-module: the worker joiner IS the merged DOC lane joiner (no split-brain)', () => {
    // R1.2: caret IDs could never match DOC's resolver keys. The worker imports
    // DOC-1's single EDGE_JOIN constant, so drift is structurally impossible.
    expect(WORKER_EDGE_JOIN).toBe(DOC_EDGE_JOIN)
    expect(WORKER_EDGE_JOIN).toBe('∧') // the spec wedge, not ASCII caret
  })
  it('sorts the adjacent-face pair lexicographically with the spec joiner', () => {
    expect(edgeId(['F1:BOX:zMax', 'F1:BOX:xMin'], '0')).toBe(`(F1:BOX:xMin${J}F1:BOX:zMax)`)
    expect(edgeId(['b', 'a'], '0')).toBe(`(a${J}b)`)
  })
  it('marks a single-adjacent (seam) edge with the spec joiner', () => {
    expect(edgeId(['F1:BOX:zMax'], '3')).toBe(`(F1:BOX:zMax${J}seam#3)`)
  })
})

describe('assignCutFaceIds', () => {
  // Target box faces 1..6 with stable ids.
  const inputFaceMap = new Map<number, string>([
    [1, 'F1:BOX:xMin'],
    [2, 'F1:BOX:xMax'],
    [3, 'F1:BOX:yMin'],
    [4, 'F1:BOX:yMax'],
    [5, 'F1:BOX:zMin'],
    [6, 'F1:BOX:zMax'],
  ])
  // Result: faces 1,2,3 unchanged; face 5 retrimmed 1:1 -> 50; face 6 split -> 61,60;
  //         new tool wall -> 99; face 4 vanished (deleted).
  const modifiedRecords = [
    { inHash: 5, outHashes: [50] },
    { inHash: 6, outHashes: [60, 61] },
  ]
  const resultFaces: FaceProbe[] = [
    probe(1, [0, 10, 5]),
    probe(2, [40, 10, 5]),
    probe(3, [20, 0, 5]),
    probe(50, [20, 10, 0], 700),
    probe(60, [10, 10, 10], 300),
    probe(61, [30, 10, 10], 300),
    probe(99, [5, 5, 5], 100),
  ]

  it('names unchanged / modified / split / new / deleted per spec', () => {
    const a = assignCutFaceIds('F3', inputFaceMap, modifiedRecords, resultFaces, undefined)
    // unchanged keep id
    expect(a.faceMap.get(1)).toBe('F1:BOX:xMin')
    // retrimmed 1:1 keeps id
    expect(a.faceMap.get(50)).toBe('F1:BOX:zMin')
    expect(a.modified['F1:BOX:zMin']).toEqual(['F1:BOX:zMin'])
    // split -> centroid-ordered fragments (#0 is the smaller-x one)
    expect(a.faceMap.get(60)).toBe('F3:CUT:F1:BOX:zMax#0')
    expect(a.faceMap.get(61)).toBe('F3:CUT:F1:BOX:zMax#1')
    expect(a.modified['F1:BOX:zMax']).toEqual(['F3:CUT:F1:BOX:zMax#0', 'F3:CUT:F1:BOX:zMax#1'])
    // new tool wall
    expect(a.faceMap.get(99)).toBe('F3:CUT:new#0')
    expect(a.generated).toEqual(['F3:CUT:new#0'])
    // vanished input -> deleted
    expect(a.deleted).toEqual(['F1:BOX:yMax'])
    // every result face is named
    expect(a.faceMap.size).toBe(resultFaces.length)
  })

  it('is deterministic across runs (byte-identical id sets)', () => {
    const a = assignCutFaceIds('F3', inputFaceMap, modifiedRecords, resultFaces, undefined)
    const b = assignCutFaceIds('F3', inputFaceMap, modifiedRecords, resultFaces, undefined)
    expect([...a.faceMap.values()].sort()).toEqual([...b.faceMap.values()].sort())
    expect(a.generated).toEqual(b.generated)
    expect(a.deleted).toEqual(b.deleted)
  })
})

describe('assignShellFaceIds (GEO-4)', () => {
  // Target box faces 1..6, same convention as assignCutFaceIds's fixture.
  const inputFaceMap = new Map<number, string>([
    [1, 'F1:BOX:xMin'],
    [2, 'F1:BOX:xMax'],
    [3, 'F1:BOX:yMin'],
    [4, 'F1:BOX:yMax'],
    [5, 'F1:BOX:zMin'],
    [6, 'F1:BOX:zMax'],
  ])
  // zMax (6) is the removed face: retrims 1:1 into a rim (hash 60).
  const removedRecords = [{ inHash: 6, outHashes: [60] }]
  // Every remaining face spawns exactly one inner companion.
  const spawnedRecords = [
    { inHash: 1, outHashes: [101] },
    { inHash: 2, outHashes: [102] },
    { inHash: 3, outHashes: [103] },
    { inHash: 4, outHashes: [104] },
    { inHash: 5, outHashes: [105] },
  ]
  const resultFaces: FaceProbe[] = [
    probe(1, [0, 10, 5], 200),
    probe(2, [40, 10, 5], 200),
    probe(3, [20, 0, 5], 400),
    probe(4, [20, 20, 5], 400),
    probe(5, [20, 10, 0], 800),
    probe(60, [20, 10, 10], 224), // rim (ring area, not the full 800)
    probe(101, [2, 10, 6], 128),
    probe(102, [38, 10, 6], 128),
    probe(103, [20, 2, 6], 288),
    probe(104, [20, 18, 6], 288),
    probe(105, [20, 10, 2], 576),
  ]

  it('names unchanged / rim-retrim / inner-companions per spec', () => {
    const a = assignShellFaceIds('F2', inputFaceMap, removedRecords, spawnedRecords, resultFaces, undefined)
    // unchanged faces keep their id.
    expect(a.faceMap.get(1)).toBe('F1:BOX:xMin')
    // removed face retrims to a rim but KEEPS its id.
    expect(a.faceMap.get(60)).toBe('F1:BOX:zMax')
    expect(a.modified['F1:BOX:zMax']).toEqual(['F1:BOX:zMax'])
    // inner companions named `<fid>:SHL:<origId>:inner`.
    expect(a.faceMap.get(101)).toBe('F2:SHL:F1:BOX:xMin:inner')
    expect(a.faceMap.get(105)).toBe('F2:SHL:F1:BOX:zMin:inner')
    expect(a.generated.sort()).toEqual([
      'F2:SHL:F1:BOX:xMax:inner',
      'F2:SHL:F1:BOX:xMin:inner',
      'F2:SHL:F1:BOX:yMax:inner',
      'F2:SHL:F1:BOX:yMin:inner',
      'F2:SHL:F1:BOX:zMin:inner',
    ])
    expect(a.deleted).toEqual([])
    expect(a.faceMap.size).toBe(resultFaces.length)
  })

  it('is deterministic across runs (byte-identical id sets)', () => {
    const a = assignShellFaceIds('F2', inputFaceMap, removedRecords, spawnedRecords, resultFaces, undefined)
    const b = assignShellFaceIds('F2', inputFaceMap, removedRecords, spawnedRecords, resultFaces, undefined)
    expect([...a.faceMap.values()].sort()).toEqual([...b.faceMap.values()].sort())
    expect(a.generated).toEqual(b.generated)
  })

  it('a removed face with NO surviving output is deleted, not silently dropped', () => {
    const a = assignShellFaceIds('F2', inputFaceMap, [{ inHash: 6, outHashes: [] }], spawnedRecords, resultFaces.filter((f) => f.hash !== 60), undefined)
    expect(a.deleted).toEqual(['F1:BOX:zMax'])
  })

  it('well-formed shell leaves NO unmapped faces', () => {
    const a = assignShellFaceIds('F2', inputFaceMap, removedRecords, spawnedRecords, resultFaces, undefined)
    expect(a.unmapped).toEqual([])
  })

  it('R1.4: a result face absent from all evolution channels is surfaced as unmapped, NOT minted as an off-grammar F:SHL:new#k id', () => {
    // Drive the ex-catch-all path directly: an extra result face (hash 777)
    // that is neither an unchanged input, nor a removed-face retrim output,
    // nor a spawned inner companion. Pre-R1 minted `F2:SHL:new#0` for it (a
    // silent wrong-binding once persisted); R1.4 surfaces it in `unmapped` so
    // applyShell can fail loud instead.
    const rogue = probe(777, [15, 15, 7], 42)
    const a = assignShellFaceIds('F2', inputFaceMap, removedRecords, spawnedRecords, [...resultFaces, rogue], undefined)
    expect(a.unmapped.map((p) => p.hash)).toEqual([777])
    // and it was NOT given an id under any grammar (no positional fallback).
    expect(a.faceMap.has(777)).toBe(false)
    expect(a.generated.some((id) => id.includes(':new#'))).toBe(false)
  })
})

describe('rebindDraftFaces (GEO-4-R1.2 motion-aware draft rebind)', () => {
  // Kernel-free fixture modelled on the REAL kernel spike: a 40x20x10 box whose
  // +x face is drafted 30deg about the z=0 neutral plane, pullDir -z. Measured
  // post-draft geometry (from the empirical probe): the edited +x face's normal
  // tilts by exactly 30deg (dot with prior = cos30 = 0.866) and grows; every
  // OTHER face keeps its normal but its centroid/area shift (the top face grows
  // 800 -> 915, blowing past the old area-ratio gate). A verted(v) helper builds
  // a normal-carrying snapshot.
  const cos30 = Math.cos((30 * Math.PI) / 180) // 0.8660
  const sin30 = Math.sin((30 * Math.PI) / 180) // 0.5
  function snapN(centroid: [number, number, number], area: number, normal: [number, number, number]): GeometrySnapshot {
    return { type: 'plane', centroid, normal, area }
  }
  const priorSnapshots = new Map<string, GeometrySnapshot>([
    ['F1:BOX:xMin', snapN([0, 10, 5], 200, [-1, 0, 0])],
    ['F1:BOX:xMax', snapN([40, 10, 5], 200, [1, 0, 0])],
    ['F1:BOX:yMin', snapN([20, 0, 5], 400, [0, -1, 0])],
    ['F1:BOX:yMax', snapN([20, 20, 5], 400, [0, 1, 0])],
    ['F1:BOX:zMin', snapN([20, 10, 0], 800, [0, 0, -1])],
    ['F1:BOX:zMax', snapN([20, 10, 10], 800, [0, 0, 1])],
  ])
  const ids = [...priorSnapshots.keys()].sort()
  // POST-draft candidates (new hashes; edited +x face carries the tilted normal
  // + moved centroid + grown area).
  const candidates = [
    { hash: 901, snapshot: snapN([0, 10, 5], 200, [-1, 0, 0]) },                 // xMin unchanged
    { hash: 902, snapshot: snapN([42.89, 10, 5], 230.94, [cos30, 0, -sin30]) },  // xMax EDITED (normal tilted 30deg)
    { hash: 903, snapshot: snapN([22.89, 0, 5], 428.87, [0, -1, 0]) },           // yMin moved+grown
    { hash: 904, snapshot: snapN([22.89, 20, 5], 428.87, [0, 1, 0]) },           // yMax moved+grown
    { hash: 905, snapshot: snapN([20, 10, 0], 800, [0, 0, -1]) },                // zMin unchanged
    { hash: 906, snapshot: snapN([22.89, 10, 10], 915.47, [0, 0, 1]) },          // zMax moved+GREW 800->915
  ]
  const angleRad = (30 * Math.PI) / 180
  const motionBudget = Math.tan(angleRad) * 10 // = 5.7735 (maxDistToNeutral = 10)

  it('binds the edited face by its 30deg normal-rotation signature and moved neighbours by motion-aware tolerance', () => {
    const r = rebindDraftFaces(ids, priorSnapshots, candidates, { editedId: 'F1:BOX:xMax', angleRad, motionBudget })
    expect(r.unresolved).toEqual([])
    // edited +x face bound to the TILTED-normal candidate (902), not enumeration order.
    expect(r.faceMap.get(902)).toBe('F1:BOX:xMax')
    expect(r.snapshots.get('F1:BOX:xMax')!.normal[2]).toBeCloseTo(-sin30, 5)
    // the top face grew 800->915 (area ratio 1.14) and moved 2.89 -- both would
    // trip the OLD fixed-tolerance + area-ratio gate; motion-aware rebind keeps it.
    expect(r.faceMap.get(906)).toBe('F1:BOX:zMax')
    expect(r.snapshots.get('F1:BOX:zMax')!.area).toBeCloseTo(915.47, 2)
    // unchanged faces still bound correctly.
    expect(r.faceMap.get(901)).toBe('F1:BOX:xMin')
    expect(r.faceMap.get(905)).toBe('F1:BOX:zMin')
  })

  it('does NOT mistake an untouched face for the edited one (normal-direction gate)', () => {
    // If we (wrongly) declared zMax the edited face, its UNCHANGED normal (dot=1)
    // fails the "rotated by angleRad" test, so it is left unresolved rather than
    // silently accepted -- proving the edit signature actually gates.
    const r = rebindDraftFaces(ids, priorSnapshots, candidates, { editedId: 'F1:BOX:zMax', angleRad, motionBudget })
    expect(r.unresolved).toContain('F1:BOX:zMax')
  })

  it('reports an id as unresolved (never guesses) when its candidate is missing', () => {
    const sparse = candidates.filter((c) => c.hash !== 901) // xMin's candidate gone
    const r = rebindDraftFaces(ids, priorSnapshots, sparse, { editedId: 'F1:BOX:xMax', angleRad, motionBudget })
    expect(r.unresolved).toEqual(['F1:BOX:xMin'])
  })

  it('reports unresolved when a face moved BEYOND the motion budget (never silently mis-binds)', () => {
    // A candidate for xMin displaced far past tan(30)*10 with no other match.
    const farflung = candidates.map((c) => c.hash === 901 ? { hash: 901, snapshot: snapN([0, 10, 99], 200, [-1, 0, 0]) } : c)
    const r = rebindDraftFaces(ids, priorSnapshots, farflung, { editedId: 'F1:BOX:xMax', angleRad, motionBudget })
    expect(r.unresolved).toEqual(['F1:BOX:xMin'])
  })
})

describe('mintDiscriminatorKey + orderMintCandidates (GEO-6X6-R3)', () => {
  function snapN(centroid: [number, number, number], area: number, normal: [number, number, number], type: GeometrySnapshot['type'] = 'plane', axis?: [number, number, number]): GeometrySnapshot {
    return { type, centroid, normal, area, axis }
  }

  describe('mintDiscriminatorKey', () => {
    it('is stronger than compareSnapshots: two faces tied on centroid+area+type separate by normal', () => {
      const a = snapN([1, 2, 3], 50, [1, 0, 0])
      const b = snapN([1, 2, 3], 50, [0, 1, 0])
      expect(compareSnapshots(a, b)).toBe(0) // the OLD key sees these as tied
      expect(mintDiscriminatorKey(a)).not.toBe(mintDiscriminatorKey(b)) // the NEW key does not
    })
    it('folds in axis for axial types when present', () => {
      const a = snapN([1, 2, 3], 50, [0, 0, 1], 'cylinder', [1, 0, 0])
      const b = snapN([1, 2, 3], 50, [0, 0, 1], 'cylinder', [0, 1, 0])
      expect(mintDiscriminatorKey(a)).not.toBe(mintDiscriminatorKey(b))
    })
    it('is a true tie (identical key) when every field — including normal/axis — coincides', () => {
      const a = snapN([1, 2, 3], 50, [0, 0, 1], 'cylinder', [1, 0, 0])
      const b = snapN([1, 2, 3], 50, [0, 0, 1], 'cylinder', [1, 0, 0])
      expect(mintDiscriminatorKey(a)).toBe(mintDiscriminatorKey(b))
    })
    it('returns null (never a bogus key) when a field is non-finite — NaN cannot participate in ordering', () => {
      expect(mintDiscriminatorKey(snapN([NaN, 2, 3], 50, [1, 0, 0]))).toBeNull()
      expect(mintDiscriminatorKey(snapN([1, 2, 3], Infinity, [1, 0, 0]))).toBeNull()
      expect(mintDiscriminatorKey(snapN([1, 2, 3], 50, [1, 0, NaN]))).toBeNull()
      expect(mintDiscriminatorKey(snapN([1, 2, 3], 50, [0, 0, 1], 'cylinder', [1, NaN, 0]))).toBeNull()
    })
  })

  describe('orderMintCandidates', () => {
    it('empty input orders to empty, trivially', () => {
      const r = orderMintCandidates([])
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.ordered).toEqual([])
    })
    it('a single distinguishing field (normal) is enough for a deterministic order independent of ARRIVAL order', () => {
      const pA: FaceProbe = { hash: 1, snapshot: snapN([1, 2, 3], 50, [1, 0, 0]) }
      const pB: FaceProbe = { hash: 2, snapshot: snapN([1, 2, 3], 50, [0, 1, 0]) }
      const fwd = orderMintCandidates([pA, pB])
      const rev = orderMintCandidates([pB, pA])
      expect(fwd.ok).toBe(true)
      expect(rev.ok).toBe(true)
      if (fwd.ok && rev.ok) {
        // same ordered SEQUENCE of hashes regardless of input array order.
        expect(fwd.ordered.map((p) => p.hash)).toEqual(rev.ordered.map((p) => p.hash))
      }
    })
    it('structured-refuses (never guesses) a true total tie — two candidates identical on every discriminated field', () => {
      const pA: FaceProbe = { hash: 1, snapshot: snapN([1, 2, 3], 50, [1, 0, 0]) }
      const pB: FaceProbe = { hash: 2, snapshot: snapN([1, 2, 3], 50, [1, 0, 0]) }
      const r = orderMintCandidates([pA, pB])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/true total tie/)
    })
    it('structured-refuses (never crashes) when any candidate has a non-finite field', () => {
      const pA: FaceProbe = { hash: 1, snapshot: snapN([1, 2, 3], 50, [1, 0, 0]) }
      const pB: FaceProbe = { hash: 2, snapshot: snapN([NaN, 2, 3], 50, [0, 1, 0]) }
      const r = orderMintCandidates([pA, pB])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/non-finite/)
    })
    it('a 3-way tie is refused just like a 2-way tie (the check is not hard-coded to pairs)', () => {
      const same = snapN([4, 5, 6], 20, [0, 0, 1])
      const probes: FaceProbe[] = [1, 2, 3].map((hash) => ({ hash, snapshot: { ...same } }))
      const r = orderMintCandidates(probes)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/3 mint candidates/)
    })
  })
})

// ===========================================================================
// GEO-16 (ICR-3 step 2): two-face edge-id disambiguation + migration.
// ===========================================================================

const J = WORKER_EDGE_JOIN

/** A two-face base edge id `(A^B)` (faces sorted by edgeId itself). */
function base(a: string, b: string): string {
  return edgeId([a, b], '0')
}

function geom(mid: [number, number, number], length = 1): EdgeGeom {
  return { mid, length }
}

describe('GEO-16 edgeDisambToken', () => {
  it('is a pure function of the edge geometry, snapped to the 1e-7 grid', () => {
    const t = edgeDisambToken(geom([1, 2, 3], 5))
    expect(t).toBe(`m${snap(1)}_${snap(2)}_${snap(3)}_l${snap(5)}`)
    // sub-grid noise does not change the token (regeneration stability)
    expect(edgeDisambToken(geom([1 + 1e-9, 2, 3], 5))).toBe(t)
  })
  it('returns null for a non-finite geometry (never puts NaN in an id)', () => {
    expect(edgeDisambToken(geom([NaN, 0, 0], 1))).toBeNull()
    expect(edgeDisambToken(geom([0, 0, 0], NaN))).toBeNull()
  })
})

describe('GEO-16 disambiguateEdgeIds', () => {
  it('leaves a single-edge-per-pair id BYTE-IDENTICAL (zero migration common case)', () => {
    const ids = [base('A', 'B'), base('A', 'C'), `(A${J}seam#0)`]
    const geoms = [geom([0, 0, 0]), geom([1, 0, 0]), geom([2, 0, 0])]
    expect(disambiguateEdgeIds(ids, geoms)).toEqual(ids)
  })

  it('appends a geometric disambiguator to every member of a >=2 collision group -> all unique', () => {
    const pair = base('A', 'B')
    const ids = [pair, pair] // two physical edges collapse onto one pair
    const geoms = [geom([0, 0, 0], 1), geom([10, 0, 0], 2)]
    const out = disambiguateEdgeIds(ids, geoms)
    expect(new Set(out).size).toBe(2)
    for (const id of out) expect(id.startsWith(pair + EDGE_DISAMB_MARK)).toBe(true)
    // faces are preserved: each disambiguated id still starts with the base pair.
    expect(edgeIdBase(out[0])).toBe(pair)
    expect(edgeIdBase(out[1])).toBe(pair)
  })

  it('ADVERSARIAL >=3 on one face pair: mints unique + DETERMINISTIC under input reorder (two regenerations)', () => {
    const pair = base('A', 'B')
    const edges = [
      { g: geom([0, 0, 0], 1) },
      { g: geom([5, 0, 0], 2) },
      { g: geom([0, 7, 0], 3) },
      { g: geom([0, 0, 9], 4) },
    ]
    const idsA = disambiguateEdgeIds(edges.map(() => pair), edges.map((e) => e.g))
    expect(new Set(idsA).size).toBe(4) // all unique

    // "regenerate" with the kernel handing edges over in a DIFFERENT order:
    // each physical edge must mint the SAME id (order-independence).
    const order = [2, 0, 3, 1]
    const idsB = disambiguateEdgeIds(order.map(() => pair), order.map((i) => edges[i].g))
    order.forEach((origIndex, k) => expect(idsB[k]).toBe(idsA[origIndex]))
  })

  it('ATOMIC: a single null geom (one unreadable curve) leaves the WHOLE group at base, never a partial tag (auditor finding 1)', () => {
    const pair = base('A', 'B')
    const out = disambiguateEdgeIds([pair, pair], [geom([0, 0, 0]), null])
    // ATOMIC all-or-nothing: because ONE member had no token, NEITHER is tagged.
    // A partial tag ([pair@token, pair]) would make the bare base appear exactly
    // once, and resolvePersistedEdgeId would then bind an OLD BARE id 'exact' to
    // that lone survivor -- the prohibited silent wrong-binding.
    expect(out).toEqual([pair, pair])                     // whole group stays bare
    // Regression: the OLD persisted bare id resolved against this one-null group
    // must REFUSE (ambiguous), NEVER 'exact'.
    const r = resolvePersistedEdgeId(pair, out)
    expect(r.status).toBe('ambiguous')
    if (r.status !== 'ambiguous') throw new Error('unreachable')
    expect(r.count).toBe(2)
  })

  it('a within-group token TIE (or all-null) leaves members at BASE -> residual collision caught by the backstop', () => {
    const pair = base('A', 'B')
    // Geometrically indistinguishable pair (identical geom) -> refuse, never guess.
    const g = geom([1, 1, 1], 1)
    const tie = disambiguateEdgeIds([pair, pair], [g, g])
    expect(tie).toEqual([pair, pair])                     // neither disambiguated
    // Both stay bare, so the base now has multiplicity 2 -> the fail-closed
    // backstop fires on a pick of that id.
    expect(collidingPickedEdgeIds([pair], tie).length).toBe(1)
  })
})

describe('GEO-16 collidingPickedEdgeIds (fail-closed backstop, synthetic lists)', () => {
  const dup = base('A', 'B')
  const uniq = base('A', 'C')
  it('reports a requested id with candidate multiplicity >= 2, once, with its count', () => {
    const out = collidingPickedEdgeIds([dup], [dup, dup, uniq])
    expect(out).toEqual([{ id: dup, count: 2 }])
  })
  it('does not report a unique pick, nor a collision the caller did not pick', () => {
    expect(collidingPickedEdgeIds([uniq], [dup, dup, uniq])).toEqual([])
  })
  it('MUTATION LEVER: a guard that returned [] would pass a colliding pick (non-vacuous)', () => {
    // If the backstop were neutered to return [], this length would be 0 and the
    // consumer would last-wins-bind a twin -- the exact GEO-15 defect. Asserting
    // > 0 here fails on that mutation.
    expect(collidingPickedEdgeIds([dup], [dup, dup]).length).toBeGreaterThan(0)
  })
})

describe('GEO-16 resolvePersistedEdgeId (migration / compatibility)', () => {
  const pair = base('A', 'B')
  const t0 = edgeDisambToken(geom([0, 0, 0], 1))!
  const t1 = edgeDisambToken(geom([9, 0, 0], 2))!
  const d0 = `${pair}${EDGE_DISAMB_MARK}${t0}`
  const d1 = `${pair}${EDGE_DISAMB_MARK}${t1}`

  it('EXACT: a unique id present in the current list binds directly (byte-identical old->new common case)', () => {
    const uniq = base('A', 'C')
    expect(resolvePersistedEdgeId(uniq, [uniq, d0, d1])).toEqual({ status: 'exact', id: uniq })
    expect(resolvePersistedEdgeId(d0, [uniq, d0, d1])).toEqual({ status: 'exact', id: d0 })
  })

  it('AMBIGUOUS: an OLD BARE colliding id (never carried a disambiguator) refuses BY NAME, never a silent rebind', () => {
    const r = resolvePersistedEdgeId(pair, [d0, d1])
    expect(r.status).toBe('ambiguous')
    if (r.status !== 'ambiguous') throw new Error('unreachable')
    expect(r.base).toBe(pair)
    expect(r.count).toBe(2)
  })

  it('AMBIGUOUS: a residual collision (current list still has the id twice) refuses', () => {
    const r = resolvePersistedEdgeId(pair, [pair, pair])
    expect(r.status).toBe('ambiguous')
    if (r.status !== 'ambiguous') throw new Error('unreachable')
    expect(r.count).toBe(2)
  })

  it('MIGRATED: a persisted disambiguated id whose twin was removed upstream binds to the lone survivor', () => {
    // The colliding twin d1 is gone; the pair now owns exactly one edge (bare).
    expect(resolvePersistedEdgeId(d0, [pair])).toEqual({ status: 'migrated', id: pair })
  })

  it('LOST: a base pair with no current edge refuses (never guesses)', () => {
    const r = resolvePersistedEdgeId(d0, [base('X', 'Y')])
    expect(r.status).toBe('lost')
  })

  it('edgeIdBase strips only the disambiguator, leaving the pair intact', () => {
    expect(edgeIdBase(d0)).toBe(pair)
    expect(edgeIdBase(pair)).toBe(pair)
    expect(edgeIdBase('F1:BOX:zmax')).toBe('F1:BOX:zmax')
  })

  it('MALFORMED SUFFIX: edgeIdBase leaves a non-token suffix INTACT (no silent base reduction)', () => {
    // A tail that is not the EDGE_DISAMB_MARK token grammar must NOT be stripped;
    // otherwise `(A^B)garbage` collapses to `(A^B)` and mis-migrates onto a lone
    // current base-pair edge. Pre-fix edgeIdBase stripped every tail after ')'.
    expect(edgeIdBase(`${pair}garbage`)).toBe(`${pair}garbage`)
    expect(edgeIdBase(`${pair}${EDGE_DISAMB_MARK}notatoken`)).toBe(`${pair}${EDGE_DISAMB_MARK}notatoken`)
    // ...but a well-formed @token IS still stripped.
    expect(edgeIdBase(d0)).toBe(pair)
  })

  it('MALFORMED SUFFIX: a garbage-suffixed id NEVER migrates onto a lone base-pair edge -> refuses (lost)', () => {
    // The migrate trap: the pair owns exactly one current bare edge. Pre-fix,
    // `(A^B)garbage` reduced to `(A^B)`, found that single edge, and bound
    // 'migrated' -- a guessed rebind. Now it refuses BY NAME.
    const r = resolvePersistedEdgeId(`${pair}garbage`, [pair])
    expect(r.status).toBe('lost')
  })
})
