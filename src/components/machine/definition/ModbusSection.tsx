import { liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

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

export const MODBUS_EZ_GROUPS = liveCatalog(() => ([
  {
    title: controlText('ModbusSection.text001'),
    summary: controlText('ModbusSection.text002'),
    fields: [
      [controlText('ModbusSection.text003'), 'MultiBM'],
      [controlText('ModbusSection.text004'), 'RpmONLY'],
      [controlText('ModbusSection.text005'), 'MultipleRegs'],
      [controlText('ModbusSection.text006'), 'MultiCoil'],
      [controlText('ModbusSection.text007'), 'SingCoil'],
      [controlText('ModbusSection.text008'), 'HZ Range'],
      [controlText('ModbusSection.text009'), 'SingHold'],
      [controlText('ModbusSection.text010'), 'Amp Enable'],
    ],
  },
  {
    title: controlText('ModbusSection.text011'),
    summary: controlText('ModbusSection.text012'),
    fields: [
      [controlText('ModbusSection.text013'), 'Selectedport'],
      [controlText('ModbusSection.text014'), 'SelectedBaud'],
      [controlText('ModbusSection.text015'), 'StopBit'],
    ],
  },
  {
    title: controlText('ModbusSection.text016'),
    summary: controlText('ModbusSection.text017'),
    fields: [
      [controlText('ModbusSection.text018'), 'CaDD'],
      [controlText('ModbusSection.text019'), 'FrqADD'],
      [controlText('ModbusSection.text020'), 'ONCW'],
      [controlText('ModbusSection.text021'), 'STOP'],
      [controlText('ModbusSection.text022'), 'ONCCW'],
      [controlText('ModbusSection.text023'), 'Function'],
      [controlText('ModbusSection.text024'), 'DisplayField'],
      [controlText('ModbusSection.text025'), 'SpindleStop'],
      [controlText('ModbusSection.text026'), 'SendCwOn'],
      [controlText('ModbusSection.text027'), 'SendCwwOn'],
      [controlText('ModbusSection.text028'), 'Amp Address'],
      [controlText('ModbusSection.text029'), 'Amp Divideby'],
      [controlText('ModbusSection.text030'), 'Amp Send'],
    ],
  },
  {
    title: controlText('ModbusSection.text031'),
    summary: controlText('ModbusSection.text032'),
    fields: [
      [controlText('ModbusSection.text033'), 'SelectedFreq'],
      [controlText('ModbusSection.text034'), 'Selectedminrpm'],
      [controlText('ModbusSection.text035'), 'Selectedmaxrpm'],
    ],
  },
] as const))

export const MODBUS_CONNECTION_FIELDS = liveCatalog(() => ([
  [controlText('ModbusSection.text036'), 'Description'],
  [controlText('ModbusSection.text037'), 'ID'],
  [controlText('ModbusSection.text038'), 'Enabled'],
  [controlText('ModbusSection.text039'), 'Loopinterval'],
  [controlText('ModbusSection.text040'), 'Retrycount'],
  [controlText('ModbusSection.text041'), 'Timeout'],
  [controlText('ModbusSection.text042'), 'Type'],
  [controlText('ModbusSection.text043'), 'Serial_Baudrate'],
  [controlText('ModbusSection.text044'), 'Serial_Comport'],
  [controlText('ModbusSection.text045'), 'Serial_Databits'],
  [controlText('ModbusSection.text046'), 'Serial_Parity'],
  [controlText('ModbusSection.text047'), 'Serial_RS485mode'],
  [controlText('ModbusSection.text048'), 'Serial_Stopbits'],
] as const))

export const MODBUS_FUNCTION_FIELDS = liveCatalog(() => ([
  ['Name', controlText('ModbusSection.text049')],
  ['Enabled', controlText('ModbusSection.text050')],
  ['Type', controlText('ModbusSection.text051')],
  ['Registercount', controlText('ModbusSection.text052')],
  ['Slaveaddress', controlText('ModbusSection.text053')],
  ['Startregister', controlText('ModbusSection.text054')],
  ['UCCNCstartregister', controlText('ModbusSection.text055')],
] as const))

export const MODBUS_FUNCTION_ROWS = [0, 1, 2, 3] as const

type ModbusSectionProps = Pick<MachineDefinitionPanelState, 'unsent'>

export function ModbusSection({ unsent }: ModbusSectionProps) {
  useText('control-screens-not-probing')
  return (
    <><div data-testid="machine-def-panel-modbus-vfd" style={{ marginTop: 12 }}>
                  <SectionHead
                    title={controlText('ModbusSection.text056')}
                    summary="UCCNC plugin, serial connection and four function records"
                    testId="machine-def-panel-modbus-vfd-head"
                  />
                  <div
                    data-testid="machine-def-panel-modbus-vfd-boundary"
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
                  >{controlText('ModbusSection.text057')}</div>

                  <div data-testid="machine-def-panel-modbus-ez">
                    <SectionHead
                      title={controlText('ModbusSection.text058')}
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
                      title={controlText('ModbusSection.text059')}
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
                            <th>{controlText('ModbusSection.text060')}</th>
                            <th>{controlText('ModbusSection.text061')}</th>
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

