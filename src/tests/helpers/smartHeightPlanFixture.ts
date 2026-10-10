import {
  validatePersistedSmartHeightState,
  type ResolvedHeightPlanV2,
  type SmartHeightIntentOwner,
} from '../../lib/cam/smartHeights'
import type { Operation, ResolvedHeightSnapshotV1 } from '../../types'

const setupOwner = { kind: 'setup' as const, setupId: 'setup-1' }
const policyOwner = { kind: 'operation_policy' as const }

export function smartHeightPlanFixture(
  operation: Operation,
  snapshot: ResolvedHeightSnapshotV1,
): ResolvedHeightPlanV2 {
  const validated = validatePersistedSmartHeightState(operation.smartHeight)
  if (!validated.ok) {
    throw new Error(`Test operation has no valid Smart Height V2 authority: ${validated.message}`)
  }

  const component = (
    plane: keyof ResolvedHeightSnapshotV1['wcs'],
    owner: SmartHeightIntentOwner = policyOwner,
  ) => ({
    wcsMm: snapshot.wcs[plane],
    machineMm: snapshot.machine[plane],
    owner,
    proofNodeIds: [],
  })

  return {
    version: 2,
    policyVersion: 1,
    policy: validated.state.intent.policy,
    revision: {
      projectRevision: 'test-project-revision',
      setupRevision: 'test-setup-revision',
      operationRevision: `test-operation-${operation.id}`,
    },
    safety: {
      clearance: component('clearance', setupOwner),
      retract: component('retract', setupOwner),
      feed: component('feed', setupOwner),
    },
    machining: {
      materialStart: component('top'),
      physicalTarget: component('bottom'),
      cutterCenterEnd: component('bottom'),
    },
    evidenceGraph: [],
    dependencyFingerprints: [],
    warnings: [],
  }
}
