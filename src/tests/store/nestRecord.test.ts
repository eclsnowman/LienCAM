// Nesting store actions (ADR 0024 P3.1: model + worker + store actions). These
// tests prove the STORE STATE LOGIC directly — the Web Worker is the app transport
// and is NOT spawned in the headless test env (createNest guards on `typeof
// Worker`). The node-testable seam is the engine's pure runNest(request) (which the
// worker also calls) plus the store's applyNestResult writer: a test runs runNest
// in-node, then writes the result through applyNestResult, exactly as the worker
// completion does in the browser.
//
// Coverage:
//  - createNest DEEP-COPIES each source into an OWNED SEED (ownerNestId set, NONE
//    stock) and references the COPY (ADR 0025 §2 deep-copy seed model); the
//    pre-existing original is untouched + independent; a fresh modal import passed
//    in consumeSourceIds is deleted after copying;
//  - rename / setVisible / remove (removeNest deletes owned seeds);
//  - edit/cancel correctness (Accept removes original+its seeds; Cancel removes
//    provisional+its seeds);
//  - persistence round-trip (persistPartialize -> a Project blob preserves nests);
//  - determinism of stored placements (same inputs + seed -> equal placements).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, persistPartialize } from '../../store'
import type {
  ImportedGeometry, BoundingBox, Vec3, Project, Loop2D, NestRecord,
} from '../../types'
import { runNest } from '../../lib/cam/nesting'
import type { NestRequest, NestPart } from '../../lib/cam/nesting'
import { seedPlacementIds } from '../../lib/cam/nesting/seedSelectors'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A closed square loop of side `s` at the origin (CCW), as a Loop2D the store can
// resolve into a NestPart (outer = largest closed loop).
function squareLoop(id: string, s: number): Loop2D {
  return {
    id,
    layerId: 'L',
    closed: true,
    type: 'contour',
    area: s * s,
    points: [
      { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
    ],
  }
}

function squareLoopAt(id: string, x: number, y: number, s: number): Loop2D {
  const result = squareLoop(id, s)
  return {
    ...result,
    points: result.points.map((point) => ({ x: point.x + x, y: point.y + y })),
  }
}

function makeGeo(id: string, side: number): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
  } as ImportedGeometry
}

function installProject(geometry: ImportedGeometry[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests: [],
      setups: [],
      stocks: undefined,
    },
    projectHistory: [],
    canUndo: false,
  }))
}

const SEED = 42

function createParams(over: Partial<Parameters<ReturnType<typeof useCamStore.getState>['createNest']>[0]> = {}) {
  return {
    sources: [{ geometryId: 'a', quantity: 4 }],
    sheet: { width: 100, height: 100 },
    style: 'ninety' as const,
    spacing: { partGap: 1, sheetMargin: 2, windowGap: 1 },
    seed: SEED,
    ...over,
  }
}

beforeEach(() => {
  installProject([makeGeo('a', 20), makeGeo('b', 15)])
})

// =============================================================================
// createNest — record creation, source references, no geometry duplication
// =============================================================================

