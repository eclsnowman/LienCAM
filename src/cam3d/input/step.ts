// cam3d input pipeline: STEP importer (D-007 / D-008 / D-011).
//
// STEP bytes -> in-house OCCT model kernel tessellation -> ONE PartMesh,
// indistinguishable downstream from an STL import except for source tag and
// faceIds. The kernel does read + heal + BRepMesh; this module owns the
// CAM-driven deflection policy, the triangle budget, the faceRanges->faceIds
// conversion, the sanity pass, and the in-session tessellation cache.
//
// Deflection policy (D-007): linear deflection = camTolerance / 4, so chord
// error consumes at most a quarter of the CAM tolerance. If that tessellation
// exceeds the triangle budget the deflection is COARSENED until it fits, and
// the effective deflection is surfaced in the result plus a warning -- never
// silently.
//
// Budget loop: the kernel cannot predict a triangle count without meshing
// (BRepMesh has no dry-run), so this is a tessellate -> check -> coarsen loop.
// Triangle count on curved regions scales roughly ~ 1/deflection, so each
// retry scales deflection by (count/budget) with a 1.25 overshoot factor --
// converges in 1-2 retries in practice, and fails loud after a bounded number
// of attempts rather than looping forever on pathological shapes.

import type { PartImportResult, StepTessellation, StepTessellator } from './types';
import { fnv1a64Bytes } from './contentHash';
import { sanitizeTriangleMesh } from './sanitize';

/** D-007 budget: keep CAM meshes under ~1.5M triangles. */
export const DEFAULT_TRIANGLE_BUDGET = 1_500_000;

/** Default BRepMesh angular deflection (radians) for CAM tessellation. */
export const DEFAULT_ANGULAR_DEFLECTION_RAD = 0.35;

/** Bounded coarsening retries before declaring the shape un-budgetable. */
const MAX_COARSEN_ATTEMPTS = 8;

export interface StepImportOptions {
  /** CAM tolerance in mm; linear deflection is camTolerance / 4 (D-007). */
  camTolerance: number;
  /** BRepMesh angular deflection, radians. Default 0.35. */
  angularDeflectionRad?: number;
  /** Triangle budget override (default 1.5M). Tests use small budgets to exercise coarsening cheaply. */
  triangleBudget?: number;
  /**
   * Tessellation seam. Default: the browser model-worker client (dynamic
   * import so Node tests never load worker code). Node tests inject
   * makeOcctCoreTessellator(oc) instead.
   */
  tessellator?: StepTessellator;
}

// ---- in-session tessellation cache (D-007: keyed by content hash + deflection) ----
//
// The key holds the REQUESTED deflection inputs (camTolerance/4, angular,
// budget); the effective deflection is derived deterministically from those
// plus the bytes, so identical requests always land on the same entry.
// Entries hold the final PartImportResult; callers must treat the typed
// arrays as immutable (the kernel contract already requires this: meshes are
// uploaded once and referenced by handle).

const cache = new Map<string, PartImportResult>();
let cacheHits = 0;
let cacheMisses = 0;

/** Cache observability hook (tests assert hit counts instead of timing). */
export function getStepImportCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits: cacheHits, misses: cacheMisses, entries: cache.size };
}

