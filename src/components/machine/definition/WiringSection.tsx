import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { SectionHead } from './DefinitionFields'
import { NotSentLegend } from './DefinitionFields'
import { AXIS_NAMES } from '../../../types'
import { PinField } from './DefinitionFields'
import { NotSent } from './DefinitionFields'
import { AxisProfileReadouts } from './AxisProfileFields'
import { unsentAxisPolarityFields } from './AxisProfileFields'
import { IO_FIELDS } from './IoFields'
import { IoNotSent } from './IoFields'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { GENERAL_DEBOUNCE_FIELDS } from './GeneralSection'
import { emptyMarked } from './DefinitionFields'
import { GeneralNotSent } from './GeneralSection'
import { IO_CONTROLLER_OUTPUT_ROWS } from './IoFields'
import { IoPinReadoutTable } from './IoFields'
import { IO_THC_BEHAVIOR_FIELDS } from './IoFields'
import { IO_THC_INPUT_ROWS } from './IoFields'
import { IO_THC_OUTPUT_ROWS } from './IoFields'
import { IO_OVERRIDE_ROWS } from './IoFields'
import { IO_ANALOG_ROWS } from './IoFields'
import { rowEmptyMarked } from './DefinitionFields'
import { IO_DIGITAL_SYNC_ROWS } from './IoFields'
import { AUX_ENCODER_ROWS } from './AutomationFields'
import { ProfileNotSent } from './AutomationFields'
import { TRIGGER_TABLES } from './IoFields'
import { TriggerTable } from './IoFields'
import { FAULT_SIGNAL_ROWS } from './AutomationFields'
import { FAULT_SIGNAL_FIELDS } from './AutomationFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


// WO-1690 - THE SIX-PIN AXIS TABLE RETIRED FROM HERE, TO THE MACHINE AREA.
//
// v2/SLICES.md T7 moved step/dir/home/limit-/limit+/enable - and their GRBL
// read-out fallback - onto `MachineArea.tsx`'s table and its "Pins and more"
// drawer. What is left is the UCCNC catalogue's own per-axis extras (drive
// current hi/lo, profile-only polarity flags with no named pin of their
// own): fields this software cannot yet send, so they stay with the rest of
// the not-yet-migrated catalogue on this Legacy tab. Everything else here -
// machine inputs (e-stop/probe/probe2), input filtering, controller signals,
// THC, handwheel/overrides, sync outputs, aux encoders, triggers, fault
// signals - is untouched: none of it is a per-axis wire and none of it is
// this order's scope.
type WiringSectionProps = Pick<MachineDefinitionPanelState, 'absentAxisRow' | 'draft' | 'notAcceptedCount' | 'patchIoPin' | 'pinProblem' | 'pinText' | 'polarityBoxFor' | 'unsent'> & { def: NonNullable<MachineDefinitionPanelState['def']> }

