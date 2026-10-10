// Lazy singleton loader for the vendored custom OCCT B-rep MODEL kernel (ADR 0018 D1;
// see vendor/README.md). This is the SECOND OCCT module in the app (alongside
// ../loader.ts / occt-fillet): it carries STEP import, healing, tessellation, topology
// queries, surface classification and planar sections, and lazy-loads only in the
// dedicated model worker when a STEP file is imported.
import initOcctModel, { type OpenCascadeInstance } from "./vendor/occt-model.js";

export type OcctModelModule = OpenCascadeInstance;

// The generated default export is typed as init() with no args, but the emscripten factory
// accepts Module overrides at runtime. These are the only ones we use.
export interface OcctModelInitOptions {
  /**
   * Provide the wasm bytes directly. Used by the Node/test runtime (where fetch-of-a-file
   * is unavailable). In the browser worker, omit this — the module fetches the wasm asset
   * URL via locateFile (Vite rewrites the URL to the emitted asset).
   */
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, scriptDirectory: string) => string;
}

let _module: OcctModelModule | null = null;
let _pending: Promise<OcctModelModule> | null = null;

/**
 * Instantiate the OCCT model WASM module (singleton — repeated calls share one instance).
 * @param options Browser worker: omit (defaults to fetching the sibling wasm asset).
 *                Node/tests: pass `{ wasmBinary }`.
 */
export function loadOcctModel(options?: OcctModelInitOptions): Promise<OcctModelModule> {
  if (_module) return Promise.resolve(_module);
  if (_pending) return _pending;
  const factory = initOcctModel as unknown as (
    opts: OcctModelInitOptions,
  ) => Promise<OcctModelModule>;
  const overrides: OcctModelInitOptions =
    options ??
    {
      locateFile: (path) =>
        path.endsWith(".wasm") ? new URL("./vendor/occt-model.wasm", import.meta.url).href : path,
    };
  _pending = factory(overrides).then((m) => {
    _module = m;
    return m;
  });
  return _pending;
}

/** Drop the cached instance — test-only hook so each suite starts clean. */
export function _resetOcctModelForTest(): void {
  _module = null;
  _pending = null;
}
