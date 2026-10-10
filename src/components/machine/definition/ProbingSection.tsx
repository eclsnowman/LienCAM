import { type SettingSource } from './DefinitionFields'
import { NotSent } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { emptyMarked } from './DefinitionFields'
import { rowEmptyMarked } from './DefinitionFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'
import type { ProbeCalibration } from '../../../types'
import { describeProbeCalibration } from '../../../lib/machine/probeCalibration'


/** UCCNC's probe-screen record. These values overlap conceptually with the
 * CAM-side `MachineConfig.probing` defaults, but they are not a second source
 * for those defaults: one machine record carries both views, and nothing reads
 * a `[Probing]` key back out. Keeping the raw controller values under the
 * controller's own names preserves the machine's facts without silently
 * changing the probe motion LienCAM will command. */
export function ProbingNotSent({ label, settingKey, settings }: {
  label: string
  settingKey: string
  settings: SettingSource
}) {
  return (
    <NotSent
      label={label}
      settings={settings}
      settingKey={`Probing.${settingKey}`}
    />
  )
}

export const PROBING_ROUTINE_FIELDS = [
  ['active mode', 'Mode'],
  ['tool setter', 'Tool'],
  ['single surface', 'Simple'],
  ['angle', 'Angle'],
  ['pocket', 'Pocket'],
  ['outside edge', 'Outer'],
  ['inside corner', 'InnerCorner'],
  ['outside corner', 'OuterCorner'],
  ['inside rectangle', 'RectInner'],
  ['inside circle', 'CircleInner'],
  ['outside rectangle', 'RectOuter'],
  ['outside circle', 'CircleOuter'],
] as const

export const PROBING_MOTION_FIELDS = [
  ['gage height', 'GageHeight'],
  ['fine distance', 'FineDistance'],
  ['retract', 'Retract'],
  ['fast feed', 'FastFeed'],
  ['fine feed', 'FineFeed'],
] as const

export const PROBING_BEHAVIOR_FIELDS = [
  ['zero probed axis', 'ZeroProbedAxis'],
  ['zero all offsets', 'ZeroOnAllOffsets'],
  ['single-probe mode', 'SingleProbeMode'],
  ['retract enabled', 'EnableRetract'],
  ['pause before probe', 'PauseBeforeProbe'],
  ['manual-probe mode', 'ManualProbeMode'],
] as const

export const PROBING_SAVED_MODE_FIELDS = [
  ['tool setter', 'Set_ToolProbe'],
  ['single surface', 'Set_SimpleProbe'],
  ['angle', 'Set_AngleProbe'],
  ['pocket', 'Set_PocketProbe'],
  ['outside edge', 'Set_OuterProbe'],
  ['inside corner', 'Set_InnerCornerProbe'],
  ['outside corner', 'Set_OuterCornerProbe'],
  ['inside rectangle', 'Set_RectInnerProbe'],
  ['inside circle', 'Set_CircleInnerProbe'],
  ['outside rectangle', 'Set_RectOuterProbe'],
  ['outside circle', 'Set_CircleOuterProbe'],
] as const

export const PROBING_SAFE_POSITION_FIELDS = [
  ['safe X', 'SafeX'],
  ['safe X positive', 'SafeXPositive'],
  ['safe Y', 'SafeY'],
  ['safe Y positive', 'SafeYPositive'],
  ['safe Z', 'SafeZ'],
  ['safe Z positive', 'SafeZPositive'],
] as const

export const PROBING_STORAGE_FIELDS = [
  ['save mobile probe position', 'SaveMobileProbePos'],
  ['save workpiece references', 'SaveWpReferences'],
  ['override probe diameter', 'OverrideProbeDia'],
  ['probe diameter override', 'ProbeDiameterOvr'],
  ['limit traverse speed', 'LimitTraverseSpeed'],
  ['traverse speed limit', 'TraverseSpeedLimit'],
  ['separate settings per mode', 'SeparateSettingsPerMode'],
  ['info window position', 'InfoWindowPos'],
] as const

export const PROBING_BLOWER_FIELDS = [
  ['command', 'Blower'],
  ['port', 'BlowerPort'],
  ['pin', 'BlowerPin'],
  ['active low', 'BlowerActiveLow'],
] as const

export const PROBING_POSITION_ROWS = [
  ['Fixed', 'FixedProbePos'],
  ['Mobile', 'MobileProbePos'],
] as const

export const PROBING_AXIS_COUNT_ROWS = [1, 2] as const

/**
 * The installed probe's own facts (WO-1817): tip diameter and runout, each
 * with provenance and date, or a named UNCALIBRATED state when neither has
 * ever been stated or measured. This is a DIFFERENT record from the UCCNC
 * `Probing.*` catalogue the rest of this file shows - it is LienCAM's own
 * probe-routine motion fact, `MachineConfig.probeCalibration`, read through
 * `describeProbeCalibration` so a probing screen and this panel can never
 * disagree on what "uncalibrated" or "stale" mean.
 */
