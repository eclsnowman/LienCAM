// @vitest-environment jsdom
//
// WO-1184: the third Goto XY0 gate Operator hit at the machine on 2026-09-03.
// The bridge said "Work zero agrees: G54 X20.2725 Y9.295 Z21.37." at connect,
// and Goto XY0 then refused with "the controller has not reported the G54 work
// offset for X and Y". Both gates read the SESSION offsets table, and the
// connect reconcile had never written it from `hello.workOffsets`.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { reconcileWorkOffsetsOnConnect } from '../../lib/machine/machineSession'
import type { UccncController } from '../../lib/machine/uccncController'
import type { MachineVec3, WcsId } from '../../lib/machine/types'

const WCS: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
const SAMPLE_MACHINE_G54: MachineVec3 = { x: 20.2725, y: 9.295, z: 21.37 }
const ZERO: MachineVec3 = { x: 0, y: 0, z: 0 }

function allOffsets(g54: MachineVec3): Record<WcsId, MachineVec3> {
  return Object.fromEntries(WCS.map((wcs) => [wcs, wcs === 'G54' ? { ...g54 } : { ...ZERO }])) as Record<WcsId, MachineVec3>
}

/** A standalone target: no installed backend generation, so every receipt is
 *  current (machineSession's own rule for injected test controllers). */
function target(workOffsets: { current: Record<WcsId, MachineVec3>; profile: Record<WcsId, MachineVec3> | null } | undefined) {
  const setWorkOffset = vi.fn(async (_wcs: WcsId, offset: Partial<MachineVec3>) => ({
    ok: true, reason: null, offset: { ...ZERO, ...offset },
  }))
  return {
    controller: {
      bridgeHello: () => (workOffsets ? { workOffsets } : {}),
      setWorkOffset,
      refreshState: vi.fn(() => true),
    } as unknown as UccncController,
    setWorkOffset,
  }
}

const MACHINE = 'wo-1184-machine'

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState({ offsets: {}, consoleLines: [] })
})

describe('WO-1184 the bridge\'s reported work offsets count as reported', () => {
  it('writes every slot the bridge reports into the session table, so "agrees" means reported', async () => {
    useCamStore.getState().setMachineWorkOffset(MACHINE, 'G54', SAMPLE_MACHINE_G54, 'restored')
    const { controller, setWorkOffset } = target({ current: allOffsets(SAMPLE_MACHINE_G54), profile: allOffsets(SAMPLE_MACHINE_G54) })

    await reconcileWorkOffsetsOnConnect(MACHINE, controller)

    const offsets = useMachineControl.getState().offsets
    expect(offsets.G54).toEqual([SAMPLE_MACHINE_G54.x, SAMPLE_MACHINE_G54.y, SAMPLE_MACHINE_G54.z])
    expect(offsets.G55).toEqual([0, 0, 0])
    expect(setWorkOffset).not.toHaveBeenCalled()
    expect(useMachineControl.getState().consoleLines.map((line) => line.text))
      .toContain('Work zero agrees: G54 X20.2725 Y9.295 Z21.37.')
  })

  it('carries a restored value into the session table from the bridge\'s receipt', async () => {
    useCamStore.getState().setMachineWorkOffset(MACHINE, 'G54', SAMPLE_MACHINE_G54, 'not-sent')
    // The bridge holds the profile's numbers, ours differ: the reconcile sends
    // ours and the receipt echoes what the bridge now holds.
    const profile = allOffsets({ x: 81.2275, y: 61.3225, z: 12.16 })
    const { controller, setWorkOffset } = target({ current: profile, profile })

    await reconcileWorkOffsetsOnConnect(MACHINE, controller)

    expect(setWorkOffset).toHaveBeenCalledWith('G54', SAMPLE_MACHINE_G54)
    expect(useMachineControl.getState().offsets.G54).toEqual([SAMPLE_MACHINE_G54.x, SAMPLE_MACHINE_G54.y, SAMPLE_MACHINE_G54.z])
  })

  it('leaves the table empty for a bridge too old to report offsets', async () => {
    const { controller } = target(undefined)

    await reconcileWorkOffsetsOnConnect(MACHINE, controller)

    expect(useMachineControl.getState().offsets).toEqual({})
  })
})
