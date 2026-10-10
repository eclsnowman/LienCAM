// @vitest-environment jsdom
// Curvature display (Form stage 21): colours by 1 / radius on modeled bodies,
// switched by a uniform in the same shared hook as zebra.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createModeledBodyMaterial } from '../../lib/viewport/lighting/bodyVisualStyle'
import { CURVATURE_LEGEND_MM, CURVATURE_STOPS, curvatureColor, curvatureOn, curvatureRampT, setCurvature, setZebra, zebraOn } from '../../lib/viewport/lighting/zebra'
import { WorkbenchDisplayMode } from '../../components/model3d/workbench/WorkbenchDisplayMode'
import { ensureCurvatureAttribute, vertexCurvature } from '../../lib/viewport/lighting/curvature'
import { setMeshCurvature } from '../../lib/viewport/lighting/zebra'

function compile(material: THREE.Material) {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, THREE.IUniform>,
  } as unknown as THREE.WebGLProgramParametersWithUniforms
  material.onBeforeCompile.call(material, shader, {} as THREE.WebGLRenderer)
  return shader
}

describe('curvature colours on modeled-body materials', () => {
  it('every body material carries the curvature code, off, after three\'s final colour, with the ramp from the same stops', () => {
    const m = createModeledBodyMaterial()
    const shader = compile(m)
    expect(shader.fragmentShader).toContain('uniform float uCurv;')
    expect(shader.fragmentShader.indexOf('uCurv > 0.5')).toBeGreaterThan(shader.fragmentShader.indexOf('#include <dithering_fragment>'))
    // the per-vertex value (curvature.ts), carried from the vertex shader
    expect(shader.vertexShader).toContain('attribute float aCurvature;')
    expect(shader.vertexShader).toContain('vCurv = aCurvature;')
    // (stage 47: the range is read from shared uniforms, and a Gaussian branch sits beside it)
    expect(shader.fragmentShader).toContain('curvT = log( max( max( vCurv, 0.0 ) * uCurvFlat, 1.0 ) ) / curvRange;')
    expect(shader.fragmentShader).not.toContain('dFdx( curvN )')
    for (const c of CURVATURE_STOPS) expect(shader.fragmentShader).toContain(`vec3( ${c.map((v) => v.toFixed(3)).join(', ')} )`)
    expect(shader.uniforms.uCurv.value).toBe(0)
    expect(curvatureOn(m)).toBe(false)
  })

  it('setCurvature flips the bound uniform without a recompile, independent of zebra', () => {
    const m = createModeledBodyMaterial({ vertexColors: true })
    const shader = compile(m)
    const version = m.version
    setCurvature(m, true)
    expect(shader.uniforms.uCurv.value).toBe(1)
    expect(zebraOn(m)).toBe(false)
    setZebra(m, true)
    setCurvature(m, false)
    expect(shader.uniforms.uCurv.value).toBe(0)
    expect(shader.uniforms.uZebra.value).toBe(1)
    expect(m.version).toBe(version)
    // one program text for every body material still
    expect(compile(createModeledBodyMaterial()).fragmentShader).toBe(shader.fragmentShader)
  })

  it('a material without the code is left alone', () => {
    const plain = new THREE.MeshStandardMaterial()
    setCurvature(plain, true)
    expect(curvatureOn(plain)).toBe(false)
  })
})

describe('the ramp', () => {
  it('flat at 200 mm and up, red at 3 mm and down, the geometric middle in the middle', () => {
    expect(curvatureRampT(200)).toBe(0)
    expect(curvatureRampT(5000)).toBe(0)
    expect(curvatureRampT(3)).toBeCloseTo(1, 12)
    expect(curvatureRampT(0.5)).toBe(1)
    expect(curvatureRampT(Math.sqrt(200 * 3))).toBeCloseTo(0.5, 12)
    const near = (a: number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 12))
    near(curvatureColor(0), CURVATURE_STOPS[0])
    near(curvatureColor(1), CURVATURE_STOPS[4])
    near(curvatureColor(0.5), CURVATURE_STOPS[2])
    expect(CURVATURE_LEGEND_MM).toEqual([200, 70, 24, 8.6, 3])
  })
})

describe('the Display Mode flyout', () => {
  afterEach(cleanup)
  it('offers Curvature when the page passes it, reports the toggle, and shows the legend while on', () => {
    const onCurv = vi.fn()
    const { rerender } = render(<WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} zebra={false} onZebraChange={() => {}} curvature={false} onCurvatureChange={onCurv} />)
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    expect(screen.queryByTestId('workbench-curvature-legend')).toBeNull()
    fireEvent.click(screen.getByTestId('workbench-curvature'))
    expect(onCurv).toHaveBeenCalledWith(true)
    rerender(<WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} zebra={false} onZebraChange={() => {}} curvature onCurvatureChange={onCurv} />)
    expect(screen.getByTestId('workbench-curvature-legend').textContent).toContain('200+')
    expect(screen.getByTestId('workbench-curvature-legend').textContent).toContain('3-')
  })

  it('shows no curvature row for a caller that does not pass it', () => {
    render(<WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} zebra={false} onZebraChange={() => {}} />)
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    expect(screen.queryByTestId('workbench-curvature')).toBeNull()
  })
})