describe('createNest', () => {
  it('deep-copies each source into an OWNED SEED and references the COPY (ADR 0025 §2)', () => {
    const id = useCamStore.getState().createNest(createParams())
    const st = useCamStore.getState()
    const nests = st.project.nests!
    expect(nests).toHaveLength(1)
    const n = nests[0]
    expect(n.id).toBe(id)
    // The record references an OWNED SEED copy, NOT the original 'a'.
    expect(n.sources).toHaveLength(1)
    const ownedId = n.sources[0].geometryId
    expect(ownedId).not.toBe('a')
    expect(n.sources[0].quantity).toBe(4)
    // The copy exists in project.geometry, owned by this nest, with NONE stock.
    const seed = st.project.geometry.find((g) => g.id === ownedId)!
    expect(seed).toBeDefined()
    expect(seed.ownerNestId).toBe(id)
    expect(seed.stockIdLocked).toBe(true)
    expect(seed.stockId).toBeUndefined()
    // The original 'a' is untouched (pre-existing workspace part, not consumed).
    const original = st.project.geometry.find((g) => g.id === 'a')!
    expect(original).toBeDefined()
    expect(original.ownerNestId).toBeUndefined()
    // The copy has its OWN deep-copied loops (independent from the original).
    expect((seed.loops ?? []).length).toBeGreaterThan(0)
    expect(seed.loops![0].id).not.toBe(original.loops![0].id)
    // the record carries the pack params back for a faithful recompute.
    expect(n.seed).toBe(SEED)
    expect(n.style).toBe('ninety')
    expect(n.sheet).toEqual({ width: 100, height: 100 })
    expect(n.visible).toBe(true)
  })

  it('splits disconnected top-level outlines and keeps contained features with their outer', () => {
    const multi = makeGeo('multi', 80)
    const left = squareLoopAt('left', 0, 0, 30)
    const hole = { ...squareLoopAt('hole', 5, 5, 10), type: 'hole' as const }
    const right = squareLoopAt('right', 50, 0, 20)
    multi.loops = [hole, right, left]
    installProject([multi])

    const id = useCamStore.getState().createNest(createParams({
      sources: [{ geometryId: 'multi', quantity: 2 }],
    }))
    const state = useCamStore.getState()
    const nest = state.project.nests!.find((item) => item.id === id)!
    const seeds = nest.sources.map((source) =>
      state.project.geometry.find((geometry) => geometry.id === source.geometryId)!,
    )

    expect(nest.sources).toHaveLength(2)
    expect(seeds.every((seed) => seed.ownerNestId === id)).toBe(true)
    expect(seeds.map((seed) => seed.loops!.length)).toEqual([1, 2])
    expect(seeds[1].loops!.map((item) => item.type)).toEqual(['contour', 'hole'])
    expect(nest.unplaced).toEqual(
      nest.sources.map((source) => ({ partId: source.geometryId, count: 2 })),
    )
  })

  it('does NOT consume a pre-existing original; deleting it does not break the nest', () => {
    const id = useCamStore.getState().createNest(createParams())
    let st = useCamStore.getState()
    const ownedId = st.project.nests![0].sources[0].geometryId
    // The original survives at root (independent).
    expect(st.project.geometry.some((g) => g.id === 'a')).toBe(true)
    // Delete the original — the nest still resolves against its owned seed copy.
    useCamStore.getState().removeGeometry('a')
    st = useCamStore.getState()
    expect(st.project.geometry.some((g) => g.id === 'a')).toBe(false)
    // The nest + its owned seed are intact.
    expect(st.project.nests!.some((nn) => nn.id === id)).toBe(true)
    expect(st.project.geometry.some((g) => g.id === ownedId)).toBe(true)
  })

  it('CONSUMES a fresh modal import (deletes it after copying) but keeps the seed', () => {
    // 'a' is treated as a fresh modal import (passed in consumeSourceIds).
    const id = useCamStore.getState().createNest(createParams(), ['a'])
    const st = useCamStore.getState()
    // The fresh import 'a' is gone; the owned seed remains, owned by the nest.
    expect(st.project.geometry.some((g) => g.id === 'a')).toBe(false)
    const ownedId = st.project.nests![0].sources[0].geometryId
    const seed = st.project.geometry.find((g) => g.id === ownedId)!
    expect(seed.ownerNestId).toBe(id)
  })

  it('defaults the name to "Nest <n>" and increments per nest', () => {
    useCamStore.getState().createNest(createParams())
    useCamStore.getState().createNest(createParams())
    const names = useCamStore.getState().project.nests!.map((n) => n.name)
    expect(names).toEqual(['Nest 1', 'Nest 2'])
  })

  it('starts with empty placements and ALL requested copies unplaced (ADR 0003)', () => {
    // In the headless env no Worker runs, so the record holds its pre-compute state:
    // nothing placed yet, leftovers reported explicitly (never a silent empty set).
    useCamStore.getState().createNest(createParams({ sources: [{ geometryId: 'a', quantity: 4 }] }))
    const n = useCamStore.getState().project.nests![0]
    expect(n.placements).toEqual([])
    // unplaced is keyed by the OWNED SEED partId (= the record's source id).
    expect(n.unplaced).toEqual([{ partId: n.sources[0].geometryId, count: 4 }])
    expect(n.utilization).toBe(0)
  })

  it('pushes one undo entry per create (history-tracked)', () => {
    expect(useCamStore.getState().canUndo).toBe(false)
    useCamStore.getState().createNest(createParams())
    expect(useCamStore.getState().canUndo).toBe(true)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)
  })

  // Regression (P4.1): the chosen solver objective MUST be persisted on the record
  // so a recompute reproduces it. The bug: NestRecord dropped `solver` and
  // recomputeNest hardcoded fixSheet, so a fixQty request (exact quantities) would
  // silently revert to fixSheet (max-qty fill) and pack the WRONG count on re-pack.
  it('persists the requested solver objective on the record', () => {
    useCamStore.getState().createNest(
      createParams({ solver: { kind: 'fixQty', lockedAxis: 'none' } }),
    )
    expect(useCamStore.getState().project.nests![0].solver).toEqual({
      kind: 'fixQty',
      lockedAxis: 'none',
    })
  })

  it('defaults the stored solver to fixSheet when none is given', () => {
    useCamStore.getState().createNest(createParams())
    expect(useCamStore.getState().project.nests![0].solver).toEqual({ kind: 'fixSheet' })
  })

  // P4 EDIT: rotationCount must round-trip onto the record so the Edit modal can
  // faithfully prefill an arbitrary-style nest's orientation-sample count.
  it('stores rotationCount from params (arbitrary style)', () => {
    useCamStore.getState().createNest(
      createParams({ style: 'arbitrary', rotationCount: 8 }),
    )
    expect(useCamStore.getState().project.nests![0].rotationCount).toBe(8)
  })
})

