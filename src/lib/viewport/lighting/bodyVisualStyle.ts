import { installZebra } from './zebra'
import * as THREE from 'three'
import type { BodyEdgeOverlayOptions } from '../../../viewport3d/bodyPresentation'
import type { ShadingMode } from '../../../types'
import {
  VIEWPORT_THEME_COLORS,
  viewportThemeUsesFatLineEdges,
  type ViewportThemeId,
} from './viewportThemes'

/** Resting modeled bodies use one presentation in CAM and Model. Theme choice
 * changes the body paint, not the topology language: a muted body-blue edge
 * defines form without reading as a black outline over the shaded surface. */
export const MODELED_BODY_REST_EDGE_HEX = '#4e7898'
export const MODELED_BODY_WIREFRAME_EDGE_HEX = '#8fa3b2'
export const MODELED_BODY_CLASSIC_HEX = '#8ab4cc'
export const MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX = 1.75
export const MODELED_BODY_EDGE_RENDER_ORDER = 0.5

// A colored body carries its own topology shade. We aim for 2:1 raw contrast,
// with this narrow band allowing only sRGB byte rounding at the material
// boundary. That keeps a true edge legible without making it read as ink.
const MODELED_BODY_EDGE_CONTRAST_FLOOR = 1.9
const MODELED_BODY_EDGE_CONTRAST_TARGET = 2
const MODELED_BODY_EDGE_CONTRAST_CEILING = 2.1

export const MODELED_BODY_VISUAL_POLICY = {
  material: {
    metalness: 0,
    roughness: 0.52,
    polygonOffset: true,
    // The Model host uses a perspective depth slab. A 1/1 offset left
    // coplanar topology strokes fighting the body surface there even though
    // the orthographic CAM host happened to remain readable. Keep the shared
    // policy at the proven Model minimum so both projections render every
    // true edge without disabling depth testing.
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 1.5,
  },
  edge: {
    opacity: 0.72,
    linewidthPx: 0.9,
    toneMapped: false,
    depthBias: true,
  },
} as const

export interface ModeledBodyVisualStyle {
  readonly bodyHex: string
  /** Linear working-space RGB for a THREE vertex-color attribute. */
  readonly bodyLinearRgb: readonly [number, number, number]
  readonly edgeHex: string
  /** Linear working-space RGB for a THREE vertex-color attribute. */
  readonly edgeLinearRgb: readonly [number, number, number]
  readonly fatEdges: boolean
}

export interface ModeledBodyEdgeModeStyle {
  readonly color: THREE.ColorRepresentation
  readonly opacity: number
  readonly linewidthPx: number
  readonly depthTest: boolean
  readonly depthWrite: false
}

function relativeLuminance(color: THREE.Color): number {
  const srgb = color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace)
  const linear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(srgb.r) + 0.7152 * linear(srgb.g) + 0.0722 * linear(srgb.b)
}

/** Resolve a colored body's resting topology shade. The search preserves the
 * body's HSL hue and saturation and varies only lightness. Darker bodies move
 * toward white; lighter bodies move toward black. The luminance split is the
 * point at which the 2:1 lighter target remains reachable, so neither branch
 * can cross through the body color and invert into the wrong kind of shade. */
function resolveModeledBodyRestEdgeHex(
  bodyBaseColor: THREE.ColorRepresentation | undefined,
): string {
  if (bodyBaseColor === undefined) return MODELED_BODY_REST_EDGE_HEX

  const body = new THREE.Color(bodyBaseColor)
  const bodyLuminance = relativeLuminance(body)
  const hsl = body.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)
  const lighten = bodyLuminance < 0.475
  let lower = lighten ? hsl.l : 0
  let upper = lighten ? 1 : hsl.l
  const edge = new THREE.Color()

  for (let i = 0; i < 24; i += 1) {
    const lightness = (lower + upper) / 2
    edge.setHSL(hsl.h, hsl.s, lightness, THREE.SRGBColorSpace)
    const edgeLuminance = relativeLuminance(edge)
    const contrast = lighten
      ? (edgeLuminance + 0.05) / (bodyLuminance + 0.05)
      : (bodyLuminance + 0.05) / (edgeLuminance + 0.05)
    if (contrast < MODELED_BODY_EDGE_CONTRAST_TARGET) {
      if (lighten) lower = lightness
      else upper = lightness
    } else if (lighten) {
      upper = lightness
    } else {
      lower = lightness
    }
  }

  const resolvedHex = `#${edge.getHexString(THREE.SRGBColorSpace)}`
  const roundedEdgeLuminance = relativeLuminance(new THREE.Color(resolvedHex))
  const roundedContrast = lighten
    ? (roundedEdgeLuminance + 0.05) / (bodyLuminance + 0.05)
    : (bodyLuminance + 0.05) / (roundedEdgeLuminance + 0.05)
  if (
    roundedContrast < MODELED_BODY_EDGE_CONTRAST_FLOOR ||
    roundedContrast > MODELED_BODY_EDGE_CONTRAST_CEILING
  ) {
    throw new Error(`modeled body edge contrast escaped policy: ${roundedContrast}`)
  }
  return resolvedHex
}

/** Select the resting topology renderer from display semantics, never from
 * the workspace host or visual theme. Screen-space LineSegments2 currently
 * loses depth-tested coplanar segments on real WebGL GPUs, so shaded and
 * translucent bodies use native depth-tested lines. Topology-only wireframe
 * intentionally exposes every edge and retains the wider screen-space path. */
