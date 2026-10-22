// WO-2922 (GitHub issue #1): 3D Rough generates on the Form starters with default settings.
//
// The bug: on the Form cylinder and torus starters, 3D Rough with a 6 mm tool on
// default settings refused ("the open space leaves room for a helix only 0.16 mm
// across"). Default Roughing scope "Clear around part" plans on the part's own box;
// the auto stock stands 5 mm proud of it, so the part-box exception (WO-2145) does
// not apply, the field models none of the stock around the part, and every entry
// is a helix inside the box that does not fit at the rounded corners.
// "Clear all stock" entered from the side through that stock and generated.
//
// The fix (rule 11, the software can do this): when the part-bounds plan refuses
// its entry and the real stock surrounds this part (the same gate Clear all stock
// uses), re-plan on that stock field with side entry. A plan that generates today
// never takes the retry.
//
// The production half runs the store's computeOperationToolpath through the
// benchmark chain runner (the shipped Form starter bodies, the shipped 6 mm flat
// recipe, default 3D Rough settings, auto stock 5 mm proud); a wrapper around
// computeAdaptive3dMoves only records what the store asked for and what was carved.
import { describe, expect, it, vi } from 'vitest'

import type { Box3 } from '../../cam3d/stock'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { Cam3dClient } from '../../cam3d/worker/client'
import { formatStraightPlungeRefusal } from '../../cam3d/rough/entryRefusal'
import type { Tool } from '../../types'
import { typedMock } from '../support/typedMock'
import type * as AdaptiveModule from '../../cam3d/integration/adaptive3dOperation'

interface RecordedCall {
  stockBounds: Box3
  sideEntry?: boolean
  fallback?: { stockBounds: Box3; reachStockEdgeBy: number }
  plannedStockBounds?: Box3
  partBounds: PartMesh['bounds']
}
const calls: RecordedCall[] = []

vi.mock('../../cam3d/integration/adaptive3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptiveModule>()
  return typedMock<typeof AdaptiveModule>({
    ...actual,
    computeAdaptive3dMoves: async (args) => {
      const call: RecordedCall = {
        stockBounds: { ...args.stockBounds },
        sideEntry: args.sideEntry,
        fallback: args.partBoundsEntryFallback,
        partBounds: args.partMesh.bounds,
      }
      calls.push(call)
      const result = await actual.computeAdaptive3dMoves(args)
      call.plannedStockBounds = result.plannedStockBounds
      return result
    },
  })
})

const { planChain } = await import('../benchmark/chainRunner')
const { alpha3Chains } = await import('../benchmark/registry')
const adaptive = await import('../../cam3d/integration/adaptive3dOperation')

async function generateDefault(starter: 'cylinder' | 'torus' | 'sphere') {
  const chain = alpha3Chains().find((candidate) => candidate.id === `form-${starter}-default`)!
  // The shipped 6 mm flat recipe only: the first-tool step (WO-3025: the -tool2 variant is a real 3 mm row now).
  const sixMm = { ...chain, steps: chain.steps.filter((step) => !/-tool\d+$/.test(step.id)) }
  expect(sixMm.steps).toHaveLength(1)
  calls.length = 0
  const planned = await planChain(sixMm)
  expect(calls).toHaveLength(1)
  return { step: planned.steps[0], call: calls[0] }
}

function xyExtent(moves: { x: number; y: number }[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const move of moves) {
    minX = Math.min(minX, move.x); maxX = Math.max(maxX, move.x)
    minY = Math.min(minY, move.y); maxY = Math.max(maxY, move.y)
  }
  return { minX, minY, maxX, maxY }
}

