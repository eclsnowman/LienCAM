import { useRef, useState } from 'react'
import { type VfdDefinition } from '../../../lib/machine/vfd'
import { type VfdLink } from '../../../lib/machine/vfd'
import { type VfdCommandTable } from '../../../lib/machine/vfd'
import { SectionHead } from './DefinitionFields'
import {
  type MachineSpindleDriveDefinition,
  type MachineSpindleLinkDefinition,
} from '../../../types'
import { type VfdPortLinkState } from '../../../lib/machine/bridgeTransport'
import { VFD_REGISTER_ROLES } from '../../../lib/machine/vfd'
import { type VfdRegisterRole, type VfdOptionalRegisterRole } from '../../../lib/machine/vfd'
import { VFD_OPTIONAL_REGISTER_ROLES } from '../../../lib/machine/vfd'
import { type VfdFaultCodeRegister, type VfdFaultRule } from '../../../lib/machine/vfd'
import { type VfdSetpointRegister } from '../../../lib/machine/vfd'
import { VFD_MODEL_TEMPLATES } from '../../../lib/machine/vfd'
import {
  VFD_RUN_STATE_MEANINGS,
  vfdFollowedFields,
  type VfdRequiredParameterRow,
  type VfdRunStateMeaning,
  type VfdRunStateValue,
} from '../../../lib/machine/vfd'
import {
  changeMachineVfdLinkTransport, declareMachineVfdLink, removeMachineVfdLink,
  setMachineVfdFaultCodeRegister,
  setMachineVfdRequiredParameters, setMachineVfdRunStateValues,
} from '../../../lib/machine/machineSession'
import {
  newBoardSpindleDrive, SPINDLE_DRIVE_KIND_LABEL, storedSpindleDriveKind,
  type SpindleDriveKind,
} from './SpindleFields'

// ---------------------------------------------------------------------------
// WO-967 - THE SPINDLE LINK, which lives in a file and not in this record.
//
// Operator at the machine, 2026-08-24: "we still don't have any way to edit the
// modbus vfd settings from our UI currently do we? ... I want it to live under
// the machine definitions under a section specific for the spindle."
//
// WHAT WAS TRUE BEFORE THIS SECTION EXISTED. His inverter is described by
// `pendant/uccnc-bridge/vfd/huanyang-gt.definition.json`, handed to the bridge
// as `--vfd <path>` at process start: transport, COM port, baud, parity, slave
// address, poll interval, retries, timeout, function codes, word order, and
// every register with its own scale and encode rule. The browser saw THREE
// fields of it - present, verified, name. So changing one Modbus register
// meant editing JSON by hand on the bridge machine, with nothing on any screen
// to check the result against. On a machine where the definition is otherwise
// the boot authority (WO-924), the spindle was the one part still living in a
// file nobody could see.
//
// AND WHY THIS SECTION SHOWS AND DOES NOT STORE. Operator's ruling of
// 2026-08-26T21:03Z is that the spindle section carries its own Modbus fields
// because his `.pro` does not describe this link at all ("not all spindles are
// modbus but mine is"). That settles WHOSE fields these are. It does not
// settle which document is the AUTHORITY once two of them describe one
// inverter - the bridge's file and a machine record - and that question is
// his, not this order's. So this is the first of the three the WO names:
//
//   (a) SHOW      <- here. Carry the definition up, render it, mark it.
//   (b) STORE     needs an answer to "file or record?" - Operator's to give.
//   (c) SEND      needs a bridge-side apply; the bridge reads `--vfd` ONCE, at
//                 process start, so today an edit could not reach the inverter
//                 without a restart even if a control existed to make one.
//
// EVERY VALUE HERE IS `data-not-sent`, and that marker means precisely what it
// says on this page: shown, and this software cannot send it to the controller
// at all. Not `data-not-driven` - that one promises the value is stored with
// the machine definition and Apply carries it, and none of that is true of a
// file on the bridge machine. There are no controls in this section, so
// `unmarkedControlsIn` finds nothing in it by construction; the marker is on
// the readouts anyway, so the day somebody puts a control here it is already
// making the honest claim rather than the flattering one.
//
// THE SOURCE IS THE BRIDGE, ONCE PER CONNECTION. `VfdPortLinkState.declared`
// is `hello.vfd.definition` after this build checked it whole
// (`readDeclaredVfdDefinition`): every field's SHAPE, and then the safety
// validator over the values. It clears on disconnect with the rest of that
// record, so a definition can never be read as a fact about a machine nothing
// is talking to. Nothing here is stored, and nothing here is a default this
// software chose: a field the document does not state renders EMPTY.
//
// SO THIS SECTION MAY READ THE DOCUMENT AS ITS DECLARED TYPE, and that is the
// only reason it may. The attempt-1 audit found the boundary checking values
// but not shape, so a `requiredParameters: "bad"` off the socket reached the
// `.map` below and threw mid-render, taking this whole page down. The check is
// complete now and it is the single place a definition enters - there is one
// writer of `declared`, and it is that function. A field added to this section
// tomorrow is a field to add to that check, not a `?.` to add here: a page
// half-guarding a document it has been promised is whole reads as a page that
// does not trust its own boundary, and then neither does.

/** One value off the inverter's document. No box: there is nothing on the
 *  other end of an edit. `null` renders as nothing at all - the document did
 *  not state it, and an empty string beside a label is the honest picture of
 *  that (rule 3 of this file: never invent a machine fact). */
export type VfdPath = readonly (string | number)[]

export function vfdPathKey(path: VfdPath): string {
  return path.map(String).join('.')
}

export interface VfdEditContext {
  pending: Record<string, string>
  disabled: boolean
  onType: (path: VfdPath, value: string) => void
  onCommit: (path: VfdPath, value: string) => void
  onDirectionChange: (inverted: boolean) => void
}

export function VfdReadout({ label, value, testId, path, edit, ariaLabel, width = 118 }: {
  label: string
  value: string | null
  testId: string
  path?: VfdPath
  edit?: VfdEditContext
  /** The box's accessible name when `label` is empty or shared. */
  ariaLabel?: string
  width?: number
}) {
  const key = path ? vfdPathKey(path) : ''
  const typed = path && edit && Object.prototype.hasOwnProperty.call(edit.pending, key)
    ? edit.pending[key]
    : (value ?? '')
  return (
    <span
      {...(path && edit ? { 'data-wired': '' } : { 'data-not-sent': '' })}
      data-testid={testId}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 5,
        fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)',
      }}
    >
      {label !== '' && <span style={{ flex: 'none' }}>{label}</span>}
      {path && edit ? (
        <input
          className="mform-input mform-input-mono"
          aria-label={ariaLabel ?? (label || testId)}
          value={typed}
          disabled={edit.disabled}
          aria-disabled={edit.disabled}
          onChange={(event) => edit.onType(path, event.target.value)}
          onBlur={(event) => edit.onCommit(path, event.target.value)}
          style={{ width, fontVariantNumeric: 'tabular-nums' }}
        />
      ) : (
        <span className="mform-input-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {value ?? ''}
        </span>
      )}
    </span>
  )
}

/** A number the document states, as text - and NOTHING when it does not state
 *  one. `String(undefined)` would put the word "undefined" on the page and
 *  `?? 0` would put a number nobody chose there; both are the defect rule 3
 *  names. Non-finite values are absence too: the validator has already refused
 *  the document if a required number is not a number, so anything left here
 *  that is not finite is a field the document simply has not got. */
export function vfdText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return null
}

