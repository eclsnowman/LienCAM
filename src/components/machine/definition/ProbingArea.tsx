import { type MachineConfig } from '../../../types'
import { type MachineProbeDefaults } from '../../../types'
import { DEFAULT_MACHINE_PROBE_DEFAULTS } from '../../../lib/machine/toolTable'
import { NumericInput, OptionalNumericInput } from '../../ui/NumericInput'
import { PinField } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


// ---------------------------------------------------------------------------
// WO-1693 (v2/SLICES.md T10) - the Probing area: probe and tool-setter pins,
// and MachineProbeDefaults, in one place.
//
// ONE RECORD, TWO LENSES (ADR-0049). `MachineProbeDefaults` (`machine.probing`)
// is LienCAM's own CAM-side probe-motion contract - what `resolveProbeConfig`
// hands every probe routine (docs/research/probe-routine-format.md). It has no
// UCCNC key of its own and Apply never sends it; nothing here is
// `data-wired`. It IS acted on, right now, by this software's own probing
// runner - the exact shape `data-drives-this-app` names. This area is now the
// ONE editor for it; the Machine Library modal's "Probing Defaults" disclosure
// becomes a read-out of the same record (see MachineLibraryModal.tsx).
//
// The probe and tool-setter pins (`io.probe` / `io.probe2`) are a DIFFERENT
// kind of fact - real UCCNC wiring, already `data-wired` via the shared
// `PinField` used here (same component `WiringSection` uses for these same two
// pins on the Legacy tab, which is unchanged and keeps showing them too until
// this rollout retires it).
//
// UCCNC's own `Probing.*` catalogue (probe-screen modes, motion, recipes,
// safe positions, the blower) is a THIRD, separate thing -
// `ProbingSection.tsx`'s content, reachable from All settings (WO-1689) -
// and is not this area's concern at all.
// ---------------------------------------------------------------------------

/** The record this area edits, defaulted exactly as the Machine Library
 *  modal's `editableProbeDefaults` always has: an imported or legacy machine
 *  with no `probing` key still shows a complete set of values rather than
 *  nine empty boxes. */
export function probeDefaults(machine: MachineConfig): MachineProbeDefaults {
  return { ...DEFAULT_MACHINE_PROBE_DEFAULTS, ...(machine.probing ?? {}) }
}

/** The three touch-cycle speeds plus the retract distance between the search
 *  and final passes - Operator's "four probing feeds". Steps match the values the
 *  Machine Library modal's editor used before this WO moved the edit here. */
export const PROBING_FEED_FIELDS = [
  ['Clear positioning', 'positioningFeed', 'mm/min', 100],
  ['Search speed', 'fastFeed', 'mm/min', 25],
  ['Probe speed', 'slowFeed', 'mm/min', 5],
  ['Retract / step-off', 'retract', 'mm', 0.5],
] as const satisfies readonly (readonly [string, keyof MachineProbeDefaults, string, number])[]

/** The rest of `MachineProbeDefaults` - search bounds and stand-off distances
 *  the routines also read. Kept in the same one editor rather than orphaned:
 *  "MachineProbeDefaults - this is the ONE editor" names the whole record, and
 *  the modal's disclosure becomes a read-out of all of it, not part of it. */
export const PROBING_GEOMETRY_FIELDS = [
  ['Maximum search', 'maxTravel', 'mm', 1],
  ['Surface clearance', 'surfaceClearance', 'mm', 0.5],
  ['Search overtravel', 'overtravel', 'mm', 0.5],
  ['Boss cross-over lift', 'crossOverLift', 'mm', 1],
  ['Probe pad thickness', 'padThickness', 'mm', 0.5],
] as const satisfies readonly (readonly [string, keyof MachineProbeDefaults, string, number])[]