/** Test-only: reset the cache and its counters. */
export function _resetStepImportCacheForTest(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/**
 * Expand the kernel's per-face [firstIndexOffset, indexCount] ranges into one
 * BRep face id per triangle (D-008). Validates the ranges are contiguous,
 * ascending, triangle-aligned and cover the whole index buffer -- any
 * violation is a kernel protocol bug and fails loud.
 */
function faceIdsFromRanges(faceRanges: Uint32Array, indexCount: number): Uint32Array {
  if (faceRanges.length % 2 !== 0) {
    throw new Error(`STEP import: faceRanges length ${faceRanges.length} is not even`);
  }
  const faceCount = faceRanges.length / 2;
  if (indexCount % 3 !== 0) {
    throw new Error(`STEP import: index count ${indexCount} is not a multiple of 3`);
  }
  const faceIds = new Uint32Array(indexCount / 3);
  let expectedStart = 0;
  for (let f = 0; f < faceCount; f++) {
    const start = faceRanges[2 * f];
    const count = faceRanges[2 * f + 1];
    if (start !== expectedStart || start % 3 !== 0 || count % 3 !== 0) {
      throw new Error(
        `STEP import: faceRanges not contiguous/triangle-aligned at face ${f} ` +
          `(start ${start}, count ${count}, expected start ${expectedStart})`,
      );
    }
    for (let t = start / 3; t < (start + count) / 3; t++) faceIds[t] = f;
    expectedStart = start + count;
  }
  if (expectedStart !== indexCount) {
    throw new Error(
      `STEP import: faceRanges cover ${expectedStart} indices but the mesh has ${indexCount}`,
    );
  }
  return faceIds;
}

/**
 * Import STEP bytes into a PartMesh via the in-house OCCT model kernel
 * (D-011). See module header for the deflection/budget policy.
 */
export async function importStepToPartMesh(
  data: ArrayBuffer,
  opts: StepImportOptions,
): Promise<PartImportResult> {
  const { camTolerance } = opts;
  if (!Number.isFinite(camTolerance) || camTolerance <= 0) {
    throw new Error(`STEP import: camTolerance must be a positive finite number, got ${camTolerance}`);
  }
  const angular = opts.angularDeflectionRad ?? DEFAULT_ANGULAR_DEFLECTION_RAD;
  if (!Number.isFinite(angular) || angular <= 0) {
    throw new Error(`STEP import: angularDeflectionRad must be positive, got ${angular}`);
  }
  const budget = opts.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`STEP import: triangleBudget must be a positive integer, got ${budget}`);
  }

  const bytes = new Uint8Array(data);
  if (bytes.length === 0) {
    throw new Error('STEP import: empty file');
  }

  const requestedDeflection = camTolerance / 4;
  const cacheKey = `${fnv1a64Bytes(bytes)}:${bytes.length}:${requestedDeflection}:${angular}:${budget}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    cacheHits++;
    return cached;
  }
  cacheMisses++;

  const tessellator = opts.tessellator ?? (await defaultTessellator());

  // --- tessellate -> check -> coarsen loop (see module header) ---
  let deflection = requestedDeflection;
  let tess: StepTessellation | null = null;
  for (let attempt = 0; attempt <= MAX_COARSEN_ATTEMPTS; attempt++) {
    const candidate = await tessellator(bytes, {
      linearDeflection: deflection,
      angularDeflection: angular,
    });
    if (candidate.indices.length / 3 <= budget) {
      tess = candidate;
      break;
    }
    deflection = deflection * ((candidate.indices.length / 3) / budget) * 1.25;
  }
  if (tess === null) {
    throw new Error(
      `STEP import: could not fit the tessellation under the ${budget}-triangle budget after ` +
        `${MAX_COARSEN_ATTEMPTS} coarsening attempts (last deflection ${deflection.toFixed(6)} mm). ` +
        `The shape's minimum tessellation exceeds the budget.`,
    );
  }

  const warnings: string[] = [];
  if (deflection > requestedDeflection) {
    warnings.push(
      `Triangle budget (${budget}) forced coarsening: tessellation deflection is ` +
        `${deflection.toFixed(6)} mm instead of the requested ${requestedDeflection.toFixed(6)} mm ` +
        `(camTolerance/4). Surface chord error may exceed camTolerance/4.`,
    );
  }

  const rawFaceIds = faceIdsFromRanges(tess.faceRanges, tess.indices.length);
  const clean = sanitizeTriangleMesh(tess.positions, tess.indices, rawFaceIds);
  warnings.push(...clean.warnings);
  if (clean.faceIds === undefined) {
    // sanitize returns faceIds iff they were passed in; this cannot happen.
    throw new Error('STEP import: sanitize pass lost faceIds (internal bug)');
  }

  const result: PartImportResult = {
    mesh: {
      positions: clean.positions,
      indices: clean.indices,
      bounds: clean.bounds,
      faceIds: clean.faceIds,
      source: 'step',
    },
    warnings,
    effectiveDeflectionMm: deflection,
    triangleCount: clean.indices.length / 3,
  };
  cache.set(cacheKey, result);
  return result;
}

/**
 * Default (browser) tessellator: the model-worker client. Loaded lazily so
 * that Node/vitest importers of this module never pull in Worker-dependent
 * code paths; Node callers inject a tessellator explicitly.
 */
async function defaultTessellator(): Promise<StepTessellator> {
  const mod = await import('./stepTessellatorWorker');
  return mod.workerStepTessellator;
}
