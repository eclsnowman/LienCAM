import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { MoveOwner } from '../../lib/viewport/toolpathSegments'
import type { ToolpathMove } from '../../types'

function methodOnlyViewport() {
  const viewport = Object.create(CNCViewport.prototype) as unknown as
    Pick<CNCViewport, 'renderToolpath' | 'setSimulationToolpathPreview' | 'setHiddenToolpathRoles' | 'setToolpathVisible'> &
    Record<string, unknown>
  viewport.toolpathGroup = new THREE.Group()
  viewport.toolpathRoleLines = new Map<string, THREE.Object3D>()
  viewport.toolpathPickBodies = []
  return viewport
}

const LAYER_MOVES: ToolpathMove[] = [
  { type: 'feed', x: 0, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 10, y: 0, z: -1, role: 'cut' },
  { type: 'feed', x: 10, y: 10, z: -1, role: 'cut' },
]

// Exercises the dash policy + end caps (rapid) alongside solid roles so the
// builder's overlay option is proven on both material kinds.
const MIXED_MOVES: ToolpathMove[] = [
  { type: 'feed', x: 0, y: 0, z: -1, role: 'plunge' },
  { type: 'rapid', x: 10, y: 0, z: 5, role: 'rapid' },
  { type: 'feed', x: 10, y: 0, z: -1, role: 'plunge' },
  { type: 'feed', x: 10, y: 10, z: -1, role: 'cut' },
  { type: 'feed', x: 0, y: 10, z: -1, role: 'stepover' },
]

const MIXED_OWNERS: (MoveOwner | null)[] = [
  { operationId: 'op-1', indexInOp: 0, moveCount: 5 },
  { operationId: 'op-1', indexInOp: 1, moveCount: 5 },
  { operationId: 'op-1', indexInOp: 2, moveCount: 5 },
  { operationId: 'op-1', indexInOp: 3, moveCount: 5 },
  { operationId: 'op-1', indexInOp: 4, moveCount: 5 },
]

describe('CNCViewport Simulation toolpath preview', () => {
  it('replaces the full path with a depth-independent layer and restores it on clear', () => {
    const viewport = methodOnlyViewport()
    viewport.setSimulationToolpathPreview(LAYER_MOVES)

    const base = viewport.toolpathGroup as THREE.Group
    const preview = viewport.simulationToolpathGroup as THREE.Group
    expect(base.visible).toBe(false)
    expect(preview.visible).toBe(true)
    expect(preview.children.length).toBeGreaterThan(0)
    preview.traverse((object) => {
      if (!(object instanceof THREE.Line)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        expect(material.depthTest).toBe(false)
        expect(material.depthWrite).toBe(false)
      }
    })

    viewport.setSimulationToolpathPreview(null)
    expect(base.visible).toBe(true)
    expect(preview.visible).toBe(false)
    expect(preview.children).toHaveLength(0)
  })

  it('honors toolpath visibility and role filters while a layer is active', () => {
    const viewport = methodOnlyViewport()
    viewport.setHiddenToolpathRoles(new Set(['cut']))
    viewport.setSimulationToolpathPreview(LAYER_MOVES)

    const preview = viewport.simulationToolpathGroup as THREE.Group
    expect(preview.children[0]?.visible).toBe(false)
    viewport.setToolpathVisible(false)
    expect(preview.visible).toBe(false)
    viewport.setToolpathVisible(true)
    expect(preview.visible).toBe(true)
  })
})

describe('CNCViewport unified toolpath builder option matrix', () => {
  it('Toolpath surface (renderToolpath) respects depth and attaches move-pick payloads when owners are supplied', () => {
    const viewport = methodOnlyViewport()
    viewport.renderToolpath(MIXED_MOVES, true, MIXED_OWNERS)

    const base = viewport.toolpathGroup as THREE.Group
    expect(base.children.length).toBeGreaterThan(0)
    // overlay option OFF: depth is NOT disabled on any role body or end cap.
    base.traverse((object) => {
      if (!(object instanceof THREE.LineSegments)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        expect(material.depthTest).toBe(true)
        expect(material.depthWrite).toBe(true)
      }
    })
    // pick-attribution option ON: every registered pick body carries a payload.
    const pickBodies = viewport.toolpathPickBodies as THREE.LineSegments[]
    expect(pickBodies.length).toBeGreaterThan(0)
    for (const body of pickBodies) {
      expect((body.userData as Record<string, unknown>).toolpathPick).toBeDefined()
    }
  })

  it('Simulate surface (setSimulationToolpathPreview) draws an overlay and is NOT move-pickable', () => {
    const viewport = methodOnlyViewport()
    viewport.setSimulationToolpathPreview(MIXED_MOVES)

    const preview = viewport.simulationToolpathGroup as THREE.Group
    expect(preview.children.length).toBeGreaterThan(0)
    // overlay option ON: depth ignored on every role body and end cap.
    preview.traverse((object) => {
      if (!(object instanceof THREE.Line)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        expect(material.depthTest).toBe(false)
        expect(material.depthWrite).toBe(false)
      }
    })
    // pick-attribution option OFF for simulation: no bodies registered.
    expect(viewport.toolpathPickBodies as THREE.LineSegments[]).toHaveLength(0)
  })
})
