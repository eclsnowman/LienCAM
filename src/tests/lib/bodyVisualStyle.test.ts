import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  MODELED_BODY_REST_EDGE_HEX,
  MODELED_BODY_EDGE_RENDER_ORDER,
  MODELED_BODY_VISUAL_POLICY,
  MODELED_BODY_WIREFRAME_EDGE_HEX,
  MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX,
  colorManagedLinearRgb,
  createModeledBodyMaterial,
  modeledBodyEdgeOverlayOptions,
  modeledBodyEdgeUsesFatLines,
  resolveModeledBodyEdgeModeStyle,
  resolveModeledBodyVisualStyle,
  srgbUnitRgbToLinearRgb,
} from '../../lib/viewport/lighting/bodyVisualStyle'
import {
  INTERACTION_EDGE_WIDTH_PX,
  INTERACTION_SELECTED_EDGE_WIDTH_PX,
} from '../../viewport3d/interactionPresentation'
import {
  CAM_ACCENT_LIGHTS,
  CAM_ENV_INTENSITY,
  MODELED_BODY_STUDIO_ENV_INTENSITY,
  MODELED_BODY_STUDIO_EXPOSURE,
  WORKBENCH_ACCENT_LIGHTS,
  WORKBENCH_ENV_INTENSITY,
  WORKBENCH_EXPOSURE,
} from '../../lib/viewport/lighting/rigDescriptors'
import { buildModeledBodyStudioRig } from '../../lib/viewport/lighting/workbenchRig'
import {
  VIEWPORT_THEME_EDGE_WIDTH_PX,
  VIEWPORT_THEME_IDS,
} from '../../lib/viewport/lighting/viewportThemes'