// =============================================================================
// P4 EDIT: nestEditTarget transient plumbing
// =============================================================================

describe('nestEditTarget (transient edit-target plumbing)', () => {
  it('setNestEditTarget sets and clears the target', () => {
    useCamStore.getState().setNestEditTarget('n1')
    expect(useCamStore.getState().nestEditTarget).toBe('n1')
    useCamStore.getState().setNestEditTarget(null)
    expect(useCamStore.getState().nestEditTarget).toBeNull()
  })

  it('is NOT persisted (excluded from persistPartialize)', () => {
    useCamStore.getState().setNestEditTarget('n1')
    const slice = persistPartialize(useCamStore.getState())
    expect('nestEditTarget' in slice).toBe(false)
  })
})

// =============================================================================
// rename / setVisible / remove
// =============================================================================

describe('renameNest', () => {
  it('renames in place', () => {
    const id = useCamStore.getState().createNest(createParams())
    useCamStore.getState().renameNest(id, 'Sheet A')
    expect(useCamStore.getState().project.nests![0].name).toBe('Sheet A')
  })

  it('is a no-op for an unknown id and for an unchanged name', () => {
    const id = useCamStore.getState().createNest(createParams())
    useCamStore.setState({ projectHistory: [], canUndo: false })
    useCamStore.getState().renameNest('ghost', 'X')
    useCamStore.getState().renameNest(id, 'Nest 1')
    expect(useCamStore.getState().canUndo).toBe(false)
  })
})

describe('setNestVisible', () => {
  it('toggles visibility', () => {
    const id = useCamStore.getState().createNest(createParams())
    useCamStore.getState().setNestVisible(id, false)
    expect(useCamStore.getState().project.nests![0].visible).toBe(false)
    useCamStore.getState().setNestVisible(id, true)
    expect(useCamStore.getState().project.nests![0].visible).toBe(true)
  })
})

describe('removeNest', () => {
  it('removes the record and leaves other nests untouched', () => {
    const a = useCamStore.getState().createNest(createParams())
    const b = useCamStore.getState().createNest(createParams())
    useCamStore.getState().removeNest(a)
    const ids = useCamStore.getState().project.nests!.map((n) => n.id)
    expect(ids).toEqual([b])
  })

  it('is a no-op for an unknown id', () => {
    useCamStore.getState().createNest(createParams())
    useCamStore.setState({ projectHistory: [], canUndo: false })
    useCamStore.getState().removeNest('ghost')
    expect(useCamStore.getState().project.nests).toHaveLength(1)
    expect(useCamStore.getState().canUndo).toBe(false)
  })
})

// =============================================================================
// removeNest — owned-seed deletion (deep-copy seed model, ADR 0025 §2)
// =============================================================================
//
// removeNest deletes every geometry whose ownerNestId === the nest (its owned
// seed copies) ALWAYS — each nest owns its OWN copies, so there is nothing
// shared to spare. Pre-existing workspace originals (no ownerNestId) survive.
// State logic only — the __cncViewport teardown seam is a guarded no-op in node.

