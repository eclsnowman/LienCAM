import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { SectionHead } from './DefinitionFields'
import { MacroLoopsTable } from './AutomationFields'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { DIGITIZE_AXIS_FIELDS } from './AutomationFields'
import { DIGITIZE_FORMAT_FIELDS } from './AutomationFields'
import { emptyMarked } from './DefinitionFields'
import { ProfileNotSent } from './AutomationFields'
import { LASER_ENGRAVE_FIELDS } from './AutomationFields'
import { RFH_FIELDS } from './AutomationFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


type AutomationSectionProps = Pick<MachineDefinitionPanelState, 'unsent'>

export function AutomationSection({ unsent }: AutomationSectionProps) {
  useText('control-screens-not-probing')
  return (
    <><div data-testid="machine-def-panel-plugins-automation" style={{ marginTop: 12 }}>
                  <SectionHead
                    title={controlText('AutomationSection.text001')}
                    summary="Automatic macros, digitizing output, laser engraving and RFH"
                    testId="machine-def-panel-head-plugins-automation"
                  />

                  <div data-testid="machine-def-panel-macro-loop-section">
                    <SectionHead
                      title={controlText('AutomationSection.text002')}
                      summary="48 controller slots; configured actions stay in view"
                      testId="machine-def-panel-head-macro-loops"
                    />
                    <MacroLoopsTable settings={unsent} />
                  </div>

                  <div data-testid="machine-def-panel-digitize" style={{ marginTop: 12 }}>
                    <SectionHead
                      title={controlText('AutomationSection.text003')}
                      summary="Axes, output file and numeric format recorded by the plugin"
                      testId="machine-def-panel-head-digitize"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-digitize-none"
                      settings={unsent}
                      keys={[
                        ...sectionKeys(DIGITIZE_AXIS_FIELDS, 'Digitizesettings'),
                        'Digitizesettings.Filenametosave',
                        ...sectionKeys(DIGITIZE_FORMAT_FIELDS, 'Digitizesettings'),
                      ]}
                      noun="digitizing settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(DIGITIZE_AXIS_FIELDS, 'Digitizesettings'))}
                    >
                      {DIGITIZE_AXIS_FIELDS.map(([label, key]) => (
                        <ProfileNotSent
                          key={key} label={label} section="Digitizesettings" settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                    <div style={{ marginTop: 5 }}>
                      <ProfileNotSent
                        label={controlText('AutomationSection.text004')} section="Digitizesettings" settingKey="Filenametosave" settings={unsent}
                      />
                    </div>
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                        gap: '5px 16px', marginTop: 5,
                      }}
                      {...emptyMarked(unsent, sectionKeys(DIGITIZE_FORMAT_FIELDS, 'Digitizesettings'))}
                    >
                      {DIGITIZE_FORMAT_FIELDS.map(([label, key]) => (
                        <ProfileNotSent
                          key={key} label={label} section="Digitizesettings" settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>

                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: 16, marginTop: 12,
                  }}>
                    <div data-testid="machine-def-panel-laser-engrave">
                      <SectionHead
                        title={controlText('AutomationSection.text005')}
                        summary="Workpiece, scan and feed settings"
                        testId="machine-def-panel-head-laser-engrave"
                      />
                      <SectionNoneSet
                        testId="machine-def-panel-laser-engrave-none"
                        settings={unsent}
                        keys={sectionKeys(LASER_ENGRAVE_FIELDS, 'Laserengraveplugin')}
                        noun="laser settings"
                      />
                      <div
                        style={{ display: 'grid', gap: 5 }}
                        {...emptyMarked(unsent, sectionKeys(LASER_ENGRAVE_FIELDS, 'Laserengraveplugin'))}
                      >
                        {LASER_ENGRAVE_FIELDS.map(([label, key]) => (
                          <ProfileNotSent
                            key={key} label={label} section="Laserengraveplugin" settingKey={key} settings={unsent}
                          />
                        ))}
                      </div>
                    </div>

                    <div data-testid="machine-def-panel-rfh">
                      <SectionHead
                        title={controlText('AutomationSection.text006')}
                        summary="Controller-recorded spindle and initial-move behavior"
                        testId="machine-def-panel-head-rfh"
                      />
                      <SectionNoneSet
                        testId="machine-def-panel-rfh-none"
                        settings={unsent}
                        keys={sectionKeys(RFH_FIELDS, 'RFHsettings')}
                        noun="RFH settings"
                      />
                      <div
                        style={{ display: 'grid', gap: 5 }}
                        {...emptyMarked(unsent, sectionKeys(RFH_FIELDS, 'RFHsettings'))}
                      >
                        {RFH_FIELDS.map(([label, key]) => (
                          <ProfileNotSent
                            key={key} label={label} section="RFHsettings" settingKey={key} settings={unsent}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div></>
  )
}

