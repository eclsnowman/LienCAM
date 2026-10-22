// WO-2998: 3D Rough's cut-region offsets go through the kernel geometry service.
//
// cutRegionAt's stock corner-reach offset, its radial-skin part offset and its
// stock-minus-part difference now run through createGeometryService's cam3d
// adapter over the UNCHANGED geom2d module. Nothing that is cut may change.
//
// Two halves:
// 1. Production route: the Form starters (WO-2922) plus a pocketed/island part
//    and an outside-wall part go through the store's computeOperationToolpath
//    (benchmark chain runner). Every cut region, every move and the posted
//    G-code must be byte-identical to the record captured from the starter
//    commit (src/tests/evidence/WO-2998/before-record.json). Re-record with
//    WO2998_RECORD=<path> on the starter source only.
// 2. Direct parity: cutRegionAt against the same native geom2d calls on small
//    fields (reach, skin, a hole, an island, collapse, no part), plus today's
//    native exception messages on invalid input.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import type * as CutRegionModule from '../../cam3d/rough/cutRegion'
import type * as GeometryModule from '../../kernel/geometry'
import type { Ring } from '../../cam3d/geom2d'
import type { Box3 } from '../../cam3d/stock'
import { typedMock } from '../support/typedMock'

const regionDigests: string[] = []
const serviceCalls = { offset: 0, boolean: 0 }

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function ringsDigest(rings: readonly Ring[]): string {
  const hash = createHash('sha256')
  for (const ring of rings) {
    hash.update(`${ring.length}:`)
    hash.update(new Uint8Array(ring.buffer, ring.byteOffset, ring.byteLength))
  }
  return hash.digest('hex')
}

vi.mock('../../cam3d/rough/cutRegion', async (importOriginal) => {
  const actual = await importOriginal<typeof CutRegionModule>()
  return typedMock<typeof CutRegionModule>({
    ...actual,
    cutRegionAt: async (stock, part, z, opts) => {
      const rings = await actual.cutRegionAt(stock, part, z, opts)
      regionDigests.push(sha(JSON.stringify({
        z, reach: opts?.reachStockEdgeBy ?? 0, grow: opts?.radialStockToLeave ?? 0,
        partSection: opts?.partSection ? ringsDigest(opts.partSection) : null,
        out: ringsDigest(rings),
      })))
      return rings
    },
  })
})

// Count what reaches the service, so the parity run proves the new route ran.
vi.mock('../../kernel/geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof GeometryModule>()
  return typedMock<typeof GeometryModule>({
    ...actual,
    createGeometryService: (backend) => {
      const service = actual.createGeometryService(backend)
      return {
        ...service,
        offset: (...args: Parameters<typeof service.offset>) => { serviceCalls.offset++; return service.offset(...args) },
        boolean: (...args: Parameters<typeof service.boolean>) => { serviceCalls.boolean++; return service.boolean(...args) },
      }
    },
  })
})

const { planChain } = await import('../benchmark/chainRunner')
const { alpha3Chains } = await import('../benchmark/registry')
const { cutRegionAt } = await import('../../cam3d/rough/cutRegion')
const geom2d = await import('../../cam3d/geom2d')
const { ZDexelField, remainingAbove } = await import('../../cam3d/stock')
const { postProgram, GRBL_CONFIG } = await import('../../lib/post')
const { resolveFeedrates } = await import('../../lib/cam/feedrates')
const { resolveSpindle, resolveCoolant } = await import('../../lib/post/resolve')
const { makeTool, makeMachine, makeOp, makeWcs } = await import('../post/helpers')

const RECORD_PATH = 'src/tests/evidence/WO-2998/before-record.json'
// Form starters (WO-2922; cylinder and torus take the 6 mm stock-edge reach),
// the H-pocket with its island and 0.3 mm skin, and the outside-wall terraces.
const CHAINS = [
  'form-cylinder-default',
  'form-torus-default',
  'form-sphere-default',
  'engagement-pocket-rough-finish-declared',
  'stepped-boss-rough-finish-declared',
] as const

interface ChainRecord {
  regionCalls: number
  regions: string
  steps: { stepId: string; status?: string; moveCount: number; moves: string; gcode: string; gcodeBytes: number }[]
}

function postedGcode(stepId: string, moves: Parameters<typeof postProgram>[0]['setup']['operations'][number]['moves']) {
  const machine = makeMachine()
  const tool = makeTool({ id: 't1', name: 'Flat d6', type: 'flat_end_mill', diameter: 6, toolNumber: 1 })
  const op = makeOp({ id: stepId, name: '3D Rough', type: 'adaptive_3d', toolId: tool.id, status: 'ready', toolpathMoves: moves })
  const result = postProgram({ machine, setup: { wcs: makeWcs(), operations: [{
    op, tool, moves,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
  }] } }, GRBL_CONFIG)
  expect(result.ok).toBe(true)
  return result.gcode
}

async function recordChain(id: string): Promise<ChainRecord> {
  const chain = alpha3Chains().find(candidate => candidate.id === id)
  expect(chain, id).toBeDefined()
  // The first-tool 3D Rough rows (WO-3025: the -tool2 variants are real 3 mm rows now).
  const rough = { ...chain!, steps: chain!.steps.filter(step => step.type === 'adaptive_3d' && !/-tool\d+$/.test(step.id)) }
  expect(rough.steps.length).toBeGreaterThan(0)
  regionDigests.length = 0
  const planned = await planChain(rough)
  const steps = planned.steps.map(step => {
    const gcode = step.moves.length ? postedGcode(step.stepId, step.moves) : ''
    return { stepId: step.stepId, status: step.status, moveCount: step.moves.length,
      moves: sha(JSON.stringify(step.moves)), gcode: sha(gcode), gcodeBytes: gcode.length }
  })
  return { regionCalls: regionDigests.length, regions: sha(regionDigests.join('\n')), steps }
}

