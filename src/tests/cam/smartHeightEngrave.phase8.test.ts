import { describe, expect, it } from 'vitest'
import type { HeightIntentV1, Tool } from '../../types'
import {
  buildEngraveSmartHeightEvidenceContext,
  buildEngraveSmartHeightIntent,
  engraveSmartHeightDraftFromIntent,
  EngraveSmartHeightError,
  rebuildEngraveSmartHeightIntent,
  resolveEngraveSmartHeights,
} from '../../lib/cam/smartHeights'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 2, provenance: 'default' },
  retract: { reference: 'feed', offset: 2, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

const tool: Tool = {
  id: 'vbit-1', name: '90 degree V-bit', type: 'v_bit', diameter: 10,
  tipDiameter: 0, angleFromAxisDeg: 45, fluteLength: 8,
  shankDiameter: 10, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
}

const scope = {
  geometryIds: ['drawing-1'], loopIds: ['line-1', 'outline-1'],
  includeOpen: true, includeClosed: true,
}

const revision = {
  projectRevision: 'project-r1', setupRevision: 'setup-r1', operationRevision: 'operation-r1',
}

function resolve(input: {
  depth?: { kind: 'explicit'; depthMm: number } | { kind: 'line_width'; targetLineWidthMm: number }
  axialOffsetMm?: number
  currentTool?: Tool
  currentScope?: typeof scope
} = {}) {
  const intent = buildEngraveSmartHeightIntent({
    setupId: 'setup-1', safetyIntent: safety,
    datumReference: 'geometry_plane', datumOffsetMm: 0.25,
    axialOffsetMm: input.axialOffsetMm ?? -0.1,
    depth: input.depth ?? { kind: 'explicit', depthMm: 0.5 },
    scope,
  })
  const evidence = buildEngraveSmartHeightEvidenceContext({
    intent, revision, wcsOriginMachineMm: 90, operationId: 'engrave-1',
    tool: input.currentTool ?? tool, scope: input.currentScope ?? scope,
    resolvedDatumMachineMm: 100, datumFingerprint: 'datum-r1',
  })
  return { intent, resolved: resolveEngraveSmartHeights({ intent, evidence }) }
}

describe('Engrave Smart Height policy adapter', () => {
  it('resolves an explicitly confirmed constant depth from the semantic datum', () => {
    const { intent, resolved } = resolve({
      depth: { kind: 'explicit', depthMm: 0.6 }, axialOffsetMm: -0.2,
    })
    expect(intent.policy).toEqual({ operationType: 'engrave', variant: 'explicit_depth' })
    expect(intent.machining.scope.value).toEqual({ kind: 'selected_paths', ...scope })
    expect(resolved.workerHeights.topHeight).toBeCloseTo(9.8, 9)
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(9.2, 9)
    expect(resolved.resolvedDepthMm).toBeCloseTo(0.6, 9)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBeCloseTo(10, 9)
  })

  it('derives groove depth from half-angle and an ideal pointed tip', () => {
    const { resolved } = resolve({
      depth: { kind: 'line_width', targetLineWidthMm: 2 }, axialOffsetMm: 0,
    })
    expect(resolved.resolvedDepthMm).toBeCloseTo(1, 9)
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(9, 9)
  })

  it('subtracts a physical tip flat from requested groove width', () => {
    const { resolved } = resolve({
      depth: { kind: 'line_width', targetLineWidthMm: 2 }, axialOffsetMm: 0,
      currentTool: { ...tool, tipDiameter: 0.5 },
    })
    expect(resolved.resolvedDepthMm).toBeCloseTo(0.75, 9)
  })

  it('refuses widths outside the usable cutter profile', () => {
    expect(() => resolve({
      depth: { kind: 'line_width', targetLineWidthMm: 0.5 },
      currentTool: { ...tool, tipDiameter: 0.5 },
    })).toThrow(/greater than the tool tip-flat diameter/)
    expect(() => resolve({
      depth: { kind: 'line_width', targetLineWidthMm: 2.1 },
      currentTool: { ...tool, diameter: 10, fluteLength: 1, angleFromAxisDeg: 45 },
    })).toThrow(/usable profile width 2/)
  })

  it('refuses an explicit cut deeper than usable flute length', () => {
    expect(() => resolve({ depth: { kind: 'explicit', depthMm: 8.1 } }))
      .toThrow(/exceeds the tool flute length/)
  })

  it('refuses stale path selection rather than transferring authority', () => {
    expect(() => resolve({
      currentScope: { ...scope, loopIds: ['replacement'] },
    })).toThrow(EngraveSmartHeightError)
  })

  it('round-trips editable authority without weakening path scope', () => {
    const { intent } = resolve()
    const rebuilt = rebuildEngraveSmartHeightIntent({
      intent, setupId: 'setup-1',
      patch: {
        datumReference: 'stock_top', datumOffsetMm: 0.4, axialOffsetMm: -0.3,
        depth: { kind: 'line_width', targetLineWidthMm: 1.5 },
      },
    })
    expect(rebuilt.machining.scope).toEqual(intent.machining.scope)
    expect(engraveSmartHeightDraftFromIntent(rebuilt)).toEqual({
      datumReference: 'stock_top', datumOffsetMm: 0.4, axialOffsetMm: -0.3,
      depth: { kind: 'line_width', targetLineWidthMm: 1.5 },
    })
    expect(rebuilt.policy).toEqual({ operationType: 'engrave', variant: 'width_derived' })
  })

  describe('WO-1969: surface following', () => {
    const surface = {
      artifactId: 'engrave-surface:engrave-1', fingerprint: 'surface-r1',
      minMachineMm: 96, maxMachineMm: 104,
      bounds: { minX: -5, minY: -5, maxX: 25, maxY: 5 },
    }
    const followIntent = () => buildEngraveSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety,
      datumReference: 'geometry_plane', datumOffsetMm: 0, axialOffsetMm: -0.1,
      depth: { kind: 'explicit', depthMm: 0.5 }, followSurface: true, scope,
    })

    it('measures Top and Bottom from the surface span, not the datum plane', () => {
      const intent = followIntent()
      expect(intent.policy).toEqual({ operationType: 'engrave', variant: 'surface_following' })
      const evidence = buildEngraveSmartHeightEvidenceContext({
        intent, revision, wcsOriginMachineMm: 90, operationId: 'engrave-1', tool, scope,
        resolvedDatumMachineMm: 104, datumFingerprint: 'datum-r1', surface,
      })
      const resolved = resolveEngraveSmartHeights({ intent, evidence })
      // Top: highest surface point + axial. Bottom: lowest surface point + axial - depth.
      expect(resolved.workerHeights.topHeight).toBeCloseTo(104 - 0.1 - 90, 9)
      expect(resolved.workerHeights.bottomHeight).toBeCloseTo(96 - 0.1 - 0.5 - 90, 9)
      expect(evidence.evidence.some(node => node.kind === 'target_surface_field')).toBe(true)
    })

    it('refuses to resolve without the sampled surface', () => {
      expect(() => buildEngraveSmartHeightEvidenceContext({
        intent: followIntent(), revision, wcsOriginMachineMm: 90, operationId: 'engrave-1', tool, scope,
        resolvedDatumMachineMm: 104, datumFingerprint: 'datum-r1',
      })).toThrow(EngraveSmartHeightError)
    })

    it('keeps following the surface through a Properties edit', () => {
      const rebuilt = rebuildEngraveSmartHeightIntent({
        intent: followIntent(), setupId: 'setup-1',
        patch: { depth: { kind: 'line_width', targetLineWidthMm: 1.2 } },
      })
      expect(rebuilt.policy).toEqual({ operationType: 'engrave', variant: 'surface_following' })
      expect(engraveSmartHeightDraftFromIntent(rebuilt).followSurface).toBe(true)
    })
  })
})
