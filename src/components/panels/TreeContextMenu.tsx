import { textFor, useText } from '../../i18n'
import { useEffect, useRef } from 'react'
import {
  buildTreeContextMenu,
  type TreeContextTarget,
  type TreeMenuAction,
} from '../../lib/tree/treeContextMenu'

const shellText = textFor('app-shell-settings-menus')

interface Props {
  /** Menu anchor in CLIENT coordinates (the right-click position). */
  at: { x: number; y: number }
  target: TreeContextTarget
  /** Run the chosen intent through DesignTree's existing store-backed handlers. */
  onAction: (action: TreeMenuAction) => void
  /** WO-2451: opens the Export window on this item's row. Absent -> no Export... entry. */
  onExport?: () => void
  onClose: () => void
}

/**
 * DesignTree right-click context menu (Phase 7, P12 / 7.2). Renders the pure
 * buildTreeContextMenu model and dispatches each item through DesignTree's
 * existing handlers (the SAME store actions the hover-row buttons use). Reuses
 * the sketch context-menu CSS classes (.sketch-context-*). Closes on item
 * click, outside click, or Esc; the overlay swallows the click; the menu flips
 * to stay on-screen. Focus moves to the first item so the ring is reachable.
 */
export function TreeContextMenu({ at, target, onAction, onExport, onClose }: Props) {
  useText('app-shell-settings-menus')
  const menuRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  // Esc closes the menu (capture phase so it runs before any tree key handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Keep the menu inside the window (flip up/left when it would clip) and move
  // focus to the first item so keyboard users get a visible focus ring.
  useEffect(() => {
    const el = menuRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.right > window.innerWidth) el.style.left = `${at.x - r.width}px`
      if (r.bottom > window.innerHeight) el.style.top = `${at.y - r.height}px`
    }
    firstItemRef.current?.focus()
  }, [at])

  const items = buildTreeContextMenu(target)

  // WO-2451: Export... sits just above a trailing danger item (Delete), else last.
  const exportAt = items.length > 0 && items[items.length - 1].danger ? items.length - 1 : items.length

  const handle = (action: TreeMenuAction, disabled?: boolean) => {
    if (disabled) return
    onAction(action)
    onClose()
  }

  return (
    <>
      <div
        className="sketch-context-overlay"
        onPointerDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        ref={menuRef}
        className="sketch-context-menu"
        style={{ left: at.x, top: at.y }}
        role="menu"
        aria-label={shellText('TreeContextMenu.treeItemContextMenu')}
        data-testid="tree-context-menu"
      >
        {items.map((item, idx) => (
          <div key={item.id}>
            {onExport && idx === exportAt && (
              <button
                className="sketch-context-item"
                role="menuitem"
                data-action="export"
                onClick={() => { onExport(); onClose() }}
              >{shellText('TreeContextMenu.export')}</button>
            )}
            {item.separatorBefore && <div className="sketch-context-sep" />}
            <button
              ref={idx === 0 ? firstItemRef : undefined}
              className={`sketch-context-item${item.danger ? ' sketch-context-item-danger' : ''}`}
              role="menuitem"
              data-action={item.action}
              disabled={item.disabled}
              onClick={() => handle(item.action, item.disabled)}
            >
              {menuLabel(item.label)}
            </button>
          </div>
        ))}
        {onExport && exportAt === items.length && (
          <button
            className="sketch-context-item"
            role="menuitem"
            data-action="export"
            onClick={() => { onExport(); onClose() }}
          >{shellText('TreeContextMenu.export')}</button>
        )}
      </div>
    </>
  )
}

// The display model keeps English identifiers; the rendering boundary owns words.
function menuLabel(value: string): string {
  switch(value) {
    case "Edit operation": return shellText('TreeMenuLabels.editOperation')
    case "Regenerate": return shellText('TreeMenuLabels.regenerate')
    case "Suppress": return shellText('TreeMenuLabels.suppress')
    case "Unsuppress": return shellText('TreeMenuLabels.unsuppress')
    case "Duplicate": return shellText('TreeMenuLabels.duplicate')
    case "Rename": return shellText('TreeMenuLabels.rename')
    case "Move up": return shellText('TreeMenuLabels.moveUp')
    case "Move down": return shellText('TreeMenuLabels.moveDown')
    case "Delete": return shellText('TreeMenuLabels.delete')
    case "Edit setup": return shellText('TreeMenuLabels.editSetup')
    case "Add operation": return shellText('TreeMenuLabels.addOperation')
    case "Edit boolean...": return shellText('TreeMenuLabels.editBoolean')
    case "Edit as model": return shellText('TreeMenuLabels.editAsModel')
    case "Choose body split...": return shellText('TreeMenuLabels.chooseBodySplit')
    case "Boolean with model body...": return shellText('TreeMenuLabels.booleanWithModelBody')
    case "Edit model": return shellText('TreeMenuLabels.editModel')
    case "Rename model...": return shellText('TreeMenuLabels.renameModel')
    case "Delete model": return shellText('TreeMenuLabels.deleteModel')
    case "Show": return shellText('TreeMenuLabels.show')
    case "Hide": return shellText('TreeMenuLabels.hide')
    case "Edit sketch": return shellText('TreeMenuLabels.editSketch')
    case "Convert to model...": return shellText('TreeMenuLabels.convertToModel')
    case "Unlock": return shellText('TreeMenuLabels.unlock')
    case "Lock": return shellText('TreeMenuLabels.lock')
    case "Exit gizmo": return shellText('TreeMenuLabels.exitGizmo')
    case "Move with gizmo": return shellText('TreeMenuLabels.moveWithGizmo')
    case "enabled": return shellText('TreeMenuLabels.enabled')
    case "Suppress all": return shellText('TreeMenuLabels.suppressAll')
    case "Enable all": return shellText('TreeMenuLabels.enableAll')
    case "Edit nest": return shellText('TreeMenuLabels.editNest')
    case "Recompute": return shellText('TreeMenuLabels.recompute')
    case "Explode": return shellText('TreeMenuLabels.explode')
    default: return value
  }
}
