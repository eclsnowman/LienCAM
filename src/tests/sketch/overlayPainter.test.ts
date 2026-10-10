// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { SketchOverlayPainter } from '../../lib/sketch/sketcher/overlayPainter'

const linesIn = (root: THREE.Object3D): THREE.Line[] =>
  root.children.filter((child): child is THREE.Line => child instanceof THREE.Line)

describe('SketchOverlayPainter disconnected tool previews', () => {
  it('renders each disconnected path as its own line with no connector segment', () => {
    const root = new THREE.Group()
    const painter = new SketchOverlayPainter(root, () => 1)

    painter.setToolPreview([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 100, y: 100 }, { x: 110, y: 100 }],
    ])

    const lines = linesIn(root)
    expect(painter.previewPathCount()).toBe(2)
    expect(lines).toHaveLength(2)
    expect(lines[0].geometry.getAttribute('position').count).toBe(3)
    expect(lines[1].geometry.getAttribute('position').count).toBe(2)
    // FAILS-IF the two paths are flattened: one line with five vertices necessarily contains the
    // false (10,10) -> (100,100) connector.
    expect(lines.map((line) => line.geometry.getAttribute('position').count)).toEqual([3, 2])

    painter.dispose()
  })

  it('poses every path and rebuilds only geometry whose point count changed', () => {
    const root = new THREE.Group()
    const painter = new SketchOverlayPainter(root, () => 1)
    painter.setToolPreview([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      [{ x: 5, y: 5 }, { x: 6, y: 5 }],
    ])
    const before = linesIn(root)
    const firstGeometry = before[0].geometry
    const secondGeometry = before[1].geometry
    const firstDispose = vi.spyOn(firstGeometry, 'dispose')

    painter.setOffset({ x: 12, y: -4, rotationDeg: 30 })
    for (const line of before) {
      expect(line.position.x).toBe(12)
      expect(line.position.y).toBe(-4)
      expect(line.rotation.z).toBeCloseTo(Math.PI / 6)
    }

    painter.setToolPreview([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
      [{ x: 5, y: 5 }, { x: 7, y: 5 }],
    ])
    const after = linesIn(root)
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(after[0].geometry).not.toBe(firstGeometry)
    expect(after[1].geometry).toBe(secondGeometry)
    expect(after[0].position.x).toBe(12)
    expect(after[1].position.x).toBe(12)

    painter.dispose()
  })

  it('disposes removed paths and every clear/dispose tail updates hasPreview', () => {
    const root = new THREE.Group()
    const painter = new SketchOverlayPainter(root, () => 1)
    painter.setToolPreview([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    ])
    const initial = linesIn(root)
    const removedGeometryDispose = vi.spyOn(initial[1].geometry, 'dispose')
    const removedMaterialDispose = vi.spyOn(initial[1].material as THREE.Material, 'dispose')

    painter.setToolPreview([[{ x: 0, y: 0 }, { x: 2, y: 0 }]])
    expect(removedGeometryDispose).toHaveBeenCalledOnce()
    expect(removedMaterialDispose).toHaveBeenCalledOnce()
    expect(painter.hasPreview()).toBe(true)
    expect(painter.previewPathCount()).toBe(1)

    const remaining = linesIn(root)[0]
    const remainingGeometryDispose = vi.spyOn(remaining.geometry, 'dispose')
    const remainingMaterialDispose = vi.spyOn(remaining.material as THREE.Material, 'dispose')
    painter.clearAll()
    expect(remainingGeometryDispose).toHaveBeenCalledOnce()
    expect(remainingMaterialDispose).toHaveBeenCalledOnce()
    expect(painter.hasPreview()).toBe(false)
    expect(linesIn(root)).toHaveLength(0)

    painter.setToolPreview([{ x: 0, y: 0 }])
    expect(painter.hasPreview()).toBe(false)
    painter.dispose()
    expect(root.children).toHaveLength(0)
  })
})
