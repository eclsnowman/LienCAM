// WO-2173: the one place that loads onnxruntime-web (MIT). Imported lazily, inside the depth worker only, so
// the 28 MB runtime and its wasm never touch the app's start-up or its main thread.
//
// The wasm URL is handed to the runtime explicitly (the same rule as the geometry kernel's `?url` import):
// Vite's dev pre-bundle moves the runtime's own files, so its default "next to me" lookup cannot be trusted.
import type { OrtLike } from './runtime'

export async function loadOrt(): Promise<OrtLike> {
  const [ort, wasm] = await Promise.all([
    import('onnxruntime-web'),
    import('onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url'),
  ])
  ort.env.wasm.wasmPaths = { wasm: wasm.default }
  return ort as unknown as OrtLike
}
