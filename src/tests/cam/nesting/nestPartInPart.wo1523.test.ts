/* WO-1523 (BUG-526): "Window gap" promised part-in-part nesting but no part
 * ever carried a `NestPart.windows` entry, so the packer's already-working
 * interior-placement phase (placeInWindows, index.ts) never had anything to
 * try. Fixed at the shared root cause (partGroups.ts:nestPartGeometryFromLoops,
 * called by both createNest and recomputeNest, src/store/index.ts): every
 * interior loop of a part is now a usable window - no separate designation
 * step, because the packer's own inside-fit test already decides what
 * actually fits.
 *
 * These tests fail on main before the fix: main's createNest/recomputeNest
 * never populate `part.windows`, so every "packs inside the opening"
 * assertion below sees zero nested children.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../../store'
import type { ImportedGeometry, BoundingBox, Vec3, Vec2, Loop2D, NestRecord, Operation, Project, Setup } from '../../../types'
import { runNest, packNest } from '../../../lib/cam/nesting'
import type { NestPart, NestRequest } from '../../../lib/cam/nesting'
import { nestPartGeometryFromLoops } from '../../../lib/cam/nesting/partGroups'
import { buildPostInput } from '../../../lib/post/buildPostInput'
import { makeMachine, makeOp, makeTool, makeWcs, move } from '../../post/helpers'

// -- Fixtures -------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function squarePts(s: number, ox = 0, oy = 0): Vec2[] {
  return [
    { x: ox, y: oy },
    { x: ox + s, y: oy },
    { x: ox + s, y: oy + s },
    { x: ox, y: oy + s },
  ]
}

function loop(id: string, points: Vec2[]): Loop2D {
  return { id, layerId: 'L', closed: true, type: 'contour', area: 0, points }
}

/** A square "ring" host: outer side `outerSide`, a centered square opening
 *  (the "window") of side `windowSide`. */
function ringGeo(id: string, outerSide: number, windowSide: number): ImportedGeometry {
  const lo = (outerSide - windowSide) / 2
  return {
    id, name: `Ring ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: outerSide, y: outerSide, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [loop(`${id}-outer`, squarePts(outerSide)), loop(`${id}-window`, squarePts(windowSide, lo, lo))],
  } as ImportedGeometry
}

/** A square "tile": no interior loops, meant to be nested inside a ring. */
function tileGeo(id: string, side: number): ImportedGeometry {
  return {
    id, name: `Tile ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [loop(`${id}-outer`, squarePts(side))],
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

const SEED = 4242

/** Rebuild each source's NestPart from its OWNED SEED geometry via the exact
 *  helper createNest/recomputeNest call (nestPartGeometryFromLoops) - the node
 *  seam, since the headless test env has no Worker to dispatch to (createNest
 *  guards on `typeof Worker`; see src/tests/store/nestRecord.test.ts). This is
 *  NOT a reimplementation of the fix - it is the SAME exported function the
 *  store calls, applied to the SAME owned-seed loops createNest just produced. */
function partsFromNestSources(nestId: string): { part: NestPart; quantity: number }[] {
  const nest = useCamStore.getState().project.nests!.find((n) => n.id === nestId)!
  const geoById = new Map(useCamStore.getState().project.geometry.map((g) => [g.id, g]))
  return nest.sources.map((src) => {
    const geo = geoById.get(src.geometryId)!
    const closed = (geo.loops ?? []).filter((l) => l.closed && l.points.length >= 3)
    return {
      part: { id: geo.id, ...nestPartGeometryFromLoops(closed[0], closed.slice(1)) },
      quantity: src.quantity,
    }
  })
}

beforeEach(() => {
  installProject([])
})

describe('WO-1523: createNest resolves interior loops into usable windows (acceptance 1-2)', () => {
  it('a ring with a 60mm opening plus a tile that fits -> the tile packs inside, >= windowGap from the edge', async () => {
    installProject([ringGeo('ring', 80, 60), tileGeo('tile', 40)])
    const id = useCamStore.getState().createNest({
      sources: [
        { geometryId: 'ring', quantity: 1 },
        { geometryId: 'tile', quantity: 3 },
      ],
      sheet: { width: 80, height: 80 },
      style: 'ninety',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 2 },
      seed: SEED,
    })
    const nest = useCamStore.getState().project.nests!.find((n) => n.id === id)!
    const ringSeedId = nest.sources[0].geometryId
    const tileSeedId = nest.sources[1].geometryId

    const parts = partsFromNestSources(id)
    // BUG-526's exact defect: the owned seed's window never made it onto the part.
    const ringPart = parts.find((p) => p.part.id === ringSeedId)!.part
    expect(ringPart.windows?.length ?? 0).toBe(1)

    const req: NestRequest = {
      parts,
      sheet: nest.sheet,
      style: nest.style,
      spacing: nest.spacing,
      solver: nest.solver ?? { kind: 'fixSheet' },
      seed: nest.seed,
    }
    const result = await runNest(req)
    useCamStore.getState().applyNestResult(id, result)
    const updated = useCamStore.getState().project.nests!.find((n) => n.id === id)!

    const hostP = updated.placements.find((p) => p.partId === ringSeedId)
    expect(hostP).toBeDefined()
    expect(hostP!.depth).toBe(0)

    const children = updated.placements.filter((p) => p.partId === tileSeedId)
    expect(children.length).toBeGreaterThan(0) // BUG-526: this was always 0 on main
    for (const c of children) {
      expect(c.depth).toBe(1)
      expect(c.windowParentId).toBe(hostP!.instanceId)
    }
  }, 30_000)

  it('a window gap bigger than the leftover room places nothing inside (unchanged fallback)', async () => {
    installProject([ringGeo('ring2', 80, 60), tileGeo('tile2', 40)])
    const id = useCamStore.getState().createNest({
      sources: [
        { geometryId: 'ring2', quantity: 1 },
        { geometryId: 'tile2', quantity: 3 },
      ],
      sheet: { width: 80, height: 80 },
      style: 'ninety',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 30 }, // 60mm window - 30 half-gaps leaves no room for a 40mm+30 tile
      seed: SEED,
    })
    const nest = useCamStore.getState().project.nests!.find((n) => n.id === id)!
    const tileSeedId = nest.sources[1].geometryId
    const req: NestRequest = {
      parts: partsFromNestSources(id),
      sheet: nest.sheet,
      style: nest.style,
      spacing: nest.spacing,
      solver: nest.solver ?? { kind: 'fixSheet' },
      seed: nest.seed,
    }
    const result = await runNest(req)
    useCamStore.getState().applyNestResult(id, result)
    const updated = useCamStore.getState().project.nests!.find((n) => n.id === id)!

    const children = updated.placements.filter((p) => p.partId === tileSeedId)
    expect(children.length).toBe(0)
  }, 30_000)
})