describe('WO-2998 3D Rough cut regions through the kernel geometry service (production Generate)', () => {
  it('cut regions, moves and posted G-code are byte-identical to the starter', { timeout: 3_000_000 }, async () => {
    const records: Record<string, ChainRecord> = {}
    for (const id of CHAINS) records[id] = await recordChain(id)
    const recordTo = process.env.WO2998_RECORD
    if (recordTo) {
      writeFileSync(recordTo, JSON.stringify({ chains: records }, null, 2) + '\n')
      return
    }
    const before = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as { source: string; chains: Record<string, ChainRecord> }
    expect(records).toEqual(before.chains)
    for (const id of CHAINS) {
      expect(records[id].regionCalls, id).toBeGreaterThan(0)
      for (const step of records[id].steps) {
        expect(step.status, `${id} ${step.stepId}`).toBe('ready')
        expect(step.moveCount, `${id} ${step.stepId}`).toBeGreaterThan(0)
      }
    }
    // The new route actually ran: every cut region's difference, plus the
    // reach and skin offsets, went through the service.
    expect(serviceCalls.boolean).toBeGreaterThan(0)
    expect(serviceCalls.offset).toBeGreaterThan(0)
  })
})

describe('WO-2998 cutRegionAt parity with the native geom2d calls', () => {
  const box: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 30, maxZ: 10 }
  const stock = () => ZDexelField.fromBox(box, 0.5)
  // An empty part field (every column top at its bottom): no part material.
  const part = () => {
    const field = ZDexelField.fromBox(box, 0.5)
    field.top.set(field.bottom)
    return field
  }
  const circle = (cx: number, cy: number, r: number, ccw: boolean) => {
    const points = Array.from({ length: 48 }, (_, i) => {
      const a = (ccw ? 1 : -1) * (2 * Math.PI * i) / 48
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
    })
    return Float64Array.from(points.flat())
  }
  // A square boss (CCW) with a round bore (CW hole) and a separate round
  // island (CCW): the outer/hole/island coupling a region offset must keep.
  const section: Ring[] = [
    Float64Array.from([5, 5, 22, 5, 22, 25, 5, 25]),
    circle(13.5, 15, 3.5, false),
    circle(32, 15, 4, true),
  ]
  const asArrays = (rings: readonly Ring[]) => rings.map(ring => Array.from(ring))

  it('reach, skin, hole and island: identical rings to native offset/boolean', async () => {
    await geom2d.ensureGeom2dReady()
    for (const [reach, grow] of [[0, 0], [0, 0.3], [3, 0], [3, 0.3], [0, 4]] as const) {
      const calls = serviceCalls.offset + serviceCalls.boolean
      const out = await cutRegionAt(stock(), part(), 4, { partSection: section, reachStockEdgeBy: reach, radialStockToLeave: grow })
      // Today's calls, made directly on geom2d exactly as cutRegionAt made them.
      let stockSec = remainingAbove(stock(), 4)
      if (reach > 0) stockSec = geom2d.offset(stockSec, reach, { joinType: 'round' })
      const partSec = grow > 0 ? geom2d.offset(section, grow, { joinType: 'round' }) : section
      expect(asArrays(out), `reach ${reach} skin ${grow}`).toEqual(asArrays(geom2d.boolean(stockSec, partSec, 'difference')))
      expect(serviceCalls.offset + serviceCalls.boolean).toBe(calls + 1 + (reach > 0 ? 1 : 0) + (grow > 0 ? 1 : 0))
    }
  })

  it("collapse, no part and above the stock keep today's results", async () => {
    await geom2d.ensureGeom2dReady()
    // The part covers the reached stock: an empty region, not an error.
    const cover = [Float64Array.from([-10, -10, 50, -10, 50, 40, -10, 40])]
    expect(await cutRegionAt(stock(), part(), 4, { partSection: cover, reachStockEdgeBy: 2, radialStockToLeave: 0.3 })).toEqual([])
    // No part at z: the (reached) stock section itself, without a boolean.
    const reached = await cutRegionAt(stock(), part(), 4, { reachStockEdgeBy: 2 })
    expect(asArrays(reached)).toEqual(asArrays(geom2d.offset(remainingAbove(stock(), 4), 2, { joinType: 'round' })))
    expect(await cutRegionAt(stock(), part(), 20)).toEqual([])
  })

  it("invalid input throws today's native message, never a substitute result", async () => {
    await geom2d.ensureGeom2dReady()
    const degenerate = [Float64Array.from([0, 0, 1, 1])]
    const message = (run: () => unknown) => { try { run() } catch (error) { return (error as Error).message } return '' }
    const nativeOffset = message(() => geom2d.offset(degenerate, 0.3, { joinType: 'round' }))
    const nativeBoolean = message(() => geom2d.boolean(remainingAbove(stock(), 4), degenerate, 'difference'))
    expect(nativeOffset).toMatch(/degenerate/)
    expect(nativeBoolean).toMatch(/degenerate/)
    await expect(cutRegionAt(stock(), part(), 4, { partSection: degenerate, radialStockToLeave: 0.3 })).rejects.toThrow(nativeOffset)
    await expect(cutRegionAt(stock(), part(), 4, { partSection: degenerate })).rejects.toThrow(nativeBoolean)
  })
})
