// WO-3012 (WO-2750 Slice F part 1): the drawing export engine - one sheet scene,
// a vector PDF and a static R2000 DXF.
//
// Plan section 8 row "PDF/DXF mm/inch, scales 1:1/1:2/2:1" and section 5. The
// files are read BACK by readers that share no code with the writers: a PDF
// reader that follows the xref table and interprets the page's content stream
// (path operators, cm, Bezier curves, marked content), and a DXF reader that
// walks group-code pairs. Every number asserted below is measured from those
// reads, never from the scene or the writer's own model.

import { describe, it, expect } from 'vitest'
import { unzlibSync, zlibSync } from 'fflate'
import { buildSheetScene, dimensionLabel, type AnnotationRender, type SceneInputs } from '../../lib/drawing/scene'
import { exportDrawingPdf } from '../../lib/drawing/exportPdf'
import { exportDrawingDxf } from '../../lib/drawing/exportDxf'
import { standardViewFrame } from '../../lib/drawing/project'
import type { DrawingDocument, DrawingDimension } from '../../lib/drawing/document'
import type { ProjectedLine, ProjectionScene, SourceRevision } from '../../lib/drawing/types'

// -- fixtures -----------------------------------------------------------------------

const REV: SourceRevision = { geometryFingerprint: 'a1b2c3d4e5f60718', frameFingerprint: 'frame-1', producerVersion: 'test/1' }
const OLD_REV: SourceRevision = { geometryFingerprint: '99887766aabbccdd', frameFingerprint: 'frame-1', producerVersion: 'test/1' }

function ring(cx: number, cy: number, r: number, n: number): Array<[number, number]> {
  return Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)] as [number, number])
}

/** A 100 x 60 plate with a 20 mm hole at its centre, seen from the front (view mm, u right, v up). */
function plateProjection(chordToleranceMm = 0.01): ProjectionScene {
  const lines: ProjectedLine[] = [
    { visibility: 'visible', category: 'sharp', points: [[0, 0], [100, 0], [100, 60], [0, 60], [0, 0]] },
    { visibility: 'visible', category: 'outline', points: ring(50, 30, 10, 96) },
    { visibility: 'hidden', category: 'sharp', points: [[10, 10], [90, 10]] },
  ]
  return {
    frame: standardViewFrame('front'), producer: 'occt-hlr', producerVersion: 'test', chordToleranceMm, lines, limits: [],
    stats: { visibleLengthMm: 0, hiddenLengthMm: 0, hiddenSuppressedLengthMm: 0, duplicateSuppressedLengthMm: 0, ms: 0 },
  }
}

function crc32(bytes: Uint8Array): number {
  let c = ~0
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}

function png(width: number, height: number, colorType: 2 | 6, bitDepth = 8): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = new Uint8Array(height * (1 + width * bpp))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * bpp)] = 0
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * bpp) + 1 + x * bpp
      raw[o] = x * 60; raw[o + 1] = y * 60; raw[o + 2] = 200
      if (bpp === 4) raw[o + 3] = x === 0 ? 0 : 255
    }
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, width); new DataView(ihdr.buffer).setUint32(4, height)
  ihdr[8] = bitDepth; ihdr[9] = colorType
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

interface FixtureOpts {
  size?: [number, number]
  scale?: { numerator: number; denominator: number }
  unit?: 'mm' | 'inch'
  precision?: number
  assets?: Array<{ id: string; name: string; contentType: string; bytes: Uint8Array }>
}

function dimension(id: string, over: Partial<DrawingDimension> = {}): DrawingDimension {
  return { kind: 'dimension', id, measurement: 'linear', referenceIds: [], tolerance: { kind: 'none' }, ...over }
}

function makeDoc(o: FixtureOpts = {}): DrawingDocument {
  const assets = o.assets ?? [{ id: 'logo', name: 'logo.png', contentType: 'image/png', bytes: png(4, 4, 6) }]
  return {
    schemaVersion: 1, id: 'dwg-1', name: 'Mounting plate', author: {},
    source: { modelItemId: 'm1', documentId: 'd1', lineageId: 'l1', kind: 'mesh', observedRevision: REV },
    createdAt: '2026-03-04T12:00:00.000Z', editedAt: '2026-03-05T18:30:00.000Z', sourceEditedAt: '2026-03-06T03:00:00.000Z',
    template: {
      templateId: 'starter-landscape-mm', revision: '3', fields: { partNumber: 'PN-100', revision: 'B', drawnBy: 'A. Machinist', branding: 'SAMPLE SHOP' },
      overrides: { title: 'SHOP TITLE' }, assetIds: assets.map(a => a.id),
      // the table was edited to +/-0.10 at two decimals after the pinned dimension below took 0.05
      generalTolerances: { linearByDecimalPlaces: { '0': 0.5, '1': 0.1, '2': 0.1, '3': 0.01 }, angularDegrees: 0.5 }, dateDisplayZone: 'America/Chicago',
    },
    assets: assets.map(a => ({ id: a.id, name: a.name, contentType: a.contentType, dataBase64: b64(a.bytes) })),
    sheets: [{
      id: 's1', sizeMm: o.size ?? [279.4, 215.9], marginsMm: 10, projection: 'third-angle', unit: o.unit ?? 'mm', precision: o.precision ?? 2,
      views: [
        { id: 'front', frame: standardViewFrame('front'), scale: o.scale ?? { numerator: 1, denominator: 2 }, sheetOriginMm: [60, 130], showHidden: true },
        {
          id: 'detail', frame: standardViewFrame('front'), scale: { numerator: 2, denominator: 1 }, sheetOriginMm: [130, 165], showHidden: false, label: 'B',
          detail: { parentViewId: 'front', centerLocalMm: [50, 0, 30], radiusMm: 15, magnification: { numerator: 2, denominator: 1 } },
        },
      ],
    }],
    references: [],
    annotations: [
      dimension('dim-length', { tolerance: { kind: 'bilateral', upper: 0.1, lower: -0.05 }, lastGood: { value: 100, unit: 'mm', measuredAt: REV } }),
      dimension('dim-height', { lastGood: { value: 42.5, unit: 'mm', measuredAt: OLD_REV } }),
      dimension('dim-dia', { measurement: 'diameter', lastGood: { value: 20, unit: 'mm', measuredAt: REV } }),
      dimension('dim-angle', { measurement: 'angle', lastGood: { value: 45, unit: 'deg', measuredAt: REV } }),
      dimension('dim-unplaced', { lastGood: { value: 7, unit: 'mm', measuredAt: REV } }),
      dimension('dim-pinned', { tolerance: { kind: 'general', tableKey: '2', templateRevision: '2', value: 0.05 }, lastGood: { value: 100, unit: 'mm', measuredAt: REV }, labelSheetMm: [150, 110] }),
      dimension('dim-table', { tolerance: { kind: 'general', tableKey: '2', templateRevision: '3', value: 0.1 }, lastGood: { value: 30, unit: 'mm', measuredAt: REV }, labelSheetMm: [150, 125] }),
      dimension('dim-mesh', { lastGood: { value: 30, unit: 'mm', measuredAt: REV }, labelSheetMm: [200, 50] }),
      { kind: 'balloon', id: 'b1', number: 3, anchorSheetMm: [60, 100], labelSheetMm: [100, 90] },
      { kind: 'note', id: 'n1', text: 'HOLE ⌀ 20 ± 0.1 AT 45°', anchorSheetMm: [20, 40] },
      { kind: 'note', id: 'n2', text: 'SHAPE 世', anchorSheetMm: [20, 55] },
    ],
  }
}

