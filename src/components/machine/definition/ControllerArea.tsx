import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useEffect, useRef } from 'react'
import { PinField } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import { ControllerSetupSection } from './ControllerSetupSection'
import { BuiltinCommandsSection } from './BuiltinCommandsSection'
import { GENERAL_TRAJECTORY_FIELDS } from './GeneralSection'
import { GeneralNotSent } from './GeneralSection'
import { FAULT_SIGNAL_ROWS } from './AutomationFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'
import { controllerSurface } from '../../../lib/machine/controllerSurface'
import { uccncBoardName, uccncBoardOptions, uccncBoardUnknownName, withUccncBoardDeviceType } from '../../../lib/machine/controllerBoard'
import { exportUccncProfile } from '../../../lib/machine/uccncProfileExport'
import { proExportSummary } from '../../../lib/machine/operatorMessages'
import { useCamStore } from '../../../store'
import { saveFile } from '../../../lib/saveFile'


/** WO-1694 T11 - the two trajectory settings Operator asked this area to carry
 *  ("trajectory basics"). The other eight `GENERAL_TRAJECTORY_FIELDS` remain
 *  reachable through the searchable All settings table (WO-1689) rather than
 *  duplicated here - this area states the two that decide whether a corner is
 *  cut sharp or blended, not the whole trajectory planner catalogue. */
const TRAJECTORY_BASIC_KEYS = ['Constantvelocitymode', 'Lookaheadlines']
const TRAJECTORY_BASIC_FIELDS = GENERAL_TRAJECTORY_FIELDS.filter(
  ([, key]) => TRAJECTORY_BASIC_KEYS.includes(key),
)

/** A fault row counts as enabled the same way `macroLoopConfigured` reads an
 *  autorun flag: UCCNC's own spelling ('True'/'False'), read leniently. */
function faultSignalEnabled(settings: MachineDefinitionPanelState['unsent'], row: number): boolean {
  const value = settings.read(`FaultSignals.Enable${row}`)
  return value !== null && !['', 'false', '0'].includes(value.toLowerCase())
}

const fileStem = (name: string) => name.replace(/\s+/g, '_')

/** Same blob-download the Machine Library modal's own "Export .pro" uses
 *  (`MachineLibraryModal.handleExportPro`) - one browser mechanism, not a
 *  second one, so a person picks where the file goes and nothing here holds
 *  a copy of it. */
function downloadText(body: string, filename: string, type: string): void {
  void saveFile(filename, body, type)
}

type ControllerAreaProps = Pick<MachineDefinitionPanelState,
  | 'bridgeAction' | 'bridgeCapability' | 'bridgeHello' | 'bridgePort' | 'bridgeProcessState'
  | 'bridgeTextBlurred' | 'bridgeTextFocused' | 'connectionBusy' | 'connectionKind' | 'connectionPhase'
  | 'controllerSetupHighlighted' | 'controllerSetupRef' | 'def' | 'detectedInstallRoot' | 'draft'
  | 'editDraft' | 'handleBridgeAction' | 'importIssues' | 'legacyBridgeStatusHost' | 'linuxcncHello'
  | 'linuxcncJoints' | 'linuxcncOwnsSpindle' | 'localLink'
  | 'noteBridgeSettingChanged' | 'patchIoPin' | 'pinProblem' | 'polarityBoxFor' | 'rememberBridgeSetting'
  | 'rememberPickedPath' | 'serialBaud' | 'setMachineBridgePort' | 'setSection' | 'setSkewTyped'
  | 'setupKind' | 'skewTyped' | 'source' | 'spindleLink' | 'uccnc' | 'unsent'
>

/**
 * WO-1694 T11 - THE CONTROLLER AREA: this computer's link, profile
 * import/export, the e-stop pin, a faults count, trajectory basics, and the
 * way back into setup. Composes existing pieces rather than rebuilding them:
 * `ControllerSetupSection` is reused verbatim, the e-stop pin reuses the same
 * `PinField`/`patchIoPin`/`polarityBoxFor` the Wiring group edits with, export
 * calls the same `exportUccncProfile` WO-1038 built, and import opens the
 * Machine Library modal's existing WO-1002/1063 preview flow rather than a
 * second one - `openModal('machine-config')` is the same door
 * `MachineLibraryModal` already answers to.
 *
 * Mounted on the Controller tab by `MachineDefinitionPanel.tsx`.
 */
