import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// OverridePanel - live feed / rapid / spindle overrides (MACHINE-CONTROL,
// reworked per Operator ruling 2026-07-31: single-line symmetric steppers, no wrap, no
// chip pile). Each row reads like a pendant: -10 -1 [VALUE] +1 +10, with the
// live percentage as the CENTER field, with a dedicated 100% reset beside it.
// Rapid is a three-segment 25/50/100 selector (the only values GRBL offers),
// with the active segment lit. Realtime bytes: immediate, bypass the RX buffer.
//
// WO-287 - why the percent field is NOT a NumCell, though it obeys the same
// numeric-entry contract: NumCell commits on BLUR and remounts on key={shown}.
// Both are wrong for a live override. Blur-commit would fire override bytes at
// a cutting machine on an accidental click-away (this field commits only on
// Enter), and the shown value is re-reported by the machine every status poll,
// so a keyed remount would wipe a half-typed entry mid-cycle - the exact
// regression WO-080 armored against. The field therefore consumes the CANONICAL
// contract in place (type="text" + inputMode + useSelectAllOnClick), the same
// way ProgramPanel's run-from field does. No third numeric behaviour was added.

import { useEffect, useState } from 'react'
import { useMachineControl } from '../../store/machineControlStore'
import type { OverrideAvailability } from '../../store/machineControlStore'
import { appRapidOverrideNote, getMachineController } from '../../lib/machine/machineSession'
import { authorize } from '../../lib/machine/operatorAuthority'
import type { OverrideKind } from '../../lib/machine/controller'
import { useSelectAllOnClick } from '../ui/selectAllOnClick'
import {
  ControlPanelCollapseToggle,
  useControlPanelCollapsed,
} from './ControlPanelCollapseToggle'

// WO-422 (ADR-0041): this panel speaks the CONTROLLER-NEUTRAL override
// vocabulary - reset / step / absolute percent - not GRBL realtime bytes.
// Against a GRBL controller the bytes on the wire are unchanged; the mapping
// now lives in the backend, where it belongs.
function step(kind: OverrideKind, direction: 1 | -1, coarse: boolean) {
  getMachineController().setOverride({ kind, to: 'step', direction, coarse })
}

/** A controller with an absolute-percent override (UCCNC) gets the typed
 *  percent in one call, so it lands exactly even when the board's readback
 *  lags (WO-2676: reset + steps landed typed 130 at 110 on the simulator).
 *  On GRBL feed and spindle expose deltas, not an arbitrary-percent command:
 *  start from the absolute 100% reset so a direct entry never guesses from a
 *  stale report. */
function sendDirect(kind: OverrideKind, target: number) {
  const controller = getMachineController()
  if (controller.absoluteOverridePercent === true) {
    controller.setOverride({ kind, to: 'percent', percent: target })
    return
  }
  controller.setOverride({ kind, to: 'reset' })
  const delta = target - 100
  const direction: 1 | -1 = delta < 0 ? -1 : 1
  for (let remaining = Math.floor(Math.abs(delta) / 10); remaining > 0; remaining--) {
    controller.setOverride({ kind, to: 'step', direction, coarse: true })
  }
  for (let remaining = Math.abs(delta) % 10; remaining > 0; remaining--) {
    controller.setOverride({ kind, to: 'step', direction, coarse: false })
  }
}

