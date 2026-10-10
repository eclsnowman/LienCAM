// WO SKC-14C: THE sketch overlay DOM, in one component.
//
// Plan Section 8.2's mount contract says a mount renders NO sketch overlay DOM. Before this WO,
// CAM's Viewport.tsx rendered eight of them by name and held the context-menu anchor in a
// `useState`. Now it renders this:
//
//     <SketcherOverlays port={camOverlayPort} />
//
// ...and the package owns every pixel of sketch chrome. The eight are siblings, not a tree: each
// gates itself on the port's session flag and its own tool/document conditions, exactly as it did
// when it was mounted individually, so the mount order and the DOM order are unchanged. That
// matters -- `.sketch-dim-layer` and the prompt bar are positioned by app.css against the
// `viewport-root` stacking context, and a wrapper element here would change what the user sees.
// Hence a Fragment, not a div.
//
// WHY THE CONTEXT MENU IS DIFFERENT: it is conditional on an ANCHOR (where the user right-clicked),
// which the interaction layer supplies through `SketchMenuPort`. That anchor now lives in the
// package (./menuStore.ts) rather than in a host `useState`, which is what lets this component take
// exactly ONE prop. A mount wires the port once and holds no sketch presentation state at all.
import { useSyncExternalStore } from 'react'
import { sketcherMenuStore } from './menuStore'
import { SketchDimensionOverlay } from './SketchDimensionOverlay'
import { SketchLiveDimsOverlay } from './SketchLiveDimsOverlay'
import { SketchDrawValueInput } from './SketchDrawValueInput'
import { SketchTextInput } from './SketchTextInput'
import { SketchTextAnchorPill } from './SketchTextAnchorPill'
import { SketchPromptBar } from './SketchPromptBar'
import { SketchConfirmOverlay } from './SketchConfirmOverlay'
import { SketchContextMenu } from './SketchContextMenu'
import type { SketcherOverlaysPort } from './port'

/** The package's own reactive read of the context-menu anchor. */
function useMenuAt(): { x: number; y: number } | null {
  return useSyncExternalStore(
    sketcherMenuStore.subscribe,
    () => sketcherMenuStore.getState().menuAt,
    () => sketcherMenuStore.getState().menuAt,
  )
}

/**
 * Every sketch overlay, rendered from one host port.
 *
 * The `port` object MUST be referentially stable for the life of the mount: its members are React
 * hooks, called in render, and a new object every render would defeat the effect dependency arrays
 * that carry it. CAM satisfies that with a module const (`camOverlaysPort`).
 */
export function SketcherOverlays({ port }: { port: SketcherOverlaysPort }) {
  const menuAt = useMenuAt()
  return (
    <>
      <SketchDimensionOverlay port={port} />
      <SketchLiveDimsOverlay port={port} />
      <SketchDrawValueInput port={port} />
      <SketchTextInput port={port} />
      <SketchTextAnchorPill port={port} />
      <SketchPromptBar port={port} />
      <SketchConfirmOverlay port={port} />
      {menuAt && (
        <SketchContextMenu port={port} at={menuAt} onClose={sketcherMenuStore.close} />
      )}
    </>
  )
}