// An owned-seed geometry literal (ownerNestId set), plus a pre-existing one.
function makeOwnedGeo(id: string, side: number, ownerNestId: string): ImportedGeometry {
  return { ...makeGeo(id, side), ownerNestId, stockIdLocked: true }
}

// Build a NestRecord referencing its owned seed copies by id.
function makeNest(id: string, sources: NestRecord['sources']): NestRecord {
  return {
    id, name: `Nest ${id}`,
    sheet: { width: 200, height: 200 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources,
    placements: [],
    unplaced: [],
    utilization: 0,
  }
}

// Install geometry + nests directly (precise ownerNestId control).
function installNests(geometry: ImportedGeometry[], nests: NestRecord[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests,
      setups: [],
      stocks: undefined,
    },
    projectHistory: [],
    canUndo: false,
  }))
}

describe('removeNest deletes owned seeds (deep-copy seed model)', () => {
  it('deletes the OWNED SEED but keeps the PRE-EXISTING original', () => {
    const owned = makeOwnedGeo('g-owned', 10, 'n1')
    const pre = makeGeo('g-pre', 12) // no ownerNestId -> survives
    installNests(
      [owned, pre],
      [makeNest('n1', [
        { geometryId: 'g-owned', quantity: 1 },
        { geometryId: 'g-pre', quantity: 1 },
      ])],
    )

    useCamStore.getState().removeNest('n1')
    const st = useCamStore.getState()

    const ids = st.project.geometry.map((g) => g.id)
    expect(ids).toContain('g-pre')
    expect(ids).not.toContain('g-owned')
    expect((st.project.nests ?? []).some((n) => n.id === 'n1')).toBe(false)
  })

  it('each nest owns its own copies: removing one nest keeps the other intact', () => {
    // Two nests, each owning its OWN copy (no sharing under the deep-copy model).
    const owned1 = makeOwnedGeo('g-own1', 10, 'n1')
    const owned2 = makeOwnedGeo('g-own2', 10, 'n2')
    installNests(
      [owned1, owned2],
      [
        makeNest('n1', [{ geometryId: 'g-own1', quantity: 1 }]),
        makeNest('n2', [{ geometryId: 'g-own2', quantity: 1 }]),
      ],
    )

    useCamStore.getState().removeNest('n1')
    const st = useCamStore.getState()

    // n1's copy is gone; n2 + its copy survive.
    expect(st.project.geometry.some((g) => g.id === 'g-own1')).toBe(false)
    expect(st.project.geometry.some((g) => g.id === 'g-own2')).toBe(true)
    expect((st.project.nests ?? []).map((n) => n.id)).toEqual(['n2'])
  })

  it('pushes a single history entry; one undo restores nest + owned seed', () => {
    const owned = makeOwnedGeo('g-owned', 10, 'n1')
    const pre = makeGeo('g-pre', 12)
    installNests(
      [owned, pre],
      [makeNest('n1', [
        { geometryId: 'g-owned', quantity: 1 },
        { geometryId: 'g-pre', quantity: 1 },
      ])],
    )

    const histBefore = useCamStore.getState().projectHistory.length
    useCamStore.getState().removeNest('n1')
    expect(useCamStore.getState().projectHistory.length).toBe(histBefore + 1)

    useCamStore.getState().undo()
    const st = useCamStore.getState()
    expect(st.project.geometry.map((g) => g.id).sort()).toEqual(['g-owned', 'g-pre'])
    expect((st.project.nests ?? []).map((n) => n.id)).toEqual(['n1'])
  })
})

// =============================================================================
// EDIT / CANCEL correctness (deep-copy seed model, ADR 0025 §2)
// =============================================================================
//
// Edit flow (mirrors NestModal): the original nest stays ALIVE during edit so its
// owned seeds are a live copy-source. A provisional createNest copies from them.
//   - Accept -> removeNest(original): leaves exactly the new nest + its owned seeds.
//   - Cancel -> removeNest(provisional): leaves the original nest + its owned seeds.

