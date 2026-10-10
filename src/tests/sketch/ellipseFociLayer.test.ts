// Ellipse FOCUS nodes in the sketch render layer: EVERY ellipse /
// elliptical-arc shows its two foci as a hollow-ring point cloud
// ('__sketch_ellipse_foci__') at ALL times (Operator ruling 2026-07-02: "foci nodes
// should always be displayed") — selection only brightens the owner's
// nodes (per-vertex color), and construction owners show them too; the
// circle-degenerate case defers to the canonical center node so glyphs do
// not stack at one coordinate.
// Headless (node env): SketchLayer builds real THREE objects without a DOM
// (the ring texture falls back to an untextured point cloud — the marker
// GEOMETRY, which is what these tests pin, is identical).

import { describe, it, expect } from 'vitest'
import type * as THREE from 'three'
import { SketchLayer } from '../../lib/sketch/sketcher/sketchLayer'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const ELLIPSE: SketchEntity = {
  id: 'el1', kind: 'ellipse', construction: false,
  center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
}

function sketchWith(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: 'L',
    entities, constraints: [], dimensions: [], solveStatus: null,
  }
}

function fociCloud(layer: SketchLayer): THREE.Points | undefined {
  return layer.group.children.find(
    (c) => c.name === '__sketch_ellipse_foci__',
  ) as THREE.Points | undefined
}

function view(selected: string[]) {
  return { selectedIds: new Set(selected), glyphsVisible: false, editingId: null }
}

describe('SketchLayer ellipse focus nodes', () => {
  it('UNSELECTED ellipse still renders the foci cloud (always displayed)', () => {
    const layer = new SketchLayer()
    layer.update(sketchWith([ELLIPSE]), view([]))
    const cloud = fociCloud(layer)
    expect(cloud).toBeTruthy()
    const pos = cloud!.geometry.getAttribute('position')
    expect(pos.count).toBe(2)
    // Positions ride a Float32Array — compare at float32 precision (4dp).
    const c = Math.sqrt(10 * 10 - 5 * 5)
    expect(pos.getX(0)).toBeCloseTo(c, 4)
    expect(pos.getY(0)).toBeCloseTo(0, 4)
    expect(pos.getX(1)).toBeCloseTo(-c, 4)
    expect(pos.getY(1)).toBeCloseTo(0, 4)
    layer.dispose()
  })

  it('selection BRIGHTENS the owner foci; unselected owners stay dim', () => {
    const other: SketchEntity = {
      id: 'el2', kind: 'ellipse', construction: false,
      center: { x: 50, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    }
    const layer = new SketchLayer()
    layer.update(sketchWith([ELLIPSE, other]), view(['el1']))
    const cloud = fociCloud(layer)
    expect(cloud).toBeTruthy()
    const pos = cloud!.geometry.getAttribute('position')
    expect(pos.count).toBe(4) // BOTH ellipses contribute foci
    const col = cloud!.geometry.getAttribute('color')
    expect(col).toBeTruthy()
    // el1 (selected) nodes are strictly brighter than el2 (unselected) nodes.
    expect(col.getX(0)).toBeGreaterThan(col.getX(2))
    expect(col.getY(0)).toBeGreaterThan(col.getY(2))
    expect(col.getZ(0)).toBeGreaterThan(col.getZ(2))
    // Both foci of one owner share a color.
    expect(col.getX(0)).toBeCloseTo(col.getX(1), 6)
    expect(col.getX(2)).toBeCloseTo(col.getX(3), 6)
    layer.dispose()
  })

  it('CONSTRUCTION ellipse renders its foci like any other ellipse', () => {
    const cons: SketchEntity = { ...ELLIPSE, id: 'elc', construction: true }
    const layer = new SketchLayer()
    layer.update(sketchWith([cons]), view([]))
    const cloud = fociCloud(layer)
    expect(cloud).toBeTruthy()
    expect(cloud!.geometry.getAttribute('position').count).toBe(2)
    layer.dispose()
  })

  it('unselected elliptical-arc reveals the SAME underlying-ellipse foci', () => {
    const arc: SketchEntity = {
      id: 'ea1', kind: 'elliptical-arc', construction: false,
      center: { x: 2, y: 3 }, majorRadius: 8, minorRadius: 3, rotation: Math.PI / 2,
      startParam: 0, endParam: Math.PI,
    }
    const layer = new SketchLayer()
    layer.update(sketchWith([arc]), view([]))
    const cloud = fociCloud(layer)
    expect(cloud).toBeTruthy()
    const pos = cloud!.geometry.getAttribute('position')
    expect(pos.count).toBe(2)
    const c = Math.sqrt(8 * 8 - 3 * 3)
    // rotation 90deg: foci ride +Y from the center (float32 storage -> 4dp).
    expect(pos.getX(0)).toBeCloseTo(2, 4)
    expect(pos.getY(0)).toBeCloseTo(3 + c, 4)
    expect(pos.getX(1)).toBeCloseTo(2, 4)
    expect(pos.getY(1)).toBeCloseTo(3 - c, 4)
    layer.dispose()
  })

  it('circle-degenerate ellipse uses one canonical center node', () => {
    const circle: SketchEntity = {
      id: 'ec1', kind: 'ellipse', construction: false,
      center: { x: 4, y: -1 }, majorRadius: 6, minorRadius: 6, rotation: 0,
    }
    const layer = new SketchLayer()
    layer.update(sketchWith([circle]), view([]))
    expect(fociCloud(layer)).toBeUndefined()
    const centers = layer.group.children
      .filter((child) => child.name === '__sketch_centers__')
    expect(centers).toHaveLength(1)
    const pos = (centers[0] as THREE.Points).geometry.getAttribute('position')
    expect(pos.count).toBe(1)
    expect(pos.getX(0)).toBe(4)
    expect(pos.getY(0)).toBe(-1)
    layer.dispose()
  })
})
