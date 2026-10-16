import { jsxTextValue } from '../../../i18n/locales/en/probing-screens'
import { textFor, useText } from '../../../i18n'
const probeText = textFor('probing-screens')

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
  useText('probing-screens')
  return (
    <NotSent
      label={label}
      settings={settings}
      settingKey={`Probing.${settingKey}`}
    />
  )
}

export const PROBING_ROUTINE_FIELDS = [
  [probeText('probingSection1'), 'Mode'],
  [probeText('probingSection2'), 'Tool'],
  [probeText('probingSection3'), 'Simple'],
  [probeText('probingSection4'), 'Angle'],
  [probeText('probingSection5'), 'Pocket'],
  [probeText('probingSection6'), 'Outer'],
  [probeText('probingSection7'), 'InnerCorner'],
  [probeText('probingSection9'), 'OuterCorner'],
  [probeText('probingSection11'), 'RectInner'],
  [probeText('probingSection13'), 'CircleInner'],
  [probeText('probingSection15'), 'RectOuter'],
  [probeText('probingSection17'), 'CircleOuter'],
] as const

export const PROBING_MOTION_FIELDS = [
  [probeText('probingSection19'), 'GageHeight'],
  [probeText('probingSection21'), 'FineDistance'],
  [probeText('probingSection23'), 'Retract'],
  [probeText('probingSection24'), 'FastFeed'],
  [probeText('probingSection26'), 'FineFeed'],
] as const

export const PROBING_BEHAVIOR_FIELDS = [
  [probeText('probingSection28'), 'ZeroProbedAxis'],
  [probeText('probingSection30'), 'ZeroOnAllOffsets'],
  [probeText('probingSection32'), 'SingleProbeMode'],
  [probeText('probingSection34'), 'EnableRetract'],
  [probeText('probingSection36'), 'PauseBeforeProbe'],
  [probeText('probingSection38'), 'ManualProbeMode'],
] as const

export const PROBING_SAVED_MODE_FIELDS = [
  [probeText('probingSection40'), 'Set_ToolProbe'],
  [probeText('probingSection42'), 'Set_SimpleProbe'],
  [probeText('probingSection44'), 'Set_AngleProbe'],
  [probeText('probingSection46'), 'Set_PocketProbe'],
  [probeText('probingSection48'), 'Set_OuterProbe'],
  [probeText('probingSection50'), 'Set_InnerCornerProbe'],
  [probeText('probingSection52'), 'Set_OuterCornerProbe'],
  [probeText('probingSection54'), 'Set_RectInnerProbe'],
  [probeText('probingSection56'), 'Set_CircleInnerProbe'],
  [probeText('probingSection58'), 'Set_RectOuterProbe'],
  [probeText('probingSection60'), 'Set_CircleOuterProbe'],
] as const

export const PROBING_SAFE_POSITION_FIELDS = [
  [probeText('probingSection62'), 'SafeX'],
  [probeText('probingSection64'), 'SafeXPositive'],
  [probeText('probingSection66'), 'SafeY'],
  [probeText('probingSection68'), 'SafeYPositive'],
  [probeText('probingSection70'), 'SafeZ'],
  [probeText('probingSection72'), 'SafeZPositive'],
] as const

export const PROBING_STORAGE_FIELDS = [
  [probeText('probingSection74'), 'SaveMobileProbePos'],
  [probeText('probingSection76'), 'SaveWpReferences'],
  [probeText('probingSection78'), 'OverrideProbeDia'],
  [probeText('probingSection80'), 'ProbeDiameterOvr'],
  [probeText('probingSection82'), 'LimitTraverseSpeed'],
  [probeText('probingSection84'), 'TraverseSpeedLimit'],
  [probeText('probingSection86'), 'SeparateSettingsPerMode'],
  [probeText('probingSection88'), 'InfoWindowPos'],
] as const

