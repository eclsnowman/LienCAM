// ── Viewport display (shading) modes + section-clip params ─────────────────────
// PURE, GL-free helpers so the display-mode logic is fully unit-testable without a
// WebGL renderer. CNCViewport.ts owns the GL wiring; this module owns the decision
// of "what does each shading mode do to a material" and "what plane does a section
// view define". Keeping it pure means the math is byte-stable and testable.
//
// IMPORTANT invariant: the DEFAULT mode ('shaded-edges') is a baseline RESTORE — a
// visual no-op against a pristine material. Modes mutate a material RELATIVE to its
// captured baseline so any mode -> default round-trips back to the original render.
// None of these helpers touch material.emissive, so part-selection highlighting
// (which drives emissive in CNCViewport.setSelectedPart) composes independently.

import * as THREE from 'three'
import type { ShadingMode, SectionAxis } from '../../types'

export const DEFAULT_SHADING_MODE: ShadingMode = 'shaded-edges'
export const TRANSLUCENT_OPACITY = 0.35

export interface MaterialBaseline {
  transparent: boolean
  opacity: number
  depthWrite: boolean
  wireframe: boolean
}

/** Snapshot a material's pristine display props so a later mode change can restore
 *  them. Capture ONCE per material (before any mode mutation) — see CNCViewport. */
export function captureMaterialBaseline(m: THREE.MeshStandardMaterial): MaterialBaseline {
  return { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, wireframe: m.wireframe }
}

/** Mutate `m` in place for `mode`, RELATIVE to its captured pristine `base`. The
 *  shaded modes restore the baseline exactly (so default = no-op); unshaded flips
 *  the surface to wireframe; translucent forces see-through with depthWrite off. */
export function applyShadingToMaterial(m: THREE.MeshStandardMaterial, base: MaterialBaseline, mode: ShadingMode): void {
  switch (mode) {
    case 'shaded-edges':
    case 'shaded-no-edges':
      m.wireframe = base.wireframe; m.transparent = base.transparent; m.opacity = base.opacity; m.depthWrite = base.depthWrite
      break
    case 'unshaded':
      m.wireframe = true; m.transparent = base.transparent; m.opacity = base.opacity; m.depthWrite = base.depthWrite
      break
    case 'translucent':
      m.wireframe = false; m.transparent = true; m.opacity = Math.min(base.opacity, TRANSLUCENT_OPACITY); m.depthWrite = false
      break
  }
  m.needsUpdate = true
}

/** Apply display-mode shading to a modeled B-rep body. Unlike imported STL
 *  meshes, modeled bodies already carry a kernel-derived topological edge
 *  overlay. Unshaded therefore suppresses the tessellated fill without setting
 *  THREE's triangle-wireframe flag; the caller displays that existing overlay. */
export function applyModeledBodyShadingToMaterial(
  m: THREE.MeshStandardMaterial,
  base: MaterialBaseline,
  mode: ShadingMode,
): void {
  switch (mode) {
    case 'unshaded':
      // UI-84 future reservation: when STL modeling reaches the Model workspace,
      // add a separate show/hide facet-edge toggle here. STL facets are real
      // polygon edges and must not be folded into this B-rep topology filter.
      m.wireframe = false
      m.transparent = true
      m.opacity = 0
      m.depthWrite = false
      m.needsUpdate = true
      return
    default:
      // Translucent and both shaded modes stay byte-for-byte on the established
      // material path; UI-84 changes only the modeled-body Unshaded filter.
      applyShadingToMaterial(m, base, mode)
  }
}

/** Whether the baked display edges (STL/B-rep/stock wireframe overlays) should be
 *  shown for `mode`. Edges read as clutter on a flat wireframe or no-edge shade. */
export function edgesVisibleForMode(mode: ShadingMode): boolean {
  return mode === 'shaded-edges' || mode === 'translucent'
}

/** Modeled bodies reuse the same kernel edge overlay in Translucent and
 *  Unshaded. This selects visibility only; it never derives another edge set. */
export function modeledBodyEdgesVisibleForMode(mode: ShadingMode): boolean {
  return mode === 'unshaded' || edgesVisibleForMode(mode)
}

export interface StockSimDisplayStyle {
  /** Lit simulation surface. Wireframe mode suppresses it in favour of edges. */
  fillVisible: boolean
  /** Heightmap overlay / voxel shader surface-grid treatment. */
  edgesVisible: boolean
  /** Effective alpha after composing the display mode with Compare opacity. */
  opacity: number
  transparent: boolean
  depthWrite: boolean
}

/**
 * Resolve one display contract for both stock-removal render engines.
 *
 * Stock simulation has a user-controlled Compare opacity in addition to the
 * global display mode. Keep that value independent so leaving Translucent
 * restores it exactly. Unlike a generic THREE mesh, simulation wireframe uses
 * a dedicated edge carrier (heightmap) or shader surface grid (voxel), so
 * Unshaded hides the fill and explicitly enables those edges.
 */
export function stockSimDisplayStyle(
  mode: ShadingMode,
  requestedOpacity: number,
): StockSimDisplayStyle {
  const safeOpacity = Number.isFinite(requestedOpacity)
    ? THREE.MathUtils.clamp(requestedOpacity, 0, 1)
    : 1
  const opacity = mode === 'translucent'
    ? Math.min(safeOpacity, TRANSLUCENT_OPACITY)
    : safeOpacity
  const transparent = opacity < 0.999
  return {
    fillVisible: mode !== 'unshaded',
    edgesVisible: mode !== 'shaded-no-edges',
    opacity,
    transparent,
    depthWrite: !transparent,
  }
}

/** Section clip-plane params for THREE.Plane(normal, constant): the kept half-space
 *  is where (normal . point + constant) >= 0. No flip keeps the axis-positive side
 *  of `position` (e.g. x: normal (1,0,0), constant -position keeps x >= position);
 *  flip negates the normal so the axis-negative side is kept instead. */
export function sectionPlaneParams(axis: SectionAxis, position: number, flip: boolean): { normal: [number, number, number]; constant: number } {
  const sign = flip ? -1 : 1
  const n: [number, number, number] = axis === 'x' ? [sign, 0, 0] : axis === 'y' ? [0, sign, 0] : [0, 0, sign]
  const constant = -sign * position
  return { normal: n, constant }
}
