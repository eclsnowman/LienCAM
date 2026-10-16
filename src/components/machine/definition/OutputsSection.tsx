import { catalogChildren, liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useState } from 'react'
import { type MachineConfig } from '../../../types'
import { type MachineOutputDefinition } from '../../../types'
import { type MachineMCode } from '../../../types'
import { type CoolantChannel } from '../../../types'
import { normalizeMachineMCode } from '../../../types'
import { RESERVED_VACUUM_M_CODE_REASON } from '../../../types'
import { UNASSIGNED_PIN } from '../../../types'
import { withCoolantCapability } from '../../../types'
import { withEnabledCoolantCapability } from '../../../types'
import { withVacuumCapability } from '../../../types'
import { statedCoolantCapability } from '../../../types'
import { describeCoolantCodeMove } from '../../../types'
import { useMachineControl } from '../../../store/machineControlStore'
import { outputTurnedOff } from '../../../lib/machine/machineOutputs'
import { SectionHead } from './DefinitionFields'
import { PinField } from './DefinitionFields'
import { DefNumber } from './DefinitionFields'

/** The CAM role a row may claim, and the blank choice that means "no role -
 *  a pump, a dust boot or air, switched by its word and never asked for
 *  abstractly" (see the module doc). */
const CAM_ROLE_OPTIONS: { value: CoolantChannel | ''; label: string }[] = liveCatalog(() => ([
  { value: '', label: controlText('OutputsSection.text001') },
  { value: 'flood', label: controlText('OutputsSection.text002') },
  { value: 'mist', label: controlText('OutputsSection.text003') },
  { value: 'vacuum', label: controlText('OutputsSection.text004') },
]))


/**
 * WO-1708 + WO-1777: THE ONE DISPLAY RULE FOR AN IMPORTED CAM ROLE, shared by
 * this area's role column and the All settings table's `outputs.N.role` row,
 * so the two surfaces can never give two answers side by side about the same
 * stored fact.
 *
 * An imported relay's `role` is wiring evidence written at import time
 * (`uccncProfileOutputs`), not an answer anybody gave. The heading's answer is
 * `statedCoolantCapability` - true, false, or null for "nobody has answered" -
 * so a Flood/Mist role shows exactly when the record states Yes for that
 * channel, and the control is blank on BOTH other routes:
 *   - stated No (WO-1708): a machine can state "no flood" while the row UCCNC
 *     calls "flood coolant" still carries `role: 'flood'` from the pin import;
 *   - not stated (WO-1777): the same imported role next to a heading saying
 *     "flood not stated" was two answers side by side on Operator's seeded
 *     machine. The comment above `setOutputRole` already called the imported
 *     role "wiring evidence, not yet an answer" - the display now agrees.
 * Blanking is display-only: the stored role, pin and word are untouched, and
 * picking the role in a real change event still writes Yes through
 * `withEnabledCoolantCapability`, so unknown is never turned into an
 * affirmative capability or a stored answer by merely looking at it. A vacuum
 * role keeps WO-1708's rule unchanged because `statedCoolantCapability
 * ('vacuum')` reads the output list first and so is never false or null while
 * a row claims it.
 */
export const statedCoolantRole = (
  machine: MachineConfig,
  role: CoolantChannel | undefined,
): CoolantChannel | '' => {
  if (role === undefined) return ''
  const stated = statedCoolantCapability(machine, role)
  if (role === 'vacuum') return stated === false ? '' : role
  return stated === true ? role : ''
}

/**
 * WO-1651: THE ONE PLACE A PERSON ADDS, EDITS OR REMOVES AN OUTPUT.
 *
 * Operator ruling 2026-09-17: "They define the pins. They point them at the use cases
 * like a pump or a vacuum or whatever they want to run in the macro and it
 * works." AND: "My machine is just the test bed. This needs to be able to be
 * used by anyone."
 *
 * THIS EDITS THE ONE LIST (WO-1649), AND BUILDS NO SECOND MODEL.
 * `controllerDefinition.outputs` is the whole record - flood, mist, a vacuum,
 * a pump, air, whatever the operator wires. A UCCNC import fills the same
 * list (`uccncProfileOutputs`), so an imported flood or mist relay shows up
 * here exactly like a hand-typed pump; there is no separate imported-outputs
 * view to keep in step with this one.
 *
 * A CODE ALREADY USED BY ANOTHER OUTPUT IS NOT REFUSED. `resolveMachineOutputWord`
 * switches every entry that names a word (WO-1649: "a pump that must run
 * whenever flood does" is a real machine, not a mistake), so a shared word is
 * flagged on the field, in place, rather than blocked.
 */
