// GEO-14 — the fail-closed contract for defeature.ts.
// =====================================================================
// Two audit-driven guarantees, each proved with a fault the harness INJECTS (a probe
// that cannot fail is not a gate — WORKER-CHARTER bar 1):
//
//  ITEM 1 (GEO-13 held major, coordination/reports/GEO-13.audit.json finding #1):
//    reconcileSpliceLoop reads each splice edge's endpoints through the kernel
//    (getSubShapes('vertex') + vertexPosition). Pre-fix those reads sat in an unguarded
//    Array.map, so a kernel read fault ESCAPED healRemoval as an exception instead of the
//    named refusal the work order promises, and vertex handles acquired before a
//    vertexPosition fault missed their release. This pins: BOTH fault points return a NAMED
//    'splice edge vertices unreadable' refusal (never throw), and EVERY acquired vertex
//    handle is released (asserted release count on the mock) — including on the success path.
//    MUTATION ANCHOR: reverting reconcileSpliceLoop to the unguarded `edges.map(...)` makes
//    every case in this block throw out of the call -> the block fails. See
//    coordination/evidence/GEO-14/item1-exception-boundary.pre-mutation.ts and
//    coordination/reports/GEO-14.report.json (item 1 mutation proof).
//
//  ITEM 2 (BK-96 core, the fail-open 'other' inversion GEO-6X5 closed for blends):
//    FaceRec.type === 'other' means gatherFaces()'s surfaceType() call THREW — an UNREAD
//    type, since the kernel names every surface it recognizes (plane/cylinder/cone/sphere/
//    bspline/…). The hole recognizer must not silently treat an unread face inside a bore
//    footprint as an ordinary non-member and heal around it. This forces a real bore wall to
//    read 'other' (surfaceType throws for it) and pins the NAMED hole refusal.
//    MUTATION ANCHOR: deleting the `unread` guard in recognizeFeatures makes the faulted
//    counterbore recognize as a removable hole again -> the refusal assertion fails.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle, Vec3 } from 'occt-wasm'
import { recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs, __geo14internals } from '../../geom/worker/defeature.ts'

const { reconcileSpliceLoop } = __geo14internals
function releaseAll(k: OcctKernel, hs: ShapeHandle[]): void { for (const h of hs) { try { k.release(h) } catch { /* */ } } }

