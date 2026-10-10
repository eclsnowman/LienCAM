import { useEffect, useRef } from 'react'

export interface SectionPlaneDragController {
  state: {
    dragEnabled: boolean
    pos: number | null
    range: { min: number; max: number }
  }
  setPos(pos: number): void
}

export interface UseSectionPlaneDragArgs {
  domElement: HTMLElement | null
  enabled: boolean
  section: SectionPlaneDragController
  onLeave?(): void
  /** CAM uses exclusive capture so the armed plane drag cannot also orbit or pick. */
  exclusive?: boolean
}

interface DragGesture {
  pointerId: number
  startY: number
  startPos: number
  height: number
}

/** Shared Model/CAM owner for converting a vertical pointer drag into a section-plane position. */
export function useSectionPlaneDrag({
  domElement,
  enabled,
  section,
  onLeave,
  exclusive = false,
}: UseSectionPlaneDragArgs): void {
  const enabledRef = useRef(enabled)
  const sectionRef = useRef(section)
  const onLeaveRef = useRef(onLeave)
  const gestureRef = useRef<DragGesture | null>(null)

  useEffect(() => { enabledRef.current = enabled }, [enabled])
  useEffect(() => { sectionRef.current = section }, [section])
  useEffect(() => { onLeaveRef.current = onLeave }, [onLeave])

  useEffect(() => {
    if (domElement === null) return

    const claim = (event: PointerEvent): void => {
      if (!exclusive) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (!enabledRef.current) return
      const rect = domElement.getBoundingClientRect()
      if (!(rect.height > 0)) return
      claim(event)
      gestureRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startPos: sectionRef.current.state.pos ?? sectionRef.current.state.range.max,
        height: rect.height,
      }
      try { domElement.setPointerCapture?.(event.pointerId) } catch { /* jsdom / unsupported */ }
    }
    const handlePointerMove = (event: PointerEvent): void => {
      const gesture = gestureRef.current
      if (!sectionRef.current.state.dragEnabled || gesture === null || gesture.pointerId !== event.pointerId) return
      claim(event)
      const { range } = sectionRef.current.state
      const span = range.max - range.min
      const next = gesture.startPos - ((event.clientY - gesture.startY) / gesture.height) * span
      sectionRef.current.setPos(Math.min(range.max, Math.max(range.min, next)))
    }
    const handlePointerUp = (event: PointerEvent): void => {
      if (gestureRef.current?.pointerId !== event.pointerId) return
      claim(event)
      gestureRef.current = null
      try { domElement.releasePointerCapture?.(event.pointerId) } catch { /* jsdom / unsupported */ }
    }
    const handlePointerCancel = (event: PointerEvent): void => {
      if (gestureRef.current?.pointerId !== event.pointerId) return
      claim(event)
      gestureRef.current = null
    }
    const handlePointerLeave = (): void => {
      gestureRef.current = null
      onLeaveRef.current?.()
    }

    const capture = exclusive
    domElement.addEventListener('pointerdown', handlePointerDown, capture)
    domElement.addEventListener('pointermove', handlePointerMove, capture)
    domElement.addEventListener('pointerup', handlePointerUp, capture)
    domElement.addEventListener('pointercancel', handlePointerCancel, capture)
    domElement.addEventListener('pointerleave', handlePointerLeave, capture)

    return () => {
      gestureRef.current = null
      domElement.removeEventListener('pointerdown', handlePointerDown, capture)
      domElement.removeEventListener('pointermove', handlePointerMove, capture)
      domElement.removeEventListener('pointerup', handlePointerUp, capture)
      domElement.removeEventListener('pointercancel', handlePointerCancel, capture)
      domElement.removeEventListener('pointerleave', handlePointerLeave, capture)
    }
  }, [domElement, exclusive])
}