const RENDERS: Record<string, AnnotationRender> = {
  'dim-length': { state: 'current', valueMm: 100, linear: { from: [60, 130], to: [110, 130], offsetMm: 16 } },
  'dim-height': { state: 'stale', reason: 'not-found', linear: { from: [110, 130], to: [110, 100], offsetMm: 14 } },
  'dim-dia': { state: 'current', valueMm: 20, radial: { center: [85, 115], radiusMm: 5, angleDeg: 140 } },
  'dim-angle': { state: 'current', valueMm: 45, angular: { vertex: [150, 80], fromDeg: 0, toDeg: 45, radiusMm: 18 } },
  'dim-unplaced': { state: 'missing', reason: 'deleted' },
  'dim-mesh': { state: 'current', valueMm: 30, approximate: { maxDeviationMm: 0.12 } },
  'dim-pinned': { state: 'current', valueMm: 100 },
  'dim-table': { state: 'current', valueMm: 30 },
  b1: { state: 'current' },
}

function inputs(over: Partial<SceneInputs> = {}): SceneInputs {
  return { projections: { front: plateProjection() }, annotations: RENDERS, ...over }
}

// -- an independent PDF reader --------------------------------------------------------

const PT = 72 / 25.4

interface ReadPath { op: 'S' | 'f' | 'f*'; subpaths: Array<Array<[number, number]>>; closed: boolean[]; widthMm: number; dash: number[]; actualText?: string }
interface ReadImage { name: string; width: number; height: number; colorSpace: string; hasSMask: boolean; filter: string; rectMm: [number, number, number, number] }
interface ReadPdf { mediaMm: [number, number]; info: Record<string, string>; paths: ReadPath[]; images: ReadImage[]; actualTexts: string[] }

function latin1(bytes: Uint8Array, from = 0, to = bytes.length): string {
  let s = ''
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i])
  return s
}

function hexText(hex: string): string {
  const units = hex.replace(/\s/g, '').match(/.{4}/g) ?? []
  return units.map(u => String.fromCharCode(parseInt(u, 16))).join('').replace(/^\uFEFF/, '')
}

function readPdf(bytes: Uint8Array): ReadPdf {
  const text = latin1(bytes)
  expect(text.startsWith('%PDF-')).toBe(true)
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1])
  const xref = text.slice(startxref)
  expect(xref.startsWith('xref')).toBe(true)
  const count = Number(/^xref\s+0\s+(\d+)/.exec(xref)![1])
  const entries = [...xref.matchAll(/(\d{10}) (\d{5}) ([nf]) /g)].slice(0, count)
  const offsets = entries.map(e => Number(e[1]))
  const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(xref)![1]
  expect(Number(/\/Size (\d+)/.exec(trailer)![1])).toBe(count)
  const obj = (n: number) => {
    const at = offsets[n]
    const head = new RegExp(`^${n} 0 obj\\n`).exec(text.slice(at, at + 40))
    expect(head, `object ${n} sits where the xref says`).not.toBeNull()
    const bodyStart = at + head![0].length
    const end = text.indexOf('\nendobj', bodyStart)
    const dictEnd = text.indexOf('stream\n', bodyStart)
    const hasStream = dictEnd >= 0 && dictEnd < end
    const dict = text.slice(bodyStart, hasStream ? dictEnd : end)
    if (!hasStream) return { dict, data: null as Uint8Array | null }
    const len = Number(/\/Length (\d+)/.exec(dict)![1])
    const s0 = dictEnd + 'stream\n'.length
    expect(text.slice(s0 + len, s0 + len + 10)).toBe('\nendstream')
    return { dict, data: bytes.subarray(s0, s0 + len) }
  }
  const root = Number(/\/Root (\d+) 0 R/.exec(trailer)![1])
  const catalog = obj(root).dict
  const pagesNo = Number(/\/Pages (\d+) 0 R/.exec(catalog)![1])
  const pages = obj(pagesNo).dict
  expect(Number(/\/Count (\d+)/.exec(pages)![1])).toBe(1)
  const pageNo = Number(/\/Kids \[(\d+) 0 R\]/.exec(pages)![1])
  const page = obj(pageNo).dict
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page)!
  const mediaPt: [number, number] = [Number(box[1]), Number(box[2])]
  const info: Record<string, string> = {}
  const infoNo = /\/Info (\d+) 0 R/.exec(trailer)
  if (infoNo) {
    const d = obj(Number(infoNo[1])).dict
    for (const m of d.matchAll(/\/(\w+) (?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f]+)>)/g)) info[m[1]] = m[3] !== undefined ? hexText(m[3]) : m[2].replace(/\\(.)/g, '$1')
  }
  const xobjects: Record<string, number> = {}
  for (const m of page.matchAll(/\/(Im\d+) (\d+) 0 R/g)) xobjects[m[1]] = Number(m[2])
  const content = obj(Number(/\/Contents (\d+) 0 R/.exec(page)![1]))
  const stream = /FlateDecode/.test(content.dict) ? unzlibSync(content.data!) : content.data!
  const src = latin1(stream)

  // marked content: `/Span << /ActualText <HEX> >> BDC` -> a token carrying the logical string
  const prepared = src.replace(/\/Span << \/ActualText <([0-9A-Fa-f]+)> >> BDC/g, (_m, h: string) => `BDC_TEXT ${h} BDC`)
  const tokens = prepared.split(/\s+/).filter(Boolean)
  const stack: number[][] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const mul = (m: number[], n: number[]) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ]
  // a PDF matrix [a b c d e f] maps (x y) -> (a x + c y + e, b x + d y + f); `cm` pre-multiplies the CTM
  const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const toMm = (x: number, y: number): [number, number] => {
    const [px, py] = apply(ctm, x, y)
    return [px / PT, (mediaPt[1] - py) / PT]
  }
  let width = 1, dash: number[] = [], actual: string | undefined
  const operands: string[] = []
  let cur: Array<[number, number]> = []
  let subs: Array<Array<[number, number]>> = []
  let closed: boolean[] = []
  let last: [number, number] = [0, 0]
  const paths: ReadPath[] = []
  const images: ReadImage[] = []
  const actualTexts: string[] = []
  const finishSub = (isClosed: boolean) => { if (cur.length) { subs.push(cur); closed.push(isClosed) } cur = [] }
  const num = (i: number) => Number(operands[i])
  const emit = (op: 'S' | 'f' | 'f*') => {
    finishSub(false)
    const scaleMm = Math.hypot(ctm[0], ctm[1]) / PT
    paths.push({ op, subpaths: subs, closed, widthMm: width * scaleMm, dash: dash.map(d => d * scaleMm), actualText: actual })
    subs = []; closed = []
  }
  for (const t of tokens) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) || t.startsWith('/') || t.startsWith('[') || t.endsWith(']') || /^[0-9A-Fa-f]+$/.test(t) && operands[operands.length - 1] === 'BDC_TEXT') { operands.push(t); continue }
    switch (t) {
      case 'BDC_TEXT': operands.push(t); continue
      case 'q': stack.push(ctm); break
      case 'Q': ctm = stack.pop()!; break
      case 'cm': ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); break
      case 'w': width = num(0); break
      case 'd': dash = (/\[([^\]]*)\]/.exec(operands.join(' '))?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number); break
      case 'J': case 'j': break
      case 'm': finishSub(false); last = [num(0), num(1)]; cur = [toMm(...last)]; break
      case 'l': last = [num(0), num(1)]; cur.push(toMm(...last)); break
      case 'c': {
        const p0 = last, p1: [number, number] = [num(0), num(1)], p2: [number, number] = [num(2), num(3)], p3: [number, number] = [num(4), num(5)]
        for (let i = 1; i <= 24; i++) {
          const s = i / 24, u = 1 - s
          cur.push(toMm(u * u * u * p0[0] + 3 * u * u * s * p1[0] + 3 * u * s * s * p2[0] + s * s * s * p3[0], u * u * u * p0[1] + 3 * u * u * s * p1[1] + 3 * u * s * s * p2[1] + s * s * s * p3[1]))
        }
        last = p3
        break
      }
      case 'h': finishSub(true); break
      case 'S': emit('S'); break
      case 'f': emit('f'); break
      case 'f*': emit('f*'); break
      case 'BDC': {
        const hex = operands[operands.indexOf('BDC_TEXT') + 1]
        actual = hexText(hex)
        actualTexts.push(actual)
        break
      }
      case 'EMC': actual = undefined; break
      case 'Do': {
        const name = operands[0].slice(1)
        const o = obj(xobjects[name])
        const unit = [toMm(0, 0), toMm(1, 0), toMm(0, 1)]
        const wmm = Math.hypot(unit[1][0] - unit[0][0], unit[1][1] - unit[0][1])
        const hmm = Math.hypot(unit[2][0] - unit[0][0], unit[2][1] - unit[0][1])
        const xs = [unit[0][0], unit[1][0], unit[2][0]], ys = [unit[0][1], unit[1][1], unit[2][1]]
        images.push({
          name, width: Number(/\/Width (\d+)/.exec(o.dict)![1]), height: Number(/\/Height (\d+)/.exec(o.dict)![1]),
          colorSpace: /\/ColorSpace (\/\w+|\[[^\]]*\])/.exec(o.dict)![1], hasSMask: /\/SMask/.test(o.dict), filter: /\/Filter \/(\w+)/.exec(o.dict)![1],
          rectMm: [Math.min(...xs), Math.min(...ys), wmm, hmm],
        })
        break
      }
      default: break
    }
    operands.length = 0
  }
  return { mediaMm: [mediaPt[0] / PT, mediaPt[1] / PT], info, paths, images, actualTexts }
}

