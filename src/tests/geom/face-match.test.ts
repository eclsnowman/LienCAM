// GEO-6X6 (BK-91) — the factored face-lineage matcher, enumerated path by path.
//
// The spec-level invariant: every final face gets exactly one id, every original
// id is matched-or-deleted, and ids move ONLY along a verified match. There are
// five terminal paths and this file gates each one by name:
//
//   exact                     -> #p1
//   plane-fallback-unique     -> #p2
//   plane-fallback-nearest    -> #p3
//   plane-fallback-refused    -> #p4   (ambiguous; mint + delete, never mis-bind)
//   no-hit-mint               -> #p5
//   orig-leftover-delete      -> #p6
//
// plus the three properties the WO enumerates (#c1 kept faces never re-mint,
// #c2 rebuilt planar faces keep their id, #c3 coplanar twins never steal ids)
// and order-independence (#c4).
import { describe, it, expect } from 'vitest'
import { matchFacesToOriginals, exactMatchKey, planeSupportKey } from '../../geom/worker/geom-engine.ts'
import type { OrigFace } from '../../geom/worker/geom-engine.ts'
import type { FaceProbe, GeometrySnapshot } from '../../geom/worker/internal-types.ts'
import type { StableId } from '../../geom/geom-service.ts'

/** A +Z planar face: centroid (x,y,z), given area. */
function plane(x: number, y: number, z: number, area: number, n: [number, number, number] = [0, 0, 1]): GeometrySnapshot {
  return { type: 'plane', centroid: [x, y, z], normal: n, area }
}
function cyl(x: number, y: number, z: number, area: number): GeometrySnapshot {
  return { type: 'cylinder', centroid: [x, y, z], normal: [1, 0, 0], area, axis: [0, 0, 1] }
}
let nextHash = 1
function probe(s: GeometrySnapshot): FaceProbe { return { hash: nextHash++, snapshot: s } }
function orig(id: string, s: GeometrySnapshot): OrigFace { return { id: id as StableId, snap: s } }

/** id -> path, for terse assertions. */
function pathsById(r: ReturnType<typeof matchFacesToOriginals>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of r.matches) out[m.id] = m.path
  return out
}

