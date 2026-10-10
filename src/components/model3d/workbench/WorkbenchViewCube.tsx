// WO UI-17 (criterion 6): the CAM ViewCube, mounted in the workbench.
//
// The cube component itself is imported, not copied: one cube, one look, both
// surfaces. It constructs the SAME THREE.WebGLRenderer site both surfaces use
// (ViewCube.tsx:58) -- this wrapper is NOT a fifth renderer constructor site,
// which is why the D1.1 context budget counts co-mounted INSTANCES, not sites
// (spec 1.3).
//
// WO INT-13B (D1.3): this wrapper no longer publishes, acquires, or reads
// window.__cncViewport AT ALL. It used to republish a SceneRuntime-backed bridge
// under that global name, because the workbench route mounted INSTEAD of the CAM
// app (mountLab3DPage.ts) and the slot was therefore unowned. UI-17-R1's audit
// then made acquisition conditional -- refusing an occupied slot and rendering
// NOTHING -- to stop the workbench clobbering CAM's bridge.
//
// INT-13's D1 co-mounts both workspaces, which retires that whole mechanism:
//   - the refusal branch would fire in production (CAM publishes the slot
//     unconditionally at Viewport.tsx:844), so the Part cube would render null
//     forever -- the bug D1.3 exists to fix;
//   - and un-refusing it would reintroduce exactly the UI-17-R1 clobber.
// A global cannot express "each cube drives ITS OWN workspace's camera", so the
// cube takes its camera API as a prop instead (see ViewCube.tsx's own doc on
// ViewCubeCameraApi for why a prop beats a workspace-keyed registry).
//
// The GLOBAL ITSELF SURVIVES, untouched, still published by CAM for its twelve
// non-cube CAM consumers (spec 1.3 blast-radius census) -- this file simply has
// nothing to do with it. workbenchViewCubeGlobalUntouched.int13b.test.tsx pins
// that as a can-fail regression: the workbench touches window.__cncViewport zero
// times, mount and unmount.
//
// POINTER-OWNERSHIP NOTE: the cube's own onMouseMove/onClick bindings live in
// src/components/viewport/ViewCube.tsx, OUTSIDE the severing target that
// oneWorkbenchSketchPointerOwner.test.ts net (d) scans -- this wrapper binds
// no pointer events at all.

import { useMemo } from 'react'
import { ViewCube, type ViewCubeCameraApi } from '../../viewport/ViewCube'
import type { SceneRuntime } from '../sceneRuntime'

/** WO INT-13B (D1.3): the workbench's half of the cube's camera contract -- the
 *  same two members the old window bridge carried, now handed over directly.
 *  Exported as a named function so the wiring is assertable headlessly: jsdom has
 *  no WebGL, so the cube itself cannot mount there to be interrogated through the
 *  DOM (see webglAvailable below).
 *
 *  Reads runtime.camera at CALL time, never at build time: SceneRuntime rebuilds
 *  its camera object outright when the projection swaps (sceneRuntime.ts's
 *  setCameraProjection -- a PerspectiveCamera and an OrthographicCamera are
 *  different subclasses, there is no in-place conversion), so a captured
 *  reference would silently pin the cube to the DEAD pre-swap camera. */
export function workbenchCubeCameraApi(runtime: SceneRuntime): ViewCubeCameraApi {
  return {
    getCamera: () => runtime.camera,
    setCameraView: (view) => runtime.setCameraView(view),
  }
}

/** ViewCube constructs its own THREE.WebGLRenderer inside a mount effect --
 *  in an environment with no WebGL context (jsdom; the page's own runtime is
 *  injected there precisely so nothing else constructs one) that throw would
 *  take the whole page down. Probe once per mount: no WebGL, no cube.
 *
 *  WO INT-13B: the probe now RELEASES the context it just acquired.
 *
 *  Asking for a context is not free -- it allocates a real one against the
 *  browser's global cap, and this probe's canvas is never attached to the DOM, so
 *  nothing was ever going to reclaim it. That cost nothing when the workbench was
 *  a standalone route probed once per page load. Under D1 the cube mounts on
 *  EVERY entry into the 3D modeling workspace, so each entry silently burned another context
 *  from the very four-context budget D1.1 sets -- a leak that existed only in the
 *  co-mounted world this stage creates.
 *
 *  Measured, not theorised: the B1 hardware census read 3, 3, 4, 4 live contexts
 *  across the round trip, and the surplus tracked Part entries exactly -- one
 *  orphaned probe apiece. jsdom could never have shown this (it has no WebGL to
 *  leak), which is why the WO puts B1 on a real GPU. */
function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    if (gl === null) return false
    // Hand it straight back: we asked a yes/no question, not for a renderer.
    ;(gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

export interface WorkbenchViewCubeProps {
  runtime: SceneRuntime
}

export function WorkbenchViewCube({ runtime }: WorkbenchViewCubeProps) {
  const canRenderCube = useMemo(() => webglAvailable(), [])
  // Rebuilt only when the runtime identity changes, so ViewCube's mount effect
  // (and its WebGL context) is never churned by an unrelated re-render.
  const camera = useMemo(() => workbenchCubeCameraApi(runtime), [runtime])

  // INT-13B (spec 3.2 step 6): there is deliberately no `suspended` prop here.
  // The SUSPENDED workspace's cube must DISPOSE its WebGL context, and the only
  // honest way to dispose it is to unmount the component that owns it -- so the
  // host simply stops rendering <WorkbenchViewCube> while suspended and
  // ViewCube's own mount-effect cleanup (cancelAnimationFrame + renderer.dispose)
  // does the rest. A `suspended` prop that merely paused the rAF loop would leave
  // the context LIVE and quietly blow the D1.1 budget the B1 gate measures.
  return canRenderCube ? <ViewCube camera={camera} /> : null
}
