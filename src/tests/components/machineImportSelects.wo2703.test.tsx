// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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


import { makeMachine } from '../post/helpers'
const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')
beforeEach(() => act(() => {
  useCamStore.getState().newProject()
  const machine = makeMachine({ id: 'old', name: 'Old machine', controller: 'grbl' })
  useCamStore.setState(s => ({ machineLibrary: [machine], project: { ...s.project, machine } }))
  useCamStore.getState().closeModal()
}))
afterEach(cleanup)
async function importJson(value: unknown) {
  const input = document.querySelector('input[type="file"][accept*=".json"]')!
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(value)], 'machines.json', { type: 'application/json' })] } })
}
describe('WO-2703 machine JSON import selection', () => {
  it.each([false, true])('shows first imported machine without activating it (array=%s)', async (array) => {
    render(<MachineLibraryModal />)
    act(() => useCamStore.getState().openModal('machine-config'))
    const first = makeMachine({ id: 'foreign', name: 'Imported first', controller: 'grbl' })
    await importJson(array ? [{ name: '' }, first, makeMachine({ name: 'Imported second' })] : first)
    await waitFor(() => expect(screen.getByDisplayValue('Imported first')).toBeTruthy())
    const imported = useCamStore.getState().machineLibrary.find(m => m.name === 'Imported first')!
    expect(imported.id).not.toBe('foreign')
    expect(document.querySelector('.machine-list-item-active')?.textContent).toContain('Imported first')
    expect(useCamStore.getState().project.machine.id).toBe('old')
    expect(screen.getByRole('button', { name: /Use for this project/i })).toBeTruthy()
  })
  it('shows the adopted library document after import, including reconciled coolant', async () => {
    render(<MachineLibraryModal />)
    act(() => useCamStore.getState().openModal('machine-config'))
    await importJson(makeMachine({ name: 'Reconciled import', controller: 'grbl', coolant: true, coolantCapability: { mist: false, flood: false } }))
    await waitFor(() => expect(screen.getByDisplayValue('Reconciled import')).toBeTruthy())
    const imported = useCamStore.getState().machineLibrary.find(m => m.name === 'Reconciled import')!
    expect(imported.coolant).toBe(false)
    fireEvent.click(screen.getByTestId('disclosure-machine-feeds'))
    expect((screen.getByTestId('machine-form-coolant').querySelector('input') as HTMLInputElement).checked).toBe(imported.coolant)
  })
  it('saves the previous dirty draft at the normal selection boundary', async () => {
    render(<MachineLibraryModal />)
    act(() => useCamStore.getState().openModal('machine-config'))
    fireEvent.change(screen.getByDisplayValue('Old machine'), { target: { value: 'Edited old machine' } })
    await importJson(makeMachine({ name: 'Imported after edit', controller: 'grbl' }))
    await waitFor(() => expect(screen.getByDisplayValue('Imported after edit')).toBeTruthy())
    expect(useCamStore.getState().machineLibrary.find(m => m.id === 'old')?.name).toBe('Edited old machine')
    expect(useCamStore.getState().project.machine.id).toBe('old')
  })
  it.each([{ label: 'empty', list: [] }, { label: 'nameless', list: [{ name: '' }] }])('keeps selection when the imported list is $label', async ({ list }) => {
    render(<MachineLibraryModal />)
    act(() => useCamStore.getState().openModal('machine-config'))
    await act(async () => {
      await importJson(list)
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(screen.getByDisplayValue('Old machine')).toBeTruthy()
    expect(useCamStore.getState().machineLibrary).toHaveLength(1)
  })

})