export function OutputsSection({ machine, onChange }: {
  machine: MachineConfig
  onChange: (mut: (m: MachineConfig) => MachineConfig) => void
}) {
  useText('control-screens-not-probing')
  const outputs = machine.controllerDefinition?.outputs ?? []

  const writeOutputs = (next: MachineOutputDefinition[]): void => {
    onChange((m) => (m.controllerDefinition
      ? { ...m, controllerDefinition: { ...m.controllerDefinition, outputs: next } }
      : m))
  }

  const patchOutput = (index: number, patch: Partial<MachineOutputDefinition>): void => {
    writeOutputs(outputs.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  }

  /**
   * WO-1692: THE CAM ROLE COLUMN IS NOW THE ONLY EDITOR OF "DOES THIS MACHINE
   * HAVE FLOOD/MIST/VACUUM", folding `CoolantCapabilitySection`'s deleted
   * Yes/No block into this list. A row's role IS the answer: give a row the
   * role and the machine states it has that channel, clear it and the machine
   * states it does not - no separate control asks the same question twice.
   *
   * WHY THIS STILL WRITES `coolantCapability` for mist/flood. Only vacuum's
   * capability reads the outputs list directly (`machineOutputForChannel`,
   * types/index.ts); mist and flood still answer from `coolantCapability`
   * because every other reader of that fact - the Control page, the post -
   * is outside this order's lane. So the role write goes through the same
   * seam the deleted selects used (`withEnabledCoolantCapability` /
   * `withCoolantCapability`), which is what keeps this one control doing both
   * jobs instead of needing a second writer somewhere else.
   *
   * ONE OWNER PER ROLE, the same invariant `reconcileCoolantCapability`
   * enforces for M-codes: giving a row a role takes it off whichever other
   * row held it.
   *
   * WO-1708: computed from `machine`, not the `onChange` mutator's own
   * argument, so `next` is a value this function can also hand to
   * `describeCoolantCodeMove` - the same shape `CoolantCapabilitySection`'s
   * `writeCoolantAnswer` already uses to print the one console line a moved
   * vacuum code earns, in the old Yes select's own words. Picking a role
   * always runs `withEnabledCoolantCapability`, whether or not the row
   * already carried that role (an imported relay's role is wiring evidence,
   * not yet an answer - see `OutputRow`'s `displayedRole`), so the operator
   * never has to clear and re-pick to say Yes.
   */
  const setOutputRole = (index: number, role: CoolantChannel | ''): void => {
    const previousRole = outputs[index]?.role
    const nextOutputs = outputs.map((o, i) => {
      if (i === index) return { ...o, role: role === '' ? undefined : role }
      return role !== '' && o.role === role ? { ...o, role: undefined } : o
    })
    let next = machine.controllerDefinition
      ? { ...machine, controllerDefinition: { ...machine.controllerDefinition, outputs: nextOutputs } }
      : machine
    const stillListed = (channel: CoolantChannel) => nextOutputs.some((o) => o.role === channel)
    if (role === 'mist' || role === 'flood') next = withEnabledCoolantCapability(next, role)
    if (
      (previousRole === 'mist' || previousRole === 'flood')
      && previousRole !== role && !stillListed(previousRole)
    ) {
      next = withCoolantCapability(next, previousRole, false)
    }
    if (previousRole === 'vacuum' && role !== 'vacuum' && !stillListed('vacuum')) {
      next = withVacuumCapability(next, false)
    }
    onChange(() => next)
    const moved = describeCoolantCodeMove(machine, next)
    if (moved) useMachineControl.getState().pushConsole('tx', moved, 'warn')
  }

  /** THE ROLE COLUMN AND THE HEADING READ THE SAME STORED ANSWER - the rule
   *  and its whole history live in `statedCoolantRole` above, which the All
   *  settings table shares so the two views cannot disagree. */
  const displayedRole = (output: MachineOutputDefinition): CoolantChannel | '' =>
    statedCoolantRole(machine, output.role)

  const removeOutput = (index: number): void => {
    const removedRole = outputs[index]?.role
    const nextOutputs = outputs.filter((_, i) => i !== index)
    onChange((m) => {
      let next = m.controllerDefinition
        ? { ...m, controllerDefinition: { ...m.controllerDefinition, outputs: nextOutputs } }
        : m
      const stillListed = (channel: CoolantChannel) => nextOutputs.some((o) => o.role === channel)
      if ((removedRole === 'mist' || removedRole === 'flood') && !stillListed(removedRole)) {
        next = withCoolantCapability(next, removedRole, false)
      }
      if (removedRole === 'vacuum' && !stillListed('vacuum')) {
        next = withVacuumCapability(next, false)
      }
      return next
    })
  }

  const addOutput = (): void => {
    const used = new Set(outputs.flatMap((o) => [o.onCode, o.offCode]))
    let n = 10
    while (used.has(`M${n}` as MachineMCode)) n += 1
    writeOutputs([
      ...outputs,
      { name: '', onCode: `M${n}` as MachineMCode, offCode: null, pin: UNASSIGNED_PIN },
    ])
  }

  /**
   * WO-1703 fix round 3: OUTPUTS THE CONTROLLER SWITCHES WITH ONE SETTING GET
   * ONE CONTROL. UCCNC has a single `Floodmistrelaysenabled` for its M7 and M8
   * relays (`sharedSwitch`), so the pair is ticked on or off together, here,
   * once - never per row, which let the page say "M8 switches nothing" while
   * the exported flag still switched it. The group reads on if ANY member is
   * on, the same answer the resolver and the export give a mixed record.
   */
  const sharedGroups = [...new Set(outputs.flatMap((o) => (o.sharedSwitch === undefined ? [] : [o.sharedSwitch])))]
  const groupCodes = (group: string): MachineMCode[] =>
    outputs.filter((o) => o.sharedSwitch === group).map((o) => o.onCode).sort()
  const setGroupInUse = (group: string, inUse: boolean): void => {
    writeOutputs(outputs.map((o) => (o.sharedSwitch === group
      ? { ...o, disabled: inUse ? undefined : true }
      : o)))
  }
  const controllerName = machine.controller === 'uccnc' ? 'UCCNC' : controlText('OutputsSection.text005')

  /** A code another entry already switches - a real machine shape, so it is
   *  said rather than refused (see the module doc). */
  const codeConflict = (index: number, code: MachineMCode | null): string | undefined => {
    if (code === null) return undefined
    const other = outputs.find((o, i) => i !== index && (o.onCode === code || o.offCode === code))
    return other === undefined
      ? undefined
      : controlText('OutputsSection.text007', { value1: String(code), value2: String(other.name || controlText('OutputsSection.text006')) })
  }

  return (
    <div data-testid="machine-def-panel-outputs" style={{ marginTop: 12 }}>
      <SectionHead
        title={controlText('OutputsSection.text008')}
        summary={outputs.length === 0
          ? 'none defined'
          : outputs.map((o) => o.name || o.onCode).join(', ')}
        testId="machine-def-panel-head-outputs"
      />
      <div
        data-testid="machine-def-panel-outputs-boundary"
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
      >{controlText('OutputsSection.text009')}</div>
      {outputs.length === 0 ? (
        <div
          data-testid="machine-def-panel-outputs-none"
          style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 8 }}
        >{controlText('OutputsSection.text010')}</div>
      ) : (
        <table
          className="mform-axis-table"
          data-testid="machine-def-panel-outputs-table"
          style={{ width: 'auto' }}
        >
          <thead>
            <tr>
              <th>{controlText('OutputsSection.text011')}</th>
              <th data-tooltip={controlText('OutputsSection.text012')}>{controlText('OutputsSection.text013')}</th>
              <th data-tooltip={controlText('OutputsSection.text014')}>{controlText('OutputsSection.text015')}</th>
              <th data-tooltip={controlText('OutputsSection.text016')}>{controlText('OutputsSection.text017')}</th>
              <th data-tooltip={controlText('OutputsSection.text018')}>{controlText('OutputsSection.text019')}</th>
              <th data-tooltip={controlText('OutputsSection.text020')}>{controlText('OutputsSection.text021')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {outputs.map((output, index) => (
              <OutputRow
                key={index}
                output={output}
                displayedRole={displayedRole(output)}
                index={index}
                onCodeConflict={codeConflict(index, output.onCode)}
                offCodeConflict={codeConflict(index, output.offCode)}
                turnedOff={outputTurnedOff(output, outputs)}
                offCodes={output.sharedSwitch === undefined
                  ? output.onCode
                  : groupCodes(output.sharedSwitch).join(' or ')}
                onPatch={(patch) => { patchOutput(index, patch) }}
                onRoleChange={(role) => { setOutputRole(index, role) }}
                onRemove={() => { removeOutput(index) }}
              />
            ))}
          </tbody>
        </table>
      )}
      {sharedGroups.map((group) => {
        const members = outputs.filter((o) => o.sharedSwitch === group)
        const inUse = !members.every((o) => o.disabled === true)
        return (
          <label
            key={group}
            data-wired=""
            style={{ display: 'block', fontSize: 'var(--font-size-sm)', margin: '4px 0 8px' }}
          >
            <input
              type="checkbox"
              data-testid={`machine-def-output-shared-enabled-${group.replace(/\s+/g, '-')}`}
              checked={inUse}
              onChange={(e) => { setGroupInUse(group, e.target.checked) }}
            />
            {controlText('OutputsSection.text022', { value1: String(group.charAt(0).toUpperCase()), value2: String(group.slice(1)), value3: String(controllerName), value4: String(groupCodes(group).join(' and ')) })}
          </label>
        )
      })}
      <button
        type="button"
        className="control-chip-btn"
        data-testid="machine-def-outputs-add"
        onClick={addOutput}
      >{controlText('OutputsSection.text023')}</button>
    </div>
  )
}