export function ControllerArea(props: ControllerAreaProps) {
  useText('control-screens-not-probing')
  const {
    def, draft, editDraft, importIssues, patchIoPin, pinProblem, polarityBoxFor, setSection, unsent,
  } = props
  const addConsoleEvent = useCamStore((s) => s.addConsoleEvent)
  const openModal = useCamStore((s) => s.openModal)
  const surface = controllerSurface(draft)

  // ImportIssuesSection used to render these inline, under "From the
  // profile". WO-1694 moves them to the console instead - the console
  // already carries import results, so a second on-page list is not a new
  // fact, it is the same fact twice (rule 11's "no new notice"). Reported
  // once per issue per machine, the same shape `absentTouched`/`refusedSetting`
  // use in the panel hook for the same reason.
  const reportedImportIssues = useRef(new Set<string>())
  useEffect(() => {
    for (const issue of importIssues) {
      const key = `${draft.id}:${issue.key}:${issue.message}`
      if (reportedImportIssues.current.has(key)) continue
      reportedImportIssues.current.add(key)
      addConsoleEvent({ severity: 'info', source: 'machine', message: `${issue.key} - ${issue.message}` })
    }
  }, [importIssues, draft.id, addConsoleEvent])

  const handleExportPro = () => {
    if (!surface.uccncProfile || !def) return
    // WO-1805: the exported machine is not the exporting app - hand the
    // exporter this machine's CURRENT declared board so the `Statistics` line
    // states what the machine IS, not what an archived profile once said. This
    // is a complete current machine record, so the option is ALWAYS named:
    // undefined means the machine currently states no board, including after a
    // saved clear has crossed JSON persistence and lost its optional key.
    const written = exportUccncProfile(def, {
      profileName: draft.name,
      controllerBoard: draft.controllerBoard,
    })
    downloadText(written.text, `${fileStem(draft.name)}.pro`, 'text/plain')
    addConsoleEvent({
      severity: written.absent.length === 0 ? 'info' : 'warning',
      source: 'machine',
      message: proExportSummary(fileStem(draft.name), written.emitted.length, written.absent.length),
    })
  }

  const faultsEnabled = FAULT_SIGNAL_ROWS.filter((row) => faultSignalEnabled(unsent, row)).length

  // WO-1732 - the board this definition DECLARES. A CNCdrive DeviceInfo type,
  // not the bridge's BoardID (that selects a connected device and may be a
  // demo number); the names and choices come from the one controllerBoard
  // table so this editor and the Control-page label can never drift. A stored
  // type the table does not know is kept and shown as what it is - unknown -
  // never silently converted to a default or to absence. Only a UCCNC machine
  // has this fact; no other controller's editor borrows it.
  const statedBoardType = (() => {
    const raw = draft.controllerBoard?.deviceType
    return draft.controller === 'uccnc' && typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : null
  })()
  const statedBoardName = uccncBoardName(statedBoardType)
  const boardTooltip = statedBoardType === null
    ? controlText('ControllerArea.text001')
    : statedBoardName !== null
      ? controlText('ControllerArea.text002', { value1: String(statedBoardName), value2: String(statedBoardType) })
      : uccncBoardUnknownName(statedBoardType)

  return (
    <div data-testid="machine-def-controller-area">
      <ControllerSetupSection {...props} />

      {surface.uccncProfile && (
        <div data-testid="machine-def-controller-profile" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="control-chip-btn"
            data-testid="machine-def-controller-import"
            data-tooltip={controlText('ControllerArea.text003')}
            onClick={() => { openModal('machine-config') }}
          >{controlText('ControllerArea.text004')}</button>
          <button
            type="button"
            className="control-chip-btn"
            data-testid="machine-def-controller-export"
            data-tooltip={controlText('ControllerArea.text005')}
            onClick={handleExportPro}
          >{controlText('ControllerArea.text006')}</button>
        </div>
      )}

      {draft.controller === 'uccnc' && (
        <div data-testid="machine-def-controller-board" style={{ marginTop: 12 }}>
          <SectionHead
            title={controlText('ControllerArea.text007')}
            summary="Which CNCdrive board this machine's definition declares"
            testId="machine-def-controller-head-board"
          />
          <label
            data-drives-this-app=""
            data-tooltip={boardTooltip}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4,
              fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
            }}
          >
            <span className="mform-label">{controlText('ControllerArea.text008')}</span>
            <select
              className="mform-select"
              data-testid="machine-def-controller-board-select"
              aria-label={controlText('ControllerArea.text009')}
              style={{ width: 220 }}
              value={statedBoardType === null ? '' : String(statedBoardType)}
              onChange={(e) => {
                const text = e.target.value
                // WO-1732: the SAME shared writer the All Settings row calls,
                // so the two doors can never drift. Clear = remove the
                // optional fact (the library door MERGES, so naming the key
                // as undefined is what takes it off the record); rewriting a
                // stored type the record already states changes nothing, so
                // an unknown id survives an edit that does not name a board.
                editDraft((m) => withUccncBoardDeviceType(m, text === '' ? null : Number(text)))
              }}
            >
              <option value="">{controlText('ControllerArea.text010')}</option>
              {statedBoardType !== null && statedBoardName === null && (
                <option value={String(statedBoardType)}>
                  {uccncBoardUnknownName(statedBoardType)}
                </option>
              )}
              {uccncBoardOptions().map((option) => (
                <option key={option.deviceType} value={String(option.deviceType)}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {surface.grblSettings && (
        <button
          type="button"
          className="control-chip-btn"
          data-testid="machine-def-controller-grbl-table-link"
          data-tooltip={controlText('ControllerArea.text011')}
          style={{ marginTop: 12 }}
          onClick={() => { setSection('allSettings') }}
        >{controlText('ControllerArea.text012')}</button>
      )}

      {def && (
        <div data-testid="machine-def-controller-estop" style={{ marginTop: 12 }}>
          <SectionHead
            title={controlText('ControllerArea.text013')}
            summary="Which input this machine names as its e-stop"
            testId="machine-def-controller-head-estop"
          />
          <PinField
            label={controlText('ControllerArea.text014')}
            name="E-stop"
            testId="machine-def-controller-estop-pin"
            value={def.io.estop}
            problem={pinProblem('e-stop')}
            polarityBox={polarityBoxFor('io.estop')}
            onChange={(pin) => patchIoPin('estop', pin)}
          />
        </div>
      )}

      {unsent.catalogued && (
        <div data-testid="machine-def-controller-faults" style={{ marginTop: 12 }}>
          <SectionHead
            title={controlText('ControllerArea.text015')}
            summary={`${faultsEnabled} of ${FAULT_SIGNAL_ROWS.length} fault inputs enabled`}
            testId="machine-def-controller-head-faults"
          />
          <button
            type="button"
            className="control-chip-btn"
            data-testid="machine-def-controller-faults-link"
            onClick={() => { setSection('allSettings') }}
          >{controlText('ControllerArea.text016')}</button>
        </div>
      )}

      {unsent.catalogued && (
        <div data-testid="machine-def-controller-trajectory" style={{ marginTop: 12 }}>
          <SectionHead
            title={controlText('ControllerArea.text017')}
            summary="Path blending and lookahead"
            testId="machine-def-controller-head-trajectory"
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 16px' }}>
            {TRAJECTORY_BASIC_FIELDS.map(([label, key]) => (
              <GeneralNotSent key={key} label={label} settingKey={key} settings={unsent} />
            ))}
          </div>
        </div>
      )}

      {/* WO-2102: the Control tab's Actions door folded in here (Operator,
          2026-09-27) - what each stock spindle / coolant button sends. */}
      <BuiltinCommandsSection machine={draft} />

      <button
        type="button"
        className="control-chip-btn"
        data-testid="machine-def-controller-walkthrough"
        style={{ marginTop: 12 }}
        data-tooltip={controlText('ControllerArea.text018')}
        onClick={() => {
          // WO-1696 has not landed - decide-and-log (WO-1694): the entry
          // point is present now so nothing has to be added to this area
          // later, and it says plainly that there is nothing to run yet
          // rather than doing nothing silently.
          addConsoleEvent({
            severity: 'info', source: 'machine',
            message: controlText('ControllerArea.text019'),
          })
        }}
      >{controlText('ControllerArea.text020')}</button>
    </div>
  )
}
