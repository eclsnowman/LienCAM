import { fmtMachineLength } from '../../lib/ui/unitFormat'
// WO-411 slice 4 - the PREVIEW of a probe routine: the numbered concrete steps
// the expander produced (slice 2), the proposals it would make, and the errors
// in plain words naming the step. Presentation only (COHESION-STANDARD section



import { useMemo } from 'react'
import type { RoutineError } from '../../lib/machine/probeRoutineFormat'
import { HelpLink } from '../ui/HelpLink'
import { ProbeRoutineRunPanel } from './ProbeRoutineRunPanel'
import type { EffectiveProbeConfig } from '../../lib/machine/toolTable'
import type { MachineEnvelope } from '../../lib/machine/machineEnvelope'
import { formatPosition } from '../../lib/machine/positionFrames'
import { errorCodeAnchor } from '../../help/helpOpen'
import {
  describeExpandedStep,
  listExpandedSteps,
  type ExpandedDisplayUnits,
  type ExpandedProposal,
  type ExpandedRoutine,
  type ExpandedStep,
  type ExpandPoint,
} from '../../lib/machine/probeRoutineExpand'

export type ProbeRoutinePreviewState =
  /** Nothing checked yet (or the routine changed since the last check). */
  | { kind: 'idle' }
  /** Check could not run at all (no machine position, for instance). */
  | { kind: 'blocked'; sentence: string }
  /** Check found problems; `stage` says whether they came from the file
   *  alone (static) or from placing it on this machine (expansion). */
  | { kind: 'errors'; stage: 'static' | 'expansion'; errors: RoutineError[] }
  /** The concrete plan for this routine, these inputs, this machine. */
  | { kind: 'ok'; expanded: ExpandedRoutine }

export interface ProbeRoutinePreviewProps {
  state: ProbeRoutinePreviewState
  /** True when the routine or its inputs changed after this preview was made. */
  stale: boolean
  units: ExpandedDisplayUnits
  routineName: string
  /** WO-411 slice 3: when the host can run (it knows the live profile, the
   *  envelope and the active offset), the Run panel replaces the disabled
   *  Run row. Absent = the preview-only form. */
  run?: { probe: EffectiveProbeConfig; envelope: MachineEnvelope; activeWcs: string | null } | null
}

const RUN_WAITS = 'Running is available from the Routines tab, where the machine position and probe settings are known.'
const RUN_NEEDS_CHECK = 'Check the routine first; Run appears with a clean preview.'

/** WO-1667: a routine position through the one position formatter
 *  ("machine X 1.0 Y 2.0 Z 3.0") - a routine is written in machine coordinates. */
function coordText(point: ExpandPoint, units: ExpandedDisplayUnits): string {
  const c = (v: number) => fmtMachineLength(v, units === 'in' ? 'inch' : 'mm')
  return formatPosition({ machine: point, format: c })
}

/** One plain sentence per proposal. Nothing is written by a preview. */
export function describeExpandedProposal(proposal: ExpandedProposal): string {
  switch (proposal.kind) {
    case 'workOffset': {
      const target = proposal.wcs === 'active'
        ? `the active work offset${proposal.activeWcs ? ` (${proposal.activeWcs})` : ''}`
        : proposal.wcs
      const axes = (['X', 'Y', 'Z'] as const)
        .filter((a) => proposal.axes[a] !== undefined)
        .map((a) => `${a} = ${proposal.axes[a]!.source}`)
        .join(', ')
      const note = proposal.compensationNote ? ` ${proposal.compensationNote}` : ''
      return `Would propose ${target}: ${axes} - "${proposal.label}"; written only after you confirm.${note}`
    }
    case 'toolLength': {
      const tool = proposal.tool === 'active' ? 'the active tool' : `T${proposal.tool}`
      return `Would propose a length for ${tool} from machine Z = ${proposal.machineZ.source} - "${proposal.label}"; written only after you confirm.`
    }
    case 'report':
      return `Would report: ${proposal.items.map((i) => `${i.label} = ${i.expr.source} (${i.unit})`).join('; ')}.`
  }
}

