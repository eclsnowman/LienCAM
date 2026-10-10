// @vitest-environment jsdom
//
// WO-1909: a slot or drafted wall is named and reachable.
//
// Same harness as WO-1908 (rule 6): the store claims go through the store's
// own `loadMeshFeatureTargets` / `loadMeshEdgeChains` actions, the shared
// `geometryForOperation` boundary, and the real `computeOperationToolpath`
// with the production toolpath worker running in this thread, authored with
// the PRODUCTION Smart Height builder (`buildPlanarRoughSmartHeightIntent`,
// geometry-floor mode).
//
// Fixtures are triangle soups built here and re-exported offset from the
// origin the way CAD leaves a part, so recentring has a real value to get
// wrong. The top face round each opening is triangulated by three's
// ShapeUtils, so every part is a closed, valid solid.

import { readFileSync, writeFileSync } from 'node:fs'
import { ShapeUtils, Vector2 } from 'three'
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

type P2 = [number, number]

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

const OUTER: P2[] = [[-40, -30], [40, -30], [40, 30], [-40, 30]]
const THICK = 12
const FLOOR = 6
const DEPTH = THICK - FLOOR

function outerShell(soup: Soup): void {
  soup.quad(at(OUTER[0], 0), at(OUTER[3], 0), at(OUTER[2], 0), at(OUTER[1], 0))
  for (let k = 0; k < 4; k++) {
    const [a, b] = [OUTER[k], OUTER[(k + 1) % 4]]
    soup.quad(at(a, 0), at(b, 0), at(b, THICK), at(a, THICK))
  }
}

/** The top face at THICK, the outer rectangle less the opening `rim` (CCW),
 *  every triangle facing up. */
function topWithOpening(soup: Soup, rim: P2[]): void {
  const contour = OUTER.map(([x, y]) => new Vector2(x, y))
  const hole = [...rim].reverse().map(([x, y]) => new Vector2(x, y))
  const points = [...contour, ...hole]
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [hole])) {
    const [a, b, c] = [points[i], points[j], points[k]]
    const up = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0
    const [p, q, r] = up ? [a, b, c] : [a, c, b]
    soup.tri([p.x, p.y, THICK], [q.x, q.y, THICK], [r.x, r.y, THICK])
  }
}

/** A cavity: floor ring (CCW) at FLOOR fanned from `centre`, walls from each
 *  floor point to the rim point of the same index at THICK, facing inward. */
function cavity(floorRing: P2[], rimRing: P2[], centre: P2 = [0, 0]): ArrayBuffer {
  const soup = new Soup()
  outerShell(soup)
  topWithOpening(soup, rimRing)
  for (let i = 0; i < floorRing.length; i++) {
    const j = (i + 1) % floorRing.length
    soup.tri(at(centre, FLOOR), at(floorRing[i], FLOOR), at(floorRing[j], FLOOR))
    soup.quad(at(floorRing[i], FLOOR), at(rimRing[i], THICK), at(rimRing[j], THICK), at(floorRing[j], FLOOR))
  }
  return soup.bytes()
}

/** A round-ended slot outline, CCW: centreline a -> b, half-width r, each end
 *  a semicircle in `chords` pieces (a vertex on its apex when `chords` is even). */
function stadium(a: P2, b: P2, r: number, chords = 16): P2[] {
  const run = Math.hypot(b[0] - a[0], b[1] - a[1])
  const d: P2 = [(b[0] - a[0]) / run, (b[1] - a[1]) / run]
  const e: P2 = [-d[1], d[0]]
  const arc = (c: P2, from: number): P2[] => Array.from({ length: chords + 1 }, (_, i) => {
    const t = from + (Math.PI * i) / chords
    return [c[0] + r * (d[0] * Math.cos(t) + e[0] * Math.sin(t)), c[1] + r * (d[1] * Math.cos(t) + e[1] * Math.sin(t))]
  })
  return [...arc(b, -Math.PI / 2), ...arc(a, Math.PI / 2)]
}

