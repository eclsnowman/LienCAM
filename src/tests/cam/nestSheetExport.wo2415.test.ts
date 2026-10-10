import { describe, expect, it } from 'vitest'
import type { ImportedGeometry, Loop2D, NestRecord, Vec2 } from '../../types'
import { packNest } from '../../lib/cam/nesting'
import {
  buildSheetExportModel,
  sheetExportFilename,
  sheetToDxf,
  sheetToSvg,
} from '../../lib/cam/nesting/sheetExport'

const TOL = 1e-6

function loop(id: string, pts: [number, number][], type: Loop2D['type']): Loop2D {
  const points = pts.map(([x, y]) => ({ x, y }))
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    a += p.x * q.y - q.x * p.y
  }
  return { id, points, closed: true, type, layerId: 'L', area: Math.abs(a) / 2 }
}

function geo(id: string, name: string, loops: Loop2D[]): ImportedGeometry {
  return {
    id, name, filename: `${name}.dxf`, type: '2d', format: 'dxf',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, loops,
  } as unknown as ImportedGeometry
}

// L-shaped plate with a square hole, and a plain rectangle.
const plate = geo('g-plate', 'Plate', [
  loop('o', [[0, 0], [40, 0], [40, 20], [20, 20], [20, 30], [0, 30]], 'contour'),
  loop('h', [[5, 5], [10, 5], [10, 10], [5, 10]], 'hole'),
])
const bar = geo('g-bar', 'Bar', [loop('o2', [[0, 0], [50, 0], [50, 8], [0, 8]], 'contour')])

// Independent DXF reader: group-code pairs -> LWPOLYLINE rings / TEXT, by layer.
function readDxf(text: string) {
  const lines = text.split(/\r?\n/)
  const pairs: [number, string][] = []
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()])
  const polys: { layer: string; ring: Vec2[] }[] = []
  const texts: { layer: string; text: string }[] = []
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'LWPOLYLINE') {
      let layer = ''
      const ring: Vec2[] = []
      let j = i + 1
      for (; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 8) layer = pairs[j][1]
        if (pairs[j][0] === 10) ring.push({ x: parseFloat(pairs[j][1]), y: parseFloat(pairs[j + 1][1]) })
      }
      polys.push({ layer, ring })
    } else if (pairs[i][0] === 0 && pairs[i][1] === 'TEXT') {
      let layer = ''
      let t = ''
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 8) layer = pairs[j][1]
        if (pairs[j][0] === 1) t = pairs[j][1]
      }
      texts.push({ layer, text: t })
    }
  }
  return { polys, texts }
}

function parsePath(d: string): Vec2[] {
  return [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }))
}

