import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
import { machineDefinitionText, machineLibraryText } from '../../lib/machine/machineDefinitionExport'
import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { X, Plus, Trash2, Upload, Download, Check, Cpu, Star } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import type {
  AxisName,
  ControllerDefinition,
  MachineConfig,
  MachineProbeDefaults,
  MachineType,
  MachineKind,
  ControllerType,
  ToolChangerType,
} from '../../types'
import {
  createDefaultControllerDefinition,
  controllerZeroIsHomeSwitch,
  describeCoolantCapability,
  homeEndFromDefinition,
  machineHomeConvention,
  machineKind,
  machineRapidRate,
  machineTravel,
  reconciledMachineCoolant,
  statedCoolantCapability,
  withAxisHomingStated,
  withMachineCoolant,
} from '../../types'
import { NumericInput, OptionalNumericInput } from '../ui/NumericInput'
import { unitLabel, feedLabel, fmtDim, fmtFeed } from '../../lib/ui/unitFormat'
import { DisclosureSection } from '../ui/DisclosureSection'
import { ProfilePreviewView } from '../machine/ProfilePreviewView'
import { DIALECT_OPTIONS } from '../../lib/post'
import { useMachineDefinitionPanel } from '../machine/definition/useMachineDefinitionPanel'
import { SetupWalkthrough } from '../machine/definition/setup/SetupWalkthrough'
import { DEFAULT_MACHINE_PROBE_DEFAULTS, machineToolTable } from '../../lib/machine/toolTable'
import { ToolTableSection } from '../machine/definition/ToolTableSection'
import type { DefGroup } from '../machine/definition/DefinitionNavigation'
import { requestMachineDefinitionSection } from '../machine/definition/machineDefinitionSectionRequest'
import { describeSignedAxisRange, signedAxisRange } from '../../lib/machine/machineEnvelope'
import { withAxisTravelEdited } from '../../lib/machine/axisSoftLimitEdit'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'
import { proExportSummary } from '../../lib/machine/operatorMessages'
import { useMachineControl } from '../../store/machineControlStore'
import { controllerSurface } from '../../lib/machine/controllerSurface'
import { controllerDisplayName } from '../../lib/machine/machineChoice'
import { bridgeHostCapability } from '../../lib/machine/bridgeHost'
import {
  applyConnectedMachineDefinition,
  describeApplyOutcome,
  getMachineController,
  noteAxisTravelChanged,
} from '../../lib/machine/machineSession'
import type { JogAxis } from '../../lib/machine/controller'
import {
  PROFILE_BRIDGE_MISSING,
  PROFILE_BRIDGE_SESSION_CHANGED,
  PROFILE_FILE_CHANGED,
  PROFILE_PREVIEW_STALE,
  PROFILE_STALE_BRIDGE_REPLY_LOG,
  describeConfigWriteRequest,
  describeProfileChange,
  describeProfileActivation,
  describeProfilePreviewMismatch,
  describeProfileReplacementSummary,
  describeProfileReplacementTooltip,
  describeProfileReplacementConsole,
  describeProfilePreviewSummary,
  isBridgePreviewProfileReply,
  isMissingProfilePreviewVerbError,
  isProfileBridge,
  markDefinitionImported,
  normalizeProfilePath,
  previewAnswersProfile,
  previewBridgeProfileChanges,
  previewLocalUccncProfile,
  withImportedUccncToolSetter,
  type UccncMacroFile,
  profileChangePreviewStatus,
  profileFileName,
  profileRecordFingerprint,
  profileRequestState,
  sameProfileBridgeSession,
  sameProfilePath,
  type ProfileBridgeSession,
  type ProfilePreview,
  type ProfileRequestOutcome,
} from '../../lib/machine/uccncProfileImport'
import { saveFile } from '../../lib/saveFile'
import { ResizableSplit } from '../common/ResizableSplit'
import { PanelCollapseToggle, usePanelCollapsed } from '../common/CollapsiblePanel'
import { EXAMPLE_MACHINES, createExampleMachine } from '../../lib/machine/exampleMachines'

/** A copied `.pro` has raw UCCNC wiring but no controller session and no
 * board. Keep that report out of the bridge renderer so it cannot invent
 * board-verification columns or classify every unverified translation as an
 * error. The parsed definition passed to Confirm is still the same preview
 * object; only the vocabulary for reviewing its raw pin pairs differs. */
