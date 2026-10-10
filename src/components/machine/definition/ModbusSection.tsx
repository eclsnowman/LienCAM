import { type SettingSource } from './DefinitionFields'
import { NotSent } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { emptyMarked } from './DefinitionFields'
import { rowEmptyMarked } from './DefinitionFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'



/** UCCNC's Modbus plugin record is evidence about how this profile drives its
 * VFD, not a second live spindle path. The values are stored on the definition
 * under the controller's exact keys and are driven by nothing, so a later
 * order can give them a bridge contract without translating or guessing at
 * machine facts (WO-954 / WO-1039). */
export function ModbusNotSent({ label, section, settingKey, settings }: {
  label: string
  section: string
  settingKey: string
  settings: SettingSource
}) {
  return (
    <NotSent
      label={label}
      settings={settings}
      settingKey={`${section}.${settingKey}`}
    />
  )
}

export const MODBUS_EZ_GROUPS = [
  {
    title: 'Plugin mode',
    summary: 'Command and telemetry modes selected in UCCNC',
    fields: [
      ['multi-byte mode', 'MultiBM'],
      ['RPM only', 'RpmONLY'],
      ['multiple registers', 'MultipleRegs'],
      ['multiple coils', 'MultiCoil'],
      ['single coil', 'SingCoil'],
      ['frequency is Hz range', 'HZ Range'],
      ['single holding register', 'SingHold'],
      ['amperage enabled', 'Amp Enable'],
    ],
  },
  {
    title: 'Serial selection',
    summary: 'Port and framing stored by the plugin',
    fields: [
      ['port', 'Selectedport'],
      ['baud rate', 'SelectedBaud'],
      ['stop bits', 'StopBit'],
    ],
  },
  {
    title: 'Commands and registers',
    summary: 'Addresses and command frames stored verbatim',
    fields: [
      ['command address', 'CaDD'],
      ['frequency address', 'FrqADD'],
      ['clockwise command', 'ONCW'],
      ['stop command', 'STOP'],
      ['counterclockwise command', 'ONCCW'],
      ['write function', 'Function'],
      ['display field', 'DisplayField'],
      ['stop frame', 'SpindleStop'],
      ['clockwise frame', 'SendCwOn'],
      ['counterclockwise frame', 'SendCwwOn'],
      ['amperage address', 'Amp Address'],
      ['amperage divisor', 'Amp Divideby'],
      ['amperage send value', 'Amp Send'],
    ],
  },
  {
    title: 'Speed range',
    summary: 'Frequency and spindle range stored by the plugin',
    fields: [
      ['maximum frequency', 'SelectedFreq'],
      ['minimum RPM', 'Selectedminrpm'],
      ['maximum RPM', 'Selectedmaxrpm'],
    ],
  },
] as const

export const MODBUS_CONNECTION_FIELDS = [
  ['description', 'Description'],
  ['connection ID', 'ID'],
  ['enabled', 'Enabled'],
  ['loop interval', 'Loopinterval'],
  ['retry count', 'Retrycount'],
  ['timeout', 'Timeout'],
  ['transport', 'Type'],
  ['baud rate', 'Serial_Baudrate'],
  ['COM port', 'Serial_Comport'],
  ['data bits', 'Serial_Databits'],
  ['parity', 'Serial_Parity'],
  ['RS485 mode', 'Serial_RS485mode'],
  ['stop bits', 'Serial_Stopbits'],
] as const

export const MODBUS_FUNCTION_FIELDS = [
  ['Name', 'name'],
  ['Enabled', 'enabled'],
  ['Type', 'operation'],
  ['Registercount', 'register count'],
  ['Slaveaddress', 'slave'],
  ['Startregister', 'device register'],
  ['UCCNCstartregister', 'UCCNC register'],
] as const

export const MODBUS_FUNCTION_ROWS = [0, 1, 2, 3] as const

type ModbusSectionProps = Pick<MachineDefinitionPanelState, 'unsent'>

