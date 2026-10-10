// @vitest-environment jsdom
// WO-1700 re-audit: after a confirmed Apply of new axis speeds, the live
// session's record carries min(typed rapid, promoted slowest axis) - Operator
// 2026-09-19: the everyday rapid may sit below the max speed - so jog /
// go-to-zero feeds agree with the saved machine and the post.

import { describe, it, expect } from 'vitest'
import type { MachineConfig } from '../../types'

const mem: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = String(v) },
    removeItem: (k: string) => { delete mem[k] },
    clear: () => { for (const k of Object.keys(mem)) delete mem[k] },
    key: (i: number) => Object.keys(mem)[i] ?? null,
    get length() { return Object.keys(mem).length },
  },
})

const { useCamStore } = await import('../../store')
const { machineRapidRate } = await import('../../types')

const { createDefaultControllerDefinition } = await import('../../types')
const withSpeeds = (m: MachineConfig, s: Record<string, number>): MachineConfig => {
  const d = m.controllerDefinition ?? createDefaultControllerDefinition()
  return { ...m, controllerDefinition: { ...d, axes: d.axes.map((a) => (s[a.axis] !== undefined ? { ...a, maxVelocity: s[a.axis] } : a)) } }
}

/** Pin a live session on `seed`, confirm `speeds` as its applied axis table,
 *  and return the record controlMachine() serves while the session is pinned. */
function applySpeeds(seed: MachineConfig, speeds: Record<string, number>): MachineConfig {
  useCamStore.setState((s) => ({ control: { ...s.control, sessionMachine: structuredClone(seed), appliedMachine: null } }))
  const def = withSpeeds(seed, speeds).controllerDefinition!
  expect(useCamStore.getState().confirmControlSessionDefinition(seed.id, def)).toBe(true)
  return useCamStore.getState().control.appliedMachine!
}

describe('WO-1700: the live session follows a confirmed axis-speed Apply', () => {
  const base = () => useCamStore.getState().project.machine as MachineConfig

  it('an Apply that lowers the slowest axis below the typed rapid caps it there', () => {
    const seed = withSpeeds({ ...base(), id: 'wo1700-live', rapidRate: 3000 }, { X: 9000, Y: 8000, Z: 3000 })
    expect(machineRapidRate(seed)?.ceiling).toBe(3000)
    const live = applySpeeds(seed, { Z: 1500 })
    expect(live.rapidRate).toBe(1500)
    expect(live.rapidRate).toBe(machineRapidRate(live)?.mmMin)
  })

  it('typed 3000 with a confirmed slowest axis 5000: the live rapid stays 3000', () => {
    const seed = withSpeeds({ ...base(), id: 'wo1700-live-everyday', rapidRate: 3000 }, { X: 9000, Y: 8000, Z: 4000 })
    const live = applySpeeds(seed, { Z: 5000 })
    expect(live.rapidRate).toBe(3000)
    expect(machineRapidRate(live)).toEqual({ mmMin: 3000, from: 'typed', ceiling: 5000 })
  })

  it('typed 8000 with a confirmed slowest axis 5000: the live rapid is 5000', () => {
    const seed = withSpeeds({ ...base(), id: 'wo1700-live-capped', rapidRate: 8000 }, { X: 9000, Y: 9000, Z: 9000 })
    const live = applySpeeds(seed, { Z: 5000 })
    expect(live.rapidRate).toBe(5000)
  })
})
