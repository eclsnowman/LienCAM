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
  return (
    <><div data-testid="machine-def-group-wiring">
                <SectionHead
                  title="Wiring"
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
                        <th>Axis</th>
                        <th data-tooltip="axessettingscontrol<axis>.Currhilowportnumber / Currhilowpinnumber - the drive current hi/lo select line. Stored with this machine definition; nothing in this software drives it yet.">curr hi/lo</th>
                        <th data-tooltip="Pin-polarity flags with no named pin of their own. Editable here and stored with the definition; an assigned pin's polarity stays on its pin triple.">profile-only polarity</th>
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
                                label="port" settings={unsent}
                                settingKey={`axessettingscontrol${name}.Currhilowportnumber`}
                              />
                              {' '}
                              <NotSent
                                label="pin" settings={unsent}
                                settingKey={`axessettingscontrol${name}.Currhilowpinnumber`}
                              />
                            </td>
                            <td>
                              <AxisProfileReadouts
                                axis={name}
                                fields={unsentAxisPolarityFields(name)}
                                settings={unsent}
                                testId={`machine-def-panel-axis-profile-polarity-${name}`}
                                label="polarity"
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
                    title="Machine inputs"
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
                      label="Probe 2 recorded active low"
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
                      title="Input filtering"
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
                      title="Controller signals"
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
                        label="Spindle index port"
                        settingKey="Indexportnumber"
                        settings={unsent}
                      />
                      <IoNotSent
                        label="pin"
                        settingKey="Indexpinnumber"
                        settings={unsent}
                      />
                      <IoNotSent
                        label="prescaler"
                        settingKey="Indexprescaler"
                        settings={unsent}
                      />
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <SectionHead
                        title="Torch height control"
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
                          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 3 }}>
                            Inputs from the torch controller
                          </div>
                          <IoPinReadoutTable
                            testId="machine-def-panel-io-thc-inputs"
                            rows={IO_THC_INPUT_ROWS}
                            settings={unsent}
                          />
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 3 }}>
                            Outputs to the torch controller
                          </div>
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
                        title="Handwheel and overrides"
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
                              <th>Device</th>
                              <th>A port</th>
                              <th>A pin</th>
                              <th>B port</th>
                              <th>B pin</th>
                              <th>prescaler</th>
                              <th>filter</th>
                              <th>speed multiplier</th>
                              <th>attached to jog override</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>Handwheel encoder</td>
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
                              <tr><th>Override</th><th>channel</th><th>minimum %</th><th>maximum %</th></tr>
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
                              <tr><th>Analog signal</th><th>input variable</th><th>output variable</th></tr>
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
                          label="Spindle PWM analog channel"
                          settingKey="SPPWMchannel"
                          settings={unsent}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <SectionHead
                        title="Synchronized outputs"
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
                            <tr><th>Output</th><th>port</th><th>pin</th><th>active low</th></tr>
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
                      title="Auxiliary encoders"
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
                            <th>encoder</th><th>A port</th><th>A pin</th>
                            <th>B port</th><th>B pin</th><th>counts per unit</th>
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
                      title="Input and output triggers"
                      summary="External signals that can command or reflect controller actions"
                      testId="machine-def-panel-head-triggers"
                    />
                    <div
                      data-testid="machine-def-panel-trigger-safety"
                      style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
                    >
                      An input trigger can press a controller button without anybody touching the
                      screen. Editing these boxes changes this machine's record only, and nothing in
                      this section gates or delays a stop.
                    </div>
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
                      title="Drive and machine faults"
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
                        label="Show a message box on warning"
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
                            <th data-tooltip="Fault input number in the controller profile">#</th>
                            {FAULT_SIGNAL_FIELDS.map(([stem, label]) => (
                              <th
                                key={stem}
                                data-tooltip={`FaultSignals.${stem}# - ${label}, read from this machine's profile. This software cannot send it to the controller yet.`}
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
