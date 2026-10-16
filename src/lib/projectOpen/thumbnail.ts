/** Capture the visible production viewport, without modal/toolbar chrome.
 * The renderers do not preserve their WebGL buffers. Capture in the same frame
 * as CAM's animation; resize asks the on-demand Model renderer to paint before
 * copying its canvas. Neither camera nor project data is changed.
 */
export function captureProjectThumbnail(): Promise<string | undefined> {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), 1500)
    requestAnimationFrame(() => {
      clearTimeout(timeout)
      try {
        const canvases = Array.from(document.querySelectorAll('canvas')).filter((canvas) => {
          const rect = canvas.getBoundingClientRect()
          return rect.width > 100 && rect.height > 100 && canvas.checkVisibility?.() !== false
        }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)
        const source = canvases[0]
        if (!source) { resolve(undefined); return }
        window.dispatchEvent(new Event('resize'))
        const picture = document.createElement('canvas')
        picture.width = 320
        picture.height = 200
        const context = picture.getContext('2d')
        if (!context) { resolve(undefined); return }
        context.fillStyle = '#20252c'
        context.fillRect(0, 0, 320, 200)
        const scale = Math.min(320 / source.width, 200 / source.height)
        const width = source.width * scale, height = source.height * scale
        context.drawImage(source, (320 - width) / 2, (200 - height) / 2, width, height)
        resolve(picture.toDataURL('image/png'))
      } catch { resolve(undefined) } // A lost graphics context must never prevent saving the project.
    })
  })
}
