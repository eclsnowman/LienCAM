import { type SettingSource } from './DefinitionFields'
import { type FocusEvent as ReactFocusEvent } from 'react'
import { useState } from 'react'
import { NotSent } from './DefinitionFields'
import { SectionHead } from './DefinitionFields'
import { rowEmptyMarked } from './DefinitionFields'


export const IO_FIELDS = [
  ['E-stop',  'estop',  'e-stop'],
  ['Probe',   'probe',  'probe'],
  ['Probe 2', 'probe2', 'probe 2'],
] as const

export type IoPinReadoutRow = {
  label: string
  port: string
  pin: string
  negate: string
  extra?: readonly (readonly [label: string, key: string])[]
}

/** Pin-shaped IO settings nothing drives yet. The row labels say what each
 * signal DOES; UCCNC's spelling remains in the box's tooltip and test id,
 * where a person can still trace the value to its profile. */
export const IO_CONTROLLER_OUTPUT_ROWS: readonly IoPinReadoutRow[] = [
  {
    label: 'Primary charge pump',
    port: 'Chargepumpportnumber', pin: 'Chargepumppinnumber', negate: 'Chargepumppinnegate',
    extra: [
      ['laser mode', 'Chargepumplasermodeon'],
      ['always on', 'Chargepumpalwayson'],
    ],
  },
  {
    label: 'Secondary charge pump',
    port: 'Chargepump2portnumber', pin: 'Chargepump2pinnumber', negate: 'Chargepump2pinnegate',
  },
  {
    label: 'Drive current high/low',
    port: 'CurrentHiLoportnumber', pin: 'CurrentHiLopinnumber', negate: 'CurrentHiLopinnegate',
  },
  {
    label: 'Laser output',
    port: 'Laseroutputportnumber', pin: 'Laseroutputpinnumber', negate: 'Laseroutputpinnegate',
  },
]

export const IO_THC_INPUT_ROWS: readonly IoPinReadoutRow[] = [
  { label: 'Arc on', port: 'THConport', pin: 'THConpin', negate: 'THConpinnegate' },
  { label: 'Raise torch', port: 'THCupport', pin: 'THCuppin', negate: 'THCuppinnegate' },
  { label: 'Lower torch', port: 'THCdownport', pin: 'THCdownpin', negate: 'THCdownpinnegate' },
]

export const IO_THC_OUTPUT_ROWS: readonly IoPinReadoutRow[] = [
  {
    label: 'THC enable',
    port: 'THCenableoutport', pin: 'THCenableoutpin', negate: 'THCenableoutpinnegate',
  },
  {
    label: 'Anti-dive',
    port: 'THCantidiveoutport', pin: 'THCantidiveoutpin', negate: 'THCantidiveoutpinnegate',
  },
  {
    label: 'Anti-down',
    port: 'THCantidownoutport', pin: 'THCantidownoutpin', negate: 'THCantidownoutpinnegate',
  },
]

export const IO_THC_BEHAVIOR_FIELDS = [
  ['enabled', 'THCenable'],
  ['minimum correction', 'THCmin'],
  ['maximum correction', 'THCmax'],
  ['correction feed', 'THCfeed'],
  ['always on', 'THCalwayson'],
  ['arc-on delay', 'THCondelay'],
  ['delay enabled', 'THCdelayenable'],
  ['anti-dive enabled', 'THCantidiveenable'],
  ['anti-dive threshold', 'THCantidivepercent'],
  ['pierce height', 'Plasmapierceheight'],
  ['anti-down enabled', 'THCantidownenable'],
] as const

export const IO_OVERRIDE_ROWS = [
  ['Feed rate', 'FROchannel', 'FROminpercent', 'FROmaxpercent'],
  ['Spindle speed', 'SROchannel', 'SROminpercent', 'SROmaxpercent'],
  ['Jog rate', 'JROchannel', 'JROminpercent', 'JROmaxpercent'],
] as const

