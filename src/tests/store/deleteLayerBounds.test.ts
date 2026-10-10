// B5 stale-bounds half (docs/planning/POST-MERGE-WORKPLAN.md): deleting a 2D
// layer from the geometry tab must re-derive the bounds the transform gizmo
// anchors to. The gizmo attaches to the part's THREE group and draws at its
// ORIGIN; import establishes "loop bbox center == origin" via centerLoops, so
// deleteGeometryLayer must re-establish that invariant: re-center the
// remaining loops and compensate geo.position (rotation-aware) so the part
// does not move in world space, and refresh geo.boundingBox.
//
// Unit-level companion to svgPhantomLayer.test.ts (which drives the real
// Leadscrew SVG end-to-end); here the numbers are hand-derived so the
// rotation compensation is verified against independent arithmetic, not
// against the same helper the implementation calls.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { computeBBox2D } from '../../lib/geometry/path2d'
import type { ImportedGeometry, Loop2D, Layer2D } from '../../types'

const state = () => useCamStore.getState()
const geo = (id: string) => state().project.geometry.find(g => g.id === id)!

function squareLoop(id: string, layerId: string, x0: number, y0: number, s: number): Loop2D {
  return {
    id,
    points: [
      { x: x0, y: y0 }, { x: x0 + s, y: y0 },
      { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s },
    ],
    closed: true, type: 'contour', layerId, area: s * s,
  }
}

