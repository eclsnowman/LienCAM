import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useMemo } from 'react'
import { useCamStore } from '../../store'
import {
  controllerSettingNumber,
  type AxisDefinition,
  type MachineConfig,
  type ToolpathMove,
  type Units,
} from '../../types'
import { resolveFeedrates, type ResolvedFeedrates } from '../../lib/cam/feedrates'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import { formatDurationHMS } from '../../lib/format'
import { feedLabel, fmtDim, fmtFeed, unitLabel } from '../../lib/ui/unitFormat'
import {
  estimateAchievableFeed,
  type AchievableFeedEstimate,
  type AxisAccelerations,
} from '../../lib/simulation/achievableFeed'

const FEED_SUMMARY_ROLES = new Set(['cut', 'stepover', 'wall_follow', 'finish'])

function validAxisAcceleration(
  axes: readonly AxisDefinition[] | undefined,
  axis: AxisDefinition['axis'],
): number | undefined {
  const value = axes?.find((candidate) => candidate.axis === axis)?.acceleration
  return Number.isFinite(value) && (value as number) > 0 ? value : undefined
}

/** Absence stays absent: no controller definition or incomplete XYZ data never becomes 0/default. */
export function machineAxisAccelerations(
  machine: Pick<MachineConfig, 'controllerDefinition'>,
): AxisAccelerations | null {
  const axes = machine.controllerDefinition?.axes
  const x = validAxisAcceleration(axes, 'X')
  const y = validAxisAcceleration(axes, 'Y')
  const z = validAxisAcceleration(axes, 'Z')
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : null
}

/** Use the controller's own stop-angle only when its profile actually carries one. */
export function machineStopAtAngleDeg(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'>,
): number | undefined {
  const value = controllerSettingNumber(
    machine.controllerDefinition?.settings,
    machine.controller,
    'Generalsettings.Stopatangle',
  )
  return value !== null && value >= 0 && value <= 180
    ? value
    : undefined
}

function commandedFeed(move: ToolpathMove, rates: ResolvedFeedrates, rapidRate: number): number {
  if (move.type === 'rapid' || move.role === 'rapid') return rapidRate
  if (move.role === 'fast_traverse') return rates.fastTraverseRate
  if (move.role === 'finish') return rates.finishRate
  return move.feed as number
}

function rangeText(range: { minMmMin: number; typicalMmMin: number }, units: Units): string {
  return `${fmtFeed(range.minMmMin, units)} / ${fmtFeed(range.typicalMmMin, units)} ${feedLabel(units)}`
}

export interface ToolpathFeedEstimateSummaryProps {
  operationName: string
  units: Units
  commandedFeedMmMin: number
  theoreticalCycleTimeMs?: number
  estimate: AchievableFeedEstimate | null
  rpm?: number
  fluteCount?: number
  error?: string
}

export interface DisplayCycleTimes {
  theoreticalMs: number | undefined
  estimatedMs: number | undefined
}

/**
 * Keep the two displayed times on one baseline. The stored operation time is
 * authoritative (and uses exact arc lengths), while the acceleration estimator
 * may linearize arcs. Applying only its slowdown ratio prevents those two sums
 * from producing an impossible estimated time below the theoretical time.
 */
export function displayCycleTimes(
  theoreticalCycleTimeMs: number | undefined,
  estimate: AchievableFeedEstimate | null,
): DisplayCycleTimes {
  const theoreticalMs = theoreticalCycleTimeMs ?? estimate?.theoreticalCycleTimeMs
  if (!estimate || theoreticalMs === undefined) {
    return { theoreticalMs, estimatedMs: undefined }
  }
  const slowdown = estimate.theoreticalCycleTimeMs > 0
    ? Math.max(1, estimate.estimatedCycleTimeMs / estimate.theoreticalCycleTimeMs)
    : 1
  return {
    theoreticalMs,
    estimatedMs: theoreticalMs * slowdown,
  }
}

