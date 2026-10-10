import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  ACTIVE_SKETCH_RENDER_ORDER,
  SKETCH_COLORS,
  SKETCH_Z,
  SketchLayer,
} from '../../lib/sketch/sketcher/sketchLayer'
import type { Sketch, SketchEntity, SketchViewState } from '../../lib/sketch/sketcher'

const NATIVE: SketchEntity = {
  id: 'native',
  kind: 'line',
  construction: false,
  start: { x: 0, y: 0 },
  end: { x: 20, y: 0 },
}

const PROJECTED: SketchEntity = {
  id: 'projected',
  kind: 'line',
  construction: false,
  provenance: 'projected',
  start: { x: 0, y: 10 },
  end: { x: 20, y: 10 },
}

function sketch(): Sketch {
  return {
    id: 'visual-semantics',
    layerId: 'workbench',
    entities: [NATIVE, PROJECTED],
    constraints: [],
    dimensions: [],
    solveStatus: null,
  }
}

function view(selectedIds: string[] = []): SketchViewState {
  return {
    selectedIds: new Set(selectedIds),
    glyphsVisible: false,
    editingId: null,
  }
}

function line(layer: SketchLayer, name: string): THREE.Line {
  const found = layer.group.children.find((child) => child.name === name)
  if (!(found instanceof THREE.Line)) throw new Error(`missing sketch line ${name}`)
  return found
}

function material(layer: SketchLayer, name: string): THREE.LineBasicMaterial {
  return line(layer, name).material as THREE.LineBasicMaterial
}

describe('SketchLayer projected/reference presentation', () => {
  it('keeps the active sketch screen-layered just above its support face', () => {
    const layer = new SketchLayer()
    layer.update(sketch(), view())

    expect(layer.group.position.z).toBe(SKETCH_Z)
    expect(SKETCH_Z).toBeLessThan(0.05)
    expect(layer.group.renderOrder).toBe(ACTIVE_SKETCH_RENDER_ORDER)
    expect(ACTIVE_SKETCH_RENDER_ORDER).toBeGreaterThan(10)
    for (const name of ['native', 'projected']) {
      expect(material(layer, name).depthTest).toBe(false)
      expect(material(layer, name).depthWrite).toBe(false)
    }
    layer.dispose()
  })

  it('uses a distinct high-contrast reference color while preserving selection precedence', () => {
    const layer = new SketchLayer()
    layer.update(sketch(), view())

    expect(material(layer, 'native').color.getHex()).toBe(SKETCH_COLORS.underDefined)
    expect(material(layer, 'projected').color.getHex()).toBe(SKETCH_COLORS.reference)
    expect(SKETCH_COLORS.reference).not.toBe(SKETCH_COLORS.underDefined)
    expect(SKETCH_COLORS.reference).not.toBe(SKETCH_COLORS.fullyDefined)

    layer.update(sketch(), view(['projected']))
    expect(material(layer, 'projected').color.getHex()).toBe(SKETCH_COLORS.selected)
    layer.dispose()
  })
})
