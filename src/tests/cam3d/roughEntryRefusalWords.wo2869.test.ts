// WO-2869: 3D Rough on a Form body - a refused entry says, in machinist words,
// where it stopped, why, and which setting to change.
//
// The operator's sweep (2026-10-16, H3): 3D Rough with default settings on a Form body
// refused, and the op status showed engine text: "emitLevelPasses: refusing a
// straight plunge ... helix radius 0.187 below the 0.200 minimum ...". Here:
// the Form tab's default Box starter, tessellated by the Form body's own
// formFaceSet, roughed through computeAdaptive3dMoves (the store's call) and
// the cam3d worker dispatcher in process, with default 3D Rough settings, a
// 6 mm flat end mill and stock 2 mm proud of the part all round.
//
// "Clear around part" (the default scope) models only the part's box, so the
// corner where the rounded Form leaves stock is a closed pocket the 6 mm tool
// cannot helix into: the operation stays refused (rule 11: the software truly
// cannot do this with this tool and scope) and the words name the setting that
// does it. "Clear all stock" enters from outside the stock and generates.
import { describe, expect, it } from 'vitest'

import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../cam3d/kernel/types'
import { computeAdaptive3dMoves, DEFAULT_ADAPTIVE3D_PARAMS } from '../../cam3d/integration/adaptive3dOperation'
import { roughEntryRefusalWords } from '../../cam3d/integration/roughEntryRefusalWords'
import { formatStraightPlungeRefusal, parseStraightPlungeRefusal } from '../../cam3d/rough/entryRefusal'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { formFaceSet, makeFormFeaturePayload } from '../../form/formBody'
import { starterCage } from '../../form/starters'
import type { Tool } from '../../types'

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  return new Cam3dClient(fakeWorker)
}

const TOOL: Tool = {
  id: 'tool-flat-6',
  name: 'Flat 6 mm',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 50,
  shankDiameter: 6,
  overallLength: 80,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
}

/** The Form tab's default Box starter as the part mesh. */
function formBoxMesh(): PartMesh {
  const faces = formFaceSet(makeFormFeaturePayload('Form 1', starterCage('box')), 'form-1')
  if (!faces.ok) throw new Error(faces.reason)
  const P = faces.tessellation.positions
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k])
      max[k] = Math.max(max[k], P[i + k])
    }
  }
  return {
    positions: Float32Array.from(P),
    indices: Uint32Array.from(faces.tessellation.indices),
    bounds: { min, max },
    source: 'fixture',
  }
}

/**
 * 'part': Clear around part. 'all': Clear all stock on a lone unspun part (the
 * store passes side entry). 'all-fell-back': Clear all stock requested, but the
 * store's gate turned it down (rotated part, shared stock, no footprint), so it
 * passes the scope with no side entry.
 */
async function roughFormBox(scope: 'part' | 'all' | 'all-fell-back') {
  const clearAllStock = scope === 'all'

  const partMesh = formBoxMesh()
  const { min, max } = partMesh.bounds
  const stockBounds = {
    minX: min[0] - 2, minY: min[1] - 2, minZ: min[2],
    maxX: max[0] + 2, maxY: max[1] + 2, maxZ: max[2] + 2,
  }
  const client = makeClient()
  try {
    return await computeAdaptive3dMoves({
      partMesh,
      tool: TOOL,
      params: { ...DEFAULT_ADAPTIVE3D_PARAMS, useStockBoundary: scope !== 'part' },
      stockBounds,
      stockBoundsAreRealStock: true,
      resolvedHeights: {
        clearanceZ: stockBounds.maxZ + 10,
        retractZ: stockBounds.maxZ + 5,
        feedZ: stockBounds.maxZ + 2,
        topZ: stockBounds.maxZ,
        bottomZ: min[2],
      },
      // What the store passes for "Clear all stock" on a lone unspun part.
      ...(clearAllStock ? { sideEntry: true, reachStockEdgeBy: TOOL.diameter } : {}),
      client,
    })
  } finally {
    await client.dispose()
  }
}