// --- the path sketch ---------------------------------------------------------------

interface SketchPoint { x: number; y: number; number: number; kind: 'move' | 'touch' }

/** The XY track the expanded steps describe, as the points the machine
 *  visits in order (move targets, then the nominal contact of each touch). */
function sketchPoints(expanded: ExpandedRoutine): SketchPoint[] {
  const points: SketchPoint[] = [{ x: expanded.start.x, y: expanded.start.y, number: 0, kind: 'move' }]
  for (const step of listExpandedSteps(expanded.steps)) {
    if (step.kind === 'move') points.push({ x: step.target.x, y: step.target.y, number: step.number, kind: 'move' })
    else if (step.kind === 'touch') points.push({ x: step.nominalContact.x, y: step.nominalContact.y, number: step.number, kind: 'touch' })
  }
  return points
}

function PathSketch({ expanded }: { expanded: ExpandedRoutine }) {
  const points = useMemo(() => sketchPoints(expanded), [expanded])
  const size = 200
  const pad = 18
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const span = Math.max(maxX - minX, maxY - minY, 1)
  const scale = (size - pad * 2) / span
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const sx = (x: number) => size / 2 + (x - cx) * scale
  const sy = (y: number) => size / 2 - (y - cy) * scale
  const track = points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')
  return (
    <svg
      className="probe-routine-sketch"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Top-down sketch of the previewed path: moves and nominal touch points in order"
      data-testid="probe-routine-sketch"
    >
      <polyline className="probe-routine-sketch-track" points={track} />
      {points.map((p, i) => (
        <g key={`${p.number}-${i}`} className="probe-routine-sketch-point" data-kind={p.kind}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={p.kind === 'touch' ? 4 : 2.5} />
          {p.number > 0 && (
            <text x={sx(p.x) + 5} y={sy(p.y) - 4}>{p.number}</text>
          )}
        </g>
      ))}
      <text className="probe-routine-sketch-caption" x={4} y={size - 5}>
        XY, start at 0; numbers are preview steps
      </text>
    </svg>
  )
}

// --- the component ------------------------------------------------------------------