describe('edit/cancel correctness (deep-copy seed)', () => {
  it('edit then Accept leaves only the new nest + its owned seeds (old gone)', () => {
    installProject([makeGeo('a', 20)])
    // Original nest (deep-copies 'a' into its owned seed).
    const origId = useCamStore.getState().createNest(createParams())
    const origSeedId = useCamStore.getState().project.nests!.find((n) => n.id === origId)!.sources[0].geometryId

    // Provisional edit: copy from the original's STILL-ALIVE owned seed.
    const provId = useCamStore.getState().createNest(
      createParams({ sources: [{ geometryId: origSeedId, quantity: 4 }] }),
    )
    const provSeedId = useCamStore.getState().project.nests!.find((n) => n.id === provId)!.sources[0].geometryId

    // Accept: remove the original; its owned seed goes with it.
    useCamStore.getState().removeNest(origId)
    const st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([provId])
    expect(st.project.geometry.some((g) => g.id === origSeedId)).toBe(false)
    expect(st.project.geometry.some((g) => g.id === provSeedId)).toBe(true)
  })

  it('edit then Cancel leaves the original nest + its owned seeds intact', () => {
    installProject([makeGeo('a', 20)])
    const origId = useCamStore.getState().createNest(createParams())
    const origSeedId = useCamStore.getState().project.nests!.find((n) => n.id === origId)!.sources[0].geometryId

    const provId = useCamStore.getState().createNest(
      createParams({ sources: [{ geometryId: origSeedId, quantity: 4 }] }),
    )
    const provSeedId = useCamStore.getState().project.nests!.find((n) => n.id === provId)!.sources[0].geometryId

    // Cancel: remove the provisional; its owned seed goes, the original survives.
    useCamStore.getState().removeNest(provId)
    const st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([origId])
    expect(st.project.geometry.some((g) => g.id === origSeedId)).toBe(true)
    expect(st.project.geometry.some((g) => g.id === provSeedId)).toBe(false)
  })
})

// =============================================================================
// applyNestResult — the worker-completion writer / node seam
// =============================================================================

describe('applyNestResult writes engine output into the record', () => {
  it('stores placements / unplaced / utilization / solved sheet', async () => {
    const id = useCamStore.getState().createNest(createParams())
    const part: NestPart = {
      id: 'a',
      outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      holes: [],
    }
    const req: NestRequest = {
      parts: [{ part, quantity: 4 }],
      sheet: { width: 100, height: 100 },
      style: 'ninety',
      spacing: { partGap: 1, sheetMargin: 2, windowGap: 1 },
      solver: { kind: 'fixSheet' },
      seed: SEED,
    }
    const res = await runNest(req)
    useCamStore.getState().applyNestResult(id, res)
    const n = useCamStore.getState().project.nests!.find((x) => x.id === id)!
    expect(n.placements).toEqual(res.placements)
    expect(n.unplaced).toEqual(res.unplaced)
    expect(n.utilization).toBe(res.utilization)
    expect(n.sheet).toEqual(res.sheetUsed)
    // four 20mm squares fit easily on a 100mm sheet -> something placed.
    expect(n.placements.length).toBeGreaterThan(0)
  }, 30_000) // generous: the pack runs ~3s isolated but ~12-20s under full-suite
             // parallel contention (same rationale as perf.test.ts).

  it("sets each owned seed's home to its lower-left placement pose", async () => {
    // Edit-the-seed-at-its-slot (Part 1): after applyNestResult the owned seed
    // geometry's position/rotation equals its lower-left placement pose, while
    // its loops stay in the clean LOCAL frame (ADR 0024). The part id MUST be
    // the OWNED SEED id so placements (keyed by partId) map back to the seed.
    const id = useCamStore.getState().createNest(createParams())
    const seedId = useCamStore.getState().project.nests!.find((n) => n.id === id)!.sources[0].geometryId
    const part: NestPart = {
      id: seedId,
      outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      holes: [],
    }
    const req: NestRequest = {
      parts: [{ part, quantity: 4 }],
      sheet: { width: 100, height: 100 },
      style: 'ninety',
      spacing: { partGap: 1, sheetMargin: 2, windowGap: 1 },
      solver: { kind: 'fixSheet' },
      seed: SEED,
    }
    const res = await runNest(req)
    useCamStore.getState().applyNestResult(id, res)

    const st = useCamStore.getState()
    const n = st.project.nests!.find((x) => x.id === id)!
    // The lower-left placement = the seed slot per seedSelectors.
    const seedIids = seedPlacementIds(n)
    const seedPlacement = n.placements.find((p) => seedIids.has(p.instanceId) && p.partId === seedId)!
    expect(seedPlacement).toBeDefined()

    const seedGeo = st.project.geometry.find((g) => g.id === seedId)!
    expect(seedGeo.position.x).toBe(seedPlacement.x)
    expect(seedGeo.position.y).toBe(seedPlacement.y)
    expect(seedGeo.rotation.z).toBe(seedPlacement.rotationDeg)
    expect(seedGeo.rotation.x).toBe(0)
    expect(seedGeo.rotation.y).toBe(0)
    // The loops stay in the clean LOCAL frame (NOT baked to the slot): the outer
    // square still starts at the local origin.
    const outer = seedGeo.loops!.find((l) => l.closed)!
    expect(outer.points[0]).toEqual({ x: 0, y: 0 })
  }, 30_000)

  it('is a no-op for an unknown nest id', async () => {
    const id = useCamStore.getState().createNest(createParams())
    const before = useCamStore.getState().project.nests!.find((n) => n.id === id)!
    useCamStore.getState().applyNestResult('ghost', {
      placements: [], unplaced: [], utilization: 0.5, sheetUsed: { width: 1, height: 1 },
    })
    const after = useCamStore.getState().project.nests!.find((n) => n.id === id)!
    expect(after).toEqual(before)
  })
})

