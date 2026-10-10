// WO-2405: a Parallel finish never moves below its own resolved bottom, the
// stay-down links between passes included.
//
// Found by WO-2378 (kit part 06, the knob): with a finish depth whose floor sits
// above part of the surface, the passes are clipped AT the floor but the
// stay-down link between two clipped pieces fed along the raw surface under it
// (Z 4.985 vs bottom 5.114). The reopened operation was then "outdated" by the
// saved-toolpath height check and Post refused it. The check is right; the path
// was wrong.
//
// Production route: the store's computeOperationToolpath on the plate-with-holes
// STEP part (the same worker path the app uses; only browser transports are
// replaced, as in finishRetractOverStock.wo1616), then the real Save
// (saveProjectToFile) into a fresh store and the real Open (loadProjectFromFile),
// then Post (buildPostInput -> postProgram). With the pathbuild clamp removed
// this case puts 6 link moves up to 0.0715 mm under the 8.5 mm floor.
//
// WO2405_EVIDENCE=<label> writes the moves near the floor into
// src/tests/evidence/WO-2405/moves-<label>.json for the side-view picture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
  // Open re-caches the file's STEP bytes; there is no IndexedDB under node.
  cacheStep: async () => {},
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))

import * as scenarioModule from '../helpers/heightScenario'
import { installRealToolpathWorker, runSolidScenario } from '../helpers/heightScenario'
import { useCamStore } from '../../store'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { buildPostInput, postProgram, UCCNC_CONFIG } from '../../lib/post'
import type { ToolpathMove } from '../../types'

installRealToolpathWorker()

const EPS = 1e-6
const FINISH_DEPTH = 1.5

let savedProjectText = ''

beforeEach(() => {
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-2405.camproject'
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const below = (moves: readonly ToolpathMove[], floor: number) => moves
  .map((m, index) => ({ index, role: m.role, x: m.x, y: m.y, z: m.z, under: floor - m.z }))
  .filter(m => m.under > EPS)

describe('WO-2405 Parallel finish links stay on the operation floor', () => {
  it('plate with holes, finish depth 1.5: every move at or above the bottom; save -> open keeps it current; Post writes it', async () => {
    const [r] = await runSolidScenario({
      part: 'plate_holes', z: 0, stock: { kind: 'auto', offsetXY: 5, offsetZTop: 0, offsetZBottom: 0 },
      operations: [{ kind: 'parallel_3d', toolDiameter: 6, params: { finishDepth: FINISH_DEPTH } }],
    })
    expect(r.status, r.errorMessage).toBe('ready')
    const computed = useCamStore.getState().project.setups[0].operations[0]
    const bottom = computed.resolvedHeights!.machine.bottom
    const top = computed.resolvedHeights!.machine.top
    expect(top - bottom, 'the resolved bottom is the finish depth under the top').toBeCloseTo(FINISH_DEPTH, 6)
    const moves = r.worldMoves

    // The case is real: the floor sits above part of the surface (the holes), so
    // passes were clipped onto it, and stay-down links run between the pieces.
    const lowestCut = moves.filter(m => m.role === 'cut').reduce((z, m) => Math.min(z, m.z), Infinity)
    expect(lowestCut, 'passes clipped exactly at the floor').toBeCloseTo(bottom, 6)
    expect(r.partBottomWcs + r.wcsOriginMachineZ, 'part surface reaches below the floor').toBeLessThan(bottom)
    expect(moves.filter(m => m.role === 'stepover').length, 'stay-down links present').toBeGreaterThan(0)

    if (process.env.WO2405_EVIDENCE) {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('src/tests/evidence/WO-2405', { recursive: true })
      writeFileSync(`src/tests/evidence/WO-2405/moves-${process.env.WO2405_EVIDENCE}.json`, JSON.stringify({
        label: process.env.WO2405_EVIDENCE, bottom, top, finishDepth: FINISH_DEPTH,
        below: below(moves, bottom),
        moves: moves.map(m => ({ role: m.role, x: m.x, y: m.y, z: m.z })),
      }))
    }

    // Every move, links included, at or above the resolved bottom. Soft, like
    // the reopen and Post verdicts below, so the negative control (clamp
    // removed) reports all three consequences, not just the first.
    expect.soft(below(moves, bottom)).toEqual([])

    // Save (the real Save button's store action) -> fresh store -> Open.
    await useCamStore.getState().saveProjectToFile()
    expect(savedProjectText).not.toBe('')
    useCamStore.setState(useCamStore.getInitialState(), true)
    await useCamStore.getState().loadProjectFromFile(savedProjectText)
    const reopened = useCamStore.getState().project
    const setup = reopened.setups[0]
    const op = setup.operations[0]
    expect.soft(op.status, op.errorMessage).toBe('ready')
    expect.soft(operationGenerationIsCurrent(reopened, setup, op)).toBe(true)
    expect.soft(op.toolpathMoves?.length).toBe(moves.length)

    // Post writes the program: no OP_OUTDATED, no error, real G-code.
    const result = postProgram(buildPostInput(reopened, setup), UCCNC_CONFIG)
    expect.soft(result.diagnostics.filter(d => d.level === 'error').map(d => d.code)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.gcode.split('\n').length).toBeGreaterThan(moves.length / 2)
  }, 300_000)
})
