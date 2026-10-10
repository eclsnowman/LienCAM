// WO-1486: measuredParam's preferred-key selection was a single ['radius']
// fallback that missed every hole class and fell through to `entries[0]` --
// `axisX` for hole params (built axisX/axisY/axisZ/diameter/depth/openings/
// radiusCount, see src/geom/worker/defeature.ts:782). An axis-aligned hole
// rounds axisX to 0, so the picker rendered "Through hole - axisX 0 mm": a
// unitless direction component dressed up as a millimeter measurement.
// defeatureVerdictLabel shares the same helper as the picker rows and the
// SolidsWorkbenchPage console lines, so exercising it here covers both.

import { describe, expect, it } from 'vitest'
import { defeatureVerdictLabel } from '../../components/model3d/dialogs/DefeatureDialog'
import type { FeatureVerdict } from '../../geom/geom-service'

function verdict(featureClass: FeatureVerdict['featureClass'], params: FeatureVerdict['params']): FeatureVerdict {
  return {
    featureKey: `k-${featureClass}`,
    featureClass,
    removable: true,
    effect: 'add',
    faceIds: ['F1:FACE:a'],
    neighbourIds: [],
    params,
  }
}

// real shapes as built by src/geom/worker/defeature.ts, not hand-picked keys.
const HOLE_PARAMS = { axisX: 0, axisY: 0, axisZ: 1, diameter: 6, depth: 10, openings: 2, radiusCount: 1 }
const FILLET_PARAMS = { centerX: 1, centerY: 2, centerZ: 3, radius: 2 }
const CHAMFER_PARAMS = { centerX: 1, centerY: 2, centerZ: 3, width: 0.7071 }
const POCKET_OR_BOSS_PARAMS = { centerX: 5, centerY: 6, centerZ: 7, spanX: 12, spanY: 8, depth: 4, faceCount: 5 }
const SLIVER_PARAMS = { area: 0.02, centerX: 1, centerY: 2, centerZ: 3 }

describe('defeatureVerdictLabel measured-param selection (WO-1486)', () => {
  it.each([
    ['throughHole', HOLE_PARAMS] as const,
    ['blindHole', HOLE_PARAMS] as const,
    ['counterboreStack', HOLE_PARAMS] as const,
  ])('%s reports diameter, never the axis direction', (featureClass, params) => {
    const label = defeatureVerdictLabel(verdict(featureClass, params))
    expect(label).toContain('diameter 6 mm')
    expect(label).not.toMatch(/axisX|axisY|axisZ/)
  })

  it.each([
    ['filletPlanar', FILLET_PARAMS] as const,
    ['filletCurvedCorner', FILLET_PARAMS] as const,
  ])('%s keeps reporting its radius', (featureClass, params) => {
    const label = defeatureVerdictLabel(verdict(featureClass, params))
    expect(label).toContain('radius 2 mm')
  })

  it('chamferPlanar keeps reporting its width (unchanged preference order)', () => {
    const label = defeatureVerdictLabel(verdict('chamferPlanar', CHAMFER_PARAMS))
    expect(label).toContain('width 0.7071 mm')
  })

  it.each([
    ['pocket'] as const,
    ['boss'] as const,
    ['engravedText'] as const,
  ])('%s falls back to a length-like param (spanX), never a center component', (featureClass) => {
    const label = defeatureVerdictLabel(verdict(featureClass, POCKET_OR_BOSS_PARAMS))
    expect(label).toContain('spanX 12 mm')
    expect(label).not.toMatch(/centerX|centerY|centerZ/)
  })

  it('a class with no length-like param at all reports unavailable, never a position component', () => {
    const label = defeatureVerdictLabel(verdict('sliver', SLIVER_PARAMS))
    expect(label).toContain('measured parameter unavailable')
    expect(label).not.toMatch(/centerX|centerY|centerZ/)
  })

  it('never renders an axis or center numeric value with an "mm" suffix, across every class', () => {
    for (const [featureClass, params] of [
      ['throughHole', HOLE_PARAMS],
      ['blindHole', HOLE_PARAMS],
      ['counterboreStack', HOLE_PARAMS],
      ['pocket', POCKET_OR_BOSS_PARAMS],
      ['boss', POCKET_OR_BOSS_PARAMS],
      ['engravedText', POCKET_OR_BOSS_PARAMS],
      ['filletPlanar', FILLET_PARAMS],
      ['filletCurvedCorner', FILLET_PARAMS],
      ['chamferPlanar', CHAMFER_PARAMS],
      ['sliver', SLIVER_PARAMS],
    ] as const) {
      const label = defeatureVerdictLabel(verdict(featureClass, params))
      expect(label).not.toMatch(/(axisX|axisY|axisZ|centerX|centerY|centerZ) -?\d+(\.\d+)? mm/)
    }
  })
})