export function vfdValueAt(definition: VfdDefinition, path: VfdPath): unknown {
  let value: unknown = definition
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string | number, unknown>)[part]
  }
  return value
}

export function withVfdValue(
  definition: VfdDefinition,
  path: VfdPath,
  nextValue: unknown,
): VfdDefinition {
  const copy = JSON.parse(JSON.stringify(definition)) as Record<string | number, unknown>
  let parent = copy
  for (const part of path.slice(0, -1)) {
    parent = parent[part] as Record<string | number, unknown>
  }
  parent[path[path.length - 1]] = nextValue
  return copy as unknown as VfdDefinition
}

export function parseVfdEdit(current: unknown, typed: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof current === 'number') {
    const value = Number(typed)
    return typed.trim() !== '' && Number.isFinite(value) ? { ok: true, value } : { ok: false }
  }
  if (typeof current === 'boolean') {
    const value = typed.trim().toLowerCase()
    if (value === 'true' || value === 'yes') return { ok: true, value: true }
    if (value === 'false' || value === 'no') return { ok: true, value: false }
    return { ok: false }
  }
  return { ok: true, value: typed }
}

/** The link block, WHICHEVER TRANSPORT it is. A serial link and a TCP link are
 *  different documents - `port`/`baud`/`parity`/`stopBits`/`rs485` against
 *  `host`/`tcpPort` - and the rows this returns are the ones the document
 *  actually has, in the document's own words. A TCP inverter is not given
 *  empty COM-port rows to say it has no COM port, and a serial one is not
 *  given an empty host. */
export type VfdRow = [string, string | null, VfdPath?]

export function vfdLinkRows(link: VfdLink): VfdRow[] {
  const timing: VfdRow[] = [
    ['slave address', vfdText(link.slaveAddress), ['link', 'slaveAddress']],
    ['poll interval (ms)', vfdText(link.pollIntervalMs), ['link', 'pollIntervalMs']],
    ['retry count', vfdText(link.retryCount), ['link', 'retryCount']],
    ['timeout (ms)', vfdText(link.timeoutMs), ['link', 'timeoutMs']],
  ]
  if (link.transport === 'tcp') {
    return [
      ['transport', vfdText(link.transport), ['link', 'transport']],
      ['host', vfdText(link.host), ['link', 'host']],
      ['TCP port', vfdText(link.tcpPort), ['link', 'tcpPort']],
      ...timing,
    ]
  }
  return [
    ['transport', vfdText(link.transport), ['link', 'transport']],
    ['serial port', vfdText(link.port), ['link', 'port']],
    ['baud rate', vfdText(link.baud), ['link', 'baud']],
    ['data bits', vfdText(link.dataBits), ['link', 'dataBits']],
    ['parity', vfdText(link.parity), ['link', 'parity']],
    ['stop bits', vfdText(link.stopBits), ['link', 'stopBits']],
    ['RS485 wiring', vfdText(link.rs485), ['link', 'rs485']],
    ...timing,
  ]
}

/** The command table, whichever STYLE it is - one word per command (Operator's
 *  Huanyang GT: 1 CW, 2 CCW, 5 stop) or a mask-and-value applied over the last
 *  word written (the older HY packs). Rows are the commands the table names,
 *  never all five: a command the inverter has no code for is absent from the
 *  document, and an empty row for it would claim the document mentioned it. */
/**
 * WO-1736 - the Modbus protocol block. Extracted from the panel's JSX so the
 * paths can be read in a test: `protocol.wordOrder` stopped being decoration
 * the day a setpoint could be two registers wide, and an operator who cannot
 * set it on this page can only set it by hand-authoring JSON (ADR-0044).
 */
export function vfdProtocolRows(definition: Pick<VfdDefinition, 'protocol'>): VfdRow[] {
  return [
    ['read function', vfdText(definition.protocol?.readFunction), ['protocol', 'readFunction']],
    ['write function', vfdText(definition.protocol?.writeFunction), ['protocol', 'writeFunction']],
    ['word order', vfdText(definition.protocol?.wordOrder), ['protocol', 'wordOrder']],
  ]
}

/**
 * One row of the register table: where the role lives, HOW MANY REGISTERS IT
 * SPANS, and - for the setpoint, the only role that carries arithmetic - its
 * scale, rounding and clamp. `words` on the setpoint row is the setpoint's
 * WIDTH (WO-1736): 1 is a 16-bit speed reference, 2 is a 32-bit pair ordered
 * by `protocol.wordOrder`.
 */
export function vfdRegisterRows(
  definition: Pick<VfdDefinition, 'registers'>,
  role: VfdRegisterRole | VfdOptionalRegisterRole,
): VfdRow[] {
  const register = definition.registers?.[role]
  const setpoint = role === 'setpoint' ? (register as VfdSetpointRegister | undefined) : undefined
  return [
    ['address', vfdText(register?.address), ['registers', role, 'address']],
    ['words', vfdText(register?.count), ['registers', role, 'count']],
    ['scale', vfdText(setpoint?.scale), ['registers', role, 'scale']],
    ['rounding', vfdText(setpoint?.encode?.round), ['registers', role, 'encode', 'round']],
    ['minimum', vfdText(setpoint?.encode?.min), ['registers', role, 'encode', 'min']],
    ['maximum', vfdText(setpoint?.encode?.max), ['registers', role, 'encode', 'max']],
  ]
}

export function vfdCommandRows(table: VfdCommandTable): VfdRow[] {
  // WO-1734: THE STYLE IS THE FIRST ROW, and it has no box. It says which of
  // the two kinds of table the rows under it are, which is the difference
  // between "5 stops this spindle" and "these bits stop it"; without it the
  // numbers below are ambiguous on the page in a way they are not in the
  // document. It is a readout rather than an edit because the style is not one
  // field: typing `bitfield` over `value` leaves a document with no mask and no
  // idle word - not a definition, and one the bridge would refuse whole,
  // spindle stop included. Changing the style is picking a different inverter,
  // and that is the model picker's job.
  const style: VfdRow = ['style', vfdText(table.style)]
  if (table.style === 'bitfield') {
    return [
      style,
      // The word a command starts from before this link has written one. It is
      // as much this drive's fact as any mask is, so it is edited here and not
      // only in hand-authored JSON.
      ['idle word', vfdText(table.idle), ['commands', 'idle']],
      ...Object.entries(table.commands)
        .filter(([, spec]) => spec !== undefined)
        .flatMap(([command, spec]): VfdRow[] => [
          [`${command} mask`, vfdText(spec?.mask), ['commands', 'commands', command, 'mask']],
          [`${command} value`, vfdText(spec?.value), ['commands', 'commands', command, 'value']],
        ]),
    ]
  }
  return [
    style,
    ...Object.entries(table.values)
      .filter(([, value]) => value !== undefined)
      .map(([command, value]): VfdRow => [
        command, vfdText(value), ['commands', 'values', command],
      ]),
  ]
}

/** WO-1718 review: THE TRANSPORT IS NOT A ONE-FIELD EDIT. A serial link and a
 *  network link are different documents, so typing `tcp` over `rtu` and
 *  storing it alone can never be a valid definition - it has no host yet, and
 *  the host box only exists once the transport says tcp. So a transport change
 *  is held HERE, in this block, with the new transport's rows open for typing:
 *  timing and slave address carry over, a serial link's settings come from the
 *  model template this link was declared from (the template's own facts, as
 *  declaring it did), and a host and TCP port are the operator's to give. The
 *  moment the held link is a whole one it is stored and pushed like any other
 *  edit; typing the stored transport back abandons it. */