/** One row: name, on code, off code, pin, on-delay, remove. Every input here
 *  is `data-wired` - `resolveMachineOutputWord` reads exactly these fields and
 *  `ctrl.setOutput` acts on the pin the moment the matching word is sent
 *  (`src/lib/machine/machineSession.ts`), whether that word comes from the
 *  Control page, MDI, or a posted program. */
function OutputRow({
  output, displayedRole, index, onCodeConflict, offCodeConflict, turnedOff, offCodes,
  onPatch, onRoleChange, onRemove,
}: {
  output: MachineOutputDefinition
  displayedRole: CoolantChannel | ''
  index: number
  onCodeConflict: string | undefined
  offCodeConflict: string | undefined
  /** Its word switches nothing, answered as the controller answers it. */
  turnedOff: boolean
  /** The words that stop switching when it is off: its own, or its whole
   *  shared group's ("M7 or M8"). */
  offCodes: string
  onPatch: (patch: Partial<MachineOutputDefinition>) => void
  onRoleChange: (role: CoolantChannel | '') => void
  onRemove: () => void
}) {
  useText('control-screens-not-probing')
  return (
    <tr data-testid={`machine-def-output-row-${index}`} data-wired="">
      <td>
        <input
          className="mform-input"
          type="text"
          aria-label={controlText('OutputsSection.text024', { value1: String(index + 1) })}
          data-testid={`machine-def-output-name-${index}`}
          value={output.name}
          onChange={(e) => { onPatch({ name: e.target.value }) }}
          style={{ width: 120 }}
        />
      </td>
      <td>
        <OutputCodeField
          testId={`machine-def-output-oncode-${index}`}
          ariaLabel={controlText('OutputsSection.text025', { value1: String(index + 1) })}
          value={output.onCode}
          allowEmpty={false}
          conflict={onCodeConflict}
          onCommit={(code) => { if (code !== null) onPatch({ onCode: code }) }}
        />
      </td>
      <td>
        <OutputCodeField
          testId={`machine-def-output-offcode-${index}`}
          ariaLabel={controlText('OutputsSection.text026', { value1: String(index + 1) })}
          value={output.offCode ?? ''}
          allowEmpty
          conflict={offCodeConflict}
          onCommit={(code) => { onPatch({ offCode: code }) }}
        />
      </td>
      <td>
        <PinField
          label=""
          name={`output ${index + 1} pin`}
          testId={`machine-def-output-pin-${index}`}
          value={output.pin}
          onChange={(pin) => { onPatch({ pin }) }}
        />
        {/* WO-1703: ON OR OFF IS ITS OWN FACT, NEVER A BLANKED PIN. A relay the
            profile turned off keeps its real pin above. A row in a shared
            group is ticked by the one group control under the table; a row of
            its own gets a tick only when a loaded record already has it off -
            the way back on, and no control nobody asked for otherwise. */}
        {output.sharedSwitch === undefined && output.disabled === true && (
          <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginTop: 2 }}>
            <input
              type="checkbox"
              aria-label={controlText('OutputsSection.text027', { value1: String(index + 1) })}
              data-testid={`machine-def-output-enabled-${index}`}
              checked={false}
              onChange={(e) => { if (e.target.checked) onPatch({ disabled: undefined }) }}
            />
            {controlText('OutputsSection.text028')}
          </label>
        )}
        {turnedOff && (
          <div
            data-testid={`machine-def-output-disabled-${index}`}
            style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}
          >{catalogChildren(controlText('OutputsSection.text029', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: output.pin.port, value2: output.pin.pin, value3: offCodes })}</div>
        )}
      </td>
      <td>
        <select
          className="mform-select"
          aria-label={controlText('OutputsSection.text030', { value1: String(index + 1) })}
          data-testid={`machine-def-output-role-${index}`}
          value={displayedRole}
          onChange={(e) => { onRoleChange(e.target.value as CoolantChannel | '') }}
        >
          {CAM_ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </td>
      <td>
        <DefNumber
          label=""
          name={`output ${index + 1} on delay (milliseconds)`}
          value={output.onDelayMs ?? 0}
          min={0}
          step={10}
          width={60}
          onChange={(v) => { onPatch({ onDelayMs: v === 0 ? undefined : v }) }}
        />
      </td>
      <td>
        <button
          type="button"
          className="control-chip-btn"
          data-testid={`machine-def-output-remove-${index}`}
          onClick={onRemove}
        >{controlText('OutputsSection.text031')}</button>
      </td>
    </tr>
  )
}

