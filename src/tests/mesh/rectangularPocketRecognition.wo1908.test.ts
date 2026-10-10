// @vitest-environment jsdom
//
// WO-1908: an STL pocket shows its measured floor.
//
// Rule 6: the store claims go through the application's own path - the
// store's `loadMeshFeatureTargets` / `loadMeshEdgeChains` actions, the shared
// `geometryForOperation` boundary, and the real `computeOperationToolpath`
// with the production toolpath worker running in this thread. The pocket op is
// authored with the PRODUCTION Smart Height builder the dialog uses
// (`buildPlanarRoughSmartHeightIntent`, geometry-floor mode).
//
// The fixtures are built here, in the same triangle-soup style as WO-1846's,
// and re-exported offset from the origin the way CAD leaves a part, so the
// recentring into the viewport's local frame has a real value to get wrong.

import { readFileSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type {
  HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock, Project, Setup, Tool,
} from '../../types'
import type { MeshBuffers, Vec3 } from '../../mesh/types'

const stlBytesById = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytesById.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytesById.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytesById.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } as Storage,
})

// The PRODUCTION toolpath worker, run in this thread (same harness as WO-1851).
const workerScope: {
  onmessage: ((event: MessageEvent) => unknown) | null
  postMessage: (data: unknown) => void
  location: Location
} = { onmessage: null, postMessage: () => {}, location: window.location }
vi.stubGlobal('self', workerScope)
await import('../../lib/cam/toolpathWorker')
let activeWorker: { onmessage: ((event: MessageEvent) => void) | null } | null = null
workerScope.postMessage = (data) => activeWorker?.onmessage?.({ data } as MessageEvent)
class InProcessToolpathWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: unknown): void {
    activeWorker = this
    void workerScope.onmessage?.({ data } as MessageEvent)
  }
  terminate(): void { /* in-process */ }
}
vi.stubGlobal('Worker', InProcessToolpathWorker)

const { useCamStore, geometryForOperation } = await import('../../store')
const { buildPlanarRoughSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { legacyHeightIntentForOperation } = await import('../../lib/cam/heightIntent')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')
const { sourceFacetIdsOf } = await import('../../mesh/edit')
const { recognizeMeshFeatures } = await import('../../mesh/recognition')
const { describePocketTarget, meshFeatureTargets } = await import('../../mesh/recognition/toolpathTargets')

// ------------------------------------------------------------------ fixtures

class Soup {
  private readonly coords: number[] = []

  tri(a: Vec3, b: Vec3, c: Vec3): void {
    this.coords.push(...a, ...b, ...c)
  }

  /** a, b, c, d counter-clockwise seen from OUTSIDE the material */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }

  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }

  bytes(): ArrayBuffer {
    return exportBinaryStl(this.mesh()).bytes
  }
}

const at = (xy: readonly [number, number], z: number): Vec3 => [xy[0], xy[1], z]

/** The block's outside, CCW from above, and the pocket's rectangle. */
const OUTER: Array<[number, number]> = [[-40, -30], [40, -30], [40, 30], [-40, 30]]
const POCKET: Array<[number, number]> = [[-20, -10], [20, -10], [20, 10], [-20, 10]]
const THICK = 12
const FLOOR = 6

/** Points along each side of `rect`, `per` pieces a side, CCW, no repeats. */
function subdivided(rect: Array<[number, number]>, per: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let k = 0; k < 4; k++) {
    const [a, b] = [rect[k], rect[(k + 1) % 4]]
    for (let i = 0; i < per; i++) out.push([a[0] + ((b[0] - a[0]) * i) / per, a[1] + ((b[1] - a[1]) * i) / per])
  }
  return out
}

function outerShell(soup: Soup): void {
  soup.quad(at(OUTER[0], 0), at(OUTER[3], 0), at(OUTER[2], 0), at(OUTER[1], 0))
  for (let k = 0; k < 4; k++) {
    const [a, b] = [OUTER[k], OUTER[(k + 1) % 4]]
    soup.quad(at(a, 0), at(b, 0), at(b, THICK), at(a, THICK))
  }
}

/** The top face with a rectangular opening whose boundary is `inner` (CCW,
 *  `per` points a side, starting at the first corner of POCKET). */
