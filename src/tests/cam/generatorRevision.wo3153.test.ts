// WO-3153 round 4: every operation family's stamp carries its planner's
// revision. A path its planner saved before a bump reads not-current; a path
// the unchanged planner saved stays current.
import { describe, expect, it } from 'vitest'
import { createOperation } from '../../kernel/headless'
import { OPERATION_REGISTRY } from '../../kernel/registry'
import {
  generatorRevision,
  projectOperationFingerprint,
  projectOperationFingerprintMatches,
  withGeneratorRevision,
} from '../../lib/cam/generationFingerprint'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { useCamStore } from '../../store'
import type { OperationType, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'

const TOOL = { id: 'tool-wo3153', name: 'WO-3153 cutter', type: 'flat_end_mill', diameter: 6 } as Tool
const HEIGHTS: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  machine: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: [TOOL.id],
}
const FAMILIES = Object.keys(OPERATION_REGISTRY) as OperationType[]

describe('WO-3153: every planner family stamps its generator revision', () => {
  it('covers every operation type', () => {
    expect(FAMILIES).toHaveLength(17) // 11 2.5D, 6 3D; the revision table is a complete Record
  })

  it.each(FAMILIES)('%s: an older revision reads not-current, the unchanged one stays current', (type) => {
    useCamStore.getState().newProject()
    const op = createOperation(type, { id: `op-${type}`, name: type, toolId: TOOL.id })
    const setup = {
      id: 'setup-wo3153', name: 'WO-3153 setup', operationFolders: [], operations: [op], notes: '',
      wcs: { id: 'wcs-wo3153', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
      stock: { type: 'rectangular', width: 40, height: 20, depth: 5, offsetX: 0, offsetY: 0,
        offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    } as unknown as Setup
    const project = { ...useCamStore.getState().project, toolLibrary: [TOOL], setups: [setup] }
    const stamp = () => projectOperationFingerprint(project, setup, op, HEIGHTS)
    const matches = (saved: string) => projectOperationFingerprintMatches(saved, project, setup, op, HEIGHTS)
    const revision = generatorRevision(type) ?? 1

    const saved = stamp()
    expect(matches(saved), 'the unchanged planner').toBe(true)
    expect(withGeneratorRevision(type, revision, stamp)).toBe(saved)
    // The next bump renews every path this planner saved.
    expect(withGeneratorRevision(type, revision + 1, () => matches(saved)), 'after a bump').toBe(false)
    if (revision > 1) {
      const older = withGeneratorRevision(type, revision - 1, stamp)
      expect(matches(older), `saved by revision ${revision - 1}`).toBe(false)
    }
  })

  it('bumps the planners whose Full Suite paths moved under an unchanged stamp', () => {
    expect(Object.fromEntries((['adaptive_clearing_2d', 'contour_2d', 'drill', 'adaptive_3d', 'parallel_3d'] as const)
      .map(type => [type, generatorRevision(type)]))).toEqual({
      adaptive_clearing_2d: 2, contour_2d: 2, drill: 2, adaptive_3d: 2, parallel_3d: 2,
    })
  })
})
