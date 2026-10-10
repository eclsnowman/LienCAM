// WO SKC-15C: THE jsdom canvas-2D stub, defined once.
//
// WHY IT EXISTS. `sketchLayer.badgeMaterial` paints a rounded chip onto a `<canvas>` 2D context for
// every CONSTRAINT BADGE it renders. jsdom's `<canvas>` has no 2D context at all -- `getContext('2d')`
// returns `null` -- so the first badge a sketch acquires throws
// `Cannot read properties of null (reading 'beginPath')`, from deep inside SketchLayer.rebuild.
//
// This is an ENVIRONMENT gap, not a defect under test. The badge texture path is CAM-proven, runs in
// every real browser, and has no bearing on whether a pointer event reaches the DAG. It is exercised
// for real -- with real badges, on a real 2D context -- by the Chromium harness
// tools/smoke/skc15-sketcher-evidence.mjs, which is where a genuine badge regression would surface.
// Nothing here can mask one, because nothing here is asserted on.
//
// WHY IT IS SHARED. Before SKC-15C only `workbenchSketchMount.test.ts` needed it: the workbench's
// package session opened on an EMPTY base-plane sketch. Face sketches now open blank too, but page
// tests may explicitly Project / Use fixed geometry or exercise saved sketches with constraints, so
// they still share this environment shim. Six copies of a Proxy this fiddly is how they drift;
// there is one, and it is here.
//
// The stub RESTORES the original prototype method, so a suite that installs it cannot leak a fake
// 2D context into an unrelated file that runs after it in the same worker.

/** Install the stub. Returns the restore function -- call it in `afterEach`. */
export function stubCanvas2d(): () => void {
  const original = HTMLCanvasElement.prototype.getContext
  const noop = (): void => {}
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, prop) => {
      if (prop === 'canvas') return document.createElement('canvas')
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: noop })
      }
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      return noop
    },
    set: () => true,
  })
  HTMLCanvasElement.prototype.getContext =
    ((kind: string) => (kind === '2d' ? ctx : null)) as unknown as typeof HTMLCanvasElement.prototype.getContext
  return () => {
    HTMLCanvasElement.prototype.getContext = original
  }
}

/**
 * `beforeEach`/`afterEach` sugar for a file that needs the stub for its whole lifetime. Kept separate
 * from `stubCanvas2d` so a test that needs to observe the UNSTUBBED failure (there is none today, but
 * the seam should exist) can still reach the raw installer.
 */
export function useStubbedCanvas2d(beforeEach: (fn: () => void) => void, afterEach: (fn: () => void) => void): void {
  let restore: (() => void) | null = null
  beforeEach(() => {
    restore = stubCanvas2d()
  })
  afterEach(() => {
    restore?.()
    restore = null
  })
}
