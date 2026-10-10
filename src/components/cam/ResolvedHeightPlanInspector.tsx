import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import type { CSSProperties, ReactNode } from 'react'
import type {
  ResolveSmartHeightPlanResult,
  ResolvedHeightPlanV2,
  ResolvedSmartHeightComponent,
  SmartHeightEvidenceNode,
  SmartHeightIntentOwner,
  SmartHeightRefusal,
} from '../../lib/cam/smartHeights'

export interface ResolvedHeightPlanInspectorProps {
  /** Pass the resolver result when the host has both success and refusal states. */
  result?: ResolveSmartHeightPlanResult | null
  /** Pass a plan directly when the host only renders successful resolution. */
  plan?: ResolvedHeightPlanV2 | null
  /** A direct refusal takes precedence over result and plan. */
  refusal?: SmartHeightRefusal | ResolvedHeightPlanNamedRefusal | null
  /** Optional host-owned recovery instruction shown only with a refusal. */
  repairMessage?: string
  title?: string
  className?: string
  defaultOpen?: boolean
}

export interface ResolvedHeightPlanNamedRefusal {
  code: string
  message: string
  evidenceKind?: string
  evidenceRole?: string
}

const shellStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  background: 'var(--surface-2, rgba(18, 24, 31, 0.72))',
  fontSize: 12,
}

const summaryStyle: CSSProperties = {
  cursor: 'pointer',
  padding: '7px 9px',
  fontWeight: 600,
  userSelect: 'none',
}

const contentStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: '0 9px 9px',
}

const primaryRowsStyle: CSSProperties = {
  display: 'grid',
  gap: 5,
  fontVariantNumeric: 'tabular-nums',
}

const primaryRowStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent)',
  borderRadius: 5,
  padding: '6px 8px',
}

function formatMm(value: number): string {
  if (!Number.isFinite(value)) return tx('ResolvedHeightPlanInspector.Invalid')
  const rounded = Math.round(value * 1000) / 1000
  return `${Object.is(rounded, -0) ? 0 : rounded} mm`
}

const operationLabels: Record<string, string> = {
  get adaptive_3d() { return tx('ResolvedHeightPlanInspector.Adaptive_3D') },
  get adaptive_clearing_2d() { return tx('ResolvedHeightPlanInspector.Adaptive_Clearing_2D') },
  get bore() { return tx('ResolvedHeightPlanInspector.Bore') },
  get chamfer() { return tx('ResolvedHeightPlanInspector.Chamfer') },
  get contour_2d() { return tx('ResolvedHeightPlanInspector.Contour_2D') },
  get drill() { return tx('ResolvedHeightPlanInspector.Drill') },
  get engrave() { return tx('ResolvedHeightPlanInspector.Engrave') },
  get face() { return tx('ResolvedHeightPlanInspector.Face') },
  get parallel_3d() { return tx('ResolvedHeightPlanInspector.Parallel_3D') },
  get pocket_2d() { return tx('ResolvedHeightPlanInspector.Pocket_2D') },
  get thread_mill() { return tx('ResolvedHeightPlanInspector.Thread_Mill') },
}

