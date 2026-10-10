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
export const GENERAL_TRAJECTORY_FIELDS = [
  ['constant velocity mode', 'Constantvelocitymode'],
  ['stop at angle', 'Stopatangle'],
  ['lookahead lines', 'Lookaheadlines'],
  ['linear error', 'Linearerror'],
  ['corner error', 'Cornerserror'],
  ['USB buffer size', 'USBbuffersize'],
  ['maximum linear add length', 'MaxLinearaddlenght'],
  ['maximum linear unification length', 'MaxLinearunificationlenght'],
  ['arc radius tolerance', 'Arcradiustolerance'],
  ['round G41/G42 joints', 'G41G42roundjoints'],
] as const

export const GENERAL_PROGRAM_FIELDS = [
  ['tool-change behavior', 'Doontoolchange'],
  ['safe Z', 'SafeZ'],
  ['G73 backoff', 'G73_backoff'],
  ['dwell values are seconds', 'Dwellinseconds'],
  ['unknown G-code behavior', 'Runmodewhenunknowngcode'],
  ['precheck G-code against soft limits', 'Softlimitsgcodeprecheck'],
  ['reset G68 on file load', 'ResetG68onfileload'],
  ['reset G51 on file load', 'ResetG51onfileload'],
  ['reset G94 on file load', 'ResetG94onfileload'],
  ['precompile macros on startup', 'Precompilemacrosonstartup'],
] as const

export const GENERAL_CONTROLLER_FIELDS = [
  ['position DRO digits', 'POSDROsdigits'],
  ['kernel frequency', 'Kernelfreq'],
  ['maximize screen on startup', 'Maximisescreenonstartup'],
] as const

export const GENERAL_HOMING_POLICY_FIELDS = [
  ['soft limits enabled', 'Softlimitsenable'],
  ['require home before cycle start', 'CheckHomeonCycleStart'],
  ['clear home references on reset', 'ResetDereferenceHomes'],
  ['mandatory homing', 'Mandatoryhoming'],
] as const

export const GENERAL_DEBOUNCE_FIELDS = [
  ['general inputs', 'Debounce'],
  ['torch height control', 'DebounceTHC'],
  ['home switches', 'DebounceHome'],
  ['probe 1', 'DebounceProbe1'],
  ['probe 2', 'DebounceProbe2'],
] as const

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
  return (
    <><div data-testid="machine-def-panel-general-motion" style={{ marginTop: 12 }}>
                  <SectionHead
                    title="Trajectory planner"
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
                      title="Program execution"
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
                      title="Controller display and startup"
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

