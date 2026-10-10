// Image relief - a picture as greyscale numbers (plain typed arrays, no React,
// no kernel). docs/design/RELIEF-WHAT-GOOD-LOOKS-LIKE.md S4: heights stay float
// from loading to the kernel, and a 16-bit PNG keeps its 65,536 levels - so
// PNGs are decoded here (fflate inflates the pixel data), never through a
// canvas, which would squeeze them to 8 bits. Other formats (JPG, WebP, an
// interlaced PNG) go through the browser's own decoder and are 8-bit anyway.

import { unzlibSync } from 'fflate'

/** A picture as grey levels: row 0 is the TOP of the picture, values 0 (black) .. 1 (white). */
export interface Picture {
  cols: number
  rows: number
  grey: Float32Array
  /** 16 when the file carried 16-bit samples, else 8 */
  bitDepth: 8 | 16
  /**
   * WO-2174: the colour channels for the greyscale-channel choice, interleaved
   * r, g, b per pixel in grey's order, 0..65535 (16 bits keep a 16-bit file's
   * levels at 6 bytes a pixel); absent for a grey picture
   */
  rgb?: Uint16Array
}

/** Rec. 709 luma - the standard's greyscale (section 2: 0.2126 R + 0.7152 G + 0.0722 B). */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/**
 * Decode a (non-interlaced) PNG of any colour type at 1-16 bits to grey.
 * Transparent pixels are laid over white, the way a viewer shows them.
 * Returns null for what it does not read (interlaced), so the caller can use
 * the browser decoder instead.
 */
export function decodePng(bytes: Uint8Array): Picture | null {
  if (!isPng(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let width = 0, height = 0, depth = 8, colorType = 0, interlace = 0
  let palette: Uint8Array | null = null
  let paletteAlpha: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const data = bytes.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8)
      height = view.getUint32(pos + 12)
      depth = bytes[pos + 16]
      colorType = bytes[pos + 17]
      interlace = bytes[pos + 20]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') paletteAlpha = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (width === 0 || height === 0 || interlace !== 0) return null
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (channels === 0) return null
  const total = idat.reduce((n, c) => n + c.length, 0)
  const packed = new Uint8Array(total)
  let at = 0
  for (const c of idat) { packed.set(c, at); at += c.length }
  const raw = unzlibSync(packed)
  const bitsPerPixel = channels * depth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const lines = new Uint8Array(stride * height)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = lines.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = src[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[i] = v & 255
    }
    prev = out
  }
  const max = (1 << depth) - 1
  const sample = (y: number, index: number): number => {
    const row = y * stride
    if (depth === 16) return (lines[row + index * 2] << 8) | lines[row + index * 2 + 1]
    if (depth === 8) return lines[row + index]
    const bit = index * depth
    return (lines[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max
  }
  const grey = new Float32Array(width * height)
  const colour = colorType === 3 || channels >= 3
  const rgb = colour ? new Uint16Array(grey.length * 3) : undefined
  const over = (v: number, alpha: number) => (alpha >= 1 ? v : v * alpha + (1 - alpha))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let g: number, alpha = 1, r = 0, gg = 0, b = 0
      if (colorType === 3) {
        const i = sample(y, x)
        r = palette ? palette[i * 3] / 255 : 0; gg = palette ? palette[i * 3 + 1] / 255 : 0; b = palette ? palette[i * 3 + 2] / 255 : 0
        g = luma(r, gg, b)
        if (paletteAlpha && i < paletteAlpha.length) alpha = paletteAlpha[i] / 255
      } else if (channels >= 3) {
        const i = x * channels
        r = sample(y, i) / max; gg = sample(y, i + 1) / max; b = sample(y, i + 2) / max
        g = luma(r, gg, b)
        if (channels === 4) alpha = sample(y, i + 3) / max
      } else {
        g = sample(y, x * channels) / max
        if (channels === 2) alpha = sample(y, x * 2 + 1) / max
      }
      const at = y * width + x
      grey[at] = over(g, alpha)
      if (rgb !== undefined) {
        rgb[at * 3] = Math.round(over(r, alpha) * 65535)
        rgb[at * 3 + 1] = Math.round(over(gg, alpha) * 65535)
        rgb[at * 3 + 2] = Math.round(over(b, alpha) * 65535)
      }
    }
  }
  return { cols: width, rows: height, grey, bitDepth: depth === 16 ? 16 : 8, ...(rgb !== undefined ? { rgb } : {}) }
}

/** Any picture file the browser can open, as 8-bit grey (JPG, WebP, interlaced PNG). Browser only. */
export async function decodeWithBrowser(bytes: Uint8Array, mime = 'image/*'): Promise<Picture> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }))
  const cols = bitmap.width, rows = bitmap.height
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(cols, rows)
    : Object.assign(document.createElement('canvas'), { width: cols, height: rows })
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (ctx === null) throw new Error('this browser gave no 2D canvas to read the picture with')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cols, rows)
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rgba = ctx.getImageData(0, 0, cols, rows).data
  const grey = new Float32Array(cols * rows)
  const rgb = new Uint16Array(grey.length * 3)
  let colour = false
  for (let i = 0; i < grey.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    rgb[i * 3] = r * 257; rgb[i * 3 + 1] = g * 257; rgb[i * 3 + 2] = b * 257
    grey[i] = luma(r / 255, g / 255, b / 255)
    colour ||= r !== g || g !== b
  }
  return { cols, rows, grey, bitDepth: 8, ...(colour ? { rgb } : {}) }
}

/** Decode picture bytes: PNG here (16-bit kept), anything else by the browser. */
export async function decodePicture(bytes: Uint8Array, mime?: string): Promise<Picture> {
  const png = decodePng(bytes)
  return png ?? decodeWithBrowser(bytes, mime)
}

/** The longest side the picture is worked at; larger pictures are averaged down (the working grid is capped at 2048 too). */
export const PICTURE_CAP = 2048

/** An area-averaged copy no larger than `cap` on its long side (the picture itself when it already fits). */
export function capPicture(p: Picture, cap = PICTURE_CAP): Picture {
  const long = Math.max(p.cols, p.rows)
  if (long <= cap) return p
  const s = cap / long
  const cols = Math.max(1, Math.round(p.cols * s)), rows = Math.max(1, Math.round(p.rows * s))
  const fx = p.cols / cols, fy = p.rows / rows
  /** the area average of `src` (stride values a pixel, this one at offset) into `out` */
  const shrink = <T extends Float32Array | Uint16Array>(src: ArrayLike<number>, out: T, stride = 1, offset = 0): T => {
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor(r * fy), y1 = Math.max(y0 + 1, Math.floor((r + 1) * fy))
      for (let c = 0; c < cols; c++) {
        const x0 = Math.floor(c * fx), x1 = Math.max(x0 + 1, Math.floor((c + 1) * fx))
        let sum = 0
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += src[(y * p.cols + x) * stride + offset]
        out[(r * cols + c) * stride + offset] = sum / ((y1 - y0) * (x1 - x0))
      }
    }
    return out
  }
  let rgb: Uint16Array | undefined
  if (p.rgb !== undefined) {
    rgb = new Uint16Array(cols * rows * 3)
    for (let k = 0; k < 3; k++) shrink(p.rgb, rgb, 3, k)
  }
  return { cols, rows, grey: shrink(p.grey, new Float32Array(cols * rows)), bitDepth: p.bitDepth, ...(rgb !== undefined ? { rgb } : {}) }
}

/** Distinct values in a float array (S4 counts height levels). */
export function distinctLevels(a: Float32Array): number {
  return new Set(a).size
}
