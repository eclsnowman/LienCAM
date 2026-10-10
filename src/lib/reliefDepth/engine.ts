// WO-2173: the depth engine as the worker holds it - model loaded once per worker, session reused.
import { DEPTH_MODEL, loadModel as loadModelDefault, type LoadedModel, type ModelSpec } from './modelStore'
import { loadOrt as loadOrtDefault } from './ortLoader'
import { DEFAULT_FINE_DETAIL, DEFAULT_TUNING, runPipeline } from './pipeline'
import { createSession, type DepthSession, type OrtLike } from './runtime'
import type { DepthBackend, DepthImage, DepthOptions, DepthProgress, DepthResult } from './types'

export interface EngineDeps {
  loadOrt: () => Promise<OrtLike>
  loadModel: (spec: ModelSpec, onProgress?: (loaded: number, total: number) => void) => Promise<LoadedModel>
  model: ModelSpec
}

export interface DepthEngine {
  estimate(image: DepthImage, options?: DepthOptions, onProgress?: (p: DepthProgress) => void): Promise<DepthResult>
  dispose(): Promise<void>
}

export function createDepthEngine(deps: Partial<EngineDeps> = {}): DepthEngine {
  const d: EngineDeps = {
    loadOrt: deps.loadOrt ?? loadOrtDefault,
    loadModel: deps.loadModel ?? ((spec, onProgress) => loadModelDefault(spec, onProgress)),
    model: deps.model ?? DEPTH_MODEL,
  }
  let session: DepthSession | null = null
  let sessionWant: 'auto' | DepthBackend = 'auto'
  let fromCache = false

  return {
    async estimate(image, options = {}, onProgress) {
      const t0 = performance.now()
      const want = options.backend ?? 'auto'
      let downloadMs = 0, loadMs = 0
      if (!session || want !== sessionWant) {
        await session?.release()
        session = null
        const tl = performance.now()
        const [ort, model] = await Promise.all([
          d.loadOrt(),
          d.loadModel(d.model, (loaded, total) => onProgress?.({ stage: 'download', loaded, total })),
        ])
        session = await createSession(ort, model.bytes, want)
        sessionWant = want
        fromCache = model.fromCache
        downloadMs = model.downloadMs
        loadMs = performance.now() - tl - downloadMs
        onProgress?.({ stage: 'load', backend: session.backend })
      }
      const live = session
      const out = await runPipeline((t, w, h) => live.run(t, w, h), {
        image,
        detail: options.detail ?? 'high',
        fineDetail: options.fineDetail ?? DEFAULT_FINE_DETAIL,
        tuning: { ...DEFAULT_TUNING, ...options.tuning },
        onProgress,
      })
      onProgress?.({ stage: 'finish' })
      return {
        width: out.width,
        height: out.height,
        heights: out.heights,
        backend: live.backend,
        passes: out.passes,
        model: { id: d.model.id, bytes: d.model.bytes, fromCache, licence: d.model.licence },
        timings: { downloadMs, loadMs, inferenceMs: out.inferenceMs, postMs: out.postMs, totalMs: performance.now() - t0 },
      }
    },
    async dispose() {
      await session?.release()
      session = null
    },
  }
}
