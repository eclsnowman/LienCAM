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
        title="Board speed command"
        summary="The RPM mapping sent through the same spindle commands as a Modbus drive"
        testId="machine-def-board-spindle-head"
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        {numberInput('Output port', 'machine-def-board-spindle-port', drive.output.port,
          (port) => patchDrive({ output: { ...drive.output, port: port ?? 0 } }))}
        {numberInput('Output pin', 'machine-def-board-spindle-pin', drive.output.pin,
          (pin) => patchDrive({ output: { ...drive.output, pin: pin ?? 0 } }))}
        {numberInput('Frequency (Hz)', 'machine-def-board-spindle-frequency', drive.frequencyHz,
          (frequencyHz) => patchDrive({ frequencyHz }))}
        {numberInput('Minimum RPM', 'machine-def-board-spindle-min-rpm', drive.minimumRpm,
          (minimumRpm) => patchDrive({ minimumRpm }))}
        {numberInput('Maximum RPM', 'machine-def-board-spindle-max-rpm', drive.maximumRpm,
          (maximumRpm) => patchDrive({ maximumRpm }))}
        {numberInput('Minimum output (%)', 'machine-def-board-spindle-min-percent', drive.minimumPercent,
          (minimumPercent) => patchDrive({ minimumPercent }))}
        {numberInput('Maximum output (%)', 'machine-def-board-spindle-max-percent', drive.maximumPercent,
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
        title="Spindle"
        summary="Drive, RPM range, direction and the VFD link"
        testId="machine-def-area-spindle-head"
      />

      <div className="mform-row" data-testid="machine-def-area-spindle-drive">
        <span className="mform-label">Drive</span>
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
            ? 'No M3/M4 spindle outputs are defined in the Outputs list.'
            : spindleOutputs.map((output) => (
                <div key={`${output.onCode}:${output.name}`}>
                  {`${output.onCode} ${output.name}: port ${output.pin.port}, pin ${output.pin.pin}; M5 stops it`}
                </div>
              ))}
        </div>
      )}

      <div className="mform-row">
        <label className="mform-label">Max RPM</label>
        <OptionalNumericInput
          min={0} step={1000} className="mform-input mform-input-mono"
          value={draft.maxSpindleRpm}
          placeholder="not set"
          ariaLabel="Max RPM"
          onChange={(v) => editDraft((m) => ({
            ...m, maxSpindleRpm: v === undefined ? undefined : Math.round(v),
          }))}
        />
      </div>
      <div className="mform-row">
        <label className="mform-label">Min RPM</label>
        <OptionalNumericInput
          min={0} step={100} className="mform-input mform-input-mono"
          value={draft.minSpindleRpm}
          placeholder="not set"
          ariaLabel="Min RPM"
          onChange={(v) => editDraft((m) => ({
            ...m, minSpindleRpm: v === undefined ? undefined : Math.round(v),
          }))}
        />
      </div>
      <div className="mform-row">
        <label className="mform-label" htmlFor="machine-def-area-spindle-direction">Direction</label>
        <select
          id="machine-def-area-spindle-direction"
          className="mform-select"
          aria-label="Direction"
          value={draft.spindleDirection}
          onChange={(e) => editDraft((m) => ({ ...m, spindleDirection: e.target.value as 'cw' | 'ccw' }))}
        >
          <option value="cw">CW (M3)</option>
          <option value="ccw">CCW (M4)</option>
        </select>
      </div>

      <details data-testid="machine-def-area-spindle-vfd-link" style={{ marginTop: 12 }}>
        <summary data-testid="machine-def-area-spindle-vfd-summary">
          {summary
            ? `VFD link - ${summary.name ?? 'unnamed inverter'}, port ${summary.port ?? '(not stated)'}`
              + (summary.baud !== null ? `, ${summary.baud} baud` : '')
            : spindleLinkIsForeign
              ? `VFD link - the connected bridge is for ${spindleLinkOtherMachine ?? 'another machine'}, not this one`
              : 'VFD link - none declared'}
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
