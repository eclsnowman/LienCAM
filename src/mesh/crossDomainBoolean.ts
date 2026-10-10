/**
 * MSH-4 — Cross-domain boolean: mesh op brep, honestly labeled.
 * ==========================================================================
 * Boolean between a mesh body and a B-rep body, executed as a manifold-3d
 * mesh boolean. The B-rep operand is tessellated by the CALLER via the
 * existing frozen geom facade (createGeomService/createLocalGeomService
 * .tessellate at a caller-chosen tolerance, per WO ruling 1 — this module
 * never touches the geom worker or its contract, it only consumes the plain
 * position/index buffers that come back).
 *
 * HONEST LABELING (WO ruling 2): a result produced through this bridge is
 * approximate BY CONSTRUCTION whenever either operand came from a
 * tessellated brep — the exact B-rep surface was replaced by a triangle
 * mesh at a finite tolerance before the boolean ran. The result therefore
 * always carries `{ domain: 'mesh', approximate, tessellationTolerance,
 * operandSources }` so downstream consumers and the report can surface it
 * plainly, never silently present a cross-domain result as exact.
 *
 * REFUSAL: a brep-vs-brep boolean is refused outright. That pair is EXACT
 * and belongs to the geom worker's own applyBoolean — this bridge exists
 * to make a mesh/brep MIX possible, never to approximate a pair that could
 * have stayed exact.
 */
import { booleanMesh } from './manifoldOps';
import type { ManifoldWasmModule } from './manifoldKernel';
import type { MeshBooleanParams, MeshBuffers, MeshOperationResult } from './types';

/** Plain position/index buffers, field-compatible with GeomService's
 *  TessBuffers (position: Float32Array, index: Uint32Array) — callers pass
 *  a tessellate() result straight through without copying. Only the two
 *  geometry-carrying fields are needed here; TessBuffers' face/edge id
 *  bookkeeping is not (this bridge does not preserve brep face lineage —
 *  the boolean runs in the mesh domain and loses it, which is part of what
 *  `approximate: true` is honestly declaring). */
export interface TessellatedBrepBuffers {
  position: Float32Array;
  index: Uint32Array;
}

export type CrossDomainOperandSource =
  | { domain: 'mesh' }
  | { domain: 'brep'; tessellationTolerance: number };

export interface CrossDomainOperand {
  source: CrossDomainOperandSource;
  mesh: MeshBuffers;
}

export interface CrossDomainBooleanResult extends MeshOperationResult {
  domain: 'mesh';
  /** true whenever either operand was a tessellated brep -- the result is
   *  provably not exact even though the manifold boolean itself is robust. */
  approximate: boolean;
  /** the tightest (max, i.e. worst-case) linear-deflection tolerance used to
   *  tessellate any brep operand feeding this op; null when both operands
   *  were already mesh-domain (nothing was tessellated). */
  tessellationTolerance: number | null;
  operandSources: [CrossDomainOperandSource, CrossDomainOperandSource];
}

/** Adapts a tessellate() result's geometry buffers into a plain mesh. */
export function meshFromTessBuffers(tess: TessellatedBrepBuffers): MeshBuffers {
  return { positions: tess.position, indices: tess.index };
}

/** Tags an already mesh-domain body (e.g. an imported STL) as a mesh operand. */
export function meshOperand(mesh: MeshBuffers): CrossDomainOperand {
  return { source: { domain: 'mesh' }, mesh };
}

/** Tags a tessellated brep body as a brep operand, carrying the tolerance
 *  it was tessellated at (the caller's own tessellate() call — see module
 *  doc, this function does not tessellate anything itself). */
export function brepOperand(tess: TessellatedBrepBuffers, tessellationTolerance: number): CrossDomainOperand {
  if (!Number.isFinite(tessellationTolerance) || tessellationTolerance <= 0) {
    throw new Error('brep operand tessellationTolerance must be a positive finite number');
  }
  return { source: { domain: 'brep', tessellationTolerance }, mesh: meshFromTessBuffers(tess) };
}

export class CrossDomainBooleanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossDomainBooleanRefusedError';
  }
}

/**
 * Boolean between two operands where at least one is mesh-domain. Refuses
 * brep-vs-brep (see module doc). No wasm handles are ever minted on the
 * refusal path (the check runs before booleanMesh/toManifold); the success
 * and thrown-error paths both go through booleanMesh's own try/finally
 * handle release (manifoldOps.ts releaseAllTracked), so this wrapper adds
 * no new handle lifecycle of its own (standing acceptance #7/#9).
 */
export function crossDomainBooleanMesh(
  module: ManifoldWasmModule,
  left: CrossDomainOperand,
  right: CrossDomainOperand,
  params: MeshBooleanParams,
): CrossDomainBooleanResult {
  if (left.source.domain === 'brep' && right.source.domain === 'brep') {
    throw new CrossDomainBooleanRefusedError(
      'brep-vs-brep boolean refused: both operands are exact B-rep bodies. This belongs to the exact geom worker ' +
        "(GeomService.applyBoolean), which never needs to approximate what could stay exact -- never silently " +
        'approximate a pair that could have been exact. Route brep-vs-brep through the geom worker instead of this ' +
        'mesh-domain cross-domain bridge.',
    );
  }

  const result = booleanMesh(module, left.mesh, right.mesh, params);

  const brepSources = [left.source, right.source].filter(
    (s): s is { domain: 'brep'; tessellationTolerance: number } => s.domain === 'brep',
  );

  return {
    ...result,
    domain: 'mesh',
    approximate: brepSources.length > 0,
    tessellationTolerance: brepSources.length > 0 ? Math.max(...brepSources.map((s) => s.tessellationTolerance)) : null,
    operandSources: [left.source, right.source],
  };
}
