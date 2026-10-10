// WO-2124: one paint for a burst of scene edits.
//
// The Model runtime paints synchronously on every scene edit (requestRender,
// setSectionableVisible, addObject/removeObject, ...). A loop over every body
// therefore painted the whole model once per body, often twice: an operation
// landing (or failing) on a ten-body history queued ~70 full renders in one
// task. A real GPU hides most of that; a slower one (or a software one) spent
// tens of seconds drawing frames nobody would see while the Model screen gave
// no frame and answered no click.
//
// The runtime already has one render gate with a catch-up paint:
// suspendRender() drops every paint, resumeRender() issues exactly one. This
// holds the gate closed for a SYNCHRONOUS burst and paints once after it. A
// runtime the workspace host has already suspended is left alone: its paints
// are dropped anyway and the host's own resume paints the result.

export interface RenderGate {
  suspendRender(): void
  resumeRender(): void
  isRenderSuspended(): boolean
}

/** Run `burst` (synchronous) with the runtime's paints held, then paint once. */
export function withOneRender<T>(runtime: RenderGate | null | undefined, burst: () => T): T {
  if (runtime === null || runtime === undefined || runtime.isRenderSuspended()) return burst()
  runtime.suspendRender()
  try {
    return burst()
  } finally {
    runtime.resumeRender()
  }
}
