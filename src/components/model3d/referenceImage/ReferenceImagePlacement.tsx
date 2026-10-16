import { useText } from '../../../i18n'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReferenceImagePayload } from '../../../referenceImage/referenceImage'
import { imageContainsPoint, imageCorner, IMAGE_CORNERS, scaleImageCorner, type ImagePlacement } from '../../../referenceImage/place'
import type { ImagePoint } from '../../../referenceImage/calibrate'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import { referenceImagePoint, type ReferenceImageRuntime } from '../../../referenceImage/runtime'
import { localToWorld } from '../../../sketch3d/planeMath'

/** A palette-only gesture: preview outside history, one payload command on release. */
export function ReferenceImagePlacement({ payload, frame, runtime, canvas, onPreview, onCommit, onScalePreview, onScaleCommit }: {
  payload: ReferenceImagePayload; frame: PlaneFrame; runtime: ReferenceImageRuntime; canvas: HTMLCanvasElement
  onPreview(center: ImagePoint | null): void; onCommit(center: ImagePoint): void
  onScalePreview?(placement: ImagePlacement | null): void; onScaleCommit?(placement: ImagePlacement): void
}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const callbacks = useRef({ onPreview, onCommit, onScalePreview, onScaleCommit })
  callbacks.current = { onPreview, onCommit, onScalePreview, onScaleCommit }
  const handles = useRef<(HTMLButtonElement | null)[]>([])
  const begin = useRef<(event: PointerEvent, corner?: ImagePoint) => void>(() => {})
  const source = useRef({ payload, frame })
  source.current = { payload, frame }
  // DAG snapshots are cloned on every read. Preview renders must not retire the held gesture.
  const sourceKey = JSON.stringify([payload.center, payload.widthMm, payload.heightMm, payload.angleDeg,
    payload.flipHorizontal, payload.flipVertical, payload.scaleLocked, frame])
  useEffect(() => {
    const { payload, frame } = source.current
    let drag: { pointerId: number; start: ImagePoint; center: ImagePoint; next: ImagePoint; corner?: ImagePoint; placement?: ImagePlacement } | null = null
    let displayed = payload
    let animation = 0
    const paintHandles = () => {
      const rect = canvas.getBoundingClientRect()
      IMAGE_CORNERS.forEach((corner, i) => {
        const handle = handles.current[i]
        if (!handle) return
        const pixel = runtime.projectToCanvas(localToWorld(frame, imageCorner(displayed, corner)))
        const visible = pixel && pixel.x >= 0 && pixel.y >= 0 && pixel.x <= rect.width && pixel.y <= rect.height
        handle.style.display = visible ? 'block' : 'none'
        if (pixel) { handle.style.left = `${rect.left + pixel.x}px`; handle.style.top = `${rect.top + pixel.y}px` }
      })
      animation = requestAnimationFrame(paintHandles)
    }
    paintHandles()
    let swallowClick = false
    const block = (event: Event) => { event.stopImmediatePropagation(); event.preventDefault() }
    const releaseCapture = (id: number) => {
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id)
    }
    const cancel = () => {
      if (!drag) return
      const id = drag.pointerId
      drag = null
      releaseCapture(id)
      displayed = payload
      callbacks.current.onPreview(null)
      callbacks.current.onScalePreview?.(null)
    }
    const down = (event: PointerEvent, corner?: ImagePoint) => {
      swallowClick = false
      if (event.button !== 0 || drag) return
      const start = referenceImagePoint(runtime, canvas, frame, event.clientX, event.clientY)
      // Canvas hit testing and visible buttons share the same gesture, including its
      // capture-phase shield from sketch tools (WO-2304) and zero-lift plane (SKC-55).
      if (!corner && !payload.scaleLocked && callbacks.current.onScaleCommit) {
        const rect = canvas.getBoundingClientRect()
        corner = IMAGE_CORNERS.find((candidate) => {
          const pixel = runtime.projectToCanvas(localToWorld(frame, imageCorner(payload, candidate)))
          return pixel && Math.hypot(event.clientX - rect.left - pixel.x, event.clientY - rect.top - pixel.y) <= 8
        })
      }
      if (corner && (payload.scaleLocked || !callbacks.current.onScaleCommit)) return
      if (!corner && !imageContainsPoint(payload, start)) return
      block(event)
      const center = payload.center ?? { x: 0, y: 0 }
      drag = { pointerId: event.pointerId, start, center, next: center, corner }
      canvas.setPointerCapture?.(event.pointerId)
    }
    begin.current = down
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      block(event)
      const point = referenceImagePoint(runtime, canvas, frame, event.clientX, event.clientY)
      if (drag.corner) {
        const corner = imageCorner(payload, drag.corner)
        drag.placement = scaleImageCorner(payload, drag.corner, { x: corner.x + point.x - drag.start.x, y: corner.y + point.y - drag.start.y })
        displayed = { ...payload, ...drag.placement }
        callbacks.current.onScalePreview?.(drag.placement)
        return
      }
      drag.next = { x: drag.center.x + point.x - drag.start.x, y: drag.center.y + point.y - drag.start.y }
      displayed = { ...payload, center: drag.next }
      callbacks.current.onPreview(drag.next)
    }
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      move(event)
      const finished = drag
      drag = null
      swallowClick = true
      releaseCapture(finished.pointerId)
      callbacks.current.onPreview(null)
      callbacks.current.onScalePreview?.(null)
      if (finished.placement) {
        if (Math.abs(finished.placement.widthMm - payload.widthMm) > 1e-9) callbacks.current.onScaleCommit?.(finished.placement)
        return
      }
      if (Math.hypot(finished.next.x - finished.center.x, finished.next.y - finished.center.y) > 1e-9) callbacks.current.onCommit(finished.next)
    }
    const click = (event: MouseEvent) => {
      if (swallowClick || (event.button === 0 && imageContainsPoint(payload, referenceImagePoint(runtime, canvas, frame, event.clientX, event.clientY)))) {
        swallowClick = false
        block(event)
      }
    }
    const escape = (event: KeyboardEvent) => { if (drag && event.key === 'Escape') { block(event); cancel() } }
    const lost = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) cancel() }
    const canvasDown = (event: PointerEvent) => down(event)
    canvas.addEventListener('pointerdown', canvasDown, true)
    canvas.addEventListener('click', click, true)
    canvas.addEventListener('lostpointercapture', lost)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', lost, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      cancelAnimationFrame(animation)
      begin.current = () => {}
      canvas.removeEventListener('pointerdown', canvasDown, true)
      canvas.removeEventListener('click', click, true)
      canvas.removeEventListener('lostpointercapture', lost)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', lost, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
    }
  }, [sourceKey, runtime, canvas])
  return payload.scaleLocked || !onScaleCommit ? null : createPortal(<div aria-label={workbenchText('ReferenceImagePlacement.referenceImageCornerHandles')}>
    {IMAGE_CORNERS.map((corner, i) => <button key={i} type="button" ref={(node) => { handles.current[i] = node }}
      aria-label={workbenchText('ReferenceImagePlacement.resizeReferenceImageCorner', { value1: String(i + 1) })} data-testid={`reference-image-corner-${i}`}
      onPointerDown={(event) => begin.current(event.nativeEvent, corner)} onClick={(event) => { event.stopPropagation(); event.preventDefault() }}
      style={{ position: 'fixed', display: 'none', width: 12, height: 12, padding: 0, transform: 'translate(-50%, -50%)',
        background: 'white', border: '2px solid #167bc1', borderRadius: 2, zIndex: 35, cursor: 'nwse-resize', touchAction: 'none' }} />)}
  </div>, document.body)
}
