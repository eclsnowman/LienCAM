import { type ReactNode, type RefObject } from 'react'

/**
 * The viewport root surface that owns the MODEL-mode context-menu gesture
 * (UI-40 context actions on parts/stocks). Deliberately a separate module
 * from Viewport.tsx: the one-sketch-pointer-owner census (SKC-14) treats a
 * JSX pointer handler co-located with sketch gesture plumbing as a second
 * sketch owner. This handler is NOT one - its callback bails outside normal
 * model interaction (and always in sketch mode) - and living here keeps that
 * provable: this file must never import or reference sketch gesture state.
 */
export function ViewportContextMenuSurface({
  rootRef,
  onOpenMenu,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>
  onOpenMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  children: ReactNode
}) {
  return (
    <div className="viewport-root" ref={rootRef} onContextMenu={onOpenMenu}>
      {children}
    </div>
  )
}