function friendlyLabel(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map(word => word === 'wcs' ? tx('ResolvedHeightPlanInspector.WCS') : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
}

function policyLabel(plan: ResolvedHeightPlanV2): string {
  // WO-2694: a stock-footprint Face whose finished plane the policy owns ends
  // at the model top - name that, not the variant it is stored under.
  const variant = plan.policy.operationType === 'face' && plan.policy.variant === 'explicit_depth' &&
    plan.machining.physicalTarget?.owner.kind === 'operation_policy'
    ? tx('ResolvedHeightPlanInspector.Model_top')
    : friendlyLabel(plan.policy.variant)
  return `${operationLabels[plan.policy.operationType] ?? friendlyLabel(plan.policy.operationType)} / ${variant}`
}

function planHasUserOverride(plan: ResolvedHeightPlanV2): boolean {
  return [
    plan.safety.clearance,
    plan.safety.retract,
    plan.safety.feed,
    plan.machining.materialStart,
    plan.machining.physicalTarget,
    plan.machining.cutterCenterEnd,
    ...(plan.machining.featureEndpoints ?? []).flatMap(endpoint => [
      endpoint.physicalTarget,
      endpoint.cutterCenterEnd,
    ]),
  ].some(value => value?.owner.kind === 'user_override')
}

function ownerLabel(owner: SmartHeightIntentOwner): string {
  switch (owner.kind) {
    case 'setup': return tx('ResolvedHeightPlanInspector.Setup', { p1: owner.setupId })
    case 'operation_policy': return tx('ResolvedHeightPlanInspector.Operation_policy')
    case 'user_override': return tx('ResolvedHeightPlanInspector.User_override')
  }
}

function evidenceLabel(node: SmartHeightEvidenceNode): string {
  return `${node.kind} / ${node.role} (${node.id})`
}

function proofLabel(
  component: ResolvedSmartHeightComponent,
  evidenceById: ReadonlyMap<string, SmartHeightEvidenceNode>,
): string {
  if (component.proofNodeIds.length === 0) return tx('ResolvedHeightPlanInspector.Authored_value')
  return component.proofNodeIds
    .map(id => evidenceById.has(id) ? evidenceLabel(evidenceById.get(id)!) : id)
    .join(', ')
}

interface PrimaryHeightRowProps {
  id: string
  label: string
  value?: ResolvedSmartHeightComponent
  evidenceById: ReadonlyMap<string, SmartHeightEvidenceNode>
  userOverride?: boolean
  children?: ReactNode
}

function PrimaryHeightRow({ id, label, value, evidenceById, userOverride, children }: PrimaryHeightRowProps) {
  useText('cam-operations-new-operation')
  const isUserOverride = userOverride ?? value?.owner.kind === 'user_override'
  const authorityLabel = value ? (isUserOverride ? tx('ResolvedHeightPlanInspector.User_Override') : tx('ResolvedHeightPlanInspector.Smart')) : tx('ResolvedHeightPlanInspector.Not_Used')
  return (
    <section style={primaryRowStyle} data-testid={`resolved-height-${id}`}>
      <div
        data-testid={`resolved-height-${id}-primary`}
        style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'baseline' }}
      >
        <strong>{label}</strong>
        <span>{value ? tx('ResolvedHeightPlanInspector.WCS_Z', { p1: formatMm(value.wcsMm) }) : tx('ResolvedHeightPlanInspector.Not_used')}</span>
        <span
          data-testid={`resolved-height-${id}-authority`}
          data-authority={value ? (isUserOverride ? 'user_override' : 'smart') : 'not_used'}
          style={{
            color: isUserOverride ? 'var(--accent, #69b7ff)' : 'var(--text-muted, #9aa7b3)',
            fontWeight: 600,
          }}
        >
          {authorityLabel}
        </span>
      </div>
      <details data-testid={`resolved-height-${id}-calculation`} style={{ marginTop: 5 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-muted, #9aa7b3)' }}>{tx('ResolvedHeightPlanInspector.How_was_this_calculated')}</summary>
        <div style={{ display: 'grid', gap: 3, padding: '5px 0 1px 12px' }}>
          {value ? (
            <>
              <span>{tx('ResolvedHeightPlanInspector.Owner', { p1: ownerLabel(value.owner) })}</span>
              <span>{tx('ResolvedHeightPlanInspector.Machine_Z', { p1: formatMm(value.machineMm) })}</span>
              <span>{tx('ResolvedHeightPlanInspector.Reference', { p1: proofLabel(value, evidenceById) })}</span>
            </>
          ) : (
            <span>{tx('ResolvedHeightPlanInspector.This_operation_policy_does_not_use_a_separate_Feed')}</span>
          )}
          {children}
        </div>
      </details>
    </section>
  )
}

function RefusalView({ refusal, repairMessage }: {
  refusal: SmartHeightRefusal | ResolvedHeightPlanNamedRefusal
  repairMessage?: string
}) {
  useText('cam-operations-new-operation')
  const basis = [refusal.evidenceKind, refusal.evidenceRole].filter(Boolean).join(' / ')
  return (
    <div
      data-testid="resolved-height-refusal"
      role="alert"
      style={{ ...contentStyle, color: 'var(--text-danger)' }}
    >
      <strong>{refusal.code}</strong>
      <span>{refusal.message}</span>
      {basis && <span>{tx('ResolvedHeightPlanInspector.Evidence', { p1: basis })}</span>}
      {repairMessage && <span>{tx('ResolvedHeightPlanInspector.Repair', { p1: repairMessage })}</span>}
    </div>
  )
}

function ResolvedPlanView({ plan }: { plan: ResolvedHeightPlanV2 }) {
  useText('cam-operations-new-operation')
  const evidenceById = new Map(plan.evidenceGraph.map(node => [node.id, node]))
  const allowances = plan.evidenceGraph.filter(node =>
    node.kind === 'strategy_allowance' || node.role === 'cutter_end_allowance')
  const resolvedAllowances = [
    ...(plan.machining.physicalTarget && plan.machining.cutterCenterEnd ? [{
      id: 'overall',
      get label() { return tx('ResolvedHeightPlanInspector.Target_to_cutter_center_offset') },
      valueMm: plan.machining.cutterCenterEnd.wcsMm - plan.machining.physicalTarget.wcsMm,
    }] : []),
    ...(plan.machining.featureEndpoints ?? []).map(endpoint => ({
      id: `feature:${endpoint.feature.stableId}`,
      label: tx('ResolvedHeightPlanInspector.offset', { p1: endpoint.feature.featureKind, p2: endpoint.feature.stableId }),
      valueMm: endpoint.cutterCenterEnd.wcsMm - endpoint.physicalTarget.wcsMm,
    })),
  ]
  const bottomCandidates = [
    plan.machining.cutterCenterEnd,
    ...(plan.machining.featureEndpoints ?? []).map(endpoint => endpoint.cutterCenterEnd),
  ].filter((value): value is ResolvedSmartHeightComponent => value !== undefined)
  const bottom = bottomCandidates.length > 0
    ? bottomCandidates.reduce((deepest, candidate) =>
        candidate.wcsMm < deepest.wcsMm ? candidate : deepest)
    : plan.machining.physicalTarget

  return (
    <div style={contentStyle} data-testid="resolved-height-plan">
      <div style={{ color: 'var(--text-muted, #9aa7b3)' }}>
        {policyLabel(plan)}
      </div>
      <div style={primaryRowsStyle} data-testid="resolved-height-primary-planes">
        <PrimaryHeightRow
          id="clearance"
          label={tx('ResolvedHeightPlanInspector.Clearance_Height')}
          value={plan.safety.clearance}
          evidenceById={evidenceById}
        />
        <PrimaryHeightRow
          id="retract"
          label={tx('ResolvedHeightPlanInspector.Retract_Height')}
          value={plan.safety.retract}
          evidenceById={evidenceById}
        />
        <PrimaryHeightRow
          id="feed"
          label={tx('ResolvedHeightPlanInspector.Feed_Height')}
          value={plan.safety.feed}
          evidenceById={evidenceById}
        />
        <PrimaryHeightRow
          id="top"
          label={tx('ResolvedHeightPlanInspector.Top_Height')}
          value={plan.machining.materialStart}
          evidenceById={evidenceById}
        >
          {plan.machining.materialArtifact && (
            <span>{tx('ResolvedHeightPlanInspector.Material_evidence', { p1: plan.machining.materialArtifact.representation, p2: plan.machining.materialArtifact.artifactId, p3: plan.machining.materialArtifact.frame })}</span>
          )}
        </PrimaryHeightRow>
        <PrimaryHeightRow
          id="bottom"
          label={tx('ResolvedHeightPlanInspector.Bottom_Height')}
          value={bottom}
          evidenceById={evidenceById}
          userOverride={bottom?.owner.kind === 'user_override' ||
            plan.machining.featureEndpoints?.some(endpoint =>
              endpoint.cutterCenterEnd.owner.kind === 'user_override')}
        >
          {plan.machining.physicalTarget && (
            <span>{tx('ResolvedHeightPlanInspector.Physical_target_WCS_Z', { p1: formatMm(plan.machining.physicalTarget.wcsMm) })}</span>
          )}
          {resolvedAllowances.map(allowance => (
            <span key={allowance.id}>{allowance.label}{tx('ResolvedHeightPlanInspector.symbol')}{formatMm(allowance.valueMm)}</span>
          ))}
          {allowances.map(node => (
            <span key={node.id}>{tx('ResolvedHeightPlanInspector.Allowance_evidence', { p1: evidenceLabel(node), p2: node.scalar ? `: ${formatMm(node.scalar.valueMm)} ${node.scalar.frame}` : '' })}</span>
          ))}
          {(plan.machining.featureEndpoints ?? []).map(endpoint => (
            <span key={endpoint.feature.stableId}>{tx('ResolvedHeightPlanInspector.WCS_Z_2', { p1: friendlyLabel(endpoint.feature.featureKind), p2: endpoint.feature.stableId, p3: formatMm(endpoint.cutterCenterEnd.wcsMm), p4: endpoint.cutterCenterEnd.owner.kind === 'user_override' ? tx('ResolvedHeightPlanInspector.User_Override') : tx('ResolvedHeightPlanInspector.Smart') })}</span>
          ))}
          {plan.machining.targetArtifact && (
            <span>{tx('ResolvedHeightPlanInspector.Target_evidence', { p1: plan.machining.targetArtifact.representation, p2: plan.machining.targetArtifact.artifactId, p3: plan.machining.targetArtifact.frame })}</span>
          )}
          {plan.warnings.map(warning => (
            <span key={warning} data-testid="resolved-height-warning">{tx('ResolvedHeightPlanInspector.Warning', { p1: warning })}</span>
          ))}
        </PrimaryHeightRow>
      </div>
    </div>
  )
}

/** Compact, presentation-only view of the exact V2 plan used by CAM. */
export function ResolvedHeightPlanInspector({
  result,
  plan,
  refusal,
  repairMessage,
  title,
  className,
  defaultOpen = false,
}: ResolvedHeightPlanInspectorProps) {
  useText('cam-operations-new-operation')
  const namedRefusal = refusal ?? (result && !result.ok ? result.refusal : null)
  const resolvedPlan = result?.ok ? result.plan : plan
  if (!namedRefusal && !resolvedPlan) return null
  const summary = title ?? (namedRefusal
    ? tx('ResolvedHeightPlanInspector.Smart_Height_needs_attention')
    : `${planHasUserOverride(resolvedPlan!) ? tx('ResolvedHeightPlanInspector.User_override') : tx('ResolvedHeightPlanInspector.Smart_recommendation')}: ${policyLabel(resolvedPlan!)}`)

  return (
    <details
      className={className}
      style={shellStyle}
      open={defaultOpen || undefined}
      data-testid="resolved-height-inspector"
      data-resolution-state={namedRefusal ? 'refused' : 'resolved'}
    >
      <summary style={summaryStyle}>{summary}</summary>
      {namedRefusal
        ? <RefusalView refusal={namedRefusal} repairMessage={repairMessage} />
        : <ResolvedPlanView plan={resolvedPlan!} />}
    </details>
  )
}
