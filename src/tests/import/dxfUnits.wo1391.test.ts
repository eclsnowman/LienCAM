// WO-1391: dxfImporter.ts never read the HEADER, so $INSUNITS was ignored and
// every coordinate/radius was taken as millimetres. An inch drawing imported
// 25.4x too small. ADR-0022: read the drawing's units and convert to mm; never
// refuse it. These tests pin the conversion and prove the no-$INSUNITS path is
// byte-for-byte the old behaviour.
//
// Hand-built minimal DXF text (same two-line code/value convention as
// dxfEmptyLayers.test.ts). No browser APIs are involved, so no jsdom needed.

import { describe, it, expect } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import type { Loop2D } from '../../types'

function dxf(pairs: Array<[number | string, string]>): string {
  return pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}

// HEADER section naming the drawing's $INSUNITS (group 70 follows group 9).
function header(insUnits?: number): Array<[number | string, string]> {
  if (insUnits === undefined) return []
  return [
    [0, 'SECTION'], [2, 'HEADER'],
    [9, '$INSUNITS'], [70, String(insUnits)],
    [0, 'ENDSEC'],
  ]
}

const ENTITIES_OPEN: Array<[number | string, string]> = [
  [0, 'SECTION'], [2, 'ENTITIES'],
]
const ENTITIES_CLOSE: Array<[number | string, string]> = [
  [0, 'ENDSEC'], [0, 'EOF'],
]

function loopSpan(loop: Loop2D): { w: number; h: number } {
  const xs = loop.points.map(p => p.x)
  const ys = loop.points.map(p => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

function lineLength(loop: Loop2D): number {
  return Math.hypot(loop.points[1].x - loop.points[0].x, loop.points[1].y - loop.points[0].y)
}

// max distance of any loop point from the loop's bbox centre -> the circle radius
function loopRadius(loop: Loop2D): number {
  const xs = loop.points.map(p => p.x), ys = loop.points.map(p => p.y)
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2
  return Math.max(...loop.points.map(p => Math.hypot(p.x - cx, p.y - cy)))
}

describe('WO-1391: an inch DXF ($INSUNITS 1) is converted to mm', () => {
  it('a radius-1 CIRCLE imports at radius 25.4 mm', () => {
    const r = importDXF(dxf([
      ...header(1), ...ENTITIES_OPEN,
      [0, 'CIRCLE'], [8, 'Cut'], [10, '0.0'], [20, '0.0'], [40, '1.0'],
      ...ENTITIES_CLOSE,
    ]))
    expect(r.unitScale).toBe(25.4)
    expect(r.unitLabel).toBe('inches')
    expect(r.loops).toHaveLength(1)
    expect(loopRadius(r.loops[0])).toBeCloseTo(25.4, 3)
    expect(r.boundingBox.size.x).toBeCloseTo(50.8, 3)
    expect(r.boundingBox.size.y).toBeCloseTo(50.8, 3)
  })

  it('LINE endpoints scale the same (a 10-inch line is 254 mm)', () => {
    const r = importDXF(dxf([
      ...header(1), ...ENTITIES_OPEN,
      [0, 'LINE'], [8, 'Cut'], [10, '0.0'], [20, '0.0'], [11, '10.0'], [21, '0.0'],
      ...ENTITIES_CLOSE,
    ]))
    expect(r.loops).toHaveLength(1)
    expect(lineLength(r.loops[0])).toBeCloseTo(254, 6)
  })

  it('LWPOLYLINE vertices scale the same (a 2x1-inch rectangle is 50.8x25.4 mm)', () => {
    const r = importDXF(dxf([
      ...header(1), ...ENTITIES_OPEN,
      [0, 'LWPOLYLINE'], [8, 'Cut'], [90, '4'], [70, '1'],
      [10, '0.0'], [20, '0.0'],
      [10, '2.0'], [20, '0.0'],
      [10, '2.0'], [20, '1.0'],
      [10, '0.0'], [20, '1.0'],
      ...ENTITIES_CLOSE,
    ]))
    expect(r.loops).toHaveLength(1)
    const span = loopSpan(r.loops[0])
    expect(span.w).toBeCloseTo(50.8, 6)
    expect(span.h).toBeCloseTo(25.4, 6)
  })
})

describe('WO-1391: other declared units convert, unset/unitless is unchanged', () => {
  it.each([
    [2, 304.8, 'feet'],
    [4, 1, 'millimetres'],
    [5, 10, 'centimetres'],
    [6, 1000, 'metres'],
  ])('$INSUNITS %i scales by x%f and reports the unit', (code, scale, label) => {
    const r = importDXF(dxf([
      ...header(code as number), ...ENTITIES_OPEN,
      [0, 'LINE'], [8, 'Cut'], [10, '0.0'], [20, '0.0'], [11, '1.0'], [21, '0.0'],
      ...ENTITIES_CLOSE,
    ]))
    expect(r.unitScale).toBe(scale)
    expect(r.unitLabel).toBe(label)
    expect(lineLength(r.loops[0])).toBeCloseTo(scale as number, 6)
  })

  it('no $INSUNITS at all: scale 1 and geometry unchanged from today', () => {
    const r = importDXF(dxf([
      ...ENTITIES_OPEN,
      [0, 'LINE'], [8, 'Cut'], [10, '0.0'], [20, '0.0'], [11, '10.0'], [21, '0.0'],
      ...ENTITIES_CLOSE,
    ]))
    expect(r.unitScale).toBe(1)
    expect(r.unitLabel).toBe('millimetres')
    expect(lineLength(r.loops[0])).toBeCloseTo(10, 6)
  })

  it('$INSUNITS 0 (unitless): stays millimetres, scale 1', () => {
    const r = importDXF(dxf([
      ...header(0), ...ENTITIES_OPEN,
      [0, 'CIRCLE'], [8, 'Cut'], [10, '0.0'], [20, '0.0'], [40, '4.0'],
      ...ENTITIES_CLOSE,
    ]))
    expect(r.unitScale).toBe(1)
    expect(r.unitLabel).toBe('millimetres')
    expect(loopRadius(r.loops[0])).toBeCloseTo(4, 2)
  })
})
