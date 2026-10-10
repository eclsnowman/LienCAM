import { type AxisName } from '../../../types'
import { uccncSettingField } from '../../../lib/machine/uccncProfileImport'
import { type SettingSource } from './DefinitionFields'
import { NotSent } from './DefinitionFields'


export const PIN_FIELDS = [
  ['step',   'stepPin'],
  ['dir',    'dirPin'],
  ['home',   'homePin'],
  ['limit-', 'limitMinusPin'],
  ['limit+', 'limitPlusPin'],
  ['enable', 'enablePin'],
] as const

/** Every polarity key UCCNC can carry for an axis. Which ones get their own
 * box here is decided by the named pin fields, not by the axis name: assigning
 * a pin moves its polarity onto the pin triple, and an unassigned pin's
 * polarity is a typed setting on the definition, boxed here and editable. */
export const AXIS_PROFILE_POLARITY_FIELDS = [
  ['step', 'Steppinnegate'],
  ['direction', 'Dirpinnegate'],
  ['enable', 'Enapinnegate'],
  ['limit-', 'Limitminuspinnegate'],
  ['limit+', 'Limitpluspinnegate'],
  ['home', 'Homepinnegate'],
  ['curr hi/lo', 'Currhilowpinnegate'],
] as const

/**
 * WHICH POLARITY KEYS THIS AXIS'S CONTROLLER HAS - and ONLY that question.
 *
 * `Currhilowpinnegate` is the drive current hi/lo output's polarity and
 * nothing on `ControllerDefinition` holds it; `Steppinnegate` is held by the
 * step pin's triple. Before WO-1039 the hi/lo key appeared only when a profile
 * had stated it, which meant a machine somebody was building FROM SCRATCH
 * could never state it - the one thing Operator asked this page to make possible.
 * The catalogue is what decides, so an axis is offered exactly the polarities
 * its controller has.
 *
 * WHO OWNS EACH OF THEM IS NOT ASKED HERE ANY MORE. This function used to
 * carry half of that rule (`ownedBy === null || settings.has(key)`) while the
 * IO section carried its own broken half, which is how an assigned Probe 2
 * ended up with two negate editors (audit 2026-08-27). `SettingSource.
 * ownedElsewhere` is the one place that question is answered now, and every
 * box on the page goes through it.
 */
export function unsentAxisPolarityFields(
  axis: AxisName,
): readonly (readonly [string, string])[] {
  const section = `axessettingscontrol${axis}`
  return AXIS_PROFILE_POLARITY_FIELDS.filter(
    ([, key]) => uccncSettingField(`${section}.${key}`) !== undefined,
  )
}

/** The subset of a fixed field list THIS AXIS'S CONTROLLER ACTUALLY HAS.
 *  UCCNC gives `Rotaryaxis` to A, B and C and the drag knife to A alone, so
 *  offering X a rotary box invites somebody to state a machine fact that has
 *  no key to be written to. It cost nothing while these were readouts showing
 *  an em-dash; it is a lie now that they are boxes. */
export function axisCatalogueFields(
  axis: AxisName,
  fields: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  return fields.filter(([, key]) =>
    uccncSettingField(`axessettingscontrol${axis}.${key}`) !== undefined)
}

export const AXIS_ROTARY_PROFILE_FIELDS = [
  ['rotary', 'Rotaryaxis'],
  ['rollover', 'Rotaryrollover'],
] as const

/** The drive's current-select output is one physical fact: two coordinates
 * plus its active polarity. Keep the three controller spellings together in
 * the per-axis drawer so a locally authored definition can state or clear the
 * same values a `.pro` import supplies. */
export const AXIS_CURRENT_HI_LOW_PROFILE_FIELDS = [
  ['', 'Currhilowportnumber'],
  ['', 'Currhilowpinnumber'],
  ['negate', 'Currhilowpinnegate'],
] as const

export const AXIS_DRAG_KNIFE_PROFILE_FIELDS = [
  ['enabled', 'Dragknifeenabled'],
  ['stop angle', 'Dragknifestopatangle'],
  ['retract angle', 'Dragkniferetractatangle'],
  ['retract height', 'Dragkniferetractheight'],
  ['move-back feed', 'Dragknifemovebackfeedrate'],
  ['pull-out feed', 'Dragknifepulloutfeedrate'],
] as const

/**
 * A BLOCK OF PROFILE-ONLY FACTS THAT BELONG TO ONE AXIS - and WO-1050 gave it
 * a shut state.
 *
 * Operator, 2026-08-27 at the machine: *"the drag knife info is verbose and takes
 * up a ton of space"*, and of the axes he has switched off, *"B and C are off
 * on this machine and currently render every feature block at full width."*
 * Six labelled boxes stacked three deep make the A row three lines tall on a
 * machine that has never had a knife on it, and a disabled axis pays the same
 * height as a working one.
 *
 * `collapsed` DOES NOT MEAN UNMOUNTED. The boxes are rendered either way and a
 * shut `<details>` is the browser hiding them, so nothing is removed from the
 * page, from the tab order once opened, or from `tools/pro-coverage.mjs`'s
 * reading of what this page exposes. That distinction is the whole reason this
 * is a disclosure rather than a filter: Operator's ruling that Control shows
 * EVERYTHING is untouched, and the one thing WO-1050 names as a FAIL is
 * density bought by scattering a logical group. All six drag-knife fields stay
 * in ONE cell on the axis they describe.
 *
 * THE SHUT ROW SAYS WHAT IS INSIDE, counted off the record rather than
 * guessed - a summary that says "6 settings" over four empty boxes and two
 * stated ones is the collapsed-summary lie WO-959 went after.
 */
export function AxisProfileReadouts({ axis, fields, settings, testId, label, collapsed = false }: {
  axis: AxisName
  fields: readonly (readonly [string, string])[]
  settings: SettingSource
  testId: string
  /** What the shut row calls this block. Only read when `collapsed`. */
  label?: string
  collapsed?: boolean
}) {
  // WHAT THIS CELL ACTUALLY DRAWS. `SettingBox` returns null for a key another
  // named field owns, so asking here is what keeps the summary's count and the
  // opened contents the same number.
  const drawn = settings.catalogued
    ? fields.filter(([, key]) =>
      !settings.ownedElsewhere(`axessettingscontrol${axis}.${key}`))
    : []
  const stated = drawn.filter(([, key]) =>
    settings.has(`axessettingscontrol${axis}.${key}`)).length

  const grid = (
    <div
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, max-content)',
        columnGap: 10, rowGap: 2,
      }}
    >
      {fields.map(([fieldLabel, key]) => (
        <NotSent
          key={key}
          label={fieldLabel}
          settings={settings}
          settingKey={`axessettingscontrol${axis}.${key}`}
        />
      ))}
    </div>
  )

  // NOTHING TO DISCLOSE IS NOT A DISCLOSURE. An axis whose controller has none
  // of these keys keeps its empty cell rather than growing a row that opens on
  // nothing - and the cell itself stays, because a table column may not lose
  // its cells under one row.
  if (!collapsed || drawn.length === 0) return <div data-testid={testId}>{grid}</div>

  return (
    <details data-testid={testId} data-collapsed="">
      <summary
        style={{
          fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)',
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
        data-tooltip={`${drawn.length} ${label ?? 'profile'} settings for ${axis}`
          + ' - stored with this machine definition; nothing in this software drives them yet.'}
      >
        {label ?? 'profile'} - {stated === 0 ? 'none' : stated} of {drawn.length} set
      </summary>
      {grid}
    </details>
  )
}
