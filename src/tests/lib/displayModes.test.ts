// Pure unit tests for the GL-free display-mode helpers. No renderer required —
// constructs a bare THREE.MeshStandardMaterial and asserts the in-place mutations.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  captureMaterialBaseline,
  applyModeledBodyShadingToMaterial,
  applyShadingToMaterial,
  edgesVisibleForMode,
  modeledBodyEdgesVisibleForMode,
  sectionPlaneParams,
  stockSimDisplayStyle,
  TRANSLUCENT_OPACITY,
} from '../../lib/viewport/displayModes'

describe('captureMaterialBaseline', () => {
  it('snapshots the current display props', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.8 })
    m.depthWrite = false
    m.wireframe = false
    const base = captureMaterialBaseline(m)
    expect(base).toEqual({ transparent: true, opacity: 0.8, depthWrite: false, wireframe: false })
  })
})

describe('applyShadingToMaterial', () => {
  it('shaded-edges restores baseline (visual no-op default)', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const base = captureMaterialBaseline(m)
    // perturb, then restore via the default mode
    m.wireframe = true; m.transparent = true; m.opacity = 0.1; m.depthWrite = false
    applyShadingToMaterial(m, base, 'shaded-edges')
    expect(m.wireframe).toBe(false)
    expect(m.transparent).toBe(false)
    expect(m.opacity).toBe(1)
    expect(m.depthWrite).toBe(true)
  })

  it('shaded-no-edges restores baseline (material-identical to shaded-edges)', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const base = captureMaterialBaseline(m)
    m.wireframe = true
    applyShadingToMaterial(m, base, 'shaded-no-edges')
    expect(m.wireframe).toBe(false)
    expect(m.transparent).toBe(false)
    expect(m.opacity).toBe(1)
    expect(m.depthWrite).toBe(true)
  })

  it('unshaded sets wireframe true and leaves opacity/transparent/depthWrite at baseline', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const base = captureMaterialBaseline(m)
    applyShadingToMaterial(m, base, 'unshaded')
    expect(m.wireframe).toBe(true)
    expect(m.transparent).toBe(false)
    expect(m.opacity).toBe(1)
    expect(m.depthWrite).toBe(true)
  })

  it('translucent forces transparent, depthWrite off, clamped opacity, wireframe off', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const base = captureMaterialBaseline(m)
    applyShadingToMaterial(m, base, 'translucent')
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(false)
    expect(m.opacity).toBe(Math.min(base.opacity, TRANSLUCENT_OPACITY))
    expect(m.opacity).toBe(TRANSLUCENT_OPACITY)
    expect(m.wireframe).toBe(false)
  })

  it('translucent keeps an already-lower opacity (Math.min)', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.12 })
    const base = captureMaterialBaseline(m)
    applyShadingToMaterial(m, base, 'translucent')
    expect(m.opacity).toBe(0.12)
  })

  it('round-trip translucent -> shaded-edges restores pristine props (reversibility)', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const base = captureMaterialBaseline(m)   // capture ONCE, pristine
    applyShadingToMaterial(m, base, 'translucent')
    applyShadingToMaterial(m, base, 'shaded-edges')
    expect(m.wireframe).toBe(false)
    expect(m.transparent).toBe(false)
    expect(m.opacity).toBe(1)
    expect(m.depthWrite).toBe(true)
  })
})

describe('edgesVisibleForMode', () => {
  it('shows edges for shaded-edges and translucent, hides for the others', () => {
    expect(edgesVisibleForMode('shaded-edges')).toBe(true)
    expect(edgesVisibleForMode('translucent')).toBe(true)
    expect(edgesVisibleForMode('shaded-no-edges')).toBe(false)
    expect(edgesVisibleForMode('unshaded')).toBe(false)
  })
})

describe('stockSimDisplayStyle', () => {
  it.each([
    ['shaded-edges', true, true],
    ['shaded-no-edges', true, false],
    ['unshaded', false, true],
    ['translucent', true, true],
  ] as const)('%s resolves fill and edge visibility for both simulation engines', (
    mode,
    fillVisible,
    edgesVisible,
  ) => {
    const style = stockSimDisplayStyle(mode, 1)
    expect(style.fillVisible).toBe(fillVisible)
    expect(style.edgesVisible).toBe(edgesVisible)
  })

  it('composes Compare opacity with Translucent and restores the request on exit', () => {
    expect(stockSimDisplayStyle('shaded-edges', 0.2)).toMatchObject({
      opacity: 0.2,
      transparent: true,
      depthWrite: false,
    })
    expect(stockSimDisplayStyle('translucent', 1)).toMatchObject({
      opacity: TRANSLUCENT_OPACITY,
      transparent: true,
      depthWrite: false,
    })
    expect(stockSimDisplayStyle('translucent', 0.2).opacity).toBe(0.2)
    expect(stockSimDisplayStyle('shaded-edges', 1)).toMatchObject({
      opacity: 1,
      transparent: false,
      depthWrite: true,
    })
  })

  it('sanitizes non-finite or out-of-range opacity before applying mode semantics', () => {
    expect(stockSimDisplayStyle('shaded-edges', Number.NaN).opacity).toBe(1)
    expect(stockSimDisplayStyle('shaded-edges', -1).opacity).toBe(0)
    expect(stockSimDisplayStyle('shaded-edges', 4).opacity).toBe(1)
  })
})

describe('UI-84 modeled-body display filter', () => {
  it('Unshaded suppresses the tessellated fill without enabling triangle wireframe', () => {
    const m = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const base = captureMaterialBaseline(m)
    applyModeledBodyShadingToMaterial(m, base, 'unshaded')
    expect(m.wireframe).toBe(false)
    expect(m.transparent).toBe(true)
    expect(m.opacity).toBe(0)
    expect(m.depthWrite).toBe(false)
    expect(modeledBodyEdgesVisibleForMode('unshaded')).toBe(true)
  })

  it('keeps Translucent on the established material and edge path', () => {
    const established = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
    const modeled = established.clone()
    const establishedBase = captureMaterialBaseline(established)
    const modeledBase = captureMaterialBaseline(modeled)
    applyShadingToMaterial(established, establishedBase, 'translucent')
    applyModeledBodyShadingToMaterial(modeled, modeledBase, 'translucent')
    expect({
      wireframe: modeled.wireframe,
      transparent: modeled.transparent,
      opacity: modeled.opacity,
      depthWrite: modeled.depthWrite,
    }).toEqual({
      wireframe: established.wireframe,
      transparent: established.transparent,
      opacity: established.opacity,
      depthWrite: established.depthWrite,
    })
    expect(modeledBodyEdgesVisibleForMode('translucent')).toBe(edgesVisibleForMode('translucent'))
  })
})

describe('sectionPlaneParams', () => {
  it('axis x, pos 5, no flip -> normal [1,0,0] constant -5', () => {
    expect(sectionPlaneParams('x', 5, false)).toEqual({ normal: [1, 0, 0], constant: -5 })
  })
  it('axis x, pos 5, flip -> normal [-1,0,0] constant 5', () => {
    expect(sectionPlaneParams('x', 5, true)).toEqual({ normal: [-1, 0, 0], constant: 5 })
  })
  it('axis z, no flip -> normal [0,0,1]', () => {
    expect(sectionPlaneParams('z', 3, false)).toEqual({ normal: [0, 0, 1], constant: -3 })
  })
  it('axis y, no flip -> normal [0,1,0]', () => {
    expect(sectionPlaneParams('y', 2, false)).toEqual({ normal: [0, 1, 0], constant: -2 })
  })
})
