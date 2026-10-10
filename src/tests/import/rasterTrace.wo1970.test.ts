// @vitest-environment jsdom
//
// WO-1970: a PNG dropped on the Sketch screen's Import becomes closed sketch
// curves. Driven through the production importFileIntoSketch with a generated
// picture (a square with a square hole, plus a disc) encoded as a real PNG.

import { beforeEach, describe, expect, it } from 'vitest'
import { zlibSync } from 'fflate'
import { bindSketcherDocument, importFileIntoSketch } from '../../lib/sketch/sketcher/toolController'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

function crc32(buf: Uint8Array): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 8-bit greyscale PNG from a per-pixel function. */
function pngFile(w: number, h: number, grey: (x: number, y: number) => number, name = 'pic.png'): File {
  const raw = new Uint8Array((w + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = grey(x, y)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h)
  ihdr[8] = 8; ihdr[9] = 0
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { all.set(p, o); o += p.length }
  return new File([all], name, { type: 'image/png' })
}

// 200 x 100 picture: a 60x60 square (x 20..80, y 20..80) with a 20x20 hole
// (x 40..60, y 40..60), and a disc of radius 15 centred (150, 50).
const inSquare = (x: number, y: number) => x >= 20 && x < 80 && y >= 20 && y < 80
const inHole = (x: number, y: number) => x >= 40 && x < 60 && y >= 40 && y < 60
const inDisc = (x: number, y: number) => Math.hypot(x + 0.5 - 150, y + 0.5 - 50) <= 15
const PICTURE = (x: number, y: number) => ((inSquare(x, y) && !inHole(x, y)) || inDisc(x, y) ? 0 : 255)

let sketch: Sketch
let notices: Array<{ message: string; severity?: string }>

beforeEach(() => {
  sketch = createBlankSketch('layer-under-test')
  notices = []
  const port = {
    getSketch: () => sketch,
    ensureSketch: () => sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 1,
    getProjectCandidates: () => [],
    getSelection: () => [],
    setSelection: () => {},
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: (message: string, severity?: string) => { notices.push({ message, severity }) },
    beginStep: () => {},
    append: (commit: { entities: SketchEntity[]; constraints: Sketch['constraints']; dimensions?: Sketch['dimensions'] }, inferred: Sketch['constraints']) => {
      sketch = {
        ...sketch,
        entities: [...sketch.entities, ...commit.entities],
        constraints: [...sketch.constraints, ...commit.constraints, ...inferred],
        dimensions: [...sketch.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: () => {},
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false, dragMove: () => {}, dragEnd: () => {},
    moveDimLabel: () => {}, openDimEditor: () => {},
    getTextEditId: () => null, getPickPathForTextId: () => null,
    editText: () => {}, commitTextEdit: () => {}, cancelTextEdit: () => {}, cancelPickTextPath: () => {},
    placeText: () => {}, bindTextPath: () => {},
  } as unknown as SketchDocumentPort
  bindSketcherDocument(port)
})

/** Every point an entity touches, for bounding boxes. */
function extent(es: SketchEntity[]) {
  const xs: number[] = [], ys: number[] = []
  for (const e of es) {
    if (e.kind === 'line') {
      xs.push(e.start.x, e.end.x); ys.push(e.start.y, e.end.y)
    } else if (e.kind === 'circle') {
      xs.push(e.center.x - e.radius, e.center.x + e.radius); ys.push(e.center.y - e.radius, e.center.y + e.radius)
    } else if (e.kind === 'arc') {
      xs.push(e.center.x - e.radius, e.center.x + e.radius); ys.push(e.center.y - e.radius, e.center.y + e.radius)
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe('WO-1970 picture trace through importFileIntoSketch', () => {
  it('traces the square, its hole and the disc at the chosen width', async () => {
    await importFileIntoSketch(pngFile(200, 100, PICTURE), { traceWidthMm: 100 })
    const es = sketch.entities
    expect(es.length).toBeGreaterThan(0)
    expect(notices.at(-1)?.message).toMatch(/3 loops/)
    // 0.5 mm per pixel: the square is 30 mm, its hole 10 mm, the disc 15 mm across.
    const lines = es.filter((e) => e.kind === 'line')
    // Straight edges stay a few lines, not a pixel staircase: 2 squares x 4 sides.
    expect(lines.length).toBe(8)
    const disc = es.filter((e) => e.kind === 'circle')
    expect(disc.length).toBe(1)
    if (disc[0].kind === 'circle') {
      expect(Math.abs(disc[0].radius - 7.5)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(disc[0].center.x - 75)).toBeLessThanOrEqual(0.5)
    }
    // The hole's four lines sit inside the outer square's box (10..40 mm).
    const inner = lines.filter((l) => l.kind === 'line' && l.start.x > 19 && l.start.x < 31 && l.end.x > 19 && l.end.x < 31 && l.start.y > 19 && l.start.y < 31 && l.end.y > 19 && l.end.y < 31)
    expect(inner.length).toBe(4)
    const all = extent(es)
    const px = 0.5
    expect(Math.abs(all.minX - 10)).toBeLessThanOrEqual(px)
    expect(Math.abs(all.maxX - 82.5)).toBeLessThanOrEqual(px)
    expect(Math.abs(all.maxY - 40)).toBeLessThanOrEqual(px) // picture is 50 mm tall, square top y=20px
    expect(Math.abs(all.minY - 10)).toBeLessThanOrEqual(px)
  })

  it('a picture with no dark pixels imports nothing and says so once', async () => {
    await importFileIntoSketch(pngFile(40, 40, () => 255, 'blank.png'))
    expect(sketch.entities.length).toBe(0)
    expect(notices.length).toBe(1)
    expect(notices[0].message).toMatch(/no dark shapes/)
  })

  it('a wider trace scales the sketch', async () => {
    await importFileIntoSketch(pngFile(200, 100, PICTURE), { traceWidthMm: 200 })
    const all = extent(sketch.entities)
    expect(Math.abs(all.minX - 20)).toBeLessThanOrEqual(1)
    expect(Math.abs(all.maxX - 165)).toBeLessThanOrEqual(1)
  })

  it('DXF still imports as before', async () => {
    const d = ['0', 'SECTION', '2', 'ENTITIES', '0', 'CIRCLE', '8', 'Cut', '10', '0', '20', '0', '40', '5', '0', 'ENDSEC', '0', 'EOF'].join('\n') + '\n'
    await importFileIntoSketch(new File([d], 'c.dxf'))
    expect(sketch.entities.some((e) => e.kind === 'circle')).toBe(true)
    expect(notices.at(-1)?.message).toMatch(/1 loop/)
  })
})