/** The acceptance slot: two 30 mm walls 8 mm apart, round ends, floor Z 6. */
const SLOT_A: P2 = [-15, 0]
const SLOT_B: P2 = [15, 0]
function slotBlock(a: P2 = SLOT_A, b: P2 = SLOT_B): ArrayBuffer {
  const ring = stadium(a, b, 4)
  return cavity(ring, ring, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
}

const RECT = (x0: number, y0: number, x1: number, y1: number): P2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

/** A straight-walled rectangular pocket (WO-1908's family). */
function rectBlock(x: number, y: number): ArrayBuffer {
  const ring = RECT(-x / 2, -y / 2, x / 2, y / 2)
  return cavity(ring, ring)
}

/**
 * The 40 x 20 pocket, floor Z 6, with each wall leaning by its own angle:
 * `leanDeg[k]` for the wall on floor side k (0: -Y, 1: +X, 2: +Y, 3: -X).
 * Positive opens out (draft), negative overhangs the floor (undercut).
 */
function draftedBlock(leanDeg: [number, number, number, number]): ArrayBuffer {
  const out = leanDeg.map((deg) => DEPTH * Math.tan((deg * Math.PI) / 180))
  const floor = RECT(-20, -10, 20, 10)
  const rim = RECT(-20 - out[3], -10 - out[0], 20 + out[1], 10 + out[2])
  return cavity(floor, rim)
}

/** The same block with no cavity at all. */
function plainBlock(): ArrayBuffer {
  const soup = new Soup()
  outerShell(soup)
  soup.quad(at(OUTER[0], THICK), at(OUTER[1], THICK), at(OUTER[2], THICK), at(OUTER[3], THICK))
  return soup.bytes()
}

/** A separate small cube, outward-facing, appended to a part's facets. */
function withCube(bytes: ArrayBuffer, min: Vec3, size: number): ArrayBuffer {
  const soup = new Soup()
  const [x, y, z] = min
  const p = (dx: number, dy: number, dz: number): Vec3 => [x + dx * size, y + dy * size, z + dz * size]
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

const UNDERCUT_DEG = 5
/** The acceptance drafted wall: the +Y wall overhangs the floor by 5 degrees. */
const ONE_UNDERCUT: [number, number, number, number] = [0, 0, -UNDERCUT_DEG, 0]
/** how far the undercut rim sits in from the floor edge: 6 x tan 5 = 0.5249 mm */
const OVERHANG = DEPTH * Math.tan((UNDERCUT_DEG * Math.PI) / 180)

// ------------------------------------------------------------ store fixtures

const SETUP_ID = 'setup-1909'
const TOOL_ID = 'tool-1909-flat'
const STOCK_ID = 'stock-1909'
const SLOT_ID = 'geo-1909-slot'
const DRAFT_ID = 'geo-1909-drafted'
const PLAIN_ID = 'geo-1909-plain'
const STRAIGHT_ID = 'geo-1909-straight'

const flatTool: Tool = {
  id: TOOL_ID, name: '6 mm flat', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 2.4 } },
} as unknown as Tool
const TOOL_R = 3

const stock = {
  id: STOCK_ID, name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: -45, y: -35, z: 0 }, max: { x: 45, y: 35, z: THICK },
    size: { x: 90, y: 70, z: THICK }, center: { x: 0, y: 0, z: THICK / 2 },
  },
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
    id: 'p-1909', name: 'STL slots and drafted walls', version: '1.0.0',
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