export const IO_ANALOG_ROWS = [
  ['Analog 1', 'Ana1invarnum', 'Ana1outvarnum'],
  ['Analog 2', 'Ana2invarnum', 'Ana2outvarnum'],
  ['Analog 3', 'Ana3invarnum', 'Ana3outvarnum'],
  ['Analog 4', 'Ana4invarnum', 'Ana4outvarnum'],
] as const

export const IO_DIGITAL_SYNC_ROWS = Array.from({ length: 10 }, (_, index) => index + 1)

/** UCCNC carries 96 physical-to-screen input mappings and 96 screen-to-
 * physical output mappings. They ride the typed model on the definition and
 * are edited here (WO-1039), and NOTHING DRIVES THEM: Apply carries the
 * definition, but no code in this software or in the bridge turns a trigger
 * row into machine behaviour, which is what `data-not-driven` says and why it
 * is not `data-wired` (WO-947 / WO-953). */
export const TRIGGER_ROWS = Array.from({ length: 96 }, (_, index) => index + 1)

export type TriggerSection = 'Inputtriggersettings' | 'Outputtriggersettings'

export const TRIGGER_TABLES = [
  {
    section: 'Inputtriggersettings',
    title: 'Input triggers',
    summary: 'Physical pins mapped to button presses',
    codeStem: 'Buttoncode',
    codeLabel: 'button code',
    polarityStem: 'Activelow',
    polarityLabel: 'active low',
    noun: 'input trigger',
  },
  {
    section: 'Outputtriggersettings',
    title: 'Output triggers',
    summary: 'Controller LEDs mapped to physical pins',
    codeStem: 'LEDcode',
    codeLabel: 'LED code',
    polarityStem: 'Invert',
    polarityLabel: 'invert',
    noun: 'output trigger',
  },
] as const satisfies readonly {
  section: TriggerSection
  title: string
  summary: string
  codeStem: 'Buttoncode' | 'LEDcode'
  codeLabel: string
  polarityStem: 'Activelow' | 'Invert'
  polarityLabel: string
  noun: string
}[]

export function triggerValue(
  settings: SettingSource,
  section: TriggerSection,
  stem: string,
  row: number,
): string | null {
  return settings.read(`${section}.${stem}${row}`)
}

/** A row is unused only when the profile explicitly says all three numeric
 * fields are zero and its polarity is false. Missing values are not silently
 * classified as empty: when a section exists they remain reachable as absent
 * readouts under the unused-slots disclosure. */
export function triggerRowConfigured(
  settings: SettingSource,
  spec: (typeof TRIGGER_TABLES)[number],
  row: number,
): boolean {
  const values = [
    triggerValue(settings, spec.section, 'Port', row),
    triggerValue(settings, spec.section, 'Pin', row),
    triggerValue(settings, spec.section, spec.codeStem, row),
    triggerValue(settings, spec.section, spec.polarityStem, row),
  ]
  if (values.every((value) => value === null)) return false
  return !(
    values[0] === '0'
    && values[1] === '0'
    && values[2] === '0'
    && (values[3] === 'False' || values[3] === 'false' || values[3] === '0')
  )
}

/**
 * A ROW BEING TYPED INTO IS HELD WHERE IT IS DRAWN (WO-1039, audit fix).
 *
 * The trigger and macro-loop tables sort their own rows: a slot that states
 * nothing is drawn under the unused-slots disclosure, a slot that states
 * something is drawn in the configured table above it. That sort ran on every
 * keystroke, so the FIRST character typed into an unused slot reclassified its
 * row - React unmounted the box under the cursor and mounted a different one
 * in the other table, and the rest of the button code went nowhere. Nobody
 * could enter a multi-character button code, LED code, port or macro number
 * into a new row; only a paste or a whole-value change got through, which is
 * all the counting suites ever did, so the tables counted as editable while
 * being untypeable. That made this order's from-scratch claim false for the
 * two tables a from-scratch machine most needs to fill in.
 *
 * So the sort is HELD for the one row that has the cursor, at the
 * classification it was drawn with when the cursor arrived, and released the
 * moment focus leaves the row. Nothing is un-classified and no verdict is
 * softened: the row joins its proper table on blur - one event later, and the
 * moment a person is done with it. The hold is one row deep because only one
 * row can have the cursor.
 */
