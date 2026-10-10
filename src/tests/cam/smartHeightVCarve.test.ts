// WO-1174: the V-carve Smart Height V2 adapter. Material Start is the datum
// minus the start depth; Cutter End is Material Start minus the operator's
// flat depth, or minus the bit's own limit when no flat depth is set.

import { describe, expect, it } from 'vitest'
import type { HeightIntentV1, Tool } from '../../types'
import {
  buildVCarveSmartHeightEvidenceContext,
  buildVCarveSmartHeightIntent,
  vcarveSmartHeightDraftFromIntent,
  vcarveToolLimitDepthMm,
  VCarveSmartHeightError,
  resolveVCarveSmartHeights,
  OPERATION_HEIGHT_POLICIES,
} from '../../lib/cam/smartHeights'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 2, provenance: 'default' },
  retract: { reference: 'feed', offset: 2, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

// 90 degree bit, 10 mm diameter, sharp: full diameter at 5 mm; flute 8 mm.
const tool: Tool = {
  id: 'vbit-1', name: '90 degree V-bit', type: 'v_bit', diameter: 10,
  tipDiameter: 0, angleFromAxisDeg: 45, fluteLength: 8,
  shankDiameter: 10, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
}

const scope = { geometryIds: ['drawing-1'], loopIds: ['outline-1', 'outline-2'] }
const revision = { projectRevision: 'project-r1', setupRevision: 'setup-r1', operationRevision: 'operation-r1' }

function resolve(input: {
  flatDepth?: { kind: 'explicit'; depthMm: number } | { kind: 'tool_limit' }
  startDepthMm?: number
  currentTool?: Tool
  currentScope?: typeof scope
} = {}) {
  const intent = buildVCarveSmartHeightIntent({
    setupId: 'setup-1', safetyIntent: safety,
    datumReference: 'geometry_plane', datumOffsetMm: 0.25,
    startDepthMm: input.startDepthMm ?? 0,
    flatDepth: input.flatDepth ?? { kind: 'tool_limit' },
    scope,
  })
  const evidence = buildVCarveSmartHeightEvidenceContext({
    intent, revision, wcsOriginMachineMm: 90, operationId: 'vcarve-1',
    tool: input.currentTool ?? tool, scope: input.currentScope ?? scope,
    resolvedDatumMachineMm: 100, datumFingerprint: 'datum-r1',
  })
  return { intent, resolved: resolveVCarveSmartHeights({ intent, evidence }) }
}

describe('V-carve Smart Height policy', () => {
  it('is a live family with two provisional variants', () => {
    const policy = OPERATION_HEIGHT_POLICIES.vcarve
    expect(policy.support).toBe('live')
    expect(Object.keys(policy.variants).sort()).toEqual(['flat_depth', 'tool_limit'])
  })

  it('tool limit: Cutter End is the depth at which the bit reaches full diameter', () => {
    const { intent, resolved } = resolve()
    expect(intent.policy).toEqual({ operationType: 'vcarve', variant: 'tool_limit' })
    expect(vcarveToolLimitDepthMm(tool)).toBeCloseTo(5, 9)
    // datum 100 machine = 10 WCS; no start depth.
    expect(resolved.workerHeights.topHeight).toBeCloseTo(10, 9)
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(5, 9)
    expect(resolved.resolvedMaxDepthMm).toBeCloseTo(5, 9)
  })

  it('tool limit: a short flute limits before the diameter does', () => {
    const { resolved } = resolve({ currentTool: { ...tool, fluteLength: 3 } })
    expect(resolved.resolvedMaxDepthMm).toBeCloseTo(3, 9)
  })

  it('tool limit: a tip flat reduces the reachable depth', () => {
    const { resolved } = resolve({ currentTool: { ...tool, tipDiameter: 2 } })
    // (10 - 2) / 2 / tan(45) = 4
    expect(resolved.resolvedMaxDepthMm).toBeCloseTo(4, 9)
  })

  it('flat depth: Cutter End is Material Start minus the flat depth', () => {
    const { intent, resolved } = resolve({ flatDepth: { kind: 'explicit', depthMm: 1.5 } })
    expect(intent.policy).toEqual({ operationType: 'vcarve', variant: 'flat_depth' })
    expect(resolved.workerHeights.topHeight).toBeCloseTo(10, 9)
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(8.5, 9)
  })

  it('start depth lowers Material Start and Cutter End together', () => {
    const { resolved } = resolve({ startDepthMm: 2, flatDepth: { kind: 'explicit', depthMm: 1 } })
    expect(resolved.workerHeights.topHeight).toBeCloseTo(8, 9)
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(7, 9)
    // The physical target stays the datum surface the carve is measured from.
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBeCloseTo(10, 9)
  })

  it('refuses a flat depth the bit cannot cut', () => {
    expect(() => resolve({ flatDepth: { kind: 'explicit', depthMm: 6 } }))
      .toThrow(/deeper than tool .* can cut \(5 mm/)
  })

  it('refuses a tool with no tip angle', () => {
    expect(() => resolve({ currentTool: { ...tool, angleFromAxisDeg: undefined } }))
      .toThrow(/needs a tip angle/)
  })

  it('refuses when the selected outlines changed', () => {
    expect(() => resolve({ currentScope: { geometryIds: ['drawing-1'], loopIds: ['outline-1'] } }))
      .toThrow(VCarveSmartHeightError)
  })

  it('round-trips the authoring draft', () => {
    const { intent } = resolve({ startDepthMm: 0.5, flatDepth: { kind: 'explicit', depthMm: 2 } })
    expect(vcarveSmartHeightDraftFromIntent(intent)).toEqual({
      datumReference: 'geometry_plane', datumOffsetMm: 0.25,
      startDepthMm: 0.5, flatDepth: { kind: 'explicit', depthMm: 2 },
    })
  })

  it('rejects a negative start depth and a non-positive flat depth', () => {
    expect(() => resolve({ startDepthMm: -1 })).toThrow(/cannot be negative/)
    expect(() => resolve({ flatDepth: { kind: 'explicit', depthMm: 0 } })).toThrow(/greater than zero/)
  })
})
