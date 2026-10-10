// @vitest-environment jsdom
//
// Q-75 (Operator) render-gate pins for two workbench genesis-glyph changes:
//   1. HALO FAINTER  -- the in-plane XY/YZ/XZ plane label is dialled down (lower quad opacity,
//      lighter font weight, softer glow). This pins the quad opacity at its reduced value so a
//      mutation back toward the old louder 0.9 fails.
//   2. XYZ TRIAD     -- the always-on origin glyph is now a proper labelled orientation triad:
//      three token-coloured arms (--vp-axis-x/y/z), a cone arrowhead per arm, and an X/Y/Z letter
//      sprite per arm. Pins presence, the axis letters, the app-token colours, and that the ambient
//      variant is subtle (transparent, opacity 0.7) while the emphasis variant stays solid.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { buildGenesisGlyph } from '../../components/model3d/workbench/genesisGlyphs'
import { ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID } from '../../doc'
import { asNumber } from '../../theme/viewportColors'
import { stubCanvas2d } from './stubCanvas2d'

let restore: (() => void) | null = null
beforeEach(() => { restore = stubCanvas2d() })
afterEach(() => { restore?.(); restore = null })

function collect(glyph: THREE.Object3D): { lines: THREE.Line[]; sprites: THREE.Sprite[]; cones: THREE.Mesh[]; labelMeshes: THREE.Mesh[] } {
  const lines: THREE.Line[] = []
  const sprites: THREE.Sprite[] = []
  const cones: THREE.Mesh[] = []
  const labelMeshes: THREE.Mesh[] = []
  glyph.traverse((o) => {
    if (o.type === 'Sprite') sprites.push(o as THREE.Sprite)
    else if (o.type === 'Line') lines.push(o as THREE.Line)
    else if (o.type === 'Mesh') {
      const m = o as THREE.Mesh
      if (typeof m.userData?.planeLabel === 'string') labelMeshes.push(m)
      else if ((m.geometry as THREE.BufferGeometry).type === 'ConeGeometry') cones.push(m)
    }
  })
  return { lines, sprites, cones, labelMeshes }
}

describe('Q-75 halo fainter (in-plane plane label)', () => {
  it('the ambient XY plane label quad is fainter (opacity 0.5, was 0.9) and still tagged', () => {
    const glyph = buildGenesisGlyph(BASE_PLANE_XY_NODE_ID, 'ambient')
    expect(glyph).not.toBeNull()
    const { labelMeshes } = collect(glyph as THREE.Object3D)
    expect(labelMeshes).toHaveLength(1)
    const mat = labelMeshes[0].material as THREE.MeshBasicMaterial
    expect(mat.transparent).toBe(true)
    // The reduced weight. A mutation back toward the old louder 0.9 fails here.
    expect(mat.opacity).toBe(0.5)
    expect(mat.opacity).toBeLessThan(0.9)
    expect(mat.map).toBeTruthy() // still a textured glyph (legible), not removed
    expect(labelMeshes[0].userData.planeLabel).toBe('XY')
  })
})

describe('Q-75 XYZ orientation triad (always-on origin glyph)', () => {
  it('renders three token-coloured arms, three cone arrowheads and X/Y/Z letters', () => {
    const glyph = buildGenesisGlyph(ORIGIN_NODE_ID, 'ambient')
    expect(glyph).not.toBeNull()
    const { lines, sprites, cones } = collect(glyph as THREE.Object3D)

    // Presence: a real triad, not empty furniture.
    expect(lines).toHaveLength(3)
    expect(cones).toHaveLength(3)
    expect(sprites).toHaveLength(3)

    // The three axis letters, one per arm.
    const letters = sprites.map((s) => s.userData.axisLabel).sort()
    expect(letters).toEqual(['X', 'Y', 'Z'])

    // Arm colours come from the app's --vp-axis-x/y/z tokens (coherent with the CAM WCS triad and the
    // nav view-cube arrows), NOT a bespoke pastel palette.
    const armColors = lines.map((l) => (l.material as THREE.LineBasicMaterial).color.getHex()).sort()
    const expected = [asNumber('--vp-axis-x'), asNumber('--vp-axis-y'), asNumber('--vp-axis-z')].sort()
    expect(armColors).toEqual(expected)

    // Ambient triad is subtle: transparent, opacity 0.7 (a touch more present than the old faint 0.4,
    // still not loud).
    for (const l of lines) {
      const m = l.material as THREE.LineBasicMaterial
      expect(m.transparent).toBe(true)
      expect(m.opacity).toBe(0.7)
    }
  })

  it('the emphasis (hover/selection) variant stays fully opaque', () => {
    const glyph = buildGenesisGlyph(ORIGIN_NODE_ID, 'emphasis')
    const { lines } = collect(glyph as THREE.Object3D)
    expect(lines).toHaveLength(3)
    for (const l of lines) {
      const m = l.material as THREE.LineBasicMaterial
      expect(m.transparent).toBe(false)
      expect(m.opacity).toBe(1)
    }
  })
})
