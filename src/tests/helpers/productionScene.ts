// Use the established benchmark scene, with real store/dispatcher/kernel.
// Only cached STEP input, tessellation, and the in-process transport are stubbed.
import { vi } from 'vitest'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { WaterlineSlicer } from '../../cam3d/kernel/oclWaterline'
import { chainScene } from '../benchmark/chainRunner'
import type { BenchmarkChain } from '../benchmark/registry'
import { typedMock } from '../support/typedMock'

export async function productionScene(chain: BenchmarkChain,
  adapt: (input: Awaited<ReturnType<typeof chainScene>>) => void,
  slicer?: WaterlineSlicer) {
  const input = await chainScene(chain)
  adapt(input)
  vi.resetModules()
  const channel: WorkerLike = { onmessage: null, onerror: null,
    postMessage: message => dispatcher.handle(message as Cam3dRequest), terminate() {} }
  const dispatcher = new Cam3dDispatcher(new BvhKernel(), (message: Cam3dResponse) => {
    channel.onmessage?.({ data: message } as MessageEvent)
  }, slicer ? { slicer } : {})
  const client = new Cam3dClient(channel)
  vi.doMock('../../cam3d/integration/appClient', async importOriginal =>
    typedMock<typeof import('../../cam3d/integration/appClient')>({
      ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(), getCam3dClient: () => client,
    }))
  vi.doMock('../../cam3d/integration/parallel3dOperation', async importOriginal =>
    typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
      ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
      acquirePartMesh: vi.fn(async () => input.mesh),
    }))
  vi.doMock('../../lib/stepCache', async importOriginal =>
    typedMock<typeof import('../../lib/stepCache')>({
      ...await importOriginal<typeof import('../../lib/stepCache')>(),
      loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
    }))
  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', { localStorage, __cncViewport: { getStockBounds: () => null } })
  const { useCamStore } = await import('../../store')
  useCamStore.setState(state => ({ project: { ...state.project, id: 'wo2460',
    geometry: [input.geometry], setups: input.setups, stocks: [input.physicalStock],
    sceneStock: input.sceneStock, toolLibrary: input.tools, activeSetupId: input.setups[0].id },
    toolLibrary: input.tools, toolpathBatch: null }))
  try {
    const setup = input.setups[0]
    await useCamStore.getState().computeOperationToolpath(setup.id, setup.operations[0].id)
    return useCamStore.getState().project.setups[0].operations[0]
  } finally {
    await client.dispose()
    vi.doUnmock('../../cam3d/integration/appClient')
    vi.doUnmock('../../cam3d/integration/parallel3dOperation')
    vi.doUnmock('../../lib/stepCache')
    vi.unstubAllGlobals()
    vi.resetModules()
  }
}
