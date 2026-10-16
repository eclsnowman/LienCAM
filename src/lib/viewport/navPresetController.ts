// Shared nav-preset -> OrbitControls application engine (BK-26 "one coherent
// feel": every OrbitControls consumer in the app applies the SAME
// NAV_PRESETS table through this SAME engine, never a forked mapping).
// Extracted from CNCViewport's original applyNavPreset/setNavModifierPreset/
// setInvertZoom/setInvertPan so the main 2D/3D viewport AND the model3d
// sketch scene runtime (WO SKC-5-R1, Finding 1) share byte-identical
// mouseButtons/touches mapping, modifier-aware remap, and invert-zoom/pan
// behavior instead of each viewport growing its own copy.
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  NAV_PRESETS,
  navInvertWheelDeltaY,
  navInvertPanDelta,
  resolveNavAction,
  type NavPresetId,
  type NavButtonAction,
  type NavPreset,
} from '../../types'

// Translate a NavButtonAction to the Three.js OrbitControls mouse enum.
// 'none' -> null leaves the button free for selection/marquee raycasting.
function navActionToMouse(a: NavButtonAction): THREE.MOUSE | null {
  switch (a) {
    case 'orbit': return THREE.MOUSE.ROTATE
    case 'pan':   return THREE.MOUSE.PAN
    case 'zoom':  return THREE.MOUSE.DOLLY
    case 'none':  return null
  }
}

// Pick the base OrbitControls mouse enum so that, after OrbitControls' own
// modifier swap, the NET action equals `desired`.
function navDesiredToBaseMouse(desired: NavButtonAction, orbitSwaps: boolean): THREE.MOUSE | null {
  switch (desired) {
    case 'zoom': return THREE.MOUSE.DOLLY            // never swapped
    case 'none': return null
    case 'orbit':
      return orbitSwaps ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
    case 'pan':
      return orbitSwaps ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN
  }
}

export interface NavPresetController {
  /** Apply a preset + invert toggles to the live controls (mouseButtons/
   *  touches, modifier remap, invert interceptors). Safe to call any time
   *  (runtime remap, no re-instantiation). */
  apply(presetId: NavPresetId, invertZoom: boolean, invertPan: boolean): void
  /** WO-1595 (relocated from CNCViewport, WO-1503): true if the right-button
   *  gesture that started at the last tracked right-button pointerdown moved
   *  past `thresholdSqPx` before `clientX,clientY` -- i.e. it was a pan/orbit
   *  drag, not a plain right-click. Consumes the tracked position either way,
   *  so a later, separate right-click is judged on its own gesture. Deciding
   *  what the right button means is a navigation call, which is why it lives
   *  here rather than in the viewport that merely asks. */
  consumeRightButtonWasDrag(clientX: number, clientY: number, thresholdSqPx: number): boolean
  /** Remove all installed listeners / monkey-patches, restoring default
   *  OrbitControls behavior. Call once from the owning viewport's dispose(). */
  dispose(): void
}

export interface NavPresetControllerOptions {
  /** Opt into three.js's native wheel-dolly anchor. Kept runtime-scoped rather
   *  than embedded in NAV_PRESETS until Operator decides whether it is taste or a
   *  universal navigation rule. */
  zoomToCursor?: boolean
}

/** WO-2728: press-order browsers open the menu before the right-drag starts.
 * Observe that opening gesture without intercepting OrbitControls' events.
 * Window capture also sees movement retargeted to the menu/overlay or captured
 * by the canvas. A release/cancel/new press ends this gesture permanently. */
export function dismissContextMenuOnRightDrag(
  at: { x: number; y: number },
  onDismiss: () => void,
): () => void {
  const stop = () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', stop, true)
    window.removeEventListener('pointercancel', stop, true)
    window.removeEventListener('pointerdown', stop, true)
    window.removeEventListener('blur', stop)
  }
  const onMove = (event: PointerEvent) => {
    if ((event.buttons & 2) === 0) { stop(); return }
    const dx = event.clientX - at.x
    const dy = event.clientY - at.y
    if (dx * dx + dy * dy > 10 * 10) {
      stop()
      onDismiss()
    }
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', stop, true)
  window.addEventListener('pointercancel', stop, true)
  window.addEventListener('pointerdown', stop, true)
  window.addEventListener('blur', stop)
  return stop
}

/** Build a controller bound to one OrbitControls + its DOM element. Every
 *  consumer (CNCViewport's main 2D/3D viewport, model3d's sketch scene
 *  runtime) constructs its own controller instance per-controls, but every
 *  instance runs the exact same NAV_PRESETS table + remap/invert logic --
 *  the "do not fork a second mapping table" requirement. Runtime-scoped
 *  options may enable a native OrbitControls capability without forking that
 *  preset or event-transform logic. */
