// IMPORT-STOCK-PROMPT-COMPLETION: focused entrypoint proof that the PRODUCTION
// combined-STEP import path (store.importBrepGeometry, multi-body kept as ONE
// row) RETAINS its call to the import-time stock-choice seam, and that the
// per-body INDIVIDUAL fan-out does NOT (the deliberate model-origin limitation
// is not silently widened). A future refactor that drops the
// `await promptAndApplyImportStockChoice(...)` line from the combined branch
// would break the first test; one that accidentally routes the individual
// fan-out into the prompt would break the guard. Mirrors importBrepAttributes
// .test.ts (mocked stepCache + model worker + attribute reader, window stubbed
// so the viewport bridge access is a no-op).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { StepDisplayAttributes } from '../../lib/import/stepAttributes'
import { typedMock } from '../support/typedMock'

const readStepDisplayAttributes = vi.fn<() => Promise<StepDisplayAttributes>>()

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  removeCachedStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (orig) => {
  const actual = await orig<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...actual,
    // solidCount: 2 so importBrepGeometry enters the multi-body choice branch.
    readStep: vi.fn(async (): Promise<BrepModelPayload> => ({
      mesh: {
        positions: new Float32Array(0), normals: new Float32Array(0),
        indices: new Uint32Array(0), faceRanges: new Uint32Array(0),
      },
      edges: { positions: new Float32Array(0), edgeRanges: new Uint32Array(0) },
      faceTypes: new Uint8Array(0), faceCount: 0, edgeCount: 0,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      solidCount: 2,
    })),
    setBrepPayload: vi.fn(),
  })
})
vi.mock('../../lib/import/stepAttributes', () => typedMock<typeof import('../../lib/import/stepAttributes')>({
  readStepDisplayAttributes: () => readStepDisplayAttributes(),
}))

import { useCamStore } from '../../store'

function fakeStepFile(name: string): File {
  return { name, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File
}
function newestGeometry(filename: string) {
  return useCamStore.getState().project.geometry.filter((g) => g.filename === filename).at(-1)
}

describe('importBrepGeometry retains the import-time stock-choice call (combined STEP path)', () => {
  beforeEach(() => {
    readStepDisplayAttributes.mockReset()
    readStepDisplayAttributes.mockResolvedValue({ name: 'Bracket', color: undefined, partCount: 2 })
    vi.stubGlobal('window', {})
    useCamStore.setState({ consoleEvents: [], brepImportError: null })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('combined multi-body STEP calls promptAndApplyImportStockChoice for the new row', async () => {
    const promptSpy = vi.fn().mockResolvedValue(undefined)
    const multiBodySpy = vi.fn().mockResolvedValue('combined')
    useCamStore.setState({
      promptAndApplyImportStockChoice: promptSpy,
      requestMultiBodyImportChoice: multiBodySpy,
    })

    await useCamStore.getState().importBrepGeometry(fakeStepFile('multi.step'))

    const geo = newestGeometry('multi.step')
    expect(geo).toBeDefined()
    // The multi-body choice was offered (2 solids) and resolved 'combined'.
    expect(multiBodySpy).toHaveBeenCalledTimes(1)
    expect(multiBodySpy.mock.calls[0][0]).toMatchObject({
      geoId: geo!.id, name: geo!.name, bodyCount: 2, currentMode: 'combined',
    })
    // The stock-choice seam is invoked exactly once for the combined row.
    expect(promptSpy).toHaveBeenCalledTimes(1)
    expect(promptSpy.mock.calls[0][0]).toBe(geo!.id)
    expect(promptSpy.mock.calls[0][1]).toBe(geo!.name)
  })

  it('individual fan-out does NOT call the stock prompt (per-body model rows carry no stock)', async () => {
    // Guards requirement 7: the deliberate per-body STEP/model-origin
    // limitation stays out of this patch. The individual branch fans out to
    // model-origin rows (deliberately no-stock) and returns BEFORE the stock
    // prompt -- it must not be silently widened to prompt for them.
    const promptSpy = vi.fn().mockResolvedValue(undefined)
    const multiBodySpy = vi.fn().mockResolvedValue('individual')
    const wrapSpy = vi.fn().mockResolvedValue(undefined)
    useCamStore.setState({
      promptAndApplyImportStockChoice: promptSpy,
      requestMultiBodyImportChoice: multiBodySpy,
      wrapImportedGeometryAsModelItem: wrapSpy,
    })

    await useCamStore.getState().importBrepGeometry(fakeStepFile('split.step'))

    expect(multiBodySpy).toHaveBeenCalledTimes(1)
    // The headless fan-out ran (the individual branch) ...
    expect(wrapSpy).toHaveBeenCalledTimes(1)
    // ... and the stock-choice seam was NEVER called for the per-body rows.
    expect(promptSpy).not.toHaveBeenCalled()
  })
})
