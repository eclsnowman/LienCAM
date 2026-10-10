import { textFor, useText } from '../../i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Maximize2, X } from 'lucide-react'

const shellText = textFor('app-shell-settings-menus')

interface HelpFigureProps {
  src: string
  alt: string
}

const LIGHTBOX_MIN_ZOOM = 1
const LIGHTBOX_MAX_ZOOM = 3
const LIGHTBOX_ZOOM_STEP = 0.25

export function HelpFigure({ src, alt }: HelpFigureProps) {
  useText('app-shell-settings-menus')
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState(LIGHTBOX_MIN_ZOOM)
  const triggerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const openLightbox = useCallback(() => {
    setZoom(LIGHTBOX_MIN_ZOOM)
    setOpen(true)
  }, [])
  const closeLightbox = useCallback(() => {
    setZoom(LIGHTBOX_MIN_ZOOM)
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return

    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      closeLightbox()
    }

    // Capture Escape before the window-level handlers used by app modals and
    // viewport tools so this temporary top layer is the only thing dismissed.
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [closeLightbox, open])

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openLightbox()
  }

  return (
    <>
      <figure
        ref={triggerRef}
        className="help-figure"
        role="button"
        tabIndex={0}
        aria-label={shellText('HelpFigure.enlarge', { alt: alt })}
        onClick={openLightbox}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="help-figure-media">
          <img src={src} alt={alt} loading="lazy" />
          <span className="help-figure-expand" aria-hidden="true">
            <Maximize2 size={16} />
          </span>
        </span>
        <figcaption>{alt}</figcaption>
      </figure>

      {open && (
        <div
          className="help-image-lightbox"
          data-testid="help-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeLightbox()
          }}
          onWheel={(event) => {
            // The enlarged image owns the wheel while this modal top layer is
            // open. Fixed steps keep zoom predictable and never leak a wheel
            // gesture through to the page behind the lightbox.
            event.preventDefault()
            event.stopPropagation()
            const direction = Math.sign(event.deltaY)
            if (direction === 0) return
            setZoom((current) => Math.min(
              LIGHTBOX_MAX_ZOOM,
              Math.max(LIGHTBOX_MIN_ZOOM, current - direction * LIGHTBOX_ZOOM_STEP),
            ))
          }}
        >
          <button
            ref={closeButtonRef}
            type="button"
            className="help-image-lightbox-close"
            data-testid="help-image-lightbox-close"
            aria-label={shellText('HelpFigure.closeEnlargedImage')}
            onClick={closeLightbox}
          >
            <X size={24} />
          </button>
          <figure className="help-image-lightbox-content">
            <img
              className="help-image-lightbox-image"
              data-testid="help-image-lightbox-image"
              data-zoom={zoom.toFixed(2)}
              src={src}
              alt={alt}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            />
            <figcaption>{alt}</figcaption>
          </figure>
        </div>
      )}
    </>
  )
}
