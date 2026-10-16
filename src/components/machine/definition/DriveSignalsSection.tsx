import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { OptionalNumericInput } from '../../ui/NumericInput'
import {
  UNASSIGNED_PIN,
  type ChargePumpDefinition,
  type MachineConfig,
  type PinRef,
} from '../../../types'
import { PinNumberBox, SectionHead } from './DefinitionFields'

type DefinitionEditProps = {
  machine: MachineConfig
  onChange: (mut: (machine: MachineConfig) => MachineConfig) => void
}

/**
 * The same port/pin/unknown-polarity editor convention as `PinField`, and the
 * same `data-wired` provenance: Apply carries these pins on the machine
 * definition to the bridge, and Machine.cs acts on them (WO-1729 native
 * phase). The marker claims send-and-act only - NOT physical validation,
 * which remains the hardware session's check, and NOT frequency support,
 * which the UC wrapper cannot express.
 */
function DefinitionPinField({ label, name, testId, value, onChange }: {
  label: string
  name: string
  testId: string
  value: PinRef
  onChange: (pin: PinRef) => void
}) {
  useText('control-screens-not-probing')
  return (
    <div
      data-testid={testId}
      data-wired=""
      data-tooltip={controlText('DriveSignalsSection.text001', { value1: String(name) })}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
      }}
    >
      {label !== '' && <span style={{ flex: 'none', width: 44 }}>{label}</span>}
      <PinNumberBox
        value={value.port}
        ariaLabel={controlText('DriveSignalsSection.text002', { value1: String(name) })}
        invalid={false}
        onChange={(port) => { onChange({ ...value, port }) }}
      />
      <PinNumberBox
        value={value.pin}
        ariaLabel={controlText('DriveSignalsSection.text003', { value1: String(name) })}
        invalid={false}
        onChange={(pin) => { onChange({ ...value, pin }) }}
      />
      <input
        type="checkbox"
        aria-label={controlText('DriveSignalsSection.text004', { value1: String(name) })}
        data-tooltip={value.negate === null
          ? controlText('DriveSignalsSection.text005')
          : controlText('DriveSignalsSection.text006')}
        ref={(element) => { if (element) element.indeterminate = value.negate === null }}
        data-negate-unknown={value.negate === null ? '' : undefined}
        checked={value.negate === true}
        onChange={(event) => { onChange({ ...value, negate: event.target.checked }) }}
        style={{ margin: 0 }}
      />
    </div>
  )
}

/**
 * WO-1729: the controller-neutral drive-alarm inputs. The controller's raw
 * FaultSignals rows remain import/export evidence in All settings; this is
 * the machine fact the bridge applies. Editing here changes the
 * ordinary panel draft and therefore uses its existing Save/reload path.
 */