export function createNavPresetController(
  controls: OrbitControls,
  domElement: HTMLElement,
  options: NavPresetControllerOptions = {},
): NavPresetController {
  const originalZoomToCursor = controls.zoomToCursor
  controls.zoomToCursor = options.zoomToCursor ?? false
  let navModifierPreset: NavPreset | null = null
  let navInvertZoom = false
  let navInvertPan = false
  let navOrigPan: ((deltaX: number, deltaY: number) => void) | null = null

  // --- Right-button gesture tracking (WO-1595, relocated from CNCViewport) ---
  // The browser fires its native 'contextmenu' event on right-button release
  // regardless of how far the pointer moved first, so a right-drag pan (the
  // default right-button-pans scheme) would otherwise always pop a context
  // menu too. Track the press position on every button===2 pointerdown, always
  // -- independent of which preset or modifier rules are active -- so any
  // consumer can ask whether the gesture that just ended was a drag.
  let rightButtonDownPos: { x: number; y: number } | null = null
  const handleRightButtonPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) {
      rightButtonDownPos = { x: event.clientX, y: event.clientY }
    }
  }
  domElement.addEventListener('pointerdown', handleRightButtonPointerDown)

  // CAPTURE-phase 'pointerdown' handler: runs BEFORE OrbitControls' own
  // bubble-phase pointerdown (OrbitControls reads .mouseButtons at gesture
  // start and latches the action). Computes the DESIRED action from
  // button+modifiers via the pure resolveNavAction, then sets
  // controls.mouseButtons[button] to a BASE value chosen so OrbitControls'
  // OWN modifier swap yields exactly the desired action.
  const handleNavModifierPointerDown = (event: PointerEvent): void => {
    const preset = navModifierPreset
    if (!preset) return
    if (controls.enabled === false) return
    if (event.pointerType === 'touch') return
    const button: 'LEFT' | 'MIDDLE' | 'RIGHT' | null =
      event.button === 0 ? 'LEFT' : event.button === 1 ? 'MIDDLE' : event.button === 2 ? 'RIGHT' : null
    if (!button) return
    const mods = { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey }
    const desired = resolveNavAction(preset, button, mods)
    const orbitSwaps = event.shiftKey || event.ctrlKey || event.metaKey
    const base = navDesiredToBaseMouse(desired, orbitSwaps)
    controls.mouseButtons = {
      ...controls.mouseButtons,
      [button]: base,
    }
  }

  // Install (capture-phase) or remove the modifier remapper. Idempotent; the
  // active preset object is the install flag.
  const setNavModifierPreset = (preset: NavPreset | null): void => {
    const wasActive = navModifierPreset !== null
    const willActive = preset !== null
    navModifierPreset = preset
    if (willActive && !wasActive) {
      domElement.addEventListener('pointerdown', handleNavModifierPointerDown, { capture: true })
    } else if (!willActive && wasActive) {
      domElement.removeEventListener('pointerdown', handleNavModifierPointerDown, { capture: true } as EventListenerOptions)
    }
  }

  // --- Invert-zoom interceptor (wheel) ---
  // OrbitControls registers its own bubble-phase 'wheel' listener and reads
  // event.deltaY; zoomSpeed is magnitude-only, so inversion is layered on via
  // a CAPTURE-phase listener that stops the native event and re-dispatches a
  // synthetic one with negated deltaY. Removing the listener restores exact
  // default behavior.
  const handleInvertWheel = (event: WheelEvent): void => {
    if ((event as WheelEvent & { _navInverted?: boolean })._navInverted) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const synthetic = new WheelEvent('wheel', {
      deltaY: navInvertWheelDeltaY(event.deltaY, true),
      deltaX: event.deltaX,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
      clientY: event.clientY,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
    })
    ;(synthetic as WheelEvent & { _navInverted?: boolean })._navInverted = true
    domElement.dispatchEvent(synthetic)
  }

  const setInvertZoom = (invert: boolean): void => {
    if (invert === navInvertZoom) return
    if (invert) {
      domElement.addEventListener('wheel', handleInvertWheel, { capture: true, passive: false })
    } else {
      domElement.removeEventListener('wheel', handleInvertWheel, { capture: true } as EventListenerOptions)
    }
    navInvertZoom = invert
  }

  // --- Invert-pan interceptor (drag/touch/keyboard pan) ---
  // OrbitControls funnels ALL pan through the private _pan(deltaX, deltaY).
  // Monkey-patch that single method to negate both deltas; restoring the
  // saved original un-inverts cleanly.
  const setInvertPan = (invert: boolean): void => {
    if (invert === navInvertPan) return
    type PanFn = (deltaX: number, deltaY: number) => void
    const c = controls as unknown as { _pan: PanFn }
    if (invert) {
      if (!navOrigPan) navOrigPan = c._pan.bind(controls)
      const orig = navOrigPan
      c._pan = (deltaX: number, deltaY: number) => {
        const d = navInvertPanDelta(deltaX, deltaY, true)
        orig(d.x, d.y)
      }
    } else if (navOrigPan) {
      c._pan = navOrigPan
      navOrigPan = null
    }
    navInvertPan = invert
  }

  return {
    apply: (presetId, invertZoom, invertPan) => {
      const preset = NAV_PRESETS[presetId] ?? NAV_PRESETS['liencnc-default']
      controls.mouseButtons = {
        LEFT:   navActionToMouse(preset.mouseButtons.LEFT),
        MIDDLE: navActionToMouse(preset.mouseButtons.MIDDLE),
        RIGHT:  navActionToMouse(preset.mouseButtons.RIGHT),
      }
      controls.touches = {
        ONE: preset.touches.ONE === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE,
        TWO: preset.touches.TWO === 'dolly-rotate'
          ? THREE.TOUCH.DOLLY_ROTATE
          : THREE.TOUCH.DOLLY_PAN,
      }
      setNavModifierPreset(preset.modifierRules ? preset : null)
      setInvertZoom(invertZoom)
      setInvertPan(invertPan)
    },
    consumeRightButtonWasDrag: (clientX, clientY, thresholdSqPx) => {
      const down = rightButtonDownPos
      rightButtonDownPos = null
      if (!down) return false
      const dx = clientX - down.x
      const dy = clientY - down.y
      return dx * dx + dy * dy > thresholdSqPx
    },
    dispose: () => {
      domElement.removeEventListener('pointerdown', handleRightButtonPointerDown)
      setNavModifierPreset(null)
      setInvertZoom(false)
      setInvertPan(false)
      controls.zoomToCursor = originalZoomToCursor
    },
  }
}