export function ProbeCalibrationStatus({ calibration }: { calibration: ProbeCalibration | undefined }) {
  const summary = describeProbeCalibration(calibration)
  return (
    <div data-testid="machine-def-panel-probing-calibration" style={{ marginTop: 12 }}>
      <SectionHead
        title="Probe calibration"
        summary="Tip diameter and runout - stated or measured, never assumed"
        testId="machine-def-panel-head-probing-calibration"
      />
      <div
        data-testid="machine-def-panel-probing-calibration-state"
        data-calibration-state={summary.state}
        style={{
          fontSize: 'var(--font-size-sm)',
          color: summary.state === 'uncalibrated' ? 'var(--warning)' : 'var(--text-secondary)',
          fontWeight: summary.state === 'uncalibrated' ? 600 : 400,
          marginBottom: 6,
        }}
      >
        {summary.label}
      </div>
      {summary.tipDiameterMm != null && (
        <div data-testid="machine-def-panel-probing-calibration-tip-diameter" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          Tip diameter: {summary.tipDiameterMm} mm (radius {summary.tipRadiusMm} mm), {summary.tipDiameterProvenance} {summary.tipDiameterDate}
          {summary.tipDiameterStale ? ' - STALE' : ''}
        </div>
      )}
      {summary.runoutMm != null && (
        <div data-testid="machine-def-panel-probing-calibration-runout" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          Runout: {summary.runoutMm} mm, {summary.runoutProvenance} {summary.runoutDate}
          {summary.runoutStale ? ' - STALE' : ''}
        </div>
      )}
      {summary.state === 'uncalibrated' && (
        <div
          data-testid="machine-def-panel-probing-calibration-warning"
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--warning)', marginTop: 4 }}
        >
          No tip diameter has been stated or measured for this probe. Bore, boss and corner results carry
          no tip radius compensation until one is recorded.
        </div>
      )}
    </div>
  )
}

type ProbingSectionProps = Pick<MachineDefinitionPanelState, 'unsent'> & {
  /** Optional: absent for callers that have not wired this record through
   *  yet. Never defaulted to an empty calibration object here - that would
   *  be indistinguishable from a machine that stated one. */
  probeCalibration?: ProbeCalibration
}

