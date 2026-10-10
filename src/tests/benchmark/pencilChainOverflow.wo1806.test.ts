import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { Cam3dClient } from '../../cam3d/worker/client'
import { hemisphereOnSlab, steps } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { irFingerprint } from '../../cam3d/ir/types'
import type { CutterHandle, GeometryKernel, GridSpec, MeshHandle } from '../../cam3d/kernel/types'
import { pencilFinish } from '../../cam3d/strategies/pencil'
import { PENCIL_FIXTURE_SIZE, pencilCornerFixture } from '../cam3d/pencilCornerFixture'
import { planChain } from './chainRunner'
import { CHAINS } from './registry'

const CHAIN = CHAINS.find((candidate) => candidate.id === 'engagement-pocket-rest-pencil')
if (!CHAIN) throw new Error('WO-1806 diagnostic chain is missing from the benchmark registry')

type CapturedWorkerError = Error & { workerStack?: string }

const EVIDENCE_DIR = join(process.cwd(), 'src/tests/evidence/WO-1806')

function writeEvidence(name: string, body: string): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${body}\n`, 'utf-8')
}

/**
 * The synthetic control below builds its band from the grid the strategy asks
 * for, so it never has to predict `nx`/`ny` from the bounds. `surfaceZ` stays
 * flat, which makes the single-contact lift exactly zero, so the returned
 * cutter-location height IS the excess and the band is whatever this stub
 * marks. A one-cell-wide band is already a Zhang-Suen fixed point, so the
 * skeleton the strategy traces is the shape written here: one long spine with
 * a few teeth, i.e. ONE component that is connected, branching, and `ny` deep.
 */
function syntheticSpineKernel(spineLength: { value: number }): GeometryKernel {
  return {
    name: 'wo1806-synthetic-spine',
    uploadMesh: () => 1 as MeshHandle,
    releaseMesh: () => {},
    makeCutter: () => 1 as CutterHandle,
    releaseCutter: () => {},
    async dropGrid(_m: MeshHandle, _c: CutterHandle, g: GridSpec, opts?: { surfaceZ?: Float64Array }) {
      if (g.nx < 6) throw new Error(`WO-1806 control needs nx >= 6, got ${g.nx}`)
      const raw = new Float64Array(g.nx * g.ny)
      opts?.surfaceZ?.fill(0)
      let cells = 0
      for (let y = 1; y <= g.ny - 2; y++) {
        raw[y * g.nx + 2] = 1
        cells++
      }
      // Teeth make at least one spine cell carry three neighbours, which is
      // what sends `componentWalk` down its graph-walk branch instead of the
      // simple two-neighbour walk.
      for (const y of [Math.floor(g.ny / 4), Math.floor(g.ny / 2), Math.floor((g.ny * 3) / 4)]) {
        raw[y * g.nx + 3] = 1
        raw[y * g.nx + 4] = 1
        cells += 2
      }
      spineLength.value = cells
      return raw
    },
    async dropPoints(_m: MeshHandle, _c: CutterHandle, xy: Float64Array) {
      return new Float64Array(xy.length / 2)
    },
    async dropPath(_m: MeshHandle, _c: CutterHandle, xy: Float64Array) {
      return new Float64Array(xy.length / 2)
    },
  }
}

/**
 * The fixtures whose ridges are SHALLOW enough that the recursive walk never
 * overflowed. Their fingerprints must be identical before and after the fix:
 * an iterative walk that emits a different sequence would be a toolpath-shape
 * change, which this order does not authorise.
 */
const SAME_ANSWER_CASES = [
  {
    id: 'pencil-corner-401x41-ball4-tol0.1',
    mesh: () => pencilCornerFixture(),
    cutter: { kind: 'ball' as const, diameter: 4 },
    tolerance: 0.1,
    bounds: { minX: 0, minY: 0, maxX: PENCIL_FIXTURE_SIZE.x, maxY: PENCIL_FIXTURE_SIZE.y },
    heights: { clearanceZ: 20, retractZ: 18, feedZ: 17 },
    zSeed: 0,
  },
  {
    id: 'steps-4-40-3-ball4-tol0.2',
    mesh: () => steps(4, 40, 3),
    cutter: { kind: 'ball' as const, diameter: 4 },
    tolerance: 0.2,
    bounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
    heights: { clearanceZ: 30, retractZ: 26, feedZ: 24 },
    zSeed: 0,
  },
  {
    id: 'steps-4-40-3-ball3-tol0.15',
    mesh: () => steps(4, 40, 3),
    cutter: { kind: 'ball' as const, diameter: 3 },
    tolerance: 0.15,
    bounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
    heights: { clearanceZ: 30, retractZ: 26, feedZ: 24 },
    zSeed: 0,
  },
  {
    id: 'hemisphere-8-on-24x24x4-ball4-tol0.2',
    mesh: () => hemisphereOnSlab(8, { x: 24, y: 24, t: 4 }),
    cutter: { kind: 'ball' as const, diameter: 4 },
    tolerance: 0.2,
    bounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
    heights: { clearanceZ: 30, retractZ: 26, feedZ: 24 },
    zSeed: 0,
  },
] as const

describe('WO-1806 pencil-chain overflow attribution', () => {
  it('emits the same toolpath on every ridge that did not overflow', { timeout: 300_000 }, async () => {
    const kernel = new BvhKernel()
    const rows: string[] = []
    for (const testCase of SAME_ANSWER_CASES) {
      const mesh = kernel.uploadMesh(testCase.mesh())
      try {
        const ir = await pencilFinish(kernel, {
          mesh,
          cutter: testCase.cutter,
          tolerance: testCase.tolerance,
          direction: 'climb',
          xyBounds: testCase.bounds,
          heights: testCase.heights,
          zSeed: testCase.zSeed,
        })
        rows.push(`${testCase.id} moves=${ir.moves.length} fingerprint=${irFingerprint(ir)}`)
      } finally {
        kernel.releaseMesh(mesh)
      }
    }
    const evidence = [
      `node=${process.versions.node} platform=${process.platform} arch=${process.arch}`,
      ...rows,
    ].join('\n')
    console.log(`\n[WO-1806 same-answer]\n${evidence}`)
    writeEvidence('same-answer-fingerprints.txt', evidence)
    expect(rows).toHaveLength(SAME_ANSWER_CASES.length)
  })

  it('walks a 60000-cell branching corner ridge at the default stack', { timeout: 300_000 }, async () => {
    const spineLength = { value: 0 }
    const kernel = syntheticSpineKernel(spineLength)
    let caught: Error | undefined
    try {
      await pencilFinish(kernel, {
        mesh: 1 as MeshHandle,
        cutter: { kind: 'ball', diameter: 2 },
        tolerance: 0.05,
        // Every snapped point comes back at z = 0, so a finish floor above it
        // removes all of them. Reaching THAT refusal is the proof the walk
        // completed: the pre-fix code never gets here.
        minFinishZ: 1000,
        direction: 'climb',
        xyBounds: { minX: 0, minY: 0, maxX: 0.4, maxY: 3000 },
        heights: { clearanceZ: 20, retractZ: 15, feedZ: 2 },
        zSeed: -10,
      })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      caught = error
    }

    const evidence = [
      `node=${process.versions.node} platform=${process.platform} arch=${process.arch}`,
      `execArgv=${JSON.stringify(process.execArgv)}`,
      `skeletonCells=${spineLength.value}`,
      `error=${caught ? `${caught.name}: ${caught.message}` : 'none'}`,
      'stack:',
      caught?.stack ?? 'none',
    ].join('\n')
    console.log(`\n[WO-1806 control]\n${evidence}`)
    writeEvidence('synthetic-deep-walk.txt', evidence)

    expect(spineLength.value).toBeGreaterThan(50_000)
    // The walk itself must survive. The only refusal allowed here is the
    // finish-depth one, which happens AFTER the skeleton has been traced.
    expect(caught?.message).not.toContain('Maximum call stack size exceeded')
    expect(caught?.name).toBe('PencilFinishError')
    expect(caught?.message).toContain('removed by the finish-depth limit')
  })

  it('captures the worker stack before the store reduces it to an operation message', { timeout: 600_000 }, async () => {
    let workerError: CapturedWorkerError | undefined
    const generatePencilFinish = Cam3dClient.prototype.generatePencilFinish
    const spy = vi.spyOn(Cam3dClient.prototype, 'generatePencilFinish').mockImplementation(async function (this: Cam3dClient, ...args) {
      try {
        return await generatePencilFinish.apply(this, args)
      } catch (error) {
        if (error instanceof Error) workerError = error as CapturedWorkerError
        throw error
      }
    })

    let planningError: Error | undefined
    let pencilMoveHash = 'none'
    let pencilMoveCount = 0
    try {
      const planned = await planChain(CHAIN)
      const pencil = planned.steps.find((step) => step.stepId === 'pencil-2-ball')
      if (pencil) {
        pencilMoveCount = pencil.moves.length
        pencilMoveHash = createHash('sha256').update(JSON.stringify(pencil.moves)).digest('hex')
      }
    } catch (error) {
      if (error instanceof Error) planningError = error
      else throw error
    } finally {
      spy.mockRestore()
    }

    const lines = [
      `node=${process.versions.node} platform=${process.platform} arch=${process.arch}`,
      `execArgv=${JSON.stringify(process.execArgv)}`,
      `chain=${CHAIN.id} steps=${CHAIN.steps.map((step) => step.id).join(',')}`,
      `outcome=${planningError ? 'error' : 'ready'}`,
      `planningError=${planningError?.message ?? 'none'}`,
      `workerError=${workerError ? `${workerError.name}: ${workerError.message}` : 'none'}`,
      `pencilMoves=${pencilMoveCount}`,
      `pencilMoveSha256=${pencilMoveHash}`,
      'workerStack:',
      workerError?.workerStack ?? 'none',
    ]
    const evidence = lines.join('\n')
    console.log(`\n[WO-1806]\n${evidence}`)
    writeEvidence('production-chain-default-stack.txt', evidence)

    if (planningError) {
      expect(planningError.message).toContain('pencil-2-ball')
      expect(planningError.message).toContain('Maximum call stack size exceeded')
      expect(workerError?.name).toBe('RangeError')
      expect(workerError?.workerStack).toContain('src/cam3d/strategies/pencil/index.ts')
    } else {
      expect(workerError).toBeUndefined()
      expect(pencilMoveCount).toBeGreaterThan(0)
    }
  })
})
