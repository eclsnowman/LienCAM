import { liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { type SettingSource } from './DefinitionFields'
import { NotSent } from './DefinitionFields'
import { useHeldRow } from './IoFields'
import { useState } from 'react'


/** UCCNC's fifteen configurable fault inputs. They are on the definition's
 * typed model and editable here (WO-1039), and nothing drives them yet: Apply
 * carries the value, the bridge does not act on it. Keep the controller's key
 * stems here rather than translating them into a second data model - driving a
 * field later means giving it a bridge contract and `data-wired`, not renaming
 * it. */
export const FAULT_SIGNAL_FIELDS = liveCatalog(() => ([
  ['Enable',      controlText('AutomationFields.text001')],
  ['Port',        controlText('AutomationFields.text002')],
  ['Pin',         controlText('AutomationFields.text003')],
  ['ActiveLow',   controlText('AutomationFields.text004')],
  ['Description', controlText('AutomationFields.text005')],
  ['Action',      controlText('AutomationFields.text006')],
  ['StartDelay',  controlText('AutomationFields.text007')],
  ['ActionDelay', controlText('AutomationFields.text008')],
  ['LED',         controlText('AutomationFields.text009')],
  ['Invert',      controlText('AutomationFields.text010')],
] as const))

export const FAULT_SIGNAL_ROWS = Array.from({ length: 15 }, (_, index) => index + 1)

/** The last controller/plugin records in the profile census (WO-956). They
 * are on the definition's typed model and editable here (WO-1039); none of
 * them drives anything, so none can become an accidental control path.
 *
 * Macro loops deserve the strongest treatment here. An autorun flag means the
 * controller may run a macro without an operator pressing anything, so an
 * autorun row is an EDIT TO A RECORD and never a button - there is nothing on
 * this page that starts one - and the real configured rows remain open to
 * view. The unused rows use one disclosure, as the trigger tables do, instead
 * of turning a single configured action into 48 rows of visual noise. */
export const MACRO_LOOP_ROWS = Array.from({ length: 48 }, (_, index) => index)
export const AUX_ENCODER_ROWS = Array.from({ length: 6 }, (_, index) => index + 1)

export const DIGITIZE_AXIS_FIELDS = liveCatalog(() => ([
  [controlText('AutomationFields.text011'), 'Addaxisnames'],
  [controlText('AutomationFields.text012'), 'Xinclude'],
  [controlText('AutomationFields.text013'), 'Yinclude'],
  [controlText('AutomationFields.text014'), 'Zinclude'],
  [controlText('AutomationFields.text015'), 'Ainclude'],
  [controlText('AutomationFields.text016'), 'Binclude'],
  [controlText('AutomationFields.text017'), 'Cinclude'],
] as const))

export const DIGITIZE_FORMAT_FIELDS = liveCatalog(() => ([
  [controlText('AutomationFields.text018'), 'Commaseparation'],
  [controlText('AutomationFields.text019'), 'Numberofdigits'],
  [controlText('AutomationFields.text020'), 'Probedia'],
  [controlText('AutomationFields.text021'), 'Clearfilenamewhenfinished'],
] as const))

export const LASER_ENGRAVE_FIELDS = liveCatalog(() => ([
  [controlText('AutomationFields.text022'), 'workpiecewidth'],
  [controlText('AutomationFields.text023'), 'workpieceheight'],
  [controlText('AutomationFields.text024'), 'keepaspectratio'],
  [controlText('AutomationFields.text025'), 'Yscandistance'],
  [controlText('AutomationFields.text026'), 'Feedrate'],
  [controlText('AutomationFields.text027'), 'Originsetting'],
] as const))

export const RFH_FIELDS = liveCatalog(() => ([
  [controlText('AutomationFields.text028'), 'Switchspindlemode'],
  [controlText('AutomationFields.text029'), 'Doinitialmoveswithrapid'],
] as const))

export function ProfileNotSent({ label, section, settingKey, settings }: {
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

export function macroLoopConfigured(row: number, settings: SettingSource): boolean {
  const autorun = settings.read(`Macroloops.Macroloopautorun${row}`)
  const macro = settings.read(`Macroloops.Macroloopnumber${row}`)
  return (autorun !== null && !['', 'false', '0'].includes(autorun.toLowerCase()))
    || (macro !== null && macro !== '' && macro !== '0')
}

export function MacroLoopRows({ rows, settings, drawnConfigured, held }: {
  rows: readonly number[]
  settings: SettingSource
  /** Which of the two macro-loop tables this is - see `useHeldRow`. */
  drawnConfigured: boolean
  held: ReturnType<typeof useHeldRow>
}) {
  return (
    <tbody>
      {rows.map((row) => (
        <tr
          key={row}
          data-testid={`machine-def-panel-macro-loop-row-${row}`}
          onFocus={() => { held.hold(row, drawnConfigured) }}
          onBlur={(event) => { held.release(row, event) }}
        >
          <td className="mform-input-mono" style={{ color: 'var(--text-secondary)' }}>{row}</td>
          <td>
            <ProfileNotSent
              label="" section="Macroloops" settingKey={`Macroloopautorun${row}`} settings={settings}
            />
          </td>
          <td>
            <ProfileNotSent
              label="" section="Macroloops" settingKey={`Macroloopnumber${row}`} settings={settings}
            />
          </td>
        </tr>
      ))}
    </tbody>
  )
}

export function MacroLoopsTable({ settings }: {
  settings: SettingSource
}) {
  useText('control-screens-not-probing')
  const [showUnused, setShowUnused] = useState(false)
  const held = useHeldRow()
  const hasProfile = MACRO_LOOP_ROWS.some((row) =>
    settings.has(`Macroloops.Macroloopautorun${row}`)
    || settings.has(`Macroloops.Macroloopnumber${row}`))
  // What the slots say, and then where they are drawn - the same thing except
  // for the slot with the cursor in it, held still until it is done. Without
  // the hold, the first character of a macro number moved the row out from
  // under the cursor and the rest of the number went nowhere.
  const configuredNow = hasProfile
    ? MACRO_LOOP_ROWS.filter((row) => macroLoopConfigured(row, settings))
    : []
  const drawnConfigured = (row: number) => held.place(row, configuredNow.includes(row))
  const configured = MACRO_LOOP_ROWS.filter(drawnConfigured)
  const unused = MACRO_LOOP_ROWS.filter((row) => !drawnConfigured(row))
  const tableHead = (
    <thead><tr><th>{controlText('AutomationFields.text030')}</th><th>{controlText('AutomationFields.text031')}</th><th>{controlText('AutomationFields.text032')}</th></tr></thead>
  )

  return (
    <div data-testid="machine-def-panel-macro-loops">
      <div
        data-testid="machine-def-panel-macro-loop-safety"
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
      >{controlText('AutomationFields.text033')}</div>
      {configured.length > 0 && (
        <table
          className="mform-axis-table"
          data-testid="machine-def-panel-macro-loops-configured"
          style={{ width: 'max-content', minWidth: 360 }}
        >
          {tableHead}
          <MacroLoopRows rows={configured} settings={settings} drawnConfigured held={held} />
        </table>
      )}
      {hasProfile && configured.length === 0 && (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('AutomationFields.text034')}</div>
      )}
      <details
        data-testid="machine-def-panel-macro-loops-unused"
        style={{ marginTop: 6 }}
        onToggle={(e) => { setShowUnused(e.currentTarget.open) }}
      >
        <summary style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          {hasProfile
            ? controlText('AutomationFields.text035', { value1: String(unused.length), value2: String(unused.length === 1 ? '' : 's') })
            : controlText('AutomationFields.text036')}
        </summary>
        {/* BUILT WHEN IT IS OPENED, for the reason the trigger slots are.
            46 unused slots are 138 boxes behind a shut disclosure, rebuilt on
            every render of a page that already carries ~1489 of them. A
            `<details>` that is closed shows nothing either way, so there is no
            difference to see and a measurable one to feel. */}
        {showUnused && (
          <div style={{ overflowX: 'auto', paddingTop: 6, paddingBottom: 2 }}>
            <table
              className="mform-axis-table"
              data-testid="machine-def-panel-macro-loops-unused-table"
              style={{ width: 'max-content', minWidth: 360 }}
            >
              {tableHead}
              <MacroLoopRows rows={unused} settings={settings} drawnConfigured={false} held={held} />
            </table>
          </div>
        )}
      </details>
    </div>
  )
}
