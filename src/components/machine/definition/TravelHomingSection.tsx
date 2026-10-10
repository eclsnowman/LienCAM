import { NotSentLegend } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { GENERAL_HOMING_POLICY_FIELDS } from './GeneralSection'
import { emptyMarked } from './DefinitionFields'
import { GeneralNotSent } from './GeneralSection'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


// WO-1690 - EVERYTHING NAMED RETIRED FROM HERE, TO THE MACHINE AREA.
//
// v2/SLICES.md T7: home order, soft limits, the per-axis homing table and
// gantry skew all moved onto `MachineArea.tsx`, below its one axis table.
// What is left is `Generalsettings.*` HOMING POLICY - machine-wide, not
// per-axis, and a UCCNC catalogue fact this software cannot yet send - so it
// stays on this Legacy tab with the rest of the not-yet-migrated catalogue
// (T6 "All settings") rather than crowding the new area with a block that is
// not about any one axis. It renders nothing for a machine whose controller
// this catalogue does not describe, same as before.
type TravelHomingSectionProps = Pick<MachineDefinitionPanelState, 'notAcceptedCount' | 'unsent'>

export function TravelHomingSection({ notAcceptedCount, unsent }: TravelHomingSectionProps) {
  return (
    <><div data-testid="machine-def-group-travel">
                <SectionHead
                  title="Travel & Homing"
                  summary={unsent.catalogued ? 'Homing policy' : 'Nothing on this tab for this controller'}
                  testId="machine-def-panel-head-homing"
                />
                <NotSentLegend
                  testId="machine-def-travel-unsent-legend"
                  settings={unsent}
                  includeBoxedApplyClaim={false}
                  unmodelled={unsent.hasTextOnly()}
                  notAccepted={notAcceptedCount}
                />

                {unsent.catalogued && (
                  <div data-testid="machine-def-panel-general-homing">
                    <SectionHead
                      title="Homing policy"
                      summary="Machine-wide requirements and soft-limit policy"
                      testId="machine-def-panel-general-head-homing"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-general-homing-none"
                      settings={unsent}
                      keys={sectionKeys(GENERAL_HOMING_POLICY_FIELDS, 'Generalsettings')}
                      noun="homing policy settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(GENERAL_HOMING_POLICY_FIELDS, 'Generalsettings'))}
                    >
                      {GENERAL_HOMING_POLICY_FIELDS.map(([label, key]) => (
                        <GeneralNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div></>
  )
}
