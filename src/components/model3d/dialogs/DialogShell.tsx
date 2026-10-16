// WO UI-3: reusable property-dialog shell -- open/apply/cancel, matching the
// 2D app's EXISTING modal idiom byte-for-byte (reuses the global .modal-*
// classes from src/styles/app.css: .modal-backdrop/.modal-container/
// .modal-header/.modal-title/.modal-close-btn/.modal-body/.modal-footer/
// .modal-btn-primary/.modal-btn-ghost -- read-only reference, never edited by
// this WO). Any feature dialog (M4's future extrude/revolve, this WO's demo
// BoxSizeDialog) mounts its fields as children and gets open/apply/cancel
// chrome + keyboard (Escape = cancel, safe Enter = apply) for free.
//
// The live-preview SEAM lives one level up (in the field-editing dialog, e.g.
// BoxSizeDialog): DialogShell itself is presentation-only, no preview state.

import { useText, textFor } from '../../../i18n'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

const ENTER_APPLY_INPUT_TYPES = new Set([
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
])

function isSafeEnterApplyTarget(target: EventTarget | null, panel: HTMLDivElement | null): boolean {
  if (!(target instanceof Element) || panel === null || !panel.contains(target)) return false

  if (target.closest('textarea, [aria-multiline="true"]') !== null) return false

  const contentEditable = target.closest('[contenteditable]')
  if (contentEditable !== null && contentEditable.getAttribute('contenteditable') !== 'false') return false

  if (
    target.closest(
      'button, select, option, a[href], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="combobox"], [role="listbox"]',
    ) !== null
  ) {
    return false
  }

  const input = target.closest('input')
  return input === null || ENTER_APPLY_INPUT_TYPES.has(input.type)
}

export interface DialogShellProps {
  title: string
  icon?: React.ReactNode
  onApply(): void
  onCancel(): void
  applyLabel?: string
  cancelLabel?: string
  applyDisabled?: boolean
  allowViewportInteraction?: boolean
  /** Compact non-blocking property palette. The header drags the palette while
   * the transparent backdrop leaves the modeling viewport interactive. */
  floatingPalette?: boolean
  /** Render a floating palette without any full-screen wrapper. Use for tools
   * whose preview and workspace selection must remain completely unobscured. */
  backdropless?: boolean
  children: React.ReactNode
}

export function DialogShell({
  title,
  icon,
  onApply,
  onCancel,
  applyLabel = textFor('sketch-and-model-workbench')('DialogShell.apply'),
  cancelLabel = textFor('sketch-and-model-workbench')('DialogShell.cancel'),
  applyDisabled = false,
  allowViewportInteraction = false,
  floatingPalette = false,
  backdropless = false,
  children,
}: DialogShellProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const [palettePosition, setPalettePosition] = useState(() => ({
    x: Math.max(12, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 356),
    y: 72,
  }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()

      if (
        e.key !== 'Enter'
        || applyDisabled
        || e.defaultPrevented
        || e.isComposing
        || e.keyCode === 229
        || !isSafeEnterApplyTarget(e.target, panelRef.current)
      ) {
        return
      }

      e.preventDefault()
      onApply()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyDisabled, onApply, onCancel])

  useEffect(() => {
    if (!floatingPalette) return
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const bounds = panelRef.current?.getBoundingClientRect()
      const width = bounds?.width ?? 320
      const height = bounds?.height ?? 240
      setPalettePosition({
        x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.offsetX)),
        y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.offsetY)),
      })
    }
    const onUp = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [floatingPalette])

  const beginPaletteDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!floatingPalette || (event.target as HTMLElement).closest('button') !== null) return
    const bounds = panelRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    event.preventDefault()
  }

  const panel = (
    <div
      ref={panelRef}
      className="modal-container"
      data-testid="dialog-shell"
      data-presentation={floatingPalette ? 'floating-palette' : 'modal'}
      data-ui78-sanctioned={backdropless ? '' : undefined}
      style={floatingPalette
        ? {
            width: 320,
            maxHeight: 'calc(100vh - 24px)',
            position: 'fixed',
            left: palettePosition.x,
            top: palettePosition.y,
            margin: 0,
            ...(backdropless ? { zIndex: 500 } : {}),
          }
        : { width: 320 }}
    >
      <div
        className="modal-header"
        onPointerDown={beginPaletteDrag}
        style={floatingPalette ? { cursor: 'move', touchAction: 'none', userSelect: 'none' } : undefined}
      >
        {icon && <span className="modal-header-icon">{icon}</span>}
        <span className="modal-title">{title}</span>
        <button
          type="button"
          className="modal-close-btn"
          aria-label={workbenchText('DialogShell.cancel')}
          data-testid="dialog-shell-close"
          onClick={onCancel}
        >
          <X size={14} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      <div className="modal-footer">
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="dialog-shell-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          data-testid="dialog-shell-apply"
          disabled={applyDisabled}
          onClick={onApply}
        >
          {applyLabel}
        </button>
      </div>
    </div>
  )

  if (floatingPalette && backdropless) return panel

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- the
    // SHARED workbench dialog shell's own MODAL-GOVERNED scrim (covers every
    // workbench dialog that mounts through this shell unless it explicitly
    // opts into the backdropless in-workspace palette above).
    <div
      className={`modal-backdrop${allowViewportInteraction || floatingPalette ? ' modal-backdrop-transparent' : ''}`}
      data-testid="dialog-shell-backdrop"
      data-ui78-sanctioned=""
    >
      {panel}
    </div>
  )
}