function readSvg(text: string) {
  const groups: Record<string, { d: string; attrs: string }[]> = {}
  for (const g of text.matchAll(/<g id="(\w+)"[^>]*>([\s\S]*?)<\/g>/g)) {
    groups[g[1]] = [...g[2].matchAll(/<path ([^>]*?)d="([^"]+)"/g)].map((m) => ({ attrs: m[1], d: m[2] }))
  }
  const labels = [...text.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
  return { groups, labels }
}

function expectedRing(pts: Vec2[], rot: number, x: number, y: number): Vec2[] {
  const a = (rot * Math.PI) / 180
  return pts.map((p) => ({ x: x + p.x * Math.cos(a) - p.y * Math.sin(a), y: y + p.x * Math.sin(a) + p.y * Math.cos(a) }))
}

function expectRing(actual: Vec2[], want: Vec2[]) {
  expect(actual.length).toBe(want.length)
  actual.forEach((p, i) => {
    expect(Math.abs(p.x - want[i].x)).toBeLessThan(TOL)
    expect(Math.abs(p.y - want[i].y)).toBeLessThan(TOL)
  })
}

describe('WO-2415 nest sheet export', () => {
  it('DXF and SVG of a real nested sheet match project.nests placements', async () => {
    const geos = [plate, bar]
    const res = await packNest({
      parts: geos.map((g) => {
        const loops = g.loops!
        return {
          part: {
            id: g.id,
            outer: loops[0].points,
            holes: loops.slice(1).map((l) => l.points),
          },
          quantity: g.id === 'g-plate' ? 3 : 2,
        }
      }),
      sheet: { width: 200, height: 120 },
      style: 'arbitrary',
      spacing: { partGap: 2, sheetMargin: 3, windowGap: 0 },
      solver: { kind: 'fixSheetExact' },
      seed: 2415,
      rotationCount: 8,
    })
    expect(res.placements.length).toBe(5)

    const nest: NestRecord = {
      id: 'n1', name: 'Sheet test / 1', sheet: { width: 200, height: 120 }, style: 'arbitrary',
      spacing: { partGap: 2, sheetMargin: 3, windowGap: 0 }, seed: 2415,
      sources: [{ geometryId: 'g-plate', quantity: 3 }, { geometryId: 'g-bar', quantity: 2 }],
      placements: res.placements, unplaced: res.unplaced, utilization: res.utilization,
    }
    const model = buildSheetExportModel(nest, geos)
    expect(model.parts.length).toBe(5)

    // --- DXF ---
    const dxf = readDxf(sheetToDxf(model))
    const sheetPoly = dxf.polys.filter((p) => p.layer === 'SHEET')
    expect(sheetPoly.length).toBe(1)
    expectRing(sheetPoly[0].ring, [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }])
    const partPolys = dxf.polys.filter((p) => p.layer === 'PARTS')
    const holePolys = dxf.polys.filter((p) => p.layer === 'HOLES')
    expect(partPolys.length).toBe(5)
    expect(holePolys.length).toBe(3)
    expect(dxf.texts.filter((t) => t.layer === 'LABELS').map((t) => t.text).sort())
      .toEqual(['Bar', 'Bar', 'Plate', 'Plate', 'Plate'])

    // --- SVG ---
    const svg = readSvg(sheetToSvg(model))
    expect(svg.groups.SHEET.length).toBe(1)
    expectRing(parsePath(svg.groups.SHEET[0].d), [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }])
    expect(svg.groups.PARTS.length).toBe(5)
    expect(svg.groups.HOLES.length).toBe(3)
    expect(svg.labels.sort()).toEqual(['Bar', 'Bar', 'Plate', 'Plate', 'Plate'])

    // --- both readers vs the stored placements, computed independently ---
    res.placements.forEach((pl, i) => {
      const src = pl.partId === 'g-plate' ? plate : bar
      const want = expectedRing(src.loops![0].points, pl.rotationDeg, pl.x, pl.y)
      expectRing(partPolys[i].ring, want)
      expectRing(parsePath(svg.groups.PARTS[i].d), want)
      expect(svg.groups.PARTS[i].attrs).toContain(`data-instance="${pl.instanceId}"`)
      expect(Math.abs(parseFloat(/data-rotation="([^"]+)"/.exec(svg.groups.PARTS[i].attrs)![1]) - pl.rotationDeg)).toBeLessThan(TOL)
    })
    // Every part stays on the sheet.
    for (const p of partPolys) for (const v of p.ring) {
      expect(v.x).toBeGreaterThan(-TOL); expect(v.x).toBeLessThan(200 + TOL)
      expect(v.y).toBeGreaterThan(-TOL); expect(v.y).toBeLessThan(120 + TOL)
    }
  })

  it('a rotated, offset placement round-trips exactly', () => {
    const nest = {
      id: 'n2', name: 'rot', sheet: { width: 100, height: 100 }, style: 'arbitrary',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 }, seed: 1, sources: [],
      placements: [{ partId: 'g-bar', instanceId: 'i1', x: 60.123456789, y: 10.5, rotationDeg: 37.25, depth: 0 }],
      unplaced: [], utilization: 0,
    } as NestRecord
    const model = buildSheetExportModel(nest, [bar])
    const want = expectedRing(bar.loops![0].points, 37.25, 60.123456789, 10.5)
    expectRing(readDxf(sheetToDxf(model)).polys.filter((p) => p.layer === 'PARTS')[0].ring, want)
    expectRing(parsePath(readSvg(sheetToSvg(model)).groups.PARTS[0].d), want)
  })

  it('filenames are safe', () => {
    expect(sheetExportFilename('Sheet test / 1', 'dxf')).toBe('Sheet_test_1.dxf')
    expect(sheetExportFilename('///', 'svg')).toBe('nest-sheet.svg')
  })
})
