import { textFor, useText } from '../../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useState } from 'react'
import { NumericInput } from '../../../ui/NumericInput'

// WO-1697 (v2/SLICES.md T14) - "work it out": motor steps and mechanics into
// steps per mm, the same arithmetic LinuxCNC's StepConf/PnCconf use (v2/
// REPORT.html section 2). ONE FIELD, TWO WAYS IN: a person who already knows
// their steps/mm types it into the axis table directly, as today (DefNumber
// in setup/steps/Step2AxesAndTravel.tsx and the Machine area's own axis
// table); this popover is the OPTIONAL second way, and it writes through the
// exact same callback a caller would hand `DefNumber` - `onChange` here is
// `(v) => patchAxis(name, { stepsPerUnit: v })` there - so there is no second
// stored representation for the two paths to disagree about.

export type StepsPerMmDrive = 'belt' | 'screw'

export interface StepsPerMmInputs {
  motorStepsPerRev: number
  microsteps: number
  drive: StepsPerMmDrive
  beltPitchMm: number
  beltTeeth: number
  screwLeadMm: number
}

const DEFAULT_INPUTS: StepsPerMmInputs = {
  motorStepsPerRev: 200,
  microsteps: 8,
  drive: 'belt',
  beltPitchMm: 2,
  beltTeeth: 20,
  screwLeadMm: 5,
}

/** How far one full motor turn moves the axis: a belt's pitch x its pulley's
 *  tooth count, or a screw's lead - the two mechanisms a "work it out"
 *  popover is asked to cover (v2/SLICES.md T14). */
export function mmPerTurn(inputs: StepsPerMmInputs): number {
  return inputs.drive === 'belt'
    ? inputs.beltPitchMm * inputs.beltTeeth
    : inputs.screwLeadMm
}

/** motor steps x microsteps / mm per turn. A zero or negative mm-per-turn has
 *  no answer and comes back non-finite/non-positive rather than a number
 *  nobody typed; the caller decides what to do with that (here, disabling
 *  Apply) rather than this function inventing a value. */
export function computeStepsPerUnit(inputs: StepsPerMmInputs): number {
  return (inputs.motorStepsPerRev * inputs.microsteps) / mmPerTurn(inputs)
}

/** Float noise off the division (e.g. an imperial screw lead) rounded away
 *  without hiding a real fractional steps/mm. */
function roundStepsPerUnit(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

export function StepsPerMm({ onChange }: {
  /** Writes the SAME axis field a table's direct entry writes - see the file
   *  header. Called once, with the computed value, when "Use this value" is
   *  pressed; never called while the popover's own fields are being typed. */
  onChange: (stepsPerUnit: number) => void
}) {
  useText('control-screens-not-probing')
  const [open, setOpen] = useState(false)
  const [inputs, setInputs] = useState<StepsPerMmInputs>(DEFAULT_INPUTS)
  const set = <K extends keyof StepsPerMmInputs>(key: K, value: StepsPerMmInputs[K]) => {
    setInputs((prev) => ({ ...prev, [key]: value }))
  }
  const result = computeStepsPerUnit(inputs)
  // Rule 11: nothing new refuses. This is not a refusal of anything the
  // operator asked for - it is the "Use this value" button declining to write
  // a number that is not one (an empty belt pitch or screw lead has no
  // steps/mm to compute), same as the axis table's own box never accepts text
  // it cannot parse.
  const usable = Number.isFinite(result) && result > 0

  return (
    <details
      className="steps-per-mm"
      data-testid="steps-per-mm"
      open={open}
      onToggle={(e) => { setOpen(e.currentTarget.open) }}
      style={{ display: 'inline-block', fontSize: 'var(--font-size-sm)' }}
    >
      <summary
        data-testid="steps-per-mm-trigger"
        style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}
      >{controlText('StepsPerMm.text001')}</summary>
      <div
        style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          padding: '6px 0 2px', minWidth: 220,
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text002')}</span>
          <NumericInput
            value={inputs.motorStepsPerRev} min={1} step={1}
            ariaLabel={controlText('StepsPerMm.text003')}
            className="mform-input mform-input-mono"
            style={{ flex: 'none', width: 70 }}
            onChange={(v) => set('motorStepsPerRev', v)}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text004')}</span>
          <NumericInput
            value={inputs.microsteps} min={1} step={1}
            ariaLabel={controlText('StepsPerMm.text005')}
            className="mform-input mform-input-mono"
            style={{ flex: 'none', width: 70 }}
            onChange={(v) => set('microsteps', v)}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text006')}</span>
          <select
            className="mform-select"
            aria-label={controlText('StepsPerMm.text007')}
            value={inputs.drive}
            onChange={(e) => set('drive', e.target.value as StepsPerMmDrive)}
          >
            <option value="belt">{controlText('StepsPerMm.text008')}</option>
            <option value="screw">{controlText('StepsPerMm.text009')}</option>
          </select>
        </label>
        {inputs.drive === 'belt' ? (
          <>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text010')}</span>
              <NumericInput
                value={inputs.beltPitchMm} min={0} step={0.5}
                ariaLabel={controlText('StepsPerMm.text011')}
                className="mform-input mform-input-mono"
                style={{ flex: 'none', width: 70 }}
                onChange={(v) => set('beltPitchMm', v)}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text012')}</span>
              <NumericInput
                value={inputs.beltTeeth} min={0} step={1}
                ariaLabel={controlText('StepsPerMm.text013')}
                className="mform-input mform-input-mono"
                style={{ flex: 'none', width: 70 }}
                onChange={(v) => set('beltTeeth', v)}
              />
            </label>
          </>
        ) : (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text014')}</span>
            <NumericInput
              value={inputs.screwLeadMm} min={0} step={0.5}
              ariaLabel={controlText('StepsPerMm.text015')}
              className="mform-input mform-input-mono"
              style={{ flex: 'none', width: 70 }}
              onChange={(v) => set('screwLeadMm', v)}
            />
          </label>
        )}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ flex: 'none', width: 130 }}>{controlText('StepsPerMm.text016')}</span>
          <span
            data-testid="steps-per-mm-result"
            className="mform-input-mono"
          >
            {usable ? roundStepsPerUnit(result) : '-'}
          </span>
        </div>
        <button
          type="button"
          className="control-chip-btn"
          data-testid="steps-per-mm-apply"
          disabled={!usable}
          onClick={() => {
            onChange(roundStepsPerUnit(result))
            setOpen(false)
          }}
          style={{ alignSelf: 'flex-start' }}
        >{controlText('StepsPerMm.text017')}</button>
      </div>
    </details>
  )
}