describe('WO-2922 default 3D Rough on the Form starters (production Generate)', () => {
  for (const starter of ['cylinder', 'torus'] as const) {
    it(`${starter}: generates ready, entering from the side through the stock around the part`, { timeout: 600_000 }, async () => {
      const { step, call } = await generateDefault(starter)
      // The intended behaviour: the operation is ready, with a path. (Before WO-2922: error, no moves.)
      expect(step.operatorText ?? '').not.toContain('Nothing was generated')
      expect(step.status).toBe('ready')
      expect(step.moves.length).toBeGreaterThan(1000)

      // Default settings: Clear around part, no side entry asked for.
      expect(call.sideEntry).not.toBe(true)
      const part = call.partBounds
      expect(call.stockBounds.minX).toBeCloseTo(part.min[0], 4)
      expect(call.stockBounds.maxY).toBeCloseTo(part.max[1], 4)
      // The store offered the real stock field (5 mm proud) and the edge reach Clear all stock uses.
      expect(call.fallback).toBeDefined()
      expect(call.fallback!.stockBounds.minX).toBeCloseTo(part.min[0] - 5, 3)
      expect(call.fallback!.stockBounds.maxX).toBeCloseTo(part.max[0] + 5, 3)
      expect(call.fallback!.stockBounds.maxZ).toBe(call.stockBounds.maxZ)
      expect(call.fallback!.reachStockEdgeBy).toBe(6)
      // ...and the part-bounds plan refused, so it carved that field.
      expect(call.plannedStockBounds).toEqual(call.fallback!.stockBounds)

      // Never outside the stock plus the side-entry reach (world frame: the part sits at the origin in XY).
      const reach = call.fallback!.reachStockEdgeBy
      const extent = xyExtent(step.moves)
      const field = call.fallback!.stockBounds
      expect(extent.minX).toBeGreaterThanOrEqual(field.minX - reach - 1e-6)
      expect(extent.maxX).toBeLessThanOrEqual(field.maxX + reach + 1e-6)
      expect(extent.minY).toBeGreaterThanOrEqual(field.minY - reach - 1e-6)
      expect(extent.maxY).toBeLessThanOrEqual(field.maxY + reach + 1e-6)
    })
  }

  it('sphere: still ready, and it never takes the retry (its around-part plan is unchanged)', { timeout: 600_000 }, async () => {
    const { step, call } = await generateDefault('sphere')
    expect(step.status).toBe('ready')
    expect(step.moves.length).toBeGreaterThan(1000)
    // The fallback is offered (same gate) but the first plan generated, so the field carved is the part box.
    expect(call.fallback).toBeDefined()
    expect(call.plannedStockBounds).toEqual(call.stockBounds)
  })
})

describe('WO-2922 entry fallback gate (resolvePartBoundsEntryFallback)', () => {
  const field: Box3 = { minX: -25, minY: -25, minZ: 0, maxX: 25, maxY: 25, maxZ: 20 }
  const base = {
    useStockBoundary: false, stockBoundsAreRealStock: true, startsFromRetainedField: false,
    unspun: true, solidPartsOnStock: 1, stockFieldBounds: field,
    toolDiameter: 6, stockEdgeOvershoot: undefined, opName: '3D Rough',
  }

  it('a lone unspun part in proven stock gets the Clear all stock field and reach', () => {
    expect(adaptive.resolvePartBoundsEntryFallback(base)).toEqual({ stockBounds: field, reachStockEdgeBy: 6 })
    expect(adaptive.resolvePartBoundsEntryFallback({ ...base, stockEdgeOvershoot: 0 })?.reachStockEdgeBy).toBe(3)
  })

  it.each([
    ['Clear all stock is already chosen', { useStockBoundary: true }],
    ['the stock is not the proven stock of this part', { stockBoundsAreRealStock: false }],
    ['a rest rough starts from the retained field', { startsFromRetainedField: true }],
    ['the part is rotated on its stock', { unspun: false }],
    ['two parts share the stock', { solidPartsOnStock: 2 }],
    ['no stock footprint resolved', { stockFieldBounds: undefined }],
  ])('no fallback when %s', (_why, change) => {
    expect(adaptive.resolvePartBoundsEntryFallback({ ...base, ...change })).toBeUndefined()
  })
})