export function useHeldRow(): {
  /** Where the row is drawn: its own classification, unless it is the row with
   *  the cursor, which stays where it already was. */
  place: (row: number, configured: boolean) => boolean
  /** The cursor arrived in this row, which is drawn in the configured table
   *  when `drawnConfigured`. */
  hold: (row: number, drawnConfigured: boolean) => void
  /** The cursor may have left this row - it has, unless it landed in another
   *  box of the SAME row, which is tabbing across a row, not leaving it. */
  release: (row: number, event: ReactFocusEvent<HTMLElement>) => void
} {
  const [held, setHeld] = useState<{ row: number, configured: boolean } | null>(null)
  return {
    place: (row, configured) => (held?.row === row ? held.configured : configured),
    hold: (row, drawnConfigured) => {
      setHeld((current) => (
        current?.row === row && current.configured === drawnConfigured
          ? current
          : { row, configured: drawnConfigured }
      ))
    },
    release: (row, event) => {
      // Tabbing from the port box to the pin box of the SAME row is not
      // leaving the row. React batches a focusout and the focusin that follows
      // it into one render, so the row usually survives either way - this says
      // it on purpose rather than leaning on that.
      if (event.currentTarget.contains(event.relatedTarget)) return
      setHeld((current) => (current?.row === row ? null : current))
    },
  }
}

