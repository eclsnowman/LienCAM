import { describe, expect, it } from 'vitest'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import {
  MODEL_EDGE_NDC_DEPTH_BIAS,
  installDepthSafeBodyEdgeBias,
} from '../../components/model3d/depthSafeBodyEdges'

describe('depth-safe Model body edges', () => {
  it('adds a deterministic clip-space lift while retaining hidden-edge occlusion', () => {
    const material = new LineMaterial()
    installDepthSafeBodyEdgeBias(material)

    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.polygonOffset).toBe(false)
    expect(material.userData.modelEdgeNdcDepthBias).toBe(MODEL_EDGE_NDC_DEPTH_BIAS)
    expect(MODEL_EDGE_NDC_DEPTH_BIAS).toBeGreaterThan(0)
    expect(MODEL_EDGE_NDC_DEPTH_BIAS).toBeLessThan(1e-3)

    const shader = {
      vertexShader: 'void main() { vec4 clip = vec4(0.0); gl_Position = clip; }',
      fragmentShader: '',
      uniforms: {},
    }
    material.onBeforeCompile(shader as never, {} as never)
    expect(shader.vertexShader).toContain(
      `gl_Position.z -= ${MODEL_EDGE_NDC_DEPTH_BIAS.toExponential()} * gl_Position.w;`,
    )
    expect(material.customProgramCacheKey()).toContain(String(MODEL_EDGE_NDC_DEPTH_BIAS))
  })

  it('fails loudly if a Three.js upgrade removes the audited shader anchor', () => {
    const material = new LineMaterial()
    installDepthSafeBodyEdgeBias(material)
    const shader = { vertexShader: 'void main() {}', fragmentShader: '', uniforms: {} }
    expect(() => material.onBeforeCompile(shader as never, {} as never)).toThrow(
      /clip assignment/,
    )
  })
})