// =============================================================================
// needsRecompute (stale flag) — owned-seed edits mark the owning nest stale
// =============================================================================
//
// Owned-seed model: editing/deleting an owned seed's LOOPS after a pack leaves
// the stored placements out of date. The mutation marks the OWNING nest
// needsRecompute=true (no auto-repack — the user clicks Recompute). A non-owned
// geometry edit marks nothing; applyNestResult clears the flag (fresh pack).

// An owned 2D seed with one layer + one loop, so setGeometryLoops /
// deleteGeometryLayer have real layer/loop structure to act on.
function makeOwnedSeed2D(id: string, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Seed ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    ownerNestId, stockIdLocked: true,
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d: [
      { id: 'lyr-a', name: 'Outline', color: '#f00', visible: true },
      { id: 'lyr-b', name: 'Holes', color: '#0f0', visible: true },
    ],
    loops: [
      { ...squareLoop('lp-a', 10), layerId: 'lyr-a' },
      { ...squareLoop('lp-b', 2), id: 'lp-b', layerId: 'lyr-b' },
    ],
  } as ImportedGeometry
}

describe('needsRecompute (owned-seed stale flag)', () => {
  it('setGeometryLoops on an owned seed marks the owning nest stale', () => {
    const seed = makeOwnedSeed2D('g-seed', 'n1')
    installNests([seed], [makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])])
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBeFalsy()

    // Re-bake the seed's loops (a sketch edit lands here) -> footprint may change.
    useCamStore.getState().setGeometryLoops(
      'g-seed',
      [{ ...squareLoop('lp-a', 14), layerId: 'lyr-a' }],
      seed.layers2d!,
    )
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBe(true)
  })

  it('deleteGeometryLayer on an owned seed marks the owning nest stale', () => {
    const seed = makeOwnedSeed2D('g-seed', 'n1')
    installNests([seed], [makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])])
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBeFalsy()

    useCamStore.getState().deleteGeometryLayer('g-seed', 'lyr-b')
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBe(true)
  })

  it('does NOT mark stale when a NON-owned geometry is edited', () => {
    const seed = makeOwnedSeed2D('g-seed', 'n1')
    const free = makeOwnedSeed2D('g-free', '') // ownerNestId empty -> owned by no nest
    free.ownerNestId = undefined
    installNests([seed, free], [makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])])

    useCamStore.getState().setGeometryLoops(
      'g-free',
      [{ ...squareLoop('lp-a', 9), layerId: 'lyr-a' }],
      free.layers2d!,
    )
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBeFalsy()
  })

  it('applyNestResult clears needsRecompute (a fresh pack is up to date)', () => {
    const seed = makeOwnedSeed2D('g-seed', 'n1')
    const nest = makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])
    nest.needsRecompute = true
    installNests([seed], [nest])
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBe(true)

    useCamStore.getState().applyNestResult('n1', {
      placements: [], unplaced: [], utilization: 0.3, sheetUsed: { width: 100, height: 100 },
    })
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBe(false)
  })
})

// =============================================================================
// determinism of stored placements
// =============================================================================

