// WO-1510: resolvedMaxDepthForTool (src/lib/cam/smartHeights/vcarve.ts) must
// gate the conical depth-limit branch on the tool's declared `type`, not on
// whether it happens to carry a finite `angleFromAxisDeg`. A flat_end_mill
// saved through the ordinary Tool Library flow can still carry a leftover
// angle field from an earlier edit; that field must never make it conical.

import { describe, expect, it } from 'vitest'
import type { HeightIntentV1, Tool } from '../../types'
import {
  buildVCarveSmartHeightEvidenceContext,
  buildVCarveSmartHeightIntent,
  resolveVCarveSmartHeights,
} from '../../lib/cam/smartHeights'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 2, provenance: 'default' },
  retract: { reference: 'feed', offset: 2, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

const scope = { geometryIds: ['drawing-1'], loopIds: ['outline-1', 'outline-2'] }
const revision = { projectRevision: 'project-r1', setupRevision: 'setup-r1', operationRevision: 'operation-r1' }

// A flat clearing tool: real limit is its 18 mm flute. The 59-degree
// angleFromAxisDeg is a leftover field (e.g. from a prior edit as a V-bit)
// that has no business governing a flat end mill's depth limit.
const flatEndMillWithStrayAngle: Tool = {
  id: 'flat-1', name: '3mm flat end mill', type: 'flat_end_mill', diameter: 3,
  angleFromAxisDeg: 59, fluteLength: 18,
  shankDiameter: 3, overallLength: 40, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
}

const vbit: Tool = {
  id: 'vbit-1', name: '90 degree V-bit', type: 'v_bit', diameter: 10,
  tipDiameter: 0, angleFromAxisDeg: 45, fluteLength: 8,
  shankDiameter: 10, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
}

function resolve(input: { tool: Tool; depthMm: number }) {
  const intent = buildVCarveSmartHeightIntent({
    setupId: 'setup-1', safetyIntent: safety,
    datumReference: 'geometry_plane', datumOffsetMm: 0.25,
    startDepthMm: 0,
    flatDepth: { kind: 'explicit', depthMm: input.depthMm },
    scope,
  })
  const evidence = buildVCarveSmartHeightEvidenceContext({
    intent, revision, wcsOriginMachineMm: 90, operationId: 'vcarve-1',
    tool: input.tool, scope, resolvedDatumMachineMm: 100, datumFingerprint: 'datum-r1',
  })
  return resolveVCarveSmartHeights({ intent, evidence })
}

describe('V-carve flat-clearing depth limit reads tool.type, not a residual angle field (WO-1510)', () => {
  it('a flat_end_mill with a leftover angleFromAxisDeg resolves at its flute length, not the angle limit', () => {
    const resolved = resolve({ tool: flatEndMillWithStrayAngle, depthMm: 3 })
    expect(resolved.resolvedMaxDepthMm).toBeCloseTo(3, 9)
  })

  it('a flat_end_mill with a leftover angle still refuses a depth deeper than its flute length', () => {
    expect(() => resolve({ tool: flatEndMillWithStrayAngle, depthMm: 20 }))
      .toThrow(/deeper than tool .* can cut \(18 mm/)
  })

  it('a genuine conical tool (v_bit) is unchanged: its geometric limit still governs and still refuses', () => {
    // 90 degree bit, 10mm diameter, sharp tip: full diameter reached at 5mm.
    const resolved = resolve({ tool: vbit, depthMm: 5 })
    expect(resolved.resolvedMaxDepthMm).toBeCloseTo(5, 9)
    expect(() => resolve({ tool: vbit, depthMm: 6 }))
      .toThrow(/deeper than tool .* can cut \(5 mm/)
  })
})
