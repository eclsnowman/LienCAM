// WO-1970: trace a dark-on-light picture (PNG / JPG) into closed Loop2D outlines.
//
// Pipeline: decode -> grey field -> marching squares (sub-pixel, so an
// anti-aliased edge lands between pixels instead of on a staircase) -> join
// the crossings into closed loops -> Douglas-Peucker to drop the pixel steps
// -> scale to mm. Outer loops and holes come out of the one contour pass: the
// contour is walked with the dark side on a fixed hand, so every dark shape's
// outline turns one way and every hole inside it turns the other. The
// sketch import then runs the same line/arc fit as DXF/SVG on these loops.
//
// PNG is decoded here (fflate inflates) so the tracer runs the same in a
// test and in the browser; JPG, and any PNG shape this decoder does not
// cover (interlaced), goes through the browser's own decoder.

import { unzlibSync } from 'fflate'
import type { Loop2D, Vec2 } from '../../types'

export interface GreyBitmap {
  width: number
  height: number
  /** 0 = black .. 255 = white, alpha already composited over white. */
  grey: Uint8Array
}

export const TRACE_DEFAULT_WIDTH_MM = 100
export const TRACE_DEFAULT_THRESHOLD = 128
/** A traced edge is allowed to wander this far (in picture pixels) from the pixel contour. */
const SIMPLIFY_TOL_PX = 0.7
/** Speckle smaller than this many pixels is noise, not a shape. */
const MIN_LOOP_AREA_PX = 4

// ---------------------------------------------------------------- decoding

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]

function isPng(b: Uint8Array): boolean {
  return PNG_SIG.every((v, i) => b[i] === v)
}

/** Returns null when the PNG is a shape this decoder does not cover. */
export function decodePng(bytes: Uint8Array): GreyBitmap | null {
  if (!isPng(bytes)) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const data = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8)
      height = dv.getUint32(pos + 12)
      depth = bytes[pos + 16]
      colorType = bytes[pos + 17]
      interlace = bytes[pos + 20]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (interlace !== 0 || width === 0 || height === 0 || idat.length === 0) return null
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null
  if (colorType === 3 && !palette) return null

  const total = idat.reduce((n, c) => n + c.length, 0)
  const joined = new Uint8Array(total)
  let o = 0
  for (const c of idat) { joined.set(c, o); o += c.length }
  const raw = unzlibSync(joined)

  const bitsPerPixel = channels * depth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, bitsPerPixel >> 3)
  if (raw.length < (stride + 1) * height) return null
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= bpp ? px[dst + i - bpp] : 0
      const b = y > 0 ? px[dst - stride + i] : 0
      const c = i >= bpp && y > 0 ? px[dst - stride + i - bpp] : 0
      let v: number
      if (ft === 0) v = x
      else if (ft === 1) v = x + a
      else if (ft === 2) v = x + b
      else if (ft === 3) v = x + ((a + b) >> 1)
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else return null
      px[dst + i] = v & 255
    }
  }

  const maxVal = (1 << depth) - 1
  /** Sample n of row y, scaled to 0..255. */
  const sample = (y: number, n: number): number => {
    if (depth === 8) return px[y * stride + n]
    if (depth === 16) return px[y * stride + n * 2]
    const bit = n * depth
    const byte = px[y * stride + (bit >> 3)]
    return (byte >> (8 - depth - (bit & 7))) & maxVal
  }
  const rawSample = sample
  const grey = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lum: number
      let alpha = 255
      if (colorType === 0) {
        const s = rawSample(y, x)
        lum = depth < 8 ? Math.round((s * 255) / maxVal) : s
      } else if (colorType === 4) {
        lum = rawSample(y, x * 2)
        alpha = rawSample(y, x * 2 + 1)
      } else if (colorType === 3) {
        const idx = rawSample(y, x)
        lum = 0.299 * palette![idx * 3] + 0.587 * palette![idx * 3 + 1] + 0.114 * palette![idx * 3 + 2]
        alpha = trns && idx < trns.length ? trns[idx] : 255
      } else {
        const r = rawSample(y, x * channels), g = rawSample(y, x * channels + 1), bl = rawSample(y, x * channels + 2)
        lum = 0.299 * r + 0.587 * g + 0.114 * bl
        if (colorType === 6) alpha = rawSample(y, x * channels + 3)
      }
      grey[y * width + x] = Math.round((lum * alpha + 255 * (255 - alpha)) / 255)
    }
  }
  return { width, height, grey }
}