function OverrideEntry({
  label,
  value,
  disabled,
  channel,
}: {
  label: string
  value: number
  disabled: boolean
  channel: OverrideKind
}) {
  useText('control-screens-not-probing')
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  // WO-287: the canonical click-selects-all contract (components/ui/
  // selectAllOnClick.ts), consumed in place the same way ProgramPanel's
  // run-from field does. NumCell cannot host a LIVE override - see the header.
  const selectAll = useSelectAllOnClick()
  const tip = label.toLowerCase()

  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [editing, value])

  const refuse = () => {
    useMachineControl.getState().pushConsole(
      'tx',
      controlText('OverridePanel.text001', { value1: String(label) }),
      'error',
    )
  }

  const submit = (input: HTMLInputElement) => {
    const normalized = draft.trim()
    if (!/^\d+$/.test(normalized)) {
      refuse()
      return
    }
    const target = Number(normalized)
    if (!Number.isInteger(target) || target < 10 || target > 200) {
      refuse()
      return
    }
    sendDirect(channel, target)
    input.blur()
  }

  return (
    <span className="control-ovr-value-btn control-ovr-value-entry">
      <span className="control-ovr-input-wrap">
        <input
          className="control-ovr-value-input"
          data-testid={`control-ovr-${tip}`}
          aria-label={controlText('OverridePanel.text002', { value1: String(label) })}
          data-tooltip={controlText('OverridePanel.text003', { value1: String(tip) })}
          // type="text" + inputMode, NOT type="number": per the HTML spec the
          // text-selection APIs do not apply to number inputs, so the old
          // select()-on-focus here was a silent no-op and the value could not
          // be typed over. role/aria-value* keep the spinbutton semantics that
          // type="number" gave assistive tech - the field is still a whole
          // percent in 10-200, only the way it is EDITED changes.
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-valuemin={10}
          aria-valuemax={200}
          aria-valuenow={value}
          min={10}
          max={200}
          step={1}
          value={draft}
          disabled={disabled}
          onFocus={(event) => {
            setEditing(true)
            selectAll.onFocus(event)
          }}
          onMouseUp={selectAll.onMouseUp}
          onBlur={() => {
            setEditing(false)
            setDraft(String(value))
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit(event.currentTarget)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(String(value))
              event.currentTarget.blur()
            }
          }}
        />
        <span className="control-ovr-percent" aria-hidden="true">%</span>
      </span>
    </span>
  )
}

function unavailableRow(
  label: string,
  channel: OverrideKind,
  availability: OverrideAvailability,
) {
  const waiting = availability !== 'unsupported'
  const tip = label.toLowerCase()
  return (
    <div
      className="control-ovr-row"
      data-testid={`control-ovr-${channel}-${waiting ? 'waiting' : 'absent'}`}
    >
      <span className="control-field-label control-ovr-label">{label}</span>
      <span
        className="control-ovr-stepper control-ovr-unavailable"
        data-testid={`control-ovr-${channel}`}
        data-tooltip={waiting
          ? controlText('OverridePanel.text004', { value1: String(tip) })
          : controlText('OverridePanel.text005', { value1: String(tip) })}
      >
        {waiting ? controlText('OverridePanel.text006') : controlText('OverridePanel.text007')}
      </span>
    </div>
  )
}

/** A number is current-session telemetry. A null needs the independent
 * availability verdict: unknown/supported waits, unsupported is unavailable. */
function StepperRow({
  label,
  value,
  availability,
  channel,
}: {
  label: string
  value: number | null
  availability: OverrideAvailability
  channel: OverrideKind
}) {
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const overrideDisabled = authorize('override', { connected }).disabled
  const tip = label.toLowerCase()
  if (value === null) return unavailableRow(label, channel, availability)
  return (
    <div className="control-ovr-row">
      <span className="control-field-label control-ovr-label">{label}</span>
      <span className="control-ovr-stepper control-ovr-direct-stepper">
        <button className="control-chip-btn control-ovr-step" disabled={overrideDisabled} data-tooltip={`${tip} -10%`} onClick={() => step(channel, -1, true)}>
          -10
        </button>
        <button className="control-chip-btn control-ovr-step" disabled={overrideDisabled} data-tooltip={`${tip} -1%`} onClick={() => step(channel, -1, false)}>
          -1
        </button>
        <OverrideEntry label={label} value={value} disabled={overrideDisabled} channel={channel} />
        <button className="control-chip-btn control-ovr-step" disabled={overrideDisabled} data-tooltip={`${tip} +1%`} onClick={() => step(channel, 1, false)}>
          +1
        </button>
        <button className="control-chip-btn control-ovr-step" disabled={overrideDisabled} data-tooltip={`${tip} +10%`} onClick={() => step(channel, 1, true)}>
          +10
        </button>
      </span>
    </div>
  )
}