export function TriggerRowsTable({ spec, rows, settings, testId, drawnConfigured, held }: {
  spec: (typeof TRIGGER_TABLES)[number]
  rows: readonly number[]
  settings: SettingSource
  testId: string
  /** Which of this section's two tables this is - what a row focused here is
   *  held as until the cursor leaves it. */
  drawnConfigured: boolean
  held: ReturnType<typeof useHeldRow>
}) {
  return (
    <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
      <table
        className="mform-axis-table"
        data-testid={testId}
        style={{ width: 'max-content', minWidth: '100%' }}
      >
        <thead>
          <tr>
            <th>#</th>
            <th>port</th>
            <th>pin</th>
            <th>{spec.codeLabel}</th>
            <th>{spec.polarityLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row}
              data-testid={`machine-def-panel-${spec.section}-row-${row}`}
              onFocus={() => { held.hold(row, drawnConfigured) }}
              onBlur={(event) => { held.release(row, event) }}
            >
              <td className="mform-input-mono" style={{ color: 'var(--text-secondary)' }}>
                {row}
              </td>
              {(['Port', 'Pin', spec.codeStem, spec.polarityStem] as const).map((stem) => (
                <td key={stem}>
                  <NotSent
                    label=""
                    settings={settings}
                    settingKey={`${spec.section}.${stem}${row}`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TriggerTable({ spec, settings }: {
  spec: (typeof TRIGGER_TABLES)[number]
  settings: SettingSource
}) {
  /**
   * A RECORD THAT STATES NOTHING HERE STILL GETS ITS 96 SLOTS (WO-1039).
   *
   * This used to render one sentence and no table, which was the honest thing
   * to do when the boxes were readouts: 96 rows of em-dashes said nothing the
   * sentence did not. It is the WRONG thing now. Operator's ask is that a full
   * machine definition can be built IN THIS SOFTWARE FROM SCRATCH, and a
   * machine with no `.pro` behind it has to be able to state its own triggers
   * - which it cannot do against a table that is not drawn.
   *
   * NOTHING IS FABRICATED BY DRAWING THEM. Every box is EMPTY, which is the
   * true answer for a slot nobody has configured; a row of zeros would be this
   * software inventing 384 machine facts, and that is the defect the empty box
   * exists to prevent. They arrive folded into the unused-slots disclosure,
   * exactly as an imported machine's unconfigured slots do, so a page nobody
   * asked about triggers is one line longer than before.
   */
  const [showUnused, setShowUnused] = useState(false)
  const held = useHeldRow()
  const carriesSection = settings.hasPrefix(`${spec.section}.`)
  // WHAT THE ROWS SAY, and then WHERE THEY ARE DRAWN - which is the same thing
  // except for the row with the cursor in it, held still until it is done.
  const configuredNow = carriesSection
    ? TRIGGER_ROWS.filter((row) => triggerRowConfigured(settings, spec, row))
    : []
  const drawnConfigured = (row: number) => held.place(row, configuredNow.includes(row))
  const configuredRows = TRIGGER_ROWS.filter(drawnConfigured)
  const unusedRows = TRIGGER_ROWS.filter((row) => !drawnConfigured(row))

  return (
    <div data-testid={`machine-def-panel-${spec.section}`}>
      <SectionHead
        title={spec.title}
        summary={spec.summary}
        testId={`machine-def-panel-head-${spec.section}`}
      />
      <>
          {configuredRows.length > 0 ? (
            <TriggerRowsTable
              spec={spec}
              rows={configuredRows}
              settings={settings}
              testId={`machine-def-panel-${spec.section}-configured`}
              drawnConfigured
              held={held}
            />
          ) : (
            <div
              data-testid={`machine-def-panel-${spec.section}-empty`}
              style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
            >
              {carriesSection
                ? `No ${spec.title.toLowerCase()} are configured in this profile.`
                : `This machine record carries no imported ${spec.title.toLowerCase()} section.`}
            </div>
          )}
          {unusedRows.length > 0 && (
            <details
              data-testid={`machine-def-panel-${spec.section}-unused`}
              style={{ marginTop: 6 }}
              onToggle={(e) => { setShowUnused(e.currentTarget.open) }}
            >
              <summary
                className="control-chip-btn"
                style={{ display: 'inline-flex', width: 'max-content', cursor: 'pointer' }}
              >
                Show {unusedRows.length} unused {spec.noun} slots
              </summary>
              {/* BUILT WHEN IT IS OPENED, not before. A closed disclosure is
                  384 boxes nobody is looking at, x2 sections, and they are
                  built again on every re-render of this page - measured at
                  most of the time it takes the Wiring tab to appear. A
                  `<details>` that is shut shows nothing either way, so there
                  is no difference to see and half a second of one to feel. */}
              {showUnused && (
                <div style={{ marginTop: 6 }}>
                  <TriggerRowsTable
                    spec={spec}
                    rows={unusedRows}
                    settings={settings}
                    testId={`machine-def-panel-${spec.section}-unused-table`}
                    drawnConfigured={false}
                    held={held}
                  />
                </div>
              )}
            </details>
          )}
          <div
            data-testid={`machine-def-panel-${spec.section}-add-path`}
            style={{ marginTop: 6, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
          >
            To add one, fill in an unused slot above. It is stored with this machine
            definition; nothing in LienCAM acts on it yet.
          </div>
        </>
    </div>
  )
}

export function IoNotSent({ label, settingKey, settings }: {
  label: string
  settingKey: string
  settings: SettingSource
}) {
  return (
    <NotSent
      label={label}
      settings={settings}
      settingKey={`IOsetupsettings.${settingKey}`}
    />
  )
}

export function IoPinReadoutTable({ testId, rows, settings }: {
  testId: string
  rows: readonly IoPinReadoutRow[]
  settings: SettingSource
}) {
  return (
    <table className="mform-axis-table" data-testid={testId} style={{ width: 'max-content', minWidth: '100%' }}>
      <thead>
        <tr>
          <th>Signal</th>
          <th>port</th>
          <th>pin</th>
          <th>active low</th>
          <th>behavior</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.label}
            {...rowEmptyMarked(settings, [
              ...[row.port, row.pin, row.negate].map((key) => `IOsetupsettings.${key}`),
              ...(row.extra ?? []).map(([, key]) => `IOsetupsettings.${key}`),
            ])}
          >
            <td>{row.label}</td>
            <td><IoNotSent label="" settingKey={row.port} settings={settings} /></td>
            <td><IoNotSent label="" settingKey={row.pin} settings={settings} /></td>
            <td><IoNotSent label="" settingKey={row.negate} settings={settings} /></td>
            <td>
              {row.extra?.map(([label, key]) => (
                <span key={key} style={{ marginRight: 12 }}>
                  <IoNotSent label={label} settingKey={key} settings={settings} />
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