export function ProbeRoutinePreview({ state, stale, units, routineName, run = null }: ProbeRoutinePreviewProps) {
  return (
    <section className="probe-routine-preview" data-testid="probe-routine-preview" data-state={state.kind}>
      <div className="control-probe-zone-head">
        <strong>
          Preview
          <HelpLink topic="probe-routines" anchor="check-preview" testId="probe-routine-preview-help" />
        </strong>
        <span>
          {state.kind === 'ok'
            ? `Real machine numbers for "${routineName}" with the inputs and position above. Nothing moves from here.`
            : 'Press Check to place the routine on this machine before anything else happens.'}
        </span>
      </div>
      {stale && state.kind !== 'idle' && (
        <div className="probe-routine-stale" data-testid="probe-routine-preview-stale">
          The routine or its inputs changed since this preview - press Check again.
        </div>
      )}
      {state.kind === 'idle' && (
        <div className="control-probe-plan" data-testid="probe-routine-preview-idle">
          No preview yet.
        </div>
      )}
      {state.kind === 'blocked' && (
        <div className="control-probe-plan control-probe-status-error" data-testid="probe-routine-preview-blocked">
          {state.sentence}
        </div>
      )}
      {state.kind === 'errors' && (
        <div className="probe-routine-error-list" data-testid="probe-routine-preview-errors">
          <strong className="control-probe-status-error">
            {state.stage === 'static'
              ? `${state.errors.length} problem${state.errors.length === 1 ? '' : 's'} in the routine itself - fix these first:`
              : `${state.errors.length} problem${state.errors.length === 1 ? '' : 's'} placing this routine on the machine:`}
          </strong>
          <ul>
            {state.errors.map((error, i) => (
              <li key={`${error.code}-${i}`} data-testid="probe-routine-preview-error" data-code={error.code}>
                {error.sentence}
                {/* WO-413: lands on the code's row in "What the errors mean" */}
                <HelpLink
                  topic="probe-routines"
                  anchor={errorCodeAnchor(error.code)}
                  title={`What ${error.code} means`}
                  testId={`probe-routine-preview-error-help-${i}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.kind === 'ok' && <ExpandedPreview expanded={state.expanded} units={units} />}
      {state.kind === 'ok' && run ? (
        <ProbeRoutineRunPanel
          expanded={state.expanded}
          stale={stale}
          probe={run.probe}
          envelope={run.envelope}
          activeWcs={run.activeWcs}
          units={units}
        />
      ) : (
        <div className="probe-routine-run-row">
          <button
            className="modal-btn modal-btn-primary"
            data-testid="probe-routine-run"
            disabled
            title={state.kind === 'ok' ? RUN_WAITS : RUN_NEEDS_CHECK}
            aria-describedby="probe-routine-run-note"
          >
            Run
          </button>
          <span id="probe-routine-run-note" className="control-offsets-meta" data-testid="probe-routine-run-note">
            {state.kind === 'ok' ? RUN_WAITS : RUN_NEEDS_CHECK}
          </span>
        </div>
      )}
    </section>
  )
}

function stepIndent(step: ExpandedStep): number {
  return step.arms.length
}

function ExpandedPreview({ expanded, units }: { expanded: ExpandedRoutine; units: ExpandedDisplayUnits }) {
  const steps = useMemo(() => listExpandedSteps(expanded.steps), [expanded])
  const motion = steps.filter((s) => s.kind === 'move' || s.kind === 'touch').length
  const touches = steps.filter((s) => s.kind === 'touch').length
  const inputs = Object.entries(expanded.inputs)
  return (
    <div className="probe-routine-expanded">
      <div className="control-probe-plan-title">
        <strong>{expanded.routineName}</strong>
        <span data-testid="probe-routine-preview-count">
          {motion} motion step{motion === 1 ? '' : 's'}, {touches} touch{touches === 1 ? '' : 'es'}
        </span>
      </div>
      <div className="probe-routine-preview-meta" data-testid="probe-routine-preview-meta">
        <span>Start: {coordText(expanded.start, units)}</span>
        <span>Ends at: {coordText(expanded.end, units)}</span>
        {inputs.length > 0 && (
          <span>Inputs: {inputs.map(([k, v]) => `${k} = ${v}`).join(', ')}</span>
        )}
        <span>
          Feeds: position {expanded.profile.positioningFeedMmMin}, search {expanded.profile.searchFeedMmMin},
          final {expanded.profile.finalFeedMmMin} mm/min (profile values; a routine never raises them)
        </span>
      </div>
      <div className="probe-routine-preview-body">
        <ol className="probe-routine-preview-steps" aria-label="Previewed steps">
          {steps.map((step) => (
            <li
              key={`${step.number}-${step.arms.join('.')}`}
              className="probe-routine-preview-step"
              data-kind={step.kind}
              data-depth={stepIndent(step)}
              data-testid="probe-routine-preview-line"
              data-step={step.number}
            >
              {describeExpandedStep(step, units)}
            </li>
          ))}
        </ol>
        <PathSketch expanded={expanded} />
      </div>
      {expanded.proposals.length > 0 && (
        <div className="probe-routine-proposals" data-testid="probe-routine-preview-proposals">
          <strong>When it finishes</strong>
          <ul>
            {expanded.proposals.map((p, i) => (
              <li key={i} data-testid="probe-routine-preview-proposal">{describeExpandedProposal(p)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="probe-routine-hash" data-testid="probe-routine-preview-hash" title="Changes whenever the routine, its inputs, the start or the profile values change">
        preview {expanded.hash.slice(0, 12)}
      </div>
    </div>
  )
}
