import { describe, expect, it, vi } from 'vitest'
import {
  __resetEstopInterlockForTest,
  commandSpindle,
  installLiveSpindleOverrideRouting,
} from '../../lib/machine/machineSession'
import { UccncController } from '../../lib/machine/uccncController'
import {
  resolveLiveSpindleOverride,
  routeLiveSpindleOverride,
  type LiveSpindleOverrideChange,
} from '../../lib/machine/vfd'

interface FakeBoard {
  overrides: LiveSpindleOverrideChange[]
  inverter: Array<{ direction: 'cw' | 'ccw'; rpm: number }>
  console: string[]
}

function route(
  board: FakeBoard,
  change: LiveSpindleOverrideChange,
  currentPercent = 100,
  maximumNoticeSaid = false,
) {
  return routeLiveSpindleOverride({
    baseRpm: 24_000,
    maximumRpm: 24_000,
    currentPercent,
    direction: 'cw',
    maximumNoticeSaid,
    sendOverride: (sent) => board.overrides.push(sent),
    sendSpindle: (direction, rpm) => {
      board.inverter.push({ direction, rpm })
      return true
    },
    announce: (sentence) => board.console.push(sentence),
  }, change)
}

function fakeBoard(): FakeBoard {
  return { overrides: [], inverter: [], console: [] }
}

describe('WO-1354 spindle override reaches the inverter', () => {
  it('sends 90% to the controller and 21,600 RPM to the VFD', () => {
    const board = fakeBoard()

    const result = route(board, { kind: 'spindle', to: 'step', direction: -1, coarse: true })

    expect(result).toMatchObject({ appliedPercent: 90, effectiveRpm: 21_600, clamped: false })
    expect(board.overrides).toEqual([{ kind: 'spindle', to: 'percent', percent: 90 }])
    expect(board.inverter).toEqual([{ direction: 'cw', rpm: 21_600 }])
    expect(board.console).toEqual([])
  })

  it('clamps 110% at 24,000, reports the ceiling once, and sends the clamped panel value', () => {
    const board = fakeBoard()

    const first = route(board, { kind: 'spindle', to: 'step', direction: 1, coarse: true })
    const repeated = route(
      board,
      { kind: 'spindle', to: 'step', direction: 1, coarse: true },
      first!.appliedPercent,
      true,
    )

    expect(first).toMatchObject({ requestedPercent: 110, appliedPercent: 100, effectiveRpm: 24_000, clamped: true })
    expect(repeated).toMatchObject({ appliedPercent: 100, effectiveRpm: 24_000, clamped: true })
    expect(board.overrides).toEqual([
      { kind: 'spindle', to: 'percent', percent: 100 },
      { kind: 'spindle', to: 'percent', percent: 100 },
    ])
    expect(board.inverter).toEqual([
      { direction: 'cw', rpm: 24_000 },
      { direction: 'cw', rpm: 24_000 },
    ])
    expect(board.console).toEqual(["24,000 is this spindle's maximum."])
  })

  it.each([90, 100, 110])('leaves the working feed override path unchanged at %i%%', (percent) => {
    const board = fakeBoard()
    const change = { kind: 'feed', to: 'percent', percent } as const

    expect(route(board, change)).toBeNull()
    expect(board.overrides).toEqual([change])
    expect(board.inverter).toEqual([])
  })

  it('uses the reported override when the spindle is first commanded', () => {
    expect(resolveLiveSpindleOverride(
      24_000,
      24_000,
      90,
      { kind: 'spindle', to: 'percent', percent: 90 },
    )).toMatchObject({ appliedPercent: 90, effectiveRpm: 21_600 })
  })

  it('does not restart after a direct VFD safety stop when the override changes', () => {
    __resetEstopInterlockForTest()
    const controller = new UccncController({
      onStatus: () => {},
      onConsole: () => {},
      onConnectionPhase: () => {},
    })
    vi.spyOn(controller, 'capabilities', 'get').mockReturnValue({
      ...controller.capabilities,
      spindleCommands: true,
    })
    const spindleOn = vi.spyOn(controller, 'spindleOn').mockReturnValue(true)
    const spindleOff = vi.spyOn(controller, 'spindleOff')
    const setOverride = vi.spyOn(controller, 'setOverride')
    installLiveSpindleOverrideRouting(controller)

    expect(commandSpindle('cw', 24_000, () => [], controller).ok).toBe(true)
    controller.spindleOff()
    controller.setOverride({ kind: 'spindle', to: 'step', direction: -1, coarse: true })

    expect(spindleOff).toHaveBeenCalledOnce()
    expect(setOverride).toHaveBeenCalledWith({
      kind: 'spindle',
      to: 'step',
      direction: -1,
      coarse: true,
    })
    expect(spindleOn).toHaveBeenCalledOnce()
  })
})