/** Browser decoder for JPG and anything decodePng declines. Downscales past 4096 px. */
async function decodeWithBrowser(file: File): Promise<GreyBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('this browser cannot decode pictures')
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D canvas available to decode the picture')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const rgba = ctx.getImageData(0, 0, w, h).data
  const grey = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    grey[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])
  }
  return { width: w, height: h, grey }
}

export async function decodeRaster(file: File): Promise<GreyBitmap> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isPng(bytes)) {
    const png = decodePng(bytes)
    if (png) return png
  }
  return decodeWithBrowser(file)
}

// ------------------------------------------------------------------- trace

/** Douglas-Peucker over an open run of points. */
function dpOpen(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y
    const len = Math.hypot(dx, dy)
    let worst = -1, worstD = tol
    for (let i = a + 1; i < b; i++) {
      const d = len < 1e-12
        ? Math.hypot(pts[i].x - pts[a].x, pts[i].y - pts[a].y)
        : Math.abs((pts[i].x - pts[a].x) * dy - (pts[i].y - pts[a].y) * dx) / len
      if (d > worstD) { worstD = d; worst = i }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Douglas-Peucker for a closed ring: split at the point farthest from point 0. */
function simplifyRing(ring: Vec2[], tol: number): Vec2[] {
  if (ring.length < 4) return ring
  let far = 0, farD = -1
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y)
    if (d > farD) { farD = d; far = i }
  }
  const first = dpOpen(ring.slice(0, far + 1), tol)
  const second = dpOpen([...ring.slice(far), ring[0]], tol)
  return [...first.slice(0, -1), ...second.slice(0, -1)]
}

/** If the ring is a circle to within the pixel grid (Kasa least squares, every point within
 *  `tol` of the circle), return it. Lets a round dot or disc land as a true circle after the
 *  sketch import's arc fit instead of a many-sided polygon. */
function fitCircle(ring: Vec2[], tol: number): { cx: number; cy: number; r: number } | null {
  const n = ring.length
  if (n < 12) return null
  let mx = 0, my = 0
  for (const p of ring) { mx += p.x; my += p.y }
  mx /= n; my /= n
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const p of ring) {
    const u = p.x - mx, v = p.y - my
    suu += u * u; suv += u * v; svv += v * v
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu)
  const uc = (b1 * svv - b2 * suv) / det
  const vc = (suu * b2 - suv * b1) / det
  const cx = mx + uc, cy = my + vc
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  for (const p of ring) {
    if (Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) > tol) return null
  }
  return { cx, cy, r }
}

/** Points on a circle dense enough that its sag stays under ~0.005 of a pixel-scale unit. */
function circlePoints(c: { cx: number; cy: number; r: number }, mmPerPx: number): Vec2[] {
  const rMm = c.r * mmPerPx
  const count = Math.min(720, Math.max(36, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - 0.005 / Math.max(rMm, 0.01))))))
  const pts: Vec2[] = []
  // Clockwise on screen (dark on the right), matching the contour walk.
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count
    pts.push({ x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) })
  }
  return pts
}

