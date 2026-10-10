// @vitest-environment jsdom
//
// WO-2706. Entering Simulate on examples/06-knob-handwheel froze the page
// ~85 s in checkWorkholdingContact's columnsHitCylinder (0.05 mm vise cells,
// a disc of cells per tool band per 1 mm path sample). The fast version skips
// 16x16 groups of columns whose span bounds cannot overlap the band, then runs
// the original per-column test on the rest. The ORACLE below is a verbatim
// copy of main's implementation (a0522727e); every case must give identical
// hits (same moves, same components).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Project, Tool, ToolHolder } from '../../types'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import { buildSolidColumns, toolNeckBand, type ClearanceComponent, type ClearanceMesh, type SolidColumns } from '../../lib/cam/holderClearance'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
  removeCachedSTL: vi.fn(async () => {}),
}))

const {
  checkWorkholdingContact, primeWorkholdingContactShapes, workholdingContactShapes,
} = await import('../../lib/simulation/workholdingContact')
const { clearanceAllowanceMmOf } = await import('../../lib/cam/holderClearanceGate')
type WorkholdingContactInput = Parameters<typeof checkWorkholdingContact>[0]
type WorkholdingContactMove = WorkholdingContactInput['moves'][number]
type ContactComponent = 'cutter' | ClearanceComponent
interface WorkholdingContactHit { readonly firstMoveIndex: number; readonly lastMoveIndex: number; readonly components: readonly ContactComponent[] }

// ---- ORACLE: main's checkWorkholdingContact (a0522727e), copied verbatim ----
function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

interface ContactBand {
  readonly kind: ClearanceComponent
  readonly bottomOffsetMm: number
  readonly topOffsetMm?: number
  readonly diameterMm: number
}

/** Mirrors holderClearance.ts's private shankComponents: the neck (if the tool
 *  declares one) then the shank, from the tool's own exposed length. */
function neckAndShankBands(tool: Tool): ContactBand[] {
  if (!isPositiveFinite(tool.fluteLength) || !isPositiveFinite(tool.shankDiameter)) return []
  const exposedTop = isPositiveFinite(tool.lengthBelowHolder) ? tool.lengthBelowHolder : tool.overallLength
  const neck = toolNeckBand(tool)
  if (neck && isPositiveFinite(exposedTop) && exposedTop > neck.bottomMm) {
    const bands: ContactBand[] = [{
      kind: 'neck',
      bottomOffsetMm: neck.bottomMm,
      topOffsetMm: Math.min(neck.topMm, exposedTop),
      diameterMm: neck.diameterMm,
    }]
    if (exposedTop > neck.topMm) {
      bands.push({ kind: 'shank', bottomOffsetMm: neck.topMm, diameterMm: tool.shankDiameter })
    }
    return bands
  }
  if (!isPositiveFinite(exposedTop) || exposedTop <= tool.fluteLength) return []
  return [{ kind: 'shank', bottomOffsetMm: tool.fluteLength, diameterMm: tool.shankDiameter }]
}

/** Mirrors holderClearance.ts's private holderComponents: any invalid segment
 *  means the whole holder is not checked, same as the trim. */
function holderBands(tool: Tool, holder: ToolHolder | undefined): ContactBand[] {
  if (!holder || holder.segments.length === 0 || (tool.holderId && holder.id !== tool.holderId)) return []
  if (!isPositiveFinite(tool.lengthBelowHolder)) return []
  const bands: ContactBand[] = []
  let segmentBottom = tool.lengthBelowHolder
  for (let index = 0; index < holder.segments.length; index++) {
    const segment = holder.segments[index]
    if (!isPositiveFinite(segment.height) || !isPositiveFinite(segment.lowerDiameter) || !isPositiveFinite(segment.upperDiameter)) {
      return []
    }
    bands.push({
      kind: 'holder',
      bottomOffsetMm: segmentBottom,
      ...(index < holder.segments.length - 1 ? { topOffsetMm: segmentBottom + segment.height } : {}),
      diameterMm: Math.max(segment.lowerDiameter, segment.upperDiameter),
    })
    segmentBottom += segment.height
  }
  return bands
}

interface HeadBand { readonly bottom: number; readonly top: number; readonly radius: number }

/** Mirrors holderClearance.ts's private headBandsFor(tool, 0, 0): against
 *  workholding the whole cutting head, at its full profile radius, keeps the
 *  allowance like the rest of the assembly (WO-1575). */
