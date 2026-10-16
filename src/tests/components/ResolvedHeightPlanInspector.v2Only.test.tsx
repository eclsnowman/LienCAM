// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ResolvedHeightPlanV2,
  ResolvedSmartHeightComponent,
  SmartHeightEvidenceNode,
  SmartHeightIntentOwner,
} from '../../lib/cam/smartHeights'
import { ResolvedHeightPlanInspector } from '../../components/cam/ResolvedHeightPlanInspector'

afterEach(cleanup)

const setupOwner: SmartHeightIntentOwner = { kind: 'setup', setupId: 'setup-7' }
const policyOwner: SmartHeightIntentOwner = { kind: 'operation_policy' }
const userOwner: SmartHeightIntentOwner = { kind: 'user_override' }

function component(
  wcsMm: number,
  owner: SmartHeightIntentOwner,
  ...proofNodeIds: string[]
): ResolvedSmartHeightComponent {
  return { wcsMm, machineMm: wcsMm + 100, owner, proofNodeIds }
}

const evidence = (
  id: string,
  kind: SmartHeightEvidenceNode['kind'],
  role: SmartHeightEvidenceNode['role'],
  valueMm?: number,
): SmartHeightEvidenceNode => ({
  id,
  kind,
  role,
  entityId: `entity:${id}`,
  dependencyNodeIds: [],
  dependencyFingerprint: `fp:${id}`,
  ...(valueMm === undefined ? {} : { scalar: { frame: 'wcs', valueMm } as const }),
})

function resolvedPlan(): ResolvedHeightPlanV2 {
  const feature = {
    modelItemId: 'model-1',
    bodyId: 'body-1',
    featureKind: 'hole',
    stableId: 'hole-4',
    sourceVersion: 3,
    sourceFingerprint: 'feature-fp',
  }
  return {
    version: 2,
    policyVersion: 1,
    policy: { operationType: 'drill', variant: 'detected_features' },
    revision: {
      projectRevision: 'project-r1',
      setupRevision: 'setup-r2',
      operationRevision: 'operation-r3',
    },
    safety: {
      clearance: component(18, setupOwner, 'stock-top', 'fixture-min'),
      retract: component(12, setupOwner, 'stock-top'),
      feed: component(8, userOwner),
    },
    machining: {
      materialStart: component(6, policyOwner, 'material-top'),
      physicalTarget: component(-9, policyOwner, 'hole-floor'),
      cutterCenterEnd: component(-8.5, policyOwner, 'hole-floor', 'tip-allowance'),
      featureEndpoints: [{
        feature,
        physicalTarget: component(-9, policyOwner, 'hole-floor'),
        cutterCenterEnd: component(-8.25, userOwner, 'hole-floor', 'tip-allowance'),
      }],
      targetArtifact: {
        artifactId: 'target-field-1',
        schemaVersion: 1,
        representation: 'height-field-v1',
        frame: 'wcs',
        boundsMm: { minX: 0, minY: 0, minZ: -9, maxX: 20, maxY: 20, maxZ: 6 },
        fingerprint: 'target-field-fp',
      },
    },
    evidenceGraph: [
      evidence('stock-top', 'owning_stock', 'stock_top', 10),
      evidence('fixture-min', 'fixture_envelope', 'safety_clearance_min', 18),
      evidence('material-top', 'remaining_material', 'material_top', 6),
      evidence('hole-floor', 'detected_feature_floor', 'feature_floor', -9),
      evidence('tip-allowance', 'strategy_allowance', 'cutter_end_allowance', 0.75),
    ],
    dependencyFingerprints: ['fp:stock-top', 'fp:hole-floor'],
    warnings: ['Fixture height was inferred from the selected setup.'],
  }
}

