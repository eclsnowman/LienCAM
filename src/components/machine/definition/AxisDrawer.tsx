import { X } from 'lucide-react'
import {
  AXIS_CURRENT_HI_LOW_PROFILE_FIELDS,
  AxisProfileReadouts,
  PIN_FIELDS,
  axisCatalogueFields,
} from './AxisProfileFields'
import { PinField } from './DefinitionFields'
import { DefNumber } from './DefinitionFields'
import type { SettingSource } from './DefinitionFields'
import { NumericInput } from '../../ui/NumericInput'
import { Plus } from 'lucide-react'
import type {
  AxisDefinition, AxisHomingDefinition, AxisName, ControllerType, PinRef,
} from '../../../types'
import { controllerZeroIsHomeSwitch } from '../../../types'

// WO-1690 - THE PER-AXIS DRAWER. v2/SLICES.md T7: "a pin drawer for one axis
// adds 26 when opened" (Operator's second-pass verdict). Everything here is a
// fact the main table has no room for and a person opens once per axis, not
// once per machine session: the six wire assignments, the numbers a homing
// cycle needs beyond its main-table direction and search speed, and the two
// facts (backlash, enable delay) that describe how the drive itself behaves.

export type AxisDrawerProps = {
  axis: AxisName
  a: AxisDefinition
  h: AxisHomingDefinition | undefined
  onClose: () => void
  patchAxis: (axis: AxisName, updates: Partial<AxisDefinition>) => void
  patchAxisPin: (axis: AxisName, field: keyof AxisDefinition, value: PinRef) => void
  patchHoming: (axis: AxisName, updates: Partial<AxisHomingDefinition>) => void
  defineHoming: (axis: AxisName) => void
  pinProblem: (label: string) => string | undefined
  polarityBoxFor: (owner: string) => string | undefined
  settings: SettingSource
  /** GRBL owns a wired pin's polarity through its own $3/$5 masks - a live
   *  controller fact, not a second editor for it. */
  grblPolarityFor: (axis: AxisName, field: string) => { value: boolean; setting: string } | null
  /** Non-null when GRBL owns this axis's homing timing ($24/$27) - read-outs,
   *  not a second editor. Auto-zero stays this software's own either way: GRBL
   *  has no concept of it. The home VALUE is a third case - WO-1755's rule
   *  below. */
  grblHoming: { slowSpeed: string; backOff: string } | null
  /** WHICH controller this machine declares. The drawer needs it for exactly
   *  one decision: on a GRBL-family board the homing switch IS machine zero,
   *  so the Home value editor is omitted rather than offered (WO-1773,
   *  COHESION-STANDARD s18). Read through `controllerZeroIsHomeSwitch`, never
   *  compared against a family list here. */
  controller: ControllerType
}

