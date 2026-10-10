// WO SKC-14B: the React read path onto the package's tool state.
//
// This is the "store-free reactive port" the WO asks for: `useSyncExternalStore` over the
// subscribe/getState pair in ./toolStore.ts. It replaces `useCamStore(s => s.sketchTool)` and its
// eight siblings for every consumer -- the toolbox, the prompt bar, the confirm overlay, the
// context menu and the package's own overlays.
//
// CONTRACT: the selector must return a value that is reference-stable when nothing changed --
// a primitive, or an object the store itself holds (`chain`, `wakeRefs`). Returning a fresh object
// literal (`s => ({ tool: s.tool })`) would make `getSnapshot` unstable and React would loop.
// Select the fields separately instead; the store only notifies on a real change, so extra
// selectors are cheap.
import { useSyncExternalStore } from 'react'
import { sketcherToolStore, type SketcherToolState } from './toolStore'

export function useSketcherTool<T>(selector: (state: SketcherToolState) => T): T {
  return useSyncExternalStore(
    sketcherToolStore.subscribe,
    () => selector(sketcherToolStore.getState()),
    () => selector(sketcherToolStore.getState()),
  )
}