describe('ResolvedHeightPlanInspector V2-only presentation', () => {
  it('shows five standard WCS planes first and keeps each calculation collapsed by row', () => {
    render(<ResolvedHeightPlanInspector plan={resolvedPlan()} defaultOpen />)

    const inspector = screen.getByTestId('resolved-height-inspector')
    expect(inspector.getAttribute('data-resolution-state')).toBe('resolved')
    expect(within(inspector).getByText('Drill / Detected Features')).toBeTruthy()
    expect(within(inspector).getByText(/User override: Drill \/ Detected Features/)).toBeTruthy()
    expect(within(inspector).queryByRole('table')).toBeNull()

    const expected = [
      ['clearance', 'Clearance Height', 'WCS Z 18 mm', 'Smart'],
      ['retract', 'Retract Height', 'WCS Z 12 mm', 'Smart'],
      ['feed', 'Feed Height', 'WCS Z 8 mm', 'User Override'],
      ['top', 'Top Height', 'WCS Z 6 mm', 'Smart'],
      ['bottom', 'Bottom Height', 'WCS Z -8.5 mm', 'User Override'],
    ] as const

    for (const [id, label, value, authority] of expected) {
      const primary = within(inspector).getByTestId(`resolved-height-${id}-primary`)
      expect(primary.textContent).toContain(label)
      expect(primary.textContent).toContain(value)
      expect(primary.textContent).toContain(authority)
      expect(primary.textContent).not.toContain('Machine Z')
      expect(primary.textContent).not.toContain('Reference:')

      const calculation = within(inspector).getByTestId(
        `resolved-height-${id}-calculation`,
      ) as HTMLDetailsElement
      expect(calculation.open).toBe(false)
      expect(within(calculation).getByText('How was this calculated?')).toBeTruthy()
    }

    const clearanceCalculation = within(inspector).getByTestId(
      'resolved-height-clearance-calculation',
    ) as HTMLDetailsElement
    fireEvent.click(within(clearanceCalculation).getByText('How was this calculated?'))
    expect(clearanceCalculation.open).toBe(true)
    expect(clearanceCalculation.textContent).toContain('Machine Z: 118 mm')
    // WO-2858: owners, evidence, features and artifacts read as words; the ids
    // they replaced (setup-7, fixture-min, hole-4, target-field-1) never show.
    expect(clearanceCalculation.textContent).toContain('Owner: Setup')
    expect(clearanceCalculation.textContent)
      .toContain('Fixture Envelope / Safety Clearance Min')
    expect(clearanceCalculation.textContent).not.toMatch(/setup-7|fixture-min/)

    const bottomCalculation = within(inspector).getByTestId('resolved-height-bottom-calculation')
    expect(bottomCalculation.textContent).toContain('Target to cutter-center offset: 0.5 mm')
    expect(bottomCalculation.textContent).toContain('Hole 1: WCS Z -8.25 mm (User Override)')
    expect(bottomCalculation.textContent).toContain('Target evidence: height-field-v1 (wcs)')
    expect(bottomCalculation.textContent).not.toMatch(/hole-4|target-field-1/)
    expect(bottomCalculation.textContent)
      .toContain('Warning: Fixture height was inferred from the selected setup.')
  })

  it('shows a named refusal instead of stale resolved values', () => {
    render(
      <ResolvedHeightPlanInspector
        plan={resolvedPlan()}
        refusal={{
          code: 'stale_dependency',
          message: 'Selected feature evidence no longer matches the model.',
          evidenceKind: 'selected_feature',
          evidenceRole: 'feature_floor',
        }}
        repairMessage="Reselect the hole and regenerate the operation."
        defaultOpen
      />,
    )

    const inspector = screen.getByTestId('resolved-height-inspector')
    expect(inspector.getAttribute('data-resolution-state')).toBe('refused')
    expect(within(inspector).getByRole('alert').textContent).toContain('stale_dependency')
    expect(within(inspector).getByRole('alert').textContent)
      .toContain('Selected feature evidence no longer matches the model.')
    expect(within(inspector).getByRole('alert').textContent)
      .toContain('Evidence: selected_feature / feature_floor')
    expect(within(inspector).getByRole('alert').textContent)
      .toContain('Repair: Reselect the hole and regenerate the operation.')
    expect(within(inspector).queryByTestId('resolved-height-plan')).toBeNull()
  })

  it('accepts the public resolver result union and stays absent while unresolved', () => {
    const { rerender } = render(<ResolvedHeightPlanInspector result={null} />)
    expect(screen.queryByTestId('resolved-height-inspector')).toBeNull()

    rerender(<ResolvedHeightPlanInspector result={{ ok: true, plan: resolvedPlan() }} />)
    expect(screen.getByTestId('resolved-height-inspector').getAttribute('data-resolution-state'))
      .toBe('resolved')

    rerender(<ResolvedHeightPlanInspector result={{
      ok: false,
      refusal: { code: 'unsupported_operation', message: 'Regenerate this operation.' },
    }} />)
    expect(screen.getByTestId('resolved-height-inspector').getAttribute('data-resolution-state'))
      .toBe('refused')
    expect(screen.getByRole('alert').textContent).toContain('Regenerate this operation.')
  })
})