export function AxisDrawer({
  axis, a, h, onClose, patchAxis, patchAxisPin, patchHoming, defineHoming, pinProblem, polarityBoxFor,
  grblPolarityFor, grblHoming, controller, settings,
}: AxisDrawerProps) {
  return (
    <div
      className="machine-def-axis-drawer"
      data-testid={`machine-def-axis-drawer-${axis}`}
      role="dialog"
      aria-label={`${axis} pins and more`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 'var(--font-size-sm)' }}>{axis} - pins and more</strong>
        <button
          type="button"
          className="control-chip-btn"
          data-testid={`machine-def-axis-drawer-close-${axis}`}
          onClick={onClose}
        >
          <X size={12} /> Close
        </button>
      </div>

      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 4 }}>
        Every pin is port, pin and negate - read straight off the wiring diagram.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {PIN_FIELDS.map(([label, field]) => {
          const controllerPolarity = grblPolarityFor(axis, field)
          return (
            <PinField
              key={field}
              label={label}
              name={`${axis} ${label}`}
              testId={`machine-def-panel-pin-${axis}-${field}`}
              value={controllerPolarity === null
                ? a[field]
                : { ...a[field], negate: controllerPolarity.value }}
              problem={pinProblem(`${axis} ${label}`)}
              polarityBox={controllerPolarity?.setting ?? polarityBoxFor(`axes[${axis}].${field}`)}
              onChange={(pin) => patchAxisPin(axis, field, pin)}
            />
          )
        })}
      </div>

      {settings.catalogued && (
        <div
          data-testid={`machine-def-axis-drawer-current-hi-low-${axis}`}
          style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'start', gap: '6px 12px', marginBottom: 10,
          }}
        >
          <strong
            style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500 }}
            data-tooltip={`${axis} drive current hi/low output - port, pin and active polarity`}
          >
            Current hi/low
          </strong>
          <AxisProfileReadouts
            axis={axis}
            fields={axisCatalogueFields(axis, AXIS_CURRENT_HI_LOW_PROFILE_FIELDS)}
            settings={settings}
            testId={`machine-def-panel-axis-current-hi-low-${axis}`}
          />
        </div>
      )}

      {h ? (
        <div
          data-testid={`machine-def-axis-drawer-homing-${axis}`}
          style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginBottom: 10 }}
        >
          {/* WO-1773: on GRBL/grblHAL the switch IS machine zero, so this
             *  number has exactly one value the board will accept. An editor
             *  whose edit normalizes away is a trap, not a control - omit it.
             *  Every other controller keeps its own home coordinate. */}
          {!controllerZeroIsHomeSwitch(controller) && (
            <label
              data-wired=""
              data-tooltip={`${axis} homing value - the machine coordinate set at the switch`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)' }}
            >
              <span>Home value</span>
              <NumericInput
                step={1} value={h.homingValue} ariaLabel={`${axis} homing value`}
                className="mform-input mform-input-mono" style={{ flex: 'none', width: 78 }}
                onChange={(v) => patchHoming(axis, { homingValue: v })}
              />
            </label>
          )}
          {grblHoming ? (
            <>
              <span data-testid={`machine-def-grbl-homing-slow-${axis}`}>
                Slow approach: {grblHoming.slowSpeed}
              </span>
              <span data-testid={`machine-def-grbl-homing-backoff-${axis}`}>
                Back off: {grblHoming.backOff}
              </span>
            </>
          ) : (
            <>
              <label
                data-wired=""
                data-tooltip={`${axis} homing slow re-approach speed, units per minute`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)' }}
              >
                <span>Slow approach</span>
                <NumericInput
                  min={0} step={10} value={h.slowSpeed} ariaLabel={`${axis} homing slow speed`}
                  className="mform-input mform-input-mono" style={{ flex: 'none', width: 78 }}
                  onChange={(v) => patchHoming(axis, { slowSpeed: v })}
                />
              </label>
              <label
                data-wired=""
                data-tooltip={`${axis} how far the axis reverses off the switch when the cycle ends`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)' }}
              >
                <span>Back off</span>
                <NumericInput
                  min={0} step={0.5} value={h.backOff} ariaLabel={`${axis} homing back off`}
                  className="mform-input mform-input-mono" style={{ flex: 'none', width: 70 }}
                  onChange={(v) => patchHoming(axis, { backOff: v })}
                />
              </label>
            </>
          )}
          <label
            data-wired=""
            data-tooltip={`Zero ${axis} automatically when the homing cycle finishes`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)' }}
          >
            <input
              type="checkbox"
              aria-label={`${axis} homing auto zero`}
              checked={h.autoZero}
              onChange={(e) => patchHoming(axis, { autoZero: e.target.checked })}
              style={{ margin: 0 }}
            />
            <span>Zero after homing</span>
          </label>
        </div>
      ) : (
        <div
          data-testid={`machine-def-axis-drawer-no-homing-${axis}`}
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 10 }}
        >
          No homing block in this record.
          <button
            type="button"
            className="control-chip-btn"
            data-testid={`machine-def-axis-drawer-homing-define-${axis}`}
            data-tooltip={`Create a homing block for ${axis} from the safe defaults, then correct it`}
            onClick={() => defineHoming(axis)}
            style={{ marginLeft: 8 }}
          >
            <Plus size={12} /> Define {axis} homing
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 16px' }}>
        <label
          data-wired=""
          data-tooltip={`Compensate ${axis} backlash - only if this machine's backlash has actually been measured`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)' }}
        >
          <input
            type="checkbox"
            aria-label={`${axis} backlash enabled`}
            checked={a.backlash.enabled}
            onChange={(e) => patchAxis(axis, { backlash: { ...a.backlash, enabled: e.target.checked } })}
            style={{ margin: 0 }}
          />
          <span>Backlash</span>
        </label>
        <DefNumber
          label="distance" name={`${axis} backlash distance`} width={72}
          value={a.backlash.distance} min={0} step={0.01}
          onChange={(v) => patchAxis(axis, { backlash: { ...a.backlash, distance: v } })}
        />
        <DefNumber
          label="enable delay (ms)" name={`${axis} enable delay (milliseconds)`} width={66}
          value={a.enableDelayMs} min={0} step={10}
          onChange={(v) => patchAxis(axis, { enableDelayMs: v })}
        />
      </div>
    </div>
  )
}
