// @vitest-environment jsdom
//
// WO-2449: the per-screen export controls added on 2026-10-02 are gone from the
// screens that are cheap to mount here; every writer stays reachable through the
// one Export window (exportWindow.wo2448.test.tsx stays green beside this file).
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => mem.set(k, v),
  removeItem: (k: string) => mem.delete(k), clear: () => mem.clear(),
} })

const { useCamStore } = await import('../../store')
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { SetupModal } = await import('../../components/modals/SetupModal')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { collectExportGroups } = await import('../../lib/exportCenter')
const { MacroEditor } = await import('../../components/machine/MacroEditor')
const { parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')

afterEach(() => {
  act(() => { useCamStore.getState().closeModal() })
  cleanup()
})

function noButton(name: RegExp): void {
  expect(screen.queryByRole('button', { name })).toBeNull()
}

describe('WO-2449 screens carry no export control of their own', () => {
  it('Settings has no "Export settings" button', () => {
    render(createElement(SettingsModal))
    act(() => useCamStore.getState().openModal('settings'))
    expect(screen.queryByTestId('settings-export-profile')).toBeNull()
    noButton(/export settings/i)
  })

  it('Tool Library has no CSV export button', () => {
    render(createElement(ToolLibraryModal))
    act(() => useCamStore.getState().openModal('tool-library'))
    expect(screen.getByText('All')).toBeTruthy()
    noButton(/^csv$/i)
  })

  it('Setup dialog has no "Export setups" button', () => {
    render(createElement(SetupModal))
    act(() => useCamStore.getState().openModal('new-setup'))
    expect(screen.queryByTestId('setup-export-setups')).toBeNull()
    noButton(/export setups/i)
  })

  it('Post Process has neither Export original nor Export toolpath', () => {
    render(createElement(PostProcessModal))
    act(() => useCamStore.getState().openModal('post-process'))
    noButton(/export original/i)
    noButton(/export toolpath/i)
  })

  it('Macro editor has no Export macro button or format list', () => {
    useCamStore.getState().newProject()
    const machine = parkCarrierMachine(useCamStore.getState())
    act(() => saveParkMachineRecord({ ...machine, macros: [{ id: 'm1', name: 'Coolant', mCode: 101, body: "lines('M8')" }] }))
    render(createElement(MacroEditor, { open: true, onClose: () => {} }))
    act(() => { screen.getByTestId('macro-editor-item-m1-edit').click() })
    expect(screen.getByTestId('macro-editor-form')).toBeTruthy()
    expect(screen.queryByTestId('macro-editor-export')).toBeNull()
    expect(screen.queryByTestId('macro-editor-export-format')).toBeNull()
  })

  it('an unsaved macro draft (edited or new) is a row in the Export window, saved record untouched', () => {
    useCamStore.getState().newProject()
    const machine = parkCarrierMachine(useCamStore.getState())
    act(() => saveParkMachineRecord({ ...machine, macros: [{ id: 'm1', name: 'Coolant', mCode: 101, body: "lines('M8')" }] }))
    const macroRows = () => collectExportGroups().flatMap((g) => g.rows).filter((r) => r.id.startsWith('macro:'))
    const { unmount } = render(createElement(MacroEditor, { open: true, onClose: () => {} }))
    act(() => { screen.getByTestId('macro-editor-item-m1-edit').click() })
    act(() => { fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Mist' } }) })
    expect(macroRows().map((r) => [r.id, r.name])).toEqual([['macro:m1', 'Mist']])
    expect(parkCarrierMachine(useCamStore.getState()).macros?.[0].name).toBe('Coolant')
    act(() => { screen.getByTestId('macro-editor-cancel').click() })
    expect(macroRows().map((r) => r.name)).toEqual(['Coolant'])
    act(() => { screen.getByTestId('macro-editor-add').click() })
    expect(macroRows()).toHaveLength(2)
    unmount()
    expect(macroRows()).toHaveLength(1)
  })

  it('a macro editor closed with an unsaved edit exports the saved macro, not the abandoned draft', () => {
    useCamStore.getState().newProject()
    const machine = parkCarrierMachine(useCamStore.getState())
    act(() => saveParkMachineRecord({ ...machine, macros: [{ id: 'm1', name: 'Coolant', mCode: 101, body: "lines('M8')" }] }))
    const macroRows = () => collectExportGroups().flatMap((g) => g.rows).filter((r) => r.id.startsWith('macro:'))
    const { rerender } = render(createElement(MacroEditor, { open: true, onClose: () => {} }))
    act(() => { screen.getByTestId('macro-editor-item-m1-edit').click() })
    act(() => { fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Mist' } }) })
    expect(macroRows().map((r) => r.name)).toEqual(['Mist'])
    rerender(createElement(MacroEditor, { open: false, onClose: () => {} }))
    expect(macroRows().map((r) => r.name)).toEqual(['Coolant'])
  })

  it('an idle macro editor never clears another editor\'s published draft', () => {
    useCamStore.getState().newProject()
    const machine = parkCarrierMachine(useCamStore.getState())
    act(() => saveParkMachineRecord({ ...machine, macros: [{ id: 'm1', name: 'Coolant', mCode: 101, body: "lines('M8')" }] }))
    const macroRows = () => collectExportGroups().flatMap((g) => g.rows).filter((r) => r.id.startsWith('macro:'))
    render(createElement(MacroEditor, { open: true, onClose: () => {} }))
    act(() => { screen.getByTestId('macro-editor-item-m1-edit').click() })
    act(() => { fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Mist' } }) })
    const idle = render(createElement(MacroEditor, { open: false, onClose: () => {} }))
    idle.rerender(createElement(MacroEditor, { open: false, onClose: () => {} }))
    expect(macroRows().map((r) => r.name)).toEqual(['Mist'])
  })
})
