// WO-3012 (WO-2750 Slice F part 1): the sheet scene as a vector PDF.
//
// One page whose MediaBox is the sheet at physical size (1 mm = 72/25.4 pt),
// so a viewer that prints at "actual size" gets the drawn lengths: a 100 mm
// source edge at 1:2 is a 50 mm path. Content is in sheet millimetres under
// one `cm` that also flips Y, so the numbers in the stream are the scene's own.
// Text is glyph outlines (filled paths) with the logical string carried as
// ActualText for copy/search. Branding is an embedded image XObject. No fonts,
// no external files, no clock: the same scene gives the same bytes unless an
// export timestamp is asked for (design section 5 "PDF").

import { unzlibSync, zlibSync } from 'fflate'
import type { Pt, SceneImage, SceneItem, SceneLayer, SheetScene } from './scene'

const PT_PER_MM = 72 / 25.4

const LINE_MM: Record<SceneLayer, number> = { FRAME: 0.5, VISIBLE: 0.35, HIDDEN: 0.18, CENTER: 0.18, DIMENSION: 0.18, TEXT: 0.25 }
const DASH: Partial<Record<SceneLayer, string>> = { HIDDEN: '[2 1] 0 d', CENTER: '[8 1.5 1.5 1.5] 0 d' }

function n(v: number): string {
  const s = v.toFixed(4)
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  return t === '-0' ? '0' : t
}

function pathOf(points: Pt[], closed: boolean): string {
  return points.map((p, i) => `${n(p[0])} ${n(p[1])} ${i === 0 ? 'm' : 'l'}`).join(' ') + (closed ? ' h' : '')
}

function circlePath(c: Pt, r: number): string {
  const k = r * 0.5522847498
  const [x, y] = c
  const seg = (a: number, b: number, c2: number, d: number, e: number, f: number) => `${n(a)} ${n(b)} ${n(c2)} ${n(d)} ${n(e)} ${n(f)} c`
  return `${n(x + r)} ${n(y)} m ` +
    `${seg(x + r, y + k, x + k, y + r, x, y + r)} ${seg(x - k, y + r, x - r, y + k, x - r, y)} ` +
    `${seg(x - r, y - k, x - k, y - r, x, y - r)} ${seg(x + k, y - r, x + r, y - k, x + r, y)} h`
}

/** Bézier arcs of at most 90 degrees; angles CCW on paper (so Y is negated in this Y-down space). */
function arcPath(c: Pt, r: number, startDeg: number, endDeg: number): string {
  let sweep = endDeg - startDeg
  while (sweep <= 0) sweep += 360
  const segs = Math.max(1, Math.ceil(sweep / 90))
  const step = ((sweep / segs) * Math.PI) / 180
  const k = (4 / 3) * Math.tan(step / 4)
  let a = (startDeg * Math.PI) / 180
  const pt = (ang: number): Pt => [c[0] + r * Math.cos(ang), c[1] - r * Math.sin(ang)]
  const d = (ang: number): Pt => [-r * Math.sin(ang), -r * Math.cos(ang)] // derivative in Y-down space
  const out: string[] = [`${n(pt(a)[0])} ${n(pt(a)[1])} m`]
  for (let i = 0; i < segs; i++) {
    const b = a + step
    const p0 = pt(a), p1 = pt(b), d0 = d(a), d1 = d(b)
    out.push(`${n(p0[0] + k * d0[0])} ${n(p0[1] + k * d0[1])} ${n(p1[0] - k * d1[0])} ${n(p1[1] - k * d1[1])} ${n(p1[0])} ${n(p1[1])} c`)
    a = b
  }
  return out.join(' ')
}

function hexUtf16(text: string): string {
  let out = 'FEFF'
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return out
}

function pdfString(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? `(${text.replace(/[\\()]/g, m => `\\${m}`)})` : `<${hexUtf16(text)}>`
}

function pdfDate(iso: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || !/T\d{2}:\d{2}/.test(iso)) return null
  const d = new Date(t) // converted to UTC, so an offset in the request is honoured
  const z = (v: number, n = 2) => String(v).padStart(n, '0')
  return `D:${z(d.getUTCFullYear(), 4)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`
}