function cutterHeadBands(tool: Tool): HeadBand[] {
  const profile = buildToolProfile(tool)
  const bands: HeadBand[] = []
  const vertices = profile.vertices
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]
    const b = vertices[i + 1]
    if (a.z >= profile.cuttingMaxZ - 1e-9) break
    if (!(b.z > a.z)) continue
    const radius = Math.max(a.r, b.r)
    if (radius > 0) bands.push({ bottom: a.z, top: Math.min(b.z, profile.cuttingMaxZ), radius })
  }
  return bands
}

/** Whether any workholding column under a disc of `radius` holds solid
 *  material between z0 and z1. Mirrors holderClearance.ts's private
 *  partHitsCylinder, built only from SolidColumns's public fields. */
function columnsHitCylinder(columns: SolidColumns, x: number, y: number, radius: number, z0: number, z1: number): boolean {
  const { originX, originY, cell, nx, ny, spanStart, spanZ } = columns
  const i0 = Math.max(0, Math.ceil((x - radius - originX) / cell - 0.5))
  const i1 = Math.min(nx - 1, Math.floor((x + radius - originX) / cell - 0.5))
  const j0 = Math.max(0, Math.ceil((y - radius - originY) / cell - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((y + radius - originY) / cell - 0.5))
  const r2 = radius * radius
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y
    if (dy * dy > r2) continue
    for (let i = i0; i <= i1; i++) {
      const column = j * nx + i
      const end = spanStart[column + 1]
      if (spanStart[column] === end) continue
      const dx = originX + (i + 0.5) * cell - x
      if (dx * dx + dy * dy > r2) continue
      for (let k = spanStart[column]; k < end; k += 2) {
        if (spanZ[k] < z1 && spanZ[k + 1] > z0) return true
      }
    }
  }
  return false
}

// A program can carry hundreds of thousands of moves (a dense adaptive
// clearing pass); this check runs on the MAIN thread (the simulation panel),
// unlike the worker-side trim, so the sampling pitch is coarser than the
// trim's own REACH_STEP_MM to keep it responsive. Coarser sampling can only
// ever miss a contact narrower than this pitch along the direction of travel;
// it never invents one that is not there.
const CONTACT_SAMPLE_STEP_MM = 1

function contactAt(
  x: number, y: number, z: number,
  columnsList: readonly SolidColumns[],
  allowanceMm: number,
  bands: readonly ContactBand[],
  headBands: readonly HeadBand[],
): ReadonlySet<ContactComponent> | null {
  let hit: Set<ContactComponent> | null = null
  for (const columns of columnsList) {
    for (const band of headBands) {
      if (columnsHitCylinder(
        columns, x, y, band.radius + allowanceMm,
        z + band.bottom - allowanceMm, z + band.top + allowanceMm,
      )) {
        hit ??= new Set()
        hit.add('cutter')
      }
    }
    for (const band of bands) {
      const top = band.topOffsetMm === undefined ? Number.POSITIVE_INFINITY : z + band.topOffsetMm + allowanceMm
      if (columnsHitCylinder(columns, x, y, band.diameterMm / 2 + allowanceMm, z + band.bottomOffsetMm - allowanceMm, top)) {
        hit ??= new Set()
        hit.add(band.kind)
      }
    }
  }
  return hit
}

/**
 * WO-1578. Run WO-1575's contact rule over a played program: every move is
 * checked, nothing is trimmed or refused, and contacting moves come back as
 * one entry per contiguous run so a caller can post one console line per run.
 */