function topWithOpening(soup: Soup, inner: Array<[number, number]>, per: number): void {
  for (let k = 0; k < 4; k++) {
    const [o0, o1] = [OUTER[k], OUTER[(k + 1) % 4]]
    const side = Array.from({ length: per + 1 }, (_, i) => inner[(k * per + i) % inner.length])
    soup.tri(at(o0, THICK), at(o1, THICK), at(side[per], THICK))
    for (let i = 0; i < per; i++) soup.tri(at(o0, THICK), at(side[i + 1], THICK), at(side[i], THICK))
  }
}

/**
 * An 80 x 60 x 12 block with a 40 x 20 pocket, floor at Z 6. `per` splits each
 * pocket side into that many facets (an exporter that writes a side in pieces);
 * `draftMm` leans every wall outward by that much at the rim.
 */
function pocketBlock(per = 1, draftMm = 0): ArrayBuffer {
  const soup = new Soup()
  outerShell(soup)
  const floorRing = subdivided(POCKET, per)
  const rimRect: Array<[number, number]> = [
    [-20 - draftMm, -10 - draftMm], [20 + draftMm, -10 - draftMm], [20 + draftMm, 10 + draftMm], [-20 - draftMm, 10 + draftMm],
  ]
  const rimRing = subdivided(rimRect, per)
  topWithOpening(soup, rimRing, per)
  for (let i = 0; i < floorRing.length; i++) {
    const j = (i + 1) % floorRing.length
    soup.tri([0, 0, FLOOR], at(floorRing[i], FLOOR), at(floorRing[j], FLOOR))
    // wall: faces INTO the pocket
    soup.quad(at(floorRing[i], FLOOR), at(rimRing[i], THICK), at(rimRing[j], THICK), at(floorRing[j], FLOOR))
  }
  return soup.bytes()
}

/** The same block with no pocket at all. */
function plainBlock(): ArrayBuffer {
  const soup = new Soup()
  outerShell(soup)
  soup.quad(at(OUTER[0], THICK), at(OUTER[1], THICK), at(OUTER[2], THICK), at(OUTER[3], THICK))
  return soup.bytes()
}

/** The block with a 40 x 20 x 6 rectangular BOSS standing on it instead. */
function bossBlock(): ArrayBuffer {
  const soup = new Soup()
  outerShell(soup)
  topWithOpening(soup, POCKET, 1)
  soup.quad(at(POCKET[0], THICK + 6), at(POCKET[1], THICK + 6), at(POCKET[2], THICK + 6), at(POCKET[3], THICK + 6))
  for (let k = 0; k < 4; k++) {
    const [a, b] = [POCKET[k], POCKET[(k + 1) % 4]]
    soup.quad(at(a, THICK), at(b, THICK), at(b, THICK + 6), at(a, THICK + 6))
  }
  return soup.bytes()
}

/** A separate small cube, outward-facing, appended to a part's facets. */
function withCube(bytes: ArrayBuffer, min: Vec3, size: number): ArrayBuffer {
  const soup = new Soup()
  const [x, y, z] = min
  const s = size
  const p = (dx: number, dy: number, dz: number): Vec3 => [x + dx * s, y + dy * s, z + dz * s]
  soup.quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0))
  soup.quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1))
  soup.quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1))
  soup.quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1))
  soup.quad(p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1))
  soup.quad(p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1))
  const part = importStl(bytes).mesh
  const cube = soup.mesh()
  const positions = new Float32Array(part.positions.length + cube.positions.length)
  positions.set(part.positions)
  positions.set(cube.positions, part.positions.length)
  const indices = new Uint32Array(positions.length / 3)
  for (let i = 0; i < indices.length; i++) indices[i] = i
  return exportBinaryStl({ positions, indices }).bytes
}

function offsetStl(bytes: ArrayBuffer, by: Vec3): ArrayBuffer {
  const mesh = importStl(bytes).mesh
  const positions = Float32Array.from(mesh.positions)
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    positions[offset] += by[0]
    positions[offset + 1] += by[1]
    positions[offset + 2] += by[2]
  }
  return exportBinaryStl({ positions, indices: mesh.indices }).bytes
}

/** Where CAD left the part: no component zero, none a round number here. */
const FILE_ORIGIN: Vec3 = [137.5, -62.25, 9.75]

function recognise(bytes: ArrayBuffer) {
  const parsed = importStl(bytes)
  return recognizeMeshFeatures(parsed.mesh, sourceFacetIdsOf(parsed.mesh))
}

// ------------------------------------------------------------ store fixtures