export function ModbusSection({ unsent }: ModbusSectionProps) {
  return (
    <><div data-testid="machine-def-panel-modbus-vfd" style={{ marginTop: 12 }}>
                  <SectionHead
                    title="Modbus and VFD profile"
                    summary="UCCNC plugin, serial connection and four function records"
                    testId="machine-def-panel-modbus-vfd-head"
                  />
                  <div
                    data-testid="machine-def-panel-modbus-vfd-boundary"
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
                  >
                    This is the imported definition record only. Nothing here starts or stops the
                    spindle, changes the live VFD link, weakens VFD verification, or gates a stop.
                    These values are stored with the definition and nothing acts on them yet.
                  </div>

                  <div data-testid="machine-def-panel-modbus-ez">
                    <SectionHead
                      title="UCCNC Modbus EZ"
                      summary="Plugin commands, telemetry selection and speed range"
                      testId="machine-def-panel-modbus-ez-head"
                    />
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                      gap: 12,
                    }}>
                      {MODBUS_EZ_GROUPS.map((groupSpec) => (
                        <div key={groupSpec.title} data-testid={`machine-def-panel-modbus-ez-${groupSpec.title.toLowerCase().replaceAll(' ', '-')}`}>
                          <SectionHead
                            title={groupSpec.title}
                            summary={groupSpec.summary}
                            testId={`machine-def-panel-modbus-ez-head-${groupSpec.title.toLowerCase().replaceAll(' ', '-')}`}
                          />
                          <SectionNoneSet
                            testId={`machine-def-panel-modbus-ez-${groupSpec.title.toLowerCase().replaceAll(' ', '-')}-none`}
                            settings={unsent}
                            keys={sectionKeys(groupSpec.fields, 'ModbusEZ')}
                            noun="plugin settings"
                          />
                          <div
                            style={{ display: 'grid', gap: 5 }}
                            {...emptyMarked(unsent, sectionKeys(groupSpec.fields, 'ModbusEZ'))}
                          >
                            {groupSpec.fields.map(([label, key]) => (
                              <ModbusNotSent
                                key={key}
                                label={label}
                                section="ModbusEZ"
                                settingKey={key}
                                settings={unsent}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div data-testid="machine-def-panel-modbus-connection" style={{ marginTop: 12 }}>
                    <SectionHead
                      title="Serial connection"
                      summary="Shared transport and retry policy for the four function slots"
                      testId="machine-def-panel-modbus-connection-head"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-modbus-connection-none"
                      settings={unsent}
                      keys={[
                        ...sectionKeys(MODBUS_CONNECTION_FIELDS, 'Modbus_connection_0'),
                        ...MODBUS_FUNCTION_ROWS.flatMap((row) => [
                          `Modbus_connection_0.Function_${row}`,
                          ...sectionKeys(MODBUS_FUNCTION_FIELDS, `Modbus_function_0_${row}`),
                        ]),
                      ]}
                      noun="modbus settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                        gap: '5px 16px', marginBottom: 8,
                      }}
                      {...emptyMarked(unsent, sectionKeys(MODBUS_CONNECTION_FIELDS, 'Modbus_connection_0'))}
                    >
                      {MODBUS_CONNECTION_FIELDS.map(([label, key]) => (
                        <ModbusNotSent
                          key={key}
                          label={label}
                          section="Modbus_connection_0"
                          settingKey={key}
                          settings={unsent}
                        />
                      ))}
                    </div>

                    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                      <table
                        className="mform-axis-table"
                        data-testid="machine-def-panel-modbus-functions-table"
                        style={{ width: 'max-content', minWidth: '100%' }}
                        {...emptyMarked(unsent, MODBUS_FUNCTION_ROWS.flatMap((row) => [
                          `Modbus_connection_0.Function_${row}`,
                          ...sectionKeys(MODBUS_FUNCTION_FIELDS, `Modbus_function_0_${row}`),
                        ]))}
                      >
                        <thead>
                          <tr>
                            <th>slot</th>
                            <th>function record</th>
                            {MODBUS_FUNCTION_FIELDS.map(([, label]) => (
                              <th key={label}>{label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {MODBUS_FUNCTION_ROWS.map((row) => {
                            const functionSection = `Modbus_function_0_${row}`
                            return (
                              <tr
                                key={row}
                                data-testid={`machine-def-panel-modbus-function-row-${row}`}
                                {...rowEmptyMarked(unsent, [
                                  `Modbus_connection_0.Function_${row}`,
                                  ...sectionKeys(MODBUS_FUNCTION_FIELDS, functionSection),
                                ])}
                              >
                                <td className="mform-input-mono" style={{ color: 'var(--text-secondary)' }}>
                                  {row}
                                </td>
                                <td>
                                  <ModbusNotSent
                                    label=""
                                    section="Modbus_connection_0"
                                    settingKey={`Function_${row}`}
                                    settings={unsent}
                                  />
                                </td>
                                {MODBUS_FUNCTION_FIELDS.map(([key]) => (
                                  <td key={key}>
                                    <ModbusNotSent
                                      label=""
                                      section={functionSection}
                                      settingKey={key}
                                      settings={unsent}
                                    />
                                  </td>
                                ))}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                  </div>
                </div>
              </div></>
  )
}

