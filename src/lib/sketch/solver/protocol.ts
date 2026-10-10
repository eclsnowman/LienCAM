// Sketch solver worker protocol — mirrors the toolpathWorker
// request/response pattern (src/lib/cam/types.ts WorkerRequestMsg /
// WorkerResponseMsg). Lives in its own module so the store can import
// message types without pulling worker code into the main bundle.
//
// requestId correlates responses to requests: drag solves are debounced
// and can overlap in flight, and the store must be able to discard a
// stale response that arrives after a newer request was issued.

import type { Sketch, SketchEntity, SolveStatus } from '../types'
import type { DragRequest } from './gcsMapping'

export type SketchWorkerRequestMsg =
  | { type: 'SOLVE_SKETCH'; payload: { requestId: string; sketch: Sketch } }
  | { type: 'DRAG_SOLVE';   payload: { requestId: string; sketch: Sketch; drag: DragRequest } }

export type SketchWorkerResponseMsg =
  // Clean solve: geometry to adopt + the definition status to display.
  | {
      type: 'SKETCH_SOLVE_COMPLETE'
      requestId: string
      entities: SketchEntity[]
      status: SolveStatus
      computeTimeMs: number
    }
  // EXPECTED failures (over-constrained / non-convergent / invalid refs):
  // typed, with the conflicting/redundant sets named by id in `status` —
  // never collapsed into a generic error, never a fake success (ADR 0003).
  // The document's geometry is untouched; the store keeps the last good
  // solve.
  | {
      type: 'SKETCH_SOLVE_FAILED'
      requestId: string
      reason: 'conflicting' | 'solver_failed' | 'invalid_sketch'
      message: string
      status: SolveStatus
    }
  // UNEXPECTED errors (WASM load failure, bugs) — fail loud.
  | { type: 'SKETCH_SOLVE_ERROR'; requestId: string; message: string }