export function modeledBodyEdgeUsesFatLines(mode: ShadingMode): boolean {
  return mode === 'unshaded'
}

/** One topology language shared by the Model and CAM hosts. Shaded bodies
 * use a restrained body-blue line; topology-only mode must instead contrast
 * with the dark canvas and grid because there is no lit body behind it. */
export function resolveModeledBodyEdgeModeStyle(
  mode: ShadingMode,
  bodyBaseColor?: THREE.ColorRepresentation,
): ModeledBodyEdgeModeStyle {
  if (mode === 'unshaded') {
    return {
      color: MODELED_BODY_WIREFRAME_EDGE_HEX,
      opacity: 1,
      linewidthPx: MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX,
      depthTest: false,
      depthWrite: false,
    }
  }
  return {
    color: resolveModeledBodyRestEdgeHex(bodyBaseColor),
    opacity: MODELED_BODY_VISUAL_POLICY.edge.opacity,
    linewidthPx: MODELED_BODY_VISUAL_POLICY.edge.linewidthPx,
    depthTest: true,
    depthWrite: false,
  }
}

/** THREE vertex-color attributes are working-space values. Constructing the
 * color from its sRGB hex first performs the required sRGB -> linear transfer;
 * writing hex-byte/255 triples directly is the bug that washed out Model edges. */
export function colorManagedLinearRgb(
  color: THREE.ColorRepresentation,
): readonly [number, number, number] {
  const linear = new THREE.Color(color)
  return [linear.r, linear.g, linear.b]
}

/** Appearance controls persist 0-1 sRGB channel triples so they can round-trip
 * through HTML color inputs. Convert those UI values at the vertex-buffer
 * boundary: THREE vertex colors, like uniform material colors, are linear
 * working-space values. */
export function srgbUnitRgbToLinearRgb(
  color: readonly [number, number, number],
): readonly [number, number, number] {
  const linear = new THREE.Color().setRGB(
    color[0],
    color[1],
    color[2],
    THREE.SRGBColorSpace,
  )
  return [linear.r, linear.g, linear.b]
}

export function resolveModeledBodyVisualStyle(
  themeId: ViewportThemeId,
): ModeledBodyVisualStyle {
  const bodyHex = themeId === 'classic'
    ? MODELED_BODY_CLASSIC_HEX
    : VIEWPORT_THEME_COLORS[themeId].bodyHex
  return {
    bodyHex,
    bodyLinearRgb: colorManagedLinearRgb(bodyHex),
    edgeHex: MODELED_BODY_REST_EDGE_HEX,
    edgeLinearRgb: colorManagedLinearRgb(MODELED_BODY_REST_EDGE_HEX),
    fatEdges: viewportThemeUsesFatLineEdges(themeId),
  }
}

export function createModeledBodyMaterial(options: {
  color?: THREE.ColorRepresentation
  vertexColors?: boolean
} = {}): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: options.color ?? 0xffffff,
    vertexColors: options.vertexColors ?? false,
    metalness: MODELED_BODY_VISUAL_POLICY.material.metalness,
    roughness: MODELED_BODY_VISUAL_POLICY.material.roughness,
    polygonOffset: MODELED_BODY_VISUAL_POLICY.material.polygonOffset,
    polygonOffsetFactor: MODELED_BODY_VISUAL_POLICY.material.polygonOffsetFactor,
    polygonOffsetUnits: MODELED_BODY_VISUAL_POLICY.material.polygonOffsetUnits,
    side: THREE.DoubleSide,
  })
  // zebra stripes, switched off until the display asks for them (zebra.ts)
  installZebra(material)
  return material
}

/** Host-specific ownership, resolution, and highlight transport remain
 * explicit. Every visual property of the resting edge comes from this helper. */
export function modeledBodyEdgeOverlayOptions(
  _themeId: ViewportThemeId,
  host: Partial<Pick<
    BodyEdgeOverlayOptions,
    'vertexColors' | 'resolution' | 'ownsGeometry' | 'userData'
  >> = {},
  mode: ShadingMode = 'shaded-edges',
  bodyBaseColor?: THREE.ColorRepresentation,
): BodyEdgeOverlayOptions {
  const modeStyle = resolveModeledBodyEdgeModeStyle(mode, bodyBaseColor)
  return {
    fat: modeledBodyEdgeUsesFatLines(mode),
    // Resting topology stays a uniform material in both hosts. The Model host
    // may choose that uniform from the persisted body color; vertex colors
    // remain supported by the low-level helper for non-body consumers.
    color: host.vertexColors ? new THREE.Color(0xffffff) : new THREE.Color(modeStyle.color),
    opacity: modeStyle.opacity,
    linewidthPx: modeStyle.linewidthPx,
    vertexColors: host.vertexColors,
    depthTest: modeStyle.depthTest,
    depthWrite: modeStyle.depthWrite,
    resolution: host.resolution,
    renderOrder: MODELED_BODY_EDGE_RENDER_ORDER,
    depthBias: MODELED_BODY_VISUAL_POLICY.edge.depthBias,
    toneMapped: MODELED_BODY_VISUAL_POLICY.edge.toneMapped,
    ownsGeometry: host.ownsGeometry,
    userData: host.userData,
  }
}
