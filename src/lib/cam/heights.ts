import type { HeightParams, Vec3 } from '../../types'

export interface ResolvedHeights {
  clearanceZ: number
  retractZ:   number
  feedZ:      number
  topZ:       number
  bottomZ:    number
}

/**
 * Resolves the canonical five-plane height model to absolute machine Z by adding
 * wcsOrigin.z to each WCS-relative input. Does not interpret height modes; modes
 * are resolved by the store before dispatch.
 */
export function resolveHeights(heights: HeightParams, wcsOrigin: Vec3): ResolvedHeights {
  const wcsZ = wcsOrigin.z
  return {
    clearanceZ: heights.clearanceHeight + wcsZ,
    retractZ:   heights.retractHeight   + wcsZ,
    feedZ:      heights.feedHeight      + wcsZ,
    topZ:       heights.topHeight       + wcsZ,
    bottomZ:    heights.bottomHeight    + wcsZ,
  }
}