export function WiringSection({ absentAxisRow, def, notAcceptedCount, patchIoPin, pinProblem, pinText, polarityBoxFor, unsent }: WiringSectionProps) {
  useText('control-screens-not-probing')
  return (
    <><div data-testid="machine-def-group-wiring">
                <SectionHead
                  title={controlText('WiringSection.text001')}
                  summary={`e-stop ${pinText(def.io.estop)} / probe ${pinText(def.io.probe)}`}
                  testId="machine-def-panel-head-wiring"
                />
                <NotSentLegend
                  testId="machine-def-wiring-unsent-legend"
                  settings={unsent}
                  unmodelled={unsent.hasTextOnly()}
                  notAccepted={notAcceptedCount}
                />
                {unsent.catalogued && (
                  <table
                    className="mform-axis-table"
                    data-testid="machine-def-panel-wiring-table"
                    style={{ width: 'auto' }}
                  >
                    <thead>
                      <tr>
                        <th>{controlText('WiringSection.text002')}</th>
                        <th data-tooltip={controlText('WiringSection.text003')}>{controlText('WiringSection.text004')}</th>
                        <th data-tooltip={controlText('WiringSection.text005')}>{controlText('WiringSection.text006')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {AXIS_NAMES.map((name) => {
                        const a = def.axes.find((x) => x.axis === name)
                        if (!a) return absentAxisRow(name, 2)
                        return (
                          <tr
                            key={name}
                            data-testid={`machine-def-panel-wiring-row-${name}`}
                            style={{ opacity: a.enabled ? 1 : 0.72 }}
                          >
                            <td className="mform-axis-label">{name}</td>
                            <td>
                              <NotSent
                                label={controlText('WiringSection.text007')} settings={unsent}
                                settingKey={`axessettingscontrol${name}.Currhilowportnumber`}
                              />
                              {' '}
                              <NotSent
                                label={controlText('WiringSection.text008')} settings={unsent}
                                settingKey={`axessettingscontrol${name}.Currhilowpinnumber`}
                              />
                            </td>
                            <td>
                              <AxisProfileReadouts
                                axis={name}
                                fields={unsentAxisPolarityFields(name)}
                                settings={unsent}
                                testId={`machine-def-panel-axis-profile-polarity-${name}`}
                                label={controlText('WiringSection.text009')}
                                collapsed={!a.enabled}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}

                <div style={{ marginTop: 12 }}>
                  <SectionHead
                    title={controlText('WiringSection.text010')}
                    summary={
                      `e-stop ${pinText(def.io.estop)}`
                      + ` / probe ${pinText(def.io.probe)}`
                      + ` / probe 2 ${pinText(def.io.probe2)}`
                    }
                    testId="machine-def-panel-head-io"
                  />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
                    {IO_FIELDS.map(([title, field, label]) => (
                      <label
                        key={field}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 8,
                          fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
                        }}
                      >
                        <span style={{ minWidth: 56 }}>{title}</span>
                        <PinField
                          label="" name={title}
                          testId={`machine-def-panel-pin-io-${field}`}
                          value={def.io[field]}
                          problem={pinProblem(label)}
                          polarityBox={polarityBoxFor(`io.${field}`)}
                          onChange={(pin) => patchIoPin(field, pin)}
                        />
                      </label>
                    ))}
                    {/* Drawn only when the pin triple beside it is NOT holding
                        this polarity - `SettingBox` asks `ownedElsewhere`. The
                        guard that used to stand here compared `read()` to
                        `undefined`, which it never returns, so an assigned
                        Probe 2 got a second negate editor that then overruled
                        the triple in the export (audit 2026-08-27). */}
                    <IoNotSent
                      label={controlText('WiringSection.text011')}
                      settingKey="Probepin2negate"
                      settings={unsent}
                    />
                  </div>
                </div>

                {/* THE CATALOGUE'S OWN WIRING SECTIONS - input filtering,
                    controller signals, aux encoders, triggers and fault
                    signals are all `.pro` keys, so they belong to a UCCNC
                    machine and to no other. The pin table and machine inputs
                    above are this software's own fields and stay on every
                    machine. See `SettingSource.catalogued`. */}
                {unsent.catalogued && (
                  <>
                  <div data-testid="machine-def-panel-general-debounce" style={{ marginTop: 12 }}>
                    <SectionHead
                      title={controlText('WiringSection.text012')}
                      summary="Debounce values for machine, home, torch and probe signals"
                      testId="machine-def-panel-general-head-debounce"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-general-debounce-none"
                      settings={unsent}
                      keys={sectionKeys(GENERAL_DEBOUNCE_FIELDS, 'Generalsettings')}
                      noun="debounce settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(GENERAL_DEBOUNCE_FIELDS, 'Generalsettings'))}
                    >
                      {GENERAL_DEBOUNCE_FIELDS.map(([label, key]) => (
                        <GeneralNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }} data-testid="machine-def-panel-io-setup">
                    <SectionHead
                      title={controlText('WiringSection.text013')}
                      summary="Outputs, timing signals and the spindle index input"
                      testId="machine-def-panel-io-subhead-controller-signals"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-io-controller-signals-none"
                      settings={unsent}
                      keys={[
                        ...IO_CONTROLLER_OUTPUT_ROWS.flatMap((row) => [
                          ...[row.port, row.pin, row.negate].map((key) => `IOsetupsettings.${key}`),
                          ...(row.extra ?? []).map(([, key]) => `IOsetupsettings.${key}`),
                        ]),
                        'IOsetupsettings.Indexportnumber',
                        'IOsetupsettings.Indexpinnumber',
                        'IOsetupsettings.Indexprescaler',
                      ]}
                      noun="controller signal settings"
                    />
                    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                      <IoPinReadoutTable
                        testId="machine-def-panel-io-controller-outputs"
                        rows={IO_CONTROLLER_OUTPUT_ROWS}
                        settings={unsent}
                      />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6 }}>
                      <IoNotSent
                        label={controlText('WiringSection.text014')}
                        settingKey="Indexportnumber"
                        settings={unsent}
                      />
                      <IoNotSent
                        label={controlText('WiringSection.text015')}
                        settingKey="Indexpinnumber"
                        settings={unsent}
                      />
                      <IoNotSent
                        label={controlText('WiringSection.text016')}
                        settingKey="Indexprescaler"
                        settings={unsent}
                      />
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <SectionHead
                        title={controlText('WiringSection.text017')}
                        summary="Arc feedback, torch corrections and anti-dive signals"
                        testId="machine-def-panel-io-subhead-thc"
                      />
                      <SectionNoneSet
                        testId="machine-def-panel-io-thc-none"
                        settings={unsent}
                        keys={[
                          ...sectionKeys(IO_THC_BEHAVIOR_FIELDS, 'IOsetupsettings'),
                          ...IO_THC_INPUT_ROWS.flatMap((row) => [
                            `IOsetupsettings.${row.port}`,
                            `IOsetupsettings.${row.pin}`,
                            `IOsetupsettings.${row.negate}`,
                          ]),
                          ...IO_THC_OUTPUT_ROWS.flatMap((row) => [
                            `IOsetupsettings.${row.port}`,
                            `IOsetupsettings.${row.pin}`,
                            `IOsetupsettings.${row.negate}`,
                          ]),
                        ]}
                        noun="torch height settings"
                      />
                      <div
                        style={{
                          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                          gap: '5px 16px', marginBottom: 8,
                        }}
                        {...emptyMarked(unsent, sectionKeys(IO_THC_BEHAVIOR_FIELDS, 'IOsetupsettings'))}
                      >
                        {IO_THC_BEHAVIOR_FIELDS.map(([label, key]) => (
                          <IoNotSent
                            key={key}
                            label={label}
                            settingKey={key}
                            settings={unsent}
                          />
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10 }}>
                        <div style={{ overflowX: 'auto' }}>
                          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 3 }}>{controlText('WiringSection.text018')}</div>
                          <IoPinReadoutTable
                            testId="machine-def-panel-io-thc-inputs"
                            rows={IO_THC_INPUT_ROWS}
                            settings={unsent}
                          />
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 3 }}>{controlText('WiringSection.text019')}</div>
                          <IoPinReadoutTable
                            testId="machine-def-panel-io-thc-outputs"
                            rows={IO_THC_OUTPUT_ROWS}
                            settings={unsent}
                          />
                        </div>
                      </div>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <SectionHead
                        title={controlText('WiringSection.text020')}
                        summary="Manual pulse generator and analog override channels"
                        testId="machine-def-panel-io-subhead-handwheel"
                      />
                      <SectionNoneSet
                        testId="machine-def-panel-io-handwheel-none"
                        settings={unsent}
                        keys={[
                          'IOsetupsettings.MPG1portA', 'IOsetupsettings.MPG1pinA',
                          'IOsetupsettings.MPG1portB', 'IOsetupsettings.MPG1pinB',
                          'IOsetupsettings.MPG1prescaler', 'IOsetupsettings.MPG1filter',
                          'IOsetupsettings.MPG1speedmultiplier', 'IOsetupsettings.MPG1attachtoJRO',
                          ...IO_OVERRIDE_ROWS.flatMap(([, channel, min, max]) => [
                            `IOsetupsettings.${channel}`, `IOsetupsettings.${min}`, `IOsetupsettings.${max}`,
                          ]),
                          ...IO_ANALOG_ROWS.flatMap(([, input, output]) => [
                            `IOsetupsettings.${input}`, `IOsetupsettings.${output}`,
                          ]),
                          'IOsetupsettings.SPPWMchannel',
                        ]}
                        noun="handwheel and override settings"
                      />
                      <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                        <table
                          className="mform-axis-table"
                          data-testid="machine-def-panel-io-handwheel"
                          style={{ width: 'max-content', minWidth: '100%' }}
                          {...emptyMarked(unsent, [
                            'IOsetupsettings.MPG1portA', 'IOsetupsettings.MPG1pinA',
                            'IOsetupsettings.MPG1portB', 'IOsetupsettings.MPG1pinB',
                            'IOsetupsettings.MPG1prescaler', 'IOsetupsettings.MPG1filter',
                            'IOsetupsettings.MPG1speedmultiplier', 'IOsetupsettings.MPG1attachtoJRO',
                          ])}
                        >
                          <thead>
                            <tr>
                              <th>{controlText('WiringSection.text021')}</th>
                              <th>{controlText('WiringSection.text022')}</th>
                              <th>{controlText('WiringSection.text023')}</th>
                              <th>{controlText('WiringSection.text024')}</th>
                              <th>{controlText('WiringSection.text025')}</th>
                              <th>{controlText('WiringSection.text026')}</th>
                              <th>{controlText('WiringSection.text027')}</th>
                              <th>{controlText('WiringSection.text028')}</th>
                              <th>{controlText('WiringSection.text029')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>{controlText('WiringSection.text030')}</td>
                              {[
                                'MPG1portA', 'MPG1pinA', 'MPG1portB', 'MPG1pinB',
                                'MPG1prescaler', 'MPG1filter', 'MPG1speedmultiplier', 'MPG1attachtoJRO',
                              ].map((key) => (
                                <td key={key}>
                                  <IoNotSent label="" settingKey={key} settings={unsent} />
                                </td>
                              ))}
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1fr) minmax(280px, 0.7fr)', gap: 10, marginTop: 8 }}>
                        <div style={{ overflowX: 'auto' }}>
                          <table
                            className="mform-axis-table"
                            data-testid="machine-def-panel-io-overrides"
                            style={{ width: '100%' }}
                            {...emptyMarked(unsent, IO_OVERRIDE_ROWS.flatMap(([, channel, min, max]) => [
                              `IOsetupsettings.${channel}`, `IOsetupsettings.${min}`, `IOsetupsettings.${max}`,
                            ]))}
                          >
                            <thead>
                              <tr><th>{controlText('WiringSection.text031')}</th><th>{controlText('WiringSection.text032')}</th><th>{controlText('WiringSection.text033')}</th><th>{controlText('WiringSection.text034')}</th></tr>
                            </thead>
                            <tbody>
                              {IO_OVERRIDE_ROWS.map(([label, channel, min, max]) => (
                                <tr
                                  key={label}
                                  {...rowEmptyMarked(unsent, [
                                    `IOsetupsettings.${channel}`, `IOsetupsettings.${min}`, `IOsetupsettings.${max}`,
                                  ])}
                                >
                                  <td>{label}</td>
                                  {[channel, min, max].map((key) => (
                                    <td key={key}>
                                      <IoNotSent label="" settingKey={key} settings={unsent} />
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table
                            className="mform-axis-table"
                            data-testid="machine-def-panel-io-analog-bindings"
                            style={{ width: '100%' }}
                            {...emptyMarked(unsent, IO_ANALOG_ROWS.flatMap(([, input, output]) => [
                              `IOsetupsettings.${input}`, `IOsetupsettings.${output}`,
                            ]))}
                          >
                            <thead>
                              <tr><th>{controlText('WiringSection.text035')}</th><th>{controlText('WiringSection.text036')}</th><th>{controlText('WiringSection.text037')}</th></tr>
                            </thead>
                            <tbody>
                              {IO_ANALOG_ROWS.map(([label, input, output]) => (
                                <tr
                                  key={label}
                                  {...rowEmptyMarked(unsent, [
                                    `IOsetupsettings.${input}`, `IOsetupsettings.${output}`,
                                  ])}
                                >
                                  <td>{label}</td>
                                  <td><IoNotSent label="" settingKey={input} settings={unsent} /></td>
                                  <td><IoNotSent label="" settingKey={output} settings={unsent} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <IoNotSent
                          label={controlText('WiringSection.text038')}
                          settingKey="SPPWMchannel"
                          settings={unsent}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <SectionHead
                        title={controlText('WiringSection.text039')}
                        summary="10 outputs that switch in step with controller motion"
                        testId="machine-def-panel-io-subhead-sync-outputs"
                      />
                      <SectionNoneSet
                        testId="machine-def-panel-io-sync-outputs-none"
                        settings={unsent}
                        keys={IO_DIGITAL_SYNC_ROWS.flatMap((row) => [
                          `IOsetupsettings.Digitialsyncoutputportnumber${row}`,
                          `IOsetupsettings.Digitialsyncoutputpinnumber${row}`,
                          `IOsetupsettings.Digitialsyncoutputpinnegate${row}`,
                        ])}
                        noun="synchronized outputs"
                      />
                      <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                        <table
                          className="mform-axis-table"
                          data-testid="machine-def-panel-io-sync-outputs"
                          style={{ width: 'max-content', minWidth: '100%' }}
                          {...emptyMarked(unsent, IO_DIGITAL_SYNC_ROWS.flatMap((row) => [
                            `IOsetupsettings.Digitialsyncoutputportnumber${row}`,
                            `IOsetupsettings.Digitialsyncoutputpinnumber${row}`,
                            `IOsetupsettings.Digitialsyncoutputpinnegate${row}`,
                          ]))}
                        >
                          <thead>
                            <tr><th>{controlText('WiringSection.text040')}</th><th>{controlText('WiringSection.text041')}</th><th>{controlText('WiringSection.text042')}</th><th>{controlText('WiringSection.text043')}</th></tr>
                          </thead>
                          <tbody>
                            {IO_DIGITAL_SYNC_ROWS.map((row) => (
                              <tr
                                key={row}
                                data-testid={`machine-def-panel-io-sync-output-${row}`}
                                {...rowEmptyMarked(unsent, [
                                  `IOsetupsettings.Digitialsyncoutputportnumber${row}`,
                                  `IOsetupsettings.Digitialsyncoutputpinnumber${row}`,
                                  `IOsetupsettings.Digitialsyncoutputpinnegate${row}`,
                                ])}
                              >
                                <td>{row}</td>
                                {[
                                  `Digitialsyncoutputportnumber${row}`,
                                  `Digitialsyncoutputpinnumber${row}`,
                                  `Digitialsyncoutputpinnegate${row}`,
                                ].map((key) => (
                                  <td key={key}>
                                    <IoNotSent label="" settingKey={key} settings={unsent} />
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }} data-testid="machine-def-panel-aux-encoders">
                    <SectionHead
                      title={controlText('WiringSection.text044')}
                      summary="6 encoder input pairs and their recorded scale"
                      testId="machine-def-panel-head-aux-encoders"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-aux-encoders-none"
                      settings={unsent}
                      keys={AUX_ENCODER_ROWS.flatMap((row) => [
                        `AUXencodersettings.AUXencoder${row}portA`,
                        `AUXencodersettings.AUXencoder${row}pinA`,
                        `AUXencodersettings.AUXencoder${row}portB`,
                        `AUXencodersettings.AUXencoder${row}pinB`,
                        `AUXencodersettings.Aux${row}Encodercountsper`,
                      ])}
                      noun="aux encoder settings"
                    />
                    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                      <table
                        className="mform-axis-table"
                        data-testid="machine-def-panel-aux-encoders-table"
                        style={{ width: 'max-content', minWidth: '100%' }}
                        {...emptyMarked(unsent, AUX_ENCODER_ROWS.flatMap((row) => [
                          `AUXencodersettings.AUXencoder${row}portA`,
                          `AUXencodersettings.AUXencoder${row}pinA`,
                          `AUXencodersettings.AUXencoder${row}portB`,
                          `AUXencodersettings.AUXencoder${row}pinB`,
                          `AUXencodersettings.Aux${row}Encodercountsper`,
                        ]))}
                      >
                        <thead>
                          <tr>
                            <th>{controlText('WiringSection.text045')}</th><th>{controlText('WiringSection.text046')}</th><th>{controlText('WiringSection.text047')}</th>
                            <th>{controlText('WiringSection.text048')}</th><th>{controlText('WiringSection.text049')}</th><th>{controlText('WiringSection.text050')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {AUX_ENCODER_ROWS.map((row) => (
                            <tr
                              key={row}
                              data-testid={`machine-def-panel-aux-encoder-row-${row}`}
                              {...rowEmptyMarked(unsent, [
                                `AUXencodersettings.AUXencoder${row}portA`,
                                `AUXencodersettings.AUXencoder${row}pinA`,
                                `AUXencodersettings.AUXencoder${row}portB`,
                                `AUXencodersettings.AUXencoder${row}pinB`,
                                `AUXencodersettings.Aux${row}Encodercountsper`,
                              ])}
                            >
                              <td>{row}</td>
                              {[
                                `AUXencoder${row}portA`,
                                `AUXencoder${row}pinA`,
                                `AUXencoder${row}portB`,
                                `AUXencoder${row}pinB`,
                                `Aux${row}Encodercountsper`,
                              ].map((key) => (
                                <td key={key}>
                                  <ProfileNotSent
                                    label="" section="AUXencodersettings" settingKey={key} settings={unsent}
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }} data-testid="machine-def-panel-triggers">
                    <SectionHead
                      title={controlText('WiringSection.text051')}
                      summary="External signals that can command or reflect controller actions"
                      testId="machine-def-panel-head-triggers"
                    />
                    <div
                      data-testid="machine-def-panel-trigger-safety"
                      style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
                    >{controlText('WiringSection.text052')}</div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                        gap: 12,
                      }}
                    >
                      {TRIGGER_TABLES.map((spec) => (
                        <TriggerTable
                          key={spec.section}
                          spec={spec}
                          settings={unsent}
                        />
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }} data-testid="machine-def-panel-fault-signals">
                    <SectionHead
                      title={controlText('WiringSection.text053')}
                      summary="15 fault input rows from this machine's profile"
                      testId="machine-def-panel-head-fault-signals"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-fault-signals-none"
                      settings={unsent}
                      keys={[
                        'FaultSignals.MsgBoxOnWarning',
                        ...FAULT_SIGNAL_ROWS.flatMap((row) => (
                          FAULT_SIGNAL_FIELDS.map(([stem]) => `FaultSignals.${stem}${row}`)
                        )),
                      ]}
                      noun="fault signal settings"
                    />
                    <div style={{ marginBottom: 6 }}>
                      <NotSent
                        label={controlText('WiringSection.text054')}
                        settings={unsent}
                        settingKey="FaultSignals.MsgBoxOnWarning"
                      />
                    </div>
                    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                      <table
                        className="mform-axis-table"
                        data-testid="machine-def-panel-fault-signals-table"
                        style={{ width: 'max-content', minWidth: '100%' }}
                        {...emptyMarked(unsent, FAULT_SIGNAL_ROWS.flatMap((row) => (
                          FAULT_SIGNAL_FIELDS.map(([stem]) => `FaultSignals.${stem}${row}`)
                        )))}
                      >
                        <thead>
                          <tr>
                            <th data-tooltip={controlText('WiringSection.text055')}>#</th>
                            {FAULT_SIGNAL_FIELDS.map(([stem, label]) => (
                              <th
                                key={stem}
                                data-tooltip={controlText('WiringSection.text056', { value1: String(stem), value2: String(label) })}
                              >
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {FAULT_SIGNAL_ROWS.map((row) => (
                            <tr
                              key={row}
                              data-testid={`machine-def-panel-fault-signal-row-${row}`}
                              {...rowEmptyMarked(unsent, FAULT_SIGNAL_FIELDS.map(([stem]) => `FaultSignals.${stem}${row}`))}
                            >
                              <td className="mform-input-mono" style={{ color: 'var(--text-secondary)' }}>
                                {row}
                              </td>
                              {FAULT_SIGNAL_FIELDS.map(([stem]) => (
                                <td key={stem}>
                                  <NotSent
                                    label=""
                                    settings={unsent}
                                    settingKey={`FaultSignals.${stem}${row}`}
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  </>
                )}
              </div></>
  )
}