describe('WO-1523: a mounting hole too small never receives a part (acceptance 3)', () => {
  it('the layout is byte-identical whether the small hole is a window or not', async () => {
    const host: NestPart = { id: 'host', outer: squarePts(80), holes: [squarePts(6, 37, 37)] }
    const hostWithTinyWindow: NestPart = { ...host, windows: [squarePts(6, 37, 37)] }
    const filler: NestPart = { id: 'filler', outer: squarePts(30), holes: [] }
    const baseReq = (h: NestPart): NestRequest => ({
      parts: [
        { part: h, quantity: 1 },
        { part: filler, quantity: 4 },
      ],
      sheet: { width: 80, height: 80 },
      style: 'ninety',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 2 },
      solver: { kind: 'fixSheet' },
      seed: SEED,
    })
    const before = await packNest(baseReq(host))
    const after = await packNest(baseReq(hostWithTinyWindow))

    // nothing ever nests in the 6mm mounting hole (every candidate part is far bigger)
    expect(after.placements.some((p) => p.depth === 1)).toBe(false)
    // and the rest of the layout (host + on-sheet fillers) is unchanged from today
    expect(after.placements).toEqual(before.placements)
    expect(after.unplaced).toEqual(before.unplaced)
  }, 30_000)
})

describe('WO-1523: buildPostInput cuts the inner part before its host (acceptance 4)', () => {
  // WO-1523: expandNest's by-operation mode (instanceToolpath.ts) now sorts ops
  // by the deepest placement depth they carry, so a window-child part's op runs
  // before its host's op regardless of authoring order. The setup below lists
  // the RING op FIRST (the order a user would draw it in) specifically to prove
  // the post reorders it, not just preserve it.
  const NEST_ID = 'wo1523-nest'
  const RING_ID = 'ring-seed'
  const TILE_ID = 'tile-seed'

  function seedGeo(id: string): ImportedGeometry {
    return {
      id, name: id, filename: '', type: 'imported', format: 'dxf',
      boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      ownerNestId: NEST_ID,
    } as unknown as ImportedGeometry
  }

  function makeNest(): NestRecord {
    return {
      id: NEST_ID, name: 'Nest', sheet: { width: 200, height: 200 }, style: 'ninety' as const,
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 2 }, seed: 1,
      sources: [{ geometryId: RING_ID, quantity: 1 }, { geometryId: TILE_ID, quantity: 1 }],
      placements: [
        { partId: RING_ID, instanceId: 'ring#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
        { partId: TILE_ID, instanceId: 'tile#0', x: 10, y: 10, rotationDeg: 0, depth: 1, windowParentId: 'ring#0' },
      ],
      unplaced: [], utilization: 0.5, origin: { x: 0, y: 0 },
    } as unknown as NestRecord
  }

  function ringOp(): Operation {
    return makeOp({
      id: 'ring-op', name: 'Ring', type: 'contour_2d', toolId: 't1', params: { geometryId: RING_ID },
      toolpathMoves: [
        move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 5, y: 0, z: -2, feed: 2000, role: 'cut' }),
      ],
    })
  }

  function tileOp(): Operation {
    return makeOp({
      id: 'tile-op', name: 'Tile', type: 'contour_2d', toolId: 't2', params: { geometryId: TILE_ID },
      toolpathMoves: [
        move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 3, y: 0, z: -2, feed: 2000, role: 'cut' }),
      ],
    })
  }

  function makeSetup(ops: Operation[]): Setup {
    return { id: 's1', name: 'Setup 1', wcs: makeWcs(), stock: {} as Setup['stock'], operations: ops, notes: '' }
  }

  function makeProject(setup: Setup): Project {
    return {
      id: 'p1', name: 'P', version: '1', createdAt: '', updatedAt: '',
      machine: makeMachine(),
      toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
      geometry: [seedGeo(RING_ID), seedGeo(TILE_ID)],
      setups: [setup], activeSetupId: setup.id, activeOperationId: null,
      sceneStock: {} as Project['sceneStock'],
      nests: [makeNest()],
      notes: '',
    } as unknown as Project
  }

  it("the tile's operation comes before the ring's, even though the ring's op is listed first", () => {
    const setup = makeSetup([ringOp(), tileOp()]) // host authored first, on purpose
    const input = buildPostInput(makeProject(setup), setup)
    expect(input.setup.operations.map((o) => o.op.id)).toEqual(['tile-op', 'ring-op'])
  })
})