describe('determinism', () => {
  it('same inputs + seed -> equal stored placements', async () => {
    const part: NestPart = {
      id: 'a',
      outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      holes: [],
    }
    const req: NestRequest = {
      parts: [{ part, quantity: 4 }],
      sheet: { width: 100, height: 100 },
      style: 'ninety',
      spacing: { partGap: 1, sheetMargin: 2, windowGap: 1 },
      solver: { kind: 'fixSheet' },
      seed: SEED,
    }
    const idA = useCamStore.getState().createNest(createParams())
    const idB = useCamStore.getState().createNest(createParams())
    useCamStore.getState().applyNestResult(idA, await runNest(req))
    useCamStore.getState().applyNestResult(idB, await runNest(req))
    const a = useCamStore.getState().project.nests!.find((n) => n.id === idA)!
    const b = useCamStore.getState().project.nests!.find((n) => n.id === idB)!
    expect(b.placements).toEqual(a.placements)
  }, 30_000)
})

// =============================================================================
// persistence round-trip
// =============================================================================

describe('persistence', () => {
  it('persistPartialize preserves nests in the project blob', () => {
    const id = useCamStore.getState().createNest(createParams())
    useCamStore.getState().renameNest(id, 'Persisted')
    const slice = persistPartialize(useCamStore.getState())
    const proj = slice.project as Project
    expect(proj.nests).toBeDefined()
    expect(proj.nests!.find((n) => n.id === id)?.name).toBe('Persisted')
    // a save -> load round-trip (JSON) preserves the nest record verbatim.
    const round = JSON.parse(JSON.stringify(proj)) as Project
    expect(round.nests).toEqual(proj.nests)
  })

  it('persistPartialize keeps the needsRecompute stale flag (not stripped)', () => {
    const seed = makeOwnedSeed2D('g-seed', 'n1')
    const nest = makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])
    nest.needsRecompute = true
    installNests([seed], [nest])
    const slice = persistPartialize(useCamStore.getState())
    const proj = slice.project as Project
    // Only status/error/computeStartedAt are stripped; needsRecompute persists.
    expect(proj.nests!.find((n) => n.id === 'n1')?.needsRecompute).toBe(true)
  })

  it('persistPartialize STRIPS the transient status + computeStartedAt', () => {
    const seed = makeOwnedSeed2D('g-seed', 'n1')
    const nest = makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])
    nest.status = 'computing'
    nest.computeStartedAt = 123456
    installNests([seed], [nest])
    const slice = persistPartialize(useCamStore.getState())
    const proj = slice.project as Project
    const persisted = proj.nests!.find((n) => n.id === 'n1')!
    // A reload must never resume a stale 'computing' / live-timer start.
    expect('status' in persisted).toBe(false)
    expect('computeStartedAt' in persisted).toBe(false)
  })
})

// =============================================================================
// recomputeNest — transient compute state (live progress indicator)
// =============================================================================
//
// recomputeNest marks the in-flight (re)pack with status:'computing' and a
// computeStartedAt wall-clock start (Date.now()), which drive the persistent
// progress timer in NestProperties / the status bar. The state is set BEFORE
// dispatch; the worker (a no-op stub here) never resolves, so the record stays
// in the computing state for the assertion. Requires a Worker global (the guard
// early-returns without one) — a minimal no-op stub satisfies it in node.

describe('recomputeNest transient compute state', () => {
  it('sets status=computing + a numeric computeStartedAt', () => {
    const OrigWorker = (globalThis as { Worker?: unknown }).Worker
    // Minimal no-op Worker so the guard passes and dispatchNest stays inert.
    class StubWorker {
      onmessage: unknown = null
      onerror: unknown = null
      postMessage(): void {}
      terminate(): void {}
    }
    ;(globalThis as { Worker?: unknown }).Worker = StubWorker as unknown
    try {
      // An owned 2D seed with real loops so recomputeNest resolves a part.
      const seed = makeOwnedSeed2D('g-seed', 'n1')
      installNests([seed], [makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])])
      const before = Date.now()
      useCamStore.getState().recomputeNest('n1')
      const n = useCamStore.getState().project.nests!.find((x) => x.id === 'n1')!
      expect(n.status).toBe('computing')
      expect(typeof n.computeStartedAt).toBe('number')
      expect(n.computeStartedAt!).toBeGreaterThanOrEqual(before)
    } finally {
      ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
    }
  })
})
