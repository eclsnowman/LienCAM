import { textFor, useText as useShellText } from '../../i18n'
import { Settings as SettingsIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { type UiScalePreference, useUiPrefs } from '../../store/uiPrefs'
import { NumericInput } from '../ui/NumericInput'
import { ThemedListbox } from '../ui/ThemedListbox'
import { unitLabel } from '../../lib/ui/unitFormat'
import { homeBackOffProvenance, NAV_PRESETS } from '../../types'
import type { NavPresetId, Units, BrepTessellationQuality, SimulationEngine } from '../../types'
import { APP_VERSION, GIT_COMMIT_LABEL, GIT_BRANCH, BUILD_DATE } from '../../version'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../../store/migrations/projectMigrations'
import { UI_THEME_IDS, UI_THEME_LABELS, type UiThemeId } from '../../theme/uiTheme'
import { AVAILABLE_LANGUAGES, languageName, useText } from '../../i18n'
import { UserDataStoragePanel } from './UserDataStoragePanel'
import { writeGrblSettingAndReadBack } from '../../lib/machine/machineSession'
import { controllerSurface } from '../../lib/machine/controllerSurface'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { axisSoftLimitsAreStated } from '../../lib/machine/resolvedMachineMotion'
import { cloneGrblSettings } from '../../lib/machine/grbl/settings'
import { isGrblFamily } from '../../lib/machine/machineChoice'
import type { AxisName, MachineConfig } from '../../types'

const shellText = textFor('app-shell-settings-menus')

const PROJECTION_TOLERANCE_PRESETS = {
  draft: 0.1,
  standard: 0.02,
  fine: 0.005,
} as const

type ProjectionTolerancePreset = keyof typeof PROJECTION_TOLERANCE_PRESETS | 'custom'

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

function isSafeSettingsEnterTarget(
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

// Application Settings modal (global app preferences — NOT project data).
//
// Built to GROW: the body is a list of `mform-section`s, each a titled group of
// rows. It ships with exactly one section (STL projection) holding one field;
// new global prefs slot in as additional sections/rows without restructuring.
//
// Mirrors the SetupModal shell: modal-backdrop -> modal-container -> header
// (icon + title + close) / body / footer, self-gated on activeModal so it can
// be mounted unconditionally in App.tsx alongside the other modals.
/**
 * WO-1642: WHICH LIMITS DID THIS MACHINE STATE - asked of the machine, in its
 * own controller's words, never in one controller's key names. Soft limits go
 * through the motion resolver's own test (the app's keys for any controller,
 * UCCNC's keys for a UCCNC import); a GRBL machine states them with its
 * $130-$132 travel and its back-off with $27, which is what its import read.
 */
const GRBL_AXIS_OFFSET: Partial<Record<AxisName, number>> = { X: 0, Y: 1, Z: 2 }

function grblStates(machine: MachineConfig, id: number): boolean {
  if (!isGrblFamily(machine.controller)) return false
  const raw = cloneGrblSettings(machine)[id]
  return raw !== undefined && Number.isFinite(Number(raw)) && raw.trim() !== ''
}

function softLimitsAreStated(machine: MachineConfig, axis: AxisName): boolean {
  if (axisSoftLimitsAreStated(machine, axis)) return true
  const offset = GRBL_AXIS_OFFSET[axis]
  return offset !== undefined && grblStates(machine, 130 + offset)
}

function backOffIsStated(machine: MachineConfig, axis: AxisName): boolean {
  // WO-1731: the app-owned question - did THIS machine state its back-off,
  // asked of the definition under the machine's own controller (the UCCNC
  // profile's key is resolved inside as the import alias it is). The GRBL
  // $27 feeder stays: that is this machine's own controller saying it.
  if (homeBackOffProvenance(machine.controllerDefinition, axis, machine.controller) === 'machine') return true
  return GRBL_AXIS_OFFSET[axis] !== undefined && grblStates(machine, 27)
}

export function SettingsModal() {
  useShellText('app-shell-settings-menus')
  const activeModal = useCamStore((s) => s.activeModal)
  const closeModal  = useCamStore((s) => s.closeModal)
  const projectionToleranceDefault = useCamStore((s) => s.appSettings.projectionToleranceDefault)
  const setProjectionToleranceDefault = useCamStore((s) => s.setProjectionToleranceDefault)
  const navPreset      = useCamStore((s) => s.appSettings.navPreset)
  const invertZoom     = useCamStore((s) => s.appSettings.invertZoom)
  const invertPan      = useCamStore((s) => s.appSettings.invertPan)
  const setNavPreset   = useCamStore((s) => s.setNavPreset)
  const setInvertZoom  = useCamStore((s) => s.setInvertZoom)
  const setInvertPan   = useCamStore((s) => s.setInvertPan)
  const displayUnits   = useCamStore((s) => s.appSettings.displayUnits)
  const exportUnits    = useCamStore((s) => s.appSettings.exportUnits)
  const setDisplayUnits = useCamStore((s) => s.setDisplayUnits)
  const setExportUnits  = useCamStore((s) => s.setExportUnits)
  const defaultStockThicknessMm = useCamStore((s) => s.appSettings.defaultStockThicknessMm)
  const defaultStockPaddingXYMm = useCamStore((s) => s.appSettings.defaultStockPaddingXYMm)
  const setDefaultStockThickness = useCamStore((s) => s.setDefaultStockThickness)
  const setDefaultStockPadding   = useCamStore((s) => s.setDefaultStockPadding)
  const brepTessellationQuality    = useCamStore((s) => s.appSettings.brepTessellationQuality)
  const setBrepTessellationQuality = useCamStore((s) => s.setBrepTessellationQuality)
  const simulationEngine    = useCamStore((s) => s.appSettings.simulationEngine)
  const setSimulationEngine = useCamStore((s) => s.setSimulationEngine)
  const showSplash     = useCamStore((s) => s.appSettings.showSplash)
  const setShowSplash  = useCamStore((s) => s.setShowSplash)
  const uiTheme    = useUiPrefs((s) => s.uiTheme)
  const setUiTheme = useUiPrefs((s) => s.setUiTheme)
  // WO-1904: the ONE remembered DXF-import choice both import routes read.
  const dxfKeepOrigin    = useUiPrefs((s) => s.dxfKeepOrigin)
  const setDxfKeepOrigin = useUiPrefs((s) => s.setDxfKeepOrigin)
  const uiScale    = useUiPrefs((s) => s.uiScale)
  const setUiScale = useUiPrefs((s) => s.setUiScale)
  const uiColorMode = useUiPrefs((s) => s.uiColorMode)
  const setUiColorMode = useUiPrefs((s) => s.setUiColorMode)
  const language = useUiPrefs((s) => s.language)
  const setLanguage = useUiPrefs((s) => s.setLanguage)
  const languageText = useText('language')
  const machine = useCamStore((s) => s.project.machine)
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const surface = controllerSurface(machine)
  const grblSettings = useMachineControl((s) => s.settings)
  const [grblDrafts, setGrblDrafts] = useState<Record<number, string>>({})
  const [grblWriteKey, setGrblWriteKey] = useState<number | null>(null)
  const [grblWriteStatus, setGrblWriteStatus] = useState<string | null>(null)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  const isOpen = activeModal === 'settings'

  useEffect(() => {
    if (!isOpen) return

    const onKey = (event: KeyboardEvent): void => {
      // Child controls get first refusal, and IME confirmation must never close
      // the live-applied settings surface.
      if (
        event.defaultPrevented
        || event.isComposing
        || event.keyCode === 229
        || event.key === 'Process'
      ) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeModal()
        return
      }
      if (event.key !== 'Enter') return

      const panel = document.querySelector<HTMLElement>('[data-testid="settings-modal-panel"]')
      if (!isSafeSettingsEnterTarget(event.target, panel)) return

      event.preventDefault()
      event.stopImmediatePropagation()
      closeModal()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeModal, isOpen])

  if (!isOpen) return null

  const grblSettingRows = Object.entries(grblSettings)
    .map(([key, value]) => [Number(key), value] as const)
    .sort(([a], [b]) => a - b)
  const definition = machine?.controllerDefinition
  const homingBackOff = definition
    ? definition.homing.order
      .map((axis) => {
        const value = definition.homing.perAxis[axis]?.backOff
        return value === undefined || !backOffIsStated(machine, axis)
          ? shellText('SettingsModal.notStated', { axis: axis })
          : `${axis} ${value}`
      })
      .join(', ')
    : shellText('SettingsModal.notConfiguredInThisMachineDefinition')
  const softLimits = definition
    ? definition.axes
      .filter((axis) => axis.enabled)
      .map((axis) => softLimitsAreStated(machine, axis.axis)
        ? `${axis.axis} ${axis.softLimitMin}..${axis.softLimitMax}`
        : shellText('SettingsModal.notStatedNotStated', { axis: axis.axis }))
      .join(', ')
    : shellText('SettingsModal.notConfiguredInThisMachineDefinition')
  const softwareCapabilityRows = [
    [shellText('SettingsModal.homingOrderBackOff'), definition
      ? shellText('SettingsModal.backOff', { value: definition.homing.order.join(' -> '), homingBackOff: homingBackOff })
      : homingBackOff],
    [shellText('SettingsModal.probingRoutines'), machine?.probing
      ? shellText('SettingsModal.machineProbingDefaultsConfigured')
      : shellText('SettingsModal.lienCAMRoutineLibraryMachineDefaultsNotConfigured')],
    [shellText('SettingsModal.coolantVacuumMCodeRelays'), shellText('SettingsModal.machineActionsAndMCodeOverrides')],
    [shellText('SettingsModal.perAxisSoftLimits'), softLimits],
    [shellText('SettingsModal.spindleRamps'), shellText('SettingsModal.notConfiguredInThisMachineDefinition')],
  ] as const

  const submitGrblSetting = async (key: number): Promise<void> => {
    if (grblWriteKey !== null) return
    const attempted = grblDrafts[key] ?? grblSettings[key]
    setGrblWriteKey(key)
    setGrblWriteStatus(`Writing $${key}; waiting for the controller re-read.`)
    const result = await writeGrblSettingAndReadBack(key, attempted)
    if (result.ok) {
      setGrblDrafts((current) => ({ ...current, [key]: result.value }))
      setGrblWriteStatus(`Controller read back $${key}=${result.value}.`)
    } else {
      const reported = useMachineControl.getState().settings[key]
      setGrblDrafts((current) => ({ ...current, [key]: reported }))
      setGrblWriteStatus(`Refused: ${result.reason}`)
    }
    setGrblWriteKey(null)
  }

  const projectionTolerancePreset: ProjectionTolerancePreset =
    (Object.entries(PROJECTION_TOLERANCE_PRESETS) as [keyof typeof PROJECTION_TOLERANCE_PRESETS, number][])
      .find(([, value]) => Math.abs(value - projectionToleranceDefault) < 1e-9)?.[0] ?? 'custom'

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div
      className="modal-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal() }}
    >
      <div
        className="modal-container settings-modal"
        data-testid="settings-modal-panel"
        style={{ width: 'min(40rem, calc(100vw - 2rem))' }}
        ref={dialogFocusRef}
      >
        {/* Header */}
        <div className="modal-header">
          <SettingsIcon size={14} className="modal-header-icon" />
          <span className="modal-title">{shellText('SettingsModal.settings')}</span>
          <button className="modal-close-btn" onClick={closeModal}><X size={14} /></button>
        </div>

        {/* Body — a growable list of preference sections */}
        <div className="modal-body">
          <div className="mform-section-header">{shellText('SettingsModal.sTLProjection')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.qualityPreset')}</label>
            <ThemedListbox
              testId="settings-projection-tolerance-preset"
              ariaLabel={shellText('SettingsModal.qualityPreset')}
              value={projectionTolerancePreset}
              options={[
                { value: 'draft', label: shellText('SettingsModal.draft') },
                { value: 'standard', label: shellText('SettingsModal.standard') },
                { value: 'fine', label: shellText('SettingsModal.fine') },
                { value: 'custom', label: shellText('SettingsModal.custom') },
              ]}
              onChange={(v) => {
                const preset = v as ProjectionTolerancePreset
                if (preset !== 'custom') {
                  setProjectionToleranceDefault(PROJECTION_TOLERANCE_PRESETS[preset])
                }
              }}
            />
          </div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.sTLProjectionTolerance', { value: unitLabel(displayUnits) })}</label>
            <NumericInput
              className="mform-input mform-input-mono"
              value={projectionToleranceDefault}
              min={0.005} max={2} step={0.005}
              units={displayUnits}
              onChange={(v) => setProjectionToleranceDefault(v)}
            />
          </div>

          <div className="mform-section-header">{shellText('SettingsModal.units')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.displayUnits')}</label>
            <ThemedListbox
              testId="settings-display-units"
              ariaLabel={shellText('SettingsModal.displayUnits')}
              value={displayUnits}
              options={[
                { value: 'mm', label: 'mm' },
                { value: 'inch', label: 'in' },
              ]}
              onChange={(v) => setDisplayUnits(v as Units)}
            />
          </div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.exportUnits')}</label>
            <ThemedListbox
              testId="settings-export-units"
              ariaLabel={shellText('SettingsModal.exportUnits')}
              value={exportUnits}
              options={[
                { value: 'mm', label: 'mm' },
                { value: 'inch', label: 'in' },
              ]}
              onChange={(v) => setExportUnits(v as Units)}
            />
          </div>

          {/* WO-1904: where the existing import choices live - next to the unit
              preferences the DXF importer already honours (ADR-0022 reads the
              file's $INSUNITS; this is the operator's standing choice). ONE
              control, remembered across imports and reloads; both the DesignTree
              and sketcher DXF imports read it. Default off = today's re-centre. */}
          <div className="mform-section-header">{shellText('SettingsModal.dXFImport')}</div>

          <div className="mform-row">
            <label className="op-check-label">
              <input
                type="checkbox"
                data-testid="settings-dxf-keep-origin"
                checked={dxfKeepOrigin}
                onChange={(e) => setDxfKeepOrigin(e.target.checked)}
              />
              <span>{shellText('SettingsModal.keepDrawingOrigin')}</span>
            </label>
          </div>

          <div className="mform-section-header">{shellText('SettingsModal.nesting')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.defaultStockThicknessZ', { value: unitLabel(displayUnits) })}</label>
            <NumericInput
              className="mform-input mform-input-mono"
              value={defaultStockThicknessMm}
              min={0.001} step={1}
              units={displayUnits}
              onChange={(v) => setDefaultStockThickness(v)}
            />
          </div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.defaultStockPaddingXY', { value: unitLabel(displayUnits) })}</label>
            <NumericInput
              className="mform-input mform-input-mono"
              value={defaultStockPaddingXYMm}
              min={0} step={1}
              units={displayUnits}
              onChange={(v) => setDefaultStockPadding(v)}
            />
          </div>

          <div className="mform-section-header">{shellText('SettingsModal.navigation')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.mouseScheme')}</label>
            <ThemedListbox
              testId="settings-nav-preset"
              ariaLabel={shellText('SettingsModal.mouseScheme')}
              value={navPreset}
              options={(Object.keys(NAV_PRESETS) as NavPresetId[]).map((id) => ({
                value: id,
                label: navigationLabel(NAV_PRESETS[id].label),
              }))}
              onChange={(v) => setNavPreset(v as NavPresetId)}
            />
          </div>

          <div className="mform-row">
            <label className="op-check-label">
              <input
                type="checkbox"
                checked={invertZoom}
                onChange={(e) => setInvertZoom(e.target.checked)}
              />
              <span>{shellText('SettingsModal.invertZoomDirection')}</span>
            </label>
          </div>

          <div className="mform-row">
            <label className="op-check-label">
              <input
                type="checkbox"
                checked={invertPan}
                onChange={(e) => setInvertPan(e.target.checked)}
              />
              <span>{shellText('SettingsModal.invertPanDirection')}</span>
            </label>
          </div>

          {/* WO-270 (Operator ruling 2026-08-12: "We need brand identity, not a free for
              all"): the UI theme, Viewport theme and Selection glow selectors
              stood here. All three were removed, and so was the "Display"
              section header that held them. WO-324 brings back exactly ONE of
              them -- Operator is now actively evaluating the amber palette and
              asked for a control so he can drive it before deciding; Viewport
              theme and Selection glow are NOT restored, and this is not a
              return to the old free-for-all: exactly two options, no third. */}
          <div className="mform-section-header">{shellText('SettingsModal.theme')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.appearance')}</label>
            <ThemedListbox
              testId="settings-theme"
              ariaLabel={shellText('SettingsModal.theme')}
              value={uiTheme}
              options={UI_THEME_IDS.map((id) => ({ value: id, label: themeLabel(UI_THEME_LABELS[id]) }))}
              onChange={(v) => setUiTheme(v as UiThemeId)}
            />
          </div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.interfaceScale')}</label>
            <ThemedListbox
              testId="settings-interface-scale"
              ariaLabel={shellText('SettingsModal.interfaceScale')}
              value={String(uiScale)}
              options={[
                { value: 'auto', label: shellText('SettingsModal.auto') },
                { value: '0.8', label: shellText('SettingsModal.text80') },
                { value: '0.9', label: shellText('SettingsModal.text90') },
                { value: '1', label: shellText('SettingsModal.text100') },
                { value: '1.25', label: shellText('SettingsModal.text125') },
                { value: '1.5', label: shellText('SettingsModal.text150') },
              ]}
              onChange={(value) => setUiScale(value === 'auto' ? 'auto' : Number(value) as UiScalePreference)}
            />
          </div>

          <div className="mform-row">
            <label className="op-check-label">
              <input
                data-testid="settings-light-mode"
                type="checkbox"
                checked={uiColorMode === 'light'}
                onChange={(e) => setUiColorMode(e.target.checked ? 'light' : 'dark')}
              />
              <span>{shellText('SettingsModal.lightMode')}</span>
            </label>
          </div>

          {/* WO-2319: lists exactly the languages that have a catalog under
              src/i18n/locales/ (English only until a pilot language lands). */}
          <div className="mform-section-header" data-testid="settings-language-header">{languageText('section')}</div>

          <div className="mform-row" data-testid="settings-language-row">
            <label className="mform-label">{languageText('label')}</label>
            <ThemedListbox
              testId="settings-language"
              ariaLabel={languageText('label')}
              value={language}
              options={AVAILABLE_LANGUAGES.map((code) => ({ value: code, label: languageName(code) }))}
              onChange={setLanguage}
            />
          </div>

          <div className="mform-section-header">{shellText('SettingsModal.performance')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.modelRenderFidelity')}</label>
            <ThemedListbox
              testId="settings-brep-quality"
              ariaLabel={shellText('SettingsModal.modelRenderFidelity')}
              value={brepTessellationQuality}
              options={[
                { value: 'performance', label: shellText('SettingsModal.performance') },
                { value: 'balanced', label: shellText('SettingsModal.balanced') },
                { value: 'high', label: shellText('SettingsModal.high') },
              ]}
              onChange={(v) => setBrepTessellationQuality(v as BrepTessellationQuality)}
            />
          </div>

          <div className="mform-section-header">{shellText('SettingsModal.stockSimulation')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.simulationEngine')}</label>
            <ThemedListbox
              testId="settings-sim-engine"
              ariaLabel={shellText('SettingsModal.simulationEngine')}
              value={simulationEngine}
              options={[
                { value: 'auto', label: shellText('SettingsModal.auto3DFallsBackTo25D') },
                { value: 'voxel', label: shellText('SettingsModal.text3DSmoothTrueUndercuts') },
                { value: 'heightmap', label: shellText('SettingsModal.text25DFastLowEndGPUs') },
              ]}
              onChange={(v) => setSimulationEngine(v as SimulationEngine)}
            />
          </div>

          <div className="mform-section-header">{shellText('SettingsModal.startup')}</div>

          <div className="mform-row">
            <label className="op-check-label">
              <input
                type="checkbox"
                checked={showSplash}
                onChange={(e) => setShowSplash(e.target.checked)}
              />
              <span>{shellText('SettingsModal.showSplashScreenOnStartup')}</span>
            </label>
          </div>

          {/* WO-999. This is temporarily in the existing Settings surface
              because WO-998's Controller Setup serial body is still queued.
              Keep controller-owned `$` values and LienCAM-owned capabilities
              visibly separate: one goes over the wire, the other never does. */}
          {surface.grblSettings && connectionKind === 'serial' && (
            <>
              <div className="mform-section-header">{shellText('SettingsModal.gRBLControllerSettings')}</div>

              {grblSettingRows.length === 0 ? null : (
                <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                  <table
                    className="mform-axis-table"
                    data-testid="settings-grbl-table"
                    style={{ width: '100%' }}
                  >
                    <thead>
                      <tr>
                        <th>{shellText('SettingsModal.setting')}</th>
                        <th>{shellText('SettingsModal.reported')}</th>
                        <th>{shellText('SettingsModal.enforcedBy')}</th>
                        <th>{shellText('SettingsModal.edit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grblSettingRows.map(([key, reported]) => (
                        <tr key={key} data-testid={`settings-grbl-row-${key}`}>
                          <th scope="row">${key}</th>
                          <td data-testid={`settings-grbl-reported-${key}`}>{reported}</td>
                          <td>{shellText('SettingsModal.gRBLController')}</td>
                          <td>
                            <form
                              onSubmit={(event) => {
                                event.preventDefault()
                                void submitGrblSetting(key)
                              }}
                              style={{ display: 'flex', gap: 6 }}
                            >
                              <input
                                className="mform-input mform-input-mono"
                                aria-label={shellText('SettingsModal.editGRBLSetting', { key: key })}
                                value={grblDrafts[key] ?? reported}
                                disabled={grblWriteKey !== null}
                                onChange={(event) => setGrblDrafts((current) => ({
                                  ...current,
                                  [key]: event.target.value,
                                }))}
                                onKeyDown={(event) => {
                                  if (event.key !== 'Enter') return
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void submitGrblSetting(key)
                                }}
                                style={{ minWidth: 90 }}
                              />
                              <button
                                className="modal-btn modal-btn-ghost"
                                type="submit"
                                disabled={grblWriteKey !== null}
                              >{shellText('SettingsModal.apply')}</button>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {grblWriteStatus !== null && (
                <p className="mform-help" data-testid="settings-grbl-status" role="status">
                  {grblWriteStatus}
                </p>
              )}

              <div className="mform-section-header">{shellText('SettingsModal.softwareSideMachineCapabilities')}</div>
              <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                <table
                  className="mform-axis-table"
                  data-testid="settings-software-capabilities-table"
                  style={{ width: '100%' }}
                >
                  <thead>
                    <tr>
                      <th>{shellText('SettingsModal.capability')}</th>
                      <th>{shellText('SettingsModal.definition')}</th>
                      <th>{shellText('SettingsModal.enforcedBy')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {softwareCapabilityRows.map(([label, value]) => (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        <td>{value}</td>
                        <td>{shellText('SettingsModal.lienCAMSoftware')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="mform-section-header">{shellText('SettingsModal.userData')}</div>
          <UserDataStoragePanel />

          {/* About — static read-only version readout (no hooks; informational) */}
          <div className="mform-section-header">{shellText('SettingsModal.about')}</div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.appVersion')}</label>
            <span className="mform-value" data-testid="settings-app-version">{shellText('SettingsModal.lienCNC', { APP_VERSION: APP_VERSION })}</span>
          </div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.projectFileFormat')}</label>
            <span className="mform-value" data-testid="settings-schema-version">{shellText('SettingsModal.v', { CURRENT_PROJECT_SCHEMA_VERSION: CURRENT_PROJECT_SCHEMA_VERSION })}</span>
          </div>

          <div className="mform-row">
            <label className="mform-label">{shellText('SettingsModal.build')}</label>
            <span className="mform-value" data-testid="settings-build-info">
              {GIT_COMMIT_LABEL} ({GIT_BRANCH}, {BUILD_DATE})
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="modal-btn modal-btn-primary" onClick={closeModal}>{shellText('SettingsModal.done')}</button>
        </div>
      </div>
    </div>
  )
}

// The display model keeps English identifiers; the rendering boundary owns words.
function navigationLabel(value: string): string {
  switch(value) {
    case "LienCAM default (left-orbit)": return shellText('NavigationLabels.lienCAMDefaultLeftOrbit')
    case "Right-button orbit": return shellText('NavigationLabels.rightButtonOrbit')
    case "Orbit on middle button": return shellText('NavigationLabels.orbitOnMiddleButton')
    case "Middle-button pan + Shift orbit": return shellText('NavigationLabels.middleButtonPanShiftOrbit')
    case "Middle-button orbit + Ctrl pan": return shellText('NavigationLabels.middleButtonOrbitCtrlPan')
    case "Middle-button pan + Shift orbit + Ctrl zoom": return shellText('NavigationLabels.middleButtonPanShiftOrbitCtrlZoom')
    case "Middle-button orbit + Shift pan + Ctrl zoom": return shellText('NavigationLabels.middleButtonOrbitShiftPanCtrlZoom')
    default: return value
  }
}

// The display model keeps English identifiers; the rendering boundary owns words.
function themeLabel(value: string): string {
  switch(value) {
    case "Default": return shellText('ThemeLabels.default')
    case "Amber": return shellText('ThemeLabels.amber')
    default: return value
  }
}