// ---------------------------------------------------------------------------
// ITEM 1 — reconcileSpliceLoop exception boundary (pure mock kernel).
// ---------------------------------------------------------------------------
// A 4-edge square: edge handle i (0..3) runs corner i -> corner (i+1)%4; each corner is a
// vertex handle == corner id, positioned at P[id]. getSubShapes(i,'vertex') returns the two
// corner handles; vertexPosition(v) returns P[v]. A clean run reconciles to one degree-2
// loop AND releases all 8 acquired vertex handles. Faults are injected per-read.
describe('GEO-14 item 1 — reconcileSpliceLoop fails CLOSED on unreadable splice edges', () => {
  const P: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 2, z: 0 }, { x: 0, y: 2, z: 0 }]
  const EDGES = [0, 1, 2, 3] as unknown as ShapeHandle[]
  // opts.subShapesThrowOn: edge handle whose getSubShapes('vertex') throws.
  // opts.vertexThrowOn:    vertex handle whose vertexPosition throws.
  function mock(opts: { subShapesThrowOn?: number; vertexThrowOn?: number }): { k: OcctKernel; released: number[] } {
    const released: number[] = []
    const k = {
      getSubShapes: (h: ShapeHandle, type: string): ShapeHandle[] => {
        if (type !== 'vertex') return []
        const e = h as unknown as number
        if (opts.subShapesThrowOn === e) throw new Error('mock: getSubShapes(vertex) read fault')
        return [e as unknown as ShapeHandle, ((e + 1) % 4) as unknown as ShapeHandle]   // [start, end] corner handles
      },
      vertexPosition: (v: ShapeHandle): Vec3 => {
        const id = v as unknown as number
        if (opts.vertexThrowOn === id) throw new Error('mock: vertexPosition read fault')
        return P[id]
      },
      release: (v: ShapeHandle): void => { released.push(v as unknown as number) },
    } as unknown as OcctKernel
    return { k, released }
  }

  it('CONTROL: a clean 4-edge square reconciles to ONE loop and releases every acquired vertex handle', () => {
    const { k, released } = mock({})
    const r = reconcileSpliceLoop(k, EDGES)
    expect(r.ok, r.ok ? '' : r.reason).toBe(true)
    if (r.ok) expect(r.edges.length, 'all four edges kept').toBe(4)
    // 4 edges x 2 vertices, released in `finally` on every edge (success path too).
    expect(released.length, 'all 8 acquired vertex handles released').toBe(8)
  })

  it('getSubShapes(vertex) throw -> NAMED refusal, no exception escapes, no leak (nothing acquired on that edge)', () => {
    const { k, released } = mock({ subShapesThrowOn: 2 })   // edge 2's vertex read faults
    const r = reconcileSpliceLoop(k, EDGES)                 // MUST NOT throw
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason, 'the named fail-closed refusal').toContain('splice edge vertices unreadable')
    // edges 0,1 fully read+released (4); edge 2 acquired nothing (getSubShapes threw first).
    expect(released.length, 'edges 0,1 released; the faulting edge acquired no handle').toBe(4)
  })

  it('vertexPosition throw AFTER getSubShapes -> NAMED refusal AND the faulting edge\'s handles are released (finally)', () => {
    // Edge 2 returns vertices [2,3]; vertexPosition(3) (its end read) throws. The two handles
    // it already opened MUST be released by the finally — the leak the audit named.
    const { k, released } = mock({ vertexThrowOn: 3 })
    const r = reconcileSpliceLoop(k, EDGES)                 // MUST NOT throw
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('splice edge vertices unreadable')
    // edges 0,1 -> 4 releases; edge 2 opened [2,3] then faulted -> finally releases BOTH.
    expect(released.includes(2) && released.includes(3), 'the faulting edge\'s two handles are released in finally').toBe(true)
    expect(released.length, '4 (edges 0,1) + 2 (faulting edge, released in finally) = 6; edge 3 never reached').toBe(6)
  })
})

