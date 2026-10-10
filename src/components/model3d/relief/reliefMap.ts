// Relief - the 2D height map beside the 3D preview (docs/design/IMAGE-RELIEF-PLAN.md
// section 4: "the final heights from above ... and a live section line with
// the zero plane"). Drawn from the same applied-surface heights the settled
// 3D preview shows, so the two never disagree.

import type { Picture } from '../../../relief/picture'

/** 'image': the picture as opened (before); 'adjusted': after the adjustments (WO-2174); 'compare': before | after side by side */
export type MapView = 'image' | 'adjusted' | 'compare' | 'height' | 'shaded'

/** Light for the Shaded view: the upper left at 35 deg (S11), as the standard's reference renders. */
const SHADE_ELEVATION_DEG = 35

/**
 * Paint the map. `heights` are (n+1)^2 signed mm, row 0 at the rectangle's
 * low-Y edge; the canvas shows the picture upright (top row = high Y), with
 * the section line A-A across the middle.
 */
export function drawReliefMap(canvas: HTMLCanvasElement, view: MapView, heights: Float32Array, n: number, widthMm: number, heightMm: number, picture: Picture | null, adjusted?: Float32Array): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const W = canvas.width, H = canvas.height
  const img = ctx.createImageData(W, H)
  let lo = Infinity, hi = -Infinity
  for (const h of heights) { lo = Math.min(lo, h); hi = Math.max(hi, h) }
  const span = Math.max(hi - lo, 1e-9)
  const dx = widthMm / n, dy = heightMm / n
  const el = (SHADE_ELEVATION_DEG * Math.PI) / 180
  const c = Math.cos(el) * Math.SQRT1_2
  const sEl = Math.sin(el)
  const at = (r: number, col: number) => heights[Math.min(Math.max(r, 0), n) * (n + 1) + Math.min(Math.max(col, 0), n)]
  for (let py = 0; py < H; py++) {
    const fy = 1 - (py + 0.5) / H
    const r = Math.round(fy * n)
    for (let px = 0; px < W; px++) {
      const fx = (px + 0.5) / W
      const col = Math.round(fx * n)
      let g: number
      if ((view === 'image' || view === 'adjusted' || view === 'compare') && picture !== null) {
        const u = Math.min(picture.cols - 1, Math.floor(fx * picture.cols))
        const v = Math.min(picture.rows - 1, Math.floor((1 - fy) * picture.rows))
        const after = view === 'adjusted' || (view === 'compare' && px >= W / 2)
        g = (after && adjusted !== undefined ? adjusted : picture.grey)[v * picture.cols + u]
      } else if (view === 'shaded') {
        // Lambert of the height field (mm), light from the upper left: the prototype's shade()
        const gx = (at(r, col + 1) - at(r, col - 1)) / (2 * dx)
        const gyUp = (at(r + 1, col) - at(r - 1, col)) / (2 * dy)
        const gy = -gyUp // image rows run down
        const nz = 1 / Math.sqrt(gx * gx + gy * gy + 1)
        const lam = Math.min(Math.max(-gx * nz * -c + -gy * nz * -c + nz * sEl, 0), 1)
        g = 0.12 + 0.88 * lam
      } else {
        g = (at(r, col) - lo) / span
      }
      const i = (py * W + px) * 4
      const shade = Math.round(Math.min(Math.max(g, 0), 1) * 255)
      if (view === 'shaded') {
        img.data[i] = Math.round(shade * 0.93); img.data[i + 1] = Math.round(shade * 0.8); img.data[i + 2] = Math.round(shade * 0.62)
      } else {
        img.data[i] = shade; img.data[i + 1] = shade; img.data[i + 2] = shade
      }
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  if (view === 'compare') {
    // before | after, split down the middle
    ctx.strokeStyle = 'rgba(255,160,40,0.95)'
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(Math.round(W / 2) + 0.5, 0)
    ctx.lineTo(Math.round(W / 2) + 0.5, H)
    ctx.stroke()
    ctx.font = '10px sans-serif'
    for (const [label, x] of [['before', 4], ['after', Math.round(W / 2) + 4]] as const) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(x - 2, 2, ctx.measureText(label).width + 4, 13)
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.fillText(label, x, 12)
    }
  }
  // section line A-A across the middle
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(0, H / 2 + 0.5)
  ctx.lineTo(W, H / 2 + 0.5)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.font = '10px sans-serif'
  ctx.fillText('A', 3, H / 2 - 3)
  ctx.fillText('A', W - 10, H / 2 - 3)
}

