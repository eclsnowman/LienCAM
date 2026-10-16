import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { toolOverlay } from '../../lib/sketch/tools/toolOverlay'
import { resolveDimPlacement } from '../../lib/sketch/tools/dimPlacement'
import { SketchOverlayPainter } from '../../lib/sketch/sketcher/overlayPainter'
import { SketchLayer } from '../../lib/sketch/sketcher/sketchLayer'
import type { SketchEntity } from '../../lib/sketch/types'

const entities: SketchEntity[] = [
  { id: 'vertical', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: 50 } },
  { id: 'point', kind: 'point', construction: false, at: { x: 5.63, y: 15 } },
  { id: 'circle', kind: 'circle', construction: false, center: { x: 20, y: 15 }, radius: 2.125 },
  { id: 'linear', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 50, y: 0 } },
]
const cases = [
  { name: 'short perpendicular', ids: ['point', 'vertical'], cursor: { x: 8, y: 25 }, kind: 'distancePL', value: 5.63 },
  { name: 'diameter', ids: ['circle'], cursor: { x: 28, y: 18 }, kind: 'diameter', value: 4.25 },
  { name: 'linear control', ids: ['linear'], cursor: { x: 25, y: -10 }, kind: 'distanceX', value: 50 },
] as const

function paint(c: typeof cases[number], wpp: () => number) {
  const root = new THREE.Group()
  const painter = new SketchOverlayPainter(root, wpp)
  painter.setToolOverlayDisplay(toolOverlay({ tool: 'smart-dimension', chain: { kind: 'dim', operandIds: [...c.ids] } },
    c.cursor, 8 * wpp(), { entities }))
  const lines: THREE.Line[] = []
  root.traverse(o => { if (o instanceof THREE.Line) lines.push(o) })
  return { root, painter, lines }
}
const points = (line: THREE.Line) => {
  const pos = line.geometry.getAttribute('position')
  return Array.from({ length: pos.count }, (_, i) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
}
const arrows = (lines: THREE.Line[]) => lines.map(points).filter(p => p.length === 3 &&
  Math.abs(p[0].distanceTo(p[1]) - p[2].distanceTo(p[1])) < 1e-5)

describe('WO-2748 real toolOverlay -> painter -> committed layer', () => {
  for (const wpp of [0.04, 0.1, 0.2]) for (const c of cases) {
    it(`${c.name} has committed arrow size at ${wpp} mm/px`, () => {
      const placement = resolveDimPlacement(entities, c.ids, c.cursor, { clampInitial: true })!
      expect(placement.kind).toBe(c.kind)
      expect(placement.value).toBeCloseTo(c.value, 8)
      const preview = paint(c, () => wpp)
      const heads = arrows(preview.lines)
      expect(heads.length).toBeGreaterThan(0)
      const layer = new SketchLayer(() => wpp)
      layer.update({ id: 'sk', layerId: 'L', entities, constraints: [], solveStatus: null,
        dimensions: [{ ...placement.plan, id: 'dim', driving: true, labelAnchor: placement.labelAnchor }] },
      { selectedIds: new Set(), glyphsVisible: false, editingId: null })
      const committed = layer.group.children.find(o => o.name === '__dim_dim') as THREE.LineSegments
      const p = points(committed)
      for (const head of heads) {
        // Actual committed buffer, not a second call to the pure guide helper.
        const tip = head[1]
        const barbSegments = Array.from({ length: p.length / 2 }, (_, i) => [p[2 * i], p[2 * i + 1]])
          .filter(([a, b]) => (a.distanceTo(tip) < 1e-5 || b.distanceTo(tip) < 1e-5) &&
            Math.abs(a.distanceTo(b) / wpp - 13) < 1e-3)
        expect(barbSegments).toHaveLength(2)
        expect(head[0].distanceTo(tip) / wpp).toBeCloseTo(13, 4)
        expect(head[2].distanceTo(tip) / wpp).toBeCloseTo(13, 4)
      }
      if (c.kind === 'distancePL') {
        expect(heads).toHaveLength(2)
        const sorted = [...heads].sort((a, b) => a[1].x - b[1].x)
        expect(Math.max(sorted[0][0].x, sorted[0][2].x)).toBeLessThan(Math.min(sorted[1][0].x, sorted[1][2].x))
      }
      layer.dispose(); preview.painter.dispose()
    })
  }

  it('resizes a live preview during zoom without another pointermove', () => {
    let wpp = 0.1
    const preview = paint(cases[0], () => wpp)
    wpp = 0.04
    const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 100)
    camera.position.z = 50; camera.updateMatrixWorld()
    const renderer = { getSize: (v: THREE.Vector2) => v.set(1000, 1000) } as THREE.WebGLRenderer
    preview.root.updateMatrixWorld(true)
    for (const line of preview.lines) line.onBeforeRender(renderer, new THREE.Scene(), camera, line.geometry, line.material as THREE.Material, null!)
    for (const head of arrows(preview.lines)) expect(head[0].distanceTo(head[1]) / wpp).toBeCloseTo(13, 4)
    preview.painter.dispose()
  })

  for (const c of cases) it(`${c.name} matches committed pixel size on a posed oblique perspective plane`, () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    camera.position.set(40, -40, 50); camera.lookAt(10, 15, 0); camera.updateMatrixWorld()
    const project = (p: THREE.Vector3) => {
      const q = p.clone().project(camera)
      return new THREE.Vector2(q.x * 500, q.y * 500)
    }
    const preview = paint(c, () => 0.1)
    const expectedBarbs = arrows(preview.lines).length * 2
    const offset = { x: 12, y: -4, rotationDeg: 30 }
    preview.painter.setOffset(offset); preview.root.updateMatrixWorld(true)
    const renderer = { getSize: (v: THREE.Vector2) => v.set(1000, 1000) } as THREE.WebGLRenderer
    for (const line of preview.lines) line.onBeforeRender(renderer, new THREE.Scene(), camera, line.geometry, line.material as THREE.Material, null!)
    for (const line of preview.lines.filter(line => points(line).length === 3)) {
      const p = points(line).map(p => project(line.localToWorld(p)))
      expect(p[0].distanceTo(p[1])).toBeCloseTo(13, 3)
      expect(p[2].distanceTo(p[1])).toBeCloseTo(13, 3)
    }
    const placement = resolveDimPlacement(entities, c.ids, c.cursor, { clampInitial: true })!
    const layer = new SketchLayer(() => 0.1, (p, z) => {
      const q = project(new THREE.Vector3(p.x, p.y, z))
      return { x: q.x, y: q.y }
    })
    layer.update({ id: 'sk', layerId: 'L', entities, constraints: [], solveStatus: null,
      dimensions: [{ ...placement.plan, id: 'dim', driving: true, labelAnchor: placement.labelAnchor }] },
    { selectedIds: new Set(), glyphsVisible: false, editingId: null }, offset)
    layer.group.updateMatrixWorld(true)
    const committed = layer.group.children.find(o => o.name === '__dim_dim') as THREE.LineSegments
    const segments = points(committed).map(p => project(committed.localToWorld(p)))
    const lengths = Array.from({ length: segments.length / 2 }, (_, i) => segments[i * 2].distanceTo(segments[i * 2 + 1]))
    expect(lengths.filter(len => Math.abs(len - 13) < 0.001)).toHaveLength(expectedBarbs)
    layer.dispose(); preview.painter.dispose()
  })
})
