// WO SKC-14C: the context-menu ANCHOR, owned by the component package.
//
// `SketchMenuPort` (../ports.ts) has always said the right thing -- "the component decides WHEN a
// menu is requested and WHERE; the host renders it" -- but until this WO the host also held the
// anchor, in a `useState` in Viewport.tsx, and rendered `<SketchContextMenu at={...}/>` itself.
// That is the last scrap of sketch PRESENTATION state on a mount, and it is what stopped
// `<SketcherOverlays/>` from rendering all eight overlays from one prop.
//
// So the anchor moves here. A mount now wires the port and nothing else:
//
//     vp.setSketchMenuPort(sketcherMenuPort)      // one line, no state
//
// and `<SketcherOverlays/>` renders the menu when this store says there is one. The interaction
// layer's calls (`open` on a right-click that was not a pan, `close` on session exit / item pick)
// are unchanged -- they now land on package state instead of a host setter.
//
// MODULE SINGLETON, for the same reason as ../toolStore.ts: an open menu is a global UI mode, and a
// singleton keeps the critic's law intact (exactly one file in which a second version of "is a
// sketch menu open, and where" could be written). Two Sketchers cannot hold a live session at once.
//
// NAMING NOTE (load-bearing): the anchor field is `menuAt`, not `sketchMenuAt`. The latter is a
// BANNED_POINTER_STATE identifier and a SKETCH_GESTURE token in
// src/tests/sketch/oneSketchPointerOwner.test.ts -- and rule (a) of that scan does NOT exempt this
// package. SketchContextMenu.tsx carries a JSX `onPointerDown` (its click-away backdrop), so a
// gesture token anywhere in that file would make it a second sketch pointer owner and turn the scan
// red. The name is part of the guard.
import type { SketchMenuPort } from '../ports'

/** Menu anchor in CLIENT coordinates (the right-click position), or null when closed. */
export interface SketcherMenuState {
  menuAt: { x: number; y: number } | null
}

type Listener = () => void

/** The same hand-rolled `useSyncExternalStore` pair as ../toolStore.ts -- no state-management
 *  dependency enters the package. */
class SketcherMenuStore {
  private state: SketcherMenuState = { menuAt: null }
  private readonly listeners = new Set<Listener>()

  getState = (): SketcherMenuState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(menuAt: { x: number; y: number } | null): void {
    if (this.state.menuAt === menuAt) return
    this.state = { menuAt }
    for (const listener of [...this.listeners]) listener()
  }

  open = (clientX: number, clientY: number): void => {
    this.set({ x: clientX, y: clientY })
  }

  /** Idempotent: closing a closed menu notifies nobody (the `null === null` gate above). The
   *  interaction layer calls this on session exit whether or not a menu was open. */
  close = (): void => {
    this.set(null)
  }

  /** Test seam ONLY. */
  __reset = (): void => {
    this.state = { menuAt: null }
    for (const listener of [...this.listeners]) listener()
  }
}

/** THE sketch context-menu anchor. One per process, by design (see the header). */
export const sketcherMenuStore = new SketcherMenuStore()

/**
 * The `SketchMenuPort` a mount hands to `Sketcher.setMenuPort()` / `CNCViewport.setSketchMenuPort()`.
 * It is the package's own store, so the mount is wiring the component to itself: the only reason
 * the port still exists as an interface is that the interaction layer must not import this module
 * (it is React-adjacent), and a workbench may one day want to render the menu somewhere else.
 */
export const sketcherMenuPort: SketchMenuPort = {
  open: sketcherMenuStore.open,
  close: sketcherMenuStore.close,
}