export const PROBING_BLOWER_FIELDS = [
  [probeText('probingSection90'), 'Blower'],
  [probeText('probingSection91'), 'BlowerPort'],
  [probeText('probingSection93'), 'BlowerPin'],
  [probeText('probingSection95'), 'BlowerActiveLow'],
] as const

export const PROBING_POSITION_ROWS = [
  [probeText('probingSection97'), 'FixedProbePos'],
  [probeText('probingSection99'), 'MobileProbePos'],
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
  useText('probing-screens')
  const summary = describeProbeCalibration(calibration)
  return (
    <div data-testid="machine-def-panel-probing-calibration" style={{ marginTop: 12 }}>
      <SectionHead
        title={probeText('probingSection101')}
        summary={probeText('probingSection102')}
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
        <div data-testid="machine-def-panel-probing-calibration-tip-diameter" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>{probeText('probingSection107', { value1: jsxTextValue(summary.tipDiameterMm), value2: jsxTextValue(summary.tipRadiusMm), value3: jsxTextValue(summary.tipDiameterProvenance), value4: jsxTextValue(summary.tipDiameterDate), value5: jsxTextValue(summary.tipDiameterStale ? probeText('probingSection106') : '') })}
        </div>
      )}
      {summary.runoutMm != null && (
        <div data-testid="machine-def-panel-probing-calibration-runout" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>{probeText('probingSection111', { value1: jsxTextValue(summary.runoutMm), value2: jsxTextValue(summary.runoutProvenance), value3: jsxTextValue(summary.runoutDate), value4: jsxTextValue(summary.runoutStale ? probeText('probingSection110') : '') })}
        </div>
      )}
      {summary.state === 'uncalibrated' && (
        <div
          data-testid="machine-def-panel-probing-calibration-warning"
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--warning)', marginTop: 4 }}
        >{probeText('probingSection113')}</div>
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
  useText('probing-screens')
  return (
    <><div data-testid="machine-def-group-probing" style={{ marginTop: 12 }}>
                  <SectionHead
                    title={probeText('probingSection114')}
                    summary={probeText('probingSection115')}
                    testId="machine-def-panel-head-probing"
                  />
                  <ProbeCalibrationStatus calibration={probeCalibration} />
                  <div
                    data-testid="machine-def-panel-probing-boundary"
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
                  >{probeText('probingSection117')}</div>

                  <div data-testid="machine-def-panel-probing-routines">
                    <SectionHead
                      title={probeText('probingSection118')}
                      summary={probeText('probingSection119')}
                      testId="machine-def-panel-probing-head-routines"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-routines-none"
                      settings={unsent}
                      keys={sectionKeys(PROBING_ROUTINE_FIELDS, 'Probing')}
                      noun={probeText('probingSection120')}
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
                      title={probeText('probingSection121')}
                      summary={probeText('probingSection122')}
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
                      noun={probeText('probingSection123')}
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
                        <thead><tr><th>{probeText('probingSection125')}</th><th>{probeText('probingSection127')}</th><th>{probeText('probingSection129')}</th></tr></thead>
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
                      title={probeText('probingSection130')}
                      summary={probeText('probingSection131')}
                      testId="machine-def-panel-probing-head-recipes"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-recipes-none"
                      settings={unsent}
                      keys={sectionKeys(PROBING_SAVED_MODE_FIELDS, 'Probing')}
                      noun={probeText('probingSection132')}
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
                      title={probeText('probingSection133')}
                      summary={probeText('probingSection134')}
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
                      noun={probeText('probingSection135')}
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
                        <thead><tr><th>{probeText('probingSection137')}</th><th>{probeText('probingSection139')}</th></tr></thead>
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
                      title={probeText('probingSection140')}
                      summary={probeText('probingSection141')}
                      testId="machine-def-panel-probing-head-blower"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-probing-blower-none"
                      settings={unsent}
                      keys={sectionKeys(PROBING_BLOWER_FIELDS, 'Probing')}
                      noun={probeText('probingSection142')}
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

