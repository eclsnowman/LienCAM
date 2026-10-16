import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useEffect, useRef } from 'react'
import { dismissContextMenuOnRightDrag } from '../../lib/viewport/navPresetController'

export type ViewportContextTarget =
  | { kind: 'part'; id: string; label: string }
  | { kind: 'stock'; id: string; label: string }
  | { kind: 'empty' }

export type ViewportContextAction =
  | 'open-properties'
  | 'hide-part'
  | 'clear-selection'
  | 'fit-all'
  | 'view-iso'
  | 'view-top'
  | 'toggle-stock'
  | 'toggle-workpiece'
  | 'toggle-toolpath'
  | 'toggle-grid'

interface MenuItem {
  id: string
  label: string
  action?: ViewportContextAction
  separatorBefore?: boolean
}

export function buildViewportContextMenu(
  target: ViewportContextTarget,
  visibility: {
    stock: boolean
    workpiece: boolean
    toolpath: boolean
    grid: boolean
  },
): MenuItem[] {
  const items: MenuItem[] = []

  if (target.kind !== 'empty') {
    items.push(
      { id: 'target', label: tx('ViewportContextMenu.symbol', { p1: target.kind === 'part' ? tx('ViewportContextMenu.Part') : tx('ViewportContextMenu.Stock'), p2: target.label }) },
      { id: 'open-properties', get label() { return tx('ViewportContextMenu.Open_Properties') }, action: 'open-properties' },
    )
    if (target.kind === 'part') {
      items.push({ id: 'hide-part', get label() { return tx('ViewportContextMenu.Hide_part') }, action: 'hide-part' })
    }
    items.push({ id: 'clear-selection', get label() { return tx('ViewportContextMenu.Clear_selection') }, action: 'clear-selection' })
  }

  items.push(
    { id: 'fit-all', get label() { return tx('ViewportContextMenu.Fit_all') }, action: 'fit-all', separatorBefore: items.length > 0 },
    { id: 'view-iso', get label() { return tx('ViewportContextMenu.Isometric_view') }, action: 'view-iso' },
    { id: 'view-top', get label() { return tx('ViewportContextMenu.Top_view') }, action: 'view-top' },
    {
      id: 'toggle-stock',
      label: visibility.stock ? tx('ViewportContextMenu.Hide_stock') : tx('ViewportContextMenu.Show_stock'),
      action: 'toggle-stock',
      separatorBefore: true,
    },
    {
      id: 'toggle-workpiece',
      label: visibility.workpiece ? tx('ViewportContextMenu.Hide_parts') : tx('ViewportContextMenu.Show_parts'),
      action: 'toggle-workpiece',
    },
    {
      id: 'toggle-toolpath',
      label: visibility.toolpath ? tx('ViewportContextMenu.Hide_toolpaths') : tx('ViewportContextMenu.Show_toolpaths'),
      action: 'toggle-toolpath',
    },
    {
      id: 'toggle-grid',
      label: visibility.grid ? tx('ViewportContextMenu.Hide_grid') : tx('ViewportContextMenu.Show_grid'),
      action: 'toggle-grid',
    },
  )

  return items
}

interface Props {
  at: { x: number; y: number }
  target: ViewportContextTarget
  visibility: {
    stock: boolean
    workpiece: boolean
    toolpath: boolean
    grid: boolean
  }
  onAction: (action: ViewportContextAction) => void
  onClose: () => void
}

export function ViewportContextMenu({ at, target, visibility, onAction, onClose }: Props) {
  useText('cam-operations-new-operation')
  const menuRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const items = buildViewportContextMenu(target, visibility)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  // Keep the opening gesture's lifetime across ordinary parent rerenders.
  useEffect(() => dismissContextMenuOnRightDrag(at, () => closeRef.current()), [at])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    const menu = menuRef.current
    if (menu) {
      const bounds = menu.getBoundingClientRect()
      if (bounds.right > window.innerWidth) menu.style.left = `${at.x - bounds.width}px`
      if (bounds.bottom > window.innerHeight) menu.style.top = `${at.y - bounds.height}px`
    }
    firstActionRef.current?.focus()
  }, [at])

  let assignedFirstAction = false

  return (
    <>
      <div
        className="sketch-context-overlay"
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="sketch-context-menu"
        style={{ left: at.x, top: at.y }}
        role="menu"
        aria-label={tx('ViewportContextMenu.Viewport_context_menu')}
        data-testid="viewport-context-menu"
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {items.map((item) => {
          const isHeading = item.action === undefined
          const isFirstAction = !isHeading && !assignedFirstAction
          if (isFirstAction) assignedFirstAction = true
          return (
            <div key={item.id}>
              {item.separatorBefore && <div className="sketch-context-sep" />}
              {isHeading ? (
                <div className="sketch-context-label" data-tooltip={item.label}>{item.label}</div>
              ) : (
                <button
                  ref={isFirstAction ? firstActionRef : undefined}
                  className="sketch-context-item"
                  role="menuitem"
                  data-action={item.action}
                  onClick={() => {
                    onAction(item.action!)
                    onClose()
                  }}
                >
                  {item.label}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
