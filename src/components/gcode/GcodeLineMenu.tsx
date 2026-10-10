// WO-2651 amendment (Operator ruling, 10-06 ~11:00 PM CT): "I'd still like the right-click
// context menu. And we can also use something similar for editing like insert
// line" ... "Cause what I don't wanna do is add more UI elements for editing."
//
// THE RIGHT-CLICK MENU FOR ONE G-CODE LINE - the Control listing's and the
// editor's. It is transient: it opens at the pointer, closes on a choice, on
// Escape or a press outside it, and moves nothing on screen.

import { useEffect, useRef, useState } from 'react'

export interface GcodeLineMenuItem {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Starts a new group under a divider. */
  separated?: boolean
}

export function GcodeLineMenu({
  at,
  title,
  items,
  onClose,
  testId,
  returnFocusTo,
}: {
  at: { x: number; y: number }
  title: string
  items: readonly GcodeLineMenuItem[]
  onClose: () => void
  testId: string
  /** Where keyboard focus goes on Escape / a press outside when nothing held it before the menu opened. */
  returnFocusTo?: () => HTMLElement | null
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  // What held focus when the menu opened (read before the first item takes it).
  const [opener] = useState(() => document.activeElement)

  // Escape or a press outside: close, then give keyboard focus back - to what
  // held it before, else the caller's place (the listing) - so the keyboard
  // carries on where it was. Runs after the browser's own press handling,
  // which would otherwise leave focus on the page body. A chosen item keeps
  // focus where its action puts it (Insert line's field).
  const dismiss = () => {
    onClose()
    setTimeout(() => {
      const back = opener instanceof HTMLElement && opener !== document.body && opener.isConnected
        ? opener : returnFocusTo?.() ?? null
      back?.focus({ preventScroll: true })
    }, 0)
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      dismissRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const menu = menuRef.current
    if (menu) {
      const bounds = menu.getBoundingClientRect()
      if (bounds.right > window.innerWidth) menu.style.left = `${at.x - bounds.width}px`
      if (bounds.bottom > window.innerHeight) menu.style.top = `${at.y - bounds.height}px`
    }
    firstRef.current?.focus()
  }, [at])

  const firstEnabled = items.findIndex((item) => !item.disabled)
  return (
    <>
      <div
        className="sketch-context-overlay"
        onPointerDown={dismiss}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          dismiss()
        }}
      />
      <div
        ref={menuRef}
        className="sketch-context-menu gce-line-menu"
        style={{ left: at.x, top: at.y }}
        role="menu"
        aria-label={title}
        data-testid={testId}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div className="sketch-context-label">{title}</div>
        {items.map((item, index) => (
          <div key={item.id} style={{ display: 'contents' }}>
            {item.separated && index > 0 && <div className="sketch-context-sep" />}
            <button
              ref={index === firstEnabled ? firstRef : undefined}
              className="sketch-context-item"
              role="menuitem"
              data-testid={`${testId}-${item.id}`}
              disabled={item.disabled}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
