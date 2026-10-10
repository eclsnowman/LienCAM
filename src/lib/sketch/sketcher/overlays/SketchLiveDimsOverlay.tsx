import { useEffect, useRef } from 'react'
import { useSketcherTool } from '../useSketcherTool'
import { sketcherToolStore } from '../toolStore'
import { liveDrawLabels, liveDimSlots, type LiveDimLabel } from '../../tools/liveDims'
import type { SketcherOverlaySurface, SketcherOverlaysPort } from './port'

// Live draw-dimension labels: while a rectangle / ellipse
// tool is rubber-banding, small DISPLAY-ONLY numeric labels sit just OUTSIDE
// the dragged shape, centered on their edge (rect: W outside the top edge +
// H outside the left edge; ellipse: radii outside the axis vertices). They
// are quieter cousins of the smart-dim cursor preview (same sketch-dim-label
// chrome, smaller and never interactive) and they vanish the moment the
// chain commits or cancels.
//
// Same overlay doctrine as SketchDrawValueInput / SketchDimensionOverlay:
// React mounts/unmounts on tool/chain changes only; the per-frame rAF tick
// mutates label text + transforms directly from the live cursor
// (getLastSketchCursor) and worldToScreen, so pointer moves never re-render.
// The label GEOMETRY comes from the pure liveDims helper, which reuses the
// exact commit builders (rectCorners / ellipseFromClicks) — shown === commit.

interface Props {
  port: SketcherOverlaysPort
}

/** Screen-pixel gap between a label's CENTER and its edge anchor. */
const LIVE_DIM_GAP_PX = 18

/** Screen position for a label: project the world anchor, then step a
 *  constant pixel gap along the label's world-space OUTWARD direction as it
 *  appears ON SCREEN (project anchor + out too and normalize the delta).
 *  Going through the projection keeps "outside the shape" true even when the
 *  sketch view is rotated or mirrored — a fixed screen nudge does not. */
function labelScreenPos(vp: SketcherOverlaySurface, label: LiveDimLabel): { x: number; y: number } {
  const s = vp.worldToScreen(label.at.x, label.at.y, 0.4)
  const t = vp.worldToScreen(label.at.x + label.out.x, label.at.y + label.out.y, 0.4)
  let dx = t.x - s.x
  let dy = t.y - s.y
  const m = Math.hypot(dx, dy)
  if (m > 1e-6) {
    dx = (dx / m) * LIVE_DIM_GAP_PX
    dy = (dy / m) * LIVE_DIM_GAP_PX
  } else {
    // Outward direction degenerate on screen (view edge-on): nudge up.
    dx = 0
    dy = -LIVE_DIM_GAP_PX
  }
  return { x: s.x + dx, y: s.y + dy }
}

export function SketchLiveDimsOverlay({ port }: Props) {
  const isSketch = port.useIsSketchActive()
  const activeSketch = port.useSketch()
  const sketchToolChain = useSketcherTool((s) => s.chain)
  const units = port.useDisplayUnits()
  const rootRef = useRef<HTMLDivElement>(null)

  const kind =
    sketchToolChain?.kind === 'rect' || sketchToolChain?.kind === 'ellipse' ||
    sketchToolChain?.kind === 'ellipse-arc'
      ? sketchToolChain.kind
      : null
  const supported = isSketch && !!activeSketch && kind !== null

  // Per-frame sync: recompute the labels from the LIVE chain + cursor and
  // mutate the slot divs (text / position / visibility) without re-rendering.
  useEffect(() => {
    if (!supported) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const vp = port.getSurface()
      const root = rootRef.current
      if (!vp || !root) return
      const cursor = vp.getLastSketchCursor()
      const labels = cursor
        ? liveDrawLabels(sketcherToolStore.getState().chain, cursor, port.getDisplayUnits())
        : []
      for (const el of Array.from(root.children) as HTMLElement[]) {
        const label = labels.find((l) => l.key === el.dataset.slot)
        if (!label) {
          el.style.display = 'none'
          continue
        }
        const s = labelScreenPos(vp, label)
        el.style.display = ''
        el.textContent = label.text
        el.style.transform =
          `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [supported, port])

  if (!supported || kind === null) return null

  // First paint straight from the current cursor (the rAF tick then keeps it
  // live): a chain-advancing click re-renders through the tool-state
  // subscription, so the labels never show a stale phase.
  const cursor = port.getSurface()?.getLastSketchCursor() ?? null
  const initial = cursor ? liveDrawLabels(sketchToolChain, cursor, units) : []

  return (
    <div className="sketch-dim-layer sketch-live-dim-layer" ref={rootRef}>
      {liveDimSlots(kind).map((slot) => {
        const label = initial.find((l) => l.key === slot)
        const vp = port.getSurface()
        const s = label && vp ? labelScreenPos(vp, label) : null
        return (
          <div
            key={slot}
            data-slot={slot}
            className="sketch-dim-label sketch-live-dim"
            style={{
              display: label ? '' : 'none',
              transform: label && s
                ? `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`
                : 'translate(-1000px, -1000px)',
            }}
          >
            {label?.text ?? ''}
          </div>
        )
      })}
    </div>
  )
}
