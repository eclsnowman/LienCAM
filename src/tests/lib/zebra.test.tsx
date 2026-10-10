// @vitest-environment jsdom
// Zebra display: reflection stripes on modeled bodies, switched by a uniform.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createModeledBodyMaterial } from '../../lib/viewport/lighting/bodyVisualStyle'
import { setZebra, zebraOn } from '../../lib/viewport/lighting/zebra'
import { patchMaterialForAO } from '../../lib/viewport/lighting/vertexAO'
import { WorkbenchDisplayMode } from '../../components/model3d/workbench/WorkbenchDisplayMode'

function compile(material: THREE.Material) {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {} as Record<string, THREE.IUniform>,
  } as unknown as THREE.WebGLProgramParametersWithUniforms
  material.onBeforeCompile.call(material, shader, {} as THREE.WebGLRenderer)
  return shader
}

describe('zebra stripes on modeled-body materials', () => {
  it('every body material carries the stripe code, switched off, bound to its own uniform', () => {
    const m = createModeledBodyMaterial({ vertexColors: true })
    const shader = compile(m)
    expect(shader.fragmentShader).toContain('uniform float uZebra;')
    expect(shader.fragmentShader).toMatch(/reflect\( - normalize\( vViewPosition \), normalize\( normal \) \)/)
    // the stripes come after three's final colour, so they replace it
    expect(shader.fragmentShader.indexOf('uZebra > 0.5')).toBeGreaterThan(shader.fragmentShader.indexOf('#include <dithering_fragment>'))
    expect(shader.uniforms.uZebra.value).toBe(0)
    expect(zebraOn(m)).toBe(false)
  })

  it('setZebra flips the uniform the compiled program reads - no recompile, no new program', () => {
    const m = createModeledBodyMaterial()
    const shader = compile(m)
    const version = m.version
    setZebra(m, true)
    expect(shader.uniforms.uZebra.value).toBe(1)
    expect(zebraOn(m)).toBe(true)
    setZebra(m, false)
    expect(shader.uniforms.uZebra.value).toBe(0)
    expect(m.version).toBe(version)
  })

  it('two body materials compile the same program text (one shared hook, not a closure each)', () => {
    const a = createModeledBodyMaterial(), b = createModeledBodyMaterial({ vertexColors: true })
    expect(a.onBeforeCompile).toBe(b.onBeforeCompile)
    expect(compile(a).fragmentShader).toBe(compile(b).fragmentShader)
  })

  it('the vertex-AO patch chains onto it: both land, and the AO cache key stays as pinned', () => {
    const m = createModeledBodyMaterial({ vertexColors: true })
    patchMaterialForAO(m)
    const shader = compile(m)
    expect(shader.fragmentShader).toContain('uniform float uZebra;')
    expect(shader.fragmentShader).toContain('vGeo23Ao')
    expect(m.customProgramCacheKey()).toBe('geo23-ao')
  })

  it('a material without the stripe code is left alone', () => {
    const plain = new THREE.MeshStandardMaterial()
    setZebra(plain, true)
    expect(zebraOn(plain)).toBe(false)
  })
})

describe('the Display Mode flyout', () => {
  afterEach(cleanup)
  it('offers Zebra stripes when the page passes it, and reports the toggle', () => {
    const onZebra = vi.fn()
    render(<WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} zebra={false} onZebraChange={onZebra} />)
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    fireEvent.click(screen.getByTestId('workbench-zebra'))
    expect(onZebra).toHaveBeenCalledWith(true)
  })

  it('shows no zebra row for a caller that does not pass it', () => {
    render(<WorkbenchDisplayMode mode="shaded-edges" onModeChange={() => {}} />)
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    expect(screen.queryByTestId('workbench-zebra')).toBeNull()
  })
})

describe('the Form skin', () => {
  it('carries the stripe code, and its geometry has normals before the first draw (else three shades it flat for good)', async () => {
    const { FormOverlay } = await import('../../form/formOverlay')
    const overlay = new FormOverlay({
      addObject: () => {}, removeObject: () => {}, requestRender: () => {},
      camera: () => new THREE.PerspectiveCamera(), canvas: document.createElement('canvas'),
    })
    expect(overlay.skinMesh.geometry.getAttribute('normal')).toBeDefined()
    const m = overlay.skinMesh.material as THREE.MeshStandardMaterial
    setZebra(m, true)
    expect(zebraOn(m)).toBe(true)
    overlay.dispose()
  })
})