describe('WO-2922 adapter retry (computeAdaptive3dMoves, scripted engine replies)', () => {
  const TOOL: Tool = {
    id: 'tool-flat-6', name: 'Flat 6 mm', type: 'flat_end_mill', diameter: 6, fluteLength: 50,
    shankDiameter: 6, overallLength: 80, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    notes: '', feedsAndSpeeds: {},
  }
  const partMesh: PartMesh = {
    positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [-18, -18, 0], max: [18, 18, 28] }, source: 'fixture',
  }
  const partBox: Box3 = { minX: -18, minY: -18, minZ: 0, maxX: 18, maxY: 18, maxZ: 33 }
  const stockField: Box3 = { minX: -23, minY: -23, minZ: 0, maxX: 23, maxY: 23, maxZ: 33 }
  const refusal = formatStraightPlungeRefusal({
    x: 15, y: 15, fromZ: 33, toZ: 30, fraction: 1, uncutColumns: 50, columns: 50, allowance: 0.05,
    where: { kind: 'region', mode: 'plunge', helixRadius: 0.08, minHelixRadius: 0.2 },
  })

  function scripted(replies: Error[]) {
    const requests: Record<string, unknown>[] = []
    const client = {
      generateAdaptiveRough: async (request: Record<string, unknown>) => {
        requests.push(request)
        throw replies[Math.min(requests.length - 1, replies.length - 1)]
      },
    } as unknown as Cam3dClient
    return { client, requests }
  }
  const run = (client: Cam3dClient, extra: Partial<Parameters<typeof adaptive.computeAdaptive3dMoves>[0]> = {}) =>
    adaptive.computeAdaptive3dMoves({
      partMesh, tool: TOOL, params: { ...adaptive.DEFAULT_ADAPTIVE3D_PARAMS }, stockBounds: partBox,
      stockBoundsAreRealStock: true,
      resolvedHeights: { clearanceZ: 48, retractZ: 38, feedZ: 38, topZ: 33, bottomZ: 0 },
      client, ...extra,
    })
  const fallback = { stockBounds: stockField, reachStockEdgeBy: 6 }

  it('a refused part-bounds entry re-plans once on the stock field with side entry and edge reach', async () => {
    const { client, requests } = scripted([new Error(refusal), new Error(refusal)])
    const error = await run(client, { partBoundsEntryFallback: fallback }).then(() => undefined, (e: unknown) => e as Error)
    expect(requests).toHaveLength(2)
    expect(requests[0].stockBounds).toEqual(partBox)
    expect(requests[0].sideEntry).toBeUndefined()
    expect(requests[1].stockBounds).toEqual(stockField)
    expect(requests[1].sideEntry).toBe(true)
    expect(requests[1].reachStockEdgeBy).toBe(6)
    expect(requests[1].stockBoundsAreRealStock).toBe(true)
    // Both refused: the words say the tool is the remedy (the scope was already widened).
    expect(error?.message).toContain('Nothing was generated')
    expect(error?.message).toContain('choose a smaller tool')
    expect(error?.message).not.toContain('set Roughing scope')
  })

  it('without a fallback the refusal stands exactly as before (one plan, scope remedy named)', async () => {
    const { client, requests } = scripted([new Error(refusal)])
    const error = await run(client).then(() => undefined, (e: unknown) => e as Error)
    expect(requests).toHaveLength(1)
    expect(error?.message).toContain('set Roughing scope to "Clear all stock"')
  })

  it('any other engine error passes through with no retry', async () => {
    const other = new Error('adaptiveRough: interior-entry path exceeded the sustained engagement cap')
    const { client, requests } = scripted([other])
    const error = await run(client, { partBoundsEntryFallback: fallback }).then(() => undefined, (e: unknown) => e)
    expect(requests).toHaveLength(1)
    expect(error).toBe(other)
  })

  it('a rest rough or a job boundary never widens to the stock field', async () => {
    for (const extra of [
      { startFromStock: { id: 1 } as never },
      { boundary: [Float64Array.from([-10, -10, 10, -10, 10, 10, -10, 10])] },
    ]) {
      const { client, requests } = scripted([new Error(refusal)])
      await run(client, { partBoundsEntryFallback: fallback, ...extra }).catch(() => undefined)
      expect(requests).toHaveLength(1)
    }
  })
})