describe('shared modeled-body visual contract', () => {
  const relativeLuminance = (hex: string): number => {
    const channel = (offset: number): number => {
      const srgb = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const contrast = (a: string, b: string): number => {
    const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
    return (lighter + 0.05) / (darker + 0.05)
  }

  it('uses one muted blue color-managed topology edge for every shipped body theme', () => {
    const expectedLinear = new THREE.Color(MODELED_BODY_REST_EDGE_HEX).toArray()
    for (const themeId of VIEWPORT_THEME_IDS) {
      const style = resolveModeledBodyVisualStyle(themeId)
      expect(style.edgeHex).toBe(MODELED_BODY_REST_EDGE_HEX)
      expect(style.edgeLinearRgb).toEqual(expectedLinear)
      expect(Math.max(...style.edgeLinearRgb)).toBeGreaterThan(0.15)
    }

    // The old Model path wrote sRGB byte fractions directly into a working-
    // space vertex buffer. The managed values must be materially darker.
    expect(colorManagedLinearRgb('#4e7898')).not.toEqual([
      0x4e / 255,
      0x78 / 255,
      0x98 / 255,
    ])
  })

  it('converts persisted sRGB channel triples to the same linear color as CAM hex materials', () => {
    const camLinear = new THREE.Color('#ff8800').toArray()
    expect(srgbUnitRgbToLinearRgb([1, 0x88 / 255, 0])).toEqual(camLinear)
    expect(srgbUnitRgbToLinearRgb([1, 0x88 / 255, 0])).not.toEqual([1, 0x88 / 255, 0])
  })

  it('keeps CAM uniform-color and Model vertex-color edge transports on one visual policy', () => {
    const cam = modeledBodyEdgeOverlayOptions('brand-blue', { vertexColors: false })
    const model = modeledBodyEdgeOverlayOptions('brand-blue', { vertexColors: true })
    expect({
      opacity: cam.opacity,
      width: cam.linewidthPx,
      depthBias: cam.depthBias,
      toneMapped: cam.toneMapped,
      fat: cam.fat,
    }).toEqual({
      opacity: model.opacity,
      width: model.linewidthPx,
      depthBias: model.depthBias,
      toneMapped: model.toneMapped,
      fat: model.fat,
    })
    expect((cam.color as THREE.Color).getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
    expect((model.color as THREE.Color).getHexString()).toBe('ffffff')
    expect(cam.vertexColors).toBe(false)
    expect(model.vertexColors).toBe(true)
    // CSS-pixel contract: host resolution/DPR changes line rasterization
    // only; it must never scale the resting stroke supplied to LineMaterial.
    expect(VIEWPORT_THEME_EDGE_WIDTH_PX).toBe(1.25)
    expect(cam.linewidthPx).toBe(0.9)
    expect(model.linewidthPx).toBe(0.9)
    expect(cam.linewidthPx).toBeLessThan(VIEWPORT_THEME_EDGE_WIDTH_PX)
  })

  it('uses a higher-contrast, wider topology-only policy while interactions remain heavier', () => {
    const shaded = resolveModeledBodyEdgeModeStyle('shaded-edges')
    const translucent = resolveModeledBodyEdgeModeStyle('translucent')
    const wire = resolveModeledBodyEdgeModeStyle('unshaded')

    expect(translucent).toEqual(shaded)
    expect(shaded).toEqual({
      color: MODELED_BODY_REST_EDGE_HEX,
      opacity: 0.72,
      linewidthPx: 0.9,
      depthTest: true,
      depthWrite: false,
    })
    expect(wire).toEqual({
      color: MODELED_BODY_WIREFRAME_EDGE_HEX,
      opacity: 1,
      linewidthPx: MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX,
      depthTest: false,
      depthWrite: false,
    })
    expect(contrast(MODELED_BODY_WIREFRAME_EDGE_HEX, '#111418')).toBeGreaterThan(7)
    expect(contrast(MODELED_BODY_WIREFRAME_EDGE_HEX, '#2a2f36')).toBeGreaterThan(5)
    expect(wire.linewidthPx).toBeLessThan(INTERACTION_EDGE_WIDTH_PX)
    expect(INTERACTION_EDGE_WIDTH_PX).toBeLessThan(INTERACTION_SELECTED_EDGE_WIDTH_PX)
  })

  it('derives shaded resting edges from each body color without inverting on black or white', () => {
    const black = resolveModeledBodyEdgeModeStyle('shaded-edges', '#000000')
    const white = resolveModeledBodyEdgeModeStyle('shaded-edges', '#ffffff')

    // The named 1.9:1..2.1:1 raw contrast band keeps even extreme body
    // colors legible without turning the topology into an outline.
    for (const [body, edge] of [['#000000', black.color], ['#ffffff', white.color]] as const) {
      expect(contrast(body, edge as string)).toBeGreaterThanOrEqual(1.9)
      expect(contrast(body, edge as string)).toBeLessThanOrEqual(2.1)
    }
    expect(relativeLuminance(black.color as string)).toBeGreaterThan(relativeLuminance('#000000'))
    expect(relativeLuminance(white.color as string)).toBeLessThan(relativeLuminance('#ffffff'))
    expect(black.color).toBe('#3f3f3f')
    expect(white.color).toBe('#b7b7b7')

    // No body color remains byte-identical to the WO-1197 fallback.
    expect(resolveModeledBodyEdgeModeStyle('shaded-edges')).toMatchObject({
      color: MODELED_BODY_REST_EDGE_HEX,
      opacity: 0.72,
      linewidthPx: 0.9,
      depthTest: true,
      depthWrite: false,
    })
  })

  it('keeps the unshaded topology branch byte-identical', () => {
    expect(resolveModeledBodyEdgeModeStyle('unshaded')).toEqual({
      color: '#8fa3b2',
      opacity: 1,
      linewidthPx: 1.75,
      depthTest: false,
      depthWrite: false,
    })
  })

  it('selects the edge renderer from display semantics, independent of host and theme', () => {
    for (const theme of VIEWPORT_THEME_IDS) {
      for (const mode of ['shaded-edges', 'shaded-no-edges', 'translucent'] as const) {
        expect(modeledBodyEdgeUsesFatLines(mode)).toBe(false)
        const options = modeledBodyEdgeOverlayOptions(theme, {}, mode)
        expect(options.fat).toBe(false)
        expect(options.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
      }
      expect(modeledBodyEdgeUsesFatLines('unshaded')).toBe(true)
      const wireframe = modeledBodyEdgeOverlayOptions(theme, {}, 'unshaded')
      expect(wireframe.fat).toBe(true)
      expect(wireframe.linewidthPx).toBe(1.75)
      expect(wireframe.depthTest).toBe(false)
      expect(wireframe.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    }
  })

  it('uses identical dielectric coefficients for uniform and vertex-colored bodies', () => {
    const cam = createModeledBodyMaterial({ color: '#7ec0ff' })
    const model = createModeledBodyMaterial({ vertexColors: true })
    for (const material of [cam, model]) {
      expect(material.metalness).toBe(MODELED_BODY_VISUAL_POLICY.material.metalness)
      expect(material.roughness).toBe(MODELED_BODY_VISUAL_POLICY.material.roughness)
      expect(material.polygonOffset).toBe(true)
      expect(material.polygonOffsetFactor).toBeGreaterThanOrEqual(1.5)
      expect(material.polygonOffsetUnits).toBeGreaterThanOrEqual(1.5)
    }
    expect(cam.vertexColors).toBe(false)
    expect(model.vertexColors).toBe(true)
  })

  it('builds one fixed world-space studio profile for both viewport hosts', () => {
    expect(CAM_ENV_INTENSITY).toBe(MODELED_BODY_STUDIO_ENV_INTENSITY)
    expect(WORKBENCH_ENV_INTENSITY).toBe(MODELED_BODY_STUDIO_ENV_INTENSITY)
    expect(WORKBENCH_EXPOSURE).toBe(MODELED_BODY_STUDIO_EXPOSURE)
    expect(WORKBENCH_ACCENT_LIGHTS).toEqual(
      CAM_ACCENT_LIGHTS.map(({ role, position, intensity }) => ({ role, position, intensity })),
    )

    const rig = buildModeledBodyStudioRig()
    expect(rig.accents.map((light) => light.position.toArray())).toEqual(
      CAM_ACCENT_LIGHTS.map((light) => [...light.position]),
    )
    expect(rig.accents.map((light) => light.intensity)).toEqual(
      CAM_ACCENT_LIGHTS.map((light) => light.intensity),
    )
    expect(rig.accents.every((light) => light.parent === null)).toBe(true)
  })
})
