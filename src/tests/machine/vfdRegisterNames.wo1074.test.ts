/**
 * WO-1074: the two copies of the Huanyang GT map must agree, register by
 * register, on ADDRESS and on ROLE NAME.
 *
 * There are two copies on purpose - `huanyangGt.ts` is what the app uses, and
 * `pendant/uccnc-bridge/vfd/huanyang-gt.definition.json` is the same map in a
 * form the C# bridge can parse without a build dependency. Nothing checked they
 * still said the same thing, and on 2026-08-27 WO-1056 found they had both been
 * carrying a wrong name for 0x1001 since the day they were written.
 *
 * This is the test WO-1056's step 4 actually needed. Its step 4 asked for a
 * powered readback of `hello.vfd.definition` to prove the app had the right
 * values - but the bridge does not send that field at all, so no amount of
 * machine power would ever have shown it. What was really being asked was "do
 * the two copies agree", and that is a question a test answers for free, every
 * run, instead of once at the machine.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import { VFD_REGISTER_ROLES } from '../../lib/machine/vfd/vfdDefinition'

const JSON_PATH = join(
  process.cwd(),
  'pendant/uccnc-bridge/vfd/huanyang-gt.definition.json',
)

interface JsonRegister {
  address: number
  count: number
  deprecated?: string
}

const bridge = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as {
  id: string
  registers: Record<string, JsonRegister>
  fault: { kind: string; value?: number }
}

describe('WO-1074: the app and bridge copies of the Huanyang GT map agree', () => {
  it('is the same definition on both sides', () => {
    expect(bridge.id).toBe(HUANYANG_GT.id)
  })

  it.each([...VFD_REGISTER_ROLES])('register %s has the same address and count in both', (role) => {
    const ts = HUANYANG_GT.registers[role]
    const json = bridge.registers[role]

    // A role the JSON does not carry at all is the drift this test exists to
    // catch - a rename landed on one side only.
    expect(json, `the bridge JSON has no registers.${role}`).toBeDefined()
    expect(json.address).toBe(ts.address)
    expect(json.count).toBe(ts.count)
  })

  it('carries no register role the app does not know about', () => {
    const known = new Set<string>([...VFD_REGISTER_ROLES, ...ALIASES.keys()])
    for (const role of Object.keys(bridge.registers)) {
      expect(known.has(role), `the bridge JSON has an unknown register role '${role}'`).toBe(true)
    }
  })

  it('names 0x1001 runState, not fault - it is the operating-state word', () => {
    // WO-1057: 1 forward, 2 reverse, 3 standby, 4 fault, 5 POFF. The `== 4`
    // fault rule reads THIS register and is correct; only the name was wrong.
    // WO-1053's bridge half reads it to decide whether the spindle is turning.
    expect(HUANYANG_GT.registers.runState.address).toBe(0x1001)
    expect(bridge.registers.runState.address).toBe(0x1001)
    expect(bridge.fault).toEqual({ kind: 'equals', value: 4 })

    // The old name must not survive as a real role on the app side.
    expect('fault' in HUANYANG_GT.registers).toBe(false)
    expect(VFD_REGISTER_ROLES).not.toContain('fault')
  })
})

/**
 * Compatibility aliases the JSON may carry for the INSTALLED bridge binary,
 * mapped to the role they duplicate. Each one is a temporary second name for a
 * register that already exists, kept only until the binary that needs it is
 * swapped - see the `deprecated` text on the key itself.
 */
const ALIASES = new Map<string, (typeof VFD_REGISTER_ROLES)[number]>([['fault', 'runState']])

describe('WO-1074: compatibility aliases cannot rot', () => {
  it.each([...ALIASES.entries()])(
    'alias %s, if present, is the same register as %s and says why it exists',
    (alias, role) => {
      const aliased = bridge.registers[alias]
      if (!aliased) return // removed with the binary swap - that is the goal

      const real = bridge.registers[role]
      expect(aliased.address).toBe(real.address)
      expect(aliased.count).toBe(real.count)

      // An alias with no explanation is indistinguishable from a duplicate
      // somebody left behind, which is how the wrong name lasted this long.
      expect(aliased.deprecated, `registers.${alias} must say why it still exists`).toBeTruthy()
      expect(aliased.deprecated).toMatch(/ALIAS/i)
    },
  )
})
