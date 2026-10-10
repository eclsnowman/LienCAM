import { SectionHead } from './DefinitionFields'
import { AXIS_NAMES } from '../../../types'
import { NotSentLegend } from './DefinitionFields'
import { axisColorVar } from './DefinitionFields'
import { AxisProfileReadouts } from './AxisProfileFields'
import { axisCatalogueFields } from './AxisProfileFields'
import { AXIS_ROTARY_PROFILE_FIELDS } from './AxisProfileFields'
import { NotSent } from './DefinitionFields'
import { AXIS_DRAG_KNIFE_PROFILE_FIELDS } from './AxisProfileFields'
import { CoolantCapabilitySection } from './CoolantCapabilitySection'
import { OutputsSection } from './OutputsSection'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


// WO-1690 - THE AXIS TABLE RETIRED FROM HERE, TO THE MACHINE AREA.
//
// v2/SLICES.md T7 moved every NAMED axis field - use, steps, speed, accel,
// enable delay, backlash, slave - onto `MachineArea.tsx`'s one table. What is
// left here is the UCCNC catalogue's OWN per-axis extras (rotary profile,
// comp accel, drag knife): fields this software cannot yet send to a
// controller, so they stay with the rest of the not-yet-migrated catalogue on
// this Legacy tab (T6 "All settings" is where they eventually go) rather than
// crowding a table built to show what a machinist actually changes. They
// exist only for a machine whose controller the catalogue describes - see
// `SettingSource.catalogued` - so this whole block renders nothing for a
// machine that is not one, the same as the retired table did.
type MotionSectionProps = Pick<MachineDefinitionPanelState, 'absentAxisRow' | 'draft' | 'editDraft' | 'enabledAxes' | 'notAcceptedCount' | 'unsent'> & { def: NonNullable<MachineDefinitionPanelState['def']> }

export function MotionSection({ absentAxisRow, def, draft, editDraft, enabledAxes, notAcceptedCount, unsent }: MotionSectionProps) {
  return (
    <><div data-testid="machine-def-group-motion">
                <SectionHead
                  title="Motion"
                  summary={`${enabledAxes.map((a) => a.axis).join('') || 'none'} enabled of ${AXIS_NAMES.length}`}
                  testId="machine-def-panel-head-axes"
                />
                <NotSentLegend
                  testId="machine-def-motion-unsent-legend"
                  settings={unsent}
                  unmodelled={unsent.hasTextOnly()}
                  notAccepted={notAcceptedCount}
                />
                {unsent.catalogued && (
                  <table
                    className="mform-axis-table"
                    data-testid="machine-def-panel-motion-table"
                    style={{ width: 'auto' }}
                  >
                    <thead>
                      <tr>
                        <th data-tooltip="Use this axis on this machine">Axis</th>
                        <th data-tooltip="Rotary-axis and rollover flags read from this axis's profile section. This software cannot send them to the controller yet.">rotary profile</th>
                        <th data-tooltip="axessettingscontrol<axis>.Compaccel - read from this machine's profile. This software cannot send it to the controller yet.">comp accel</th>
                        <th data-tooltip="Drag-knife settings read from this axis's profile section. This software cannot send them to the controller yet.">drag knife</th>
                      </tr>
                    </thead>
                    <tbody>
                      {AXIS_NAMES.map((name) => {
                        const a = def.axes.find((x) => x.axis === name)
                        if (!a) return absentAxisRow(name, 3)
                        return (
                          <tr
                            key={name}
                            data-testid={`machine-def-panel-axis-catalogue-${name}`}
                            data-axis-enabled={a.enabled ? '' : undefined}
                            style={{ opacity: a.enabled ? 1 : 0.72 }}
                          >
                            <td className="mform-axis-label" style={{ color: axisColorVar(name) }}>
                              {name}
                            </td>
                            <td>
                              <AxisProfileReadouts
                                axis={name}
                                fields={axisCatalogueFields(name, AXIS_ROTARY_PROFILE_FIELDS)}
                                settings={unsent}
                                testId={`machine-def-panel-axis-rotary-${name}`}
                                label="rotary"
                                collapsed={!a.enabled}
                              />
                            </td>
                            <td>
                              <NotSent
                                label="" settings={unsent}
                                settingKey={`axessettingscontrol${name}.Compaccel`}
                              />
                            </td>
                            <td>
                              {/* ALWAYS SHUT, enabled axis or not. Six boxes
                                  three rows deep is the tallest thing in
                                  this table and it describes a tool almost
                                  no machine here carries - WO-1050. */}
                              <AxisProfileReadouts
                                axis={name}
                                fields={axisCatalogueFields(name, AXIS_DRAG_KNIFE_PROFILE_FIELDS)}
                                settings={unsent}
                                testId={`machine-def-panel-axis-drag-knife-${name}`}
                                label="drag knife"
                                collapsed
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}

                {/* WO-965: does this machine even have coolant? Its own
                    rows, grouped by setting type (Operator, 2026-08-27), sitting
                    immediately above the `.pro`'s own spindle record - which
                    is where its evidence is. */}
                <CoolantCapabilitySection
                  machine={draft}
                  onChange={editDraft}
                  settings={unsent}
                />

                {/* WO-1651: the machine's own output list - flood, mist, a
                    vacuum, a pump, air, whatever this machine actually
                    switches. Renders whenever a controller definition exists,
                    the same rule the Coolant section above follows, because
                    an output has no meaning without one. */}
                <OutputsSection machine={draft} onChange={editDraft} />
              </div></>
  )
}
