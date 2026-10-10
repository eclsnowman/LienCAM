// WO-2173: image relief stage 3 - the photo-depth engine's public shapes.
//
// One call turns a picture into a 16-bit height grid the relief tool uses: light = high = standing proud,
// the same convention as the brightness method, so the palette can swap one for the other.

/** A decoded picture, row-major RGBA (the shape of ImageData, so a canvas read passes straight in). */
export interface DepthImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** 'high' (default) adds native-resolution tiles on top of the whole-picture pass - the fine scales, leaf
 *  and hair edges of Operator's coin and medallion targets. 'fast' is the whole-picture pass alone. */
export type DepthDetail = 'high' | 'fast'

export type DepthBackend = 'webgpu' | 'wasm'

export interface DepthOptions {
  detail?: DepthDetail
  /** How much of the picture's own fine texture (a band-pass of its brightness) is laid on top of the AI
   *  depth, as a fraction of the height range. 0 = none. Coins and lettering want some; noisy photos less. */
  fineDetail?: number
  /** Force a backend. Default: WebGPU when the browser has a working adapter, else WASM. */
  backend?: 'auto' | DepthBackend
  /** Engine sizes. Only tests and the research harness change these. */
  tuning?: Partial<DepthTuning>
}

export interface DepthTuning {
  /** The model's native input side (Depth Anything V2 is trained at 518 = 37 x 14). */
  modelSide: number
  /** The picture is worked at no more than this many pixels on its long side; the result is resized back. */
  maxWorkingSide: number
  /** Tile overlap as a fraction of the tile. */
  tileOverlap: number
}

export type DepthProgress =
  | { stage: 'download'; loaded: number; total: number }
  | { stage: 'load'; backend: DepthBackend }
  | { stage: 'infer'; done: number; total: number }
  | { stage: 'finish' }

export interface DepthTimings {
  /** Model download (0 when it came from the cache). */
  downloadMs: number
  /** Reading the model (from cache or network) and creating the inference session; 0 when reused. */
  loadMs: number
  inferenceMs: number
  postMs: number
  totalMs: number
}

export interface DepthResult {
  width: number
  height: number
  /** width x height, row-major, 0 = lowest, 65535 = highest (nearest the viewer). */
  heights: Uint16Array
  backend: DepthBackend
  /** Model passes run (1 whole-picture pass + tiles). */
  passes: number
  model: { id: string; bytes: number; fromCache: boolean; licence: string }
  timings: DepthTimings
}
