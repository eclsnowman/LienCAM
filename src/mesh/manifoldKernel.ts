import type { MeshInitOptions, MeshKernelInfo } from './types';

export interface ManifoldWasmModule {
  setup: () => void;
  Manifold?: unknown;
  Mesh?: unknown;
}

export type ManifoldFactory = (options?: { locateFile?: (file: string) => string }) => Promise<ManifoldWasmModule>;

type ImportedManifoldPackage = {
  default?: ManifoldFactory;
};

const MANIFOLD_VERSION = '3.5.1' as const;

/**
 * MSH-3 ruling 3a (source fix for the bug INT-3 found at its wiring layer):
 * this MUST use a REAL, literal `import('manifold-3d')` expression, not the old
 * runtime-constructed-function indirection (a dynamically built function whose
 * body returned import(specifier)). Vite's import-analysis only saw the literal
 * string inside that constructed function, never a real dynamic import, so the
 * FROZEN worker entry (src/mesh/worker/mesh-worker.ts,
 * which composes createMeshWorkerApi() -> this factory) failed in a real
 * browser with "Failed to resolve module specifier manifold-3d" and NO
 * manifold wasm asset was emitted into that chunk's graph. A literal
 * `import('manifold-3d')` is statically visible to Vite, so it bundles the
 * package (and its wasm) for every consumer of the frozen entry. Node/vitest
 * resolves the bare specifier natively either way, which is why the original
 * gap survived MSH-1/MSH-2's Node-only verification.
 *
 * Exported so the ruling-3a pin test can assert the fix stays in place; the
 * frozen public class (ManifoldKernel) and its behavior are unchanged.
 */
export async function defaultManifoldFactory(): Promise<ManifoldWasmModule> {
  const pkg = (await import('manifold-3d')) as unknown as ImportedManifoldPackage | ManifoldFactory;
  const factory = typeof pkg === 'function' ? pkg : pkg.default;
  if (!factory) throw new Error('manifold-3d default factory export was not found');
  return factory({});
}

export class ManifoldKernel {
  private readonly factory: ManifoldFactory;
  private module: ManifoldWasmModule | null = null;
  private info: MeshKernelInfo | null = null;

  constructor(factory: ManifoldFactory = defaultManifoldFactory) {
    this.factory = factory;
  }

  async init(options: MeshInitOptions = {}): Promise<MeshKernelInfo> {
    if (this.info?.available) return this.info;
    try {
      const module = await this.factory({});
      module.setup();
      this.module = module;
      this.info = { kernel: 'manifold-3d', version: MANIFOLD_VERSION, available: true };
      return this.info;
    } catch (err) {
      const warning = err instanceof Error ? err.message : String(err);
      if (options.requireManifold) throw new Error('manifold-3d init failed: ' + warning);
      this.info = { kernel: 'manifold-3d', version: MANIFOLD_VERSION, available: false, warning };
      return this.info;
    }
  }

  async getModule(options: MeshInitOptions = { requireManifold: true }): Promise<ManifoldWasmModule> {
    const info = await this.init(options);
    if (!info.available || this.module === null) {
      throw new Error('manifold-3d is not available' + (info.warning ? ': ' + info.warning : ''));
    }
    return this.module;
  }

  dispose(): void {
    this.module = null;
    this.info = null;
  }

  get live(): boolean {
    return this.module !== null;
  }
}