/** The loop the store landed for the one recognised floor target of `id`. */
function landedFloorLoop(id: string) {
  const layer = (row(id).layers2d ?? []).find((l) => l.name.startsWith('STL pocket floors'))
  if (!layer) throw new Error('no floor layer landed')
  const loop = (row(id).loops ?? []).find((l) => l.layerId === layer.id)
  if (!loop) throw new Error('no floor loop landed')
  return { layer, loop }
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

function cuttingMoves(op: Operation) {
  return (op.toolpathMoves ?? []).filter((m) =>
    m.type !== 'rapid' && m.x !== undefined && m.y !== undefined && m.z !== undefined) as
    Array<{ x: number; y: number; z: number; type: string }>
}

function cutFloorZ(op: Operation): number {
  const cutting = cuttingMoves(op)
  if (!cutting.length) throw new Error('no cutting moves')
  return Math.min(...cutting.map((m) => m.z))
}

/** How far the undercut +Y wall stands from Y 0 at local height z: it
 *  overhangs the floor edge (Y 10) more the higher it gets. */
const undercutWallY = (z: number): number => 10 - (z - FLOOR) * Math.tan((UNDERCUT_DEG * Math.PI) / 180)

/** Deepest bite any cutting move takes into the undercut wall, mm (<= 0: clear). */
function undercutBite(op: Operation): number {
  let worst = -Infinity
  for (const m of cuttingMoves(op)) {
    if (m.z <= FLOOR + 1e-6 || m.z > THICK) continue
    worst = Math.max(worst, m.y + TOOL_R - undercutWallY(m.z))
  }
  return worst
}

// ---- evidence picture (written only with WRITE_EVIDENCE=1) -----------------
//   $env:WRITE_EVIDENCE='1'; npx vitest run src/tests/mesh/slotAndDraftedWallRecognition.wo1909.test.ts
//   node src/tests/evidence/WO-1909/shoot.mjs

const WRITE = process.env.WRITE_EVIDENCE === '1'
const EVIDENCE = 'src/tests/evidence/WO-1909'
const pathOf = (pts: P2[]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

/** Top view and a Y-Z section (at X 0) of one computed drafted-pocket op. */
function draftedPanel(op: Operation, title: string, offsetY: number): string {
  const cutting = cuttingMoves(op)
  const s = 5
  const tx = (x: number) => 20 + (x + 45) * s
  const ty = (y: number) => offsetY + 40 + (35 - y) * s
  // section: Y horizontal (-15..15), Z up (-1..14)
  const sx = (y: number) => 560 + (y + 15) * 12
  const sz = (z: number) => offsetY + 40 + (14 - z) * 22
  const bite = undercutBite(op)
  const inSection = cutting.filter((m) => Math.abs(m.x) < 1.5)
  const undercutPoly: P2[] = [[sx(15), sz(THICK)], [sx(10 - OVERHANG), sz(THICK)], [sx(10), sz(FLOOR)], [sx(-10), sz(FLOOR)],
    [sx(-10), sz(THICK)], [sx(-15), sz(THICK)], [sx(-15), sz(0)], [sx(15), sz(0)]]
  const parts = [
    `<text x="20" y="${offsetY + 24}" font-size="18" font-family="sans-serif" font-weight="bold">${title}</text>`,
    `<text x="20" y="${offsetY + 44}" font-size="14" font-family="sans-serif" fill="${bite > 1e-3 ? '#c62828' : '#2e7d32'}">` +
      `deepest cut Z ${cutFloorZ(op).toFixed(4)}; worst bite into the 5 deg undercut wall ${bite > 1e-3 ? bite.toFixed(3) + ' mm (GOUGE)' : 'none (clear by ' + (-bite).toFixed(3) + ' mm)'}</text>`,
    `<rect x="${tx(-40)}" y="${ty(30)}" width="${80 * s}" height="${60 * s}" fill="#e8e8e8" stroke="#555"/>`,
    `<rect x="${tx(-20)}" y="${ty(10)}" width="${40 * s}" height="${20 * s}" fill="#fff" stroke="#d2691e" stroke-width="2"/>`,
    `<line x1="${tx(-20)}" y1="${ty(10 - OVERHANG)}" x2="${tx(20)}" y2="${ty(10 - OVERHANG)}" stroke="#c62828" stroke-dasharray="5 3"/>`,
    `<path d="${pathOf(cutting.map((m) => [tx(m.x), ty(m.y)]))}" fill="none" stroke="#1f6feb" stroke-width="1"/>`,
    `<text x="20" y="${ty(-35) + 18}" font-size="13" font-family="sans-serif">TOP (part frame; red dashes: undercut rim, 0.525 mm in from the floor edge)</text>`,
    `<path d="${pathOf(undercutPoly)} Z" fill="#e8e8e8" stroke="#555"/>`,
    ...inSection.map((m) =>
      `<rect x="${sx(m.y - TOOL_R)}" y="${sz(m.z) - 1}" width="${TOOL_R * 2 * 12}" height="2" fill="#1f6feb" fill-opacity="0.35"/>`),
    `<text x="${sx(10.3)}" y="${sz(9)}" font-size="12" font-family="sans-serif" fill="#c62828">5 deg undercut</text>`,
    `<text x="560" y="${sz(-1) + 16}" font-size="13" font-family="sans-serif">SECTION at X 0 (Y right, Z up; blue bars: cutter width at each cutting Z)</text>`,
  ]
  return parts.join('\n')
}

function writeDraftedEvidence(before: Operation, after: Operation, listed: string): void {
  if (!WRITE) return
  const width = 1000
  const height = 960
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    draftedPanel(before, 'BEFORE: pocket from the hand-picked floor-edge chain', 0),
    draftedPanel(after, 'AFTER: pocket from the recognised drafted pocket', 450),
    `<text x="20" y="${height - 16}" font-size="14" font-family="sans-serif">Store target (loop name): ${listed}</text>`,
    '</svg>',
  ].join('\n')
  writeFileSync(`${EVIDENCE}/drafted-before-after.svg`, svg + '\n')
}

/** The target list the store landed for each fixture, as the operation
 *  pickers name the loops, with the slot's outline and centreline drawn. */
function writeListingEvidence(entries: Array<{ part: string; names: string[] }>, slotOutline: P2[], centerline: [P2, P2]): void {
  if (!WRITE) return
  const width = 1000
  const height = 640
  const s = 8
  const tx = (x: number) => 520 + (x + 25) * s
  const ty = (y: number) => 460 + (10 - y) * s
  const lines = entries.flatMap((entry, i) => [
    `<text x="20" y="${80 + i * 110}" font-size="16" font-family="sans-serif" font-weight="bold">${entry.part}</text>`,
    ...(entry.names.length ? entry.names : ['(nothing listed)']).map((name, k) =>
      `<text x="36" y="${104 + i * 110 + k * 20}" font-size="14" font-family="monospace">${name}</text>`),
  ])
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<text x="20" y="36" font-size="18" font-family="sans-serif" font-weight="bold">WO-1909: recognised STL floor targets, as loadMeshFeatureTargets lands them (loop names)</text>`,
    ...lines,
    `<path d="${pathOf(slotOutline.map(([x, y]) => [tx(x), ty(y)]))} Z" fill="#fff3e0" stroke="#d2691e" stroke-width="2"/>`,
    `<line x1="${tx(centerline[0][0])}" y1="${ty(centerline[0][1])}" x2="${tx(centerline[1][0])}" y2="${ty(centerline[1][1])}" stroke="#1f6feb" stroke-width="2"/>`,
    `<text x="520" y="600" font-size="13" font-family="sans-serif">slot outline (orange) and centreline (blue), part frame, 8 px/mm</text>`,
    '</svg>',
  ].join('\n')
  writeFileSync(`${EVIDENCE}/target-listing.svg`, svg + '\n')
}

beforeEach(() => {
  stlBytesById.clear()
  stlBytesById.set(SLOT_ID, offsetStl(slotBlock(), FILE_ORIGIN))
  stlBytesById.set(DRAFT_ID, offsetStl(draftedBlock(ONE_UNDERCUT), FILE_ORIGIN))
  stlBytesById.set(PLAIN_ID, offsetStl(plainBlock(), FILE_ORIGIN))
  stlBytesById.set(STRAIGHT_ID, offsetStl(rectBlock(40, 20), FILE_ORIGIN))
  useCamStore.setState({
    toolLibrary: [flatTool],
    project: project([
      stlRow(SLOT_ID, 'Slot block'), stlRow(DRAFT_ID, 'Drafted block'),
      stlRow(PLAIN_ID, 'Plain block'), stlRow(STRAIGHT_ID, 'Straight pocket block'),
    ]),
  })
})

// ---------------------------------------------------------------------------

describe('WO-1909: recognition proves a slot', () => {
  it('names the 30 mm-wall, 8 mm round-ended slot with its length, width and end style', () => {
    const result = recognise(offsetStl(slotBlock(), FILE_ORIGIN))
    expect(result.slots).toHaveLength(1)
    const slot = result.slots[0]
    expect(slot.kind).toBe('slot')
    expect(slot.endStyle).toBe('round')
    expect(slot.widthMm).toBeCloseTo(8, 4)
    expect(slot.lengthMm).toBeCloseTo(38, 4)
    expect(slot.depthMm).toBeCloseTo(DEPTH, 4)
    expect(slot.floorNormal[2]).toBeCloseTo(1, 9)
    expect(slot.maxDeviationMm).toBeLessThan(0.25)
    // the centreline is the two end-arc centres, on the floor, in the FILE frame
    const ends = [...slot.centerline].sort((a, b) => a[0] - b[0])
    expect(ends[0][0]).toBeCloseTo(-15 + FILE_ORIGIN[0], 3)
    expect(ends[1][0]).toBeCloseTo(15 + FILE_ORIGIN[0], 3)
    for (const end of ends) {
      expect(end[1]).toBeCloseTo(FILE_ORIGIN[1], 3)
      expect(end[2]).toBeCloseTo(FLOOR + FILE_ORIGIN[2], 3)
    }
    expect(slot.id).toBe(`slot-${slot.sourceFacetIds[0]}`)
    // it is not also a pocket, a drafted pocket, a round feature or a refusal
    expect(result.pockets).toEqual([])
    expect(result.draftedPockets).toEqual([])
    expect(result.features).toEqual([])
    expect(result.refusals).toEqual([])
  })

  it('reads the same slot turned 30 degrees on the part', () => {
    const c = Math.cos(Math.PI / 6)
    const s = Math.sin(Math.PI / 6)
    const slots = recognise(slotBlock([-15 * c, -15 * s], [15 * c, 15 * s])).slots
    expect(slots).toHaveLength(1)
    expect(slots[0].endStyle).toBe('round')
    expect(slots[0].widthMm).toBeCloseTo(8, 4)
    expect(slots[0].lengthMm).toBeCloseTo(38, 4)
    const [a, b] = slots[0].centerline
    expect(Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) % Math.PI)).toBeCloseTo(Math.PI / 6, 4)
  })

  it('a long rectangle is a flat-ended slot; WO-1908\'s 40 x 20 stays a pocket', () => {
    const flat = recognise(rectBlock(38, 8))
    expect(flat.pockets).toEqual([])
    expect(flat.slots).toHaveLength(1)
    expect(flat.slots[0]).toMatchObject({ endStyle: 'flat' })
    expect(flat.slots[0].lengthMm).toBeCloseTo(38, 6)
    expect(flat.slots[0].widthMm).toBeCloseTo(8, 6)
    // centreline half a width in from each end wall
    const xs = flat.slots[0].centerline.map((p) => p[0]).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(-15, 6)
    expect(xs[1]).toBeCloseTo(15, 6)

    const pocket = recognise(rectBlock(40, 20))
    expect(pocket.pockets).toHaveLength(1)
    expect(pocket.slots).toEqual([])
    expect(pocket.draftedPockets).toEqual([])
  })

  it('anything standing inside the slot stops it being listed; the same cube outside does not', () => {
    expect(recognise(withCube(slotBlock(), [-1, -1, 8], 2)).slots).toEqual([])
    expect(recognise(withCube(slotBlock(), [100, 100, 8], 2)).slots).toHaveLength(1)
  })
})

describe('WO-1909: recognition proves a drafted wall', () => {
  it('names the 5-degree undercut wall and pulls the cutter reach in by the overhang', () => {
    const result = recognise(offsetStl(draftedBlock(ONE_UNDERCUT), FILE_ORIGIN))
    expect(result.pockets).toEqual([])
    expect(result.slots).toEqual([])
    expect(result.draftedPockets).toHaveLength(1)
    const drafted = result.draftedPockets[0]
    expect(drafted.kind).toBe('drafted-pocket')
    expect(drafted.lengthMm).toBeCloseTo(40, 4)
    expect(drafted.widthMm).toBeCloseTo(20, 4)
    expect(drafted.depthMm).toBeCloseTo(DEPTH, 4)
    // one wall leans 5 degrees over the floor; the other three stand square
    const leans = [...drafted.wallDraftDeg].sort((a, b) => a - b)
    expect(leans[0]).toBeCloseTo(-UNDERCUT_DEG, 3)
    for (const square of leans.slice(1)) expect(Math.abs(square)).toBeLessThan(1e-3)
    // the reach: the floor, less 6 x tan 5 = 0.525 mm off the +Y side only
    const clearY = drafted.clearCorners.map((p) => p[1] - FILE_ORIGIN[1])
    const clearX = drafted.clearCorners.map((p) => p[0] - FILE_ORIGIN[0])
    expect(Math.max(...clearY)).toBeCloseTo(10 - OVERHANG, 4)
    expect(Math.min(...clearY)).toBeCloseTo(-10, 4)
    expect(Math.min(...clearX)).toBeCloseTo(-20, 4)
    expect(Math.max(...clearX)).toBeCloseTo(20, 4)
    expect(result.features).toEqual([])
  })

  it('an ordinary draft on every wall is listed with its angle and leaves the reach at the floor', () => {
    const drafted = recognise(draftedBlock([5, 5, 5, 5])).draftedPockets
    expect(drafted).toHaveLength(1)
    for (const lean of drafted[0].wallDraftDeg) expect(lean).toBeCloseTo(5, 3)
    const ys = drafted[0].clearCorners.map((p) => p[1])
    expect(Math.max(...ys)).toBeCloseTo(10, 4)
    // WO-1908's own 1 mm-drafted fixture (atan(1/6) = 9.46 deg) now reads as one
    const wo1908 = recognise(draftedBlock([9.4623, 9.4623, 9.4623, 9.4623]))
    expect(wo1908.pockets).toEqual([])
    expect(wo1908.draftedPockets[0].wallDraftDeg[0]).toBeCloseTo(9.4623, 3)
  })

  it('anything standing inside the drafted pocket stops it being listed', () => {
    expect(recognise(withCube(draftedBlock(ONE_UNDERCUT), [-1, -1, 8], 2)).draftedPockets).toEqual([])
    expect(recognise(withCube(draftedBlock(ONE_UNDERCUT), [100, 100, 8], 2)).draftedPockets).toHaveLength(1)
  })

  it('negative control: a plain block and a straight-walled pocket list nothing new', () => {
    const plain = recognise(plainBlock())
    expect(plain).toMatchObject({ features: [], pockets: [], slots: [], draftedPockets: [], refusals: [] })
    const straight = recognise(rectBlock(40, 20))
    expect(straight.slots).toEqual([])
    expect(straight.draftedPockets).toEqual([])
    expect(straight.pockets).toHaveLength(1)
  })
})

describe('WO-1909: WO-1908 and WO-1846 fixtures read exactly as they did', () => {
  it('the WO-1846 plate gives the same round features and refusals as main, and nothing new', () => {
    const bytes = readFileSync('src/tests/evidence/WO-1908/acceptance-plate.stl')
    const plate = recognise(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    const onMain = JSON.parse(readFileSync('src/tests/evidence/WO-1908/plate-round-features.main.json', 'utf8'))
    expect(JSON.parse(JSON.stringify(plate.features))).toEqual(onMain.features)
    expect(JSON.parse(JSON.stringify(plate.refusals))).toEqual(onMain.refusals)
    expect(plate.pockets).toEqual([])
    expect(plate.slots).toEqual([])
    expect(plate.draftedPockets).toEqual([])
  })
})

describe('WO-1909: the store offers slots and drafted pockets as pocket floors', () => {
  it('lists "slot 38.00 x 8.00 mm, round ends, floor Z 6.00" in the part frame, with its centreline', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(SLOT_ID)
    expect(targets.refusals).toEqual([])
    expect(targets.holes).toEqual([])
    expect(targets.pockets).toHaveLength(1)
    const slot = targets.pockets[0]
    expect(slot.kind).toBe('slot')
    expect(describePocketTarget(slot)).toBe('slot 38.00 x 8.00 mm, round ends, floor Z 6.00')
    expect(slot.floorZ).toBeCloseTo(FLOOR, 4)
    expect(slot.topZ).toBeCloseTo(THICK, 4)
    const ends = [...slot.centerline!].sort((a, b) => a[0] - b[0])
    expect(ends[0][0]).toBeCloseTo(-15, 3)
    expect(ends[1][0]).toBeCloseTo(15, 3)
    expect(ends[0][1]).toBeCloseTo(0, 3)
    // the outline stays inside the slot: every point 4 mm from the centreline or less
    for (const [x, y] of slot.outline!) {
      const along = Math.max(-15, Math.min(15, x))
      expect(Math.hypot(x - along, y)).toBeLessThanOrEqual(4 + 1e-3)
    }

    const { layer, loop } = landedFloorLoop(SLOT_ID)
    expect(layer.projectionPlane!.origin.z).toBeCloseTo(FLOOR, 4)
    expect(loop.name).toBe('slot 38.00 x 8.00 mm, round ends, floor Z 6.00')
    expect(loop.area).toBeCloseTo(2 * 4 * 30 + Math.PI * 16, 0)
    expect((geometryForOperation(row(SLOT_ID), 'pocket_2d').loops ?? []).map((l) => l.id)).toContain(loop.id)
    expect((geometryForOperation(row(SLOT_ID), 'drill').loops ?? []).map((l) => l.id)).not.toContain(loop.id)
  })

  it('a pocket op from the slot bottoms on its floor and runs its own centreline end to end', async () => {
    await useCamStore.getState().loadMeshFeatureTargets(SLOT_ID)
    const { loop } = landedFloorLoop(SLOT_ID)
    const op = await computePocket('op-slot', SLOT_ID, loop.id)
    expect(Number(cutFloorZ(op).toFixed(4))).toBe(FLOOR)
    const cutting = cuttingMoves(op)
    // the 6 mm cutter's centre never strays more than 4 - 3 = 1 mm off the
    // centreline (so its edge never passes a wall) ...
    for (const m of cutting) {
      const along = Math.max(-15, Math.min(15, m.x))
      expect(Math.hypot(m.x - along, m.y)).toBeLessThanOrEqual(4 - TOOL_R + 1e-3)
    }
    // ... and it reaches both ends: within 0.1 mm of the end arcs' reach
    expect(Math.max(...cutting.map((m) => m.x))).toBeGreaterThan(15 + (4 - TOOL_R) - 0.1)
    expect(Math.min(...cutting.map((m) => m.x))).toBeLessThan(-15 - (4 - TOOL_R) + 0.1)
  })

  it('lists the drafted pocket with its angle; its op stays clear of the undercut, the floor-edge pick gouges it', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(DRAFT_ID)
    expect(targets.refusals).toEqual([])
    expect(targets.pockets).toHaveLength(1)
    const drafted = targets.pockets[0]
    const name = describePocketTarget(drafted)
    expect(name).toBe('drafted pocket 40.00 x 20.00 mm, 1 wall 5.0 deg undercut (cutter reach 40.00 x 19.48 mm), floor Z 6.00')
    const ys = drafted.outline!.map((p) => p[1])
    expect(Math.max(...ys)).toBeCloseTo(10 - OVERHANG, 3)
    expect(Math.min(...ys)).toBeCloseTo(-10, 3)
    expect(Math.max(...drafted.floorOutline!.map((p) => p[1]))).toBeCloseTo(10, 3)

    // BEFORE this order: nothing is recognised; the operator picks the floor
    // edge by hand (the sharp 40 x 20 chain round the floor).
    const chains = await useCamStore.getState().loadMeshEdgeChains(DRAFT_ID)
    const floorChain = chains.find((chain) => chain.closed && Math.abs(chain.area - 800) < 1)
    expect(floorChain, 'no closed floor-edge chain round the pocket').toBeDefined()
    const byChain = await computePocket('op-chain', DRAFT_ID, floorChain!.id)
    expect(undercutBite(byChain)).toBeGreaterThan(0.1)

    // AFTER: the recognised drafted pocket.
    await useCamStore.getState().loadMeshFeatureTargets(DRAFT_ID)
    const { loop } = landedFloorLoop(DRAFT_ID)
    expect(loop.name).toBe(name)
    const byFeature = await computePocket('op-drafted', DRAFT_ID, loop.id)
    expect(Number(cutFloorZ(byFeature).toFixed(4))).toBe(FLOOR)
    expect(undercutBite(byFeature)).toBeLessThanOrEqual(1e-3)
    writeDraftedEvidence(byChain, byFeature, loop.name ?? '')
  })

  it('negative control: the plain block and a straight-walled pocket land nothing new', async () => {
    expect(await useCamStore.getState().loadMeshFeatureTargets(PLAIN_ID))
      .toMatchObject({ holes: [], pockets: [], refusals: [] })
    const straight = await useCamStore.getState().loadMeshFeatureTargets(STRAIGHT_ID)
    expect(straight.pockets.map((p) => p.kind)).toEqual(['rectangular-pocket'])
    expect(describePocketTarget(straight.pockets[0])).toBe('rectangular pocket 40.00 x 20.00 mm, floor Z 6.00')
  })

  it('evidence: the landed target listing for every fixture', async () => {
    const entries: Array<{ part: string; names: string[] }> = []
    for (const [id, part] of [[SLOT_ID, 'Slot block'], [DRAFT_ID, 'Drafted block'], [STRAIGHT_ID, 'Straight pocket block'], [PLAIN_ID, 'Plain block']]) {
      const targets = await useCamStore.getState().loadMeshFeatureTargets(id)
      entries.push({ part, names: targets.pockets.map(describePocketTarget) })
    }
    expect(entries.map((e) => e.names.length)).toEqual([1, 1, 1, 0])
    const slot = (await useCamStore.getState().loadMeshFeatureTargets(SLOT_ID)).pockets[0]
    writeListingEvidence(entries, slot.outline!, slot.centerline!)
  })

  it('a slot or drafted pocket that opens downward is found, and the target says why', () => {
    const flip = (bytes: ArrayBuffer): MeshBuffers => {
      const mesh = importStl(bytes).mesh
      const positions = Float32Array.from(mesh.positions)
      for (let offset = 2; offset < positions.length; offset += 3) positions[offset] = THICK - positions[offset]
      for (let offset = 0; offset < positions.length; offset += 9) {
        for (let k = 0; k < 3; k++) {
          const swap = positions[offset + 3 + k]
          positions[offset + 3 + k] = positions[offset + 6 + k]
          positions[offset + 6 + k] = swap
        }
      }
      return { positions, indices: mesh.indices }
    }
    const reason = 'it opens downward - a pocket is cut from above, so the part needs turning over first.'
    const slot = meshFeatureTargets(flip(slotBlock()))
    expect(slot.pockets).toEqual([])
    expect(slot.refusals).toEqual([{ featureId: expect.stringMatching(/^slot-/), kind: 'slot', reason }])
    const drafted = meshFeatureTargets(flip(draftedBlock(ONE_UNDERCUT)))
    expect(drafted.pockets).toEqual([])
    expect(drafted.refusals).toEqual([{ featureId: expect.stringMatching(/^drafted-pocket-/), kind: 'drafted-pocket', reason }])
  })
})