/** Pure presentation half, exported so the positive and absent states are focused-testable. */
export function ToolpathFeedEstimateSummary({
  operationName,
  units,
  commandedFeedMmMin,
  theoreticalCycleTimeMs,
  estimate,
  rpm,
  fluteCount,
  error,
}: ToolpathFeedEstimateSummaryProps) {
  useText('cam-operations-new-operation')
  const commandedChipload = rpm && rpm > 0 && fluteCount && fluteCount > 0
    ? commandedFeedMmMin / (rpm * fluteCount)
    : null
  const estimatedChipload = commandedChipload != null && estimate?.estimatedFeed
    ? estimate.estimatedFeed.typicalMmMin / ((rpm as number) * (fluteCount as number))
    : null
  const cycleTimes = displayCycleTimes(theoreticalCycleTimeMs, estimate)

  const metricStyle = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 145 } as const
  const labelStyle = { color: 'var(--text-secondary)', fontSize: 'var(--font-size-xs)' } as const
  const valueStyle = { color: 'var(--text-bright)', fontSize: 'var(--font-size-sm)', fontVariantNumeric: 'tabular-nums' } as const

  return (
    <div
      data-testid="toolpath-feed-estimate"
      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 24px' }}
    >
      <div style={{ ...metricStyle, minWidth: 190 }}>
        <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Operation')}</span>
        <span style={valueStyle} data-testid="feed-estimate-operation">{operationName}</span>
      </div>
      <div style={metricStyle}>
        <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Commanded_feed')}</span>
        <span style={valueStyle} data-testid="commanded-feed">
          {fmtFeed(commandedFeedMmMin, units)} {feedLabel(units)}
        </span>
      </div>
      {estimate?.estimatedFeed ? (
        <div style={metricStyle}>
          <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Estimated_real_feed_min_typical')}</span>
          <span style={valueStyle} data-testid="estimated-real-feed">{rangeText(estimate.estimatedFeed, units)}</span>
        </div>
      ) : (
        <div style={{ ...metricStyle, minWidth: 260 }}>
          <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Estimated_real_feed')}</span>
          <span style={valueStyle} data-testid="acceleration-not-set">
            {error ?? tx('ToolpathFeedEstimatePanel.Acceleration_not_set_in_the_machine_definition')}
          </span>
        </div>
      )}
      <div style={metricStyle}>
        <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Theoretical_cycle_time')}</span>
        <span
          style={valueStyle}
          data-testid="theoretical-cycle-time"
          data-duration-ms={cycleTimes.theoreticalMs}
        >
          {cycleTimes.theoreticalMs != null ? formatDurationHMS(cycleTimes.theoreticalMs) : '--'}
        </span>
      </div>
      {cycleTimes.estimatedMs !== undefined && (
        <div style={metricStyle}>
          <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Estimated_cycle_time')}</span>
          <span
            style={valueStyle}
            data-testid="estimated-cycle-time"
            data-duration-ms={cycleTimes.estimatedMs}
          >
            {formatDurationHMS(cycleTimes.estimatedMs)}
          </span>
        </div>
      )}
      {commandedChipload != null && (
        <div style={{ ...metricStyle, minWidth: 210 }}>
          <span style={labelStyle}>{tx('ToolpathFeedEstimatePanel.Chipload_commanded_estimated')}</span>
          <span style={valueStyle} data-testid="estimated-chipload">{tx('ToolpathFeedEstimatePanel.tooth', { p1: fmtDim(commandedChipload, units, 4), p2: estimatedChipload != null ? ` / ${fmtDim(estimatedChipload, units, 4)}` : ' / --', p3: unitLabel(units) })}</span>
        </div>
      )}
      {estimate && (
        <span
          data-testid="feed-estimate-limit"
          style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-xs)', flexBasis: '100%' }}
        >{tx('ToolpathFeedEstimatePanel.Acceleration_and_corner_limits_modelled_fitted_to_seven_measured')}</span>
      )}
    </div>
  )
}

export function ToolpathFeedEstimatePanel({ showEmpty = false }: { showEmpty?: boolean }) {
  useText('cam-operations-new-operation')
  const units = useCamStore((state) => state.appSettings.displayUnits)
  const machine = useCamStore((state) => state.project.machine)
  const setup = useCamStore((state) =>
    state.project.setups.find((candidate) => candidate.id === state.project.activeSetupId),
  )
  const activeOperationId = useCamStore((state) => state.project.activeOperationId)
  const toolLibrary = useCamStore((state) => state.toolLibrary)

  const model = useMemo(() => {
    const operation = setup?.operations.find((candidate) => candidate.id === activeOperationId)
    if (!operation?.toolpathMoves || operation.toolpathMoves.length < 2) return null
    const tool = toolLibrary.find((candidate) => candidate.id === operation.toolId)
    if (!tool) return null

    const rapidRate = Number.isFinite(machine.rapidRate) && machine.rapidRate > 0 ? machine.rapidRate : 5000
    const rates = resolveFeedrates(tool, operation.feedrateOverride, rapidRate)
    const rawMoves = operation.toolpathMoves
    const moves = rawMoves.some((move) => move.type === 'arc_cw' || move.type === 'arc_ccw')
      ? sampleArcMovesForLinearConsumers(rawMoves)
      : rawMoves
    let estimate: AchievableFeedEstimate | null = null
    let error: string | undefined
    try {
      estimate = estimateAchievableFeed(moves, {
        axisAccelerations: machineAxisAccelerations(machine),
        commandedFeedMmMin: (move) => commandedFeed(move, rates, rapidRate),
        isRapid: (move) => move.type === 'rapid' || move.role === 'rapid',
        includeInFeedSummary: (move) => FEED_SUMMARY_ROLES.has(move.role ?? 'cut'),
        stopAtAngleDeg: machineStopAtAngleDeg(machine),
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    const feeds = operation.feedrateOverride?.enabled
      ? operation.feedrateOverride
      : tool.feedsAndSpeeds?.default
    return {
      operation,
      tool,
      rates,
      rpm: feeds?.rpm,
      estimate,
      error,
    }
  }, [activeOperationId, machine, setup, toolLibrary])

  if (!model) {
    return showEmpty ? (
      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>{tx('ToolpathFeedEstimatePanel.Generate_an_operation_to_estimate_real_feed_and_cycle')}</span>
    ) : null
  }
  return (
    <ToolpathFeedEstimateSummary
      operationName={model.operation.name}
      units={units}
      commandedFeedMmMin={model.rates.feedRate}
      theoreticalCycleTimeMs={model.operation.estimatedCutTimeMs}
      estimate={model.estimate}
      rpm={model.rpm}
      fluteCount={model.tool.numberOfFlutes}
      error={model.error}
    />
  )
}
