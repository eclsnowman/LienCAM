// WO MSH-4-MESHLAB-PROOF: builds a REAL tessellated B-rep operand for the lab's
// cross-domain boolean demo (src/mesh/crossDomainBoolean.ts, unwired until now).
//
// Uses the EXISTING frozen geom facade -- createLocalGeomService, src/geom/index.ts
// -- exactly as crossDomainBoolean.ts's own module doc names as the caller-side
// tessellation source ("the B-rep operand is tessellated by the CALLER via the
// existing frozen geom facade... this module never touches the geom worker or its
// contract"). createLocalGeomService runs the real occt-wasm kernel on the calling
// thread -- no new Worker is spawned here; it is itself the geom facade's documented
// "ruling-#2 fallback (b)" no-worker path (src/geom/index.ts), already proven in a
// real browser by src/components/model3d/tree/demo/ChassisDemo.tsx.
//
// This file lives entirely inside the MeshLab lab's own territory: it IMPORTS
// createLocalGeomService + geom-service types (read + call only, per the WO's file
// boundary) and never edits src/store, src/mesh/**, src/doc/**, or src/geom/worker/**
// wiring.
import { textFor } from '../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { ExtrudeRequest, ProfileRegion } from '../../geom/geom-service'
import type { TessellatedBrepBuffers } from '../../mesh'

export type BrepPrimitiveShape = 'box' | 'cylinder'

export interface BrepPrimitiveParams {
  shape: BrepPrimitiveShape
  /** box: full box size in mm. */
  box: { x: number; y: number; z: number }
  /** cylinder: radius + height in mm (axis along +Z). */
  cylinderRadius: number
  cylinderHeight: number
}

export interface BuiltBrepOperand {
  shape: BrepPrimitiveShape
  tess: TessellatedBrepBuffers
  triangleCount: number
  ms: number
}

function xyPlane(z = 0): ProfileRegion['plane'] {
  return { origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
}

function circleProfile(sketchId: string, r: number): ProfileRegion {
  return {
    sketchId,
    plane: xyPlane(0),
    loops: [[{ kind: 'arc', c: [0, 0], r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.c0` }]],
  }
}

export interface GeomOperandClient {
  /** Lazily inits the real occt-wasm kernel on first call; idempotent after. */
  init(): Promise<void>
  /** Builds the requested primitive, tessellates it at `tolerance` (mm, linear
   *  deflection), disposes the transient body, and returns the plain
   *  position/index buffers -- ready for src/mesh/crossDomainBoolean.ts's
   *  brepOperand(). Throws (never swallows) on a refused/failed build. */
  buildPrimitive(params: BrepPrimitiveParams, tolerance: number): Promise<BuiltBrepOperand>
  /** Tears down the underlying kernel. Safe to call once, at unmount. */
  terminate(): void
}

export function createGeomOperandClient(createClient: () => GeomClient = createLocalGeomService): GeomOperandClient {
  const client = createClient()
  let initialized = false

  async function init(): Promise<void> {
    if (initialized) return
    await client.init()
    initialized = true
  }

  async function buildPrimitive(params: BrepPrimitiveParams, tolerance: number): Promise<BuiltBrepOperand> {
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      throw new Error(workbenchText('geomOperand.brepTessellationToleranceMustBeAPositiveFiniteNumber'))
    }
    await init()
    const t0 = performance.now()
    const featureId = `meshlab-brep-${Date.now()}-${Math.round(Math.random() * 1e6)}`
    const result =
      params.shape === 'box'
        ? await client.makeBox(featureId, params.box)
        : await client.makeExtrude({
            featureId,
            profiles: [circleProfile(featureId, params.cylinderRadius)],
            end: { kind: 'blind', distance: params.cylinderHeight },
            op: 'newBody',
          } satisfies ExtrudeRequest)
    if (!result.ok || result.body === undefined) {
      // FAIL-LOUD (ADR-0003): surface the kernel's own diagnostics, never a
      // generic "something went wrong".
      throw new Error(workbenchText('geomOperand.failedToBuildBrepPrimitive', { shape: String(params.shape), value2: String(JSON.stringify(result.diagnostics)) }))
    }
    try {
      const tess = await client.tessellate(result.body, { deflection: tolerance, angularDeflection: Math.PI })
      return {
        shape: params.shape,
        tess: { position: tess.position, index: tess.index },
        triangleCount: tess.index.length / 3,
        ms: performance.now() - t0,
      }
    } finally {
      await client.dispose(result.body)
    }
  }

  function terminate(): void {
    void client.terminate()
  }

  return { init, buildPrimitive, terminate }
}
