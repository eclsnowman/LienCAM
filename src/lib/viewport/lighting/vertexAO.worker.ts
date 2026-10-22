// WO-3044: the exact per-vertex AO bake, off the page thread. One job per worker: the
// page posts a body's position / normal / index arrays, this bakes them with the same
// computeVertexAO the page thread used to call, and posts the AO array back.
import { runAoJob, type AoJob } from './vertexAO.ts'

const scope = self as unknown as {
  onmessage: ((event: { data: AoJob }) => void) | null
  postMessage(message: { ao: Float32Array }, transfer: Transferable[]): void
}

scope.onmessage = (event) => {
  const ao = runAoJob(event.data)
  scope.postMessage({ ao }, [ao.buffer])
}