function oracleCheck(input: WorkholdingContactInput): { hits: WorkholdingContactHit[] } {
  const { moves, tool, holder, workholding, allowanceMm } = input
  if (moves.length === 0 || workholding.length === 0) return { hits: [] }

  const columnsList = workholding
    .map((mesh) => buildSolidColumns(mesh))
    .filter((columns): columns is SolidColumns => columns !== null)
  if (columnsList.length === 0) return { hits: [] }

  const bands = [...neckAndShankBands(tool), ...holderBands(tool, holder)]
  const headBands = cutterHeadBands(tool)
  if (bands.length === 0 && headBands.length === 0) return { hits: [] }

  const allowance = Math.max(0, allowanceMm)
  const originIndices: number[] = []
  const sampled = sampleArcMovesForLinearConsumers(moves, {}, originIndices)
  const perMoveHits = new Map<number, Set<ContactComponent>>()

  const recordHit = (moveIndex: number, hit: ReadonlySet<ContactComponent>) => {
    let set = perMoveHits.get(moveIndex)
    if (!set) {
      set = new Set()
      perMoveHits.set(moveIndex, set)
    }
    for (const component of hit) set.add(component)
  }

  if (sampled.length > 0) {
    const first = contactAt(sampled[0].x, sampled[0].y, sampled[0].z, columnsList, allowance, bands, headBands)
    if (first) recordHit(originIndices[0], first)
  }
  for (let i = 1; i < sampled.length; i++) {
    const from = sampled[i - 1]
    const to = sampled[i]
    const moveIndex = originIndices[i]
    const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    const steps = Math.max(1, Math.ceil(dist / CONTACT_SAMPLE_STEP_MM))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = from.x + (to.x - from.x) * t
      const y = from.y + (to.y - from.y) * t
      const z = from.z + (to.z - from.z) * t
      const hit = contactAt(x, y, z, columnsList, allowance, bands, headBands)
      if (hit) recordHit(moveIndex, hit)
    }
  }

  const sortedIndices = [...perMoveHits.keys()].sort((a, b) => a - b)
  const hits: WorkholdingContactHit[] = []
  let runStart = -1
  let runEnd = -1
  let runComponents: Set<ContactComponent> = new Set()
  const flush = () => {
    if (runStart < 0) return
    hits.push({ firstMoveIndex: runStart, lastMoveIndex: runEnd, components: [...runComponents].sort() })
  }
  for (const index of sortedIndices) {
    if (runStart >= 0 && index === runEnd + 1) {
      runEnd = index
      for (const component of perMoveHits.get(index)!) runComponents.add(component)
    } else {
      flush()
      runStart = index
      runEnd = index
      runComponents = new Set(perMoveHits.get(index))
    }
  }
  flush()
  return { hits }
}
// ---- end ORACLE ----

type Box = readonly [number, number, number, number, number, number]
function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