function itemOps(item: SceneItem): string {
  const stroke = `q ${n(LINE_MM[item.layer])} w ${DASH[item.layer] ?? '[] 0 d'} 1 J 1 j `
  switch (item.kind) {
    case 'polyline':
      return item.points.length < 2 ? '' : `${stroke}${pathOf(item.points, item.closed)} S Q\n`
    case 'circle':
      return `${stroke}${circlePath(item.center, item.radiusMm)} S Q\n`
    case 'arc':
      return `${stroke}${arcPath(item.center, item.radiusMm, item.startDeg, item.endDeg)} S Q\n`
    case 'text': {
      const fill = item.rings.length ? `${item.rings.map(r => pathOf(r, true)).join(' ')} f*\n` : ''
      const strokes = item.strokes.length ? `${n(0.12 * item.heightMm / 3.5 + 0.1)} w ${item.strokes.map(s => pathOf(s, false)).join(' ')} S\n` : ''
      return `/Span << /ActualText <${hexUtf16(item.text)}> >> BDC\nq 1 J 1 j\n${fill}${strokes}Q\nEMC\n`
    }
  }
}

// -- PNG -> PDF image ---------------------------------------------------------

interface PdfImage {
  width: number
  height: number
  colorSpace: string
  bpc: number
  filter: 'FlateDecode' | 'DCTDecode'
  parms?: string
  data: Uint8Array
  smask?: { data: Uint8Array }
}

function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const out: Array<{ type: string; data: Uint8Array }> = []
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let i = 8
  while (i + 8 <= png.length) {
    const len = dv.getUint32(i)
    const type = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7])
    out.push({ type, data: png.subarray(i + 8, i + 8 + len) })
    i += 12 + len
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v = raw[src + x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = v & 0xff
    }
  }
  return out
}

