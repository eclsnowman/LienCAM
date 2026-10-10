import { describe, it, expect } from 'vitest'
import { buildContourToolpath, contourLoopIdsForSave } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// WO-1517: the shared precedence rule (edge chain > face pick > loop ids) is
// applied at the modal's Create-button readiness check and its edit-save path
// (NewOperationModalBody.tsx). `contourLoopIdsForSave` is the one place that
// decides which loop ids survive a save, called from BOTH the create and the
// edit-save branch, so the two can never independently drift apart again.

await ensureClipperReady()

describe('WO-1517: contourLoopIdsForSave - the save-path precedence rule', () => {
  it('keeps the loop ids when no higher-precedence boundary is effective', () => {
    expect(contourLoopIdsForSave(['loop-a', 'loop-b'], false)).toEqual(['loop-a', 'loop-b'])
    expect(contourLoopIdsForSave([], false)).toEqual([])
  })

  it('clears a saved loop-id selection once an edge chain or face pick supersedes it', () => {
    // BUG-466: a stale id from a superseded loop-based selection must not
    // survive the save to be checked against the new boundary's loops.
    expect(contourLoopIdsForSave(['stale-section-loop'], true)).toEqual([])
    expect(contourLoopIdsForSave([], true)).toEqual([])
  })
})

// Locks in the compute contract the save-path fix depends on: buildContourToolpath
// itself is UNCHANGED by this WO ("compute's own refusal for a truly missing/
// deleted selection is preserved"). Once contourLoopIdsForSave has cleared
// loopIds, an empty selection means "use every closed loop this payload was
// given" - which is exactly what the freshly-derived boundary's own loops are.
describe('WO-1517: compute honors a cleared selection against the NEW boundary', () => {
  const tool: Tool = {
    id: 't1', name: 'O3 flat', type: 'flat_end_mill',
    diameter: 3, fluteLength: 20, shankDiameter: 3, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  } as Tool
  const heights: HeightParams = {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: -2, bottomHeightMode: 'absolute',
  }
  const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  const linking: LinkingParams = {
    entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  }
  // The face/edge-chain boundary's OWN freshly-derived loop - a different id
  // than any loop-selection era id would ever have used.
  const FACE_DERIVED_LOOP: LoopData = {
    id: 'face-derived-loop', closed: true, type: 'contour',
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
  }

  function payload(loopIds: string[]): ContourWorkerPayload {
    return {
      opId: 'op', setupId: 's',
      params: { geometryId: 'g', loopIds, side: 'outer', direction: 'climb', tabs: false } as ContourParams,
      heights, passes, linking, tool, loops: [FACE_DERIVED_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    } as ContourWorkerPayload
  }

  it('a switch to a face/edge-chain boundary (loopIds correctly cleared) computes the new boundary', () => {
    const moves = buildContourToolpath(payload(contourLoopIdsForSave(['stale-section-loop'], true)))
    expect(moves.length).toBeGreaterThan(2)
  })

  it('acceptance 4: an unfixed, genuinely stale non-empty selection is still refused BY NAME', () => {
    // No superseding boundary here - a real, non-empty selection that matches
    // nothing must still fail loud, never silently fall back to "all loops".
    expect(() => buildContourToolpath(payload(contourLoopIdsForSave(['stale-section-loop'], false))))
      .toThrow(/no longer exist/i)
  })
})
