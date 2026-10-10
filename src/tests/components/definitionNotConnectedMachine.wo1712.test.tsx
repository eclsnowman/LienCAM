// @vitest-environment jsdom
//
// WO-1712: the definition page says when it is not the connected machine.
//
// After WO-1698 the Machine Library's Travel link (and the walkthrough host)
// can land the Control page's Definition panel on machine B while Control
// still drives machine A. Apply already refuses at the wire in that case
// (machineSession.ts, WO-1698); this proves the PAGE itself never offers a
// control that can only refuse, and says which machine is on screen and
// which one is connected, in plain words - reusing the same
// `editsConnectedMachine` flag the setup walkthrough's Step 7 already uses
// for this (WO-1696).

import { describe, it, expect, afterEach } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { MachineConfig } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => [...mem.keys()][index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { requestMachineDefinitionSection } =
  await import('../../components/machine/definition/machineDefinitionSectionRequest')
const { createDefaultControllerDefinition, AXIS_NAMES } = await import('../../types')
const { useCamStore } = await import('../../store')

function router(id: string, name: string): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES),
  }
}

const A = () => router('wo1712-a', 'WO-1712 Machine A (connected)')
const B = () => router('wo1712-b', 'WO-1712 Machine B (library)')

/** Control drives A (project machine, no session, no explicit pick) - the
 *  same resolution path `controlMachine` falls back to while nothing is
 *  connected, and the one the WO-1698 review tests already exercise. */
function seedControlDrivesA(): { a: MachineConfig; b: MachineConfig } {
  const a = A()
  const b = B()
  act(() => {
    useCamStore.setState((s) => ({
      machineLibrary: [a, b],
      project: { ...s.project, machine: a },
      control: { activeMachineId: null },
      consoleEvents: [],
    }))
  })
  return { a, b }
}

afterEach(() => { cleanup() })

describe('WO-1712 - the definition page names when it is not the connected machine', () => {
  it('page opened on B via a pending section request: no Apply, header names both machines', () => {
    const { a, b } = seedControlDrivesA()
    act(() => { requestMachineDefinitionSection(b.id, 'machine') })
    render(<MachineDefinitionPanel />)

    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id')).toBe(b.id)
    expect(screen.queryByTestId('machine-def-bar-apply')).toBeNull()
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent).toBe(
      `This is ${b.name} - not the machine connected now (${a.name}). `
      + `Changes are saved to ${b.name}; apply them when ${b.name} is connected.`,
    )
  })

  it('page opened on the connected machine: Apply is offered, no foreign-machine line', () => {
    const { a } = seedControlDrivesA()
    render(<MachineDefinitionPanel />)

    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id')).toBe(a.id)
    expect(screen.getByTestId('machine-def-bar-apply')).toBeTruthy()
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent)
      .not.toContain('not the machine connected now')
  })
})