function pngImage(img: SceneImage): PdfImage {
  const parts = chunks(img.bytes)
  const ihdr = parts.find(p => p.type === 'IHDR')!.data
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const { widthPx: width, heightPx: height } = img
  const idat = concat(parts.filter(p => p.type === 'IDAT').map(p => p.data))
  if (colorType === 4 || colorType === 6) {
    const bpp = colorType === 4 ? 2 : 4
    const px = unfilter(unzlibSync(idat), width, height, bpp)
    const colors = bpp - 1
    const color = new Uint8Array(width * height * colors)
    const alpha = new Uint8Array(width * height)
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < colors; c++) color[i * colors + c] = px[i * bpp + c]
      alpha[i] = px[i * bpp + colors]
    }
    return { width, height, colorSpace: colors === 1 ? '/DeviceGray' : '/DeviceRGB', bpc: 8, filter: 'FlateDecode', data: zlibSync(color), smask: { data: zlibSync(alpha) } }
  }
  // Colour types 0, 2 and 3 keep their PNG-filtered scanlines as they are:
  // /Predictor 15 is PNG's own filtering. A tRNS chunk (colour-key transparency) is not applied.
  const colors = colorType === 2 ? 3 : 1
  let colorSpace = colors === 3 ? '/DeviceRGB' : '/DeviceGray'
  if (colorType === 3) {
    const plte = parts.find(p => p.type === 'PLTE')?.data ?? new Uint8Array(3)
    colorSpace = `[/Indexed /DeviceRGB ${plte.length / 3 - 1} <${Array.from(plte, b => b.toString(16).padStart(2, '0')).join('')}>]`
  }
  return { width, height, colorSpace, bpc: bitDepth, filter: 'FlateDecode', parms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent ${bitDepth} /Columns ${width} >>`, data: idat }
}

function jpegImage(img: SceneImage): PdfImage {
  let components = 3
  for (let i = 2; i + 9 < img.bytes.length;) {
    if (img.bytes[i] !== 0xff) { i++; continue }
    const m = img.bytes[i + 1]
    if (m >= 0xc0 && m <= 0xc2) { components = img.bytes[i + 9]; break }
    i += 2 + ((img.bytes[i + 2] << 8) | img.bytes[i + 3])
  }
  return { width: img.widthPx, height: img.heightPx, colorSpace: components === 1 ? '/DeviceGray' : '/DeviceRGB', bpc: 8, filter: 'DCTDecode', data: img.bytes }
}

// -- file assembly --------------------------------------------------------------

export interface PdfExportResult {
  bytes: Uint8Array
  /** what the PDF does not carry, in plain sentences */
  notes: string[]
}

/**
 * Write the scene as a one-page PDF at physical size. Branding images in the
 * scene are embedded; the scene already records any branding it could not draw.
 */
export function exportDrawingPdf(scene: SheetScene): PdfExportResult {
  const enc = new TextEncoder()
  const objects: Array<Uint8Array | string> = []
  const add = (body: Uint8Array | string): number => { objects.push(body); return objects.length }
  const stream = (dict: string, data: Uint8Array | string): Uint8Array => {
    const body = typeof data === 'string' ? enc.encode(data) : data
    return concat([enc.encode(`<< ${dict} /Length ${body.length} >>\nstream\n`), body, enc.encode('\nendstream')])
  }

  const catalog = add('')
  const pages = add('')
  const [W, H] = scene.sizeMm
  const xobjects: string[] = []
  let imageOps = ''
  scene.images.forEach((img, i) => {
    const pdfImg = img.kind === 'png' ? pngImage(img) : jpegImage(img)
    const smaskId = pdfImg.smask
      ? add(stream(`/Type /XObject /Subtype /Image /Width ${pdfImg.width} /Height ${pdfImg.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, pdfImg.smask.data))
      : 0
    const id = add(stream(
      `/Type /XObject /Subtype /Image /Width ${pdfImg.width} /Height ${pdfImg.height} /ColorSpace ${pdfImg.colorSpace} /BitsPerComponent ${pdfImg.bpc} /Filter /${pdfImg.filter}` +
      `${pdfImg.parms ? ` /DecodeParms ${pdfImg.parms}` : ''}${smaskId ? ` /SMask ${smaskId} 0 R` : ''}`,
      pdfImg.data,
    ))
    xobjects.push(`/Im${i + 1} ${id} 0 R`)
    const [x, y, w, h] = img.rectMm
    // the page space is Y-down, so the image is flipped back upright
    imageOps += `q ${n(w)} 0 0 ${n(-h)} ${n(x)} ${n(y + h)} cm /Im${i + 1} Do Q\n`
  })

  // the one scale matrix keeps ten decimals: at 280 mm, four would already be 0.005 mm off
  const body = `q ${PT_PER_MM.toFixed(10)} 0 0 ${(-PT_PER_MM).toFixed(10)} 0 ${(H * PT_PER_MM).toFixed(6)} cm\n1 J 1 j\n${scene.items.map(itemOps).join('')}${imageOps}Q\n`
  const contents = add(stream('', body))
  const page = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${n(W * PT_PER_MM)} ${n(H * PT_PER_MM)}] /Resources << /XObject << ${xobjects.join(' ')} >> >> /Contents ${contents} 0 R >>`)
  const date = scene.exportTimestamp ? pdfDate(scene.exportTimestamp) : null
  const info = add(`<< /Title ${pdfString(scene.documentName || scene.documentId)} /Subject ${pdfString(scene.revision)} /Keywords ${pdfString(`LienCAM drawing ${scene.documentId}`)} /Creator (LienCAM) /Producer (LienCAM drawing export)${date ? ` /CreationDate (${date})` : ''} >>`)
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`

  const parts: Uint8Array[] = [enc.encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')]
  const offsets: number[] = []
  let size = parts[0].length
  objects.forEach((o, i) => {
    offsets.push(size)
    const chunk = concat([enc.encode(`${i + 1} 0 obj\n`), typeof o === 'string' ? enc.encode(o) : o, enc.encode('\nendobj\n')])
    parts.push(chunk)
    size += chunk.length
  })
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${size}\n%%EOF\n`
  parts.push(enc.encode(xref))
  return { bytes: concat(parts), notes: [] }
}
