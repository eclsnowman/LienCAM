// WO-2173: the depth worker's entry. All model work - download, session, every pass, the merge - runs here,
// never on the app's main thread. Messages:
//   in : { type: 'estimate', id, image, options }   { type: 'dispose', id }
//   out: { type: 'progress', id, progress }   { type: 'result', id, result }   { type: 'error', id, message }
import { createDepthEngine, type EngineDeps } from './engine'
import type { DepthImage, DepthOptions, DepthProgress, DepthResult } from './types'

export type WorkerRequest =
  | { type: 'estimate'; id: number; image: DepthImage; options?: DepthOptions }
  | { type: 'dispose'; id: number }

export type WorkerReply =
  | { type: 'progress'; id: number; progress: DepthProgress }
  | { type: 'result'; id: number; result: DepthResult }
  | { type: 'error'; id: number; message: string }
  | { type: 'disposed'; id: number }

export interface WorkerScopeLike {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void
  onmessage: ((event: { data: WorkerRequest }) => void) | null
}

/** Wires the engine to a worker scope. The module calls this on its own scope when it runs as a worker;
 *  tests call it on a stand-in scope, so they drive exactly this message handling. */
export function attachReliefDepthWorker(scope: WorkerScopeLike, deps?: Partial<EngineDeps>): void {
  const engine = createDepthEngine(deps)
  // One job at a time: the model and its GPU memory are shared, so requests queue in arrival order.
  let queue: Promise<void> = Promise.resolve()
  scope.onmessage = event => {
    const msg = event.data
    queue = queue.then(async () => {
      try {
        if (msg.type === 'dispose') {
          await engine.dispose()
          scope.postMessage({ type: 'disposed', id: msg.id })
          return
        }
        const result = await engine.estimate(msg.image, msg.options, progress => scope.postMessage({ type: 'progress', id: msg.id, progress }))
        scope.postMessage({ type: 'result', id: msg.id, result }, [result.heights.buffer as ArrayBuffer])
      } catch (e) {
        scope.postMessage({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
      }
    })
  }
}

declare const WorkerGlobalScope: unknown
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  attachReliefDepthWorker(self as unknown as WorkerScopeLike)
}