const SETUP_ID = 'setup-1908'
const TOOL_ID = 'tool-1908-flat'
const STOCK_ID = 'stock-1908'
const POCKET_ID = 'geo-1908-pocket'
const PLAIN_ID = 'geo-1908-plain'

const flatTool: Tool = {
  id: TOOL_ID, name: '6 mm flat', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 2.4 } },
} as unknown as Tool

const stock = {
  id: STOCK_ID, name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: -45, y: -35, z: 0 }, max: { x: 45, y: 35, z: THICK },
    size: { x: 90, y: 70, z: THICK }, center: { x: 0, y: 0, z: THICK / 2 },
  },
  // an explicit stock is its corner plus its size
  position: { x: -45, y: -35, z: 0 },
} as unknown as PhysicalStock

function stlRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl', loaded: true,
    stockId: STOCK_ID, assignedStockId: STOCK_ID,
    boundingBox: {
      min: { x: -40, y: -30, z: 0 }, max: { x: 40, y: 30, z: THICK },
      size: { x: 80, y: 60, z: THICK }, center: { x: 0, y: 0, z: THICK / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  } as unknown as ImportedGeometry
}

const heights = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 15, feedHeight: 14,
  topHeight: THICK, topHeightMode: 'absolute',
  bottomHeight: 0, bottomHeightMode: 'absolute',
} as unknown as HeightParams
const passes = { stepdown: 2, stepover: 2.4, stockToLeave: 0, finishPasses: 0, springPasses: 0 } as unknown as PassParams
const linking = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as unknown as LinkingParams

/** A 2D pocket bounded by one picked loop, its bottom the PICKED surface -
 *  the geometry-floor authority the dialog builds for a picked boundary. */
function pocketOp(id: string, geometryId: string, loopId: string): Operation {
  const params = { geometryId, loopIds: [loopId], boundarySource: 'geometry', direction: 'climb' }
  return {
    id, name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'idle',
    toolId: TOOL_ID, geometrySelections: [loopId],
    heights, passes, linking, params,
    smartHeight: {
      kind: 'smart_v2',
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: SETUP_ID, operationType: 'pocket_2d',
        safetyIntent: legacyHeightIntentForOperation({ type: 'pocket_2d', heights, params } as never),
        mode: 'geometry_floor', geometryIds: [geometryId],
      }),
    },
  } as unknown as Operation
}

function project(geometry: ImportedGeometry[]): Project {
  return {
    id: 'p-1908', name: 'STL pocket floor', version: '1.0.0',
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 200 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [flatTool], geometry, stocks: [stock],
    setups: [{
      id: SETUP_ID, name: 'Setup 1', operations: [], stock: null, notes: '',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54, stockId: STOCK_ID,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
    } as unknown as Setup],
    activeSetupId: SETUP_ID, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 0,
      fixedWidth: 200, fixedHeight: 200, fixedDepth: 20, fixedStocks: [],
    },
    notes: '',
  } as unknown as Project
}

function row(id: string): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find((g) => g.id === id)
  if (!found) throw new Error(`fixture row "${id}" vanished`)
  return found
}

async function computePocket(opId: string, geometryId: string, loopId: string) {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      setups: s.project.setups.map((setup) => setup.id === SETUP_ID
        ? { ...setup, operations: [pocketOp(opId, geometryId, loopId)] }
        : setup),
    },
  }))
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId)
  const computed = useCamStore.getState().project.setups[0].operations[0]
  if (computed.status === 'error') throw new Error(`compute failed: ${computed.errorMessage}`)
  return computed
}

/** The deepest a CUTTING move reaches. */
function cutFloorZ(op: Operation): number {
  const cutting = (op.toolpathMoves ?? []).filter((move) => move.type !== 'rapid' && move.z !== undefined)
  if (!cutting.length) throw new Error('no cutting moves')
  return Math.min(...cutting.map((move) => move.z as number))
}

// ---- evidence picture (written only with WRITE_EVIDENCE=1) -----------------
//   $env:WRITE_EVIDENCE='1'; npx vitest run src/tests/mesh/rectangularPocketRecognition.wo1908.test.ts
//   node src/tests/evidence/WO-1908/shoot.mjs

const WRITE = process.env.WRITE_EVIDENCE === '1'

