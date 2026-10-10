// WO-2173: an inference session on the best backend the machine has - WebGPU when the browser gives us a
// working adapter, WASM otherwise, and WASM again if WebGPU is present but the session will not start on it.
import type { DepthBackend } from './types'

/** The slice of onnxruntime-web the engine uses (so tests can hand in a stand-in runtime). */
export interface OrtTensorLike { data: unknown; dims: readonly number[] }
export interface OrtSessionLike {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>
  release?(): Promise<void>
}
export interface OrtLike {
  env: { wasm: { wasmPaths?: unknown; numThreads?: number } }
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensorLike
  InferenceSession: {
    create(model: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel?: string }): Promise<OrtSessionLike>
  }
}

interface GpuLike { requestAdapter(): Promise<unknown | null> }

/** True when this context has a WebGPU adapter to run on. */
export async function hasWebGpu(nav: unknown = (globalThis as { navigator?: unknown }).navigator): Promise<boolean> {
  const gpu = (nav as { gpu?: GpuLike } | undefined)?.gpu
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false
  try { return (await gpu.requestAdapter()) != null } catch { return false }
}

export interface DepthSession {
  backend: DepthBackend
  /** [1,3,h,w] normalised RGB -> h x w relative depth. */
  run(tensor: Float32Array, width: number, height: number): Promise<Float32Array>
  release(): Promise<void>
}

export async function createSession(ort: OrtLike, model: Uint8Array, want: 'auto' | DepthBackend = 'auto'): Promise<DepthSession> {
  const order: DepthBackend[] = want === 'wasm' ? ['wasm'] : want === 'webgpu' ? ['webgpu', 'wasm'] : (await hasWebGpu() ? ['webgpu', 'wasm'] : ['wasm'])
  let lastError: unknown
  for (const backend of order) {
    try {
      const session = await ort.InferenceSession.create(model, { executionProviders: [backend], graphOptimizationLevel: 'all' })
      return wrap(ort, session, backend)
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`reliefDepth: the depth model would not start (${String(lastError)})`)
}

function wrap(ort: OrtLike, session: OrtSessionLike, backend: DepthBackend): DepthSession {
  const input = session.inputNames[0] ?? 'pixel_values'
  const output = session.outputNames[0] ?? 'predicted_depth'
  return {
    backend,
    async run(tensor, width, height) {
      const out = await session.run({ [input]: new ort.Tensor('float32', tensor, [1, 3, height, width]) })
      const t = out[output]
      const data = t?.data
      if (!(data instanceof Float32Array) || data.length !== width * height) {
        throw new Error(`reliefDepth: the model returned ${t ? t.dims.join(' x ') : 'nothing'}, expected 1 x ${height} x ${width}`)
      }
      return data
    },
    release: async () => { await session.release?.() },
  }
}
