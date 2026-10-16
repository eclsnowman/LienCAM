import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { OptionalNumericInput } from '../../ui/NumericInput'
import { SectionHead } from './DefinitionFields'
import {
  boardSpeedSpindleDrive, restoreMachineSpindleDriveAfterRefusal,
} from '../../../lib/machine/machineSession'
import {
  resolvedSpindleLink, SpindleLinkSection, SpindleDrivePicker, vfdLinkSummary,
} from './SpindleLinkSection'
import { spindleDriveKind, storedMachineSpindleDrive } from './SpindleFields'
import type { MachineBoardSpeedSpindleDrive } from '../../../types'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


type SpindleAreaProps = Pick<MachineDefinitionPanelState,
  | 'draft' | 'editDraft' | 'source' | 'unsent'
  | 'spindleLink' | 'spindleLinkIsForeign' | 'spindleLinkOtherMachine' | 'spindleStoredIsStated' | 'vfdEdit'>

function numericValue(value: number | null): string {
  return value === null ? '' : String(value)
}

function BoardSpindleDriveEditor({ drive, disabled, onChange }: {
  drive: MachineBoardSpeedSpindleDrive
  disabled: boolean
  onChange: (drive: MachineBoardSpeedSpindleDrive) => void
}) {
  useText('control-screens-not-probing')
  const patchDrive = (patch: Partial<MachineBoardSpeedSpindleDrive>): void => {
    onChange({ ...drive, ...patch })
  }
  const numberInput = (
    label: string,
    testId: string,
    value: number | null,
    onValue: (value: number | null) => void,
  ) => (
    <label style={{ display: 'grid', gap: 3, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
      {label}
      <input
        type="number"
        className="mform-input mform-input-mono"
        data-testid={testId}
        value={numericValue(value)}
        disabled={disabled}
        onChange={(event) => {
          const text = event.target.value.trim()
          onValue(text === '' ? null : Number(text))
        }}
      />
    </label>
  )
  return (
    <div data-testid="machine-def-board-spindle" style={{ marginBottom: 10 }}>
      <SectionHead
        title={controlText('SpindleArea.text001')}
        summary="The RPM mapping sent through the same spindle commands as a Modbus drive"
        testId="machine-def-board-spindle-head"
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        {numberInput(controlText('SpindleArea.text002'), 'machine-def-board-spindle-port', drive.output.port,
          (port) => patchDrive({ output: { ...drive.output, port: port ?? 0 } }))}
        {numberInput(controlText('SpindleArea.text003'), 'machine-def-board-spindle-pin', drive.output.pin,
          (pin) => patchDrive({ output: { ...drive.output, pin: pin ?? 0 } }))}
        {numberInput(controlText('SpindleArea.text004'), 'machine-def-board-spindle-frequency', drive.frequencyHz,
          (frequencyHz) => patchDrive({ frequencyHz }))}
        {numberInput(controlText('SpindleArea.text005'), 'machine-def-board-spindle-min-rpm', drive.minimumRpm,
          (minimumRpm) => patchDrive({ minimumRpm }))}
        {numberInput(controlText('SpindleArea.text006'), 'machine-def-board-spindle-max-rpm', drive.maximumRpm,
          (maximumRpm) => patchDrive({ maximumRpm }))}
        {numberInput(controlText('SpindleArea.text007'), 'machine-def-board-spindle-min-percent', drive.minimumPercent,
          (minimumPercent) => patchDrive({ minimumPercent }))}
        {numberInput(controlText('SpindleArea.text008'), 'machine-def-board-spindle-max-percent', drive.maximumPercent,
          (maximumPercent) => patchDrive({ maximumPercent }))}
      </div>
    </div>
  )
}

/**
 * WO-1691 - THE SPINDLE AREA: drive, rpm range, direction, and the VFD link,
 * in one place (v2/SLICES.md T8, Operator's second-pass verdict 2026-09-18).
 *
 * `SpindleSection`'s speed/relay/encoder/PID/pulley blocks and `ModbusSection`
 * do not render here - their registers are the `.pro` catalogue and stay
 * reachable from All settings (WO-1689) by name, searchable, drawn by kind.
 * Nothing about those blocks is deleted: this area simply never draws them,
 * the same way every other WO-1690..1694 area draws its own twelfth of the
 * page rather than the whole catalogue.
 *
 * `SpindleLinkSection` (WO-967) is the one block this area keeps WHOLE,
 * collapsed by default behind a summary line - port, baud and inverter name,
 * from the same document the open section renders - so the twelve controls
 * above it are what the tab opens on.
 */
export function SpindleArea({
  draft, editDraft, source, unsent, spindleLink, spindleLinkIsForeign, spindleLinkOtherMachine,
  spindleStoredIsStated, vfdEdit,
}: SpindleAreaProps) {
  useText('control-screens-not-probing')
  const stored = source.spindleLinkDefinition
  const definition = resolvedSpindleLink({
    link: spindleLink, foreign: spindleLinkIsForeign, stored, storedIsStated: spindleStoredIsStated,
  })
  const hasVfdLink = definition !== null && definition !== undefined
  const summary = hasVfdLink ? vfdLinkSummary(definition) : null

  // `Spindlesetupsettings` keys read null on a machine this catalogue does
  // not describe (`unsent.catalogued` false) - see `SettingSource.read` -
  // so this is safe on a GRBL machine without a `catalogued` guard here too.
  const relayEnabled = unsent.read('Spindlesetupsettings.Spindlerelaysenabled') === 'True'
  const pwmMode = unsent.read('Spindlesetupsettings.IsSpindleinPWMMode') === 'True'
  const legacyKind = spindleDriveKind({
    hasVfdLink, controller: draft.controller, catalogued: unsent.catalogued, relayEnabled, pwmMode,
  })
  const storedDrive = storedMachineSpindleDrive(draft)
  const spindleOutputs = (draft.controllerDefinition?.outputs ?? [])
    .filter((output) => output.onCode === 'M3' || output.onCode === 'M4')

  return (
    <div data-testid="machine-def-area-spindle">
      <SectionHead
        title={controlText('SpindleArea.text009')}
        summary="Drive, RPM range, direction and the VFD link"
        testId="machine-def-area-spindle-head"
      />

      <div className="mform-row" data-testid="machine-def-area-spindle-drive">
        <span className="mform-label">{controlText('SpindleArea.text010')}</span>
        <SpindleDrivePicker
          machineId={source.id}
          definition={definition}
          disabled={vfdEdit.disabled}
          storedDrive={storedDrive}
          legacyKind={legacyKind}
          newBoardDrive={(signal) => boardSpeedSpindleDrive(draft, signal)}
          onDriveChange={(drive) => editDraft((machine) => {
            if (drive !== undefined) return { ...machine, spindleDrive: drive }
            const { spindleDrive: _spindleDrive, ...withoutDrive } = machine
            return withoutDrive
          })}
          onDriveRefused={(drive) => restoreMachineSpindleDriveAfterRefusal(source.id, drive)}
        />
      </div>

      {storedDrive?.kind === 'board-speed' && (
        <BoardSpindleDriveEditor
          drive={storedDrive}
          disabled={vfdEdit.disabled}
          onChange={(drive) => editDraft((machine) => ({ ...machine, spindleDrive: drive }))}
        />
      )}
      {storedDrive?.kind === 'relay' && (
        <div data-testid="machine-def-relay-spindle" style={{ marginBottom: 10, fontSize: 'var(--font-size-sm)' }}>
          {spindleOutputs.length === 0
            ? controlText('SpindleArea.text011')
            : spindleOutputs.map((output) => (
                <div key={`${output.onCode}:${output.name}`}>
                  {controlText('SpindleArea.text012', { value1: String(output.onCode), value2: String(output.name), value3: String(output.pin.port), value4: String(output.pin.pin) })}
                </div>
              ))}
        </div>
      )}

      <div className="mform-row">
        <label className="mform-label">{controlText('SpindleArea.text013')}</label>
        <OptionalNumericInput
          min={0} step={1000} className="mform-input mform-input-mono"
          value={draft.maxSpindleRpm}
          placeholder={controlText('SpindleArea.text014')}
          ariaLabel={controlText('SpindleArea.text015')}
          onChange={(v) => editDraft((m) => ({
            ...m, maxSpindleRpm: v === undefined ? undefined : Math.round(v),
          }))}
        />
      </div>
      <div className="mform-row">
        <label className="mform-label">{controlText('SpindleArea.text016')}</label>
        <OptionalNumericInput
          min={0} step={100} className="mform-input mform-input-mono"
          value={draft.minSpindleRpm}
          placeholder={controlText('SpindleArea.text017')}
          ariaLabel={controlText('SpindleArea.text018')}
          onChange={(v) => editDraft((m) => ({
            ...m, minSpindleRpm: v === undefined ? undefined : Math.round(v),
          }))}
        />
      </div>
      <div className="mform-row">
        <label className="mform-label" htmlFor="machine-def-area-spindle-direction">{controlText('SpindleArea.text019')}</label>
        <select
          id="machine-def-area-spindle-direction"
          className="mform-select"
          aria-label={controlText('SpindleArea.text020')}
          value={draft.spindleDirection}
          onChange={(e) => editDraft((m) => ({ ...m, spindleDirection: e.target.value as 'cw' | 'ccw' }))}
        >
          <option value="cw">{controlText('SpindleArea.text021')}</option>
          <option value="ccw">{controlText('SpindleArea.text022')}</option>
        </select>
      </div>

      <details data-testid="machine-def-area-spindle-vfd-link" style={{ marginTop: 12 }}>
        <summary data-testid="machine-def-area-spindle-vfd-summary">
          {summary
            ? controlText('SpindleArea.text025', { value1: String(summary.name ?? controlText('SpindleArea.text023')), value2: String(summary.port ?? controlText('SpindleArea.text024')) })
              + (summary.baud !== null ? controlText('SpindleArea.text026', { value1: String(summary.baud) }) : '')
            : spindleLinkIsForeign
              ? controlText('SpindleArea.text028', { value1: String(spindleLinkOtherMachine ?? controlText('SpindleArea.text027')) })
              : controlText('SpindleArea.text029')}
        </summary>
        <SpindleLinkSection
          link={spindleLink}
          foreign={spindleLinkIsForeign}
          otherMachine={spindleLinkOtherMachine}
          stored={stored}
          storedIsStated={spindleStoredIsStated}
          edit={vfdEdit}
          showDrive={false}
        />
      </details>
    </div>
  )
}