/**
 * ONE M-CODE BOX: an on code (never empty) or an off code (empty means "only
 * the shared M9"). A reserved or unparsable word is refused and reverts, the
 * same rule `normalizeMachineMCode` already applies to the vacuum's own code
 * box (`CoolantCapabilitySection`) - flagged here rather than moved, because
 * an output has no fallback word to move to. A word another entry already
 * switches is not refused (see the module doc) and is flagged the same way.
 */
function OutputCodeField({ testId, ariaLabel, value, allowEmpty, conflict, onCommit }: {
  testId: string
  ariaLabel: string
  value: string
  allowEmpty: boolean
  conflict: string | undefined
  onCommit: (code: MachineMCode | null) => void
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [reserved, setReserved] = useState(false)
  const shown = pending ?? value
  const problem = reserved ? RESERVED_VACUUM_M_CODE_REASON : conflict
  return (
    <input
      className="mform-input mform-input-mono"
      type="text"
      aria-label={ariaLabel}
      aria-invalid={problem !== undefined || undefined}
      data-testid={testId}
      data-tooltip={problem}
      value={shown}
      onChange={(e) => { setPending(e.target.value); setReserved(false) }}
      onBlur={() => {
        if (pending === null) return
        const trimmed = pending.trim()
        if (allowEmpty && trimmed === '') {
          setReserved(false)
          onCommit(null)
          setPending(null)
          return
        }
        const code = normalizeMachineMCode(trimmed)
        if (code === null) {
          setReserved(true)
          setPending(null)
          return
        }
        setReserved(false)
        onCommit(code)
        setPending(null)
      }}
      style={{
        width: 56, flex: 'none',
        borderColor: problem !== undefined ? 'var(--accent-red)' : undefined,
      }}
    />
  )
}