function ProbeFeedField({ label, field, unit, step, value, onChange }: {
  label: string
  field: keyof MachineProbeDefaults
  unit: string
  step: number
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label
      data-drives-this-app=""
      data-testid={`machine-def-panel-probing-field-${field}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
      }}
    >
      <span style={{ flex: 'none' }}>{label}</span>
      <NumericInput
        value={value} min={0} step={step}
        ariaLabel={`${label} (${unit})`}
        className="mform-input mform-input-mono"
        style={{ flex: 'none', width: 78 }}
        onChange={onChange}
      />
      <span style={{ flex: 'none' }}>{unit}</span>
    </label>
  )
}

export const TOOL_SETTER_AXES = ['x', 'y', 'z'] as const
export type ToolSetterAxis = (typeof TOOL_SETTER_AXES)[number]

/**
 * WO-1730 - the ONE writer for the fixed tool setter position fact, shared by
 * this area and All settings so the two surfaces can never drift on delete
 * semantics. Set one axis; `undefined` removes that axis's statement; when no
 * axis is left the nested record goes with it rather than becoming a made-up
 * `{x:0,y:0,z:0}`. Blank is absent, zero is stated - never a second stored
 * value, never a controller alias.
 */
export function withToolSetterAxis(
  machine: MachineConfig,
  axis: ToolSetterAxis,
  value: number | undefined,
): MachineConfig {
  const probing = probeDefaults(machine)
  const toolSetter = { ...(probing.toolSetter ?? {}) }
  if (value === undefined) delete toolSetter[axis]
  else toolSetter[axis] = value
  if (TOOL_SETTER_AXES.every((key) => toolSetter[key] === undefined)) delete probing.toolSetter
  else probing.toolSetter = toolSetter
  return { ...machine, probing }
}

type ProbingAreaProps =
  Pick<MachineDefinitionPanelState, 'draft' | 'editDraft' | 'patchIoPin' | 'pinProblem' | 'polarityBoxFor'>
  & { def: NonNullable<MachineDefinitionPanelState['def']> }

export function ProbingArea({ def, draft, editDraft, patchIoPin, pinProblem, polarityBoxFor }: ProbingAreaProps) {
  const defaults = probeDefaults(draft)

  const patchFeed = (field: keyof MachineProbeDefaults, value: number) => {
    editDraft((m) => ({ ...m, probing: { ...probeDefaults(m), [field]: value } }))
  }

  const patchToolSetter = (axis: ToolSetterAxis, value: number | undefined) => {
    editDraft((m) => withToolSetterAxis(m, axis, value))
  }

  return (
    <div data-testid="machine-def-probing-area">
      <SectionHead
        title="Probe and tool-setter pins"
        summary="io.probe / io.probe2, with active-low"
        testId="machine-def-panel-head-probing-pins"
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 12 }}>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
        }}>
          <span style={{ minWidth: 70 }}>Probe</span>
          <PinField
            label="" name="Probe"
            testId="machine-def-panel-probing-pin-probe"
            value={def.io.probe}
            problem={pinProblem('probe')}
            polarityBox={polarityBoxFor('io.probe')}
            onChange={(pin) => patchIoPin('probe', pin)}
          />
        </label>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
        }}>
          <span style={{ minWidth: 70 }}>Tool setter</span>
          <PinField
            label="" name="Tool setter"
            testId="machine-def-panel-probing-pin-probe2"
            value={def.io.probe2}
            problem={pinProblem('probe 2')}
            polarityBox={polarityBoxFor('io.probe2')}
            onChange={(pin) => patchIoPin('probe2', pin)}
          />
        </label>
      </div>

      <SectionHead
        title="Fixed tool setter position"
        summary="Machine coordinates used by Measure tool"
        testId="machine-def-panel-head-tool-setter-position"
      />
      <div
        data-testid="machine-def-panel-tool-setter-position"
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: '5px 16px', marginBottom: 12,
        }}
      >
        {TOOL_SETTER_AXES.map((axis) => (
          <label
            key={axis}
            data-drives-this-app=""
            data-testid={`machine-def-panel-tool-setter-${axis}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
            }}
          >
            <span style={{ flex: 'none', textTransform: 'uppercase' }}>{axis}</span>
            <OptionalNumericInput
              value={defaults.toolSetter?.[axis]}
              step={0.1}
              placeholder="unset"
              ariaLabel={`Tool setter ${axis.toUpperCase()} (machine mm)`}
              className="mform-input mform-input-mono"
              style={{ flex: 'none', width: 90 }}
              onChange={(value) => patchToolSetter(axis, value)}
            />
            <span style={{ flex: 'none' }}>machine mm</span>
          </label>
        ))}
      </div>

      <SectionHead
        title="Probing feeds"
        summary="MachineProbeDefaults - the one editor; the Machine Library modal reads these out"
        testId="machine-def-panel-head-probing-feeds"
      />
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '5px 16px', marginBottom: 12,
        }}
      >
        {PROBING_FEED_FIELDS.map(([label, field, unit, step]) => (
          <ProbeFeedField
            key={field} label={label} field={field} unit={unit} step={step}
            value={defaults[field]}
            onChange={(v) => patchFeed(field, v)}
          />
        ))}
      </div>

      <SectionHead
        title="Probe routine geometry"
        summary="The rest of MachineProbeDefaults - search bounds and stand-off distances"
        testId="machine-def-panel-head-probing-geometry"
      />
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '5px 16px',
        }}
      >
        {PROBING_GEOMETRY_FIELDS.map(([label, field, unit, step]) => (
          <ProbeFeedField
            key={field} label={label} field={field} unit={unit} step={step}
            value={defaults[field]}
            onChange={(v) => patchFeed(field, v)}
          />
        ))}
      </div>
    </div>
  )
}
