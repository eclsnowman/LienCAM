// Web Worker -- B-rep model import (ADR 0018).
// Runs the heavy occt-model wasm kernel off the main thread. Consumers create it via:
//   new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module' })
// (same convention as src/lib/cam/toolpathWorker.ts).
//
// ADR 0018 D2: the TopoDS_Shape handle NEVER crosses the worker boundary. It lives
// in this worker's wasm heap, keyed by geoId in the registry below, for future
// in-worker stages (derivation layer, sections). Only copied typed-array buffers
// are posted out, as transferables.

import { loadOcctModel } from './loader'
import { buildModelPayload, type ModelPhase } from './core'
import {
  planarFaceLoops,
  edgeChainLoops,
  holeFeatures,
  cylinderFeatures,
  prismaticRoughTargetFacts,
  sectionAtZ,
  sectionAtPlane,
} from './derive'
import type { ModelRequestMsg, ModelResponseMsg } from './types'
import type { TopoDS_Shape } from './vendor/occt-model.js'

console.log('[modelWorker] module loaded')

// In-heap shape registry (D2). Re-importing a geoId frees the previous shape.
const shapeRegistry = new Map<string, TopoDS_Shape>()

/**
 * In-worker accessor for future stages (derivation layer, sectionAtZ, ...).
 * The shape is only valid inside this worker; never post it.
 */
export function getShape(geoId: string): TopoDS_Shape | undefined {
  return shapeRegistry.get(geoId)
}

function post(msg: ModelResponseMsg, transfer?: Transferable[]): void {
  if (transfer) self.postMessage(msg, { transfer })
  else self.postMessage(msg)
}

self.onmessage = async (event: MessageEvent<ModelRequestMsg>) => {
  const msg = event.data
  const { requestId, geoId } = msg

  try {
    // Lazy singleton -- the 11.6 MB kernel loads only on first STEP import.
    const oc = await loadOcctModel()

    if (msg.type === 'READ_STEP') {
      const onPhase = (phase: ModelPhase) => {
        post({ type: 'MODEL_PROGRESS', requestId, phase })
      }

      const { payload, shape } = buildModelPayload(
        oc,
        msg.bytes,
        msg.fileName,
        // TessellateOptions ({ linearDeflection?, angularDeflection? }); undefined
        // when the client did not pass a fidelity (back-compat: core.ts defaults).
        msg.tessellation,
        onPhase,
      )

      const previous = shapeRegistry.get(geoId)
      if (previous) previous.delete()
      shapeRegistry.set(geoId, shape)

      const ready: ModelResponseMsg = { type: 'MODEL_READY', requestId, geoId, payload }
      // Buffers are fresh JS-heap arrays built in core.ts (never wasm-heap views),
      // so transferring them is safe and zero-copy.
      post(ready, [
        payload.mesh.positions.buffer,
        payload.mesh.normals.buffer,
        payload.mesh.indices.buffer,
        payload.mesh.faceRanges.buffer,
        payload.edges.positions.buffer,
        payload.edges.edgeRanges.buffer,
        payload.faceTypes.buffer,
      ])
      return
    }

    // ---- Stage 3 derivation requests (operate on the resident shape, D2) ----
    if (
      msg.type === 'DERIVE_FACE_LOOPS' ||
      msg.type === 'DERIVE_EDGE_LOOPS' ||
      msg.type === 'DERIVE_HOLES' ||
      msg.type === 'DERIVE_CYLINDERS' ||
      msg.type === 'DERIVE_PRISMATIC_ROUGH_TARGET' ||
      msg.type === 'DERIVE_SECTION'
    ) {
      const shape = shapeRegistry.get(geoId)
      if (!shape) {
        // The client recovers from this by re-running READ_STEP with the bytes
        // cached in stepCache (the worker never touches IndexedDB itself).
        const e = new Error(
          `B-rep shape for geometry ${geoId} is not resident in the model worker ` +
            `(e.g. after a page reload); re-send READ_STEP with the cached STEP bytes`,
        )
        ;(e as Error & { where: string }).where = 'shape-not-resident'
        throw e
      }
      switch (msg.type) {
        case 'DERIVE_FACE_LOOPS':
          post({
            type: 'DERIVED_FACE_LOOPS',
            requestId,
            geoId,
            result: planarFaceLoops(oc, shape, msg.faceIndex),
          })
          return
        case 'DERIVE_EDGE_LOOPS':
          post({
            type: 'DERIVED_EDGE_LOOPS',
            requestId,
            geoId,
            result: edgeChainLoops(oc, shape, msg.edgeIndices),
          })
          return
        case 'DERIVE_HOLES':
          post({ type: 'DERIVED_HOLES', requestId, geoId, holes: holeFeatures(oc, shape) })
          return
        case 'DERIVE_CYLINDERS':
          post({
            type: 'DERIVED_CYLINDERS',
            requestId,
            geoId,
            cylinders: cylinderFeatures(oc, shape, { faceIndices: msg.faceIndices }),
          })
          return
        case 'DERIVE_PRISMATIC_ROUGH_TARGET':
          post({
            type: 'DERIVED_PRISMATIC_ROUGH_TARGET',
            requestId,
            geoId,
            facts: prismaticRoughTargetFacts(oc, shape),
          })
          return
        case 'DERIVE_SECTION':
          post({
            type: 'DERIVED_SECTION',
            requestId,
            geoId,
            // Arbitrary plane when given; else the legacy horizontal cut at z.
            result: msg.plane
              ? sectionAtPlane(oc, shape, msg.plane)
              : sectionAtZ(oc, shape, msg.z),
          })
          return
      }
    }

    const e = new Error(
      `Unknown model worker message type: ${(msg as { type: string }).type}`,
    )
    ;(e as Error & { where: string }).where = 'protocol'
    throw e
  } catch (err) {
    console.error('[modelWorker] error:', err)
    const where =
      err instanceof Error && typeof (err as Error & { where?: unknown }).where === 'string'
        ? (err as Error & { where: string }).where
        : 'model-worker'
    post({
      type: 'MODEL_ERROR',
      requestId,
      geoId,
      where,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
