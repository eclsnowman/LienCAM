import { describe, expect, it } from 'vitest'
import { machineBridgeArguments } from '../../lib/machine/bridgeHost'

describe('WO-1753 bridge launch arguments', () => {
  it('keeps Operator machine launch settings except for the retired VFD flag', () => {
    const args = machineBridgeArguments({
      installRoot: ' C:\\UCCNC ',
      profile: ' Operator-profile.pro ',
      board: 7,
      vfdDefinition: ' C:\\LienCAM\\huanyang-gt.definition.json ',
    })

    expect(args).toEqual([
      '--install-root', 'C:\\UCCNC',
      '--profile', 'Operator-profile.pro',
      '--board', '7',
    ])
    expect(args.some((arg) => arg.startsWith('--vfd'))).toBe(false)
  })

  it('keeps the no-VFD machine launch arguments unchanged', () => {
    const args = machineBridgeArguments({
      installRoot: 'C:\\UCCNC',
      profile: 'router.pro',
      board: 'auto',
    })

    expect(args).toEqual([
      '--install-root', 'C:\\UCCNC',
      '--profile', 'router.pro',
      '--board', 'auto',
    ])
    expect(args.some((arg) => arg.startsWith('--vfd'))).toBe(false)
  })
})