const HOLDER: ToolHolder = { id: 'holder-1', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }
const FLAT_6 = {
  id: 'tool-1', name: '6 mm flat', type: 'flat_end_mill', diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool
const BALL_3 = { ...FLAT_6, id: 'tool-2', type: 'ball_end_mill', diameter: 3, shankDiameter: 4 } as unknown as Tool

const feed = (x: number, y: number, z: number): WorkholdingContactMove => ({ type: 'feed', x, y, z, feed: 500 })

function same(input: WorkholdingContactInput) {
  const expected = oracleCheck(input).hits
  const actual = checkWorkholdingContact(input).hits
  expect(actual).toEqual(expected)
  return expected
}

// A jaw (x -4..4), a thin rib 0.3 mm wide (x 20..20.3), a pin 0.4 x 0.4 plus a low plate.
const JAW: Box = [-4, 11, 0, 4, 30, 20]
const RIB: Box = [20, 0, 0, 20.3, 40, 18]
const PIN: Box = [40, 20, 0, 40.4, 20.4, 15]
const PARTS = [meshOf([JAW]), meshOf([RIB]), meshOf([PIN, [60, 0, -5, 80, 40, 2]])]

describe('WO-2706: the fast contact check gives the oracle hits exactly', () => {
  it('thin features narrower than 1 mm, approached from every side and above', () => {
    const moves: WorkholdingContactMove[] = []
    for (let z = 25; z >= -2; z -= 0.7) {
      moves.push(feed(-20, -10, z), feed(100, -10, z), feed(100, 50, z), feed(-20, 50, z), feed(-20, -10, z))
      moves.push(feed(20.15, -5, z), feed(20.15, 45, z), feed(40.2, 20.2, z + 0.1))
    }
    for (const tool of [FLAT_6, BALL_3]) {
      for (const holder of [HOLDER, undefined]) {
        for (const allowanceMm of [0, 0.25, 1]) {
          const hits = same({ moves, tool, holder, workholding: PARTS, allowanceMm })
          expect(hits.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('grazing a jaw face a hair inside and a hair outside, and its corners', () => {
    // Cutter radius 3 + allowance 0.25: the face x = 4 is touched at x = 7.25.
    const moves: WorkholdingContactMove[] = []
    for (const eps of [-1e-3, -1e-6, 0, 1e-6, 1e-3, 0.02, 0.05, 0.07]) {
      const x = 4 + 3 + 0.25 + eps
      moves.push(feed(x, 0, 5), feed(x, 40, 5), feed(x, 40, 30))
      // Corner (4, 11): diagonal approach.
      const d = (3.25 + eps) / Math.SQRT2
      moves.push(feed(4 + d, 11 - d, 5), feed(4 + d, 11 - d, 30))
      // Top face z = 20: cutter bottom just above/below.
      moves.push(feed(0, 20, 20.25 + eps), feed(0, 21, 20.25 + eps), feed(0, 21, 40))
      // Holder (radius 10, from 40 above the tip) grazing the jaw from the side.
      moves.push(feed(14.25 + eps, 20, -19.75), feed(14.25 + eps, 21, -19.75), feed(30, 21, 40))
    }
    for (const allowanceMm of [0, 0.25]) {
      const hits = same({ moves, tool: FLAT_6, holder: HOLDER, workholding: [meshOf([JAW])], allowanceMm })
      expect(hits.length).toBeGreaterThan(0)
    }
  })

  it('no contact at all stays empty', () => {
    const moves = [feed(50, 50, 30), feed(-50, 50, 30), feed(-50, -50, 30), feed(50, -50, 25)]
    expect(same({ moves, tool: FLAT_6, holder: HOLDER, workholding: PARTS, allowanceMm: 0.25 })).toEqual([])
  })

  it('random moves over the parts agree with the oracle', () => {
    let seed = 12345
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const moves: WorkholdingContactMove[] = []
    for (let i = 0; i < 300; i++) moves.push(feed(-30 + rand() * 130, -20 + rand() * 80, -45 + rand() * 75))
    expect(same({ moves, tool: FLAT_6, holder: HOLDER, workholding: PARTS, allowanceMm: 0.25 }).length).toBeGreaterThan(0)
    same({ moves, tool: BALL_3, workholding: PARTS, allowanceMm: 0 })
  }, 300_000)

  // The oracle on the knob takes ~93 s, so it runs only with WO2706_KNOB=1 (that run wrote
  // src/tests/evidence/WO-2706/knob-timing.txt: 0 hits old and new on every operation). Without it the
  // test still runs the fast check on the shipped knob and holds it to the oracle's recorded answer.
  const withOracle = process.env.WO2706_KNOB === '1'
  it('the shipped knob: identical hits on every operation, and the time before/after', async () => {
    const root = path.resolve(__dirname, '../../..')
    const project = JSON.parse(readFileSync(path.join(root, 'examples/06-knob-handwheel/knob-handwheel.camproject'), 'utf8')) as
      Project & { toolLibrary: Tool[]; holders?: ToolHolder[]; binaries: Record<string, { stl: string }> }
    for (const [id, { stl }] of Object.entries(project.binaries)) {
      const bytes = Buffer.from(stl, 'base64')
      cache.stl.set(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    }
    await primeWorkholdingContactShapes(project)
    const setup = project.setups.find(s => s.id === project.activeSetupId)!
    const workholding = workholdingContactShapes(project, setup.id)
    const holders = project.holders ?? []
    const lines: string[] = [`workholding meshes: ${workholding.length} (triangles ${workholding.map(m => m.indices.length / 3).join(', ')})`]
    let oldTotal = 0
    let newTotal = 0
    for (const op of setup.operations) {
      const tool = project.toolLibrary.find(t => t.id === op.toolId)!
      const holder = tool.holderId ? holders.find(h => h.id === tool.holderId) : undefined
      const input: WorkholdingContactInput = {
        moves: op.toolpathMoves ?? [], tool, holder, workholding, allowanceMm: clearanceAllowanceMmOf(op.params),
      }
      const t0 = performance.now()
      const expected = withOracle ? oracleCheck(input).hits : [] // recorded oracle answer: 0 hits
      const t1 = performance.now()
      const actual = checkWorkholdingContact(input).hits
      const t2 = performance.now()
      oldTotal += t1 - t0
      newTotal += t2 - t1
      lines.push(`${op.name}: moves ${input.moves.length}, holder ${holder ? holder.id : 'none'}, allowance ${input.allowanceMm}, `
        + `hits old ${expected.length} new ${actual.length}, old ${(t1 - t0).toFixed(0)} ms, new ${(t2 - t1).toFixed(0)} ms`)
      expect(actual).toEqual(expected)
    }
    lines.push(`TOTAL old ${oldTotal.toFixed(0)} ms, new ${newTotal.toFixed(0)} ms`)
    // The stock-removal toggle re-runs the check on fresh mesh objects for the same vise.
    const again = workholdingContactShapes(project, setup.id)
    const t3 = performance.now()
    for (const op of setup.operations) {
      const tool = project.toolLibrary.find(t => t.id === op.toolId)!
      const holder = tool.holderId ? holders.find(h => h.id === tool.holderId) : undefined
      checkWorkholdingContact({ moves: op.toolpathMoves ?? [], tool, holder, workholding: again, allowanceMm: clearanceAllowanceMmOf(op.params) })
    }
    lines.push(`second pass (the stock-removal toggle), new: ${(performance.now() - t3).toFixed(0)} ms`)
    if (!withOracle) return
    const dir = path.join(root, 'src/tests/evidence/WO-2706')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'knob-timing.txt'), lines.join('\n') + '\n')
  }, 600_000)
})