export function OverridePanel() {
  useText('control-screens-not-probing')
  const overrides = useMachineControl((s) => s.overrides)
  const availability = useMachineControl((s) => s.overrideAvailability)
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const collapsed = useControlPanelCollapsed('overrides')
  // The only three rapid levels a GRBL controller has, sent as the absolute
  // percentages they are (the backend maps them to 0x97/0x96/0x95).
  const rapidSegments = [{ pct: 25 }, { pct: 50 }, { pct: 100 }]
  // WO-2669: where the app owns Rapid (the AXBB-E), one line says what it does.
  const rapidNote = overrides.rapid === null ? null : appRapidOverrideNote()
  return (
    <section className="panel control-panel">
      <div className="panel-header">
        <span className="panel-title">{controlText('OverridePanel.text008')}</span>
        {/* WO-116: collapsed keeps the LIVE values visible in the header (the
            DisclosureSection summary-while-collapsed idea) - an override left
            at 50% must never be folded out of sight mid-cycle. */}
        {collapsed && (
          <span className="control-version" data-testid="control-ovr-collapsed-values">
            {[
              overrides.feed !== null ? `F${overrides.feed}%` : availability.feed === 'unsupported' ? null : 'F--',
              overrides.rapid !== null ? `R${overrides.rapid}%` : availability.rapid === 'unsupported' ? null : 'R--',
              overrides.spindle !== null ? `S${overrides.spindle}%` : availability.spindle === 'unsupported' ? null : 'S--',
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
        )}
        <ControlPanelCollapseToggle
          panel="overrides"
          testId="control-overrides-toggle"
          collapseTip={controlText('OverridePanel.text009')}
          expandTip={controlText('OverridePanel.text010')}
        />
      </div>
      {!collapsed && (
      <div className="panel-body control-ovr-body">
        <StepperRow
          label={controlText('OverridePanel.text011')}
          value={overrides.feed}
          availability={availability.feed}
          channel="feed"
        />
        {overrides.rapid === null ? unavailableRow(controlText('OverridePanel.text012'), 'rapid', availability.rapid) : (
        <div className="control-ovr-row">
          <span className="control-field-label control-ovr-label">{controlText('OverridePanel.text013')}</span>
          <span className="control-ovr-stepper control-ovr-segments" data-testid="control-ovr-rapid">
            {rapidSegments.map((seg) => (
              <button
                key={seg.pct}
                className={`control-chip-btn control-ovr-seg ${overrides.rapid === seg.pct ? 'control-chip-active' : ''}`}
                data-testid={`control-ovr-rapid-${seg.pct}`}
                disabled={authorize('override', { connected }).disabled}
                data-tooltip={controlText('OverridePanel.text014', { value1: String(seg.pct) })}
                onClick={() => getMachineController().setOverride({ kind: 'rapid', to: 'percent', percent: seg.pct })}
              >
                {seg.pct}%
              </button>
            ))}
          </span>
        </div>
        )}
        {rapidNote !== null && (
          <div
            className="control-field-label"
            data-testid="control-ovr-rapid-note"
            data-tooltip="This controller has no rapid override of its own, so the app sends each G0 at this share of the machine rapid. Cutting moves keep their feed. Moves already sent to the board keep the speed they went out at."
          >
            {rapidNote}
          </div>
        )}
        <StepperRow
          label={controlText('OverridePanel.text015')}
          value={overrides.spindle}
          availability={availability.spindle}
          channel="spindle"
        />
      </div>
      )}
    </section>
  )
}