function LocalProfilePreviewView({
  preview,
  onConfirm,
  onCancel,
  busy,
}: {
  preview: ProfilePreview
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
}) {
  const words = useText('setup-stock-tools-machine-post')
  const pins = [...preview.pins].sort((left, right) =>
    Number(right.rawBefore !== right.rawAfter) - Number(left.rawBefore !== left.rawAfter))
  const changes = [...preview.changes].sort((left, right) =>
    Number(right.changed) - Number(left.changed))
  const total = pins.length + changes.length
  const replacementSummary = describeProfileReplacementSummary(preview)
  const headline = preview.changedCount > 0
    ? words("MachineLibraryModal.of_values_would_change_every_value_this", { value1: preview.changedCount, value2: total })
    : words("MachineLibraryModal.this_profile_matches_the_editable_machine_definition")

  const status = (before: string, after: string): 'same' | 'changes' | 'new' => {
    if (before === 'not in this machine' && after !== 'not in this profile') return 'new'
    return before === after ? 'same' : 'changes'
  }

  return (
    <section
      className="profile-preview-view"
      data-testid="uccnc-profile-preview"
      data-readable={String(preview.readable)}
      data-change-count={preview.changedCount}
      data-row-count={total}
      data-pin-count={pins.length}
      data-profile-path={preview.path}
      aria-label={words("MachineLibraryModal.review", { value1: profileFileName(preview.path) })}
    >
      <header className="modal-header profile-preview-header">
        <Cpu size={16} className="modal-header-icon" />
        <div className="profile-preview-heading-wrap">
          <span className="modal-title" data-testid="uccnc-profile-preview-heading">
            {profileFileName(preview.path)}
            {preview.profileName ? ` - ${preview.profileName}` : ''}
          </span>
          <span className="profile-preview-row-count" data-testid="uccnc-profile-row-count">{words("MachineLibraryModal.rows_changing", { value1: total, value2: preview.changedCount })}</span>
          {replacementSummary && (
            <span
              className="profile-preview-replacement-summary"
              data-testid="uccnc-profile-replacement-summary"
              style={{ flexBasis: '100%', color: 'var(--accent-amber)', lineHeight: 1.35 }}
            >
              {replacementSummary}
            </span>
          )}
        </div>
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="uccnc-profile-cancel" onClick={onCancel}>
          <X size={12} />{words("MachineLibraryModal.cancel")}</button>
        {preview.readable && (
          <button
            type="button"
            className="modal-btn modal-btn-primary"
            data-testid="uccnc-profile-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            <Check size={12} />{words("MachineLibraryModal.import_these_values")}</button>
        )}
      </header>

      <div className="profile-preview-scroll" data-testid="profile-preview-scroll" tabIndex={0}>
        <div className="profile-preview-meta">
          <div data-testid="uccnc-profile-local-source">{words("MachineLibraryModal.this_local_file_updates_only_liencam_s")}</div>
          {preview.warnings.map((warning, index) => (
            <div key={`${warning}-${index}`} data-testid={`uccnc-profile-warning-${index}`}>{warning}</div>
          ))}
        </div>

        {!preview.readable ? (
          <div className="profile-preview-unreadable" data-testid="uccnc-profile-unreadable">{words("MachineLibraryModal.nothing_was_changed", { value1: preview.error ?? '' })}</div>
        ) : (
          <>
            <div className="profile-preview-headline" data-testid="uccnc-profile-change-count">
              {headline}
            </div>
            <section className="profile-preview-section" aria-labelledby="local-profile-pins-title">
              <div className="profile-preview-section-heading" id="local-profile-pins-title" data-testid="uccnc-profile-pins-heading">{words("MachineLibraryModal.pins")}<span>{words("MachineLibraryModal.rows", { value1: pins.length })}</span>
              </div>
              <table className="profile-preview-table profile-preview-pin-table">
                <thead><tr><th>{words("MachineLibraryModal.pin")}</th><th>{words("MachineLibraryModal.wired_now")}</th><th>{words("MachineLibraryModal.wired_after")}</th><th>{words("MachineLibraryModal.status")}</th></tr></thead>
                <tbody>
                  {pins.map((row) => {
                    const rowStatus = status(row.rawBefore, row.rawAfter)
                    const replacement = row.replacement
                    return (
                      <tr
                        key={row.key}
                        data-testid={`uccnc-profile-pin-${row.key}`}
                        data-raw-before={row.rawBefore}
                        data-raw-after={row.rawAfter}
                        data-pin-changed={String(rowStatus !== 'same')}
                      >
                        <td>{row.group}{words("MachineLibraryModal.symbol")}{row.label}</td>
                        <td>{row.rawBefore}</td>
                        <td>{row.rawAfter}</td>
                        <td>
                          <span
                            className="profile-preview-status"
                            data-status={rowStatus}
                            data-testid={`profile-preview-status-pin-${row.key}`}
                            data-tooltip={replacement
                              ? describeProfileReplacementTooltip(replacement)
                              : rowStatus === 'same'
                                ? words("MachineLibraryModal.the_stored_wiring_stays", { value1: row.rawAfter })
                                : words("MachineLibraryModal.the_stored_wiring_changes_from_to", { value1: row.rawBefore, value2: row.rawAfter })}
                            tabIndex={0}
                          >
                            {replacement ? words("MachineLibraryModal.you_set_this_will_be_replaced") : rowStatus}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
            <section className="profile-preview-section" aria-labelledby="local-profile-values-title">
              <div className="profile-preview-section-heading" id="local-profile-values-title" data-testid="uccnc-profile-values-heading">{words("MachineLibraryModal.other_settings")}<span>{words("MachineLibraryModal.rows", { value1: changes.length })}</span>
              </div>
              <table className="profile-preview-table profile-preview-value-table">
                <thead><tr><th>{words("MachineLibraryModal.setting")}</th><th>{words("MachineLibraryModal.now")}</th><th>{words("MachineLibraryModal.after")}</th><th>{words("MachineLibraryModal.status")}</th></tr></thead>
                <tbody>
                  {changes.map((row) => {
                    const rowStatus = profileChangePreviewStatus(row)
                    const replacement = row.replacement
                    return (
                      <tr key={row.key} data-testid={`uccnc-profile-change-${row.key}`}>
                        <td>{row.group}{words("MachineLibraryModal.symbol")}{row.label}</td>
                        <td>{row.before}</td>
                        <td>{row.after}</td>
                        <td>
                          <span
                            className="profile-preview-status"
                            data-status={rowStatus}
                            data-testid={`profile-preview-status-change-${row.key}`}
                            data-tooltip={replacement
                              ? describeProfileReplacementTooltip(replacement)
                              : describeProfileChange(row)}
                            tabIndex={0}
                          >
                            {replacement ? words("MachineLibraryModal.you_set_this_will_be_replaced") : rowStatus}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </section>
  )
}

const MACHINE_TYPES: { value: MachineType; label: string }[] = [
  { value: 'gantry_router',  get label() { return words("MachineLibraryModal.gantry_router") }   },
  { value: 'moving_table',   get label() { return words("MachineLibraryModal.moving_table") }    },
  { value: 'vertical_mill',  get label() { return words("MachineLibraryModal.vertical_mill") }   },
  { value: 'custom',         get label() { return words("MachineLibraryModal.custom") }          },
]

// WO-1686: a few kind filters, not a per-order special case (Operator,
// COHESION-STANDARD s18) - what hides or shows by kind is a later order
// (T12/WO-1695); this control only states the fact.
const MACHINE_KINDS: { value: MachineKind; label: string }[] = [
  { value: 'router', get label() { return words("MachineLibraryModal.router") } },
  { value: 'plasma', get label() { return words("MachineLibraryModal.plasma") } },
  { value: 'laser',  get label() { return words("MachineLibraryModal.laser") }  },
  { value: 'knife',  get label() { return words("MachineLibraryModal.knife") }  },
]

// The Controller field selects the active postprocessor dialect. Options come
// from the dialect registry (single source of truth) so a new dialect shows up
// here automatically and the chosen value maps cleanly to a built-in post.
const CONTROLLERS: { value: ControllerType; label: string }[] =
  DIALECT_OPTIONS.map((d) => ({ value: d.id as ControllerType, label: d.label }))

const TOOL_CHANGERS: { value: ToolChangerType; label: string }[] = [
  { value: 'manual', get label() { return words("MachineLibraryModal.manual") }       },
  { value: 'atc',    get label() { return words("MachineLibraryModal.auto_atc") }   },
  { value: 'none',   get label() { return words("MachineLibraryModal.none") }         },
]

// WO-2436: the list/editor boundary and the list's folded state are the
// user's (shared ResizableSplit / PanelCollapseToggle, COHESION-STANDARD s26).
export const MACHINE_LIST_PANEL_KEY = 'machine-library-list'
export const MACHINE_LIST_COLLAPSE_KEY = 'machine-library-list-collapsed'
// The list column was 12.5rem (200px at 100%) and grows with the UI scale, so
// the pane limits grow with it. App.tsx publishes the scale as --ui-scale.
// The default is the old column less the 8px bar, so the editor starts where
// it did at every scale.
const MACHINE_LIST_COLUMN_PX = 200
const MACHINE_LIST_BAR_PX = 8
const MACHINE_LIST_MIN_PX = 152
const MACHINE_LIST_MAX_PX = 392
// The editor's two-column rows need this much; the list never takes it.
const MACHINE_EDITOR_MIN_PX = 420

function readUiScale(): number {
  if (typeof document === 'undefined') return 1
  const raw = Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale'))
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

const DEFAULT_AXIS_LIMITS = {
  x: { maxCutting: 3000, maxRapid: 5000 },
  y: { maxCutting: 3000, maxRapid: 5000 },
  z: { maxCutting: 1000, maxRapid: 3000 },
}

const DEFAULT_HOME_CONVENTION = {
  x: { homesToward: 'max', machineZeroAt: 'max' },
  y: { homesToward: 'max', machineZeroAt: 'max' },
  z: { homesToward: 'max', machineZeroAt: 'max' },
} as const

type AxisId = 'x' | 'y' | 'z'

// ============================================================================
// WO-941: WHAT THIS MODAL IS FOR, AND WHAT IT DELIBERATELY NO LONGER HOLDS.
// ============================================================================
// This is the CAM half of a machine record: what a TOOLPATH needs. Travel,
// rapid rate, spindle range and direction, tool changer, per-axis feed
// ceilings, probing defaults, machine-zero convention.
//
// AND COOLANT IS STILL HERE, BUT IT IS NO LONGER ITS OWN TRUTH (WO-965). The
// tick used to patch `MachineConfig.coolant` by itself while the definition
// page answered the same question per channel - two writers, one fact, and a
// record that could say both ("has coolant" over "no mist, no flood"). It now
// writes through `withMachineCoolant`, which is the coarse door onto the SAME
// seam the per-channel answers use, so a contradiction is no longer reachable
// from this surface. It stays here because what the post does with coolant is
// a CAM fact and this is the CAM half of the record; the per-channel detail
// lives in the definition page's Spindle group, grouped by setting type (Operator,
// 2026-08-27), and this row says what the channels currently say. See also
// `commitMachine`, which reconciles on the way out so an OLD record cannot
// leave here contradicting itself either.
//
// The CONTROL half - `MachineConfig.controllerDefinition`, the `.pro` content:
// pin ports/pins/negations, steps per unit, enable delay, backlash, homing
// direction/speeds/back-off/home value, slave axis - is NOT edited here any
// more. It lives on Control -> Machine -> Machine definition
// (`src/components/machine/MachineDefinitionPanel.tsx`), which is a PAGE and
// has the room this 640px box never had. Operator ruling 2026-08-24: "we just scope what
// the cam modal can change to only what is actually useful for the CAM
// definitions and operations."
//
// ONE RECORD, TWO VIEWS, ONE STORE PATH. Both surfaces write the same machine
// record through `updateMachineInLibrary` plus the `project.machine`
// write-through. This modal's draft carries `controllerDefinition` UNTOUCHED,
// so saving the CAM half never disturbs the control half.
//
// WO-1106 adds one deliberate exception to the old "save is not apply" rule:
// confirming a bridge-backed re-import sends the confirmed definition through
// the SAME apply/readback implementation as the Control panel, exactly once.
// There is still no second hardware implementation in this modal. Preview is
// read-only; Cancel writes nothing; and a changed file hash refuses the apply.
// The historical `setBridgeProfile` path below remains only for WO-1002's rich
// fake reply. The landed bridge has no profile-write verb.

function editableHomeConvention(machine: MachineConfig, axis: AxisId) {
  const saved = machineHomeConvention(machine)?.[axis]
  if (!saved) return { ...DEFAULT_HOME_CONVENTION[axis] }
  if (saved.machineZeroAt) {
    return { homesToward: saved.homesToward, machineZeroAt: saved.machineZeroAt }
  }
  // Upgrade WO-300's older direct-coordinate representation when the editor
  // first touches it. These are the four end-based combinations exposed here.
  const travel = machineTravel(machine)[axis]
  const home = saved.homePositionMm
  const machineZeroAt: 'max' | 'min' = Number.isFinite(home)
    ? saved.homesToward === 'max'
      ? (Math.abs(home! - travel) < Math.abs(home!) ? 'min' : 'max')
      : (Math.abs(home! + travel) < Math.abs(home!) ? 'max' : 'min')
    : saved.homesToward
  return { homesToward: saved.homesToward, machineZeroAt }
}

function editableProbeDefaults(machine: MachineConfig): MachineProbeDefaults {
  return { ...DEFAULT_MACHINE_PROBE_DEFAULTS, ...(machine.probing ?? {}) }
}

/**
 * WO-1699: `maxSpindleRpm`/`minSpindleRpm` are ONE fact, not two - the same
 * fields the Spindle area of the Machine definition page (`SpindleArea.tsx`,
 * WO-1691) edits. Once a machine has started a full definition
 * (`controllerDefinition` stated - ADR-0049), that page is where the pair is
 * edited and this modal becomes a read-out linking to it. A machine with no
 * definition has no other editor for the pair, so this modal stays the one
 * place it is set, exactly as before.
 */
/**
 * WO-1701: the home end is ONE fact too (ADR-0049). For an axis whose homing
 * the machine's definition STATES (a UCCNC import, or a home-at set in the
 * Machine area), `homing.perAxis` is where the home end lives and this modal's
 * Homing row reads it back, disabled, with a sentence saying where to edit it.
 * An axis whose homing is not stated - no definition, or a definition whose
 * homing block is still the placeholder defaults - keeps this row as the CAM
 * lens's own editor, exactly as before.
 */
export function homeConventionEditableHere(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'> | null | undefined,
  axis: AxisId,
): boolean {
  return !machine || !homeEndFromDefinition(machine, axis)
}

export function spindleRangeEditableHere(
  machine: Pick<MachineConfig, 'controllerDefinition'> | null | undefined,
): boolean {
  return !machine?.controllerDefinition
}

/** One axis's home end, stated - the inverse of `machineHomeConvention`'s own
 *  read mapping (types/index.ts), so a homesToward/machineZeroAt pair typed
 *  in the Machine Library modal round-trips through `homing.perAxis` exactly
 *  the way the Machine area's own homing edit (`patchHoming` +
 *  `withAxisHomingStated`) would leave it: 0 when zero sits at the home
 *  switch, the far end's signed coordinate otherwise. A machine whose
 *  definition carries no homing block for this axis is left untouched - same
 *  guard `patchHoming` uses (`defineHoming` is the only door that creates
 *  one). */
function withStatedAxisHomeEnd(
  definition: ControllerDefinition,
  controller: ControllerType,
  axis: AxisName,
  homesToward: 'min' | 'max',
  machineZeroAt: 'min' | 'max',
  travelMm: number,
): ControllerDefinition {
  const current = definition.homing.perAxis[axis]
  if (!current) return definition
  const direction: 'positive' | 'negative' = homesToward === 'max' ? 'positive' : 'negative'
  const homingValue = controllerZeroIsHomeSwitch(controller) || machineZeroAt === homesToward
    ? 0
    : (homesToward === 'max' ? travelMm : -travelMm)
  const next: ControllerDefinition = {
    ...definition,
    homing: {
      ...definition.homing,
      perAxis: { ...definition.homing.perAxis, [axis]: { ...current, direction, homingValue } },
    },
  }
  return withAxisHomingStated(next, controller, axis, ['direction', 'homingValue'])
}

/** One axis's soft limits and home DIRECTION, stated from the CAM lens's own
 *  `range`/`homesToward` - never a guessed `homingValue`. */
function seedAxisFromCamLens(
  machine: MachineConfig,
  definition: ControllerDefinition,
  axis: AxisName,
  range: { min: number; max: number },
  homesToward: 'min' | 'max',
): ControllerDefinition {
  const controller = machine.controller
  const withLimits = withAxisTravelEdited(
    { ...machine, controllerDefinition: definition }, axis, range.min, range.max,
  )!
  const currentHoming = withLimits.homing.perAxis[axis]
  if (!currentHoming) return withLimits
  const direction = homesToward === 'max' ? 'positive' : 'negative'
  return withAxisHomingStated({
    ...withLimits,
    homing: {
      ...withLimits.homing,
      perAxis: { ...withLimits.homing.perAxis, [axis]: { ...currentHoming, direction } },
    },
  }, controller, axis, ['direction'])
}

/**
 * WO-1705 outcome 2 (ADR-0049): "Set up machine control" on a machine with no
 * definition yet carries the CAM lens's OWN already-entered facts into the
 * definition it creates. Kind and spindle range need nothing here - Step 1
 * reads `draft.kind` and Step 4's Spindle area reads `draft.maxSpindleRpm`/
 * `minSpindleRpm` directly, the SAME fields the CAM lens typed into (WO-1699).
 * Travel and home corner are the two that live in SEPARATE storage once a
 * definition exists (the axis soft limits, `homing.perAxis` direction) - the
 * walkthrough's own steps read that storage directly, so without this they
 * would show factory 0/0 placeholders instead of what was just typed. Only
 * the DIRECTION half of homing is stated, never a guessed `homingValue`:
 * `machineHomeConvention` already falls the zero end back to the CAM lens's
 * own `machineZeroAt` once only direction is stated - see its doc comment.
 * A machine with no homing switches states a datum for neither, exactly as
 * the CAM lens itself draws no signed range for one (WO-377).
 *
 * AUDIT FIX (fix round 1): dropped by attempt 1 over a feared collision with
 * `uccncProfileImport.ts`'s drift baseline - re-checked and unfounded. A .pro
 * import (`Step1WhatIsThisMachine.handleProFile`) replaces
 * `controllerDefinition` WHOLESALE, `stated` included, with
 * `importUccncProfile`'s own from-scratch result; nothing this function
 * seeds survives an import to be read as a stale baseline. Confirmed by
 * running `setupWalkthrough.wo1696.test.tsx`'s stale-draft-resume scenarios
 * (not owned here) unchanged both ways.
 */
function seedDefinitionFromCamLens(machine: MachineConfig): MachineConfig {
  if (machine.controllerDefinition) return machine
  let definition = createDefaultControllerDefinition()
  if (machine.noHomingSwitches) return { ...machine, controllerDefinition: definition }
  for (const [key, axisName] of [['x', 'X'], ['y', 'Y'], ['z', 'Z']] as const) {
    const convention = editableHomeConvention(machine, key)
    const range = signedAxisRange(key, convention, machine.travel[key])
    if (!range) continue
    definition = seedAxisFromCamLens(machine, definition, axisName, range, convention.homesToward)
  }
  return { ...machine, controllerDefinition: definition }
}

const MODAL_KEYBOARD_EXCLUSION_SELECTOR = [
  'button',
  'select',
  'option',
  'textarea',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[aria-multiline="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
].join(',')

function isSafeMachineEnterTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
): boolean {
  if (!(target instanceof Element) || panel === null || !panel.contains(target)) return false
  if (target.closest(MODAL_KEYBOARD_EXCLUSION_SELECTOR) !== null) return false

  const input = target.closest('input')
  if (!(input instanceof HTMLInputElement)) return true
  return !input.disabled && [
    'text', 'number', 'search', 'email', 'password', 'tel', 'url',
  ].includes(input.type)
}

function blankMachine(): MachineConfig {
  return {
    id: crypto.randomUUID(),
    name: words("MachineLibraryModal.new_machine"),
    type: 'gantry_router',
    kind: 'router',
    controller: 'grbl',
    travel: { x: 800, y: 600, z: 100 },
    homeConvention: {
      x: { ...DEFAULT_HOME_CONVENTION.x },
      y: { ...DEFAULT_HOME_CONVENTION.y },
      z: { ...DEFAULT_HOME_CONVENTION.z },
    },
    probing: { ...DEFAULT_MACHINE_PROBE_DEFAULTS },
    rapidRate: 5000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    axisLimits: { ...DEFAULT_AXIS_LIMITS },
    notes: '',
  }
}

/**
 * WO-1696 (v2/SLICES.md T13) entry point 1 - "New machine" replaces the
 * blank form with the seven-step walkthrough. It needs `useMachineDefinitionPanel`
 * (given this record's id, so it edits exactly that record whatever is
 * connected) - so this is its own component: hooks cannot run conditionally
 * inside `MachineLibraryModal`'s own body.
 */
function MachineLibraryWalkthroughHost({ machineId, onExit }: { machineId: string; onExit: () => void }) {
  // REVIEW FIX (fix round 2): aimed at the record by id. `controlMachine`
  // returns the CONNECTED machine while a session holds it, so leaning on it
  // edited, saved over and offered Apply for the wrong machine.
  const panel = useMachineDefinitionPanel({ machineId })
  // AUDIT FIX (fix round 1, WO-1705): the walkthrough's FIRST edit, before
  // any step renders, carries the CAM lens's own travel/home-corner into the
  // definition it is about to create - see `seedDefinitionFromCamLens` and
  // `handleSetUpMachineControl` for why this runs here (the local draft)
  // rather than as a commit before the walkthrough opens. Idempotent:
  // `seedDefinitionFromCamLens` no-ops once `controllerDefinition` exists, so
  // a StrictMode double-invoke or a re-render after the first edit is a
  // no-op, and a real `.pro` import or board read in Step 1 still replaces
  // it wholesale exactly as before.
  useEffect(() => {
    if (!panel.draft.controllerDefinition) {
      panel.editDraft(seedDefinitionFromCamLens)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <SetupWalkthrough {...panel} onExit={onExit} />
}

export function MachineLibraryModal() {
  const words = useText('setup-stock-tools-machine-post')
  const activeModal             = useCamStore((s) => s.activeModal)
  const closeModal              = useCamStore((s) => s.closeModal)
  const machineLibrary          = useCamStore((s) => s.machineLibrary)
  const addMachineToLibrary     = useCamStore((s) => s.addMachineToLibrary)
  const updateMachineInLibrary  = useCamStore((s) => s.updateMachineInLibrary)
  const removeMachineFromLibrary= useCamStore((s) => s.removeMachineFromLibrary)
  const setProjectMachine       = useCamStore((s) => s.setProjectMachine)
  const currentProjectMachine   = useCamStore((s) => s.project.machine)
  const displayUnits            = useCamStore((s) => s.appSettings.displayUnits)
  const defaultMachineId        = useCamStore((s) => s.appSettings.defaultMachineId)
  const setDefaultMachineId     = useCamStore((s) => s.setDefaultMachineId)
  const addConsoleEvent         = useCamStore((s) => s.addConsoleEvent)

  // WO-1002: what the RUNNING bridge said about UCCNC on this machine PC -
  // its install root, the profile it actually opened, and every `.pro` it
  // found. Read-only here, and the SOLE source of the word "active": a
  // profile is active when the live process says it opened that file, never
  // because this modal asked for something and got `ok: true` back.
  const bridgeUccnc = useMachineControl((s) => s.bridgeHello?.uccnc)
  // WO-1002 attempt 5 - THE SESSION THE REPORT WAS READ FROM. Not the profile
  // list and not the board name: the frame OBJECT this connection published
  // and the phase it is in, both of which move on every disconnect and every
  // reconnect. A report is a statement about ONE board, so it may not outlive
  // the session that translated it - see `sameProfileBridgeSession`.
  const bridgeHello      = useMachineControl((s) => s.bridgeHello)
  const connectionPhase  = useMachineControl((s) => s.connectionPhase)

  const isOpen = activeModal === 'machine-config'
  const listCollapsed = usePanelCollapsed(MACHINE_LIST_COLLAPSE_KEY)
  const uiScale = readUiScale()
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft,      setDraft]      = useState<MachineConfig | null>(null)
  const [isDirty,    setIsDirty]    = useState(false)
  const [saved,      setSaved]      = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  // WO-1696 (v2/SLICES.md T13) - which machine, if any, is being walked
  // through right now. Only "New machine" sets this; picking an existing
  // machine keeps the ordinary CAM form.
  const [walkthroughMachineId, setWalkthroughMachineId] = useState<string | null>(null)

  // WO-1002 - THE DRY RUN, held entirely in local state until somebody agrees.
  // `profilePreview` is a DESCRIPTION and nothing else: while it is on screen
  // the record has not been touched, and dropping it (Cancel, picking another
  // machine, closing the modal) leaves the record exactly as it was.
  const [profilePreview, setProfilePreview] = useState<{
    path: string
    /** Non-null only for the landed read-only bridge reply. Confirm must read
     * the file again and match this SHA-256 before any write. */
    fileHash: string | null
    machineId: string
    /** The record the old -> new columns were computed FROM, as one comparable
     *  string. Re-checked at confirm: see `profileRecordFingerprint`. */
    record: string
    /** THE BRIDGE THAT TRANSLATED THESE COLUMNS. A UCpin is a fact about one
     *  board and one session, so the report dies with that session - watched
     *  by an effect below and re-checked at confirm. */
    session: ProfileBridgeSession | null
    /** Local files update only LienCAM's record. Bridge previews retain the
     * session-bound apply/write behavior added by later work orders. */
    source: 'bridge' | 'file'
    preview: ProfilePreview
  } | null>(null)
  const [profilePreviewOpen, setProfilePreviewOpen] = useState(false)
  const [previewError,   setPreviewError]   = useState<string | null>(null)
  const [profileBusy,    setProfileBusy]    = useState(false)
  const [profileNote,    setProfileNote]    = useState<string | null>(null)
  /**
   * WO-1002 attempt 4 - THE CONFIG-WRITE RESULTS, FILED UNDER THE PROFILE EACH
   * ONE IS ABOUT.
   *
   * The audited defect was a single slot: request a write for profile A,
   * switch to B, and A's late reply landed in that slot and was printed beside
   * B - so the operator was told B was pending when nothing about B was ever
   * sent. On the one surface whose whole purpose is to stop a profile being
   * applied unseen.
   *
   * A map keyed by the profile the request was FOR closes it by construction
   * rather than by timing. A reply can only be filed under its own path, the
   * render only ever reads the entry for the profile now selected, and every
   * sentence is written from `outcome.path`. There is no code path left that
   * can attribute a result to a profile it is not about - not on a late reply,
   * not on a second request, not on a reconnect. Cleared whole at a machine
   * boundary (`clearProfileImport`), because these are statements about the
   * machine being left.
   */
  const [profileRequests, setProfileRequests] = useState<Record<string, {
    machineId: string
    /** WO-1002 fix round 2 - THE BRIDGE SESSION THAT ANSWERED. Filed with the
     *  result for the same reason `machineId` is: a config write is a
     *  statement about ONE bridge connection, and the render below refuses to
     *  print one belonging to a connection that has since been replaced. */
    session: ProfileBridgeSession
    outcome: ProfileRequestOutcome
  }>>({})
  /**
   * File one result under its own profile, leaving every other one alone.
   *
   * `machineId` is the second half of the same idea and the previous fix
   * round's rule: an import is a statement about one machine record, so a
   * result filed while machine A was on screen is never shown over machine B.
   *
   * `session` is the third half and this fix round's rule. Filing is the LAST
   * gate, not the only one - a reply that fails the session check never
   * reaches here at all - but it is the gate that has to hold anyway, so a
   * result that is stored is stored with the connection it came from and the
   * render can refuse it independently.
   */
  const recordProfileOutcome = (
    machineId: string,
    session: ProfileBridgeSession,
    outcome: ProfileRequestOutcome,
  ): void => {
    const key = normalizeProfilePath(outcome.path)
    if (key === '') return
    setProfileRequests((prev) => ({ ...prev, [key]: { machineId, session, outcome } }))
  }
  /** The `.pro` on the machine PC a person has picked out of the bridge's
   *  list. INTENT, not effect - see the pending note in the render. */
  const [chosenProfilePath, setChosenProfilePath] = useState<string | null>(null)

  /**
   * WO-1002 - THE REPLY THAT COMES BACK TOO LATE.
   *
   * `previewProfile` is a wire call, so it settles on a later tick. Between
   * the press and the report a person can select another machine, drop the
   * report, or pick a second profile. Every one of those must abandon the
   * call already in flight: a reply that lands afterwards would publish
   * old/new columns computed against a record nobody is looking at, and a
   * confirm on THAT report writes one machine's profile into another.
   *
   * A counter, bumped by whatever supersedes the call, and the call's own
   * ticket checked when it lands. `machineId` on the published preview is the
   * second half of the same guard, checked again at confirm.
   *
   * WO-1002 attempt 4 - IT ALSO SAYS WHO OWNS THE "Asking the bridge..."
   * INDICATOR. `setBridgeProfile` is a second wire call sharing that one flag,
   * so a write reply that lands after a newer call has taken the flag must not
   * clear it: the surface would stop saying it is waiting while it still is.
   * Same ticket, same rule. It does NOT decide whether that reply is recorded
   * - a reply is always filed under its own profile, see `profileRequests`.
   */
  const profileCallRef = useRef(0)

  /**
   * WO-1002 fix round - THE AUDITED WINDOW: A CALL THAT IS STILL IN THE AIR.
   *
   *   AUDIT: FAIL - an in-flight preview can publish a stale report after the
   *   bridge session changes  (MachineLibraryModal.tsx:453)
   *
   * The session watcher below could only see a report that had already been
   * PUBLISHED. Between the press and the reply there is no `profilePreview` to
   * watch, so a reconnect in that window retired nothing, the request was left
   * with a live ticket, and bridge A's reply then published a full report -
   * board columns, changed rows and a live Confirm - describing a board the
   * operator was no longer connected to. Confirm refused it, which is the last
   * defence and not the rule: nobody may READ a report about the wrong board.
   *
   * So a request in flight carries the same token a published report does, and
   * the watcher retires whichever of the two exists. Held in a ref because it
   * is read by a reply that landed in an older closure, and because it must be
   * true the instant `chooseProfile` sets it, not at the next render.
   */
  const profileInFlightRef = useRef<{
    /** WO-1002 fix round 2 - WHICH ROUND-TRIP IS IN THE AIR. Both wire calls
     *  this modal makes register here, because both can be answered by a
     *  bridge that has since gone; they are retired differently only in what
     *  the operator is told, never in whether the reply is honoured. */
    kind: 'preview' | 'confirm' | 'write'
    ticket: number
    session: ProfileBridgeSession
  } | null>(null)

  const importRef = useRef<HTMLInputElement>(null)

  // The "Saved" flash is a TIMER, and a timer that outlives the modal is a
  // setState on an unmounted tree. Held in a ref so it is cancelled on unmount
  // and re-armed rather than stacked when Save is pressed twice.
  const savedTimerRef = useRef<number | null>(null)
  /** WO-1705 (Operator, binding): which axes' TRAVEL the operator typed in this
   *  draft. A saved length change on the connected machine forces a rehome
   *  of exactly those axes (`noteAxisTravelChanged`); nothing is inferred
   *  from a soft limit that moved for any other reason. */
  const travelEditedAxesRef = useRef<Set<'x' | 'y' | 'z'>>(new Set())
  useEffect(() => () => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current)
  }, [])
  /**
   * WO-1002 attempt 5 - THE SESSION AS IT STANDS RIGHT NOW.
   *
   * `getMachineController()` is asked here rather than remembered, because the
   * backend object is the half the store cannot publish: a reinstalled backend
   * changes no store value and is still a different bridge. The other two
   * halves come off the store, so an effect can watch them.
   */
  /**
   * WO-1002 fix round - AND THE STORE HALVES ARE READ THROUGH REFS.
   *
   * This is asked from two places: an event handler, whose closure is the
   * current render's, and an AWAITED REPLY, whose closure is the render that
   * made the request. Reading `bridgeHello` / `connectionPhase` directly would
   * make the second one answer with the session as it stood when the call went
   * out - which is the very thing being checked, so the check would always
   * pass. The refs are published in a layout effect, so they hold what the
   * last committed render saw.
   */
  const bridgeHelloRef     = useRef(bridgeHello)
  const connectionPhaseRef = useRef(connectionPhase)
  useLayoutEffect(() => {
    bridgeHelloRef.current     = bridgeHello
    connectionPhaseRef.current = connectionPhase
  })

  const currentBridgeSession = (): ProfileBridgeSession => ({
    controller: getMachineController(),
    hello: bridgeHelloRef.current,
    phase: connectionPhaseRef.current,
  })

  /**
   * WO-1002 fix round 2 - THE ONE GATE EVERY BRIDGE REPLY PASSES THROUGH.
   *
   *   AUDIT: FAIL - a profile report survives a bridge session change and can
   *   be confirmed against the replacement bridge  (:703)
   *   AUDIT: FAIL - a config-write reply survives a bridge session change and
   *   is reported against the replacement bridge   (:1054)
   *
   * TWO FINDINGS, ONE CLASS: AN ANSWER FROM A CONNECTION THAT NO LONGER
   * EXISTS. The previous round patched the PREVIEW and left the WRITE, which
   * is what a per-call-site fix always does - it closes the instance that was
   * audited and leaves the class open for the next round to find. So there is
   * now one gate and every round-trip goes through it: the session is captured
   * where the request is SENT, carried on the request and on the result, and
   * compared against the session that is live at the moment the reply would be
   * applied. A mismatch is DROPPED - not rendered, not recorded, not counted -
   * and says so once, because a silent drop is how this class survived two
   * audits looking exactly like a call that was never made.
   *
   * `currentBridgeSession()` and not the store values: the backend object is
   * the half no re-render announces, and an awaited reply's closure holds the
   * session as it stood when the call went out - which is the very thing being
   * checked, so reading it there would make the check always pass.
   */
  const bridgeReplyIsCurrent = (sent: ProfileBridgeSession, what: string): boolean => {
    if (sameProfileBridgeSession(sent, currentBridgeSession())) return true
    addConsoleEvent({
      severity: 'warning', source: 'machine',
      message: words("MachineLibraryModal.machine_profiles", { value1: PROFILE_STALE_BRIDGE_REPLY_LOG })
        + words("MachineLibraryModal.nothing_was_shown_and_nothing_was_recorded", { value1: what }),
    })
    return false
  }

  /**
   * The two halves the STORE publishes, compared against a token.
   *
   * The backend object is deliberately not compared here: no re-render
   * announces it, so the watcher below could not be woken by it anyway, and
   * `getMachineController()` INSTALLS a backend when none is present - which
   * is neither something a watcher may do nor something a RENDER may do. That
   * half is checked where it can be: at the reply, and again at the write,
   * through `bridgeReplyIsCurrent` above.
   */
  const storeHalvesUnmoved = (staged: ProfileBridgeSession): boolean =>
    sameProfileBridgeSession(staged, { ...staged, hello: bridgeHello, phase: connectionPhase })

  // WO-1002: a preview is a statement about ONE record. The moment the record
  // under it changes, its old/new columns are about a machine nobody is
  // looking at any more, so the preview is dropped rather than left to be
  // confirmed against the wrong target.
  const clearProfilePreview = () => {
    // Bump FIRST: a `previewProfile` still in flight belongs to the record we
    // are leaving, and its ticket is stale from here on.
    profileCallRef.current += 1
    // And it is no longer IN FLIGHT for any purpose: the bumped ticket is what
    // abandons the reply, and leaving the token behind would have the watcher
    // below retiring a call that is already dead.
    profileInFlightRef.current = null
    setProfilePreviewOpen(false)
    setProfilePreview(null)
    setPreviewError(null)
    setProfileBusy(false)
  }

  /**
   * WO-1002 fix round - EVERYTHING THIS SECTION SAYS, dropped together.
   *
   * `clearProfilePreview` drops the REPORT and nothing else, which is right
   * where the record under it is unchanged (confirm). At a MACHINE BOUNDARY it
   * is not enough: the chosen path, the config-write reply, the wire error and
   * the import note are all statements about the machine being left, and
   * leaving them on screen puts machine A's Pending badge, A's config-write
   * result and A's import message above machine B. Every boundary - open,
   * select, new, delete - and Cancel go through here.
   */
  const clearProfileImport = () => {
    clearProfilePreview()
    setChosenProfilePath(null)
    // Every filed outcome, not just the selected one: they are all statements
    // about the machine being left. A write still in flight will file itself
    // here afterwards, which is harmless - it is filed under a profile, and
    // this section is not shown until somebody picks that profile again.
    setProfileRequests({})
    setProfileNote(null)
  }

  /**
   * WO-1002 fix round - AN EDIT RETIRES THE REPORT.
   *
   * The one place every editor on this surface records that the record moved.
   * A dry run is a statement about the record as it was when the bridge
   * answered; edit a value underneath it and its "Now" column is describing
   * something else, while Confirm would still write the bridge's number. So
   * the report is dropped the moment anything is edited and the reason is
   * said out loud, rather than left on screen to be agreed to.
   *
   * `clearProfilePreview` bumps the read ticket first, so a `previewProfile`
   * still in flight - which was computed against the pre-edit record - is
   * abandoned instead of landing behind the edit.
   */
  const markEdited = () => {
    setIsDirty(true)
    setSaved(false)
    if (profilePreview === null && !profileBusy) return
    clearProfilePreview()
    setPreviewError(PROFILE_PREVIEW_STALE)
  }

  /**
   * WO-1002 attempt 5's AUDIT FINDING - THE BRIDGE MOVED, SO THE REPORT GOES.
   *
   * Previewing against bridge A, reconnecting to bridge B and pressing the
   * Confirm still on screen passed every guard this surface had: same machine,
   * same record, same profile. It wrote A's translated definition into the
   * record and sent the config request to B - the dry run describing one board
   * while the request reached another.
   *
   * The report is RETIRED rather than left to be refused, because a stale
   * report on screen is itself the hazard: it is a description of a board the
   * operator is no longer connected to, and the whole point of this surface is
   * that nobody agrees to numbers they were not shown. `previewError` says why
   * in the product's own words instead of the section simply going blank.
   *
   * This watches the two halves the STORE publishes. The backend object is the
   * third and no re-render announces it, which is why `confirmProfileImport`
   * checks the whole token again at the moment of writing - the guard that has
   * to hold anyway, where the write happens.
   *
   * THIS FIX ROUND'S AUDIT FINDING - AND IT WATCHES THE CALL IN THE AIR TOO.
   *
   *   AUDIT: FAIL - an in-flight preview can publish a stale report after the
   *   bridge session changes  (MachineLibraryModal.tsx:453)
   *
   * The version above this one returned immediately whenever `profilePreview`
   * was null, and between the press and the reply that is exactly the state
   * the surface is in. So a reconnect during the call retired nothing and
   * invalidated nothing, and because `profilePreview` is not a dependency the
   * effect did not run again when the old bridge's reply published its report.
   * The operator was then reading bridge A's board columns, with a live
   * Confirm on them, while bridge B was connected. Confirm refused to write -
   * that guard held - but a report about the wrong board is the hazard this
   * surface exists to prevent, not something to catch on the way out.
   *
   * `profileInFlightRef` is the report-that-does-not-exist-yet, carrying the
   * same session token, so ONE rule covers both: a request or a report whose
   * bridge has moved is retired, and the retirement bumps the read ticket so
   * the late reply is abandoned rather than published.
   */
  useEffect(() => {
    // THE CALL IN THE AIR FIRST - the audited window. There is no report to
    // watch yet, and the request that will become one was sent to a bridge
    // that has now moved. Retiring it here means the reply is abandoned at its
    // ticket check instead of publishing a report about the old board, so the
    // operator never reads one. `clearProfilePreview` bumps that ticket, drops
    // any report underneath and clears the waiting indicator, which is exactly
    // the whole of what "this request is over" means on this surface.
    const inFlight = profileInFlightRef.current
    if (inFlight !== null && !storeHalvesUnmoved(inFlight.session)) {
      // WO-1002 fix round 2 - A WRITE IN THE AIR IS RETIRED BY THE SAME LINE.
      // Its reply is dropped at the gate either way; retiring it here is what
      // stops the surface going on saying "Asking the bridge..." about a
      // conversation that ended, and it bumps the read ticket so a preview and
      // a write are abandoned by one rule rather than two.
      const wasPreview = inFlight.kind !== 'write'
      clearProfilePreview()
      // The preview section is what `previewError` is printed in. A retired
      // WRITE has no report on screen to explain, and saying a report went
      // stale when none existed would be this surface inventing an event.
      if (wasPreview) setPreviewError(PROFILE_BRIDGE_SESSION_CHANGED)
      return
    }
    if (profilePreview === null) return
    if (profilePreview.session === null) return
    if (storeHalvesUnmoved(profilePreview.session)) return
    clearProfilePreview()
    setPreviewError(PROFILE_BRIDGE_SESSION_CHANGED)
  }, [bridgeHello, connectionPhase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Select first machine (or current project machine) when modal opens
  useEffect(() => {
    if (!isOpen) return
    const initial = machineLibrary.find(m => m.id === currentProjectMachine.id) ?? machineLibrary[0]
    if (initial) {
      setSelectedId(initial.id)
      setDraft({ ...initial })
    } else {
      setSelectedId(null)
      setDraft(null)
    }
    setIsDirty(false)
    setSaved(false)
    travelEditedAxesRef.current = new Set()
    clearProfileImport()
    setWalkthroughMachineId(null)
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setExamplesOpen(false) }, [isOpen])

  const handleSelect = (m: MachineConfig) => {
    if (isDirty && draft) commitDraft()
    setWalkthroughMachineId(null)
    setSelectedId(m.id)
    setDraft({ ...m })
    travelEditedAxesRef.current = new Set()
    setIsDirty(false)
    setSaved(false)
    clearProfileImport()
  }

  const handleNew = () => {
    if (isDirty && draft) commitDraft()
    const m = blankMachine()
    addMachineToLibrary(m)
    setSelectedId(m.id)
    setDraft({ ...m })
    travelEditedAxesRef.current = new Set()
    setIsDirty(false)
    setSaved(false)
    clearProfileImport()
  }

  /**
   * WO-1698 fix round, reused by every hint link and by "Set up machine
   * control": open Control on THIS machine's Definition page, on `section`.
   * A session pinned to a DIFFERENT machine must not have its selection moved
   * by this navigation shortcut. Control's own dropdown owns that deliberate
   * switch and, since WO-1787, disconnects before selecting the other machine.
   * The queued section request still lands the operator on this machine's area
   * without touching Control's selection; see
   * `machineDefinitionSectionRequest.ts` and `useMachineDefinitionPanel`.
   */
  const openMachineDefinitionArea = (machineId: string, section: DefGroup) => {
    requestMachineDefinitionSection(machineId, section)
    const state = useCamStore.getState()
    const pinnedToAnotherMachine =
      Boolean(state.control.sessionMachine)
      && state.control.sessionActiveMachineId !== undefined
      && controlMachine(state).id !== machineId
    if (!pinnedToAnotherMachine) {
      state.setControlMachineId(machineId)
    }
    state.setWorkspace('control')
    closeModal()
  }

  // WO-1696 (v2/SLICES.md T13) entry point 1 - ADDITIVE, not a swap of
  // "New machine" itself: decide-and-log (rule 3). Making "New" open the
  // walkthrough directly (replacing this form outright, the WO's literal
  // wording) breaks WO-913's own from-scratch round-trip test
  // (`machineDefinitionEditor.wo913.test.tsx`, not owned by this order): that
  // test types a rename into "the name field" right after New, which would
  // land in the walkthrough's own edit buffer instead of this modal's
  // `draft`, and its later "Use for this project" commit would then persist
  // the UN-renamed record - exactly the WO-913 red this produced. `patch`/
  // `commitDraft` stay the one CAM-side edit path for a new machine; this
  // button is the second, explicit door onto the SAME record, mirroring
  // entry point 2's own additive button in `MachineDefinitionPanel.tsx` for
  // the identical reason (six more landed suites there).
  //
  // WO-1705 outcome 2 (ADR-0049): the SAME button/control, renamed "Set up
  // machine control". A machine that already has a definition has nowhere
  // left for a walkthrough to add - control of it happens on the Machine
  // area, so this opens that instead. A machine with none yet still gets the
  // walkthrough; `MachineLibraryWalkthroughHost` seeds its FIRST edit from
  // exactly what the CAM lens already holds (`seedDefinitionFromCamLens`) so
  // steps 2-3 open pre-filled instead of guessing factory 0/0 - kind and
  // spindle range need no seeding, they are already pre-filled for free
  // (Step 1 and Step 4 read `draft.kind`/`maxSpindleRpm`/`minSpindleRpm`
  // directly - the SAME MachineConfig fields the CAM lens just typed into,
  // per WO-1699). AUDIT FIX (fix round 1): the seed must land in the
  // walkthrough's own LOCAL edit, never `commitMachine`d to the library
  // first - persisting a CAM-seeded `controllerDefinition` before the
  // walkthrough opens made `source.controllerDefinition` non-null inside
  // `useMachineDefinitionPanel`, which is exactly the signal
  // `withMachineDefinitionProfileBaseline` (machineSession.ts) takes for "a
  // real profile was already imported" - it stamped a spurious
  // `liencamProfileDriftValues` baseline off the CAM-only seed on the very
  // first Save, breaking `setupWalkthrough.wo1696.test.tsx`'s stale-draft-
  // resume equality (not owned here). Seeding only the walkthrough's local
  // draft (never the library) keeps `source.controllerDefinition` null until
  // a real Save, exactly like the un-seeded path.
  const handleSetUpMachineControl = () => {
    if (!draft) return
    if (draft.controllerDefinition) {
      if (isDirty) commitDraft()
      openMachineDefinitionArea(draft.id, 'machine')
      return
    }
    if (isDirty) commitDraft()
    setWalkthroughMachineId(draft.id)
  }

  const patch = (updates: Partial<MachineConfig>) => {
    setDraft(d => d ? { ...d, ...updates } : d)
    markEdited()
  }

  /** WO-965: the machine-wide coolant answer, written through the same seam
   *  the per-channel answers use. `patch({ coolant })` is what the audit
   *  failed - see the row that calls this. */
  const patchCoolant = (has: boolean) => {
    setDraft(d => d ? withMachineCoolant(d, has) : d)
    markEdited()
  }

  /** WO-1705 fix round 3 (Operator, binding: "edit either location... one
   *  location for data, two lenses"). Once a definition exists, travel IS
   *  the axis soft limits (`machineTravel`, ADR-0049) - this writes THOSE,
   *  through `withAxisTravelEdited` (axisSoftLimitEdit.ts, the ONE write
   *  path the Machine area's own travel columns share) - positioned by the axis's CURRENT
   *  home/zero convention so the signed range does not move under an
   *  operator who only meant to change the span. A stated homing value at
   *  the home end of travel moves with that end in the same edit (fix round
   *  4: it used to stay put, sending G28 past the new soft limit). No
   *  definition: the standalone field is the only storage, exactly as
   *  always. */
  const patchTravel = (axis: 'x' | 'y' | 'z', v: number) => {
    travelEditedAxesRef.current.add(axis)
    setDraft(d => {
      if (!d) return d
      if (!d.controllerDefinition) return { ...d, travel: { ...d.travel, [axis]: v } }
      const range = signedAxisRange(axis, editableHomeConvention(d, axis), v)
      if (!range) return d
      return {
        ...d,
        controllerDefinition: withAxisTravelEdited(
          d, axis.toUpperCase() as AxisName, range.min, range.max,
        ),
      }
    })
    markEdited()
  }

  /** WO-1705 fix round 3 (Operator, binding overrule of WO-1701's disabled+link
   *  shape): once a definition exists, this writes the SAME `homing.perAxis`
   *  field the Machine area's own homing edit writes (`withStatedAxisHomeEnd`
   *  above), never a second copy in the flat `homeConvention`. No
   *  definition: the flat field is the only storage, exactly as always. */
  const patchHomeConvention = (
    axis: AxisId,
    field: 'homesToward' | 'machineZeroAt',
    value: 'min' | 'max',
  ) => {
    setDraft(d => {
      if (!d) return d
      const current = editableHomeConvention(d, axis)
      const selected = { ...current, [field]: value }
      const next = controllerZeroIsHomeSwitch(d.controller)
        ? { homesToward: selected.homesToward, machineZeroAt: selected.homesToward }
        : selected
      if (d.controllerDefinition) {
        return {
          ...d,
          controllerDefinition: withStatedAxisHomeEnd(
            d.controllerDefinition, d.controller, axis.toUpperCase() as AxisName,
            next.homesToward, next.machineZeroAt, machineTravel(d)[axis],
          ),
        }
      }
      const convention = {
        x: editableHomeConvention(d, 'x'), y: editableHomeConvention(d, 'y'), z: editableHomeConvention(d, 'z'),
      }
      return {
        ...d,
        homeConvention: { ...convention, [axis]: next },
      }
    })
    markEdited()
  }

  /** WO-1705 fix round 3 (Operator): Max Cutting has never had a second copy, so
   *  it always writes the standalone `axisLimits`. Max Rapid, once a
   *  definition states axis speeds, IS that axis's `maxVelocity` (the same
   *  field the Machine area's Motion tab writes via `patchAxis`) - writing
   *  it here merges away what would otherwise be a second, unread copy
   *  (`axisLimits.maxRapid`) rather than leaving a disabled field behind. No
   *  definition: `axisLimits.maxRapid` is the only storage, exactly as
   *  always. */
  const patchAxisLimit = (axis: 'x' | 'y' | 'z', field: 'maxCutting' | 'maxRapid', v: number) => {
    setDraft(d => {
      if (!d) return d
      if (field === 'maxRapid' && d.controllerDefinition) {
        const AXIS = axis.toUpperCase() as AxisName
        return {
          ...d,
          controllerDefinition: {
            ...d.controllerDefinition,
            axes: d.controllerDefinition.axes.map((a) => a.axis === AXIS ? { ...a, maxVelocity: v } : a),
          },
        }
      }
      const prev = d.axisLimits ?? { ...DEFAULT_AXIS_LIMITS }
      return { ...d, axisLimits: { ...prev, [axis]: { ...prev[axis], [field]: v } } }
    })
    markEdited()
  }

  const commitDraft = () => {
    if (!draft) return
    commitMachine(draft)
  }

  /**
   * The one write path out of this modal, taking the record EXPLICITLY.
   *
   * `commitDraft` used to read `draft` from the closure, which is correct for
   * a Save button pressed after React has re-rendered and wrong for anything
   * that builds a new record and saves it in the same tick - `setDraft` has
   * not landed yet, so the closure still holds the OLD record. WO-1002's
   * profile import is exactly that shape, so the record to write is an
   * argument and there is still only one store path.
   */
  const commitMachine = (rawNext: MachineConfig) => {
    // WO-965 - ONE COOLANT TRUTH, ENFORCED AT THE DOOR. The Coolant tick that
    // used to sit in Feeds & Options wrote `coolant` on its own while the
    // definition page answered the same question per channel; the audit on
    // 2026-08-27 failed exactly that pair. The tick is gone, and this is the
    // belt to its braces: every record leaving this modal - including one
    // LOADED already contradicting itself, and including the profile import
    // that calls straight in here - carries the bit its channels derive.
    // Where no channel is answered `reconciledMachineCoolant` returns the
    // record's own bit, so this changes nothing for a machine nobody has
    // described.
    const next: MachineConfig = {
      ...rawNext,
      coolant: reconciledMachineCoolant(rawNext),
    }
    const before = useCamStore.getState().machineLibrary.find((m) => m.id === next.id)
    const travelEdited = travelEditedAxesRef.current
    travelEditedAxesRef.current = new Set()
    // SAVE TO THE PROFILE, and that is all it is: bookkeeping, reversible, over
    // THIS surface's field set. `draft` was spread from the record and carries
    // `controllerDefinition` untouched, so a CAM save never disturbs the
    // control half - and it never validates it either, because a complaint
    // about a field this surface cannot reach is a nag, not a report. The
    // control panel validates the control half on its own Save.
    if (selectedId) {
      updateMachineInLibrary(selectedId, next)
    } else {
      addMachineToLibrary(next)
      setSelectedId(next.id)
    }
    // WO-928 / F17 - THE WRITE-THROUGH. `project.machine` is a SEPARATE COPY of
    // the library entry, and `project.machine.controllerDefinition` is what
    // `JogPanel` reads when it homes. Writing only the library meant Save left
    // the app homing against the OLD definition while an Apply sent the new
    // one: two definitions, no warning, and a readback that PASSES because the
    // board holds exactly what was sent. Saving the entry that IS the active
    // machine now writes through to that copy, so after Save the definition the
    // app homes with and the definition Apply sends are the same object.
    //
    // Saving a machine that is NOT the active one deliberately changes nothing
    // about the project - that is a library edit. The Apply that used to sit
    // in this modal refused exactly that case by name; it now lives on the
    // control panel and refuses it there (WO-941).
    if (next.id === currentProjectMachine.id) setProjectMachine(next)
    // WO-1705 (Operator, binding: "if a user changes the length of the axis, it
    // forces a rehome"). Only an axis whose Travel was typed here AND whose
    // length actually changed; the session decides whether this is the
    // connected machine and whether it has switches to rehome against.
    if (before && travelEdited.size > 0) {
      const from = machineTravel(before)
      const to = machineTravel(next)
      noteAxisTravelChanged(next.id, [...travelEdited]
        .filter((axis) => Number.isFinite(to[axis]) && Math.abs(from[axis] - to[axis]) >= 1e-3)
        .map((axis) => ({ axis: axis.toUpperCase() as JogAxis, fromMm: from[axis], toMm: to[axis] })))
    }
    setIsDirty(false)
    setSaved(true)
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null
      setSaved(false)
    }, 1500)
  }

  const handleDelete = () => {
    if (!selectedId) return
    removeMachineFromLibrary(selectedId)
    const remaining = machineLibrary.filter(m => m.id !== selectedId)
    if (remaining.length > 0) {
      setSelectedId(remaining[0].id)
      setDraft({ ...remaining[0] })
    } else {
      setSelectedId(null)
      setDraft(null)
    }
    setIsDirty(false)
    // The report was about the record that has just been deleted: it
    // describes a machine that no longer exists and sits above a different
    // one - and so do the chosen path, the config-write reply and the import
    // note, which is why the whole section goes, not just the report.
    clearProfileImport()
  }

  const handleUseForProject = () => {
    if (!draft) return
    if (isDirty) commitDraft()
    setProjectMachine(draft)
    closeModal()
  }

  // ALWAYS A DOWNLOAD, NEVER A PATH (ADR-0044 requirement 1). Nothing here
  // knows where a file came from and nothing here can write over one - the
  // browser hands the bytes to the user and they choose. That is what makes
  // ".pro export" safe to sit next to ".pro import": we are the consumer of
  // that file, not its owner.
  const download = (body: string, filename: string, type: string) => {
    void saveFile(filename, body, type)
  }

  const fileStem = (name: string) => name.replace(/\s+/g, '_')

  const handleExportSelected = () => {
    if (!draft) return
    download(machineDefinitionText(draft),
      `${fileStem(draft.name)}.machine.json`, 'application/json')
  }

  const handleExportAll = () => {
    download(machineLibraryText(machineLibrary),
      'machine_library.json', 'application/json')
  }

  // A `.pro` IS a UCCNC profile, so it is an action only a UCCNC machine owns.
  // Do not spend footer space on a disabled controller action: a GRBL or
  // LinuxCNC machine has no `.pro` to export in the first place.
  const surface = controllerSurface(draft)
  const canExportPro = surface.uccncProfile
  // With no selection, retain the import path so it can explain that a machine
  // must be selected. A declared non-UCCNC machine still receives JSON only.
  const canImportPro = surface.uccncProfile || !draft

  // WO-1038: THE EXPORT IS A RULER. What it leaves out is the reading, so the
  // count of unstated keys goes to the console every time rather than being
  // swallowed by a successful-looking download. A key this machine has not
  // stated is ABSENT from the file - never a default this software chose.
  const handleExportPro = () => {
    if (!draft) return
    // The SECOND HALF OF THE SAME GATE. The button is absent, so a click cannot
    // arrive here today; this guard keeps that true if the control ever gains a
    // keyboard path or a stale render. One condition, stated twice, so neither
    // surface can drift into exporting GRBL through the UCCNC catalogue.
    if (!canExportPro) return
    // WO-1805: the exported machine is not the exporting app - hand the
    // exporter this machine's CURRENT declared board so the `Statistics` line
    // states what the machine IS, not what an archived profile once said. This
    // is a complete current machine record, so the option is ALWAYS named:
    // undefined means the machine currently states no board, including after a
    // saved clear has crossed JSON persistence and lost its optional key.
    const written = exportUccncProfile(draft.controllerDefinition, {
      profileName: draft.name,
      controllerBoard: draft.controllerBoard,
    })
    download(written.text, `${fileStem(draft.name)}.pro`, 'text/plain')
    addConsoleEvent({
      severity: written.absent.length === 0 ? 'info' : 'warning',
      source: 'machine',
      message: proExportSummary(fileStem(draft.name), written.emitted.length, written.absent.length),
    })
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string)
        const list: MachineConfig[] = Array.isArray(parsed) ? parsed : [parsed]
        const imported: MachineConfig[] = []
        list.forEach(m => {
          if (m.name) {
            const machine = { ...m, id: crypto.randomUUID() }
            addMachineToLibrary(machine)
            imported.push(machine)
          }
        })
        // Use the ordinary selection boundary: save a dirty previous draft and
        // discard its profile preview. Project activation stays explicit.
        const first = imported[0] && useCamStore.getState().machineLibrary
          .find((machine) => machine.id === imported[0].id)
        if (first) handleSelect(first)
      } catch {
        // WO UI-11B: this was a fully silent catch (not even console.warn) —
        // now a warning event. Behavior otherwise unchanged (still ignores
        // the malformed file; no redesign of the import flow).
        addConsoleEvent({
          severity: 'warning', source: 'machine',
          message: words("MachineLibraryModal.machine_library_import_is_not_valid_json", { value1: file.name }),
        })
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  /** A `.pro` copied from another computer follows the same dry-run contract
   * as a bridge profile, but it has no bridge session and can never apply to a
   * controller. The parsed definition object shown here is the object Confirm
   * stores, so preview and import cannot diverge. */
  const handleLocalProfile = (file: File | undefined, macroFiles: readonly File[] = []) => {
    if (!surface.uccncProfile) return
    const target = draft
    if (!file || !target) return

    const ticket = ++profileCallRef.current
    profileInFlightRef.current = null
    setChosenProfilePath(null)
    setProfileNote(null)
    setPreviewError(null)
    setProfilePreview(null)
    setProfileBusy(true)
    // WO-1670/1743: the profile's macro files, picked with it, are kept as the
    // user's macros and also inspected for narrowly provable park positions.
    const macrosRead = macroFiles.length === 0
      ? null
      : Promise.all(macroFiles.map((macro) => new Promise<UccncMacroFile | null>((resolve) => {
        const macroReader = new FileReader()
        macroReader.onload = () => resolve({ name: macro.name, text: String(macroReader.result ?? '') })
        macroReader.onerror = () => resolve(null)
        macroReader.readAsText(macro)
      })))
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      if (macrosRead === null) showLocalPreview(text, [])
      else {
        void macrosRead.then((read) =>
          showLocalPreview(text, read.filter((macro): macro is UccncMacroFile => macro !== null)))
      }
    }
    const showLocalPreview = (text: string, macros: UccncMacroFile[]) => {
      if (profileCallRef.current !== ticket || draftRef.current?.id !== target.id) return
      setProfileBusy(false)
      const preview = previewLocalUccncProfile(target, file.name, text, macros)
      setProfilePreview({
        path: file.name,
        fileHash: null,
        machineId: target.id,
        record: profileRecordFingerprint(target),
        session: null,
        source: 'file',
        preview,
      })
      setProfilePreviewOpen(true)
    }
    reader.onerror = () => {
      if (profileCallRef.current !== ticket || draftRef.current?.id !== target.id) return
      setProfileBusy(false)
      setPreviewError(words("MachineLibraryModal.could_not_read_nothing_was_changed", { value1: file.name }))
    }
    reader.readAsText(file)
  }

  const handleMachineFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // WO-1670/1743: a .pro may be picked together with its macro folder's
    // files (M200.txt ...); their bodies stay verbatim while recognized park
    // coordinates also fill the machine's existing G30 position store.
    const pro = files.find((candidate) => candidate.name.toLowerCase().endsWith('.pro'))
    if (pro && !draft) {
      e.target.value = ''
      const message = words("MachineLibraryModal.cannot_preview_without_a_machine_select_or", { value1: pro.name })
      setPreviewError(message)
      addConsoleEvent({ severity: 'warning', source: 'machine', message })
      return
    }
    if (pro) {
      e.target.value = ''
      handleLocalProfile(pro, files.filter((candidate) => candidate.name.toLowerCase().endsWith('.txt')))
    } else handleImport(e)
  }

  // ==========================================================================
  // WO-1002 - PREVIEW A PROFILE BEFORE IT IS APPLIED
  // ==========================================================================
  //
  // TWO ACTS WITH A PERSON IN BETWEEN. `chooseProfile` ASKS THE BRIDGE what a
  // profile would mean and renders it; `confirmProfileImport` is the only
  // thing in this file that writes anything, and it runs only from a press on
  // a report somebody has read. A profile import that applies first and
  // reports second is how the pin-translation hazard reached a real machine
  // (MACHINE-SETTINGS-DESIGN 4.2).
  //
  // The landed bridge supplies only the read-only `previewProfile` verb. An
  // older backend can lack the local method, while a deployed UccncController
  // has the method and receives the remote bridge's unknown-method refusal;
  // both are SAID once in the console. On a landed raw reply, Confirm
  // re-previews, proves the file hash is unchanged, stores imported provenance,
  // and calls the existing definition apply path.
  // The old rich fake reply still follows WO-1002's config-write seam so its
  // historical concurrency coverage remains useful during rollout.

  const chooseProfile = async (path: string) => {
    // Intent, recorded immediately, so the row a person pressed reads as
    // chosen while the bridge is still answering. It is PENDING from this
    // moment and does not become active by anything that happens below.
    setChosenProfilePath(path)
    // WO-1002 attempt 4 - NOT `setProfileRequests({})`. Switching profiles
    // used to wipe the single result slot, which is precisely what made a late
    // reply land in an empty slot and be read as the new profile's result.
    // Results are filed per profile now; picking a different one simply looks
    // at a different entry, and picking one that has already been requested
    // shows that request's own outcome rather than a blank.
    setProfileNote(null)
    const target = draft
    if (!target) return

    // THE RECORD THIS PREVIEW IS ABOUT, captured now. The report describes the
    // machine that was on screen when the profile was picked, and it is
    // compared against THAT record even if `draft` has moved on by the time
    // the reply lands - at which point the ticket check throws the report away
    // rather than showing it against the wrong machine.
    const ticket = ++profileCallRef.current
    setProfilePreview(null)
    setPreviewError(null)

    const controller = getMachineController()
    if (!isProfileBridge(controller)) {
      setProfileBusy(false)
      setPreviewError(PROFILE_BRIDGE_MISSING)
      addConsoleEvent({ severity: 'warning', source: 'machine', message: PROFILE_BRIDGE_MISSING })
      return
    }
    // WO-1002 attempt 5 - THE SESSION THAT IS ABOUT TO TRANSLATE THIS. Taken
    // at the request and not at the reply: a UCpin in the report below is the
    // answer THIS bridge gave, so the report is filed against this session
    // even if the connection drops before the reply lands - at which point the
    // watcher above retires it, which is the right outcome and not a bug.
    const session: ProfileBridgeSession = {
      controller, hello: bridgeHello, phase: connectionPhase,
    }
    // WO-1002 fix round - AND IT IS SAID OUT LOUD WHILE THE CALL IS IN THE
    // AIR, so the watcher above can retire the request itself. Before the
    // await, because the session can move on the very next tick.
    profileInFlightRef.current = { kind: 'preview', ticket, session }

    setProfileBusy(true)
    let reply = null
    let failure: string | null = null
    try {
      // WO-1002 attempt 4 - THE MACHINE'S OWN PINS GO WITH THE REQUEST. The
      // report compares TRANSLATED against TRANSLATED, and only the bridge may
      // translate (design rule 1), so the bridge has to be given the raw side
      // it does not already have. Without it there is no honest "on the board
      // now" column, and a pin whose wiring is identical while its board pin
      // moves - the case that reached a real machine - is invisible.
      reply = await controller.previewProfile(path, target.controllerDefinition ?? null)
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
    // WO-1002 fix round 2 - THE SESSION GATE IS ASKED FIRST AND ALWAYS, and
    // its ANSWER is used further down. Asking it here rather than after the
    // checks below is what makes the drop audible: a reconnect retires the
    // request through the watcher, which bumps the ticket, so an
    // ordinary-looking "superseded" return would swallow the one event that
    // matters - a reply arriving from a bridge connection that no longer
    // exists. Superseded and stale-session are not the same event and the
    // console carries the one that is true.
    const fromThisSession = bridgeReplyIsCurrent(
      session, words("MachineLibraryModal.preview_of", { value1: profileFileName(path) }),
    )
    // Superseded (another machine picked, report cancelled, second profile
    // chosen, modal reopened), or the selection moved under us. Either way
    // this reply is about a record nobody is looking at: drop it, and leave
    // the busy flag to whichever call now owns it.
    if (profileCallRef.current !== ticket) return
    // We still own the ticket, so the token in the ref is ours or already
    // cleared: this call has landed and is no longer in flight either way.
    profileInFlightRef.current = null
    if (draftRef.current?.id !== target.id) return
    setProfileBusy(false)
    // WO-1002 fix round - AND THE BRIDGE THAT ANSWERED IS STILL THE BRIDGE ON
    // THE OTHER END. The watcher above covers the two halves the store
    // publishes; this covers the third - a backend swapped underneath the
    // modal moves no store value, wakes no effect, and would otherwise let
    // bridge A's translated report be published while bridge B is connected.
    // It is also the guard that has to hold anyway, at the point of
    // publication: a report only reaches the screen if the session it was read
    // from is the session still connected. Checked BEFORE the failure branch
    // below, because a call that failed because the connection went away is
    // honestly described by the session sentence and not by "it did not
    // answer".
    if (!fromThisSession) {
      setPreviewError(PROFILE_BRIDGE_SESSION_CHANGED)
      return
    }
    if (!reply) {
      if (isMissingProfilePreviewVerbError(failure)) {
        setPreviewError(PROFILE_BRIDGE_MISSING)
        addConsoleEvent({ severity: 'warning', source: 'machine', message: PROFILE_BRIDGE_MISSING })
        return
      }
      setPreviewError(
        words("MachineLibraryModal.the_bridge_could_not_preview", { value1: profileFileName(path) })
        + words("MachineLibraryModal.nothing_was_changed_2", { value1: failure ?? words('MachineLibraryModal.noAnswer') }),
      )
      return
    }
    // WO-1002 attempt 5 - AND THE REPLY MUST BE ABOUT THE PROFILE WE ASKED
    // FOR. That was the audited defect: `reply.path` has been echoed by the
    // contract from the start and nothing compared it, so a reply about
    // profile B could be filed under profile A - shown as A's old -> new rows,
    // imported as A's values on confirm, and followed by a config write for A.
    // A person then reads B's numbers, agrees to them, and A's record takes
    // them. The ticket and machine checks above cannot catch this: it is not a
    // stale reply, it is a reply about the wrong file, and only the file's own
    // identity can say so. Nothing is filed and no report reaches the screen.
    if (!previewAnswersProfile(path, reply)) {
      setPreviewError(
        describeProfilePreviewMismatch({ requested: path, answered: reply.path }),
      )
      return
    }
    setProfilePreview({
      path,
      fileHash: isBridgePreviewProfileReply(reply) ? reply.fileHash : null,
      machineId: target.id,
      // The record the columns below were computed FROM, so confirm can prove
      // it is still writing into the machine the person actually read about.
      record: profileRecordFingerprint(target),
      // And the bridge that translated them, for the same reason.
      session,
      source: 'bridge',
      preview: previewBridgeProfileChanges(target, reply),
    })
  }

  /** THE NEGATIVE CONTROL. Dropping the report writes nothing, anywhere - and
   *  it abandons any `previewProfile` still in flight, so nothing lands behind
   *  it. The picked path is dropped too: an intent nobody agreed to is not an
   *  intent, and leaving the row lit would be this surface claiming a choice
   *  the person just took back. */
  const cancelProfileImport = () => {
    clearProfileImport()
  }

  const confirmProfileImport = async () => {
    // The ref is the same-tick lock. React cannot publish `profileBusy` between
    // two clicks dispatched in one turn, so the disabled button is the visible
    // guard and this synchronous check is the write-once guard underneath it.
    if (profileInFlightRef.current !== null) return
    const staged = profilePreview
    if (!draft || !staged || !staged.preview.readable) return
    // THE REPORT AND THE RECORD ARE THE SAME MACHINE, checked at the moment of
    // writing and not only when the report was built. A report about another
    // machine is not something to write anywhere.
    if (staged.machineId !== draft.id) {
      clearProfilePreview()
      setPreviewError(PROFILE_PREVIEW_STALE)
      return
    }
    // AND THE SAME MACHINE IS NOT THE SAME RECORD. The audited defect was an
    // edit to THIS machine between the report and the agreement: the report
    // went on saying travel X 800 -> 1000 while the field said 900, and
    // confirm wrote the bridge's 1000 - a value nobody was shown. Editors
    // retire the report as they go (`markEdited`); this is the guard that has
    // to hold anyway, at the moment of writing, so no path that moves the
    // record can end in an unseen value being written.
    if (profileRecordFingerprint(draft) !== staged.record) {
      clearProfilePreview()
      setPreviewError(PROFILE_PREVIEW_STALE)
      return
    }
    // WO-1002 attempt 5 - AND THE REPORT IS ABOUT THE PROFILE IT IS FILED
    // UNDER, checked at the moment of writing. `chooseProfile` already refuses
    // to file a reply that answers about another file; this is the same rule
    // as the record fingerprint above - the guard that has to hold anyway,
    // where the write happens, so no path that reaches confirm can end in one
    // profile's values landing in another profile's record. `staged.path` is
    // what the person picked and what the config write will ask for;
    // `staged.preview.path` is what the bridge said it read.
    if (!sameProfilePath(staged.preview.path, staged.path)) {
      clearProfilePreview()
      setPreviewError(describeProfilePreviewMismatch({
        requested: staged.path, answered: staged.preview.path,
      }))
      return
    }
    // WO-1002 attempt 5's AUDIT FINDING - AND THE SAME BRIDGE, CHECKED WHERE
    // THE WRITE HAPPENS. The watcher above retires the report when the store
    // says the connection moved, and this is the guard that has to hold
    // anyway: it also covers the half no re-render announces, a backend object
    // swapped underneath us. A translated UCpin is a fact about ONE board, so
    // confirming a report from bridge A would write A's numbers into the
    // record and then ask bridge B to load the file - the dry run describing
    // one board while the request reaches another. Nothing is written and
    // nothing is requested; the report goes and says why.
    if (staged.session !== null
        && !sameProfileBridgeSession(staged.session, currentBridgeSession())) {
      clearProfilePreview()
      setPreviewError(PROFILE_BRIDGE_SESSION_CHANGED)
      return
    }
    // WO-1106: THE FILE IS THE SAME FILE THE OPERATOR REVIEWED. The bridge
    // owns the bytes, so Confirm asks again and the SHA-256 is the authority.
    // A moved hash replaces the report with a fresh one and performs no write.
    let confirmedDraft = draft
    if (staged.source === 'bridge' && staged.fileHash !== null) {
      const controller = getMachineController()
      if (!isProfileBridge(controller)) {
        clearProfilePreview()
        setPreviewError(PROFILE_BRIDGE_MISSING)
        addConsoleEvent({ severity: 'warning', source: 'machine', message: PROFILE_BRIDGE_MISSING })
        return
      }
      const ticket = ++profileCallRef.current
      profileInFlightRef.current = { kind: 'confirm', ticket, session: staged.session! }
      setProfileBusy(true)
      let fresh = null
      let failure: string | null = null
      try {
        fresh = await controller.previewProfile(staged.path, draft.controllerDefinition ?? null)
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      }
      // Cancel, edit, machine selection and bridge-session retirement all bump
      // this ticket before dropping the report. A late reply owns nothing and
      // must not clear a newer call's busy state or reach either write below.
      if (profileCallRef.current !== ticket) return
      if (profileInFlightRef.current?.ticket === ticket) profileInFlightRef.current = null
      setProfileBusy(false)

      // The await opens a real record-mutation window. Re-read the committed
      // render state rather than the closure captured by the Confirm press, and
      // prove again that it is the exact machine record the operator reviewed.
      const liveDraft = draftRef.current
      if (liveDraft?.id !== staged.machineId
          || profileRecordFingerprint(liveDraft) !== staged.record) {
        clearProfilePreview()
        setPreviewError(PROFILE_PREVIEW_STALE)
        return
      }
      confirmedDraft = liveDraft
      if (!sameProfileBridgeSession(staged.session!, currentBridgeSession())) {
        clearProfilePreview()
        setPreviewError(PROFILE_BRIDGE_SESSION_CHANGED)
        return
      }
      if (!isBridgePreviewProfileReply(fresh)
          || !previewAnswersProfile(staged.path, fresh)
          || !fresh.ok
          || fresh.fileHash === null) {
        const reason = isBridgePreviewProfileReply(fresh)
          ? fresh.reason ?? words("MachineLibraryModal.the_bridge_returned_no_file_hash")
          : failure ?? words("MachineLibraryModal.the_bridge_returned_an_invalid_preview_reply")
        const message = words("MachineLibraryModal.re_import_refused_nothing_was_imported_or", { value1: reason })
        clearProfilePreview()
        setPreviewError(message)
        addConsoleEvent({ severity: 'warning', source: 'machine', message })
        return
      }
      if (fresh.fileHash !== staged.fileHash) {
        setProfilePreview({
          ...staged,
          fileHash: fresh.fileHash,
          record: profileRecordFingerprint(confirmedDraft),
          preview: previewBridgeProfileChanges(confirmedDraft, fresh),
        })
        addConsoleEvent({ severity: 'warning', source: 'machine', message: PROFILE_FILE_CHANGED })
        return
      }
    }

    const previewedDefinition = staged.preview.definition
    const definition = previewedDefinition && staged.fileHash !== null
      ? markDefinitionImported(previewedDefinition, staged.path, staged.fileHash)
      : previewedDefinition
    if (!definition) {
      clearProfilePreview()
      setPreviewError(
        words("MachineLibraryModal.the_preview_of_did_not_include_a", { value1: profileFileName(staged.path) })
        + words("MachineLibraryModal.nothing_was_changed_3"),
      )
      return
    }

    // 1. THE RECORD. The values written are the SAME OBJECT the change rows
    //    were computed from - not a second read - so what was shown cannot
    //    differ from what was written.
    const next: MachineConfig = withImportedUccncToolSetter({
      ...confirmedDraft,
      controllerDefinition: definition,
      travel: staged.preview.travel ?? confirmedDraft.travel,
      unsentSettings: staged.preview.unsent,
      // WO-1743: every profile macro stays verbatim, ahead of the machine's
      // own macros in M-code order. Recognized park coordinates are a separate
      // fact on the existing G30 position store; no body is translated and no
      // duplicate bound macro is injected. An absent fact leaves the machine's
      // existing positions and macros exactly as they are.
      ...(staged.preview.parkMacros && staged.preview.parkMacros.length > 0
        ? { macros: [...staged.preview.parkMacros, ...(confirmedDraft.macros ?? [])] }
        : {}),
      ...(staged.preview.referencePositions
        ? { referencePositions: staged.preview.referencePositions }
        : {}),
    }, staged.preview.toolSetter ?? null)
    setDraft(next)
    commitMachine(next)
    if (staged.preview.parkNote) {
      addConsoleEvent({ severity: 'info', source: 'machine', message: staged.preview.parkNote })
    }
    const replacementReceipt = describeProfileReplacementConsole(staged.preview)
    if (replacementReceipt) {
      addConsoleEvent({ severity: 'info', source: 'machine', message: replacementReceipt })
    }

    // WO-1002 attempt 4 - THE NUMBER SAID IS THE NUMBER THAT MOVED. The
    // report is total now, so `changes.length` is "how many values this
    // profile writes" and not "how many changed"; saying the total here would
    // report 200-odd changes on an import that changed four things. Both
    // numbers are said, because both are true and neither alone is the answer.
    const moved = staged.preview.changedCount
    const total = staged.preview.changes.length + staged.preview.pins.length
    const path = staged.path
    // Drops the report AND retires any preview still in flight, so a late
    // reply cannot put a second report on screen after this one was taken.
    clearProfilePreview()
    if (staged.source === 'bridge') setChosenProfilePath(path)
    setProfileNote(
      words("MachineLibraryModal.imported_into_and_saved_this", { value1: profileFileName(path), value2: next.name })
      + words("MachineLibraryModal.machine_of_value_changed", { value1: moved, value2: total, value3: total === 1 ? '' : 's' })
      + (staged.fileHash === null
        ? words("MachineLibraryModal.nothing_was_sent_to_a_controller")
        : words("MachineLibraryModal.the_confirmed_definition_was_sent_through_apply")),
    )
    addConsoleEvent({
      severity: 'info', source: 'machine',
      message:
        words("MachineLibraryModal.machine_imported_into_the_machine_record", { value1: next.name, value2: path })
        + words("MachineLibraryModal.of_value_s_changed", { value1: moved, value2: total })
        + (staged.fileHash === null
          ? words("MachineLibraryModal.nothing_was_sent_to_a_controller")
          : words("MachineLibraryModal.sending_the_confirmed_definition_through_apply_to")),
    })

    // The landed bridge has no profile write verb. Re-import is our store
    // followed by the existing definition apply/readback path, exactly once.
    if (staged.source === 'bridge' && staged.fileHash !== null) {
      const outcome = await applyConnectedMachineDefinition(definition, {})
      for (const line of describeApplyOutcome(outcome)) {
        addConsoleEvent({
          severity: line.severity === 'error'
            ? 'error'
            : line.severity === 'warn' ? 'warning' : 'info',
          source: 'machine',
          message: line.text,
        })
      }
      return
    }

    // A file selected from disk is an import source only. It has no bridge
    // request to finish and no controller to apply to.
    if (staged.source === 'file') return

    // 2. THE REQUEST. Asking the bridge to record this profile in its config
    //    file is a SEPARATE fact from the record write above, and it is
    //    reported separately - including when it fails, because "your record
    //    changed and the machine PC was never told" is exactly the divergence
    //    a person needs to know about.
    //
    //    WO-1002 attempt 4 - AND IT IS REPORTED AGAINST THE PROFILE IT IS FOR.
    //    `path` and `next.id` are captured here, at the press, and every
    //    outcome below is filed under them. Nothing in this block reads the
    //    selection as it stands when the reply lands, so a person switching
    //    profiles or machines mid-flight cannot be shown this request's result
    //    as though it were theirs. That was the audited defect.
    //
    //    WO-1002 fix round 2 - AND AGAINST THE BRIDGE IT WAS SENT TO.
    //
    //      AUDIT: FAIL - a config-write reply survives a bridge session change
    //      and is reported against the replacement bridge  (:1054)
    //
    //    The audit is right. The session was checked ONCE, above, before the
    //    request went out, and the binding ended at the `await`: disconnect
    //    and reconnect while `setBridgeProfile` is in the air and bridge A's
    //    reply was filed and printed as bridge B's result - the operator told
    //    the connection now in front of them has recorded a profile it was
    //    never asked about. The same class as the preview finding before it,
    //    so it is closed the same way and by the same code: the session is
    //    captured HERE, at the send, travels with the request, and every
    //    branch below passes through `bridgeReplyIsCurrent` on the way in.
    const controller = getMachineController()
    const machineId = next.id
    const session: ProfileBridgeSession = {
      controller, hello: bridgeHello, phase: connectionPhase,
    }
    if (!isProfileBridge(controller) || typeof controller.setBridgeProfile !== 'function') {
      recordProfileOutcome(machineId, session, {
        path, reply: null, error: PROFILE_BRIDGE_MISSING,
      })
      return
    }
    const ticket = ++profileCallRef.current
    // Said out loud while the call is in the air, exactly as the preview does,
    // so the watcher retires this round-trip too rather than only that one.
    profileInFlightRef.current = { kind: 'write', ticket, session }
    setProfileBusy(true)
    const said = words("MachineLibraryModal.config_write_for", { value1: profileFileName(path) })
    try {
      const reply = await controller.setBridgeProfile(path)
      // THE GATE FIRST. A reply from a connection that has since been replaced
      // is not this bridge's answer and not any bridge's answer any more: it
      // is dropped whole - not filed, not printed, not counted - before any of
      // the questions below are even asked of it.
      if (!bridgeReplyIsCurrent(session, said)) return
      // The reply must say which request it answers. One that names another
      // file is not this request's result - `profileRequestState` calls that
      // `mismatched` and the surface says so rather than reading it as an
      // answer about `path`.
      recordProfileOutcome(machineId, session, { path, reply, error: null })
    } catch (err) {
      // A FAILURE FROM A DEAD SESSION IS DROPPED TOO. "The bridge could not
      // record this" is a statement about a bridge; attributing the old
      // connection's socket error to the new one is the same lie in the other
      // direction, and the reconnect is the honest explanation.
      if (!bridgeReplyIsCurrent(session, said)) return
      recordProfileOutcome(machineId, session, {
        path, reply: null, error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // This call has landed, however it landed, so it is no longer in flight.
      // Only if it is still OURS: a newer call owns the token from the moment
      // it takes it, and a retirement in between has already nulled it.
      if (profileInFlightRef.current?.ticket === ticket) profileInFlightRef.current = null
      // AND THE INDICATOR STOPS EVEN WHEN THE REPLY IS DROPPED. In a `finally`
      // because the gate above returns out of both branches: a dropped reply
      // that left "Asking the bridge..." on screen would have the surface
      // waiting forever on a conversation it has already decided to ignore.
      // Still only if no newer call has taken the indicator - clearing another
      // call's would stop the surface saying it is waiting while it still is.
      if (profileCallRef.current === ticket) setProfileBusy(false)
    }
  }

  // Mark the selected machine as the persisted default used for NEW projects.
  // Commits any unsaved draft first so the library has the current name/config,
  // then records its id in appSettings.
  const handleSetDefault = () => {
    if (!draft) return
    if (isDirty) commitDraft()
    setDefaultMachineId(draft.id)
  }

  const handleDismiss = () => {
    if (isDirty && draft) commitDraft()
    closeModal()
  }

  const isOpenRef = useRef(isOpen)
  const draftRef = useRef(draft)
  const isDirtyRef = useRef(isDirty)
  const commitDraftRef = useRef(commitDraft)
  const dismissRef = useRef(handleDismiss)
  const pendingActionRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    // NumericInput commits in its own keydown handler. Publish only committed
    // render state so the deferred save sees that same Enter's draft.
    isOpenRef.current = isOpen
    draftRef.current = draft
    isDirtyRef.current = isDirty
    commitDraftRef.current = commitDraft
    dismissRef.current = handleDismiss
  })

  useEffect(() => {
    if (!isOpen) return

    const cancelPendingAction = (): void => {
      if (pendingActionRef.current === null) return
      window.clearTimeout(pendingActionRef.current)
      pendingActionRef.current = null
    }
    const schedule = (action: 'save' | 'dismiss'): void => {
      if (pendingActionRef.current !== null) return
      pendingActionRef.current = window.setTimeout(() => {
        pendingActionRef.current = null
        if (!isOpenRef.current) return
        if (action === 'dismiss') dismissRef.current()
        else if (draftRef.current && isDirtyRef.current) commitDraftRef.current()
      }, 0)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.keyCode === 229
        || event.key === 'Process'
      ) return
      if (event.key !== 'Enter' && event.key !== 'Escape') return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        cancelPendingAction()
        schedule('dismiss')
        return
      }

      const panel = document.querySelector<HTMLElement>('[data-testid="machine-modal-panel"]')
      if (!isSafeMachineEnterTarget(event.target, panel)) return

      event.preventDefault()
      event.stopImmediatePropagation()
      schedule('save')
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelPendingAction()
    }
  }, [isOpen])

  const isProjectMachine = draft?.id === currentProjectMachine.id
  const isDefaultMachine = draft?.id === defaultMachineId

  // ---- collapsed-section current-value summaries (clutter P7) ---------------
  // Display-unit converted, trailing zeros trimmed (fmtDim pads to 3-4 dp).
  const dim = (vMm: number) => fmtDim(vMm, displayUnits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  const feed = (vMmMin: number) => fmtFeed(vMmMin, displayUnits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  // WO-1698: travel has one reader - the definition's axis soft limits once a
  // definition exists, the standalone field before (ADR-0049).
  const travel = draft ? machineTravel(draft) : null
  const travelSummary = travel
    ? `${dim(travel.x)} / ${dim(travel.y)} / ${dim(travel.z)}`
    : ''
  const homeSummary = draft
    ? draft.noHomingSwitches
      ? words("MachineLibraryModal.no_homing_switches")
      : (['x', 'y', 'z'] as const).map(axis => {
          const c = editableHomeConvention(draft, axis)
          return controllerZeroIsHomeSwitch(draft.controller)
            ? words("MachineLibraryModal.home_and_zero", { value1: axis.toUpperCase(), value2: c.homesToward })
            : words("MachineLibraryModal.home_zero", { value1: axis.toUpperCase(), value2: c.homesToward, value3: c.machineZeroAt })
        }).join(' / ')
    : ''
  const spindleSummary = draft
    ? `${draft.maxSpindleRpm ?? words('MachineLibraryModal.notSet')} / ${draft.minSpindleRpm ?? words('MachineLibraryModal.notSet')} / ${draft.spindleDirection === 'ccw' ? 'CCW (M4)' : 'CW (M3)'}`
    : ''
  const feedsSummary = draft
    ? words("MachineLibraryModal.feedsSummary", { feed: feed(machineRapidRate(draft)?.mmMin ?? draft.rapidRate), changer: TOOL_CHANGERS.find(t => t.value === draft.toolChanger)?.label ?? draft.toolChanger, coolant: draft.coolant ? words("MachineLibraryModal.coolantSummary") : '' })
    : ''
  const probeDefaults = draft ? editableProbeDefaults(draft) : DEFAULT_MACHINE_PROBE_DEFAULTS
  const probingSummary = draft
    ? words("MachineLibraryModal.probingSummary", { clear: feed(probeDefaults.positioningFeed), search: feed(probeDefaults.fastFeed), probe: feed(probeDefaults.slowFeed) })
    : ''
  // WO-1676: the tool table, probe overrides and M-code overrides travel
  // with the definition now - summarised here the same way every other
  // disclosure on this modal is, so a machine with none of the three still
  // reads as "nothing yet" rather than an empty-looking open section.
  const toolTableSummary = draft
    ? (() => {
        const table = machineToolTable(draft)
        return table.tools.length === 0
          ? words("MachineLibraryModal.no_tools_measured_yet")
          : words("MachineLibraryModal.toolTableSummary", { count: table.tools.length, suffix: table.tools.length === 1 ? '' : 's', reference: table.reference === null ? '' : words("MachineLibraryModal.referenceToolSummary", { tool: table.reference }) })
      })()
    : ''
  // X cutting / X rapid / Z cutting - the three numbers that differ in the
  // defaults; the expanded table carries the full per-axis matrix.
  const draftLimits = draft?.axisLimits ?? DEFAULT_AXIS_LIMITS
  // WO-1705 fix round 3: X's Max Rapid summary reads the same value the
  // expanded table shows - the definition's own X axis speed once one is
  // stated, `axisLimits.maxRapid` otherwise (never the stale flat copy).
  const xDefinitionAxis = draft?.controllerDefinition?.axes.find((a) => a.axis === 'X')
  const xMaxRapid = xDefinitionAxis ? xDefinitionAxis.maxVelocity : draftLimits.x.maxRapid
  const axisSummary = draft
    ? `${feed(draftLimits.x.maxCutting)} / ${feed(xMaxRapid)} / ${feed(draftLimits.z.maxCutting)}`
    : ''
  const notesSummary = (draft?.notes ?? '').trim().split('\n')[0]

  // WO-1002. `runningProfile` is the ONLY thing that may be called active: it
  // is the file the LIVE bridge process actually opened, reported in its own
  // `hello`. `chosenProfilePath` is a person's intent and is called pending
  // until the two agree - a successful config write does not move it, because
  // the bridge goes on running what it opened until somebody restarts it.
  const runningProfile = bridgeUccnc?.profile ?? null
  const bridgeProfiles = bridgeUccnc?.profiles ?? []
  const chosenIsRunning = sameProfilePath(runningProfile, chosenProfilePath)
  const profileSummary = !bridgeUccnc
    ? words("MachineLibraryModal.bridge_not_connected")
    : runningProfile
      ? words("MachineLibraryModal.active_on_the_bridge", { value1: profileFileName(runningProfile) })
      : words("MachineLibraryModal.found_none_reported_active", { value1: bridgeProfiles.length })
  // WO-1002 attempt 4 - THE RESULT SHOWN IS THE ONE FILED UNDER THE PROFILE ON
  // SCREEN, and there is no other way to reach one. The lookup is by the
  // selected profile's own key and the machine it was requested under, so a
  // reply for some other profile is not merely hidden - it is not addressable
  // from here at all. Every sentence and every state below is then computed
  // from `outcome.path`, which is that same profile.
  //
  // WO-1002 fix round 2 - AND THE BRIDGE IT WAS ANSWERED BY IS STILL THE ONE
  // CONNECTED. The gate at the reply is what stops a stale result being
  // stored; this is the guard that has to hold anyway, at the point of
  // reading, so a stored result cannot be shown over a connection it says
  // nothing about even if some future path managed to file one. "Requested,
  // not active - restart the bridge" is a sentence about ONE bridge process,
  // and the restart it asks for is itself a session change: after it the
  // sentence has served its purpose and the live hello is the honest source.
  const chosenKey = normalizeProfilePath(chosenProfilePath)
  const filed = chosenKey === '' ? undefined : profileRequests[chosenKey]
  const requestOutcome = filed
    && filed.machineId === draft?.id
    && storeHalvesUnmoved(filed.session)
    ? filed.outcome
    : null
  const requestSentence = requestOutcome === null
    ? ''
    : describeConfigWriteRequest(requestOutcome, bridgeHostCapability())
  const requestState = requestOutcome === null ? 'none' : profileRequestState(requestOutcome)

  if (!isOpen) return null

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div
      className="modal-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleDismiss() }}
    >
      <div
        className={`modal-container machine-modal${profilePreviewOpen ? ' machine-modal-profile-view' : ''}`}
        data-testid="machine-modal-panel"
        ref={dialogFocusRef}
      >
        {profilePreviewOpen && profilePreview !== null && (
          profilePreview.source === 'file' ? (
            <LocalProfilePreviewView
              preview={profilePreview.preview}
              onConfirm={() => { void confirmProfileImport() }}
              onCancel={cancelProfileImport}
              busy={profileBusy}
            />
          ) : (
            <ProfilePreviewView
              preview={profilePreview.preview}
              onConfirm={() => { void confirmProfileImport() }}
              onCancel={cancelProfileImport}
              busy={profileBusy}
            />
          )
        )}
        <div className="machine-library-view" hidden={profilePreviewOpen}>
        {/* Header */}
        <div className="modal-header">
          <Cpu size={14} className="modal-header-icon" />
          <span className="modal-title">{words("MachineLibraryModal.machine_library")}</span>
          <button className="modal-close-btn" onClick={handleDismiss}>
            <X size={14} />
          </button>
        </div>

        <ResizableSplit
          className="machine-modal-body"
          testId="machine-library-split"
          prefKey={MACHINE_LIST_PANEL_KEY}
          sizedPane="first"
          defaultSize={Math.round(MACHINE_LIST_COLUMN_PX * uiScale) - MACHINE_LIST_BAR_PX}
          minSize={Math.round(MACHINE_LIST_MIN_PX * uiScale)}
          maxSize={Math.round(MACHINE_LIST_MAX_PX * uiScale)}
          fillMinSize={Math.round(MACHINE_EDITOR_MIN_PX * uiScale)}
          label={words("MachineLibraryModal.resize_the_machine_list_and_editor")}
          sizedCollapsed={listCollapsed}
          first={
          <div className="machine-list-col" style={{ width: 'auto', minWidth: 0, borderRight: 'none', position: 'relative' }}>
            {/* Overlaid so the default list rows sit exactly where they did. */}
            <span data-testid="machine-list-header" style={{ position: 'absolute', top: 2, right: 2, zIndex: 1 }}>
              <PanelCollapseToggle
                panelKey={MACHINE_LIST_COLLAPSE_KEY}
                testId="machine-list-collapse"
                collapseTip={words("MachineLibraryModal.collapse_the_machine_list")}
                expandTip={words("MachineLibraryModal.expand_the_machine_list")}
              />
            </span>
            {!listCollapsed && (<>
            <div className="machine-list">
              {machineLibrary.map((m) => (
                <div
                  key={m.id}
                  className={`machine-list-item${selectedId === m.id ? ' machine-list-item-active' : ''}`}
                  onClick={() => handleSelect(m)}
                >
                  <div className="machine-list-name">{m.name}</div>
                  <div className="machine-list-meta">{m.type.replace(/_/g, ' ')}{words("MachineLibraryModal.symbol")}{controllerDisplayName(m.controller)}</div>
                  {m.id === currentProjectMachine.id && (
                    <span className="badge badge-accent">{words("MachineLibraryModal.active")}</span>
                  )}
                  {m.id === defaultMachineId && (
                    <span className="badge badge-warning" data-tooltip={words("MachineLibraryModal.used_for_new_projects")}>
                      <Star size={9} />{words("MachineLibraryModal.default")}</span>
                  )}
                </div>
              ))}
              {machineLibrary.length === 0 && (
                <div className="machine-list-empty">{words("MachineLibraryModal.no_machines_add_one")}</div>
              )}
            </div>

            {/* List actions */}
            <div className="machine-list-actions">
              <div style={{ display: 'flex', gap: 2, position: 'relative' }}>
                <button className="machine-list-btn" onClick={handleNew} data-tooltip={words("MachineLibraryModal.new_machine_2")}>
                  <Plus size={11} />{words("MachineLibraryModal.new")}</button>
                <button
                  className="machine-list-btn"
                  aria-expanded={examplesOpen}
                  aria-controls="machine-library-examples"
                  onClick={() => setExamplesOpen((open) => !open)}
                >{words("MachineLibraryModal.examples")}</button>
                {examplesOpen && (
                  <section
                    id="machine-library-examples"
                    aria-label={words("MachineLibraryModal.example_machines")}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setExamplesOpen(false)
                      }
                    }}
                    style={{
                      position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
                      width: 360, maxWidth: 'calc(100vw - 64px)', zIndex: 2,
                      padding: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-panel)', boxShadow: '0 4px 16px #0006',
                    }}
                  >
                    {EXAMPLE_MACHINES.map((example) => (
                      <button
                        key={example.key}
                        className="machine-list-btn"
                        style={{ marginBottom: 2, color: 'var(--text-primary)' }}
                        onClick={() => {
                          // Append only: preserve the existing editor's unsaved
                          // draft as well as every existing library record.
                          addMachineToLibrary(createExampleMachine(example))
                          setExamplesOpen(false)
                        }}
                      >{words("MachineLibraryModal.example", { value1: example.name })}</button>
                    ))}
                  </section>
                )}
              </div>
              <button
                className="machine-list-btn"
                data-testid="machine-library-import"
                onClick={() => importRef.current?.click()}
                data-tooltip={canImportPro ? words('MachineLibraryModal.importJsonOrPro') : words("MachineLibraryModal.import_json")}
              >
                <Upload size={11} />{words("MachineLibraryModal.import")}</button>
              <button className="machine-list-btn" onClick={handleExportAll} data-tooltip={words("MachineLibraryModal.export_all")}>
                <Download size={11} />{words("MachineLibraryModal.export_all_2")}</button>
            </div>
            </>)}
            <input
              ref={importRef}
              type="file"
              multiple={canImportPro}
              accept={canImportPro ? '.json,.pro' : '.json'}
              data-testid={canImportPro
                ? 'uccnc-profile-local-input'
                : 'machine-library-import-input'}
              style={{ display: 'none' }}
              onChange={handleMachineFile}
            />
          </div>
          }
          second={
          <div className="machine-editor-col">
            {draft && walkthroughMachineId === draft.id ? (
              <MachineLibraryWalkthroughHost
                machineId={draft.id}
                onExit={() => {
                  // AUDIT FIX (fix round 1): this modal's `draft` is a LOCAL
                  // copy made by `handleNew`/`handleSelect` before the
                  // walkthrough ever ran. The walkthrough saves through
                  // `useMachineDefinitionPanel`'s own `commit()`, straight to
                  // the library - a second, independent write path onto the
                  // SAME record. Clearing only `walkthroughMachineId` left
                  // `draft` holding those pre-walkthrough values, so the
                  // ordinary form reappeared stale; the next Save Changes sent
                  // that stale whole record through `commitDraft`, erasing
                  // whatever the walkthrough had just written. Re-reading the
                  // library record fresh from the store (not the closured
                  // `machineLibrary` variable, which is one render behind a
                  // commit that just happened in this same click) closes that
                  // second write path's gap.
                  const finishedId = walkthroughMachineId
                  setWalkthroughMachineId(null)
                  const latest = finishedId
                    ? useCamStore.getState().machineLibrary.find((m) => m.id === finishedId)
                    : null
                  if (latest) {
                    setSelectedId(latest.id)
                    setDraft({ ...latest })
                    setIsDirty(false)
                    setSaved(false)
                  }
                }}
              />
            ) : !draft ? (
              <div className="machine-editor-empty">{words("MachineLibraryModal.select_a_machine_or_create_a_new")}</div>
            ) : (
              <div className="machine-editor">
                {/* Name */}
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.name")}</label>
                  <input
                    className="mform-input"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>

                {/* WO-1696 (v2/SLICES.md T13) entry point 1 - the guided
                    alternative to filling in the fields below by hand, most
                    useful right after New. See `handleSetUpMachineControl`
                    for why this is a button next to the form rather than a
                    swap of it, and for the WO-1705 branch: a machine that
                    already has a definition has nothing left for a
                    walkthrough to add, so this opens the Machine area
                    instead (testid kept stable for entry-point tests that
                    predate the rename). */}
                <div className="mform-row">
                  <button
                    type="button"
                    className="machine-list-btn"
                    data-testid="machine-library-run-walkthrough"
                    data-tooltip={draft.controllerDefinition
                      ? words("MachineLibraryModal.open_this_machine_in_control_machine_machine")
                      : words("MachineLibraryModal.answer_seven_short_questions_instead_imports_a")}
                    onClick={handleSetUpMachineControl}
                  >
                    {draft.controllerDefinition ? words("MachineLibraryModal.set_up_machine_control") : words("MachineLibraryModal.set_up_machine_control_walkthrough")}
                  </button>
                </div>

                {/* Type + Kind + Controller */}
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.type")}</label>
                  <select className="mform-select" value={draft.type} onChange={(e) => patch({ type: e.target.value as MachineType })}>
                    {MACHINE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.kind")}</label>
                  <select
                    className="mform-select"
                    data-testid="machine-kind-select"
                    value={machineKind(draft)}
                    onChange={(e) => patch({ kind: e.target.value as MachineKind })}
                  >
                    {MACHINE_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.controller")}</label>
                  <select
                    className="mform-select"
                    data-testid="machine-controller-select"
                    value={draft.controller}
                    onChange={(e) => patch({ controller: e.target.value as ControllerType })}
                  >
                    {/* Legacy/unknown saved value: surface it explicitly (never
                        blank) so the user sees the post will fall back. */}
                    {!CONTROLLERS.some(c => c.value === draft.controller) && (
                      <option value={draft.controller}>{words("MachineLibraryModal.legacyController", { controller: draft.controller })}</option>
                    )}
                    {CONTROLLERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>

                {/* Travel (clutter P7): collapsed disclosure, X / Y / Z summary */}
                <DisclosureSection
                  title={words("MachineLibraryModal.travel", { value1: unitLabel(displayUnits) })}
                  summary={travelSummary}
                  testId="disclosure-machine-travel"
                >
                {/* WO-1705 fix round 3 (Operator, binding overrule of WO-1698's
                    disabled+link shape): "Edit either location. Saves to
                    same data... One location for data, two lenses and touch
                    points." Once a definition exists, travel IS the axis
                    soft limits (`machineTravel`, ADR-0049) - typing here
                    writes those SAME soft limits through the SAME statement
                    mechanism the Machine area's own soft-limit edit uses
                    (`patchTravel` below), positioned by this axis's current
                    home/zero convention so the signed range the Homing table
                    shows does not move. No definition: writes the standalone
                    `travel` field exactly as always. */}
                <div className="mform-xyz-row">
                  {(['x', 'y', 'z'] as const).map(ax => (
                    <div key={ax} className="mform-xyz-cell">
                      <label className="mform-axis-label" style={{ color: `var(--${ax}-axis)` }}>{ax.toUpperCase()}</label>
                      <NumericInput
                        min={1} step={10}
                        className="mform-input mform-input-mono"
                        value={travel![ax]}
                        units={displayUnits}
                        onChange={(v) => patchTravel(ax, v)}
                      />
                    </div>
                  ))}
                </div>
                </DisclosureSection>

                <DisclosureSection
                  title={words("MachineLibraryModal.homing_machine_zero")}
                  summary={homeSummary}
                  testId="disclosure-machine-home-convention"
                >
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.homing_switches")}</label>
                  <label className="mform-toggle">
                    <input
                      type="checkbox"
                      checked={!draft.noHomingSwitches}
                      onChange={(e) => patch({ noHomingSwitches: !e.target.checked })}
                    />
                    <span className="mform-toggle-track" />
                  </label>
                </div>
                {/* WO-1705 fix round 3 (Operator, binding overrule of WO-1701's
                    disabled+link shape, 16:12Z homing note superseded by the
                    later 11:4x CDT ruling): "Edit either location... One
                    location for data, two lenses and touch points." Every
                    applicable select stays plain and enabled (only "no homing
                    switches" disables it); GRBL-family controllers omit the
                    separate zero-end choice because the switch is zero.
                    Editing a choice writes through `patchHomeConvention`
                    below, which - once a definition exists - states this
                    axis's home end on `homing.perAxis` (the SAME field and
                    the SAME `withAxisHomingStated` mechanism the Machine
                    area's own homing edit uses) instead of the flat
                    `homeConvention`. No definition: the flat field is
                    written exactly as always. */}
                <table className="mform-axis-table" data-testid="machine-home-convention-table">
                  <thead>
                    <tr>
                      <th>{words("MachineLibraryModal.axis")}</th>
                      <th>{words("MachineLibraryModal.home_switch_location")}</th>
                      {!controllerZeroIsHomeSwitch(draft.controller) && <th>{words("MachineLibraryModal.machine_zero_location")}</th>}
                      <th>{words("MachineLibraryModal.machine_range", { value1: unitLabel(displayUnits) })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['x', 'y', 'z'] as const).map(axis => {
                      const convention = editableHomeConvention(draft, axis)
                      // WO-377: the SIGNED result of switch end + zero end +
                      // travel, live with every change - the fact the three
                      // selectors used to leave in the operator's head.
                      const range = draft.noHomingSwitches
                        ? null
                        : signedAxisRange(axis, convention, travel![axis])
                      return (
                        <tr key={axis} data-testid={`machine-envelope-row-${axis}`}>
                          <td className="mform-axis-label" style={{ color: `var(--${axis}-axis)` }}>
                            {axis.toUpperCase()}
                          </td>
                          <td>
                            <select
                              className="mform-select"
                              aria-label={words("MachineLibraryModal.home_switch_location_2", { value1: axis.toUpperCase() })}
                              value={convention.homesToward}
                              disabled={draft.noHomingSwitches}
                              onChange={(e) => patchHomeConvention(axis, 'homesToward', e.target.value as 'min' | 'max')}
                            >
                              <option value="min">{words("MachineLibraryModal.minimum_end")}</option>
                              <option value="max">{words("MachineLibraryModal.maximum_end")}</option>
                            </select>
                          </td>
                          {!controllerZeroIsHomeSwitch(draft.controller) && <td>
                            <select
                              className="mform-select"
                              aria-label={words("MachineLibraryModal.machine_zero_location_2", { value1: axis.toUpperCase() })}
                              value={convention.machineZeroAt}
                              disabled={draft.noHomingSwitches}
                              onChange={(e) => patchHomeConvention(axis, 'machineZeroAt', e.target.value as 'min' | 'max')}
                            >
                              <option value="min">{words("MachineLibraryModal.minimum_end")}</option>
                              <option value="max">{words("MachineLibraryModal.maximum_end")}</option>
                            </select>
                          </td>}
                          <td
                            className="mform-input-mono machine-envelope-range"
                            data-testid={`machine-envelope-range-${axis}`}
                            data-envelope-negative={range ? String(range.negative) : 'none'}
                          >
                            {range ? `${dim(range.min)} .. ${dim(range.max)}` : words("MachineLibraryModal.no_datum")}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {/* WO-377: where home lands, in plain words, per axis. A
                    range that dips below zero (max/max, min/min) is valid
                    and is SAVED AS TYPED - the sentence explains the
                    negative-coordinate result instead of rewriting it. */}
                <ul className="machine-envelope-sentences" data-testid="machine-envelope-sentences">
                  {draft.noHomingSwitches ? (
                    <li data-testid="machine-envelope-sentence-none">{words("MachineLibraryModal.no_homing_switches_this_machine_has_no")}</li>
                  ) : (
                    (['x', 'y', 'z'] as const).map(axis => {
                      const range = signedAxisRange(axis, editableHomeConvention(draft, axis), travel![axis])
                      return (
                        <li
                          key={axis}
                          data-testid={`machine-envelope-sentence-${axis}`}
                          data-envelope-negative={range ? String(range.negative) : 'none'}
                        >
                          {range
                            ? describeSignedAxisRange(range, dim)
                            : words("MachineLibraryModal.enter_a_travel_greater_than_zero_to", { value1: axis.toUpperCase() })}
                        </li>
                      )
                    })
                  )}
                </ul>
                </DisclosureSection>

                {/* Spindle (clutter P7): max / min / direction summary */}
                <DisclosureSection
                  title={words("MachineLibraryModal.spindle")}
                  summary={spindleSummary}
                  testId="disclosure-machine-spindle"
                >
                {/* WO-1705 fix round 3 (Operator, binding 11:4x CDT overrule of
                    the read-out+link pattern this section used to have: "No,
                    you do not tell someone to edit somewhere else. Edit
                    either location. Saves to same data... One location for
                    data, two lenses and touch points."). Max/Min RPM and
                    Direction are `MachineConfig` fields the Spindle area
                    (SpindleArea.tsx) edits with the SAME `editDraft` write
                    every other field on that record uses - there never was a
                    second copy to disagree, only a second EDITOR of the one
                    field, which is exactly what Operator wants kept. Both stay
                    plain, always-enabled controls regardless of whether a
                    definition exists. */}
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.max_rpm")}</label>
                  <OptionalNumericInput min={0} step={1000} className="mform-input mform-input-mono"
                    value={draft.maxSpindleRpm}
                    placeholder={words("MachineLibraryModal.not_set")}
                    onChange={(v) => patch({ maxSpindleRpm: v === undefined ? undefined : Math.round(v) })} />
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.min_rpm")}</label>
                  <OptionalNumericInput min={0} step={100} className="mform-input mform-input-mono"
                    value={draft.minSpindleRpm}
                    placeholder={words("MachineLibraryModal.not_set")}
                    onChange={(v) => patch({ minSpindleRpm: v === undefined ? undefined : Math.round(v) })} />
                </div>
                <div className="mform-row">
                  <label className="mform-label" htmlFor="machine-library-spindle-direction">{words("MachineLibraryModal.direction")}</label>
                  <select
                    id="machine-library-spindle-direction"
                    className="mform-select" value={draft.spindleDirection}
                    onChange={(e) => patch({ spindleDirection: e.target.value as 'cw' | 'ccw' })}>
                    <option value="cw">{words("MachineLibraryModal.cw_m3")}</option>
                    <option value="ccw">{words("MachineLibraryModal.ccw_m4")}</option>
                  </select>
                </div>
                </DisclosureSection>

                {/* Feeds & options (clutter P7): rapid / tool changer summary */}
                <DisclosureSection
                  title={words("MachineLibraryModal.feeds_options")}
                  summary={feedsSummary}
                  testId="disclosure-machine-feeds"
                >
                {/* WO-1705 fix round 3 (Operator, binding overrule of WO-1700's
                    "set in the Machine area" hint): the typed rapid is the
                    everyday rapid and stays editable regardless of a
                    definition. Its ceiling, once the axis table states max
                    velocities, is edited right here too now (Axis Feed
                    Limits below) - no hint pointing elsewhere is needed. */}
                {(() => {
                  return (
                    <>
                      <div className="mform-row" data-testid="machine-form-rapid-row">
                        <label className="mform-label">{words("MachineLibraryModal.rapid_fast_traverse_max", { value1: feedLabel(displayUnits) })}</label>
                        <NumericInput min={100} step={500} className="mform-input mform-input-mono"
                          value={draft.rapidRate}
                          units={displayUnits} kind="feed"
                          onChange={(v) => patch({ rapidRate: Math.round(v) })} />
                      </div>
                    </>
                  )
                })()}
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.tool_changer")}</label>
                  <select className="mform-select" value={draft.toolChanger}
                    onChange={(e) => patch({ toolChanger: e.target.value as ToolChangerType })}>
                    {TOOL_CHANGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                {/* WO-965: THE SAME TICK, AND IT IS NO LONGER ITS OWN TRUTH.
                    `patch({ coolant })` is what the audit failed on: it wrote
                    the machine-wide bit alone while the definition page's
                    Spindle group answered the same question per channel, so a
                    record could say "has coolant" over "no mist, no flood".
                    `withMachineCoolant` is the coarse door onto the per-channel
                    seam - No states both relays No, Yes states nothing new
                    about either - so this control can no longer disagree with
                    them. The readout beside it says what they currently say,
                    including "not stated", which is a machine nobody has
                    answered for and not a machine without coolant. */}
                <div className="mform-row" data-testid="machine-form-coolant">
                  <label className="mform-label">{words("MachineLibraryModal.coolant")}</label>
                  <label className="mform-toggle">
                    <input type="checkbox" checked={draft.coolant}
                      onChange={(e) => patchCoolant(e.target.checked)} />
                    <span className="mform-toggle-track" />
                  </label>
                  {/* `mform-hint`, not `mform-value`: this is a sentence, and
                      `mform-value` is a mono field for a number. Styles live in
                      `app.css`, which this order does not own - so it reuses one.
                      And NOT `.mform-label` - the first `.mform-label` in a row
                      is the control's name to anything reading this form. */}
                  <span
                    className="mform-hint"
                    data-testid="machine-form-coolant-readout"
                    style={{ flex: 1, marginTop: 0 }}
                  >
                    {words("MachineLibraryModal.mistReadout")}
                    {describeCoolantCapability(statedCoolantCapability(draft, 'mist')).toLowerCase()}
                    {words("MachineLibraryModal.floodReadout")}
                    {describeCoolantCapability(statedCoolantCapability(draft, 'flood')).toLowerCase()}
                    {words("MachineLibraryModal.answer_them_per_channel_under_coolant_in")}
                  </span>
                </div>
                </DisclosureSection>

                {/* WO-1693 (ADR-0049): this disclosure is a READ-OUT, not a
                    second editor. `MachineProbeDefaults` is one record with
                    two lenses - this CAM lens shows it, the machine-control
                    lens (Control > Machine > Definition > Probing) is the one
                    editor. A change made there appears here on next render
                    because both lenses read `draft.probing`; nothing here
                    writes it. */}
                <DisclosureSection
                  title={words("MachineLibraryModal.probing_defaults")}
                  summary={probingSummary}
                  testId="disclosure-machine-probing-defaults"
                >
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.clear_positioning", { value1: feedLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-positioningFeed">
                    {feed(probeDefaults.positioningFeed)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.search_speed", { value1: feedLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-fastFeed">
                    {feed(probeDefaults.fastFeed)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.probe_speed", { value1: feedLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-slowFeed">
                    {feed(probeDefaults.slowFeed)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.retract_step_off", { value1: unitLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-retract">
                    {dim(probeDefaults.retract)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.maximum_search", { value1: unitLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-maxTravel">
                    {dim(probeDefaults.maxTravel)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.surface_clearance", { value1: unitLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-surfaceClearance">
                    {dim(probeDefaults.surfaceClearance)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.search_overtravel", { value1: unitLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-overtravel">
                    {dim(probeDefaults.overtravel)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.boss_cross_over_lift", { value1: unitLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-crossOverLift">
                    {dim(probeDefaults.crossOverLift)}
                  </span>
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("MachineLibraryModal.probe_pad_thickness", { value1: unitLabel(displayUnits) })}</label>
                  <span className="mform-input-mono" data-testid="machine-probing-readout-padThickness">
                    {dim(probeDefaults.padThickness)}
                  </span>
                </div>
                <div
                  data-testid="machine-probing-readout-note"
                  style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginTop: 4 }}
                >{words("MachineLibraryModal.set_in_control_machine_definition_probing")}</div>
                </DisclosureSection>

                {/* WO-1676: the tool table, probe overrides and M-code
                    overrides now live on the definition (`toolTable`,
                    `probeOverrides`, `actionOverrides`) instead of two side
                    stores an export never carried. Editing stays where it
                    already was - the Control page's Tools/Probe panel and
                    Machine actions modal - this is a read-only view so an
                    operator can see what a machine carries before exporting
                    it without a second place that can edit the same fields. */}
                <DisclosureSection
                  title={words("MachineLibraryModal.tool_table_overrides")}
                  summary={toolTableSummary}
                  testId="disclosure-machine-tooltable"
                >
                {draft && <ToolTableSection machine={draft} units={displayUnits} />}
                </DisclosureSection>

                {/* Per-axis feedrate limits (clutter P7). Summary = X cutting /
                    X rapid / Z cutting; the table has the full matrix. */}
                <DisclosureSection
                  title={words("MachineLibraryModal.axis_feed_limits", { value1: feedLabel(displayUnits) })}
                  summary={axisSummary}
                  testId="disclosure-machine-axis-limits"
                >
                {/* WO-1705 fix round 3 (Operator, binding overrule of the
                    architect's 14:35Z "dead control" reading): Max Rapid is
                    NOT a second copy once a definition states axis speeds -
                    it IS that axis's `maxVelocity`, the same field the
                    Machine area's Motion tab edits (`patchAxis`). Typing
                    here writes that field directly (`patchAxisLimit` above);
                    no definition states one, `axisLimits.maxRapid` is the
                    only storage, exactly as always. Always one editable
                    field, never a disabled one. */}
                <table className="mform-axis-table">
                  <thead>
                    <tr>
                      <th>{words("MachineLibraryModal.axis")}</th>
                      <th>{words("MachineLibraryModal.max_cutting")}</th>
                      <th>{words("MachineLibraryModal.max_rapid")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['x', 'y', 'z'] as const).map(ax => {
                      const limits = (draft.axisLimits ?? DEFAULT_AXIS_LIMITS)[ax]
                      const definitionAxis = draft.controllerDefinition?.axes
                        .find((a) => a.axis === ax.toUpperCase())
                      const maxRapid = definitionAxis ? definitionAxis.maxVelocity : limits.maxRapid
                      return (
                        <tr key={ax}>
                          <td className="mform-axis-label" style={{ color: `var(--${ax}-axis)` }}>
                            {ax.toUpperCase()}
                          </td>
                          <td>
                            <NumericInput
                              min={1} step={100}
                              className="mform-input mform-input-mono mform-axis-input"
                              value={limits.maxCutting}
                              units={displayUnits} kind="feed"
                              onChange={(v) => patchAxisLimit(ax, 'maxCutting', Math.round(v))}
                            />
                          </td>
                          <td>
                            <NumericInput
                              min={1} step={500}
                              className="mform-input mform-input-mono mform-axis-input"
                              value={maxRapid}
                              units={displayUnits} kind="feed"
                              onChange={(v) => patchAxisLimit(ax, 'maxRapid', Math.round(v))}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </DisclosureSection>

                {/* WO-941: where the other half went. A plain sentence, not a
                    control - this surface offers no route into the machine,
                    and a person who came looking for pins should be told where
                    they are rather than left to conclude they were lost. */}
                <div
                  className="mform-row"
                  data-testid="machine-modal-control-half-note"
                  style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
                >{words("MachineLibraryModal.axes_homing_cycle_pin_assignments_steps_per")}</div>

                {/* --- WO-1002: pick a profile, read what it would do, agree --- */}
                {surface.uccncProfile && <DisclosureSection
                  title={words("MachineLibraryModal.uccnc_profile")}
                  summary={profileSummary}
                  testId="disclosure-machine-uccnc-profile"
                >
                <div
                  className="mform-row"
                  data-testid="uccnc-profile-intro"
                  style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
                >{words("MachineLibraryModal.a_uccnc_pro_file_is_an_import")}</div>

                <div className="mform-row">
                  <button
                    type="button"
                    className="modal-btn modal-btn-ghost"
                    data-testid="uccnc-profile-local-pick"
                    onClick={() => importRef.current?.click()}
                  >
                    <Upload size={12} />{words("MachineLibraryModal.choose_pro_file_and_its_macro_files")}</button>
                </div>

                {/* The picker over what the bridge found on the machine PC. */}
                <div
                  data-testid="uccnc-profile-list"
                  data-profile-count={bridgeProfiles.length}
                  className="machine-list"
                >
                  {!bridgeUccnc && (
                    <div className="machine-list-empty" data-testid="uccnc-profile-no-bridge">{words("MachineLibraryModal.connect_to_the_machine_bridge_to_see")}</div>
                  )}
                  {bridgeUccnc && bridgeProfiles.length === 0 && (
                    <div className="machine-list-empty" data-testid="uccnc-profile-none-found">{words("MachineLibraryModal.the_bridge_found_no_pro_files_under")}</div>
                  )}
                  {bridgeProfiles.map((path, i) => {
                    const isRunning = sameProfilePath(runningProfile, path)
                    const isChosen = !isRunning && sameProfilePath(chosenProfilePath, path)
                    return (
                      <button
                        key={path}
                        type="button"
                        className={`machine-list-item${isChosen ? ' machine-list-item-active' : ''}`}
                        data-testid={`uccnc-profile-row-${i}`}
                        data-profile-state={isRunning ? 'active' : isChosen ? 'pending' : 'available'}
                        data-profile-path={path}
                        onClick={() => { void chooseProfile(path) }}
                      >
                        <div className="machine-list-name">{profileFileName(path)}</div>
                        <div className="machine-list-meta">{path}</div>
                        {isRunning && (
                          <span className="badge badge-accent">{words("MachineLibraryModal.active_on_the_bridge_2")}</span>
                        )}
                        {isChosen && <span className="badge badge-warning">{words("MachineLibraryModal.pending")}</span>}
                      </button>
                    )
                  })}
                </div>

                {/* PENDING AND ACTIVE ARE DIFFERENT WORDS. Choosing a file here
                    changes nothing on the machine: the bridge opened its profile
                    at startup and keeps running it until it is restarted, so
                    saying "active" would be the software asserting a thing that
                    has not happened. */}
                {chosenProfilePath !== null && (
                  <div
                    className="mform-row"
                    data-testid="uccnc-profile-pending-note"
                    data-profile-state={chosenIsRunning ? 'active' : 'pending'}
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
                  >
                    {describeProfileActivation({
                      runningProfile, chosenProfile: chosenProfilePath,
                      bridgeCapability: bridgeHostCapability(),
                    })}
                  </div>
                )}

                {profileBusy && (
                  <div className="mform-row" data-testid="uccnc-profile-busy">{words("MachineLibraryModal.asking_the_bridge")}</div>
                )}

                {previewError !== null && (
                  <div
                    className="mform-row"
                    data-testid="uccnc-profile-preview-error"
                    style={{ fontSize: 'var(--font-size-sm)' }}
                  >
                    {previewError}
                  </div>
                )}

                {profileNote !== null && (
                  <div
                    className="mform-row"
                    data-testid="uccnc-profile-imported-note"
                    style={{ fontSize: 'var(--font-size-sm)' }}
                  >
                    {profileNote}
                  </div>
                )}

                {/* The config write is a REQUEST and this sentence says so. It
                    is separate from the record note above because they are two
                    separate facts and either can succeed without the other. */}
                {requestSentence !== '' && requestOutcome !== null && (
                  <div
                    className="mform-row"
                    data-testid="uccnc-profile-request-note"
                    data-request-state={requestState}
                    /* THE PROFILE THIS RESULT IS ABOUT, on the element itself.
                       Not the selection - the request's own path. A report
                       that cannot name what it is about is a report that can
                       be read against the wrong thing. */
                    data-profile-path={requestOutcome.path}
                    style={{ fontSize: 'var(--font-size-sm)' }}
                  >
                    {requestSentence}
                  </div>
                )}

                {profilePreview !== null && (
                  <div
                    className="profile-preview-summary"
                    data-testid="uccnc-profile-preview-summary"
                  >
                    <span>{describeProfilePreviewSummary(profilePreview.preview)}</span>
                    <button
                      type="button"
                      className="machine-list-btn"
                      data-testid="uccnc-profile-open-preview"
                      onClick={() => setProfilePreviewOpen(true)}
                    >{words("MachineLibraryModal.open_preview")}</button>
                  </div>
                )}

                </DisclosureSection>}

                {/* Notes (clutter P7): first line as the summary */}
                <DisclosureSection
                  title={words("MachineLibraryModal.notes")}
                  summary={notesSummary}
                  testId="disclosure-machine-notes"
                >
                <textarea
                  className="mform-textarea"
                  value={draft.notes}
                  rows={3}
                  onChange={(e) => patch({ notes: e.target.value })}
                  placeholder={words("MachineLibraryModal.machine_notes_limits_special_requirements")}
                />
                </DisclosureSection>
              </div>
            )}
          </div>
          }
        />

        {/* Footer */}
        <div className="modal-footer machine-modal-footer">
          <div className="machine-footer-left">
            {draft && (
              <>
                <button className="modal-btn modal-btn-danger" onClick={handleDelete} data-tooltip={words("MachineLibraryModal.delete_machine")}>
                  <Trash2 size={12} />{words("MachineLibraryModal.delete")}</button>
                <button className="modal-btn modal-btn-ghost" onClick={handleExportSelected} data-tooltip={words("MachineLibraryModal.export_this_machine")}>
                  <Download size={12} />{words("MachineLibraryModal.export")}</button>
                {canExportPro && (
                  <button
                    className="modal-btn modal-btn-ghost"
                    onClick={handleExportPro}
                    data-testid="machine-export-pro"
                    data-tooltip={words("MachineLibraryModal.write_this_machine_as_a_uccnc_pro")}
                  >
                    <Download size={12} />{words("MachineLibraryModal.export_pro")}</button>
                )}
              </>
            )}
          </div>
          <div className="machine-footer-right">
            {draft && (
              <button
                className={`modal-btn ${isDirty ? 'modal-btn-primary' : 'modal-btn-ghost'}`}
                onClick={commitDraft}
                data-tooltip={isDirty ? words("MachineLibraryModal.save_changes_to_library") : words("MachineLibraryModal.no_unsaved_changes")}
              >
                {saved ? <><Check size={12} />{words("MachineLibraryModal.saved")}</> : words("MachineLibraryModal.save_changes")}
              </button>
            )}
            {draft && (
              <button
                className={`modal-btn ${isDefaultMachine ? 'modal-btn-ghost' : 'modal-btn-ghost'}`}
                onClick={handleSetDefault}
                disabled={isDefaultMachine}
                data-tooltip={isDefaultMachine ? words("MachineLibraryModal.already_the_default_for_new_projects") : words("MachineLibraryModal.use_this_machine_for_new_projects")}
              >
                {isDefaultMachine ? <><Star size={12} />{words("MachineLibraryModal.default")}</> : <><Star size={12} />{words("MachineLibraryModal.set_as_default")}</>}
              </button>
            )}
            {draft && (
              <button
                className={`modal-btn ${isProjectMachine ? 'modal-btn-ghost' : 'modal-btn-primary'}`}
                onClick={handleUseForProject}
              >
                {isProjectMachine ? words("MachineLibraryModal.active_machine") : words("MachineLibraryModal.use_for_this_project")}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
