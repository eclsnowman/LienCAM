// B-rep render-fidelity (tessellation quality) tier table.
//
// PURE module by design: it imports ONLY the BrepTessellationQuality type, never
// the OCCT kernel or the model worker, so it is safe to import from the store,
// the Settings UI, and tests alike. The values feed BRepMesh via TessellateOptions
// in core.ts (buildModelPayload's opts param: { linearDeflection?, angularDeflection? }).
//
// Higher fidelity = smaller deflection = smoother curved surfaces but more mesh
// memory and slower STEP load.
//
// VALUES ARE EVIDENCE-BASED, not guessed. A deflection sweep was benchmarked on
// two curved STEP fixtures (fix_plate_holes, fix_freeform), measuring triangle
// count and median tessellation time per setting (tools/capture/out/tess-bench.csv,
// docs/qa/005). The cost/quality KNEE is at linear 0.05 / angular 0.25: triangle
// count + build time are nearly flat from 0.10/0.50 down to 0.05/0.25, then bend
// upward (2-4x cost below ~0.03/0.15 for diminishing visual return). Visual
// samples confirmed performance->balanced is the meaningful smoothing jump and
// balanced->high is marginal. So 'balanced' (the knee) is the default; 'high' is
// available for capable hardware / curve-heavy parts; 'performance' is the old
// 0.1/0.5 floor for low-end machines.
import type { BrepTessellationQuality } from '../../../../../types'

export const DEFAULT_BREP_QUALITY: BrepTessellationQuality = 'balanced'

export interface BrepDeflection {
  /** BRepMesh linear deflection, mm. */
  linearDeflection: number
  /** BRepMesh angular deflection, radians. */
  angularDeflection: number
}

const TABLE: Record<BrepTessellationQuality, BrepDeflection> = {
  // Today's old hardcoded values = the low-end floor.
  performance: { linearDeflection: 0.1, angularDeflection: 0.5 },
  // Default: smoother curves at a modest memory/time cost.
  balanced: { linearDeflection: 0.05, angularDeflection: 0.25 },
  // Very smooth; heaviest mesh.
  high: { linearDeflection: 0.025, angularDeflection: 0.12 },
}

/** Resolve a tier to its (linear, angular) deflection; unknown -> balanced. */
export function deflectionForQuality(q: BrepTessellationQuality): BrepDeflection {
  return TABLE[q] ?? TABLE[DEFAULT_BREP_QUALITY]
}