// -- an independent DXF reader ----------------------------------------------------------

interface DxfEnt { type: string; layer: string; codes: Array<[number, string]> }
interface ReadDxf { header: Record<string, Array<[number, string]>>; layers: string[]; entities: DxfEnt[]; objects: DxfEnt[]; classes: string[]; blockNames: string[] }

function readDxf(dxf: string): ReadDxf {
  const raw = dxf.split(/\r?\n/)
  const pairs: Array<[number, string]> = []
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([Number(raw[i].trim()), raw[i + 1]])
  expect(pairs[pairs.length - 1]).toEqual([0, 'EOF'])
  const out: ReadDxf = { header: {}, layers: [], entities: [], objects: [], classes: [], blockNames: [] }
  let section = ''
  let table = ''
  let curEnt: DxfEnt | null = null
  let hv: string | null = null
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i]
    if (c === 0 && v === 'SECTION') { section = pairs[i + 1][1]; i++; continue }
    if (c === 0 && v === 'ENDSEC') { section = ''; curEnt = null; continue }
    if (section === 'HEADER') {
      if (c === 9) { hv = v; out.header[v] = []; continue }
      if (hv) out.header[hv].push([c, v])
      continue
    }
    if (section === 'CLASSES') { if (c === 1) out.classes.push(v); continue }
    if (c === 0) {
      if (section === 'TABLES') { if (v === 'TABLE') { table = pairs[i + 1][1]; i++; curEnt = null; continue } if (v === 'ENDTAB') { curEnt = null; continue } }
      curEnt = { type: v, layer: '', codes: [] }
      if (section === 'ENTITIES') out.entities.push(curEnt)
      else if (section === 'OBJECTS') out.objects.push(curEnt)
      else if (section === 'BLOCKS' && v === 'BLOCK') out.blockNames.push('')
      continue
    }
    if (!curEnt) continue
    curEnt.codes.push([c, v])
    if (c === 8) curEnt.layer = v
    if (section === 'TABLES' && table === 'LAYER' && curEnt.type === 'LAYER' && c === 2) out.layers.push(v)
    if (section === 'BLOCKS' && curEnt.type === 'BLOCK' && c === 2) out.blockNames[out.blockNames.length - 1] = v
  }
  return out
}

function codesOf(e: DxfEnt, code: number): number[] {
  return e.codes.filter(([c]) => c === code).map(([, v]) => Number(v))
}

/** Geometry of one DXF entity in SHEET mm (Y down), from its own group codes. */
function dxfPoints(e: DxfEnt, sheetH: number): Array<[number, number]> {
  if (e.type === 'LINE') return [[codesOf(e, 10)[0], sheetH - codesOf(e, 20)[0]], [codesOf(e, 11)[0], sheetH - codesOf(e, 21)[0]]]
  if (e.type === 'LWPOLYLINE') {
    const xs = codesOf(e, 10), ys = codesOf(e, 20)
    const pts = xs.map((x, i) => [x, sheetH - ys[i]] as [number, number])
    if ((codesOf(e, 70)[0] & 1) === 1) pts.push(pts[0])
    return pts
  }
  return []
}

