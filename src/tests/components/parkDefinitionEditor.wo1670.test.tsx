// @vitest-environment jsdom
//
// WO-1670 - SAFE Z NEVER ASKS FOR A VALUE THE DEFINITION STATES.
// WO-1681 - THE PARK SECTION IS GONE; A PARK IS A MACRO TYPE.
// WO-1710 - SAFE Z HAS ONE EDITOR: the Machine tab, not Machine actions. The
// "shown from the profile, nothing says required" and "not set until typed"
// behaviour still belongs to Safe Z - it just re-pins to the one remaining
// box (MachineArea.tsx, aria-label "Safe Z") instead of the deleted one.
//
// Operator at the machine, 2026-09-17: his .pro says SafeZ=120, and the Park
// section showed "required" and asked him to type it again, because it read a
// second store only its own field wrote. The Machine tab shows the machine
// record's own safe Z (from the profile) and Machine actions shows nothing
// about parks - those are macros now, edited on the Macros panel like any
// other button (WO-1681).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { importUccncProfile } = await import('../../lib/machine/uccncProfileImport')
const { createDefaultControllerDefinition } = await import('../../types')

const PRO = readFileSync(join(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')

function selectMachine(profiled: boolean): void {
  useCamStore.getState().newProject()
  const base = useCamStore.getState().project.machine
  const machine = {
    ...base,
    id: profiled ? 'wo1670-profiled' : 'wo1670-hand-made',
    name: profiled ? 'Profiled' : 'Hand-made',
    controller: profiled ? 'uccnc' as const : 'grbl' as const,
    // A hand-made machine with no profile still needs a controllerDefinition
    // for the Machine tab to render at all; a default one states no Safe Z,
    // which is the same "not stated" fact the old `undefined` carried.
    controllerDefinition: profiled
      ? importUccncProfile(PRO).definition ?? undefined
      : createDefaultControllerDefinition(),
    referencePositions: undefined,
    safeZMachine: undefined,
  }
  useCamStore.getState().setProjectMachine(machine)
  useCamStore.setState({ machineLibrary: [machine] })
}

function mountMachineTab(): void {
  render(<MachineDefinitionPanel />)
  act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-machine')) })
}

beforeEach(() => {
  useMachineActions.setState({ byMachine: {} })
})

afterEach(cleanup)

describe('WO-1670/1710 Safe Z on the Machine tab', () => {
  it('Operator\'s imported profile: safe Z 120 is shown from the profile, and nothing says "required"', () => {
    selectMachine(true)
    mountMachineTab()
    expect((screen.getByLabelText('Safe Z') as HTMLInputElement).value).toBe('120')
    expect(screen.getByTestId('machine-def-group-machine').textContent).not.toMatch(/required/i)
  })

  it('a hand-made definition with no profile: safe Z is not set until typed', () => {
    selectMachine(false)
    mountMachineTab()
    expect((screen.getByLabelText('Safe Z') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('machine-def-panel-safe-z-unset').textContent).toBe('not stated')
  })
})

describe('WO-1681 the Park section is gone', () => {
  it('Machine actions has no Park positions section or park-add control', () => {
    selectMachine(false)
    render(<MachineActionsModal open onClose={() => {}} />)
    expect(screen.queryByTestId('machine-parks-section')).toBeNull()
    expect(screen.queryByTestId('control-park-add')).toBeNull()
    expect(screen.getByTestId('control-actions-modal').textContent).not.toMatch(/park position/i)
  })
})