type VfdTransport = VfdLink['transport']

interface VfdTransportDraft {
  transport: VfdTransport
  values: Record<string, string>
}

const TRANSPORT_KEY = vfdPathKey(['link', 'transport'])

const TRANSPORT_FIELDS: Record<VfdTransport, readonly string[]> = {
  rtu: ['port', 'baud', 'dataBits', 'parity', 'stopBits', 'rs485'],
  tcp: ['host', 'tcpPort'],
}
const TIMING_FIELDS = ['slaveAddress', 'pollIntervalMs', 'retryCount', 'timeoutMs'] as const
const NUMBER_FIELDS = new Set([
  'baud', 'dataBits', 'stopBits', 'tcpPort', 'slaveAddress', 'pollIntervalMs', 'retryCount', 'timeoutMs',
])

function vfdTransportOf(typed: string): VfdTransport | null {
  const value = typed.trim().toLowerCase()
  return value === 'rtu' || value === 'tcp' ? value : null
}

function vfdTransportDraft(
  definition: VfdDefinition | MachineSpindleLinkDefinition,
  transport: VfdTransport,
): VfdTransportDraft {
  const current = definition.link as unknown as Record<string, unknown>
  const template = VFD_MODEL_TEMPLATES
    .find((candidate) => candidate.id === definition.id && candidate.definition.link.transport === transport)
  const seed = (template?.definition.link ?? {}) as unknown as Record<string, unknown>
  const values: Record<string, string> = {}
  for (const field of TIMING_FIELDS) values[field] = vfdText(current[field]) ?? ''
  for (const field of TRANSPORT_FIELDS[transport]) values[field] = vfdText(seed[field]) ?? ''
  return { transport, values }
}

/** The held link as the document it would become - or null while any of its
 *  fields is still empty (the operator is still filling it in). */
function vfdDraftLink(draft: VfdTransportDraft): VfdLink | null {
  const link: Record<string, unknown> = { transport: draft.transport }
  for (const field of [...TRANSPORT_FIELDS[draft.transport], ...TIMING_FIELDS]) {
    const typed = (draft.values[field] ?? '').trim()
    if (typed === '') return null
    link[field] = NUMBER_FIELDS.has(field) ? Number(typed) : typed
  }
  return link as unknown as VfdLink
}

function VfdLinkBlock({ machineId, definition, edit }: {
  machineId: string | null
  definition: VfdDefinition | MachineSpindleLinkDefinition
  edit: VfdEditContext
}) {
  const [draft, setDraft] = useState<VfdTransportDraft | null>(null)
  const [transportTyped, setTransportTyped] = useState<string | null>(null)
  const stored = definition.link.transport
  const held = draft !== null && draft.transport !== stored ? draft : null

  const shownLink = (held === null
    ? definition.link
    : { transport: held.transport, ...held.values }) as unknown as VfdLink
  const pending: Record<string, string> = { ...edit.pending }
  if (held !== null) {
    for (const [field, value] of Object.entries(held.values)) pending[vfdPathKey(['link', field])] = value
    pending[TRANSPORT_KEY] = held.transport
  }
  if (transportTyped !== null) pending[TRANSPORT_KEY] = transportTyped

  const storeWhenWhole = (next: VfdTransportDraft): void => {
    const link = vfdDraftLink(next)
    if (link === null) return
    void changeMachineVfdLinkTransport(machineId, definition as MachineSpindleLinkDefinition, link)
      .then((outcome) => {
        if (outcome.stored) setDraft((current) => (current === next ? null : current))
      })
  }

  const linkEdit: VfdEditContext = {
    ...edit,
    pending,
    onType: (path, value) => {
      const key = vfdPathKey(path)
      if (key === TRANSPORT_KEY) {
        setTransportTyped(value)
        return
      }
      if (held !== null && path[0] === 'link') {
        setDraft({ ...held, values: { ...held.values, [String(path[1])]: value } })
        return
      }
      edit.onType(path, value)
    },
    onCommit: (path, value) => {
      const key = vfdPathKey(path)
      if (key === TRANSPORT_KEY) {
        setTransportTyped(null)
        const transport = vfdTransportOf(value)
        if (transport === stored) {
          setDraft(null)
          return
        }
        if (transport !== null) {
          if (held?.transport === transport) return
          const next = vfdTransportDraft(definition, transport)
          setDraft(next)
          storeWhenWhole(next)
          return
        }
        // Not a transport this link knows: the panel's own refusal says so.
        edit.onCommit(path, value)
        return
      }
      if (held !== null && path[0] === 'link') {
        const next = { ...held, values: { ...held.values, [String(path[1])]: value } }
        setDraft(next)
        storeWhenWhole(next)
        return
      }
      edit.onCommit(path, value)
    },
  }

  return (
    <VfdRows
      title="Serial link"
      summary="How the bridge reaches the inverter, and how long it waits"
      testId="machine-def-panel-vfd-serial"
      slug="serial"
      rows={vfdLinkRows(shownLink)}
      edit={linkEdit}
    />
  )
}

/** WO-1718 review 2: THE KEYPAD PARAMETERS ARE PART OF THE DEFINITION, and
 *  every one of their fields is edited here - add a row, edit its parameter,
 *  value and reason, remove it. A row that restates a link field (`follows`:
 *  Huanyang PC.00 slave address, PC.01 baud, PC.02 framing) has no value of
 *  its own: its value cell edits the link field itself, so changing the baud
 *  here or in the link block is one edit to one fact, and the stored keypad
 *  text is restated from the link on every store. Over TCP a serial-only row
 *  has no link field to follow and stands as its own text. */
const FOLLOWED_FIELD_LABEL: Record<string, string> = {
  slaveAddress: 'slave address', baud: 'baud rate', dataBits: 'data bits', parity: 'parity', stopBits: 'stop bits',
}