function make2DGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  const layers: Layer2D[] = [
    { id: 'L-real', name: 'Real', color: '#00ffff', visible: true },
    { id: 'L-phantom', name: 'Phantom', color: '#000000', visible: true },
  ]
  return {
    id: 'geo-2d', name: 'Part', filename: 'part.svg', type: 'curves_2d', format: 'svg',
    boundingBox: {
      min: { x: 10, y: 0, z: 0 }, max: { x: 110, y: 210, z: 0 },
      size: { x: 100, y: 210, z: 0 }, center: { x: 60, y: 105, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [
      squareLoop('loop-real', 'L-real', 10, 0, 10),        // center (15, 5)
      squareLoop('loop-phantom', 'L-phantom', 100, 200, 10), // far away
    ],
    layers2d: layers,
    ...over,
  }
}

function install(g: ImportedGeometry): void {
  useCamStore.setState(s => ({
    project: { ...s.project, geometry: [g] },
  }))
}

beforeEach(() => {
  useCamStore.setState(s => ({ project: { ...s.project, geometry: [] } }))
})

describe('deleteGeometryLayer re-derives bounds (B5)', () => {
  it('re-centers remaining loops and refreshes boundingBox', () => {
    install(make2DGeo())
    state().deleteGeometryLayer('geo-2d', 'L-phantom')

    const g = geo('geo-2d')
    // Remaining square was centered at (15,5) -> now centered at origin
    expect(g.loops!).toHaveLength(1)
    expect(g.loops![0].points).toEqual([
      { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 },
    ])
    expect(g.boundingBox).toEqual({
      min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 0, y: 0, z: 0 },
    })
    // Unrotated at origin: position compensates by exactly the old center
    expect(g.position).toEqual({ x: 15, y: 5, z: 0 })
  })

  it('compensates position through the geometry rotation (hand-derived numbers)', () => {
    install(make2DGeo({ position: { x: 5, y: 7, z: 2 }, rotation: { x: 0, y: 0, z: 90 } }))
    state().deleteGeometryLayer('geo-2d', 'L-phantom')

    const g = geo('geo-2d')
    // Old world image of local corner (10,0): Rz(90)*(10,0)+(5,7) = (5,17).
    // New local corner is (-5,-5); world must still be (5,17), so position
    // must become (5,7) + Rz(90)*(15,5) = (5-5, 7+15) = (0,22). Z untouched.
    expect(g.position.x).toBeCloseTo(0, 9)
    expect(g.position.y).toBeCloseTo(22, 9)
    expect(g.position.z).toBe(2)
    const corner = g.loops![0].points[0]
    const world = {
      x: corner.x * Math.cos(Math.PI / 2) - corner.y * Math.sin(Math.PI / 2) + g.position.x,
      y: corner.x * Math.sin(Math.PI / 2) + corner.y * Math.cos(Math.PI / 2) + g.position.y,
    }
    expect(world.x).toBeCloseTo(5, 9)
    expect(world.y).toBeCloseTo(17, 9)
  })

  it('shifts optimizer segments together with the points', () => {
    const base = make2DGeo()
    base.loops![0].segments = [
      { type: 'line', to: { x: 20, y: 0 } },
      { type: 'arc', to: { x: 20, y: 10 }, center: { x: 20, y: 5 }, radius: 5, clockwise: false },
    ]
    install(base)
    state().deleteGeometryLayer('geo-2d', 'L-phantom')

    const segs = geo('geo-2d').loops![0].segments!
    expect(segs[0]).toEqual({ type: 'line', to: { x: 5, y: -5 } })
    expect(segs[1]).toEqual({
      type: 'arc', to: { x: 5, y: 5 }, center: { x: 5, y: 0 }, radius: 5, clockwise: false,
    })
  })

  it('does NOT shift coordinates when a sketch-baked layer is present (frame owned elsewhere)', () => {
    const base = make2DGeo()
    base.layers2d = [
      ...base.layers2d!,
      { id: 'L-sketch', name: 'Sketch 1', color: '#ffd740', visible: true, sourceType: 'sketch' },
    ]
    base.loops = [...base.loops!, squareLoop('loop-sketch', 'L-sketch', -30, -30, 10)]
    install(base)
    state().deleteGeometryLayer('geo-2d', 'L-phantom')

    const g = geo('geo-2d')
    expect(g.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(g.loops!.find(l => l.id === 'loop-real')!.points[0]).toEqual({ x: 10, y: 0 })
    // bounds intentionally untouched too (conservative guard path)
    expect(g.boundingBox.center).toEqual({ x: 60, y: 105, z: 0 })
  })

  it('leaves STL projection geometry untouched (mesh owns its bounds)', () => {
    const base = make2DGeo({ id: 'geo-stl', format: 'stl', type: 'mesh', filename: 'part.stl' })
    install(base)
    state().deleteGeometryLayer('geo-stl', 'L-phantom')

    const g = geo('geo-stl')
    expect(g.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(g.loops!.find(l => l.id === 'loop-real')!.points[0]).toEqual({ x: 10, y: 0 })
    expect(g.boundingBox.center).toEqual({ x: 60, y: 105, z: 0 })
  })

  it('deleting the last layer zeroes the bounds and keeps the Default placeholder', () => {
    const base = make2DGeo()
    base.layers2d = [base.layers2d![0]]
    base.loops = [base.loops![0]]
    install(base)
    state().deleteGeometryLayer('geo-2d', 'L-real')

    const g = geo('geo-2d')
    expect(g.loops).toEqual([])
    expect(g.layers2d!.map(l => l.id)).toEqual(['default'])
    expect(g.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(g.boundingBox.size).toEqual({ x: 0, y: 0, z: 0 })
    expect(g.boundingBox.center).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('still purges deleted loop ids from operations (existing behavior preserved)', () => {
    install(make2DGeo())
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        setups: [{
          id: 'setup-1', name: 'Setup 1', notes: '',
          wcs: {
            id: 'wcs-1', label: 'G54', fixtureOffset: 54,
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          stock: {
            type: 'rectangular' as const,
            offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
            material: 'aluminum',
          } as never,
          operations: [{
            id: 'op-1', name: 'Op', type: 'contour_2d' as const, enabled: true,
            status: 'ready' as const, toolId: 't1',
            geometrySelections: ['loop-real', 'loop-phantom'],
            heights: {} as never, passes: {} as never, linking: {} as never,
            params: { loopIds: ['loop-real', 'loop-phantom'] } as never,
            toolpathMoves: [],
          }],
        }],
      },
    }))
    state().deleteGeometryLayer('geo-2d', 'L-phantom')

    const op = state().project.setups[0].operations[0]
    expect(op.geometrySelections).toEqual(['loop-real'])
    expect((op.params as { loopIds?: string[] }).loopIds).toEqual(['loop-real'])
    expect(op.status).toBe('outdated')
    // sanity: re-centering still happened alongside the purge
    expect(computeBBox2D(geo('geo-2d').loops!).center).toEqual({ x: 0, y: 0 })
  })
})
