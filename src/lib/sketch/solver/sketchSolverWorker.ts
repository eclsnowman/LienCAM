// Web Worker — sketch constraint solving.
// Runs planegcs off the UI thread so drag solves never stall rendering,
// and keeps the WASM module dynamically loaded (LGPL boundary, ADR-0016).
// Vite builds this as a module worker via:
//   new Worker(new URL('./sketchSolverWorker.ts', import.meta.url), { type: 'module' })
//
// This file is TRANSPORT ONLY: all mapping/solve logic lives in
// gcsMapping.ts (pure, tested headless against a direct GcsWrapper). If a
// behavior question comes up, the answer is in gcsMapping — not here.

import { createGcsWrapper } from '../../planegcs/planegcsLoader'
import { solveSketchOnWrapper } from './gcsMapping'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { SketchWorkerRequestMsg, SketchWorkerResponseMsg } from './protocol'

console.log('[sketchSolverWorker] module loaded')

// One wrapper per worker, created on first request and reused: WASM
// instantiation is the expensive part, while solveSketchOnWrapper clears
// the constraint network per solve. The worker stays alive across solves
// (unlike the per-compute toolpath worker) because drag emits a stream of
// requests.
let wrapperPromise: Promise<GcsWrapper> | null = null
function ensureWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}

self.onmessage = async (event: MessageEvent<SketchWorkerRequestMsg>) => {
  const msg = event.data
  const { requestId, sketch } = msg.payload
  const t0 = performance.now()

  try {
    const wrapper = await ensureWrapper()

    let outcome
    if (msg.type === 'SOLVE_SKETCH') {
      outcome = solveSketchOnWrapper(wrapper, sketch)
    } else if (msg.type === 'DRAG_SOLVE') {
      outcome = solveSketchOnWrapper(wrapper, sketch, msg.payload.drag)
    } else {
      throw new Error(`Unknown sketch worker message type: ${(msg as { type: string }).type}`)
    }

    const response: SketchWorkerResponseMsg = outcome.ok
      ? {
          type: 'SKETCH_SOLVE_COMPLETE',
          requestId,
          entities: outcome.entities,
          status: outcome.status,
          computeTimeMs: Math.round(performance.now() - t0),
        }
      : {
          type: 'SKETCH_SOLVE_FAILED',
          requestId,
          reason: outcome.reason,
          message: outcome.message,
          status: outcome.status,
        }
    self.postMessage(response)
  } catch (err) {
    console.error('[sketchSolverWorker] error:', err)
    const response: SketchWorkerResponseMsg = {
      type: 'SKETCH_SOLVE_ERROR',
      requestId,
      message: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(response)
  }
}