function VfdRequiredParameters({ machineId, definition, edit }: {
  machineId: string | null
  definition: VfdDefinition | MachineSpindleLinkDefinition
  edit: VfdEditContext
}) {
  const rows = (definition.requiredParameters ?? []) as VfdRequiredParameterRow[]
  const link = definition.link as unknown as Record<string, unknown>
  const store = (next: VfdRequiredParameterRow[], what: string): void => {
    void setMachineVfdRequiredParameters(
      machineId, definition as MachineSpindleLinkDefinition, next, what,
    )
  }
  return (
    <div data-testid="machine-def-panel-vfd-required" style={{ marginTop: 10 }}>
      <SectionHead
        title="Set these on the inverter itself"
        summary="This link cannot set them and cannot check them - they are yours to enter on the keypad"
        testId="machine-def-panel-vfd-required-head"
      />
      <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
        <table
          className="mform-axis-table"
          data-testid="machine-def-panel-vfd-required-table"
          style={{ width: 'max-content', minWidth: '100%' }}
        >
          <thead><tr><th>parameter</th><th>value</th><th>why</th><th /></tr></thead>
          <tbody>
            {rows.map((required, index) => {
              const slug = required.parameter === '' ? `new-${index}` : required.parameter
              const name = required.parameter === '' ? `row ${index + 1}` : required.parameter
              const followed = required.follows === undefined
                ? []
                : vfdFollowedFields(definition.link, required.follows)
              return (
                <tr key={index} data-testid={`machine-def-panel-vfd-required-row-${slug}`}>
                  <td>
                    <VfdReadout
                      label="" value={vfdText(required.parameter)}
                      testId={`machine-def-vfd-required-${slug}-parameter`}
                      path={['requiredParameters', index, 'parameter']}
                      ariaLabel={`${name} parameter`}
                      edit={edit}
                    />
                  </td>
                  <td
                    data-testid={`machine-def-vfd-required-${slug}-value`}
                    {...(followed.length > 0 ? { 'data-follows': required.follows } : {})}
                    data-tooltip={followed.length > 0
                      ? `The link's own ${followed.map((field) => FOLLOWED_FIELD_LABEL[field]).join(', ')} - one value, edited here or in the link above`
                      : undefined}
                  >
                    {followed.length > 0 ? (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        {followed.map((field) => (
                          <VfdReadout
                            key={field}
                            label={FOLLOWED_FIELD_LABEL[field]}
                            value={vfdText(link[field])}
                            testId={`machine-def-vfd-required-${slug}-value-${field}`}
                            path={['link', field]}
                            ariaLabel={`${name} ${FOLLOWED_FIELD_LABEL[field]}`}
                            width={followed.length > 1 ? 56 : 90}
                            edit={edit}
                          />
                        ))}
                      </span>
                    ) : (
                      <VfdReadout
                        label="" value={vfdText(required.value)}
                        testId={`machine-def-vfd-required-${slug}-value-text`}
                        path={['requiredParameters', index, 'value']}
                        ariaLabel={`${name} value`}
                        edit={edit}
                      />
                    )}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <VfdReadout
                      label="" value={vfdText(required.why)}
                      testId={`machine-def-vfd-required-${slug}-why`}
                      path={['requiredParameters', index, 'why']}
                      ariaLabel={`${name} why`}
                      width={420}
                      edit={edit}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid={`machine-def-vfd-required-${slug}-remove`}
                      aria-label={`Remove ${name}`}
                      data-tooltip={`Remove ${name} from this machine's keypad parameters`}
                      disabled={edit.disabled}
                      aria-disabled={edit.disabled}
                      onClick={() => store(
                        rows.filter((_, at) => at !== index),
                        `keypad parameter ${name} removed`,
                      )}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="control-chip-btn"
        data-testid="machine-def-vfd-required-add"
        data-tooltip="Add a parameter the operator has to set on the inverter's keypad"
        disabled={edit.disabled}
        aria-disabled={edit.disabled}
        style={{ marginTop: 6 }}
        onClick={() => store(
          [...rows, { parameter: '', value: '', why: '' }],
          'keypad parameter added',
        )}
      >
        Add parameter
      </button>
    </div>
  )
}

/** WO-1735: the rule this register reads by. The empty choice is a real
 *  answer, not a blank - it means "the definition's own fault rule, applied to
 *  this register's word", which is what most drives with a fault-code register
 *  want and what a newly stated register starts as. */
const FAULT_RULE_CHOICES: { value: '' | VfdFaultRule['kind']; label: string }[] = [
  { value: '', label: "The definition's fault rule" },
  { value: 'nonZero', label: 'Any value but 0' },
  { value: 'equals', label: 'Equals one value' },
  { value: 'mask', label: 'A bit is set' },
]

/**
 * WO-1735 - THE DRIVE'S OWN FAULT REGISTER, stated, edited and removed here.
 *
 * Operator's Huanyang GT reports its fault in the operating-state word, so his
 * definition states no register here and this row is empty - which is what
 * "this drive has no fault register" looks like, and it is also how one is
 * added: type the address the drive's manual gives and the definition states
 * it; clear the address and the definition states it no longer. No button, no
 * modal, and no address this software chose - a Modbus address nobody chose is
 * a machine fact nobody chose.
 *
 * `equals` and `a bit is set` are not rules until a number goes with them, so
 * those two wait for one; the two that need no number take effect when chosen.
 */
function VfdFaultCodeRegisterSection({ machineId, definition, edit }: {
  machineId: string | null
  definition: VfdDefinition | MachineSpindleLinkDefinition
  edit: VfdEditContext
}) {
  const register = definition.registers?.faultCode
  // Null means "show what the document states"; a string is what is being
  // typed, held here until the completed-edit boundary the readouts use.
  const [addressText, setAddressText] = useState<string | null>(null)
  const [wordsText, setWordsText] = useState<string | null>(null)
  const [ruleDraft, setRuleDraft] = useState<{ kind: 'equals' | 'mask'; text: string } | null>(null)

  // WO-1065: this editor reads no machine identity of its own. A section that
  // was handed no machine passes that null on, exactly as the required-keypad
  // and run-state tables do, and `machineSession` resolves the Control machine
  // in the one place that owns that fallback.
  const store = (next: VfdFaultCodeRegister | undefined, what: string) =>
    setMachineVfdFaultCodeRegister(machineId, definition as MachineSpindleLinkDefinition, next, what)

  const whole = (text: string, low: number, high: number): number | null => {
    const value = Number(text)
    return text.trim() !== '' && Number.isInteger(value) && value >= low && value <= high
      ? value
      : null
  }

  const commitAddress = (text: string): void => {
    if (text.trim() === '') {
      // An empty address is not half a register: it is a definition that
      // states none, and the fault goes back to the operating-state word.
      if (register === undefined) { setAddressText(null); return }
      void store(undefined, 'fault register removed').then((outcome) => {
        if (outcome.stored) { setAddressText(null); setWordsText(null); setRuleDraft(null) }
      })
      return
    }
    const address = whole(text, 0, 65535)
    if (address === null || address === register?.address) return
    const count = register?.count ?? whole(wordsText ?? '', 1, 125) ?? 1
    const next: VfdFaultCodeRegister = register === undefined
      ? { address, count }
      : { ...register, address }
    void store(next, register === undefined ? 'fault register stated' : 'fault register address changed')
      .then((outcome) => { if (outcome.stored) setAddressText(null) })
  }

  const commitWords = (text: string): void => {
    if (register === undefined) return
    const count = whole(text, 1, 125)
    if (count === null || count === register.count) return
    void store({ ...register, count }, 'fault register word count changed')
      .then((outcome) => { if (outcome.stored) setWordsText(null) })
  }

  const commitRuleDraft = (next: { kind: 'equals' | 'mask'; text: string }): void => {
    if (register === undefined) return
    const value = whole(next.text, next.kind === 'mask' ? 1 : 0, 65535)
    if (value === null) return
    const rule: VfdFaultRule = next.kind === 'equals'
      ? { kind: 'equals', value }
      : { kind: 'mask', mask: value }
    void store({ ...register, rule }, 'fault register rule changed').then((outcome) => {
      if (outcome.stored) setRuleDraft((current) => (current === next ? null : current))
    })
  }

  const chosenKind: '' | VfdFaultRule['kind'] = ruleDraft?.kind ?? register?.rule?.kind ?? ''

  return (
    <div data-testid="machine-def-panel-vfd-fault-register" style={{ marginTop: 10 }}>
      <SectionHead
        title="Fault register"
        summary="The register this drive reports faults in. Empty: it has none, and the fault is read from the operating-state word"
        testId="machine-def-panel-vfd-fault-register-head"
      />
      <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
        <table className="mform-axis-table" style={{ width: '100%' }}>
          <thead><tr><th>address</th><th>words</th><th>a fault is</th><th>value</th></tr></thead>
          <tbody>
            <tr data-testid="machine-def-vfd-fault-register-row">
              <td>
                <input
                  data-wired=""
                  className="mform-input mform-input-mono"
                  aria-label="fault register address"
                  data-testid="machine-def-vfd-fault-register-address"
                  value={addressText ?? (register === undefined ? '' : String(register.address))}
                  disabled={edit.disabled}
                  aria-disabled={edit.disabled}
                  onChange={(event) => setAddressText(event.target.value)}
                  onBlur={(event) => commitAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    commitAddress(event.currentTarget.value)
                  }}
                  style={{ width: 118, fontVariantNumeric: 'tabular-nums' }}
                />
              </td>
              <td>
                <input
                  data-wired=""
                  className="mform-input mform-input-mono"
                  aria-label="fault register words"
                  data-testid="machine-def-vfd-fault-register-words"
                  value={wordsText ?? (register === undefined ? '' : String(register.count))}
                  disabled={edit.disabled || register === undefined}
                  aria-disabled={edit.disabled || register === undefined}
                  onChange={(event) => setWordsText(event.target.value)}
                  onBlur={(event) => commitWords(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    commitWords(event.currentTarget.value)
                  }}
                  style={{ width: 118, fontVariantNumeric: 'tabular-nums' }}
                />
              </td>
              <td>
                <select
                  data-wired=""
                  className="mform-select"
                  aria-label="fault register rule"
                  data-testid="machine-def-vfd-fault-register-rule"
                  value={chosenKind}
                  disabled={edit.disabled || register === undefined}
                  aria-disabled={edit.disabled || register === undefined}
                  onChange={(event) => {
                    if (register === undefined) return
                    const kind = event.target.value as '' | VfdFaultRule['kind']
                    if (kind === 'equals' || kind === 'mask') {
                      // Not a rule until a number goes with it: hold the choice
                      // here until the operator has stated one.
                      setRuleDraft({ kind, text: '' })
                      return
                    }
                    setRuleDraft(null)
                    const next = { ...register }
                    if (kind === '') delete next.rule
                    else next.rule = { kind: 'nonZero' }
                    void store(next, 'fault register rule changed')
                  }}
                >
                  {FAULT_RULE_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                  ))}
                </select>
              </td>
              <td>
                {ruleDraft !== null ? (
                  <input
                    data-wired=""
                    className="mform-input mform-input-mono"
                    aria-label="fault register rule value"
                    data-testid="machine-def-vfd-fault-register-rule-value"
                    value={ruleDraft.text}
                    disabled={edit.disabled}
                    aria-disabled={edit.disabled}
                    onChange={(event) => setRuleDraft({ ...ruleDraft, text: event.target.value })}
                    onBlur={() => commitRuleDraft(ruleDraft)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      commitRuleDraft(ruleDraft)
                    }}
                    style={{ width: 118, fontVariantNumeric: 'tabular-nums' }}
                  />
                ) : register?.rule?.kind === 'equals' ? (
                  <VfdReadout
                    label=""
                    value={vfdText(register.rule.value)}
                    path={['registers', 'faultCode', 'rule', 'value']}
                    edit={edit}
                    ariaLabel="fault register rule value"
                    testId="machine-def-vfd-fault-register-rule-value"
                  />
                ) : register?.rule?.kind === 'mask' ? (
                  <VfdReadout
                    label=""
                    value={vfdText(register.rule.mask)}
                    path={['registers', 'faultCode', 'rule', 'mask']}
                    edit={edit}
                    ariaLabel="fault register rule value"
                    testId="machine-def-vfd-fault-register-rule-value"
                  />
                ) : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

const RUN_STATE_MEANING_LABEL: Record<VfdRunStateMeaning, string> = {
  running: 'Running',
  runningForward: 'Running forward',
  runningReverse: 'Running reverse',
  stopped: 'Stopped',
  faulted: 'Faulted',
  poweredOff: 'Powered off',
}

interface VfdRunStateDraft {
  value: string
  meaning: '' | VfdRunStateMeaning
}

/** WO-1721: A run-state table may be absent or empty, so it cannot rely on
 * scalar-path editing alone. Add holds a blank row locally until the operator
 * has stated both facts; the typed text stays component-local while typing
 * (an earlier eager commit stored the first valid digit of a meaning-first
 * entry, so "15" became a row for 1) and commits only at the completed-edit
 * boundaries the scalar readouts already use: blur, Enter, or the discrete
 * meaning choice. Only then does the whole candidate pass through the
 * canonical validator and existing controller receipt boundary. A refusal
 * leaves the accepted definition untouched and the draft available to fix. */
function VfdRunStateValues({ machineId, definition, edit }: {
  machineId: string | null
  definition: VfdDefinition | MachineSpindleLinkDefinition
  edit: VfdEditContext
}) {
  const rows = definition.registers.runState.values ?? []
  const [draft, setDraft] = useState<VfdRunStateDraft | null>(null)
  const store = (next: VfdRunStateValue[], what: string) => setMachineVfdRunStateValues(
    machineId, definition as MachineSpindleLinkDefinition, next, what,
  )
  const commitDraft = (next: VfdRunStateDraft): void => {
    const value = Number(next.value)
    if (
      next.value.trim() === ''
      || !Number.isInteger(value)
      || value < 0
      || value > 65535
      || next.meaning === ''
    ) return
    void store([...rows, { value, meaning: next.meaning }], 'run-state value added')
      .then((outcome) => {
        if (outcome.stored) setDraft((current) => (current === next ? null : current))
      })
  }

  return (
    <div data-testid="machine-def-panel-vfd-run-state-values" style={{ marginTop: 10 }}>
      <SectionHead
        title="Run-state values"
        summary="What each value read from the operating-state register means"
        testId="machine-def-panel-vfd-run-state-values-head"
      />
      <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
        <table className="mform-axis-table" style={{ width: '100%' }}>
          <thead><tr><th>value</th><th>meaning</th><th /></tr></thead>
          <tbody>
            {rows.map((entry, index) => (
              <tr key={`${entry.value}:${index}`} data-testid={`machine-def-vfd-run-state-${index + 1}-row`}>
                <td>
                  <VfdReadout
                    label=""
                    value={vfdText(entry.value)}
                    path={['registers', 'runState', 'values', index, 'value']}
                    edit={edit}
                    ariaLabel={`run-state row ${index + 1} value`}
                    testId={`machine-def-vfd-run-state-${index + 1}-value`}
                  />
                </td>
                <td>
                  <select
                    data-wired=""
                    className="mform-select"
                    aria-label={`run-state row ${index + 1} meaning`}
                    data-testid={`machine-def-vfd-run-state-${index + 1}-meaning`}
                    value={entry.meaning}
                    disabled={edit.disabled}
                    aria-disabled={edit.disabled}
                    onChange={(event) => {
                      const meaning = event.target.value as VfdRunStateMeaning
                      void store(
                        rows.map((row, at) => (at === index ? { ...row, meaning } : row)),
                        `run-state row ${index + 1} meaning changed`,
                      )
                    }}
                  >
                    {VFD_RUN_STATE_MEANINGS.map((meaning) => (
                      <option key={meaning} value={meaning}>{RUN_STATE_MEANING_LABEL[meaning]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    className="control-chip-btn"
                    data-testid={`machine-def-vfd-run-state-${index + 1}-remove`}
                    aria-label={`Remove run-state row ${index + 1}`}
                    disabled={edit.disabled}
                    aria-disabled={edit.disabled}
                    onClick={() => {
                      void store(
                        rows.filter((_, at) => at !== index),
                        `run-state row ${index + 1} removed`,
                      )
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {draft !== null && (
              <tr data-testid="machine-def-vfd-run-state-draft-row">
                <td>
                  <input
                    data-wired=""
                    className="mform-input mform-input-mono"
                    aria-label="new run-state value"
                    data-testid="machine-def-vfd-run-state-draft-value"
                    value={draft.value}
                    disabled={edit.disabled}
                    aria-disabled={edit.disabled}
                    onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    onBlur={() => commitDraft(draft)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      commitDraft(draft)
                    }}
                    style={{ width: 118, fontVariantNumeric: 'tabular-nums' }}
                  />
                </td>
                <td>
                  <select
                    data-wired=""
                    className="mform-select"
                    aria-label="new run-state meaning"
                    data-testid="machine-def-vfd-run-state-draft-meaning"
                    value={draft.meaning}
                    disabled={edit.disabled}
                    aria-disabled={edit.disabled}
                    onChange={(event) => {
                      const next = {
                        ...draft,
                        meaning: event.target.value as '' | VfdRunStateMeaning,
                      }
                      setDraft(next)
                      // A select change is a completed edit: the whole choice
                      // arrives in one event, so value-first entry can commit
                      // here while meaning-first typing still waits for the
                      // value box's blur/Enter boundary.
                      commitDraft(next)
                    }}
                  >
                    <option value="">Choose meaning</option>
                    {VFD_RUN_STATE_MEANINGS.map((meaning) => (
                      <option key={meaning} value={meaning}>{RUN_STATE_MEANING_LABEL[meaning]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    className="control-chip-btn"
                    data-testid="machine-def-vfd-run-state-draft-cancel"
                    disabled={edit.disabled}
                    aria-disabled={edit.disabled}
                    // Keep focus off the value box: without this a real
                    // browser blurs the input on mousedown, the blur boundary
                    // commits the completed draft, and Cancel arrives too late.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setDraft(null)}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="control-chip-btn"
        data-testid="machine-def-vfd-run-state-add"
        data-tooltip="Add a value named by this inverter's operating-state register"
        disabled={edit.disabled || draft !== null}
        aria-disabled={edit.disabled || draft !== null}
        style={{ marginTop: 6 }}
        onClick={() => setDraft({ value: '', meaning: '' })}
      >
        Add run-state value
      </button>
    </div>
  )
}

/** A labelled block of readouts, so the parts of the document below read the
 *  same way and none of them grows its own layout. */
export function VfdRows({ title, summary, testId, slug, rows, edit }: {
  title: string
  summary: string
  testId: string
  slug: string
  rows: VfdRow[]
  edit?: VfdEditContext
}) {
  return (
    <div data-testid={testId} style={{ marginTop: 10 }}>
      <SectionHead title={title} summary={summary} testId={`${testId}-head`} />
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: '5px 16px',
      }}>
        {rows.map(([label, value, path]) => (
          <VfdReadout
            key={label}
            label={label}
            value={value}
            path={path}
            edit={edit}
            testId={`machine-def-vfd-${slug}-${label}`}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * THE SPINDLE'S OWN DOCUMENT, on the page Operator went looking for it on.
 *
 * Three states and no fourth, because each is a different fact and flattening
 * any two of them would be this page guessing:
 *
 *   nothing declared   no bridge is connected, or the bridge that is was
 *                      started without `--vfd`, or it is an older bridge that
 *                      does not state its definition. Says so, and says what
 *                      to do about it. It does NOT say "your machine has no
 *                      spindle settings" - that is a claim about his machine
 *                      and it would be false.
 *   declared, refused  the bridge sent a document this build cannot read.
 *                      The validator's own sentences are shown verbatim: a
 *                      half-rendered definition is worse than none, because
 *                      register addresses somebody can act on would be on
 *                      screen from a document this software had already
 *                      decided it could not read.
 *   declared, read     the whole document, in its own words.
 *
 * WO-967 round 2 folds a fourth INPUT into the first state rather than adding
 * a fourth state: a bridge connected for a DIFFERENT machine has declared a
 * document, but not one about the machine on this page, so this page has not
 * been told anything about this machine's spindle - which is the first state
 * exactly. It says which machine the bridge is for, because "no bridge has
 * stated one" would be a false explanation while a bridge is plainly
 * connected. `foreign` is decided by the panel, which is what knows the
 * machine on screen; this component never guesses it from a global.
 */
export function vfdOperationalSignature(
  definition: VfdDefinition | MachineSpindleLinkDefinition,
): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(definition)
      .filter(([key]) => key !== 'verified'
        && key !== 'provenance'
        && key !== 'directionInverted'
        && key !== 'directionInvertedProvenance'),
  ))
}

/** The link this record actually shows. WO-1718: the machine definition is
 *  the ONLY source - a record that states no link has none, whatever a
 *  connected bridge was started with. `link` and `foreign` stay in the
 *  signature for `SpindleArea`'s collapsed summary (WO-1691), which asks the
 *  same question through this one function. */
export function resolvedSpindleLink({ stored, storedIsStated }: {
  link: VfdPortLinkState
  foreign: boolean
  stored: MachineSpindleLinkDefinition | null | undefined
  storedIsStated: boolean
}): VfdDefinition | MachineSpindleLinkDefinition | null | undefined {
  return storedIsStated ? stored : null
}

/** The Drive picker's selected identity. Legacy is a display-only value until
 * the operator chooses a stored drive; VFDs use their template id, or
 * `current` when the declared link names no shipped template. */
const DRIVE_LEGACY = 'legacy'
const DRIVE_CURRENT = 'vfd:current'
const DRIVE_MANUAL = 'manual'
const DRIVE_RELAY = 'relay'
const DRIVE_BOARD_PWM = 'board:pwm'
const DRIVE_BOARD_ANALOG = 'board:analog-0-10v'

function driveValue(
  definition: VfdDefinition | MachineSpindleLinkDefinition | null | undefined,
  storedDrive?: MachineSpindleDriveDefinition,
): string {
  if (storedDrive === undefined) return DRIVE_LEGACY
  if (storedDrive.kind === 'manual') return DRIVE_MANUAL
  if (storedDrive?.kind === 'relay') return DRIVE_RELAY
  if (storedDrive?.kind === 'board-speed') {
    return storedDrive.signal === 'pwm' ? DRIVE_BOARD_PWM : DRIVE_BOARD_ANALOG
  }
  if (definition === null || definition === undefined) return DRIVE_CURRENT
  return VFD_MODEL_TEMPLATES.some((template) => template.id === definition.id)
    ? `vfd:${definition.id}`
    : DRIVE_CURRENT
}

/** WO-1760 - one Drive control, backed by the one stored field. Legacy records
 * keep their derived word until the operator makes a choice. A VFD choice
 * still declares its separate inverter document through WO-1718's path.
 * WO-1723 preserves WO-1760's immediate draft edit, but only accepts it as
 * control authority after the existing link operation says it stored. */
export function SpindleDrivePicker({
  machineId, definition, disabled, storedDrive, legacyKind = 'none',
  newBoardDrive = newBoardSpindleDrive, onDriveChange, onDriveRefused,
}: {
  machineId: string | null
  definition: VfdDefinition | MachineSpindleLinkDefinition | null | undefined
  disabled: boolean
  storedDrive?: MachineSpindleDriveDefinition
  legacyKind?: SpindleDriveKind
  newBoardDrive?: (signal: 'pwm' | 'analog-0-10v') => MachineSpindleDriveDefinition
  onDriveChange?: (drive: MachineSpindleDriveDefinition | undefined) => void
  onDriveRefused?: (drive: MachineSpindleDriveDefinition | undefined) => void
}) {
  const committedValue = driveValue(definition, storedDrive)
  const [pendingValue, setPendingValue] = useState<string | null>(null)
  const changeSequence = useRef(0)
  const changeQueue = useRef<Promise<void>>(Promise.resolve())
  const acceptedDrive = useRef<MachineSpindleDriveDefinition | undefined>(storedDrive)
  const value = pendingValue ?? committedValue
  const shownKind = storedDrive === undefined ? legacyKind : storedSpindleDriveKind(storedDrive)
  const legacyLabel = SPINDLE_DRIVE_KIND_LABEL[shownKind]
  const boardPwmLabel = committedValue === DRIVE_LEGACY && shownKind === 'pwm-board'
    ? `${SPINDLE_DRIVE_KIND_LABEL['board-pwm']} (save this choice)`
    : SPINDLE_DRIVE_KIND_LABEL['board-pwm']

  const requestDriveChange = (next: string): void => {
    let drive: MachineSpindleDriveDefinition
    let apply: () => Promise<{ stored: boolean }>
    if (next === DRIVE_MANUAL) {
      drive = { kind: 'manual' }
      apply = () => removeMachineVfdLink(machineId)
    } else if (next === DRIVE_RELAY) {
      drive = { kind: 'relay' }
      apply = () => removeMachineVfdLink(machineId)
    } else if (next === DRIVE_BOARD_PWM || next === DRIVE_BOARD_ANALOG) {
      drive = newBoardDrive(next === DRIVE_BOARD_PWM ? 'pwm' : 'analog-0-10v')
      apply = () => removeMachineVfdLink(machineId)
    } else if (next.startsWith('vfd:') && next !== DRIVE_CURRENT) {
      drive = { kind: 'modbus-vfd' }
      apply = () => declareMachineVfdLink(machineId, next.slice('vfd:'.length))
    } else {
      return
    }

    const sequence = ++changeSequence.current
    setPendingValue(next)
    onDriveChange?.(drive)
    const attempt = changeQueue.current.then(apply).then(
      (outcome) => {
        if (outcome.stored) {
          acceptedDrive.current = drive
        } else if (changeSequence.current === sequence) {
          onDriveChange?.(acceptedDrive.current)
          onDriveRefused?.(acceptedDrive.current)
        }
      },
      () => {
        if (changeSequence.current === sequence) {
          onDriveChange?.(acceptedDrive.current)
          onDriveRefused?.(acceptedDrive.current)
        }
      },
    )
    changeQueue.current = attempt
    void attempt.then(() => {
      if (changeSequence.current === sequence) setPendingValue(null)
    })
  }

  return (
    <label
      data-testid="machine-def-vfd-drive"
      style={{
        display: 'contents',
        fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)',
      }}
    >
      <select
        data-wired=""
        className="mform-select"
        aria-label="Spindle drive"
        data-testid="machine-def-area-spindle-drive-value"
        value={value}
        disabled={disabled}
        aria-disabled={disabled}
        onChange={(event) => {
          const next = event.target.value
          if (next === value) return
          requestDriveChange(next)
        }}
      >
        {value === DRIVE_LEGACY && (
          <option value={DRIVE_LEGACY}>{legacyLabel}</option>
        )}
        <option value={DRIVE_MANUAL}>{SPINDLE_DRIVE_KIND_LABEL.manual}</option>
        <option value={DRIVE_BOARD_PWM}>{boardPwmLabel}</option>
        <option value={DRIVE_BOARD_ANALOG}>{SPINDLE_DRIVE_KIND_LABEL['board-analog']}</option>
        <option value={DRIVE_RELAY}>{SPINDLE_DRIVE_KIND_LABEL.relay}</option>
        {value === DRIVE_CURRENT && (
          <option value={DRIVE_CURRENT}>
            {`Modbus VFD - ${vfdText(definition?.name) ?? 'unnamed inverter'}`}
          </option>
        )}
        {VFD_MODEL_TEMPLATES.map((template) => (
          <option key={template.id} value={`vfd:${template.id}`}>
            {`Modbus VFD - ${template.label}`}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Port, baud (serial only) and inverter name, for a summary line that shows
 *  something without opening the full section (WO-1691's collapsed VFD
 *  link). Whichever transport the document names, in the document's own
 *  words - a TCP inverter's "port" is `host:tcpPort`, not an empty COM box. */
export function vfdLinkSummary(definition: VfdDefinition | MachineSpindleLinkDefinition): {
  port: string | null
  baud: string | null
  name: string | null
} {
  const port = definition.link.transport === 'tcp'
    ? (vfdText(definition.link.host) !== null && vfdText(definition.link.tcpPort) !== null
      ? `${definition.link.host}:${definition.link.tcpPort}`
      : null)
    : vfdText(definition.link.port)
  const baud = definition.link.transport === 'tcp' ? null : vfdText(definition.link.baud)
  return { port, baud, name: vfdText(definition.name) }
}

export function SpindleLinkSection({
  link, foreign, stored, storedIsStated, edit, machineId, showDrive = true,
}: {
  link: VfdPortLinkState
  foreign: boolean
  /** What to CALL the machine the bridge was started for - its library name,
   *  or its id when the library has no entry, or null when the connection
   *  named no machine at all. Only read when `foreign`. */
  otherMachine: string | null
  stored: MachineSpindleLinkDefinition | null | undefined
  storedIsStated: boolean
  edit: VfdEditContext
  /** The machine whose definition this is. Absent means the Control
   *  machine, which is the record the Definition page edits. */
  machineId?: string
  /** The Drive picker. The Spindle area (WO-1691) carries it; the temporary
   *  Legacy tab keeps the page exactly as it stood (WO-1687) and does not. */
  showDrive?: boolean
}) {
  const owner = machineId ?? null
  const definition = resolvedSpindleLink({ link, foreign, stored, storedIsStated })
  const applied = definition !== null && definition !== undefined
    && link.machineId !== null && !foreign && link.applied !== null
    && vfdOperationalSignature(link.applied) === vfdOperationalSignature(definition)
  return (
    <div data-testid="machine-def-panel-vfd-link" style={{ marginBottom: 14 }}>
      <SectionHead
        title="Spindle link (Modbus VFD)"
        summary="This machine's editable inverter definition"
        testId="machine-def-panel-vfd-link-head"
      />
      <div
        data-testid="machine-def-panel-vfd-link-boundary"
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
      >
        This machine's definition is the one copy of its inverter settings. The bridge for this
        machine is handed it on connect, and every accepted edit is sent to it immediately; every
        edit clears commissioning verification. Applied means the bridge holds this document;
        verified means commissioning proved it against the inverter. Required keypad parameters
        below are separate and are never sent.
      </div>

      {showDrive && (
        <SpindleDrivePicker machineId={owner} definition={definition} disabled={edit.disabled} />
      )}

      {definition === null || definition === undefined ? (
        <div
          data-testid="machine-def-panel-vfd-link-absent"
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
        >
          {showDrive
            ? 'This machine has no VFD link. Choose a Modbus VFD under Drive to declare one; every '
              + 'field is then editable here.'
            : 'This machine has no VFD link. Declare one under Drive in the Spindle area.'}
        </div>
      ) : (
        <>
          <div data-testid="machine-def-panel-vfd-apply-state" style={{ display: 'flex', gap: 16 }}>
            <VfdReadout
              label="applied by bridge"
              value={applied ? 'yes' : 'no'}
              testId="machine-def-vfd-applied"
            />
            <VfdReadout
              label="verified against inverter"
              value={definition.verified ? 'yes' : 'no'}
              testId="machine-def-vfd-verified"
            />
          </div>
          <label
            data-testid="machine-def-vfd-direction-inverted"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
              fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)',
            }}
          >
            <input
              data-wired=""
              type="checkbox"
              aria-label="Reverse spindle direction"
              checked={'directionInverted' in definition && definition.directionInverted === true}
              disabled={edit.disabled}
              aria-disabled={edit.disabled}
              onChange={(event) => edit.onDirectionChange(event.target.checked)}
            />
            Reverse spindle direction in software
          </label>
          <VfdRows
            title="Inverter"
            summary="Which definition the bridge is running, and where it came from"
            testId="machine-def-panel-vfd-identity"
            slug="identity"
            rows={[
              ['name', vfdText(definition.name), ['name']],
              ['id', vfdText(definition.id), ['id']],
              ['provenance', vfdText(definition.provenance?.kind)],
              ['source', vfdText(definition.provenance?.source)],
              ['schema version', vfdText(definition.schemaVersion)],
              ['up-to-speed tolerance (rpm)', vfdText(definition.upToSpeedToleranceRpm), ['upToSpeedToleranceRpm']],
            ]}
            edit={edit}
          />
          <VfdLinkBlock
            key={owner ?? ''}
            machineId={owner}
            definition={definition}
            edit={edit}
          />
          <VfdRows
            title="Modbus protocol"
            summary="Function codes, and which half of a two-register value goes first"
            testId="machine-def-panel-vfd-protocol"
            slug="protocol"
            rows={vfdProtocolRows(definition)}
            edit={edit}
          />

          <div data-testid="machine-def-panel-vfd-registers" style={{ marginTop: 10 }}>
            <SectionHead
              title="Registers"
              summary={
                'Where each value lives on the inverter, how many registers it spans '
                + '(the setpoint is 1 for a 16-bit drive, 2 for a 32-bit one) and how the '
                + 'setpoint is scaled'
              }
              testId="machine-def-panel-vfd-registers-head"
            />
            <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
              <table
                className="mform-axis-table"
                data-testid="machine-def-panel-vfd-register-table"
                style={{ width: 'max-content', minWidth: '100%' }}
              >
                <thead>
                  <tr>
                    <th>role</th><th>address</th><th>words</th>
                    <th>scale</th><th>rounding</th><th>minimum</th><th>maximum</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...VFD_REGISTER_ROLES,
                    // WO-1735: an optional role appears when the document
                    // states it, and simply is not a row when it does not -
                    // never an empty row claiming a register with no address.
                    ...VFD_OPTIONAL_REGISTER_ROLES.filter((role) => definition.registers?.[role] !== undefined),
                  ].map((role) => {
                    return (
                      <tr key={role} data-testid={`machine-def-panel-vfd-register-row-${role}`}>
                        <td>{role}</td>
                        {vfdRegisterRows(definition, role).map(([column, value, path]) => (
                          <td key={column}>
                            <VfdReadout
                              label=""
                              value={value}
                              path={value === null ? undefined : path}
                              edit={edit}
                              testId={`machine-def-vfd-register-${role}-${column}`}
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

          <VfdRunStateValues
            key={`${owner ?? ''}:${definition.id}`}
            machineId={owner}
            definition={definition}
            edit={edit}
          />

          <VfdFaultCodeRegisterSection
            key={`fault:${owner ?? ''}:${definition.id}`}
            machineId={owner}
            definition={definition}
            edit={edit}
          />

          <VfdRows
            title="Commands"
            summary="What the bridge writes to run and to stop"
            testId="machine-def-panel-vfd-commands"
            slug="command"
            rows={definition.commands ? vfdCommandRows(definition.commands) : []}
            edit={edit}
          />

          {(definition.resetSequence?.length ?? 0) > 0 && (
            <VfdRows
              title="Fault reset sequence"
              summary="What clearing a fault writes, and how long it waits between steps"
              testId="machine-def-panel-vfd-reset"
              slug="reset"
              rows={definition.resetSequence.flatMap((step, index): VfdRow[] => [
                [`step ${index + 1} command`, vfdText(step.command), ['resetSequence', index, 'command']],
                [`step ${index + 1} wait (ms)`, vfdText(step.delayMsAfter), ['resetSequence', index, 'delayMsAfter']],
              ])}
              edit={edit}
            />
          )}

          <div data-testid="machine-def-panel-vfd-status" style={{ marginTop: 10 }}>
            <SectionHead
              title="Telemetry"
              summary="Which words of the status block become which reading"
              testId="machine-def-panel-vfd-status-head"
            />
            <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
              <table
                className="mform-axis-table"
                data-testid="machine-def-panel-vfd-status-table"
                style={{ width: 'max-content', minWidth: '100%' }}
              >
                <thead>
                  <tr><th>reading</th><th>source</th><th>word offset</th><th>scale</th></tr>
                </thead>
                <tbody>
                  {(definition.status ?? []).map((field) => (
                    <tr
                      key={field.name}
                      data-testid={`machine-def-panel-vfd-status-row-${field.name}`}
                    >
                      <td>
                        <VfdReadout
                          label="" value={vfdText(field.name)}
                          testId={`machine-def-vfd-status-${field.name}-name`}
                          path={['status', definition.status.indexOf(field), 'name']}
                          edit={edit}
                        />
                      </td>
                      {([
                        ['source', vfdText(field.source), ['status', definition.status.indexOf(field), 'source']],
                        // A DERIVED field has no word offset, and this is the
                        // one place that difference is visible: Operator's `power`
                        // is `field.volts * field.amps` and reads no register
                        // at all. `offset` is absent from its document, so the
                        // cell is empty rather than a 0 that would say it
                        // reads the first word.
                        ['offset', field.source === 'register' ? vfdText(field.offset) : null, ['status', definition.status.indexOf(field), 'offset']],
                        ['scale', vfdText(field.scale), ['status', definition.status.indexOf(field), 'scale']],
                      ] as VfdRow[]).map(([column, value, path]) => (
                        <td key={column}>
                          <VfdReadout
                            label=""
                              value={value}
                              path={value === null ? undefined : path}
                              edit={edit}
                            testId={`machine-def-vfd-status-${field.name}-${column}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <VfdRows
            title="Fault rule and constants"
            summary="What counts as a fault, and the named numbers the scales may use"
            testId="machine-def-panel-vfd-fault"
            slug="fault"
            rows={[
              ['fault rule', definition.fault ? vfdText(definition.fault.kind) : null, ['fault', 'kind']],
              ...(definition.fault?.kind === 'equals'
                ? [['fault value', vfdText(definition.fault.value), ['fault', 'value']] as VfdRow]
                : definition.fault?.kind === 'mask'
                  ? [['fault mask', vfdText(definition.fault.mask), ['fault', 'mask']] as VfdRow]
                  : []),
              ...Object.entries(definition.constants ?? {})
                .map(([name, value]): VfdRow => [name, vfdText(value), ['constants', name]]),
            ]}
            edit={edit}
          />

          <VfdRequiredParameters machineId={owner} definition={definition} edit={edit} />

          {vfdText(definition.notes) !== null && (
            <div data-testid="machine-def-panel-vfd-notes" style={{ marginTop: 10 }}>
              <SectionHead
                title="Notes"
                summary="What the definition's author wrote about this inverter"
                testId="machine-def-panel-vfd-notes-head"
              />
              <VfdReadout
                label="" value={vfdText(definition.notes)} testId="machine-def-vfd-notes"
                path={['notes']} edit={edit}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
