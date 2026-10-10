// @vitest-environment jsdom
//
// WO-2690 C2 - FILE > OPEN WITH A DEFAULT MACHINE SET, WHILE CONNECTED.
//
// Journey audit 2026-10-08 (C2): the Machine Library showed LienCNC V2 as
// "Active Default", Control was connected to it, and File > Open of
// Example Projects/Full Suite.camproject printed
//   "Control stays on LienCNC V2 until you disconnect - the CAM setup moved to
//    Sample hobby router (GRBL)."
// BEFORE the forced machine choice was answered.
//
// WHAT A REAL USER MEETS (no simulator): Full Suite names the generic sample
// machine, so File > Open installs it and the forced choice is raised. The
// connection pins Control's machine in `connectMachine` BEFORE any backend is
// dialled (`setControlSessionMachine`, machineSession.ts) - a real bridge pins
// exactly as the simulator does. This test pins it with that same store action
// and opens the shipped file through `loadProjectFromFile`, the File > Open
// entry point. No controller backend is involved at all.
//
// The machine he is asked about is the open project's; until he answers, the
// CAM setup has not moved anywhere, so nothing may say it has. His default is
// listed first and pre-selected; answering with it prints nothing (Control is
// already on it), answering with another machine prints the one line after.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

const { useCamStore, controlMachineSelection } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
// Registers the WO-1065 console subscription under test.
const { __resetCamMovedNoticeForTest } = await import('../../lib/machine/machineSession')
const { MachineChoiceModal } = await import('../../components/modals/MachineChoiceModal')
const { GENERIC_MACHINE_ID } = await import('../../lib/machine/machineChoice')

import type { MachineConfig } from '../../types'

const root = resolve(import.meta.dirname, '../../..')
const FULL_SUITE = readFileSync(join(root, 'Example Projects/Full Suite.camproject'), 'utf8')

let lienCnc: MachineConfig
let shopRouter: MachineConfig

function camMovedNotices(): string[] {
  return useMachineControl.getState().consoleLines
    .map((line) => line.text)
    .filter((text) => /the CAM setup moved to/.test(text))
}

async function fileOpen(text: string): Promise<void> {
  await act(async () => {
    const store = useCamStore.getState()
    await store.loadProjectFromFile(text, store.beginProjectOpen())
  })
}

beforeEach(() => {
  useCamStore.getState().newProject()
  const base = useCamStore.getState().project.machine
  lienCnc = { ...structuredClone(base), id: `wo2690-liencnc-${crypto.randomUUID()}`, name: 'LienCNC V2', controller: 'uccnc' }
  shopRouter = { ...structuredClone(base), id: `wo2690-shop-${crypto.randomUUID()}`, name: 'Shop Router', controller: 'grbl' }
  const store = useCamStore.getState()
  // Library order puts another machine ahead of his default.
  store.addMachineToLibrary(shopRouter)
  store.addMachineToLibrary(lienCnc)
  lienCnc = useCamStore.getState().machineLibrary.find((m) => m.id === lienCnc.id)!
  shopRouter = useCamStore.getState().machineLibrary.find((m) => m.id === shopRouter.id)!
  // The library row reads "Active Default": the project's machine and the default.
  useCamStore.getState().setDefaultMachineId(lienCnc.id)
  useCamStore.getState().setProjectMachine(lienCnc)
  useCamStore.setState((s) => ({
    control: { ...s.control, activeMachineId: null },
    machineChoiceRequired: false,
  }))
  // Connect pins Control's machine before any backend is dialled.
  useCamStore.getState().setControlSessionMachine(lienCnc)
  useMachineControl.setState({ consoleLines: [] })
  __resetCamMovedNoticeForTest()
})

afterEach(() => {
  cleanup()
  useCamStore.getState().setControlSessionMachine(null)
  useCamStore.setState((s) => ({
    machineChoiceRequired: false,
    machineLibrary: s.machineLibrary.filter((m) => !m.id.startsWith('wo2690-')),
    appSettings: { ...s.appSettings, defaultMachineId: null },
  }))
})

describe('WO-2690 C2: File > Open asks once, defaulting to his machine, and announces nothing first', () => {
  it('opening Full Suite while connected raises the choice in the same write and prints no "moved" line', async () => {
    expect(controlMachineSelection(useCamStore.getState()).pinned).toBe(true)

    await fileOpen(FULL_SUITE)

    const state = useCamStore.getState()
    expect(state.project.name).toBe('Full Suite')
    expect(state.project.machine.id).toBe(GENERIC_MACHINE_ID)
    // Raised by the open itself - no React effect has run in this test.
    expect(state.machineChoiceRequired).toBe(true)
    expect(controlMachineSelection(state).camMovedTo).toBeNull()
    expect(camMovedNotices()).toEqual([])
  })

  it('the choice lists his default first, pre-selected; answering with it keeps Control and CAM on it silently', async () => {
    await fileOpen(FULL_SUITE)
    render(createElement(MachineChoiceModal))

    const names = Array.from(document.querySelectorAll('.machine-choice-item .machine-choice-name'))
      .map((node) => node.textContent)
    expect(names[0]).toBe('LienCNC V2')
    const first = document.querySelector('.machine-choice-item')!
    expect(first.className).toContain('machine-choice-item-active')
    expect(first.textContent).toContain('Default')

    fireEvent.click(screen.getByText('Use this machine'))

    const state = useCamStore.getState()
    expect(state.project.machine.id).toBe(lienCnc.id)
    expect(state.machineChoiceRequired).toBe(false)
    expect(camMovedNotices()).toEqual([])
  })

  it('answering with another machine says so once, after the answer', async () => {
    await fileOpen(FULL_SUITE)
    render(createElement(MachineChoiceModal))
    expect(camMovedNotices()).toEqual([])

    fireEvent.click(screen.getByText('Shop Router'))
    fireEvent.click(screen.getByText('Use this machine'))

    expect(useCamStore.getState().project.machine.id).toBe(shopRouter.id)
    expect(camMovedNotices()).toEqual([
      'Control stays on LienCNC V2 until you disconnect - the CAM setup moved to Shop Router.',
    ])
  })

  it('a project bound to a known library machine opens with no choice and the WO-1065 line stands', async () => {
    const file = JSON.parse(FULL_SUITE)
    file.machine = structuredClone(shopRouter)

    await fileOpen(JSON.stringify(file))

    const state = useCamStore.getState()
    expect(state.machineChoiceRequired).toBe(false)
    expect(state.project.machine.id).toBe(shopRouter.id)
    expect(camMovedNotices()).toEqual([
      'Control stays on LienCNC V2 until you disconnect - the CAM setup moved to Shop Router.',
    ])
  })

  it('New Project with no default set while connected waits for the choice too', () => {
    useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, defaultMachineId: null } }))

    act(() => { useCamStore.getState().newProject() })

    const state = useCamStore.getState()
    expect(state.project.machine.id).toBe(GENERIC_MACHINE_ID)
    expect(state.machineChoiceRequired).toBe(true)
    expect(camMovedNotices()).toEqual([])
  })
})