/** Top view and a side section (Y = 0) of one computed pocket, over the part. */
function pocketPanel(op: Operation, title: string, offsetY: number): string {
  const moves = (op.toolpathMoves ?? []).filter((m) => m.x !== undefined && m.y !== undefined && m.z !== undefined)
  const scale = 5
  // top view: part X -45..45, Y -35..35 -> 450 x 350
  const tx = (x: number) => 20 + (x + 45) * scale
  const ty = (y: number) => offsetY + 40 + (35 - y) * scale
  // side view: part X -45..45, Z -2..16
  const sx = (x: number) => 520 + (x + 45) * scale
  const sz = (z: number) => offsetY + 40 + (16 - z) * scale * 2
  const path = (pts: Array<[number, number]>) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const cutting = moves.filter((m) => m.type !== 'rapid')
  const floorZ = Math.min(...cutting.map((m) => m.z as number))
  const parts = [
    `<text x="20" y="${offsetY + 24}" font-size="18" font-family="sans-serif" font-weight="bold">${title} - deepest cut Z ${floorZ.toFixed(4)}</text>`,
    // top view: block, pocket rectangle, moves
    `<rect x="${tx(-40)}" y="${ty(30)}" width="${80 * scale}" height="${60 * scale}" fill="#e8e8e8" stroke="#555"/>`,
    `<rect x="${tx(-20)}" y="${ty(10)}" width="${40 * scale}" height="${20 * scale}" fill="#fff" stroke="#d2691e" stroke-width="2"/>`,
    `<path d="${path(cutting.map((m) => [tx(m.x as number), ty(m.y as number)]))}" fill="none" stroke="#1f6feb" stroke-width="1"/>`,
    `<text x="20" y="${ty(-35) + 18}" font-size="13" font-family="sans-serif">TOP (part frame, X right, Y up)</text>`,
    // side section at Y = 0: block with the pocket cut, the measured floor, the moves
    `<path d="${path([[sx(-40), sz(0)], [sx(40), sz(0)], [sx(40), sz(12)], [sx(20), sz(12)], [sx(20), sz(6)], [sx(-20), sz(6)], [sx(-20), sz(12)], [sx(-40), sz(12)]])} Z" fill="#e8e8e8" stroke="#555"/>`,
    `<line x1="${sx(-45)}" y1="${sz(6)}" x2="${sx(45)}" y2="${sz(6)}" stroke="#d2691e" stroke-dasharray="6 4"/>`,
    `<text x="${sx(21)}" y="${sz(6) - 4}" font-size="12" font-family="sans-serif" fill="#d2691e">measured floor Z 6</text>`,
    `<line x1="${sx(-45)}" y1="${sz(0)}" x2="${sx(45)}" y2="${sz(0)}" stroke="#999" stroke-dasharray="2 3"/>`,
    `<text x="${sx(21)}" y="${sz(0) + 14}" font-size="12" font-family="sans-serif" fill="#777">part bottom Z 0</text>`,
    `<path d="${path(cutting.map((m) => [sx(m.x as number), sz(m.z as number)]))}" fill="none" stroke="#1f6feb" stroke-width="1"/>`,
    `<text x="520" y="${sz(-2) + 18}" font-size="13" font-family="sans-serif">SIDE (X right, Z up; tool centre path, blue)</text>`,
  ]
  return parts.join('\n')
}

function writePocketEvidence(before: Operation, after: Operation, listed: string): void {
  if (!WRITE) return
  const width = 1000
  const height = 900
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    pocketPanel(before, 'BEFORE: pocket driven from the hand-picked rim chain', 0),
    pocketPanel(after, 'AFTER: pocket driven from the recognised feature', 430),
    `<text x="20" y="${height - 16}" font-size="15" font-family="sans-serif">Store target list (loadMeshFeatureTargets, loop name): ${listed}</text>`,
    '</svg>',
  ].join('\n')
  writeFileSync('src/tests/evidence/WO-1908/pocket-before-after.svg', svg + '\n')
}

beforeEach(() => {
  stlBytesById.clear()
  stlBytesById.set(POCKET_ID, offsetStl(pocketBlock(), FILE_ORIGIN))
  stlBytesById.set(PLAIN_ID, offsetStl(plainBlock(), FILE_ORIGIN))
  useCamStore.setState({
    toolLibrary: [flatTool],
    project: project([stlRow(POCKET_ID, 'Pocket block'), stlRow(PLAIN_ID, 'Plain block')]),
  })
})

// ---------------------------------------------------------------------------

