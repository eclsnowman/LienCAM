import { SectionHead } from './DefinitionFields'
import { SpindleLinkSection, resolvedSpindleLink } from './SpindleLinkSection'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { SPINDLE_SPEED_FIELDS } from './SpindleFields'
import { SPINDLE_COMMAND_OUTPUT_ROWS } from './SpindleFields'
import { emptyMarked } from './DefinitionFields'
import { SpindleNotSent } from './SpindleFields'
import { rowEmptyMarked } from './DefinitionFields'
import { SPINDLE_ENCODER_FIELDS } from './SpindleFields'
import { SPINDLE_PID_FIELDS } from './SpindleFields'
import { SPINDLE_PULLEY_ROWS } from './SpindleFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


type SpindleSectionProps = Pick<MachineDefinitionPanelState, 'source' | 'spindleLink' | 'spindleLinkIsForeign' | 'spindleLinkOtherMachine' | 'spindleStoredIsStated' | 'unsent' | 'vfdEdit'>

export function SpindleSection({ source, spindleLink, spindleLinkIsForeign, spindleLinkOtherMachine, spindleStoredIsStated, unsent, vfdEdit }: SpindleSectionProps) {
  // WO-1704: `directionInverted` (SpindleLinkSection) is the one direction
  // editor when a VFD link exists - the step/dir `Spindledir*` pins below are
  // the alternative for a machine that really drives step/dir, not a second
  // copy of the VFD's direction row, so they show only when there is no link.
  const spindleLinkDefinition = resolvedSpindleLink({
    link: spindleLink,
    foreign: spindleLinkIsForeign,
    stored: source.spindleLinkDefinition,
    storedIsStated: spindleStoredIsStated,
  })
  const hasVfdLink = spindleLinkDefinition !== null && spindleLinkDefinition !== undefined
  const commandOutputRows = hasVfdLink
    ? SPINDLE_COMMAND_OUTPUT_ROWS.filter(([label]) => label !== 'Step direction')
    : SPINDLE_COMMAND_OUTPUT_ROWS
  return (
    <><div data-testid="machine-def-group-spindle">
                <SectionHead
                  title="Spindle"
                  summary="The Modbus link, then speed command, encoder, pulleys and PID - relays are rows on the Outputs list"
                  testId="machine-def-panel-head-spindle"
                />
                {/* WO-967: FIRST, because it is the inverter this software
                    actually drives. Everything below it is the `.pro`'s record
                    of how UCCNC drove one, which is a different document about
                    the same machine - Operator, 2026-08-26T21:03Z: "modbus is not
                    setup through the .pro ... we need the modbus controls in
                    the spindle section of the machine definition, but will
                    need its own fields to function outside of what the .pro
                    will bring." */}
                <SpindleLinkSection
                  link={spindleLink}
                  foreign={spindleLinkIsForeign}
                  otherMachine={spindleLinkOtherMachine}
                  stored={source.spindleLinkDefinition}
                  storedIsStated={spindleStoredIsStated}
                  edit={vfdEdit}
                  machineId={source.id}
                  showDrive={false}
                />
                <div data-testid="machine-def-panel-spindle-speed">
                  <SectionHead
                    title="Speed command"
                    summary="PWM and step/direction settings from this machine's profile"
                    testId="machine-def-panel-spindle-head-speed"
                  />
                  {/* WO-1122: the whole block collapses to its heading and a
                      count when the record states none of it. */}
                  <SectionNoneSet
                    testId="machine-def-panel-spindle-speed-none"
                    settings={unsent}
                    keys={[
                      ...sectionKeys(SPINDLE_SPEED_FIELDS, 'Spindlesetupsettings'),
                      ...SPINDLE_COMMAND_OUTPUT_ROWS.flatMap(([, port, pin, negate]) => [
                        `Spindlesetupsettings.${port}`,
                        `Spindlesetupsettings.${pin}`,
                        `Spindlesetupsettings.${negate}`,
                      ]),
                    ]}
                    noun="speed settings"
                  />
                  <div
                    {...emptyMarked(unsent, sectionKeys(SPINDLE_SPEED_FIELDS, 'Spindlesetupsettings'))}
                    style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                      gap: '5px 16px', marginBottom: 8,
                    }}
                  >
                    {SPINDLE_SPEED_FIELDS.map(([label, key]) => (
                      <SpindleNotSent
                        key={key} label={label} settingKey={key} settings={unsent}
                      />
                    ))}
                  </div>
                  <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                    <table
                      className="mform-axis-table"
                      data-testid="machine-def-panel-spindle-command-outputs"
                      style={{ width: 'max-content', minWidth: '100%' }}
                      {...emptyMarked(unsent, commandOutputRows.flatMap(([, port, pin, negate]) => [
                        `Spindlesetupsettings.${port}`,
                        `Spindlesetupsettings.${pin}`,
                        `Spindlesetupsettings.${negate}`,
                      ]))}
                    >
                      <thead><tr><th>Command output</th><th>port</th><th>pin</th><th>active low</th></tr></thead>
                      <tbody>
                        {commandOutputRows.map(([label, port, pin, negate]) => (
                          <tr key={label}
                            {...rowEmptyMarked(unsent, [
                              `Spindlesetupsettings.${port}`,
                              `Spindlesetupsettings.${pin}`,
                              `Spindlesetupsettings.${negate}`,
                            ])}
                          >
                            <td>{label}</td>
                            {[port, pin, negate].map((key) => (
                              <td key={key}>
                                <SpindleNotSent
                                  label="" settingKey={key} settings={unsent}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div
                  data-testid="machine-def-panel-spindle-feedback"
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(300px, 1fr)', gap: 18, marginTop: 12 }}
                >
                  <div>
                    <SectionHead
                      title="Encoder feedback"
                      summary="Quadrature input and scale"
                      testId="machine-def-panel-spindle-head-encoder"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-spindle-encoder-none"
                      settings={unsent}
                      keys={sectionKeys(SPINDLE_ENCODER_FIELDS, 'Spindlesetupsettings')}
                      noun="encoder settings"
                    />
                    <div
                      style={{ display: 'grid', gap: 5 }}
                      {...emptyMarked(unsent, sectionKeys(SPINDLE_ENCODER_FIELDS, 'Spindlesetupsettings'))}
                    >
                      {SPINDLE_ENCODER_FIELDS.map(([label, key]) => (
                        <SpindleNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>
                  <div>
                    <SectionHead
                      title="PID feedback"
                      summary="Closed-loop spindle tuning"
                      testId="machine-def-panel-spindle-head-pid"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-spindle-pid-none"
                      settings={unsent}
                      keys={sectionKeys(SPINDLE_PID_FIELDS, 'SpindlePIDsettings')}
                      noun="PID settings"
                    />
                    <div
                      style={{ display: 'grid', gap: 5 }}
                      {...emptyMarked(unsent, sectionKeys(SPINDLE_PID_FIELDS, 'SpindlePIDsettings'))}
                    >
                      {SPINDLE_PID_FIELDS.map(([label, key]) => (
                        <SpindleNotSent
                          key={key} label={label} settingKey={key}
                          section="SpindlePIDsettings" settings={unsent}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div data-testid="machine-def-panel-spindle-pulleys" style={{ marginTop: 12 }}>
                  {/* "15 configured speed ranges" was a HARDCODED STRING and it
                      was a lie whenever the record held none - which is how
                      Operator found it on 2026-08-29, reading fifteen empty rows
                      under a heading that said they were configured. 15 is the
                      number of ROWS UCCNC has, not the number anyone set. Count
                      what is actually stated; the row count is the table's job
                      to show, not the heading's to claim. */}
                  <SectionHead
                    title="Pulley ranges"
                    summary={(() => {
                      const set = SPINDLE_PULLEY_ROWS.filter((row) =>
                        ['Pulleyratio', 'Pulleyminvel', 'Pulleymaxvel'].some(
                          (stem) => unsent.read(`Spindlesetupsettings.${stem}${row}`) !== null,
                        ),
                      ).length
                      return set === 0
                        ? `no speed ranges set - ${SPINDLE_PULLEY_ROWS.length} slots this controller can hold`
                        : `${set} of ${SPINDLE_PULLEY_ROWS.length} speed ranges set`
                    })()}
                    testId="machine-def-panel-spindle-head-pulleys"
                  />
                  <SectionNoneSet
                    testId="machine-def-panel-spindle-pulleys-none"
                    settings={unsent}
                    keys={[
                      'Spindlesetupsettings.Usepulleys',
                      'Spindlesetupsettings.Pulleyinuse',
                      ...SPINDLE_PULLEY_ROWS.flatMap((row) => (
                        ['Pulleyratio', 'Pulleyminvel', 'Pulleymaxvel']
                          .map((stem) => `Spindlesetupsettings.${stem}${row}`)
                      )),
                    ]}
                    noun="pulley settings"
                  />
                  <div
                    {...emptyMarked(unsent, [
                      'Spindlesetupsettings.Usepulleys',
                      'Spindlesetupsettings.Pulleyinuse',
                    ])}
                    style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 18px', marginBottom: 8 }}
                  >
                    <SpindleNotSent
                      label="use pulley ranges" settingKey="Usepulleys" settings={unsent}
                    />
                    <SpindleNotSent
                      label="active pulley" settingKey="Pulleyinuse" settings={unsent}
                    />
                  </div>
                  <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
                    <table
                      className="mform-axis-table"
                      data-testid="machine-def-panel-spindle-pulley-table"
                      style={{ width: 'max-content', minWidth: '100%' }}
                      {...emptyMarked(unsent, SPINDLE_PULLEY_ROWS.flatMap((row) => (
                        ['Pulleyratio', 'Pulleyminvel', 'Pulleymaxvel']
                          .map((stem) => `Spindlesetupsettings.${stem}${row}`)
                      )))}
                    >
                      <thead><tr><th>Pulley</th><th>ratio</th><th>minimum velocity</th><th>maximum velocity</th></tr></thead>
                      <tbody>
                        {SPINDLE_PULLEY_ROWS.map((row) => (
                          <tr
                            key={row}
                            data-testid={`machine-def-panel-spindle-pulley-row-${row}`}
                            {...rowEmptyMarked(unsent, ['Pulleyratio', 'Pulleyminvel', 'Pulleymaxvel']
                              .map((stem) => `Spindlesetupsettings.${stem}${row}`))}
                          >
                            <td>{row}</td>
                            {['Pulleyratio', 'Pulleyminvel', 'Pulleymaxvel'].map((stem) => (
                              <td key={stem}>
                                <SpindleNotSent
                                  label="" settingKey={`${stem}${row}`} settings={unsent}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div></>
  )
}

