import { useUiPrefs } from '../../store/uiPrefs'

/** Device-pixel ratio for a renderer whose CSS box may be rem-scaled.
 *
 * Root-font scaling changes the box's CSS-pixel dimensions. Multiplying DPR by
 * the UI scale would count that growth twice and would desynchronize picking
 * and screen-space line resolution from the renderer's drawing buffer. */
export function rendererDpr(max = 2): number {
  if (typeof window === 'undefined') return 1
  const dpr = window.devicePixelRatio || 1
  return Math.min(dpr, max)
}

/** Keep a mounted renderer synchronized with live scale and display changes. */
export function observeRendererDpr(sync: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  let frame = 0
  const schedule = () => {
    sync()
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(sync)
  }
  const unsubscribe = useUiPrefs.subscribe((state) => state.uiScale, schedule)
  window.addEventListener('resize', schedule)
  return () => {
    cancelAnimationFrame(frame)
    unsubscribe()
    window.removeEventListener('resize', schedule)
  }
}