// ---------------------------------------------------------------------------
// ITEM 2 — BK-96 fail-open sweep: an unread bore wall refuses the hole BY NAME.
// ---------------------------------------------------------------------------
// The heal-counterbore-regression fixture (60x40x15 box, d20 counterbore + d3 pilot) has TWO
// concentric bore CYLINDERS. A Proxy makes surfaceType() throw for the FIRST cylinder it is
// asked about, so gatherFaces tags exactly that bore wall 'other'. The second cylinder still
// populates `bore`, so the seed is a live hole — and an unread face sits in its footprint.
describe('GEO-14 item 2 — an UNREAD bore wall (surfaceType threw) refuses the hole by name (BK-96)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { (k as unknown as Disposable)[Symbol.dispose]() } catch { /* */ } })

  // Build the drilled body once per test (kernel session is reused, shapes are per-test).
  function drilledCounterbore(): { drilled: ShapeHandle; box: ShapeHandle } {
    const box = k.makeBox(60, 40, 15)
    const cbore = k.translate(k.makeCylinder(10, 5), 30, 20, 11)
    const pilot = k.translate(k.makeCylinder(3, 11), 30, 20, 5)
    const drilled = k.cut(k.cut(box, cbore), pilot)
    return { drilled, box }
  }

  // Proxy whose surfaceType throws the FIRST time it would return 'cylinder' (one bore wall
  // -> 'other'); everything else is the real kernel. gatherFaces swallows the throw (line 477).
  function faultFirstCylinder(base: OcctKernel): OcctKernel {
    let thrown = false
    return new Proxy(base, {
      get(t, prop) {
        if (prop === 'surfaceType') return (f: ShapeHandle): string => {
          const real = (t as OcctKernel).surfaceType(f)
          if (!thrown && real === 'cylinder') { thrown = true; throw new Error('mock: surfaceType read fault on a bore wall') }
          return real
        }
        const v = Reflect.get(t, prop, t)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    }) as unknown as OcctKernel
  }

  it('CONTROL: with every face readable, the counterbore recognizes as a REMOVABLE hole (no refusal)', () => {
    const { drilled, box } = drilledCounterbore()
    const recs = gatherFaces(k, drilled)
    try {
      const feats = recognizeFeatures(k, drilled, recs)
      const removableHoles = feats.filter((f) => f.removable && (f.type === 'counterboreStack' || f.type === 'blindHole' || f.type === 'throughHole'))
      expect(removableHoles.length, 'the drilled counterbore is a removable hole when readable').toBeGreaterThanOrEqual(1)
      const unreadRefusals = feats.filter((f) => !f.removable && (f.refuseReason ?? '').includes('unreadable'))
      expect(unreadRefusals.length, 'no unread-face refusal when every surface reads').toBe(0)
      // premise assertion: the fixture really has >= 2 bore cylinders, so faulting one leaves
      // the seed a live hole (otherwise the item-2 case below would trivially `continue`).
      const cyls = recs.filter((r) => r.type === 'cylinder')
      expect(cyls.length, 'the counterbore fixture exposes >= 2 bore cylinders').toBeGreaterThanOrEqual(2)
    } finally {
      releaseFaceRecs(k, recs)
      try { k.release(drilled) } catch { /* */ }
      try { k.release(box) } catch { /* */ }
    }
  }, 120_000)

  it('#bk96-hole one bore wall reads \'other\' -> the hole REFUSES BY NAME instead of healing around it', () => {
    const { drilled, box } = drilledCounterbore()
    const pk = faultFirstCylinder(k)
    const recs = gatherFaces(pk, drilled)   // exactly one cylinder wall is now 'other'
    try {
      expect(recs.some((r) => r.type === 'other'), 'exactly the faulted bore wall is unread').toBe(true)
      const feats = recognizeFeatures(pk, drilled, recs)
      // The named refusal exists AND no removable hole verdict heals over that footprint.
      const refusal = feats.find((f) => !f.removable && (f.refuseReason ?? '').includes('unreadable'))
      expect(refusal, 'an unread face in the bore footprint refuses the hole by name').toBeDefined()
      expect(refusal!.refuseReason, 'the refusal names WHERE the unread face is').toContain('bore footprint')
      const removableHoleThere = feats.filter((f) => f.removable && (f.type === 'counterboreStack' || f.type === 'blindHole' || f.type === 'throughHole'))
      expect(removableHoleThere.length, 'the hole does NOT heal around the unread wall').toBe(0)
    } finally {
      releaseFaceRecs(k, recs)
      try { k.release(drilled) } catch { /* */ }
      try { k.release(box) } catch { /* */ }
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// ITEM 5 — DUAL-FAULT e2e (BK-110 c): both the shoulder UV read AND its later outerWire
// read fail on ONE built FaceRec, and the heal still fails CLOSED by name.
// ---------------------------------------------------------------------------
// The counterbore shoulder (annular plane at z=11 between the d20 and d3 bores) is read TWICE
// on the heal path: gatherFaces reads its UV (uvBounds -> normal/planeExtent), and
// recognizeFeatures reads its outer wire (capRadialExtent -> capWithinFootprint). A Proxy
// faults BOTH reads for that one face. With the shoulder's radial extent unprovable it is
// EXCLUDED from the cap set (capRadialExtent fails closed to Infinity), so it is NOT dropped;
// left in the sew set it closes an OPEN shell. The FINAL watertight+finite gate in healRemoval
// must refuse BY NAME — no invalid/open solid escapes even with two independent reads down on
// the same face. MUTATION ANCHOR (acceptance criterion 5): weakening that gate to always pass
// makes this heal return ok:true with the open shell -> the refusal assertion fails. See
// coordination/evidence/GEO-14/item5-mutation-proof.log.
describe('GEO-14 item 5 — dual-fault e2e: shoulder UV + outerWire both fail -> named refusal', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { (k as unknown as Disposable)[Symbol.dispose]() } catch { /* */ } })

  function drilledCounterbore(): { drilled: ShapeHandle; box: ShapeHandle } {
    const box = k.makeBox(60, 40, 15)
    const cbore = k.translate(k.makeCylinder(10, 5), 30, 20, 11)
    const pilot = k.translate(k.makeCylinder(3, 11), 30, 20, 5)
    const drilled = k.cut(k.cut(box, cbore), pilot)
    return { drilled, box }
  }

  // Proxy: uvBounds AND outerWire throw for the SHOULDER only — identified by geometry (a
  // horizontal plane at z=11), so it is robust to face-handle instance churn across calls.
  function faultShoulderReads(base: OcctKernel): { pk: OcctKernel; uvFaults: () => number; wireFaults: () => number } {
    let uv = 0, wire = 0
    const isShoulder = (f: ShapeHandle): boolean => {
      let bb: { zmin: number; zmax: number }
      try { bb = base.getBoundingBox(f, false) } catch { return false }
      return Math.abs(bb.zmin - 11) < 1e-6 && Math.abs(bb.zmax - 11) < 1e-6   // the z=11 counterbore ledge
    }
    const pk = new Proxy(base, {
      get(t, prop) {
        if (prop === 'uvBounds') return (f: ShapeHandle) => { if (isShoulder(f)) { uv++; throw new Error('mock: shoulder UV read fault') } return (t as OcctKernel).uvBounds(f) }
        if (prop === 'outerWire') return (f: ShapeHandle) => { if (isShoulder(f)) { wire++; throw new Error('mock: shoulder outerWire read fault') } return (t as OcctKernel).outerWire(f) }
        const v = Reflect.get(t, prop, t)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    }) as unknown as OcctKernel
    return { pk, uvFaults: () => uv, wireFaults: () => wire }
  }

  it('CONTROL: with both reads intact, the counterbore heals to a valid watertight solid', () => {
    const { drilled, box } = drilledCounterbore()
    const recs = gatherFaces(k, drilled); const scratch: ShapeHandle[] = []
    try {
      const feats = recognizeFeatures(k, drilled, recs)
      const cb = feats.filter((f) => f.removable && f.type === 'counterboreStack')
      expect(cb.length, 'the counterbore is recognized when reads are intact').toBe(1)
      const heal = healRemoval(k, drilled, cb, scratch, recs)
      expect(heal.ok, `control heals: ${heal.reason ?? ''}`).toBe(true)
      expect(k.isSolid(heal.shape!) && k.isValid(heal.shape!), 'control is a valid solid').toBe(true)
    } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(drilled) } catch { /* */ }; try { k.release(box) } catch { /* */ } }
  }, 120_000)

  it('#dualfault the shoulder\'s UV read AND outerWire read both fail -> heal REFUSES BY NAME (no open shell escapes)', () => {
    const { drilled, box } = drilledCounterbore()
    const { pk, uvFaults, wireFaults } = faultShoulderReads(k)
    const recs = gatherFaces(pk, drilled)          // shoulder UV read faults HERE (built FaceRec, normal lost)
    const scratch: ShapeHandle[] = []
    try {
      const feats = recognizeFeatures(pk, drilled, recs)   // shoulder outerWire read faults HERE (capRadialExtent)
      // both independent reads on the ONE shoulder face actually fired:
      expect(uvFaults(), 'the shoulder UV read was faulted at gather time').toBeGreaterThanOrEqual(1)
      expect(wireFaults(), 'the shoulder outerWire read was faulted at recognition time').toBeGreaterThanOrEqual(1)
      // whichever way the shoulder-less recognition lands, the heal MUST NOT emit a solid:
      // the shoulder, excluded from the cap set, is left in the sew set and closes an open shell.
      const holes = feats.filter((f) => f.removable && (f.type === 'counterboreStack' || f.type === 'blindHole' || f.type === 'throughHole'))
      const heal = healRemoval(pk, drilled, holes, scratch, recs)
      expect(heal.ok, 'the dual-faulted heal fails closed (no valid solid)').toBe(false)
      expect(heal.reason, 'the final watertight+finite gate names the refusal').toContain('watertight solid with finite data')
    } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(drilled) } catch { /* */ }; try { k.release(box) } catch { /* */ } }
  }, 120_000)
})