function signedArea(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Marching squares over `darkness` (positive = dark), returning closed rings in
 *  picture pixel coordinates (x right, y down, 0..width / 0..height). Each ring
 *  keeps dark on the right of travel (in y-down view): a dark shape's outline
 *  turns clockwise on screen, a hole inside it counter-clockwise. */
function contourRings(bm: GreyBitmap, threshold: number): Vec2[][] {
  const { width: w, height: h, grey } = bm
  // Padded field: node (i, j) is the centre of pixel (i-1, j-1); the frame is "light".
  const nw = w + 2, nh = h + 2
  const field = new Float32Array(nw * nh).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) field[(y + 1) * nw + (x + 1)] = threshold - grey[y * w + x]
  }
  // Edge ids: horizontal edge (i,j)-(i+1,j) = 2*(j*nw+i); vertical (i,j)-(i,j+1) = 2*(j*nw+i)+1.
  const pointOf = new Map<number, Vec2>()
  const edgePoint = (id: number, ax: number, ay: number, bx: number, by: number, va: number, vb: number): number => {
    if (!pointOf.has(id)) {
      const t = va / (va - vb)
      // node (i,j) is pixel centre (i-0.5, j-0.5) in picture coordinates
      pointOf.set(id, { x: ax + (bx - ax) * t - 0.5, y: ay + (by - ay) * t - 0.5 })
    }
    return id
  }
  const next = new Map<number, number>()
  for (let j = 0; j < nh - 1; j++) {
    for (let i = 0; i < nw - 1; i++) {
      const tl = field[j * nw + i], tr = field[j * nw + i + 1]
      const br = field[(j + 1) * nw + i + 1], bl = field[(j + 1) * nw + i]
      const inTL = tl > 0, inTR = tr > 0, inBR = br > 0, inBL = bl > 0
      if (inTL === inTR && inTR === inBR && inBR === inBL) continue
      const base = j * nw + i
      const T = () => edgePoint(2 * base, i, j, i + 1, j, tl, tr)
      const R = () => edgePoint(2 * (base + 1) + 1, i + 1, j, i + 1, j + 1, tr, br)
      const B = () => edgePoint(2 * (base + nw), i, j + 1, i + 1, j + 1, bl, br)
      const L = () => edgePoint(2 * base + 1, i, j, i, j + 1, tl, bl)
      // Clockwise perimeter order T,R,B,L; crossing type: exit = inside->outside clockwise.
      const cross: Array<{ id: number; exit: boolean }> = []
      if (inTL !== inTR) cross.push({ id: T(), exit: inTL })
      if (inTR !== inBR) cross.push({ id: R(), exit: inTR })
      if (inBR !== inBL) cross.push({ id: B(), exit: inBR })
      if (inBL !== inTL) cross.push({ id: L(), exit: inBL })
      if (cross.length === 2) {
        const ex = cross[0].exit ? cross[0] : cross[1]
        const en = cross[0].exit ? cross[1] : cross[0]
        next.set(ex.id, en.id)
      } else {
        const connected = (tl + tr + br + bl) / 4 > 0
        for (let k = 0; k < 4; k++) {
          if (!cross[k].exit) continue
          const enter = connected ? cross[(k + 1) % 4] : cross[(k + 3) % 4]
          next.set(cross[k].id, enter.id)
        }
      }
    }
  }
  const rings: Vec2[][] = []
  const seen = new Set<number>()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const ring: Vec2[] = []
    let cur = start
    while (!seen.has(cur)) {
      seen.add(cur)
      ring.push(pointOf.get(cur)!)
      const n = next.get(cur)
      if (n === undefined) break
      cur = n
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

/**
 * Trace dark shapes into closed loops in mm: x right, y up, the picture's lower-left
 * corner at the origin, `widthMm` wide and the height in the picture's proportions.
 * A pixel is dark when its grey level is below `threshold` (0..255).
 */
export function traceBitmap(
  bm: GreyBitmap,
  opts: { widthMm?: number; threshold?: number } = {},
): Loop2D[] {
  const widthMm = opts.widthMm && opts.widthMm > 0 ? opts.widthMm : TRACE_DEFAULT_WIDTH_MM
  const threshold = opts.threshold ?? TRACE_DEFAULT_THRESHOLD
  const mmPerPx = widthMm / bm.width
  const loops: Loop2D[] = []
  for (const ring of contourRings(bm, threshold)) {
    const circle = fitCircle(ring, SIMPLIFY_TOL_PX)
    const simple = circle ? circlePoints(circle, mmPerPx) : simplifyRing(ring, SIMPLIFY_TOL_PX)
    const areaPx = signedArea(simple)
    if (simple.length < 3 || Math.abs(areaPx) < MIN_LOOP_AREA_PX) continue
    // Dark on the right in a y-down view = clockwise on screen = positive shoelace sum
    // in (x, y-down). Those are the outlines of dark shapes; the rest are holes.
    const isOuter = areaPx > 0
    const points = simple.map((p) => ({ x: p.x * mmPerPx, y: (bm.height - p.y) * mmPerPx }))
    loops.push({
      id: `trace-${loops.length}`,
      points,
      closed: true,
      type: isOuter ? 'contour' : 'hole',
      layerId: 'default',
      area: Math.abs(areaPx) * mmPerPx * mmPerPx,
    })
  }
  return loops
}