describe('WO-2869 3D Rough entry refusal in plain words', () => {
  it('Form body, default settings: refuses in machinist words that name the setting to change', { timeout: 120_000 }, async () => {
    let message = ''
    await roughFormBox('part').then(
      () => { throw new Error('expected the default 3D Rough to refuse this Form body') },
      (error: unknown) => { message = error instanceof Error ? error.message : String(error) },
    )
    // No engine text reaches the operator.
    expect(message).not.toMatch(/emitLevelPasses|refusing a straight plunge|cells|allowance|adaptive cleanup|minimum\)/)
    // Where: the level by depth below the stock top, and which part of the part.
    expect(message).toMatch(/^3D Rough stopped at the level \d+(\.\d+)? mm below the stock top, near the X\+ Y\+ corner of the part:/)
    // Why: the helix the space allows with this tool, against the smallest one cut.
    expect(message).toContain('with this 6 mm tool the open space leaves room for a helix only 0.33 mm across')
    expect(message).toContain('The smallest entry helix it cuts is 0.4 mm across')
    expect(message).toContain('Nothing was generated.')
    // What to change: the real setting, by its on-screen name.
    expect(message).toContain(
      'set Roughing scope to "Clear all stock" so the cutter enters from outside the stock (it can when the part is ' +
        'the only one on its stock and is not rotated on it), or choose a smaller tool.',
    )
  })

  it('Clear all stock requested but turned down by the store gate: does not name the scope again', { timeout: 120_000 }, async () => {
    let message = ''
    await roughFormBox('all-fell-back').then(
      () => { throw new Error('expected the fallen-back 3D Rough to refuse this Form body') },
      (error: unknown) => { message = error instanceof Error ? error.message : String(error) },
    )
    expect(message).toMatch(/^3D Rough stopped at the level /)
    expect(message).not.toContain('set Roughing scope to')
    expect(message).toContain(
      'Roughing scope is set to "Clear all stock", but it clears the whole stock only when the part is the only one ' +
        'on its stock and is not rotated on it, so here it cleared around the part instead. To rough this part, give ' +
        'the part its own stock and no rotation, or choose a smaller tool.',
    )
  })

  it('the named remedy works: Roughing scope "Clear all stock" generates the same part', { timeout: 300_000 }, async () => {
    const result = await roughFormBox('all')
    expect(result.moves.length).toBeGreaterThan(0)
  })

  it('keeps the engine text byte for byte, and reads every refusal variant back', () => {
    const region = {
      x: 18.8321, y: -0.5, fromZ: 30, toZ: 27, fraction: 1, uncutColumns: 113, columns: 113, allowance: 0.05,
      where: { kind: 'region' as const, mode: 'plunge', helixRadius: 0.166, minHelixRadius: 0.2 },
    }
    expect(formatStraightPlungeRefusal(region)).toBe(
      'emitLevelPasses: refusing a straight plunge through remaining stock at (18.832, -0.500) from 30.000 to ' +
        '27.000: 100.0% of the cutter face (113 of 113 cells) still stands above the floor, allowance 5% ' +
        '(region entry, mode plunge, helix radius 0.166 below the 0.200 minimum); adaptive cleanup must ' +
        'provide a cleared shaft, side entry, or fitting helix.',
    )
    expect(parseStraightPlungeRefusal(formatStraightPlungeRefusal(region))).toEqual({ ...region, x: 18.832 })
    for (const fallbackHelixTooSmall of [true, false]) {
      const landing = { ...region, where: { kind: 'landing' as const, fallbackHelixTooSmall } }
      expect(parseStraightPlungeRefusal(formatStraightPlungeRefusal(landing))?.where).toEqual(landing.where)
    }
  })

  it('a landing with no helix says so; Clear all stock already chosen leaves only the tool remedy; other errors pass through', () => {
    const bounds = { min: [-20, -20, 0] as [number, number, number], max: [20, 20, 40] as [number, number, number] }
    const landing = formatStraightPlungeRefusal({
      x: -19, y: 0, fromZ: 12, toZ: 9, fraction: 0.5, uncutColumns: 40, columns: 80, allowance: 0.05,
      where: { kind: 'landing', fallbackHelixTooSmall: false },
    })
    const words = roughEntryRefusalWords(landing, { toolDiameter: 6.35, stockTopZ: 42, partBounds: bounds, clearsAllStock: true })
    expect(words).toBe(
      '3D Rough stopped at the level 33 mm below the stock top, near the X- side of the part: the cutter has to go ' +
        'down into solid stock there, and with this 6.35 mm tool no entry helix fits in the open space. It will not ' +
        'plunge an end mill straight into solid stock. Nothing was generated. To rough this part, choose a smaller tool.',
    )
    expect(roughEntryRefusalWords('adaptiveRough: interior-entry path exceeded the sustained engagement cap', {
      toolDiameter: 6, stockTopZ: 42, partBounds: bounds, clearsAllStock: false,
    })).toBeUndefined()
  })
})