/** The profile along A-A (the middle row) with the face (zero plane of the part) dashed. */
export function drawReliefSection(canvas: HTMLCanvasElement, heights: Float32Array, n: number, depthMm: number, cutIn: boolean): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)
  const r = Math.round(n / 2)
  const pad = 4
  const range = Math.max(depthMm, 1e-6)
  // the face sits at the bottom for Raise, at the top for Cut in
  const zeroY = cutIn ? pad : H - pad
  const scale = (H - 2 * pad) / range
  const style = getComputedStyle(canvas)
  ctx.fillStyle = style.getPropertyValue('--relief-section-fill').trim() || 'rgba(120,150,190,0.55)'
  ctx.beginPath()
  ctx.moveTo(0, zeroY)
  for (let px = 0; px <= W; px++) {
    const col = Math.round((px / W) * n)
    const h = heights[r * (n + 1) + col]
    ctx.lineTo(px, zeroY - h * scale)
  }
  ctx.lineTo(W, zeroY)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = style.getPropertyValue('--relief-section-line').trim() || 'rgba(255,255,255,0.7)'
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.moveTo(0, zeroY + 0.5)
  ctx.lineTo(W, zeroY + 0.5)
  ctx.stroke()
  ctx.setLineDash([])
}

/** A small thumbnail of the picture (grey), for the palette. */
export function drawThumbnail(canvas: HTMLCanvasElement, picture: Picture): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const W = canvas.width, H = canvas.height
  const s = Math.min(W / picture.cols, H / picture.rows)
  const w = Math.max(1, Math.round(picture.cols * s)), h = Math.max(1, Math.round(picture.rows * s))
  const ox = Math.floor((W - w) / 2), oy = Math.floor((H - h) / 2)
  ctx.clearRect(0, 0, W, H)
  const img = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    const v = Math.min(picture.rows - 1, Math.floor((y / h) * picture.rows))
    for (let x = 0; x < w; x++) {
      const u = Math.min(picture.cols - 1, Math.floor((x / w) * picture.cols))
      const g = Math.round(picture.grey[v * picture.cols + u] * 255)
      const i = (y * w + x) * 4
      img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, ox, oy)
}

/**
 * WO-2174: the levels histogram - the grey values going into levels, the
 * black and white points as triangles under it and the midtones point between
 * them (where a value lands half way up after the midtones bend).
 */
export function drawHistogram(canvas: HTMLCanvasElement, hist: Uint32Array, black: number, midtones: number, white: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const W = canvas.width, H = canvas.height
  const plotH = H - 8
  ctx.clearRect(0, 0, W, H)
  const style = getComputedStyle(canvas)
  let peak = 1
  // the tallest bar sets the scale, ignoring a single huge bin (a flat background) so the rest still shows
  const sorted = Array.from(hist).sort((a, b) => b - a)
  peak = Math.max(1, sorted[1] ?? sorted[0] ?? 1)
  ctx.fillStyle = style.getPropertyValue('--relief-hist-fill').trim() || 'rgba(170,180,195,0.8)'
  const bw = W / hist.length
  for (let i = 0; i < hist.length; i++) {
    const h = Math.min(1, hist[i] / peak) * plotH
    ctx.fillRect(i * bw, plotH - h, Math.max(bw - 0.5, 0.5), h)
  }
  const mid = black + (white - black) * Math.pow(0.5, Math.min(Math.max(midtones, 0.3), 3))
  const marker = (v: number, fill: string) => {
    const x = Math.min(Math.max(v, 0), 1) * (W - 1) + 0.5
    ctx.fillStyle = fill
    ctx.strokeStyle = 'rgba(128,128,128,0.9)'
    ctx.beginPath()
    ctx.moveTo(x, plotH)
    ctx.lineTo(x - 4, H)
    ctx.lineTo(x + 4, H)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  marker(black, '#000')
  marker(mid, '#808080')
  marker(white, '#fff')
}
