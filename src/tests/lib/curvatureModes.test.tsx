// @vitest-environment jsdom
//
// Curvature display, stage 47: Gaussian curvature beside curvedness, and a range (the flat and tight radii) set
// for every body at once through shared uniforms - no recompile.

import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { vertexCurvatures, ensureCurvatureAttribute } from '../../lib/viewport/lighting/curvature'
import { CURVATURE_FLAT_MM, CURVATURE_TIGHT_MM, curvatureDisplay, curvatureLegendMm, curvatureRampT, gaussianRampT, setCurvatureDisplay } from '../../lib/viewport/lighting/zebra'
import { createModeledBodyMaterial } from '../../lib/viewport/lighting/bodyVisualStyle'

const gaussOf = (g: THREE.BufferGeometry) => {
  const P = g.getAttribute('position'), N = g.getAttribute('normal')
  return vertexCurvatures(P.array, N.array, g.index ? g.index.array : null).gaussian
}
const median = (a: ArrayLike<number>) => { const v = Array.from(a).sort((x, y) => x - y); return v[Math.floor(v.length / 2)] }

describe('Gaussian curvature per vertex', () => {
  it('a sphere: 1 / R^2; a cylinder and a plane: 0; a saddle: negative', () => {
    expect(median(gaussOf(new THREE.SphereGeometry(20, 32, 16))) * 400).toBeCloseTo(1, 1)
    for (const k of gaussOf(new THREE.CylinderGeometry(10, 10, 30, 32, 4, true))) expect(Math.abs(k)).toBeLessThan(1e-6)
    for (const k of gaussOf(new THREE.PlaneGeometry(20, 20, 4, 4))) expect(Math.abs(k)).toBeLessThan(1e-12)
    // the saddle z = (x^2 - y^2) / 40 with its true normals: K = -1 / (20^2) at the middle
    const g = new THREE.PlaneGeometry(10, 10, 10, 10)
    const P = g.getAttribute('position'), N = g.getAttribute('normal')
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i)
      P.setZ(i, (x * x - y * y) / 40)
      const n = new THREE.Vector3(-x / 20, y / 20, 1).normalize()
      N.setXYZ(i, n.x, n.y, n.z)
    }
    const K = gaussOf(g)
    const mid = Array.from({ length: P.count }, (_, i) => i).find((i) => P.getX(i) === 0 && P.getY(i) === 0)!
    expect(K[mid] * 400).toBeCloseTo(-1, 1)
    // the same saddle turned 45 deg, z = xy / 20: all of it in the cross term, K = -1 / 20^2 again
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i)
      P.setZ(i, x * y / 20)
      const n = new THREE.Vector3(-y / 20, -x / 20, 1).normalize()
      N.setXYZ(i, n.x, n.y, n.z)
    }
    expect(gaussOf(g)[mid] * 400).toBeCloseTo(-1, 1)
  })

  it('ensureCurvatureAttribute fills aGauss beside aCurvature', () => {
    const g = new THREE.SphereGeometry(10, 16, 8)
    ensureCurvatureAttribute(g)
    expect(g.getAttribute('aGauss')).toBeDefined()
    expect(median(g.getAttribute('aGauss').array) * 100).toBeCloseTo(1, 1)
  })
})

describe('the display settings', () => {
  afterEach(() => { setCurvatureDisplay({ mode: 'curvedness', flatMm: CURVATURE_FLAT_MM, tightMm: CURVATURE_TIGHT_MM }) })

  it('the range moves the ramp and the legend; the wrong way round is swapped; a radius that cannot be one is kept', () => {
    expect(curvatureRampT(50)).toBeGreaterThan(0)
    setCurvatureDisplay({ flatMm: 50, tightMm: 5 })
    expect(curvatureRampT(50)).toBe(0)
    expect(curvatureRampT(5)).toBe(1)
    expect(curvatureLegendMm()[0]).toBe(50)
    expect(curvatureLegendMm().at(-1)).toBe(5)
    expect(setCurvatureDisplay({ flatMm: 2, tightMm: 40 })).toMatchObject({ flatMm: 40, tightMm: 2 })
    expect(setCurvatureDisplay({ flatMm: -3, tightMm: Number.NaN })).toMatchObject({ flatMm: 40, tightMm: 2 })
  })

  it('Gaussian: flat or ruled at the middle of the ramp, a dome toward red, a saddle toward blue', () => {
    expect(gaussianRampT(0)).toBe(0.5)
    expect(gaussianRampT(1 / 100)).toBeGreaterThan(0.5)
    expect(gaussianRampT(-1 / 100)).toBeLessThan(0.5)
    expect(gaussianRampT(1 / 9)).toBe(1)
  })

  it('every body material reads the settings live: the mode and range uniforms are shared objects, no recompile', () => {
    const m = createModeledBodyMaterial()
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> } as unknown as THREE.WebGLProgramParametersWithUniforms
    m.onBeforeCompile.call(m, shader, {} as THREE.WebGLRenderer)
    const version = m.version
    expect(shader.vertexShader).toContain('attribute float aGauss;')
    // the shader's Gaussian ramp is gaussianRampT: signed about the middle
    expect(shader.fragmentShader).toContain('curvT = 0.5 + 0.5 * sign( vGauss ) * gaussT;')
    setCurvatureDisplay({ mode: 'gaussian', flatMm: 80, tightMm: 4 })
    expect(shader.uniforms.uCurvMode.value).toBe(1)
    expect(shader.uniforms.uCurvFlat.value).toBe(80)
    expect(shader.uniforms.uCurvTight.value).toBe(4)
    expect(m.version).toBe(version)
    expect(curvatureDisplay().mode).toBe('gaussian')
  })
})