function xdataText(e: DxfEnt): string | undefined {
  const i = e.codes.findIndex(([c, v]) => c === 1001 && v === 'LIENCAM')
  if (i < 0) return undefined
  const t = e.codes.slice(i).find(([c, v]) => c === 1000 && v.startsWith('text:'))
  return t ? t[1].slice(5).replace(/\\U\+([0-9A-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : undefined
}

const len = (pts: Array<[number, number]>) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0)
const bbox = (pts: Array<[number, number]>) => {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

function exportBoth(doc: DrawingDocument, inp: SceneInputs = inputs()) {
  const scene = buildSheetScene(doc, inp)
  const pdf = exportDrawingPdf(scene)
  const dxf = exportDrawingDxf(scene)
  return { scene, pdf, dxf, readPdf: readPdf(pdf.bytes), readDxf: readDxf(dxf.dxf) }
}

// A front-view plate edge: u 0..100 at 1:s lands at x 60 + u*k on the sheet, y 130 - v*k.
const K = (s: { numerator: number; denominator: number }) => s.numerator / s.denominator

// -- the tests ---------------------------------------------------------------------------------

describe('sheet size and scale, read back from the files', () => {
  const cases: Array<[string, [number, number], { numerator: number; denominator: number }]> = [
    ['Letter landscape 1:1', [279.4, 215.9], { numerator: 1, denominator: 1 }],
    ['Letter landscape 1:2', [279.4, 215.9], { numerator: 1, denominator: 2 }],
    ['A4 landscape 1:2', [297, 210], { numerator: 1, denominator: 2 }],
    ['A4 portrait 2:1', [210, 297], { numerator: 2, denominator: 1 }],
  ]
  for (const [name, size, scale] of cases) {
    it(`${name}: the PDF page and the DXF limits are the declared sheet, and a 100 mm edge is ${100 * K(scale)} mm on paper`, () => {
      const r = exportBoth(makeDoc({ size, scale }))
      // declared size within 0.1 mm (plan section 5)
      expect(r.readPdf.mediaMm[0]).toBeCloseTo(size[0], 1)
      expect(r.readPdf.mediaMm[1]).toBeCloseTo(size[1], 1)
      expect(Math.abs(r.readPdf.mediaMm[0] - size[0])).toBeLessThan(0.1)
      expect(Math.abs(r.readPdf.mediaMm[1] - size[1])).toBeLessThan(0.1)
      const limMax = r.readDxf.header.$LIMMAX
      expect(Number(limMax.find(([c]) => c === 10)![1])).toBeCloseTo(size[0], 4)
      expect(Number(limMax.find(([c]) => c === 20)![1])).toBeCloseTo(size[1], 4)
      expect(r.readDxf.header.$INSUNITS).toEqual([[70, '4']])
      expect(r.readDxf.header.$ACADVER).toEqual([[1, 'AC1015']])

      const k = K(scale)
      // PDF: the plate's outline is the closed 5-point stroke whose box is 100k x 60k at the view origin
      const outline = r.readPdf.paths.find(p => p.op === 'S' && p.subpaths.some(s => s.length === 5 && Math.abs(bbox(s).w - 100 * k) < 0.01 && Math.abs(bbox(s).h - 60 * k) < 0.01))!
      expect(outline).toBeDefined()
      const edge = outline.subpaths.find(s => s.length === 5)!
      expect(len(edge.slice(0, 2))).toBeCloseTo(100 * k, 2)
      expect(bbox(edge).x0).toBeCloseTo(60, 2)
      expect(bbox(edge).y1).toBeCloseTo(130, 2)
      // DXF: the same edge, on VISIBLE
      const dxfOutline = r.readDxf.entities.find(e => e.layer === 'VISIBLE' && e.type === 'LWPOLYLINE' && dxfPoints(e, size[1]).length === 5 && Math.abs(bbox(dxfPoints(e, size[1])).w - 100 * k) < 0.01)!
      expect(dxfOutline).toBeDefined()
      const dp = dxfPoints(dxfOutline, size[1])
      expect(len(dp.slice(0, 2))).toBeCloseTo(100 * k, 4)
      expect(bbox(dp).x0).toBeCloseTo(60, 4)
      expect(bbox(dp).y1).toBeCloseTo(130, 4)
    })
  }
})

describe('layers and line classes in the DXF', () => {
  it('names VISIBLE, HIDDEN, CENTER, DIMENSION and TEXT, and puts each line class on its own layer', () => {
    const r = exportBoth(makeDoc())
    for (const l of ['VISIBLE', 'HIDDEN', 'CENTER', 'DIMENSION', 'TEXT']) expect(r.readDxf.layers).toContain(l)
    const hidden = r.readDxf.entities.filter(e => e.layer === 'HIDDEN')
    expect(hidden).toHaveLength(1)
    const hp = dxfPoints(hidden[0], 215.9)
    expect(len(hp)).toBeCloseTo(40, 4) // 80 mm hidden line at 1:2
    expect(r.readDxf.entities.some(e => e.layer === 'CENTER')).toBe(true)
    expect(r.readDxf.entities.some(e => e.layer === 'DIMENSION')).toBe(true)
    expect(r.readDxf.entities.some(e => e.layer === 'TEXT')).toBe(true)
    // dashed in the PDF: the hidden line is the 0.18 mm dashed stroke
    expect(r.readPdf.paths.some(p => p.op === 'S' && p.dash.length === 2 && Math.abs(p.dash[0] - 2) < 0.01)).toBe(true)
  })

  it('a view with showHidden off draws no hidden lines', () => {
    const doc = makeDoc()
    doc.sheets[0].views[0].showHidden = false
    const r = exportBoth(doc)
    expect(r.readDxf.entities.filter(e => e.layer === 'HIDDEN')).toHaveLength(0)
    expect(r.readPdf.paths.some(p => p.dash.length === 2 && Math.abs(p.dash[0] - 2) < 0.01)).toBe(false)
  })

  it('writes no DIMENSION or TEXT entity: static, exploded geometry only', () => {
    const r = exportBoth(makeDoc())
    expect(new Set(r.readDxf.entities.map(e => e.type))).toEqual(new Set(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC']))
  })
})

describe('curves stay within 0.05 mm of the true curve on paper', () => {
  for (const [label, size, scale] of [
    ['Letter 1:1', [279.4, 215.9], { numerator: 1, denominator: 1 }],
    ['A4 1:2', [297, 210], { numerator: 1, denominator: 2 }],
    ['Letter 2:1', [279.4, 215.9], { numerator: 2, denominator: 1 }],
  ] as const) {
    it(`${label}: the 20 mm hole, read back from the PDF and the DXF`, () => {
      const r = exportBoth(makeDoc({ size: [...size], scale }))
      const k = K(scale)
      const centre: [number, number] = [60 + 50 * k, 130 - 30 * k]
      const rTrue = 10 * k
      const near = (pts: Array<[number, number]>) => pts.length > 50 && Math.abs(bbox(pts).w - 2 * rTrue) < 0.05
      const pdfRing = r.readPdf.paths.flatMap(p => p.subpaths).find(near)!
      const dxfRing = r.readDxf.entities.filter(e => e.type === 'LWPOLYLINE').map(e => dxfPoints(e, size[1])).find(near)!
      for (const pts of [pdfRing, dxfRing]) {
        expect(pts).toBeDefined()
        // every vertex sits on the circle, and the chord between neighbours sags less than 0.05 mm
        let worstVertex = 0, worstSag = 0
        for (let i = 0; i < pts.length - 1; i++) {
          worstVertex = Math.max(worstVertex, Math.abs(Math.hypot(pts[i][0] - centre[0], pts[i][1] - centre[1]) - rTrue))
          const mid: [number, number] = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]
          worstSag = Math.max(worstSag, rTrue - Math.hypot(mid[0] - centre[0], mid[1] - centre[1]))
        }
        expect(worstVertex).toBeLessThan(0.001)
        expect(worstSag).toBeLessThan(0.05)
      }
      expect(r.scene.maxChordErrorMm).toBeLessThanOrEqual(0.05)
    })
  }

  it('a coarse projection reports its sheet-space chord error instead of hiding it', () => {
    const scene = buildSheetScene(makeDoc({ scale: { numerator: 1, denominator: 1 } }), inputs({ projections: { front: plateProjection(0.2) } }))
    // 0.2 model mm at the 2:1 detail view is 0.4 mm on paper: the worst view is the one reported
    expect(scene.maxChordErrorMm).toBeCloseTo(0.4, 6)
  })

  it('exact circles and arcs keep their analytic form: the DXF holds CIRCLE/ARC with the true radius, and the PDF curves stay on it', () => {
    const r = exportBoth(makeDoc())
    const circles = r.readDxf.entities.filter(e => e.type === 'CIRCLE')
    expect(circles.some(c => Math.abs(codesOf(c, 40)[0] - 3.5) < 1e-6)).toBe(true) // balloon
    expect(circles.some(c => Math.abs(codesOf(c, 40)[0] - 30) < 1e-6)).toBe(true) // detail ring, 15 mm at 2:1
    const arcs = r.readDxf.entities.filter(e => e.type === 'ARC')
    expect(arcs).toHaveLength(1)
    expect(codesOf(arcs[0], 40)[0]).toBeCloseTo(18, 6)
    expect(codesOf(arcs[0], 50)[0]).toBeCloseTo(0, 6)
    expect(codesOf(arcs[0], 51)[0]).toBeCloseTo(45, 6)
    // the balloon in the PDF: a closed Bezier ring around its saved label position (100, 90), radius 3.5, within 0.002 mm
    const balloon = r.readPdf.paths.flatMap(p => p.subpaths).find(s => s.length > 90 && Math.abs(bbox(s).w - 7) < 0.01)!
    expect(balloon).toBeDefined()
    const c: [number, number] = [100, 90]
    for (const p of balloon) expect(Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - 3.5)).toBeLessThan(0.002) // a cubic circle is 0.03% of r off by construction
  })
})

describe('text, tolerances and stale references', () => {
  it('a stale dimension carries STALE, its reason, the last-known value and the last-known revision, in the scene, the PDF and the DXF', () => {
    const r = exportBoth(makeDoc())
    const want = ['42.50', 'STALE - NOT FOUND', 'LAST KNOWN REV 99887766']
    const sceneTexts = r.scene.items.filter(i => i.kind === 'text' && i.ownerId === 'dim-height').map(i => (i.kind === 'text' ? i.text : ''))
    const dxfTexts = r.readDxf.entities.map(xdataText).filter((t): t is string => t !== undefined)
    for (const w of want) {
      expect(sceneTexts).toContain(w)
      expect(r.readPdf.actualTexts).toContain(w)
      expect(dxfTexts).toContain(w)
    }
    // and the export notes say it in a sentence
    expect(r.scene.issues.find(i => i.ownerId === 'dim-height')!.message).toBe('Dimension dim-height is stale (not found); the sheet shows its last-known value.')
  })

  it('never prints a stale dimension as a clean current value', () => {
    const r = exportBoth(makeDoc())
    const label = dimensionLabel(makeDoc().annotations.find(a => a.id === 'dim-height') as DrawingDimension, { unit: 'mm', precision: 2 }, RENDERS['dim-height'])
    expect(label.lastKnown).toBe(true)
    // the only number printed for it is the last-known one, never a fresh value passed in the render
    const fresh = { ...RENDERS['dim-height'], valueMm: 61.23 }
    const again = dimensionLabel(makeDoc().annotations.find(a => a.id === 'dim-height') as DrawingDimension, { unit: 'mm', precision: 2 }, fresh)
    expect(again.main).toBe('42.50')
    expect(r.readPdf.actualTexts).not.toContain('61.23')
  })

  it('a dimension with no check carries UNRESOLVED and its last-known value; one with no value says NO VALUE', () => {
    const doc = makeDoc()
    const r = exportBoth(doc, inputs({ annotations: {} }))
    expect(r.readPdf.actualTexts).toContain('UNRESOLVED')
    const none = dimensionLabel(dimension('x'), { unit: 'mm', precision: 2 }, { state: 'missing', reason: 'deleted' })
    expect(none.main).toBe('NO VALUE')
    expect(none.notes).toContain('LAST KNOWN: NONE')
  })

  it('an unplaced dimension is listed in the export notes instead of vanishing', () => {
    const r = exportBoth(makeDoc())
    expect(r.readPdf.actualTexts.join(' ')).toContain('UNPLACED dim-unplaced: 7.00 (MISSING - DELETED; LAST KNOWN REV a1b2c3d4)')
    expect(r.readPdf.actualTexts).toContain('EXPORT NOTES')
  })

  it('a mesh-fit dimension says APPROX and the fit deviation beside the value', () => {
    const r = exportBoth(makeDoc())
    expect(r.readPdf.actualTexts).toContain('APPROX +/-0.12 FIT')
    expect(r.readDxf.entities.map(xdataText)).toContain('APPROX +/-0.12 FIT')
  })

  it('tolerance intent is shown stacked: +0.10 over -0.05 for a bilateral dimension, in both files', () => {
    const r = exportBoth(makeDoc())
    for (const t of ['100.00', '+0.10', '-0.05']) {
      expect(r.readPdf.actualTexts).toContain(t)
      expect(r.readDxf.entities.map(xdataText)).toContain(t)
    }
    // upper above lower on paper: measured from the glyph outlines
    const upper = r.readPdf.paths.find(p => p.actualText === '+0.10' && p.op === 'f*')!
    const lower = r.readPdf.paths.find(p => p.actualText === '-0.05' && p.op === 'f*')!
    expect(bbox(upper.subpaths.flat()).y0).toBeLessThan(bbox(lower.subpaths.flat()).y0)
  })

  it('limits, general and reference tolerances read as the editor shows them', () => {
    const base = dimension('d', { lastGood: { value: 12.5, unit: 'mm', measuredAt: REV } })
    const cur: AnnotationRender = { state: 'current', valueMm: 12.5 }
    const sheet = { unit: 'mm' as const, precision: 2 }
    const limits = dimensionLabel({ ...base, tolerance: { kind: 'limits', lower: 12.4, upper: 12.6 } }, sheet, cur)
    expect(limits.tolerance).toEqual(['12.60', '12.40'])
    const pinned = { ...base, tolerance: { kind: 'general' as const, tableKey: '2', templateRevision: '1', value: 0.05 } }
    expect(dimensionLabel(pinned, sheet, cur, 0.1).main).toBe('12.50 \u00b10.05')
    expect(dimensionLabel(pinned, sheet, cur, 0.05).main).toBe('12.50')
    expect(dimensionLabel({ ...base, tolerance: { kind: 'reference' } }, sheet, cur).main).toBe('(12.50)')
  })

  it('inches: the value converts for display, the stored limits never change, and neither does a changed precision rewrite them', () => {
    const doc = makeDoc({ unit: 'inch', precision: 3 })
    const before = JSON.stringify(doc)
    const r = exportBoth(doc)
    expect(JSON.stringify(doc)).toBe(before)
    expect(r.readPdf.actualTexts).toContain('3.937') // 100 mm
    expect(r.readPdf.actualTexts).toContain('+0.0039') // 0.1 mm, as the editor shows it
    expect(r.readPdf.actualTexts).toContain('-0.0020') // -0.05 mm
    // sheet space is still millimetres: the page and the DXF units do not change
    expect(r.readDxf.header.$INSUNITS).toEqual([[70, '4']])
    expect(Math.abs(r.readPdf.mediaMm[0] - 279.4)).toBeLessThan(0.1)
    // a different precision shows different digits for the same stored value
    const p4 = exportBoth(makeDoc({ unit: 'inch', precision: 4 }))
    expect(p4.readPdf.actualTexts).toContain('3.9370')
    expect(doc.annotations.find(a => a.id === 'dim-length')).toMatchObject({ tolerance: { kind: 'bilateral', upper: 0.1, lower: -0.05 } })
  })

  it('the diameter, plus-minus and degree symbols are drawn as geometry even though the bundled font lacks them', () => {
    const r = exportBoth(makeDoc())
    const note = 'HOLE ⌀ 20 ± 0.1 AT 45°'
    expect(r.readPdf.actualTexts).toContain(note)
    expect(r.readDxf.entities.map(xdataText)).toContain(note)
    // the dimension labels carry the same symbols
    expect(r.readPdf.actualTexts).toContain('\u230020.00')
    expect(r.readPdf.actualTexts).toContain('45.00\u00b0')
    // measured: the note's diameter sign is a 25-point ring about 0.7 cap-heights wide, its degree sign a smaller ring
    const strokes = r.readPdf.paths.filter(p => p.op === 'S' && p.actualText === note).flatMap(p => p.subpaths)
    const rings = strokes.filter(s => s.length === 25).map(s => bbox(s).w).sort((a, b) => b - a)
    expect(rings).toHaveLength(2)
    expect(rings[0]).toBeGreaterThan(2.2)
    expect(rings[0]).toBeLessThan(2.5)
    expect(rings[1]).toBeLessThan(1.2)
  })

  it('outlined text has the size it was asked for: a 3.5 mm label measures 3.5 mm tall on paper', () => {
    const r = exportBoth(makeDoc())
    const label = r.readPdf.paths.find(p => p.op === 'f*' && p.actualText === '100.00')!
    const box = bbox(label.subpaths.flat())
    expect(box.h).toBeGreaterThan(3.0)
    expect(box.h).toBeLessThan(3.9)
    expect(box.w).toBeGreaterThan(8)
  })

  it('a character no font has is named, drawn as an empty box, and listed in the notes', () => {
    const r = exportBoth(makeDoc())
    const issue = r.scene.issues.find(i => i.kind === 'missing-glyph')!
    expect(issue.ownerId).toBe('n2')
    expect(issue.message).toBe('No font has "世" (U+4E16), so it is drawn as an empty box in "SHAPE 世".')
    // the box: an open 5-point stroke in the note's text item
    const note = r.scene.items.find(i => i.kind === 'text' && i.ownerId === 'n2')!
    expect(note.kind === 'text' && note.strokes.some(s => s.length === 5)).toBe(true)
  })
})

describe('one document revision everywhere', () => {
  it('the scene, the PDF and the DXF carry the same revision, and the title block prints its short form', () => {
    const r = exportBoth(makeDoc())
    const rev = 'dwg-1@a1b2c3d4e5f60718'
    expect(r.scene.revision).toBe(rev)
    expect(r.readPdf.info.Subject).toBe(rev)
    expect(r.readDxf.header.$PROJECTNAME).toEqual([[1, rev]])
    const titleRev = (t: string) => t.startsWith('DWG REV a1b2c3d4')
    expect(r.readPdf.actualTexts.some(titleRev)).toBe(true)
    expect(r.readDxf.entities.map(xdataText).some(t => t !== undefined && titleRev(t))).toBe(true)
  })

  it('a different geometry fingerprint is a different revision in all three', () => {
    const doc = makeDoc()
    doc.source.observedRevision = OLD_REV
    const r = exportBoth(doc)
    expect(r.scene.revision).toBe('dwg-1@99887766aabbccdd')
    expect(r.readPdf.info.Subject).toBe(r.scene.revision)
    expect(r.readDxf.header.$PROJECTNAME).toEqual([[1, r.scene.revision]])
  })

  it('the same document gives the same bytes; a timestamp appears only when one is asked for', () => {
    const doc = makeDoc()
    const a = exportDrawingPdf(buildSheetScene(doc, inputs()))
    const b = exportDrawingPdf(buildSheetScene(doc, inputs()))
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
    expect(readPdf(a.bytes).info.CreationDate).toBeUndefined()
    const stamped = readPdf(exportDrawingPdf(buildSheetScene(doc, inputs({ exportTimestamp: '2026-10-21T06:30:00Z' }))).bytes)
    expect(stamped.info.CreationDate).toBe('D:20261021063000Z')
    expect(stamped.actualTexts.some(t => t.includes('2026-10-21T06:30:00Z'))).toBe(true)
  })
})

describe('detail views crop in source space', () => {
  it('every line of the detail view lies inside its ring, and the ring radius is the crop radius times the scale', () => {
    const r = exportBoth(makeDoc())
    const detailRing = r.scene.items.find(i => i.kind === 'circle' && i.layer === 'VISIBLE')!
    expect(detailRing.kind === 'circle' && detailRing.radiusMm).toBeCloseTo(30, 9)
    const c = detailRing.kind === 'circle' ? detailRing.center : [0, 0]
    // centre of the hole at 2:1 from origin (130,165): (130 + 50*2, 165 - 30*2)
    expect(c[0]).toBeCloseTo(230, 9)
    expect(c[1]).toBeCloseTo(105, 9)
    const inside = r.readDxf.entities.filter(e => e.layer === 'VISIBLE' && e.type !== 'CIRCLE').flatMap(e => dxfPoints(e, 215.9)).filter(p => p[0] > 175)
    expect(inside.length).toBeGreaterThan(10)
    for (const p of inside) expect(Math.hypot(p[0] - c[0], p[1] - c[1])).toBeLessThanOrEqual(30 + 1e-6)
    // the hole (r 10 -> 20 at 2:1) is whole inside; the plate edge (35 mm away at 2:1) is cut off
    expect(r.readPdf.actualTexts).toContain('DETAIL B (2:1)') // the saved letter, not the first free one
    expect(r.readPdf.actualTexts).toContain('B')
    expect(r.readPdf.actualTexts).not.toContain('DETAIL A (2:1)')
  })
})

describe('branding', () => {
  it('PDF: the logo is an embedded image at the planned place, with its alpha kept', () => {
    const r = exportBoth(makeDoc())
    expect(r.readPdf.images).toHaveLength(1)
    const img = r.readPdf.images[0]
    expect(img.width).toBe(4)
    expect(img.height).toBe(4)
    expect(img.hasSMask).toBe(true)
    expect(img.colorSpace).toBe('/DeviceRGB')
    const planned = r.scene.images[0].rectMm
    for (let i = 0; i < 4; i++) expect(img.rectMm[i]).toBeCloseTo(planned[i], 3)
    expect(planned[2]).toBeGreaterThan(0)
  })

  it('PDF: an opaque PNG is carried through with PNG predictors, bytes unchanged', () => {
    const r = exportBoth(makeDoc({ assets: [{ id: 'logo', name: 'logo.png', contentType: 'image/png', bytes: png(6, 3, 2) }] }))
    expect(r.readPdf.images[0]).toMatchObject({ width: 6, height: 3, hasSMask: false, filter: 'FlateDecode' })
  })

  it('DXF vector-only (the default): an empty frame, LOGO OMITTED, and a note that says so', () => {
    const r = exportBoth(makeDoc())
    expect(r.dxf.companions).toEqual([])
    expect(r.dxf.notes).toEqual(['Branding "logo.png" is not in this vector-only DXF; an empty frame marks where it goes. Export with the companion image bundle to keep it.'])
    expect(r.readDxf.entities.map(xdataText)).toContain('LOGO OMITTED')
    expect(r.readDxf.entities.some(e => e.type === 'IMAGE')).toBe(false)
  })

  it('DXF companion bundle: an IMAGE with a relative path to a file that comes back byte for byte', () => {
    const asset = png(4, 4, 6)
    const doc = makeDoc({ assets: [{ id: 'logo', name: 'my logo.png', contentType: 'image/png', bytes: asset }] })
    const scene = buildSheetScene(doc, inputs())
    const out = exportDrawingDxf(scene, { branding: 'companion', fileStem: 'plate' })
    const read = readDxf(out.dxf)
    expect(out.notes).toEqual([])
    expect(out.companions).toHaveLength(1)
    expect(out.companions[0].path).toBe('plate-assets/my_logo.png')
    expect(Buffer.from(out.companions[0].bytes).equals(Buffer.from(asset))).toBe(true)
    const image = read.entities.find(e => e.type === 'IMAGE')!
    expect(codesOf(image, 13)).toEqual([4])
    expect(codesOf(image, 23)).toEqual([4])
    const def = read.objects.find(o => o.type === 'IMAGEDEF')!
    expect(def.codes.find(([c]) => c === 1)![1]).toBe('plate-assets/my_logo.png')
    // the IMAGE points at that definition by handle, and the placed box matches the scene's
    const defHandle = def.codes.find(([c]) => c === 5)![1]
    expect(image.codes.find(([c]) => c === 340)![1]).toBe(defHandle)
    const [x, y, w, h] = scene.images[0].rectMm
    expect(codesOf(image, 10)[0]).toBeCloseTo(x, 4)
    expect(codesOf(image, 20)[0]).toBeCloseTo(215.9 - (y + h), 4)
    expect(codesOf(image, 11)[0] * 4).toBeCloseTo(w, 4)
    expect(codesOf(image, 22)[0] * 4).toBeCloseTo(h, 4)
    expect(read.classes).toEqual(expect.arrayContaining(['IMAGE', 'IMAGEDEF', 'IMAGEDEF_REACTOR']))
  })

  it('a branding file no writer can embed is never dropped silently: a frame, a label and an issue, in both files', () => {
    const doc = makeDoc({ assets: [{ id: 'logo', name: 'logo.gif', contentType: 'image/gif', bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]) }] })
    const r = exportBoth(doc)
    expect(r.scene.images).toHaveLength(0)
    expect(r.scene.issues.find(i => i.kind === 'branding-unsupported')!.message).toBe('Branding "logo.gif" cannot be drawn: its format (image/gif) is not PNG or JPEG.')
    expect(r.readPdf.actualTexts).toContain('LOGO NOT DRAWN')
    expect(r.readDxf.entities.map(xdataText)).toContain('LOGO NOT DRAWN')
    expect(r.readPdf.images).toHaveLength(0)
  })

  it('a 16-bit PNG is refused with the reason, not embedded wrongly', () => {
    const doc = makeDoc({ assets: [{ id: 'logo', name: 'deep.png', contentType: 'image/png', bytes: png(2, 2, 2, 16) }] })
    const scene = buildSheetScene(doc, inputs())
    expect(scene.issues.find(i => i.kind === 'branding-unsupported')!.message).toBe('Branding "deep.png" cannot be drawn: a 16-bit PNG of colour type 2 is not supported (use 8-bit).')
  })

  it('a template naming branding the drawing does not carry says so', () => {
    const doc = makeDoc()
    doc.assets = []
    const scene = buildSheetScene(doc, inputs())
    expect(scene.issues.find(i => i.kind === 'branding-missing')!.message).toBe('The template names branding "logo" but the drawing does not carry it.')
  })
})

describe('honest limits and a drawing that is only partly valid', () => {
  it('a view whose projection is missing says so on the sheet and in the notes, and the rest still exports', () => {
    const r = exportBoth(makeDoc(), inputs({ projections: {} }))
    expect(r.readPdf.actualTexts).toContain('NO PROJECTION: front')
    expect(r.scene.issues.filter(i => i.kind === 'missing-projection')).toHaveLength(2) // front and detail
    expect(r.readDxf.entities.some(e => e.layer === 'DIMENSION')).toBe(true)
  })

  it('a projector limit travels with the view into the export notes', () => {
    const projection = { ...plateProjection(), limits: ['Hidden lines are sampled, not exact.'] }
    const scene = buildSheetScene(makeDoc(), inputs({ projections: { front: projection } }))
    expect(scene.issues.find(i => i.kind === 'projection-limit')!.message).toBe('View front: Hidden lines are sampled, not exact.')
  })

  it('a drawing with no sheet refuses in one plain sentence', () => {
    const doc = makeDoc()
    doc.sheets = []
    expect(() => buildSheetScene(doc, inputs())).toThrow('This drawing has no sheet to export.')
  })
})

describe('the saved drawing says what the export says (fix round 1)', () => {
  const dxfTexts = (r: ReturnType<typeof exportBoth>) => r.readDxf.entities.map(xdataText).filter((t): t is string => t !== undefined)

  it('F1: a dimension pinned to 0.05 while the table now says 0.10 exports its own +/-0.05; one pinned to the table value prints none', () => {
    const r = exportBoth(makeDoc())
    expect(r.readPdf.actualTexts).toContain('100.00 ±0.05')
    expect(dxfTexts(r)).toContain('100.00 ±0.05')
    expect(r.readPdf.actualTexts).toContain('30.00')
    expect(r.readPdf.actualTexts.some(t => t.startsWith('30.00 ±'))).toBe(false)
    expect(r.readPdf.actualTexts.some(t => t.startsWith('GEN TOL'))).toBe(false)
  })

  it('F1: the general tolerance table is printed on the sheet, in the sheet unit, from the saved table', () => {
    const r = exportBoth(makeDoc())
    for (const t of ['UNLESS OTHERWISE SPECIFIED (MM; DEGREES)', 'X  +/- 0.5', 'X.X  +/- 0.1', 'X.XX  +/- 0.1', 'X.XXX  +/- 0.01', 'Angles  +/- 0.5 degrees']) {
      expect(r.readPdf.actualTexts, t).toContain(t)
      expect(dxfTexts(r), t).toContain(t)
    }
    const inch = exportBoth(makeDoc({ unit: 'inch' }))
    expect(inch.readPdf.actualTexts).toContain('UNLESS OTHERWISE SPECIFIED (INCH; DEGREES)')
    expect(inch.readPdf.actualTexts).toContain('X.XX  +/- 0.0039')
    // a table edit shows up: change the saved table and the sheet follows
    const doc = makeDoc()
    doc.template.generalTolerances = { linearByDecimalPlaces: { '0': 1, '1': 0.2, '2': 0.05 }, angularDegrees: 1 }
    const edited = exportBoth(doc)
    expect(edited.readPdf.actualTexts).toContain('X.XX  +/- 0.05')
    expect(edited.readPdf.actualTexts).toContain('Angles  +/- 1 degrees')
    expect(edited.readPdf.actualTexts).toContain('100.00') // the pin now equals the table, so no +/- is printed
  })

  it('F2: the title block shows the saved title override and the bound dates in the template zone', () => {
    const r = exportBoth(makeDoc())
    for (const t of ['SHOP TITLE', 'PN-100', 'B', 'A. Machinist', 'SAMPLE SHOP', '2026-03-04', '2026-03-05', '2026-03-05', 'TITLE *']) {
      expect(r.readPdf.actualTexts, t).toContain(t)
    }
    expect(r.readPdf.actualTexts).not.toContain('Mounting plate')
    expect(dxfTexts(r)).toContain('SHOP TITLE')
    expect(dxfTexts(r)).toContain('2026-03-04')
    // measured on paper: the title text sits inside the title block's title cell
    const title = r.readPdf.paths.find(p => p.op === 'f*' && p.actualText === 'SHOP TITLE')!
    const box = bbox(title.subpaths.flat())
    expect(box.x0).toBeGreaterThan(279.4 - 10 - 110)
    expect(box.y0).toBeGreaterThan(215.9 - 10 - 35)
    expect(box.y1).toBeLessThan(215.9 - 10 - 35 + 8)
  })

  it('F2: without an override the title follows the part name given by the editor, else the drawing name', () => {
    const doc = makeDoc()
    doc.template.overrides = {}
    expect(exportBoth(doc).readPdf.actualTexts).toContain('Mounting plate')
    const named = exportBoth(doc, inputs({ partName: 'Bracket' }))
    expect(named.readPdf.actualTexts).toContain('Bracket')
    expect(named.readPdf.actualTexts).not.toContain('TITLE *')
  })

  it('F3: a balloon is drawn where it was saved, with its leader running to the anchor', () => {
    const r = exportBoth(makeDoc())
    const ring = r.readPdf.paths.flatMap(p => p.subpaths).find(s => s.length > 90 && Math.abs(bbox(s).w - 7) < 0.01)!
    const box = bbox(ring)
    expect((box.x0 + box.x1) / 2).toBeCloseTo(100, 2)
    expect((box.y0 + box.y1) / 2).toBeCloseTo(90, 2)
    const dxfRing = r.readDxf.entities.find(e => e.type === 'CIRCLE' && Math.abs(codesOf(e, 40)[0] - 3.5) < 1e-6)!
    expect(codesOf(dxfRing, 10)[0]).toBeCloseTo(100, 4)
    expect(codesOf(dxfRing, 20)[0]).toBeCloseTo(215.9 - 90, 4)
    // the leader: a two-point line from the ring's edge to the anchor (60, 100)
    const leader = r.readDxf.entities.filter(e => e.type === 'LINE' && e.layer === 'DIMENSION').map(e => dxfPoints(e, 215.9)).find(pts => Math.hypot(pts[1][0] - 60, pts[1][1] - 100) < 1e-6)!
    expect(leader).toBeDefined()
    expect(Math.hypot(leader[0][0] - 100, leader[0][1] - 90)).toBeCloseTo(3.5, 4)
  })

  it('a balloon saved without a label position keeps the editor default of anchor + [10, -10]', () => {
    const doc = makeDoc()
    const b = doc.annotations.find(a => a.id === 'b1')!
    delete (b as { labelSheetMm?: unknown }).labelSheetMm
    const r = exportBoth(doc)
    const dxfRing = r.readDxf.entities.find(e => e.type === 'CIRCLE' && Math.abs(codesOf(e, 40)[0] - 3.5) < 1e-6)!
    expect(codesOf(dxfRing, 10)[0]).toBeCloseTo(70, 4)
    expect(codesOf(dxfRing, 20)[0]).toBeCloseTo(215.9 - 90, 4)
  })

  it('a detail view keeps its saved letter when an earlier one was deleted', () => {
    const r = exportBoth(makeDoc())
    expect(r.readPdf.actualTexts).toContain('DETAIL B (2:1)')
    expect(r.readDxf.entities.map(xdataText)).toContain('B')
  })
})

describe('inputs that used to corrupt or abort an export', () => {
  it('a 0.05 mm tolerance on an inch sheet at precision 2 never prints as zero', () => {
    const d = dimension('t', { tolerance: { kind: 'bilateral', upper: 0.05, lower: -0.05 }, lastGood: { value: 10, unit: 'mm', measuredAt: REV } })
    const label = dimensionLabel(d, { unit: 'inch', precision: 2 }, { state: 'current', valueMm: 10 })
    expect(label.main).toBe('0.39 \u00b10.0020')
  })

  it('an angle arc that wraps through 0 puts its label on the arc side, and the PDF arc matches the DXF arc', () => {
    const doc = makeDoc()
    const ann = { ...RENDERS, 'dim-angle': { state: 'current' as const, valueMm: 20, angular: { vertex: [150, 80] as [number, number], fromDeg: 350, toDeg: 10, radiusMm: 18 } } }
    const r = exportBoth(doc, inputs({ annotations: ann }))
    const label = r.scene.items.find(i => i.kind === 'text' && i.ownerId === 'dim-angle')!
    expect(label.kind === 'text' && label.rings.flat().every(p => p[0] > 150)).toBe(true)
    const arc = r.readDxf.entities.find(e => e.type === 'ARC')!
    expect(codesOf(arc, 50)[0]).toBeCloseTo(350, 6)
    expect(codesOf(arc, 51)[0]).toBeCloseTo(10, 6)
    // the PDF arc: a stroke centred on the same point whose points all lie 18 mm out, spanning 350 to 10 degrees (+-10 about +X)
    const pdfArc = r.readPdf.paths.flatMap(p => p.subpaths).find(s2 => s2.length > 20 && s2.length < 40 && s2.every(p => Math.abs(Math.hypot(p[0] - 150, p[1] - 80) - 18) < 0.01))!
    expect(pdfArc).toBeDefined()
    const angles = pdfArc.map(p => (Math.atan2(80 - p[1], p[0] - 150) * 180) / Math.PI)
    expect(Math.min(...angles)).toBeCloseTo(-10, 1)
    expect(Math.max(...angles)).toBeCloseTo(10, 1)
  })

  it('glyph outlines, not only strings, are present for every stale/approximate/revision label', () => {
    const r = exportBoth(makeDoc())
    for (const t of ['STALE - NOT FOUND', 'LAST KNOWN REV 99887766', 'APPROX +/-0.12 FIT', 'UNPLACED']) {
      const p = r.readPdf.paths.find(q => q.op === 'f*' && q.actualText?.startsWith(t))
      expect(p, t).toBeDefined()
      expect(bbox(p!.subpaths.flat()).w).toBeGreaterThan(5)
    }
    const dxfText = r.readDxf.entities.filter(e => e.type === 'LWPOLYLINE' && xdataText(e)?.startsWith('STALE - NOT FOUND'))
    expect(dxfText.length).toBe(1)
    expect(bbox(dxfPoints(dxfText[0], 215.9)).w).toBeGreaterThan(0.5)
  })

  it('a coarse projection above the 0.05 mm budget is flagged in the notes', () => {
    const scene = buildSheetScene(makeDoc(), inputs({ projections: { front: plateProjection(0.2) } }))
    expect(scene.issues.find(i => i.message.includes('above the 0.05 mm budget'))!.message).toBe('Curves are drawn as straight pieces up to 0.400 mm from the true curve on paper, above the 0.05 mm budget.')
  })

  it('a sheet with no size or no room to draw refuses in one plain sentence', () => {
    const doc = makeDoc({ size: [0, 0] })
    expect(() => buildSheetScene(doc, inputs())).toThrow('Sheet s1 is smaller than 20 mm or has no size, so it cannot be exported.')
    const margins = makeDoc()
    margins.sheets[0].marginsMm = 200
    expect(() => buildSheetScene(margins, inputs())).toThrow('Sheet s1 has margins that leave no room to draw, so it cannot be exported.')
  })

  it('a view with a zero scale, a NaN line or an orphan detail is reported and the rest still exports', () => {
    const doc = makeDoc()
    doc.sheets[0].views[0].scale = { numerator: 0, denominator: 1 }
    doc.sheets[0].views[1].detail!.parentViewId = 'gone'
    const bad = plateProjection()
    bad.lines.push({ visibility: 'visible', category: 'sharp', points: [[0, 0], [Number.NaN, 5]] })
    const r = exportBoth(doc, inputs({ projections: { front: bad, detail: bad } }))
    const msgs = r.scene.issues.map(i => i.message)
    expect(msgs).toContain('View front has a scale of 0:1, which is not a positive ratio, so it is left off the sheet.')
    expect(msgs).toContain('View detail has 1 line with a position that is not a number, so it is left off the sheet.')
    expect(msgs).toContain('Detail view detail points at view gone, which is not on this sheet, so the ring on its parent is not drawn.')
    expect(new TextDecoder().decode(r.pdf.bytes)).not.toContain('NaN')
    expect(r.dxf.dxf).not.toContain('NaN')
  })

  it('a PNG that only has a good header is refused at the scene, so the PDF never throws on it', () => {
    const good = png(4, 4, 6)
    const damaged = good.slice(0, 40)
    const truncated = good.slice()
    truncated.fill(7, 60, 80) // corrupt the compressed data
    for (const [name, bytes, reason] of [['cut.png', damaged, 'the PNG has no image data'], ['bad.png', truncated, 'the PNG image data is damaged']] as const) {
      const doc = makeDoc({ assets: [{ id: 'logo', name, contentType: 'image/png', bytes }] })
      const scene = buildSheetScene(doc, inputs())
      expect(scene.issues.find(i => i.kind === 'branding-unsupported')!.message).toBe(`Branding "${name}" cannot be drawn: ${reason}.`)
      expect(() => exportDrawingPdf(scene)).not.toThrow()
    }
  })

  it('DXF text escapes: backslash, newline and characters above U+FFFF survive as readable strings, and companion paths never collide', () => {
    const doc = makeDoc()
    doc.annotations.push({ kind: 'note', id: 'n3', text: 'A\\U+0041 \u{1F600}\nB', anchorSheetMm: [20, 70] })
    const r = exportBoth(doc)
    const strings = r.readDxf.entities.map(xdataText).filter((t): t is string => t !== undefined && t.startsWith('A'))
    expect(strings).toContain('A\\U+0041 \u{1F600}')
    expect(r.readDxf.entities.map(xdataText)).toContain('B')
    const assets = [
      { id: 'a', name: 'logo', contentType: 'image/png', bytes: png(4, 4, 6) },
      { id: 'b', name: 'logo', contentType: 'image/png', bytes: png(2, 2, 6) },
    ]
    const two = exportDrawingDxf(buildSheetScene(makeDoc({ assets }), inputs()), { branding: 'companion', fileStem: 'p' })
    expect(two.companions.map(c => c.path)).toEqual(['p-assets/logo.png', 'p-assets/b-logo.png'])
  })

  it('a timestamp with an offset is converted to UTC; a nonsense one is left out', () => {
    const doc = makeDoc()
    expect(readPdf(exportDrawingPdf(buildSheetScene(doc, inputs({ exportTimestamp: '2026-10-21T06:30:00+05:00' }))).bytes).info.CreationDate).toBe('D:20261021013000Z')
    expect(readPdf(exportDrawingPdf(buildSheetScene(doc, inputs({ exportTimestamp: '2026-13-45T99:99:99' }))).bytes).info.CreationDate).toBeUndefined()
  })
})