describe('GEO-6X6 matchFacesToOriginals — every match path', () => {
  // ---- keys -----------------------------------------------------------
  it('#k1 exactMatchKey separates two coplanar faces that the plane key collides', () => {
    const a = plane(10, 10, 18, 100)
    const b = plane(40, 10, 18, 100)
    // the pre-fix key: identical for both -> the collision BK-91 is about.
    expect(planeSupportKey(a)).toBe(planeSupportKey(b))
    expect(planeSupportKey(a)).toBe('P|0|0|1|18')
    // the exact key: distinct.
    expect(exactMatchKey(a)).not.toBe(exactMatchKey(b))
  })

  it('#k2 planeSupportKey is null for non-planar faces (no loose fallback exists for them)', () => {
    expect(planeSupportKey(cyl(0, 0, 0, 50))).toBeNull()
    expect(planeSupportKey(plane(1, 2, 3, 4))).not.toBeNull()
  })

  it('#k3 exactMatchKey: a stray axis on a sphere does not change the key (GEO-6X6-R2 minor)', () => {
    // GeometrySnapshot.axis is optional on every type, but only cylinder/cone/
    // torus are meant to consume it (the doc table above). A sphere carrying an
    // axis field (never set by production #probeFace today, but type-legal)
    // must key identically with and without it -- pre-fix, exactMatchKey read
    // `s.axis ?? [0,0,0]` for ANY non-plane type, so a stray axis silently
    // changed a sphere's key and split what should have been one exact bucket.
    const sphereNoAxis: GeometrySnapshot = { type: 'sphere', centroid: [4, 5, 6], normal: [1, 0, 0], area: 33 }
    const sphereWithAxis: GeometrySnapshot = { ...sphereNoAxis, axis: [0, 1, 0] }
    expect(exactMatchKey(sphereWithAxis)).toBe(exactMatchKey(sphereNoAxis))
    // sanity: a real axial type's key DOES still change with its axis.
    const cylA = cyl(4, 5, 6, 33), cylB: GeometrySnapshot = { ...cylA, axis: [0, 1, 0] }
    expect(exactMatchKey(cylB)).not.toBe(exactMatchKey(cylA))
  })

  // ---- path 1: exact --------------------------------------------------
  it('#p1 exact: a byte-identical KEPT face of any surface type matches by exact key', () => {
    const pl = plane(5, 5, 12, 60), cy = cyl(30, 15, 6, 90)
    const r = matchFacesToOriginals(
      [orig('F1:BOX:zMax', pl), orig('H:CYL:wall', cy)],
      [probe({ ...pl }), probe({ ...cy })],
    )
    expect(r.paths.exact).toBe(2)
    expect(pathsById(r)).toEqual({ 'F1:BOX:zMax': 'exact', 'H:CYL:wall': 'exact' })
    expect(r.mintProbes).toEqual([])
    expect(r.remainingOrig).toEqual([])
  })

  // ---- the auditor's major: exact-key multiplicity must never order-bind ----
  it('#p1b exact: two coplanar same-centroid/area planes with DIFFERENT normals bind correctly in both probe orders (auditor repro)', () => {
    // Identical type/centroid/area, normals +X and +Z — pre-fix, exactMatchKey
    // never read plane normal (it read `axis`, which planes never set), so
    // these collided into one bucket and bound by probe arrival order.
    const nx = plane(10, 10, 18, 100, [1, 0, 0])
    const nz = plane(10, 10, 18, 100, [0, 0, 1])
    expect(exactMatchKey(nx)).not.toBe(exactMatchKey(nz))
    const run = (probes: FaceProbe[]): Record<string, number> => {
      const r = matchFacesToOriginals([orig('X_FACE', nx), orig('Z_FACE', nz)], probes)
      expect(r.paths).toMatchObject({ exact: 2, noHitMint: 0, origLeftoverDelete: 0 })
      const out: Record<string, number> = {}
      for (const m of r.matches) out[m.id] = m.probe.hash
      return out
    }
    const px = probe({ ...nx }), pz = probe({ ...nz })
    // id -> probe-HASH binding (not geometry-key text), in both probe orders.
    expect(run([px, pz])).toEqual({ X_FACE: px.hash, Z_FACE: pz.hash })
    expect(run([pz, px])).toEqual({ X_FACE: px.hash, Z_FACE: pz.hash })
  })

  it('#p1c exact-key multiplicity (genuinely identical duplicates) refuses deterministically, never order-bound', () => {
    // Byte-identical coincident duplicates: both origs AND both probes share one
    // exact key. Cardinality is 2 on both sides, so pass 1 must defer the whole
    // bucket rather than bind by arrival/sort order. It falls to the plane
    // fallback, where every pairwise centroid distance is 0 (tied) -> refused.
    const mk = (): GeometrySnapshot => plane(20, 20, 18, 100)
    const run = (origOrder: OrigFace[], probeOrder: FaceProbe[]) => matchFacesToOriginals(origOrder, probeOrder)
    const o1 = orig('DUP_A', mk()), o2 = orig('DUP_B', mk())
    const p1 = probe(mk()), p2 = probe(mk())
    const forward = run([o1, o2], [p1, p2])
    const reversed = run([o2, o1], [p2, p1])
    expect(forward.matches).toEqual([])
    expect(reversed.matches).toEqual([])
    expect(forward.paths).toMatchObject({ exact: 0, planeFallbackRefused: 2, noHitMint: 2, origLeftoverDelete: 2 })
    expect(reversed.paths).toEqual(forward.paths)
    expect(reversed.remainingOrig.map((o) => o.id).sort()).toEqual(forward.remainingOrig.map((o) => o.id).sort())
  })

  // ---- path 2: plane-fallback-unique ----------------------------------
  it('#p2 plane-fallback-unique: a REBUILT planar face (area+centroid moved, same support) keeps its id', () => {
    const before = plane(30, 15, 12, 600)          // top face, holed
    const after = plane(31, 16, 12, 640)           // untrimmed: area up, centroid moved, SAME plane z=12
    const r = matchFacesToOriginals([orig('F1:BOX:zMax', before)], [probe(after)])
    expect(r.paths).toMatchObject({ exact: 0, planeFallbackUnique: 1, noHitMint: 0, origLeftoverDelete: 0 })
    expect(pathsById(r)['F1:BOX:zMax']).toBe('plane-fallback-unique')
  })

  // ---- path 3: plane-fallback-nearest (ambiguous, resolved) -----------
  it('#p3 plane-fallback-nearest: two coplanar REBUILT faces resolve by mutual-nearest centroid, no swap', () => {
    const a0 = plane(10, 10, 18, 100), b0 = plane(40, 10, 18, 100)   // two pad tops, coplanar
    const a1 = plane(10, 10, 18, 120), b1 = plane(40, 10, 18, 130)   // both untrimmed (area up, centroid put)
    const r = matchFacesToOriginals([orig('PAD_A', a0), orig('PAD_B', b0)], [probe(a1), probe(b1)])
    expect(r.paths).toMatchObject({ exact: 0, planeFallbackNearest: 2, planeFallbackRefused: 0 })
    // the binding is the CORRECT one, not a swap: each id took the probe at its own centroid.
    const byId = new Map(r.matches.map((m) => [m.id, m.probe.snapshot]))
    expect(byId.get('PAD_A')!.area).toBe(120)
    expect(byId.get('PAD_B')!.area).toBe(130)
    expect(r.mintProbes).toEqual([])
    expect(r.remainingOrig).toEqual([])
  })

  it('#p3b plane-fallback-nearest: 2 origs, 1 probe -> nearest orig binds, the other is deleted', () => {
    const r = matchFacesToOriginals(
      [orig('NEAR', plane(10, 0, 5, 50)), orig('FAR', plane(90, 0, 5, 50))],
      [probe(plane(12, 0, 5, 70))],
    )
    expect(pathsById(r)).toEqual({ NEAR: 'plane-fallback-nearest' })
    expect(r.remainingOrig.map((o) => o.id)).toEqual(['FAR'])
    expect(r.paths.origLeftoverDelete).toBe(1)
  })

  // ---- path 4: plane-fallback-refused (ambiguous, unresolvable) -------
  it('#p4 plane-fallback-refused: a TIE refuses rather than mis-bind — probe minted, both origs deleted', () => {
    // one probe exactly equidistant from two coplanar originals. Breaking this
    // tie by iteration order is precisely the BK-91 bug; the rule refuses.
    const r = matchFacesToOriginals(
      [orig('LEFT', plane(0, 0, 5, 50)), orig('RIGHT', plane(10, 0, 5, 50))],
      [probe(plane(5, 0, 5, 70))],
    )
    expect(r.matches).toEqual([])
    expect(r.paths).toMatchObject({ planeFallbackRefused: 1, noHitMint: 1, origLeftoverDelete: 2 })
    expect(r.remainingOrig.map((o) => o.id).sort()).toEqual(['LEFT', 'RIGHT'])
  })

  it('#p4b refusal is symmetric: 1 orig equidistant from 2 probes -> nothing binds', () => {
    const r = matchFacesToOriginals(
      [orig('MID', plane(5, 0, 5, 50))],
      [probe(plane(0, 0, 5, 70)), probe(plane(10, 0, 5, 70))],
    )
    expect(r.matches).toEqual([])
    expect(r.paths).toMatchObject({ planeFallbackRefused: 1, noHitMint: 2, origLeftoverDelete: 1 })
  })

  // ---- path 5 / 6: mint + delete --------------------------------------
  it('#p5 no-hit-mint: a genuinely new face on an unshared support is minted', () => {
    const r = matchFacesToOriginals([orig('F1:BOX:zMax', plane(0, 0, 12, 60))], [probe(cyl(5, 5, 3, 20))])
    expect(r.matches).toEqual([])
    expect(r.paths).toMatchObject({ noHitMint: 1, origLeftoverDelete: 1 })
    expect(r.mintProbes.length).toBe(1)
  })

  it('#p6 orig-leftover-delete: a removed face leaves its id unmatched', () => {
    const kept = plane(0, 0, 12, 60)
    const r = matchFacesToOriginals(
      [orig('KEPT', kept), orig('GONE', cyl(5, 5, 3, 20))],
      [probe({ ...kept })],
    )
    expect(pathsById(r)).toEqual({ KEPT: 'exact' })
    expect(r.remainingOrig.map((o) => o.id)).toEqual(['GONE'])
  })

  // ---- the three WO properties ----------------------------------------
  it('#c1 property 1: a kept face matches EXACT before any loose key is consulted', () => {
    // KEPT pad A and REBUILT pad B share a support. Pre-fix, whichever probe came
    // first won the single map slot. Now A is claimed exactly and B falls back.
    const a = plane(10, 10, 18, 100)
    const b0 = plane(40, 10, 18, 100), b1 = plane(40, 10, 18, 140)
    const r = matchFacesToOriginals([orig('PAD_A', a), orig('PAD_B', b0)], [probe(b1), probe({ ...a })])
    expect(pathsById(r)).toEqual({ PAD_A: 'exact', PAD_B: 'plane-fallback-unique' })
    expect(r.paths.noHitMint).toBe(0)
  })

  it('#c2 property 2: the plane-support fallback survives — rebuilt planes are NOT re-minted', () => {
    const r = matchFacesToOriginals(
      [orig('F1:BOX:zMax', plane(30, 15, 12, 600))],
      [probe(plane(30, 15, 12, 707))],       // untrimmed: area changed only
    )
    expect(r.paths.planeFallbackUnique).toBe(1)
    expect(r.paths.noHitMint).toBe(0)
    expect(r.paths.origLeftoverDelete).toBe(0)
  })

  it('#c3 property 3: two DISTINCT coplanar kept faces never steal each other ids', () => {
    const a = plane(10, 10, 18, 100), b = plane(40, 10, 18, 100)
    expect(planeSupportKey(a)).toBe(planeSupportKey(b))     // the collision is real
    const r = matchFacesToOriginals(
      [orig('PAD_A', a), orig('PAD_B', b)],
      [probe({ ...b }), probe({ ...a })],                    // deliberately reversed
    )
    const byId = new Map(r.matches.map((m) => [m.id, m.probe.snapshot.centroid[0]]))
    expect(byId.get('PAD_A')).toBe(10)
    expect(byId.get('PAD_B')).toBe(40)
    expect(r.paths.exact).toBe(2)
    expect(r.paths.noHitMint).toBe(0)
    expect(r.paths.origLeftoverDelete).toBe(0)
  })

  it('#c4 determinism: the assignment is independent of input order, including a colliding exact bucket', () => {
    // O4/O5 are a genuinely identical coincident duplicate pair (same exact key,
    // multiplicity 2 on both sides) folded into the same batch as the ordinary
    // exact/rebuilt/untouched fixtures, so this test covers WO item 3(c): a
    // colliding exact bucket must not perturb the deterministic outcome of the
    // rest of the batch, and must itself resolve identically in both orders.
    const dup = plane(70, 70, 5, 45, [0, 1, 0])
    const snaps = [plane(10, 10, 18, 100), plane(40, 10, 18, 100), plane(30, 15, 12, 600), cyl(0, 0, 5, 33), dup, dup]
    const origs = snaps.map((s, i) => orig(`O${i}`, s))
    const rebuiltTop = plane(30, 15, 12, 640)
    const mk = (): FaceProbe[] => [
      probe({ ...snaps[0] }), probe({ ...snaps[1] }), probe(rebuiltTop), probe({ ...snaps[3] }),
      probe({ ...dup }), probe({ ...dup }),
    ]
    const forward = matchFacesToOriginals(origs, mk())
    const reversed = matchFacesToOriginals([...origs].reverse(), mk().reverse())
    const sig = (r: ReturnType<typeof matchFacesToOriginals>): string => {
      const matched = r.matches.map((m) => `${m.id}=${m.path}@${m.probe.snapshot.centroid.join(',')}/${m.probe.snapshot.area}`).sort().join(';')
      const minted = r.mintProbes.map((p) => `${p.snapshot.centroid.join(',')}/${p.snapshot.area}`).sort().join(';')
      const deleted = r.remainingOrig.map((o) => o.id).sort().join(';')
      return `${matched}||mint:${minted}||delete:${deleted}`
    }
    expect(sig(reversed)).toBe(sig(forward))
    expect(forward.paths).toEqual(reversed.paths)
    // the duplicate pair itself: refused (not bound), both orders agree.
    expect(forward.paths.planeFallbackRefused).toBe(2)
    expect(['O4', 'O5'].every((id) => forward.remainingOrig.some((o) => o.id === id))).toBe(true)
  })

  it('#c5 every face on both sides lands in exactly one terminal path (fail-closed census)', () => {
    const r = matchFacesToOriginals(
      [
        orig('KEPT', plane(0, 0, 12, 60)),                 // -> exact
        orig('REBUILT', plane(50, 0, 12, 60)),             // -> plane-fallback (shares KEPT's support)
        orig('GONE', cyl(5, 5, 3, 20)),                    // -> delete
      ],
      [probe(plane(0, 0, 12, 60)), probe(plane(50, 0, 12, 80)), probe(cyl(9, 9, 9, 11))],
    )
    const p = r.paths
    // origs: exact + planeUnique + planeNearest + leftover == 3
    expect(p.exact + p.planeFallbackUnique + p.planeFallbackNearest + p.origLeftoverDelete).toBe(3)
    // probes: exact + planeUnique + planeNearest + mint == 3
    expect(p.exact + p.planeFallbackUnique + p.planeFallbackNearest + p.noHitMint).toBe(3)
    expect(r.matches.length).toBe(p.exact + p.planeFallbackUnique + p.planeFallbackNearest)
  })
})
