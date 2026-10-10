// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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


import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import type { Setup } from '../../types'
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')
function offsets() {
  const label = screen.getByText('Work offsets')
  return label.parentElement?.textContent
}
beforeEach(() => act(() => {
  useCamStore.getState().newProject()
  const tool = makeTool()
  const setups: Setup[] = [54, 55].map(n => ({ id: `setup-${n}`, name: `Setup G${n}`, wcs: makeWcs({ id: `wcs-${n}`, label: `G${n}`, fixtureOffset: n }), stock: makeStock(), operations: [makeOp({ id: `op-${n}`, name: `Cut G${n}` })], notes: '' }))
  const project = { ...useCamStore.getState().project, machine: makeMachine(), setups, activeSetupId: setups[0].id, toolLibrary: [tool] }
  for (const setup of setups) stampGenerationCurrent(project, setup, setup.operations[0], tool)
  useCamStore.setState({ project, toolLibrary: [tool] })
  useCamStore.getState().closeModal()
}))
afterEach(cleanup)
describe('WO-2703 Post export scope', () => {
  it('summarises chosen work offsets rather than the active setup and handles all/empty scopes', () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    const rows = document.querySelectorAll('.scope-setup-row')
    fireEvent.click(rows[1].querySelector('input')!)
    expect(offsets()).toContain('G54, G55')
    fireEvent.click(rows[0].querySelector('input')!)
    expect(offsets()).toContain('G55')
    expect(offsets()).not.toContain('G54')
    expect(document.querySelector('.modal-title')?.textContent).toContain('1 setup, 1 operation')
    expect(screen.getByTestId('post-gcode-preview').textContent).toContain('G55')
    fireEvent.click(rows[1].querySelector('input')!)
    expect(offsets()).toContain('—')
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    expect(offsets()).toContain('G54, G55')
  })
  it('unticks excluded children while retaining partial operation choices on reselect', () => {
    act(() => useCamStore.setState(s => ({ project: { ...s.project, setups: s.project.setups.map((setup, index) => index ? setup : { ...setup, operations: [...setup.operations, makeOp({ id: 'op-extra', name: 'Extra cut' })] }) } })))
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    const op = screen.getByRole('checkbox', { name: 'Extra cut' }) as HTMLInputElement
    fireEvent.click(op)
    const setup = document.querySelector('.scope-setup-cb')!
    fireEvent.click(setup)
    const cut = screen.getByRole('checkbox', { name: 'Cut G54' }) as HTMLInputElement
    expect(cut.disabled).toBe(true)
    expect(cut.checked).toBe(false)
    expect(op.checked).toBe(false)
    fireEvent.click(setup)
    expect(cut.checked).toBe(true)
    expect(cut.disabled).toBe(false)
    expect(op.checked).toBe(false)
  })
  it('preserves seeded choices through progress and reopen, and keeps children ticked when their setup is included', () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand operations' }))
    const rows = document.querySelectorAll('.scope-setup-cb')
    const first = screen.getByRole('checkbox', { name: 'Cut G54' }) as HTMLInputElement
    const second = screen.getByRole('checkbox', { name: 'Cut G55' }) as HTMLInputElement
    expect((rows[0] as HTMLInputElement).checked).toBe(true)
    expect((rows[1] as HTMLInputElement).checked).toBe(false)
    expect(first.checked).toBe(true)
    expect(second.checked).toBe(false)

    fireEvent.click(rows[1])
    expect(second.checked).toBe(true) // Excluding the setup did not erase its seed.
    fireEvent.click(first)
    act(() => {
      for (let index = 0; index < 200; index++) {
        useCamStore.getState().updateOperation('setup-54', 'op-54', {
          progress: (index + 1) / 200, progressPhase: `WO-2703 progress ${index}`,
        })
      }
    })
    expect((rows[0] as HTMLInputElement).checked).toBe(true)
    expect((rows[1] as HTMLInputElement).checked).toBe(true)
    expect(first.checked).toBe(false)
    expect(second.checked).toBe(true)

    act(() => useCamStore.getState().closeModal())
    act(() => useCamStore.getState().updateOperation('setup-55', 'op-55', { progress: 0.5 }))
    act(() => useCamStore.getState().openModal('post-process'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand operations' }))
    expect((document.querySelectorAll('.scope-setup-cb')[0] as HTMLInputElement).checked).toBe(true)
    expect((document.querySelectorAll('.scope-setup-cb')[1] as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'Cut G54' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Cut G55' }) as HTMLInputElement).checked).toBe(false)

    // A selectable-tree change retains the existing all-setup reseed behavior.
    act(() => useCamStore.getState().updateOperation('setup-54', 'op-54', { enabled: false }))
    expect(screen.queryByRole('checkbox', { name: 'Cut G54' })).toBeNull()
    for (const row of document.querySelectorAll('.scope-setup-cb')) {
      expect((row as HTMLInputElement).checked).toBe(true)
    }
    expect((screen.getByRole('checkbox', { name: 'Cut G55' }) as HTMLInputElement).checked).toBe(true)
  })
  it('omits a checked setup when every enabled child is unchecked', () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cut G54' }))
    expect((document.querySelector('.scope-setup-cb') as HTMLInputElement).checked).toBe(true)
    expect(offsets()).toContain('—')
    expect(offsets()).not.toContain('G54')
  })
  it('uses resolved stock offsets and lists a shared offset only once', () => {
    act(() => useCamStore.setState(s => ({ project: {
      ...s.project,
      stocks: [{ id: 'shared-stock', name: 'Shared stock', mode: 'explicit', fixtureOffset: 57,
        position: { x: 0, y: 0, z: 0 },
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 }, size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 } } }],
      setups: s.project.setups.map(setup => ({ ...setup, wcs: { ...setup.wcs, stockId: 'shared-stock' } })),
    } })))
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    expect(offsets()?.match(/G57/g)).toHaveLength(1)
    expect(offsets()).not.toContain('G54')
    expect(offsets()).not.toContain('G55')
  })
  it('omits pending-only setups from the work offset summary', () => {
    act(() => useCamStore.setState(s => ({ project: { ...s.project, setups: s.project.setups.map((setup, index) => index ? { ...setup, operations: setup.operations.map(op => ({ ...op, status: 'pending' as const })) } : setup) } })))
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    expect(offsets()).toContain('G54')
    expect(offsets()).not.toContain('G55')
  })
})
