import { liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { type MachineConfig } from '../../../types'
import { type SettingSource } from './DefinitionFields'
import { machineVacuumCapability } from '../../../types'
import { statedCoolantCapability } from '../../../types'
import { type MachineMCode } from '../../../types'
import { describeVacuumCodeMove } from '../../../types'
import { describeCoolantCodeMove } from '../../../types'
import { useMachineControl } from '../../../store/machineControlStore'
import { vacuumRelayFromUccncDefinition } from '../../../lib/machine/uccncProfileImport'
import { SectionHead } from './DefinitionFields'
import { describeCoolantCapability } from '../../../types'
import { withEnabledCoolantCapability } from '../../../types'
import { withCoolantCapability } from '../../../types'
import { withVacuumCapability } from '../../../types'
import { RESERVED_VACUUM_M_CODE_REASON } from '../../../types'
import { normalizeMachineMCode } from '../../../types'
import { coolantRecordAgrees } from '../../../types'


/**
 * DOES THIS MACHINE EVEN HAVE COOLANT? (WO-965)
 *
 * Operator ruling 2026-08-24: "One condition I have is in machine definition I want to be
 * able to toggle if mist or flood even exist. If they do not, don't even show
 * the buttons. Not many hobby CNC users even have coolant. It is far more
 * likely to have vacuum. That is what I have. I have no coolant at all. So they
 * are nice to have, but the buttons are of no use to me. But they may be to
 * others."
 *
 * TWO CALL SITES, ONE EDITOR, AND THEY ARE MUTUALLY EXCLUSIVE - exactly the
 * shape `SkewField` has, for exactly the same reason. Inside the Motion group
 * for a machine that has a controller definition; standalone for one that does
 * not. Whether anybody has typed this machine's pins yet has no bearing on
 * whether it has a mist tank, and "not many hobby CNC users even have coolant"
 * is a sentence about precisely the machines nobody has finished describing.
 *
 * WHY IT IS NOT INSIDE THE SPINDLE GROUP BELOW, which is where this order's
 * grant put it: that group is `unsent.catalogued` - the UCCNC `.pro` catalogue,
 * which renders for no other controller (see `SettingSource.catalogued`). A
 * GRBL machine and the simulator would then have no way to answer a question
 * that is about the machine and not about UCCNC.
 */
export function CoolantCapabilitySection({ machine, onChange }: {
  machine: MachineConfig
  onChange: (mut: (m: MachineConfig) => MachineConfig) => void
  /** The `.pro` catalogue, when this machine has one. WO-1703: no longer read
   *  here - the outputs list's own row is the evidence now
   *  (`OutputsSection`'s port/pin/negate columns) - kept in the prop only
   *  because `MotionSection` still passes it through. */
  settings?: SettingSource
}) {
  useText('control-screens-not-probing')
  /**
   * WO-1692: A MACHINE WITH A CONTROLLER DEFINITION HAS AN OUTPUTS LIST
   * (WO-1651), AND THE LIST'S CAM ROLE COLUMN IS NOW WHERE ITS FLOOD, MIST AND
   * VACUUM ANSWERS ARE GIVEN - see `OutputsSection.setOutputRole`. This
   * section's own Yes/No block is this order's outcome 2: folded into that
   * column and deleted here, for exactly the machines that have a list to fold
   * into. A machine with NO controller definition has no outputs list at all
   * (`OutputsSection` writes nothing for one), and whether it has a mist tank
   * has no bearing on whether anybody has typed its pins yet - the same
   * argument the standalone call site already made for this whole section
   * (see the module doc) - so the Yes/No block stays exactly where it was for
   * that machine, unowned by any other surface.
   */
  const hasOutputsList = machine.controllerDefinition != null
  const vacuum = machineVacuumCapability(machine)
  const vacuumStated = statedCoolantCapability(machine, 'vacuum')
  /**
   * THE ONLY WAY THIS PANEL WRITES A COOLANT OR VACUUM ANSWER.
   *
   * It holds no rule of its own. `withCoolantCapability`, `withVacuumCapability`
   * and `withEnabledCoolantCapability` all end in the single reconcile in
   * `types/index.ts`, which is what decides whether a code had to move; this
   * just reports what it did, in that reconcile's own words. Attempts 4 and 5 of
   * WO-1058 put collision guards on each control here instead, and every round
   * of review found another control that had not been given one.
   */
  const writeCoolantAnswer = (
    write: (m: MachineConfig) => MachineConfig,
    /** The code this write ASKED FOR, where the surface knows it - the M-code
     *  box does, an answer dropdown does not. Without it the note can only
     *  compare the record before and after, which cannot tell an operator's own
     *  legal edit from a move the reconcile made (round 13's finding). */
    requestedVacuumCode?: MachineMCode,
  ): MachineConfig => {
    const next = write(machine)
    onChange(() => next)
    const moved = requestedVacuumCode
      ? describeVacuumCodeMove(requestedVacuumCode, next)
      : describeCoolantCodeMove(machine, next)
    if (moved) useMachineControl.getState().pushConsole('tx', moved, 'warn')
    return next
  }
  const vacuumRelay = vacuum
    ? vacuumRelayFromUccncDefinition(machine.controllerDefinition, vacuum.onCode)
    : null
  const vacuumMapping = vacuum
    ? vacuumRelay
      ? controlText('CoolantCapabilitySection.text001', { value1: String(vacuum.onCode), value2: String(vacuumRelay.port), value3: String(vacuumRelay.pin) })
      : vacuum.onCode === 'M7' || vacuum.onCode === 'M8'
        ? controlText('CoolantCapabilitySection.text002', { value1: String(vacuum.onCode) })
        : controlText('CoolantCapabilitySection.text003', { value1: String(vacuum.onCode) })
    : null
  return (
    <div data-testid="machine-def-panel-coolant" style={{ marginTop: 12 }}>
      <SectionHead
        title={controlText('CoolantCapabilitySection.text004')}
        summary={[...COOLANT_CHANNELS
          .map(({ channel, label }) =>
            `${label.toLowerCase()} ${describeCoolantCapability(
              statedCoolantCapability(machine, channel),
            ).toLowerCase()}`),
          `vacuum ${describeCoolantCapability(vacuumStated).toLowerCase()}`]
          .join(', ')}
        testId="machine-def-panel-head-coolant"
      />
      <div
        data-testid="machine-def-panel-coolant-boundary"
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginBottom: 8 }}
      >
        {hasOutputsList
          ? controlText('CoolantCapabilitySection.text005')
            + controlText('CoolantCapabilitySection.text006')
            + controlText('CoolantCapabilitySection.text007')
          : controlText('CoolantCapabilitySection.text008')
            + controlText('CoolantCapabilitySection.text009')
            + controlText('CoolantCapabilitySection.text010')}
      </div>
      {!hasOutputsList && <table
        className="mform-axis-table"
        data-testid="machine-def-panel-coolant-table"
        style={{ width: 'auto' }}
      >
        <thead>
          <tr>
            <th>{controlText('CoolantCapabilitySection.text011')}</th>
            <th data-tooltip={controlText('CoolantCapabilitySection.text012')}>{controlText('CoolantCapabilitySection.text013')}</th>
            <th data-tooltip={controlText('CoolantCapabilitySection.text014')}>{controlText('CoolantCapabilitySection.text015')}</th>
          </tr>
        </thead>
        <tbody>
          {COOLANT_CHANNELS.map(({ channel, label, code }) => {
            const stated = statedCoolantCapability(machine, channel)
            return (
              <tr key={channel} data-testid={`machine-def-panel-coolant-row-${channel}`}>
                <td>{label} ({code})</td>
                <td>
                  {/* THREE ANSWERS, because there are three and a checkbox can
                      hold two. The empty value is the machine nobody has asked
                      - the state EVERY record written before this order is in -
                      and choosing it again takes the key back off rather than
                      storing a `false`. A stored `false` is a person saying no;
                      absence is nobody having been asked, and the Control page
                      treats those two differently. */}
                  <span
                    data-drives-this-app=""
                    data-testid={`machine-def-coolant-${channel}`}
                    data-tooltip={controlText('CoolantCapabilitySection.text016', { value1: String(label.toLowerCase()) })
                      + controlText('CoolantCapabilitySection.text017', { value1: String(code) })
                      + controlText('CoolantCapabilitySection.text018')}
                  >
                    <select
                      className="mform-select"
                      aria-label={controlText('CoolantCapabilitySection.text019', { value1: String(label.toLowerCase()) })}
                      data-testid={`machine-def-coolant-select-${channel}`}
                      value={stated === null ? '' : stated ? 'yes' : 'no'}
                      onChange={(e) => {
                        const next = e.target.value
                        writeCoolantAnswer((m) => next === 'yes'
                          ? withEnabledCoolantCapability(m, channel)
                          : withCoolantCapability(m, channel, next === '' ? null : false))
                      }}
                    >
                      <option value="">{controlText('CoolantCapabilitySection.text020')}</option>
                      <option value="yes">{controlText('CoolantCapabilitySection.text021')}</option>
                      <option value="no">{controlText('CoolantCapabilitySection.text022')}</option>
                    </select>
                  </span>
                </td>
                <td
                  data-testid={`machine-def-panel-coolant-effect-${channel}`}
                  style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
                >
                  {stated === false
                    ? controlText('CoolantCapabilitySection.text023', { value1: String(label) })
                    : stated === true
                      ? controlText('CoolantCapabilitySection.text024', { value1: String(label) })
                      : controlText('CoolantCapabilitySection.text025', { value1: String(label) })}
                </td>
              </tr>
            )
          })}
          <tr data-testid="machine-def-panel-coolant-row-vacuum">
            <td>{controlText('CoolantCapabilitySection.text026')}</td>
            <td>
              <span
                data-drives-this-app=""
                data-testid="machine-def-coolant-vacuum"
                data-tooltip={controlText('CoolantCapabilitySection.text027')}
              >
                <select
                  className="mform-select"
                  aria-label={controlText('CoolantCapabilitySection.text028')}
                  data-testid="machine-def-coolant-select-vacuum"
                  value={vacuumStated === null ? '' : vacuumStated ? 'yes' : 'no'}
                  onChange={(e) => {
                    const answer = e.target.value
                    const next = writeCoolantAnswer((m) => answer === ''
                      ? withVacuumCapability(m, null)
                      : answer === 'no'
                        ? withVacuumCapability(m, false)
                        : withEnabledCoolantCapability(m, 'vacuum'))
                    const mapped = machineVacuumCapability(next)
                    useMachineControl.getState().pushConsole(
                      'tx',
                      mapped
                        ? controlText('CoolantCapabilitySection.text029', { value1: String(mapped.onCode), value2: String(mapped.onCode) })
                        : answer === 'no'
                          ? controlText('CoolantCapabilitySection.text030')
                          : controlText('CoolantCapabilitySection.text031'),
                      'info',
                    )
                  }}
                >
                  <option value="">{controlText('CoolantCapabilitySection.text032')}</option>
                  <option value="yes">{controlText('CoolantCapabilitySection.text033')}</option>
                  <option value="no">{controlText('CoolantCapabilitySection.text034')}</option>
                </select>
                {vacuum && (
                  <input
                    key={vacuum.onCode}
                    className="mform-input mform-input-mono"
                    aria-label={controlText('CoolantCapabilitySection.text035')}
                    data-testid="machine-def-vacuum-code"
                    data-tooltip={controlText('CoolantCapabilitySection.text036', { value1: String(RESERVED_VACUUM_M_CODE_REASON) })}
                    defaultValue={vacuum.onCode}
                    onBlur={(e) => {
                      if (e.currentTarget.value.trim().toUpperCase() === vacuum.onCode) return
                      const code = normalizeMachineMCode(e.currentTarget.value)
                      if (!code) {
                        e.currentTarget.value = vacuum.onCode
                        useMachineControl.getState().pushConsole(
                          'tx',
                          RESERVED_VACUUM_M_CODE_REASON,
                          'error',
                        )
                        return
                      }
                      const next = writeCoolantAnswer(
                        (m) => withVacuumCapability(m, { onCode: code }),
                        code,
                      )
                      // EVERY STATE CHANGE SAYS WHY (WO-1017), INCLUDING THE
                      // ORDINARY ONE. `writeCoolantAnswer` speaks only when the
                      // reconcile MOVED the code off a word something else
                      // owns; a legal code the person simply chose moves
                      // nothing, and used to leave the console either silent or
                      // - worse, until this round - claiming their old code was
                      // reserved. Say what the machine now does with it.
                      const settled = machineVacuumCapability(next)?.onCode
                      if (settled === code) {
                        useMachineControl.getState().pushConsole(
                          'tx',
                          controlText('CoolantCapabilitySection.text037', { value1: String(code), value2: String(code) }),
                          'info',
                        )
                      }
                    }}
                    style={{ width: 72, marginLeft: 6 }}
                  />
                )}
              </span>
            </td>
            <td
              data-testid="machine-def-panel-coolant-effect-vacuum"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
            >
              {vacuumStated === null
                ? controlText('CoolantCapabilitySection.text038')
                : vacuumStated === false
                  ? controlText('CoolantCapabilitySection.text039')
                  : controlText('CoolantCapabilitySection.text040', { value1: String(vacuumMapping) })}
            </td>
          </tr>
        </tbody>
      </table>}
      {/* THE MACHINE-WIDE HALF OF THE SAME FACT, SAID OUT LOUD.
          `MachineConfig.coolant` is older than this order, it is what the post
          reads (`resolveCoolant` sends every operation dry while it is false),
          and the Machine Library's Coolant tick still edits it on its own. The
          answers above keep it in step through `reconciledMachineCoolant`, so
          this page can never leave the two disagreeing - but the modal can, and
          a disagreement a person cannot see is the second truth this order was
          failed for. So it is printed - and since attempt 2 it can be printed
          as one answer rather than a gap: `resolveCoolant` reads the channel
          now, so what this page says and what the post emits are the same
          fact. */}
      <div
        data-testid="machine-def-panel-coolant-cam"
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', marginTop: 6 }}
      >
        {machine.coolant
          ? controlText('CoolantCapabilitySection.text041')
          : controlText('CoolantCapabilitySection.text042')}
        {vacuum
          ? controlText('CoolantCapabilitySection.text043', { value1: String(vacuum.onCode) })
          : controlText('CoolantCapabilitySection.text044')}
        {controlText('CoolantCapabilitySection.text045')}
        {controlText('CoolantCapabilitySection.text046')}
        {controlText('CoolantCapabilitySection.text047')}
        {controlText('CoolantCapabilitySection.text048')}
        {!coolantRecordAgrees(machine) && (
          <span
            data-testid="machine-def-panel-coolant-disagrees"
            style={{ color: 'var(--accent-amber)' }}
          >
            {controlText('CoolantCapabilitySection.text049')}
            {controlText('CoolantCapabilitySection.text050')}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * THE TWO COOLANT CHANNELS, AND THE `.pro` KEYS THAT LOOK LIKE THE ANSWER AND
 * ARE NOT (WO-965).
 *
 * The order required checking whether the profile already tells us before
 * adding a flag a person has to set by hand - "a machine fact we can read is
 * better than one we ask for". It does not tell us, and Operator's own profile is
 * the proof: `Floodmistrelaysenabled=True`, `M7relaypin=16`, `M8relaypin=14`,
 * on the machine of the man who wrote "I have no coolant at all". Those keys
 * say which output pin UCCNC would pulse IF asked, which is a fact about the
 * wiring and not about whether anything is plumbed to it. They are shown
 * beside the question as evidence, and they are never read as the answer.
 */
export const COOLANT_CHANNELS = liveCatalog(() => ([
  {
    channel: 'mist' as const,
    label: controlText('CoolantCapabilitySection.text051'),
    code: 'M7',
    pinKey: 'Spindlesetupsettings.M7relaypin',
  },
  {
    channel: 'flood' as const,
    label: controlText('CoolantCapabilitySection.text052'),
    code: 'M8',
    pinKey: 'Spindlesetupsettings.M8relaypin',
  },
]))

export const COOLANT_RELAYS_ENABLED_KEY = 'Spindlesetupsettings.Floodmistrelaysenabled'