export function DriveFaultInputsSection({ machine, onChange }: DefinitionEditProps) {
  useText('control-screens-not-probing')
  const inputs = machine.controllerDefinition?.driveFaultInputs ?? []

  const writeInputs = (next: PinRef[]): void => {
    onChange((current) => current.controllerDefinition === undefined
      ? current
      : {
          ...current,
          controllerDefinition: {
            ...current.controllerDefinition,
            driveFaultInputs: next,
          },
        })
  }

  const patchInput = (index: number, pin: PinRef): void => {
    writeInputs(inputs.map((current, candidate) => candidate === index ? pin : current))
  }

  return (
    <div data-testid="machine-def-drive-fault-inputs" style={{ marginTop: 12 }}>
      <SectionHead
        title={controlText('DriveSignalsSection.text007')}
        summary={inputs.length === 0
          ? 'none stated'
          : `${inputs.length} input${inputs.length === 1 ? '' : 's'} stated`}
        testId="machine-def-drive-fault-inputs-head"
      />
      <div
        data-testid="machine-def-drive-fault-inputs-contract"
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
      >{controlText('DriveSignalsSection.text008')}</div>
      {inputs.length === 0 ? (
        <div
          data-testid="machine-def-drive-fault-inputs-none"
          style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 8 }}
        >{controlText('DriveSignalsSection.text009')}</div>
      ) : (
        <table
          className="mform-axis-table"
          data-testid="machine-def-drive-fault-inputs-table"
          style={{ width: 'max-content', maxWidth: '100%' }}
        >
          <thead>
            <tr><th>#</th><th>{controlText('DriveSignalsSection.text010')}</th><th /></tr>
          </thead>
          <tbody>
            {inputs.map((pin, index) => (
              <tr key={index} data-testid={`machine-def-drive-fault-input-row-${index}`}>
                <td>{index + 1}</td>
                <td>
                  <DefinitionPinField
                    label=""
                    name={`drive-fault input ${index + 1}`}
                    testId={`machine-def-drive-fault-input-pin-${index}`}
                    value={pin}
                    onChange={(next) => { patchInput(index, next) }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="control-chip-btn"
                    data-testid={`machine-def-drive-fault-input-remove-${index}`}
                    onClick={() => { writeInputs(inputs.filter((_, candidate) => candidate !== index)) }}
                  >{controlText('DriveSignalsSection.text011')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        className="control-chip-btn"
        data-testid="machine-def-drive-fault-input-add"
        onClick={() => { writeInputs([...inputs, { ...UNASSIGNED_PIN }]) }}
        style={{ marginTop: 8 }}
      >{controlText('DriveSignalsSection.text012')}</button>
    </div>
  )
}

/**
 * WO-1729: one explicit charge-pump statement. The three-way select is
 * load-bearing: "Not stated" removes the optional record, while Off retains a
 * real `{ enabled: false }` fact. Pin and frequency are optional even when the
 * record exists so a board-owned waveform needs no invented values.
 */
export function ChargePumpSection({ machine, onChange }: DefinitionEditProps) {
  useText('control-screens-not-probing')
  const pump = machine.controllerDefinition?.chargePump

  const writePump = (next: ChargePumpDefinition | undefined): void => {
    onChange((current) => {
      if (current.controllerDefinition === undefined) return current
      const controllerDefinition = { ...current.controllerDefinition }
      if (next === undefined) delete controllerDefinition.chargePump
      else controllerDefinition.chargePump = next
      return { ...current, controllerDefinition }
    })
  }

  const patchPump = (patch: Partial<ChargePumpDefinition>): void => {
    if (pump === undefined) return
    writePump({ ...pump, ...patch })
  }

  const state = pump === undefined ? 'absent' : pump.enabled ? 'on' : 'off'
  return (
    <div data-testid="machine-def-charge-pump" style={{ marginTop: 12 }}>
      <SectionHead
        title={controlText('DriveSignalsSection.text013')}
        summary={pump === undefined ? 'not stated' : pump.enabled ? 'on' : 'off'}
        testId="machine-def-charge-pump-head"
      />
      <label
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)' }}
      >{controlText('DriveSignalsSection.text014')}<select
          className="mform-select"
          aria-label={controlText('DriveSignalsSection.text015')}
          data-testid="machine-def-charge-pump-state"
          value={state}
          onChange={(event) => {
            const next = event.target.value
            if (next === 'absent') writePump(undefined)
            else writePump({ ...pump, enabled: next === 'on' })
          }}
        >
          <option value="absent">{controlText('DriveSignalsSection.text016')}</option>
          <option value="off">{controlText('DriveSignalsSection.text017')}</option>
          <option value="on">{controlText('DriveSignalsSection.text018')}</option>
        </select>
      </label>

      {pump !== undefined && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            {pump.pin === undefined ? (
              <>
                <span
                  data-testid="machine-def-charge-pump-pin-absent"
                  style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
                >{controlText('DriveSignalsSection.text019')}</span>
                <button
                  type="button"
                  className="control-chip-btn"
                  data-testid="machine-def-charge-pump-pin-define"
                  onClick={() => { patchPump({ pin: { ...UNASSIGNED_PIN } }) }}
                >{controlText('DriveSignalsSection.text020')}</button>
              </>
            ) : (
              <>
                <DefinitionPinField
                  label={controlText('DriveSignalsSection.text021')}
                  name="charge pump"
                  testId="machine-def-charge-pump-pin"
                  value={pump.pin}
                  onChange={(pin) => { patchPump({ pin }) }}
                />
                <button
                  type="button"
                  className="control-chip-btn"
                  data-testid="machine-def-charge-pump-pin-clear"
                  onClick={() => {
                    const next = { ...pump }
                    delete next.pin
                    writePump(next)
                  }}
                >{controlText('DriveSignalsSection.text022')}</button>
              </>
            )}
          </div>
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 'var(--font-size-sm)' }}
          >{controlText('DriveSignalsSection.text023')}<OptionalNumericInput
              value={pump.frequencyHz}
              onChange={(frequencyHz) => {
                if (frequencyHz === undefined) {
                  const next = { ...pump }
                  delete next.frequencyHz
                  writePump(next)
                } else {
                  patchPump({ frequencyHz })
                }
              }}
              min={0}
              step={1}
              placeholder={controlText('DriveSignalsSection.text024')}
              ariaLabel={controlText('DriveSignalsSection.text025')}
              className="mform-input mform-input-mono"
              style={{ width: 92 }}
            />
          </label>
          {/* WO-1808 (rule11): the UCCNC wrapper carries pins, polarities and
              always-on state but no frequency argument, so Machine.ApplyDefinition
              refuses an apply that states one before any write. The field stays
              editable and the value stays saved; the operator just learns up
              front why Apply cannot complete with a frequency stated. */}
          {machine.controller === 'uccnc' && (
            <div
              data-testid="machine-def-charge-pump-frequency-note"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginTop: 4 }}
            >{controlText('DriveSignalsSection.text026')}</div>
          )}
        </div>
      )}
    </div>
  )
}