describe('WO-1908: recognition proves a rectangular pocket', () => {
  it('names the 40 x 20 pocket with its measured size, depth and floor', () => {
    const result = recognise(pocketBlock())
    expect(result.pockets).toHaveLength(1)
    const pocket = result.pockets[0]
    expect(pocket.kind).toBe('rectangular-pocket')
    expect(pocket.lengthMm).toBeCloseTo(40, 6)
    expect(pocket.widthMm).toBeCloseTo(20, 6)
    expect(pocket.depthMm).toBeCloseTo(THICK - FLOOR, 6)
    expect(pocket.floorNormal[2]).toBeCloseTo(1, 9)
    expect(pocket.maxDeviationMm).toBeLessThan(1e-6)
    for (const corner of pocket.corners) expect(corner[2]).toBeCloseTo(FLOOR, 6)
    // floor (a fan of 4) + four walls (2 each)
    expect(pocket.floorSourceFacetIds).toHaveLength(4)
    expect(pocket.sourceFacetIds).toHaveLength(12)
    expect(pocket.id).toBe(`rectangular-pocket-${pocket.sourceFacetIds[0]}`)
    // round features are a separate answer and there are none here
    expect(result.features).toEqual([])
  })

  it('reads the same pocket when the exporter wrote every side in pieces', () => {
    const pocket = recognise(pocketBlock(5)).pockets
    expect(pocket).toHaveLength(1)
    expect(pocket[0].lengthMm).toBeCloseTo(40, 6)
    expect(pocket[0].widthMm).toBeCloseTo(20, 6)
    expect(pocket[0].depthMm).toBeCloseTo(THICK - FLOOR, 6)
  })

  it('a drafted wall is not this family: nothing is listed rather than a guessed box', () => {
    expect(recognise(pocketBlock(1, 1)).pockets).toEqual([])
  })

  it('anything standing inside the pocket stops it being listed', () => {
    // a 2 mm cube floating in the middle of the pocket, well clear of every wall
    expect(recognise(withCube(pocketBlock(), [-1, -1, 8], 2)).pockets).toEqual([])
    // the SAME cube outside the part changes nothing - so it was the cube's place
    expect(recognise(withCube(pocketBlock(), [100, 100, 8], 2)).pockets).toHaveLength(1)
  })

  it('a pocket that opens DOWNWARD is found, and the target says why it cannot be cut from above', () => {
    // the same block turned over: mirror Z, and reverse every facet so the
    // material stays inside
    const mesh = importStl(pocketBlock()).mesh
    const positions = Float32Array.from(mesh.positions)
    for (let offset = 2; offset < positions.length; offset += 3) positions[offset] = THICK - positions[offset]
    for (let offset = 0; offset < positions.length; offset += 9) {
      for (let k = 0; k < 3; k++) {
        const swap = positions[offset + 3 + k]
        positions[offset + 3 + k] = positions[offset + 6 + k]
        positions[offset + 6 + k] = swap
      }
    }
    const flipped = { positions, indices: mesh.indices }
    const found = recognizeMeshFeatures(flipped).pockets
    expect(found).toHaveLength(1)
    expect(found[0].floorNormal[2]).toBeCloseTo(-1, 9)
    const targets = meshFeatureTargets(flipped)
    expect(targets.pockets).toEqual([])
    expect(targets.refusals).toEqual([{
      featureId: found[0].id,
      kind: 'rectangular-pocket',
      reason: 'it opens downward - a pocket is cut from above, so the part needs turning over first.',
    }])
  })

  it('negative control: a plain block and a rectangular boss list no pocket', () => {
    const plain = recognise(plainBlock())
    expect(plain.pockets).toEqual([])
    expect(plain.features).toEqual([])
    expect(recognise(bossBlock()).pockets).toEqual([])
  })
})