export function ProbingSection({ unsent, probeCalibration }: ProbingSectionProps) {
  return (
    <><div data-testid="machine-def-group-probing" style={{ marginTop: 12 }}>
                  <SectionHead
                    title="Controller probing"
                    summary="Probe-screen modes, motion, recipes, safe positions and stored locations"
                    testId="machine-def-panel-head-probing"
                  />
                  <ProbeCalibrationStatus calibration={probeCalibration} />
                  <div
                    data-testid="machine-def-panel-probing-boundary"
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
                  >
                    These are this controller profile's probe-screen values. LienCAM's CAM probing
                    defaults remain the separate machine motion record used by probe routines.
                  </div>

                  <div data-testid="machine-def-panel-probing-routines">
                    <SectionHead
                      title="Modes and geometry"
                      summary="The active probe mode and each mode's saved geometry"
                      testId="machine-def-panel-probing-head-routines"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-routines-none"
                      settings={unsent}
                      keys={sectionKeys(PROBING_ROUTINE_FIELDS, 'Probing')}
                      noun="probe mode settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(PROBING_ROUTINE_FIELDS, 'Probing'))}
                    >
                      {PROBING_ROUTINE_FIELDS.map(([label, key]) => (
                        <ProbingNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>

                  <div data-testid="machine-def-panel-probing-cycle" style={{ marginTop: 12 }}>
                    <SectionHead
                      title="Touch cycle"
                      summary="Controller feeds, distances, zeroing and contact counting"
                      testId="machine-def-panel-probing-head-cycle"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-cycle-none"
                      settings={unsent}
                      keys={[
                        ...sectionKeys(PROBING_MOTION_FIELDS, 'Probing'),
                        ...sectionKeys(PROBING_BEHAVIOR_FIELDS, 'Probing'),
                        ...PROBING_AXIS_COUNT_ROWS.flatMap((axis) => (
                          ['Gage', 'Dia'].map((kind) => `Probing.Axis${axis}Count${kind}`)
                        )),
                      ]}
                      noun="touch cycle settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                        gap: '5px 16px', marginBottom: 8,
                      }}
                      {...emptyMarked(unsent, [
                        ...sectionKeys(PROBING_MOTION_FIELDS, 'Probing'),
                        ...sectionKeys(PROBING_BEHAVIOR_FIELDS, 'Probing'),
                      ])}
                    >
                      {[...PROBING_MOTION_FIELDS, ...PROBING_BEHAVIOR_FIELDS].map(([label, key]) => (
                        <ProbingNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                      <table
                        className="mform-axis-table"
                        data-testid="machine-def-panel-probing-axis-count-table"
                        style={{ width: 'max-content', minWidth: 360 }}
                        {...emptyMarked(unsent, PROBING_AXIS_COUNT_ROWS.flatMap((axis) => (
                          ['Gage', 'Dia'].map((kind) => `Probing.Axis${axis}Count${kind}`)
                        )))}
                      >
                        <thead><tr><th>Axis</th><th>count gage</th><th>count diameter</th></tr></thead>
                        <tbody>
                          {PROBING_AXIS_COUNT_ROWS.map((axis) => (
                            <tr
                              key={axis}
                              data-testid={`machine-def-panel-probing-axis-count-${axis}`}
                              {...rowEmptyMarked(unsent, ['Gage', 'Dia']
                                .map((kind) => `Probing.Axis${axis}Count${kind}`))}
                            >
                              <td>{axis}</td>
                              {['Gage', 'Dia'].map((kind) => (
                                <td key={kind}>
                                  <ProbingNotSent
                                    label="" settingKey={`Axis${axis}Count${kind}`} settings={unsent}
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div data-testid="machine-def-panel-probing-recipes" style={{ marginTop: 12 }}>
                    <SectionHead
                      title="Saved mode recipes"
                      summary="Controller-encoded settings retained verbatim for each probe mode"
                      testId="machine-def-panel-probing-head-recipes"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-recipes-none"
                      settings={unsent}
                      keys={sectionKeys(PROBING_SAVED_MODE_FIELDS, 'Probing')}
                      noun="saved recipes"
                    />
                    <div
                      style={{ display: 'grid', gap: 5 }}
                      {...emptyMarked(unsent, sectionKeys(PROBING_SAVED_MODE_FIELDS, 'Probing'))}
                    >
                      {PROBING_SAVED_MODE_FIELDS.map(([label, key]) => (
                        <ProbingNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>

                  <div data-testid="machine-def-panel-probing-positions" style={{ marginTop: 12 }}>
                    <SectionHead
                      title="Safe and stored positions"
                      summary="Safe coordinates, retained probe locations and controller display state"
                      testId="machine-def-panel-probing-head-positions"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-positions-none"
                      settings={unsent}
                      keys={[
                        ...sectionKeys(PROBING_SAFE_POSITION_FIELDS, 'Probing'),
                        ...sectionKeys(PROBING_STORAGE_FIELDS, 'Probing'),
                        ...PROBING_POSITION_ROWS.map(([, key]) => `Probing.${key}`),
                      ]}
                      noun="position settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '5px 16px', marginBottom: 8,
                      }}
                      {...emptyMarked(unsent, [
                        ...sectionKeys(PROBING_SAFE_POSITION_FIELDS, 'Probing'),
                        ...sectionKeys(PROBING_STORAGE_FIELDS, 'Probing'),
                      ])}
                    >
                      {[...PROBING_SAFE_POSITION_FIELDS, ...PROBING_STORAGE_FIELDS].map(([label, key]) => (
                        <ProbingNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                      <table
                        className="mform-axis-table"
                        data-testid="machine-def-panel-probing-position-table"
                        style={{ width: 'max-content', minWidth: '100%' }}
                        {...emptyMarked(unsent, PROBING_POSITION_ROWS.map(([, key]) => `Probing.${key}`))}
                      >
                        <thead><tr><th>Probe location</th><th>controller record</th></tr></thead>
                        <tbody>
                          {PROBING_POSITION_ROWS.map(([label, key]) => (
                            <tr
                              key={key}
                              data-testid={`machine-def-panel-probing-position-${label.toLowerCase()}`}
                              {...rowEmptyMarked(unsent, [`Probing.${key}`])}
                            >
                              <td>{label}</td>
                              <td>
                                <ProbingNotSent
                                  label="" settingKey={key} settings={unsent}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div data-testid="machine-def-panel-probing-blower" style={{ marginTop: 12 }}>
                    <SectionHead
                      title="Probe blower"
                      summary="Cleaning output and its pin assignment"
                      testId="machine-def-panel-probing-head-blower"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-blower-none"
                      settings={unsent}
                      keys={sectionKeys(PROBING_BLOWER_FIELDS, 'Probing')}
                      noun="blower settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(PROBING_BLOWER_FIELDS, 'Probing'))}
                    >
                      {PROBING_BLOWER_FIELDS.map(([label, key]) => (
                        <ProbingNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>
                </div></>
  )
}

