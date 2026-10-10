// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { FormOverlay } from '../../form/formOverlay'
import { useFormStore } from '../../form/formStore'
import { boxCage, cylinderCage } from '../../form/starters'
import { asNumber } from '../../theme/viewportColors'

const box = () => boxCage({ segments: { x: 1, y: 1, z: 1 } })

let overlay: FormOverlay | undefined
afterEach(() => { overlay?.dispose(); overlay = undefined; useFormStore.getState().closeSession() })

describe('WO-2501 Circular count notice', () => {
  it('explains 6 -> 4 on the 8-point box and keeps the notice prefix', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'Box', cage: box() })
    useFormStore.getState().setCircularCopies(6)
    useFormStore.getState().toggleCircular()
    expect(useFormStore.getState().circularCopies).toBe(4)
    expect(useFormStore.getState().notice).toBe('Circular 4: 4 copies round the Z axis; 0 points stay on the axis; 6 copies do not fit this 8-point cage')
  })

  it('keeps a fitting request and preserves the no-copies tail for an explicit unmatched count', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'Box', cage: box() })
    useFormStore.getState().setCircularCopies(4)
    useFormStore.getState().toggleCircular()
    expect(useFormStore.getState().notice).toBe('Circular 4: 4 copies round the Z axis; 0 points stay on the axis')
    useFormStore.getState().setCircularCopies(3)
    expect(useFormStore.getState().symmetry).toBe('c3')
    expect(useFormStore.getState().notice).toBe('Circular 3: 3 copies round the Z axis; 0 points stay on the axis; 8 points have no copies and move alone')
  })

  it('restores a saved circular mode without inventing a count-change explanation', () => {
    useFormStore.getState().openSession({ featureId: 'F1', name: 'Box', cage: boxCage(), symmetry: 'c4' })
    expect(useFormStore.getState().symmetry).toBe('c4')
    expect(useFormStore.getState().notice ?? '').not.toContain('do not fit')
  })
})

describe('WO-2501 display-only circular guides', () => {
  function setup(cage = boxCage()) {
    const canvas = document.createElement('canvas')
    overlay = new FormOverlay({ canvas, camera: () => new THREE.PerspectiveCamera(), addObject: () => {}, removeObject: () => {}, requestRender: () => {} })
    const axis = overlay.root.getObjectByName('form-circular-axis') as THREE.LineSegments
    const boundaries = overlay.root.getObjectByName('form-circular-boundaries') as THREE.LineSegments
    expect(axis, 'Circular must have a Z-axis guide').toBeDefined()
    expect(boundaries, 'Circular must have copy boundaries').toBeDefined()
    const state = { cage, topologyVersion: 1, displayMode: 'both' as const, dragging: false }
    return { axis, boundaries, state }
  }

  it('shows the world Z axis and four radial boundaries round the box; off hides both', () => {
    const { axis, boundaries, state } = setup()
    const original = JSON.stringify(state.cage)
    overlay!.update({ ...state, circular: { copies: 4 } })
    expect(axis.visible).toBe(true)
    expect(boundaries.visible).toBe(true)
    expect(axis.renderOrder).toBeGreaterThan(overlay!.root.getObjectByName('form-cage-points')!.renderOrder)
    const p = axis.geometry.getAttribute('position')
    expect(p.count).toBe(2)
    expect([p.getX(0), p.getY(0), p.getX(1), p.getY(1)]).toEqual([0, 0, 0, 0])
    expect(p.getZ(0)).toBeLessThan(0)
    expect(p.getZ(1)).toBeGreaterThan(40)
    expect(boundaries.geometry.getAttribute('position').count).toBe(4 * 6)
    expect((axis.material as THREE.LineBasicMaterial).color.getHex()).toBe(asNumber('--vp-seed'))
    expect((axis.material as THREE.LineBasicMaterial).color.getHex()).not.toBe(asNumber('--vp-select-amber'))
    expect((axis.material as THREE.LineBasicMaterial).color.getHex()).not.toBe(asNumber('--vp-loop-default'))
    expect(JSON.stringify(state.cage)).toBe(original)
    overlay!.update(state)
    expect(axis.visible).toBe(false)
    expect(boundaries.visible).toBe(false)
  })

  it('redraws evenly spaced boundaries with the count and updated cage bounds, including smooth display', () => {
    const { axis, boundaries, state } = setup(cylinderCage({ segments: { x: 8, y: 1, z: 2 } }))
    overlay!.update({ ...state, circular: { copies: 8 } })
    expect(boundaries.geometry.getAttribute('position').count).toBe(8 * 6)
    const p = boundaries.geometry.getAttribute('position')
    expect(Math.atan2(p.getY(7), p.getX(7))).toBeCloseTo(Math.PI / 4)
    overlay!.update({ ...state, displayMode: 'smooth', circular: { copies: 2 }, cage: { ...state.cage, positions: state.cage.positions.map(([x, y, z]) => [x * 2, y * 2, z + 100]) } })
    expect(boundaries.geometry.getAttribute('position').count).toBe(2 * 6)
    expect(axis.visible).toBe(true)
    expect(axis.geometry.getAttribute('position').getZ(0)).toBeGreaterThan(50)
  })

  it('never raycasts guides; a mirror replaces them and keeps its own drawing', () => {
    const { axis, boundaries, state } = setup()
    overlay!.update({ ...state, circular: { copies: 4 } })
    const hits: THREE.Intersection[] = []
    const ray = new THREE.Raycaster(new THREE.Vector3(0, -100, 20), new THREE.Vector3(0, 1, 0))
    axis.raycast(ray, hits)
    boundaries.raycast(ray, hits)
    expect(hits).toEqual([])
    expect(overlay!.mirrorShown()).toBeNull()
    overlay!.update({ ...state, mirror: { normal: [1, 0, 0], at: 0 } })
    expect(axis.visible).toBe(false)
    expect(boundaries.visible).toBe(false)
    overlay!.mirrorShown()!.normal.forEach((v, i) => expect(v).toBeCloseTo(i === 0 ? 1 : 0))
    const dispose = vi.spyOn(boundaries.geometry, 'dispose')
    overlay!.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