describe('the Form skin', () => {
  it('carries the curvature switch', async () => {
    const { FormOverlay } = await import('../../form/formOverlay')
    const overlay = new FormOverlay({
      addObject: () => {}, removeObject: () => {}, requestRender: () => {},
      camera: () => new THREE.PerspectiveCamera(), canvas: document.createElement('canvas'),
    })
    const m = overlay.skinMesh.material as THREE.MeshStandardMaterial
    setCurvature(m, true)
    expect(curvatureOn(m)).toBe(true)
    overlay.dispose()
  })

  it('after a point drag is released the colours are the dragged shape\'s, not the pre-drag ones (the drag runs a level down, so the rest buffers come back fresh)', async () => {
    const { FormOverlay } = await import('../../form/formOverlay')
    const { sphereCage } = await import('../../form/starters')
    const overlay = new FormOverlay({
      addObject: () => {}, removeObject: () => {}, requestRender: () => {},
      camera: () => new THREE.PerspectiveCamera(), canvas: document.createElement('canvas'),
    })
    setCurvature(overlay.skinMesh.material as THREE.Material, true)
    const cage = sphereCage()
    overlay.update({ cage, topologyVersion: 1, displayMode: 'both', dragging: false })
    const g = overlay.skinMesh.geometry
    const before = Float32Array.from(g.getAttribute('aCurvature').array as Float32Array)
    const moved = { ...cage, positions: cage.positions.map((p, i) => (i === 0 ? [p[0] * 3, p[1] * 3, p[2] * 3] as typeof p : p)) }
    overlay.update({ cage: moved, topologyVersion: 1, displayMode: 'both', dragging: true })
    overlay.update({ cage: moved, topologyVersion: 1, displayMode: 'both', dragging: false })
    const shown = g.getAttribute('aCurvature').array as Float32Array
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal')
    const fresh = vertexCurvature(pos.array, nor.array, g.index ? g.index.array : null)
    expect(shown.length).toBe(before.length)
    let offFresh = 0, offBefore = 0
    for (let i = 0; i < shown.length; i++) { offFresh = Math.max(offFresh, Math.abs(shown[i] - fresh[i])); offBefore = Math.max(offBefore, Math.abs(shown[i] - before[i])) }
    // what is shown is the released shape's curvature, and that differs from before the drag
    expect(offFresh).toBeLessThan(1e-6)
    expect(offBefore).toBeGreaterThan(0.1)
    overlay.dispose()
  })
})

describe('per-vertex curvature (curvature.ts)', () => {
  const values = (g: THREE.BufferGeometry) => Array.from(vertexCurvature(g.getAttribute('position').array, g.getAttribute('normal').array, g.index ? g.index.array : null))

  it('a sphere reads 1 / R at every vertex, poles included, fine or coarse', () => {
    for (const [w, h] of [[48, 24], [8, 6]]) {
      const v = values(new THREE.SphereGeometry(20, w, h))
      for (const k of v) expect(Math.abs(k * 20 - 1)).toBeLessThan(0.01)
    }
    for (const k of values(new THREE.SphereGeometry(6, 32, 16))) expect(Math.abs(k * 6 - 1)).toBeLessThan(0.01)
  })

  it('a cylinder reads its curvedness 1 / (r sqrt 2); a plane and a box\'s faces read 0 (sharp edges are not curvature)', () => {
    const cyl = new THREE.CylinderGeometry(10, 10, 40, 48, 4, true)
    for (const k of values(cyl)) expect(Math.abs(k * 10 * Math.SQRT2 - 1)).toBeLessThan(0.02)
    for (const k of values(new THREE.PlaneGeometry(30, 20, 5, 5))) expect(k).toBeLessThan(1e-9)
    for (const k of values(new THREE.BoxGeometry(20, 20, 20, 3, 3, 3))) expect(k).toBeLessThan(1e-9)
  })

  it('a vertex with too few edge directions to fit (a grid corner) takes its fitted neighbours\' value, not the edges\' rms', () => {
    // an 8 x 4 grid wrapped on a cylinder of radius 20, turned 30 deg to its axis (so the corner's two edge
    // curvatures do not happen to have the right rms): the corner vertex has edges in two directions only
    const g = new THREE.PlaneGeometry(40, 20, 8, 4)
    const P = g.getAttribute('position'), N = g.getAttribute('normal')
    const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6)
    for (let i = 0; i < P.count; i++) {
      const u = P.getX(i), v = P.getY(i)
      const a = (u * c - v * sn) / 20, z = u * sn + v * c
      P.setXYZ(i, 20 * Math.sin(a), -20 * Math.cos(a), z)
      N.setXYZ(i, Math.sin(a), -Math.cos(a), 0)
    }
    for (const k of values(g)) expect(Math.abs(k * 20 * Math.SQRT2 - 1)).toBeLessThan(0.01)
  })

  it('the attribute is cached until the geometry changes; setMeshCurvature switches the material and fills it', () => {
    const g = new THREE.SphereGeometry(20, 16, 8)
    ensureCurvatureAttribute(g)
    const first = g.getAttribute('aCurvature')
    ensureCurvatureAttribute(g)
    expect(g.getAttribute('aCurvature')).toBe(first)
    g.getAttribute('position').needsUpdate = true
    ensureCurvatureAttribute(g)
    expect(g.getAttribute('aCurvature')).not.toBe(first)
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 8), createModeledBodyMaterial())
    setMeshCurvature(mesh, true)
    expect(curvatureOn(mesh.material as THREE.Material)).toBe(true)
    expect(mesh.geometry.getAttribute('aCurvature').getX(0)).toBeCloseTo(0.2, 3)
  })
})
