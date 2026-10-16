import { liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { type SettingSource } from './DefinitionFields'
import { NotSent } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import { SectionNoneSet } from './DefinitionFields'
import { sectionKeys } from './DefinitionFields'
import { emptyMarked } from './DefinitionFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


/** `[Generalsettings]` is UCCNC's mixed machine-wide section. Do not repeat
 * that hodgepodge in the UI: keep each value beside the concern it affects.
 * These are stored with the definition and drive nothing until the bridge
 * grows a contract for them - except `Linearerror`, which the path-tolerance
 * read already follows (`refreshPathToleranceFromMachine`). The homing
 * sequence is deliberately absent because it already lives in
 * `ControllerDefinition.homing.order` and is sent by the homing path. */
export const GENERAL_TRAJECTORY_FIELDS = liveCatalog(() => ([
  [controlText('GeneralSection.text001'), 'Constantvelocitymode'],
  [controlText('GeneralSection.text002'), 'Stopatangle'],
  [controlText('GeneralSection.text003'), 'Lookaheadlines'],
  [controlText('GeneralSection.text004'), 'Linearerror'],
  [controlText('GeneralSection.text005'), 'Cornerserror'],
  [controlText('GeneralSection.text006'), 'USBbuffersize'],
  [controlText('GeneralSection.text007'), 'MaxLinearaddlenght'],
  [controlText('GeneralSection.text008'), 'MaxLinearunificationlenght'],
  [controlText('GeneralSection.text009'), 'Arcradiustolerance'],
  [controlText('GeneralSection.text010'), 'G41G42roundjoints'],
] as const))

export const GENERAL_PROGRAM_FIELDS = liveCatalog(() => ([
  [controlText('GeneralSection.text011'), 'Doontoolchange'],
  [controlText('GeneralSection.text012'), 'SafeZ'],
  [controlText('GeneralSection.text013'), 'G73_backoff'],
  [controlText('GeneralSection.text014'), 'Dwellinseconds'],
  [controlText('GeneralSection.text015'), 'Runmodewhenunknowngcode'],
  [controlText('GeneralSection.text016'), 'Softlimitsgcodeprecheck'],
  [controlText('GeneralSection.text017'), 'ResetG68onfileload'],
  [controlText('GeneralSection.text018'), 'ResetG51onfileload'],
  [controlText('GeneralSection.text019'), 'ResetG94onfileload'],
  [controlText('GeneralSection.text020'), 'Precompilemacrosonstartup'],
] as const))

export const GENERAL_CONTROLLER_FIELDS = liveCatalog(() => ([
  [controlText('GeneralSection.text021'), 'POSDROsdigits'],
  [controlText('GeneralSection.text022'), 'Kernelfreq'],
  [controlText('GeneralSection.text023'), 'Maximisescreenonstartup'],
] as const))

export const GENERAL_HOMING_POLICY_FIELDS = liveCatalog(() => ([
  [controlText('GeneralSection.text024'), 'Softlimitsenable'],
  [controlText('GeneralSection.text025'), 'CheckHomeonCycleStart'],
  [controlText('GeneralSection.text026'), 'ResetDereferenceHomes'],
  [controlText('GeneralSection.text027'), 'Mandatoryhoming'],
] as const))

export const GENERAL_DEBOUNCE_FIELDS = liveCatalog(() => ([
  [controlText('GeneralSection.text028'), 'Debounce'],
  [controlText('GeneralSection.text029'), 'DebounceTHC'],
  [controlText('GeneralSection.text030'), 'DebounceHome'],
  [controlText('GeneralSection.text031'), 'DebounceProbe1'],
  [controlText('GeneralSection.text032'), 'DebounceProbe2'],
] as const))

export function GeneralNotSent({ label, settingKey, settings }: {
  label: string
  settingKey: string
  settings: SettingSource
}) {
  return (
    <NotSent
      label={label}
      settings={settings}
      settingKey={`Generalsettings.${settingKey}`}
    />
  )
}

type GeneralSectionProps = Pick<MachineDefinitionPanelState, 'unsent'>

export function GeneralSection({ unsent }: GeneralSectionProps) {
  useText('control-screens-not-probing')
  return (
    <><div data-testid="machine-def-panel-general-motion" style={{ marginTop: 12 }}>
                  <SectionHead
                    title={controlText('GeneralSection.text033')}
                    summary="Path blending, lookahead, tolerances and controller buffering"
                    testId="machine-def-panel-general-head-trajectory"
                  />
                  <SectionNoneSet
                    testId="machine-def-panel-general-trajectory-none"
                    settings={unsent}
                    keys={sectionKeys(GENERAL_TRAJECTORY_FIELDS, 'Generalsettings')}
                    noun="trajectory settings"
                  />
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                      gap: '5px 16px',
                    }}
                    {...emptyMarked(unsent, sectionKeys(GENERAL_TRAJECTORY_FIELDS, 'Generalsettings'))}
                  >
                    {GENERAL_TRAJECTORY_FIELDS.map(([label, key]) => (
                      <GeneralNotSent
                        key={key} label={label} settingKey={key} settings={unsent}
                      />
                    ))}
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <SectionHead
                      title={controlText('GeneralSection.text034')}
                      summary="File loading, tool changes, canned cycles and unknown codes"
                      testId="machine-def-panel-general-head-program"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-general-program-none"
                      settings={unsent}
                      keys={sectionKeys(GENERAL_PROGRAM_FIELDS, 'Generalsettings')}
                      noun="program settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(GENERAL_PROGRAM_FIELDS, 'Generalsettings'))}
                    >
                      {GENERAL_PROGRAM_FIELDS.map(([label, key]) => (
                        <GeneralNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <SectionHead
                      title={controlText('GeneralSection.text035')}
                      summary="Profile-level controller presentation and startup behavior"
                      testId="machine-def-panel-general-head-controller"
                    />
                    <SectionNoneSet
                      testId="machine-def-panel-general-controller-none"
                      settings={unsent}
                      keys={sectionKeys(GENERAL_CONTROLLER_FIELDS, 'Generalsettings')}
                      noun="startup settings"
                    />
                    <div
                      style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                        gap: '5px 16px',
                      }}
                      {...emptyMarked(unsent, sectionKeys(GENERAL_CONTROLLER_FIELDS, 'Generalsettings'))}
                    >
                      {GENERAL_CONTROLLER_FIELDS.map(([label, key]) => (
                        <GeneralNotSent
                          key={key} label={label} settingKey={key} settings={unsent}
                        />
                      ))}
                    </div>
                  </div>
                </div></>
  )
}