describe('WO-1908: round features read exactly as they did', () => {
  it('the WO-1846 plate gives the same round features, source ids and all, as main', () => {
    // The plate's own bytes, written by WO-1851's copy of WO-1846's builder and
    // kept in this order's evidence; the expected answer was recorded from
    // main's recogniser BEFORE this order changed it.
    const bytes = readFileSync('src/tests/evidence/WO-1908/acceptance-plate.stl')
    const plate = recognise(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    const onMain = JSON.parse(readFileSync('src/tests/evidence/WO-1908/plate-round-features.main.json', 'utf8'))
    expect(JSON.parse(JSON.stringify(plate.features))).toEqual(onMain.features)
    expect(JSON.parse(JSON.stringify(plate.refusals))).toEqual(onMain.refusals)
    expect(plate.pockets).toEqual([])
  })
})

describe('WO-1908: the store offers the pocket with its measured floor', () => {
  it('lists "rectangular pocket 40.00 x 20.00 mm, floor Z 6.00" in the part frame', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(POCKET_ID)
    expect(targets.refusals).toEqual([])
    expect(targets.holes).toEqual([])
    expect(targets.pockets).toHaveLength(1)
    const pocket = targets.pockets[0]
    expect(describePocketTarget(pocket)).toBe('rectangular pocket 40.00 x 20.00 mm, floor Z 6.00')
    expect(pocket.floorZ).toBeCloseTo(FLOOR, 4)
    expect(pocket.topZ).toBeCloseTo(THICK, 4)
    // RECENTRED: the file has the pocket at x 97.5..177.5; the part frame at -20..20
    const xs = pocket.outline!.map((p) => p[0])
    const ys = pocket.outline!.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(-20, 3)
    expect(Math.max(...xs)).toBeCloseTo(20, 3)
    expect(Math.min(...ys)).toBeCloseTo(-10, 3)
    expect(Math.max(...ys)).toBeCloseTo(10, 3)

    // It lands on the floor layer whose plane IS the measured floor, as a
    // rectangle named the way the operator reads it.
    const geometry = row(POCKET_ID)
    const layer = (geometry.layers2d ?? []).find((l) => l.name.startsWith('STL pocket floors'))
    expect(layer).toBeDefined()
    expect(layer!.projectionPlane!.origin.z).toBeCloseTo(FLOOR, 4)
    const loop = (geometry.loops ?? []).find((l) => l.layerId === layer!.id)!
    expect(loop.name).toBe('rectangular pocket 40.00 x 20.00 mm, floor Z 6.00')
    expect(loop.points).toHaveLength(4)
    expect(loop.area).toBeCloseTo(800, 3)
    // a pocket sees it; a drill does not
    expect((geometryForOperation(geometry, 'pocket_2d').loops ?? []).map((l) => l.id)).toContain(loop.id)
    expect((geometryForOperation(geometry, 'drill').loops ?? []).map((l) => l.id)).not.toContain(loop.id)
  })

  it('negative control: the plain block lists nothing and refuses nothing', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(PLAIN_ID)
    expect(targets).toMatchObject({ holes: [], pockets: [], refusals: [] })
  })

  it('a pocket op from the feature bottoms at Z 6.0000, where the rim pick bottoms at its layer plane', async () => {
    // BEFORE this order: the operator picks the rim by hand. The chain has no
    // floor of its own, so the pocket's depth is not the measured floor -
    // measured here: it cuts on down to the bottom of the part, Z 0.
    const chains = await useCamStore.getState().loadMeshEdgeChains(POCKET_ID)
    const rim = chains.find((chain) => chain.closed && Math.abs(chain.area - 800) < 1)
    expect(rim, 'no closed rim chain round the pocket').toBeDefined()
    const byRim = await computePocket('op-rim', POCKET_ID, rim!.id)
    const rimFloor = cutFloorZ(byRim)
    expect(Math.abs(rimFloor - FLOOR)).toBeGreaterThan(1)

    // AFTER: the same pocket, driven from the recognised feature.
    await useCamStore.getState().loadMeshFeatureTargets(POCKET_ID)
    const layer = (row(POCKET_ID).layers2d ?? []).find((l) => l.name.startsWith('STL pocket floors'))!
    const loop = (row(POCKET_ID).loops ?? []).find((l) => l.layerId === layer.id)!
    const byFeature = await computePocket('op-feature', POCKET_ID, loop.id)
    expect(Number(cutFloorZ(byFeature).toFixed(4))).toBe(6)
    writePocketEvidence(byRim, byFeature, loop.name ?? '')
    // and every cutting move stays inside the 40 x 20 rectangle, less the tool radius
    for (const move of (byFeature.toolpathMoves ?? []).filter((m) => m.type !== 'rapid')) {
      if (move.x === undefined || move.y === undefined) continue
      expect(Math.abs(move.x)).toBeLessThanOrEqual(20 - 3 + 1e-3)
      expect(Math.abs(move.y)).toBeLessThanOrEqual(10 - 3 + 1e-3)
    }
  })
})
