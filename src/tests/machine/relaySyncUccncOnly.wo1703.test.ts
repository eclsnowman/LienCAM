// @vitest-environment jsdom
// WO-1703 re-audit (round 3): the outputs -> relay-settings sync runs at the
// store's one write door for every record. UCCNC relay keys belong only on a
// UCCNC machine - a GRBL machine whose outputs list names M8 keeps its settings.

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

describe('WO-1703: relay settings sync is UCCNC-only', () => {
  it('a GRBL machine whose outputs name M8 gains no UCCNC settings keys on save', () => {
    const base = useCamStore.getState().project.machine
    const grbl = {
      ...base,
      id: 'grbl-m8',
      name: 'GRBL with flood',
      controller: 'grbl',
      controllerDefinition: {
        ...(base.controllerDefinition ?? {}),
        settings: [],
        outputs: [{ name: 'Flood', onCode: 'M8', offCode: 'M9', pin: { port: 3, pin: 14, negate: false } }],
      },
    } as unknown as MachineConfig
    useCamStore.getState().addMachineToLibrary(grbl)
    const saved = useCamStore.getState().machineLibrary.find((m) => m.id === 'grbl-m8')
    expect(saved?.controllerDefinition?.settings ?? []).toEqual([])
  })
})
