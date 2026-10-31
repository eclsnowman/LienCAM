// @vitest-environment jsdom
//
// WO-3257: the real useGlobalShortcuts hook, driven by real KeyboardEvents against the real
// CAM store and the real uiPrefs store. Only the three store actions the shortcuts call are
// replaced by spies. Remaps go through the same store action Settings uses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'

vi.hoisted(() => {
  const m = new Map<string, string>()
  const memStorage: Storage = {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
})

function Host(): null {
  useGlobalShortcuts()
  return null
}

const calls = {
  computeOne: vi.fn(async (_setupId: string, _opId: string) => {}),
  computeAll: vi.fn(async () => {}),
  setActiveSetup: vi.fn((_id: string | null) => {}),
  openModal: vi.fn((_id: string) => {}),
}
let machineWrites = 0
let unsubscribeMachine: (() => void) | null = null

beforeEach(() => {
  Object.values(calls).forEach((spy) => spy.mockClear())
  useUiPrefs.setState({ camShortcutOverrides: null })
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    workspace: 'cam',
    activeModal: null,
    viewer: { ...s.viewer, mode: 'setup' },
    project: { ...s.project, activeSetupId: 'setup-1', activeOperationId: 'op-1' },
    computeOperationToolpath: calls.computeOne,
    computeAllToolpaths: calls.computeAll,
    setActiveSetup: calls.setActiveSetup,
    openModal: calls.openModal,
  }))
  machineWrites = 0
  unsubscribeMachine = useMachineControl.subscribe(() => { machineWrites += 1 })
  render(<Host />)
})

afterEach(() => {
  unsubscribeMachine?.()
  cleanup()
  document.body.innerHTML = ''
  useUiPrefs.setState({ camShortcutOverrides: null })
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

function total(): number {
  return calls.computeOne.mock.calls.length + calls.computeAll.mock.calls.length + calls.openModal.mock.calls.length
}

function remap(id: Parameters<ReturnType<typeof useUiPrefs.getState>['setCamShortcutBinding']>[0], key: string, shift = false): void {
  const edit = useUiPrefs.getState().setCamShortcutBinding(id, { key, shift })
  expect(edit.ok).toBe(true)
}

describe('CAM shortcuts through useGlobalShortcuts, defaults', () => {
  it('G computes the selected operation once, with no other call', () => {
    const event = press('g')
    expect(calls.computeOne.mock.calls).toEqual([['setup-1', 'op-1']])
    expect(calls.computeAll).not.toHaveBeenCalled()
    expect(calls.openModal).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('Shift+G computes all once', () => {
    press('G', { shiftKey: true })
    expect(calls.computeAll).toHaveBeenCalledTimes(1)
    expect(calls.computeOne).not.toHaveBeenCalled()
  })

  it('N selects the setup and then opens the new-operation modal, in that order', () => {
    const order: string[] = []
    calls.setActiveSetup.mockImplementation(() => { order.push('setActiveSetup') })
    calls.openModal.mockImplementation(() => { order.push('openModal') })
    press('n')
    expect(order).toEqual(['setActiveSetup', 'openModal'])
    expect(calls.setActiveSetup).toHaveBeenCalledWith('setup-1')
    expect(calls.openModal).toHaveBeenCalledWith('new-operation')
  })

  it('Caps Lock G without Shift computes the selected operation; Shift+N does nothing', () => {
    press('G')
    expect(calls.computeOne).toHaveBeenCalledTimes(1)
    expect(calls.computeAll).not.toHaveBeenCalled()
    press('N', { shiftKey: true })
    expect(calls.openModal).not.toHaveBeenCalled()
  })

  it('makes no machine call for any of the three', () => {
    press('g'); press('G', { shiftKey: true }); press('n')
    expect(total()).toBe(3)
    expect(machineWrites).toBe(0)
  })
})

describe('CAM shortcuts through useGlobalShortcuts, remapped', () => {
  it('R then computes the selected operation and G does nothing', () => {
    remap('computeOperationToolpath', 'r')
    press('g')
    expect(total()).toBe(0)
    press('r')
    expect(calls.computeOne.mock.calls).toEqual([['setup-1', 'op-1']])
  })

  it('the next key press after a remap uses the new map with no remount', () => {
    press('n')
    expect(calls.openModal).toHaveBeenCalledTimes(1)
    remap('openModal:new-operation', 'w', true)
    press('n')
    expect(calls.openModal).toHaveBeenCalledTimes(1)
    press('W', { shiftKey: true })
    expect(calls.openModal).toHaveBeenCalledTimes(2)
  })

  it('an unassigned row fires nothing and Restore brings the default back', () => {
    useUiPrefs.getState().setCamShortcutBinding('computeAllToolpaths', null)
    press('G', { shiftKey: true })
    expect(calls.computeAll).not.toHaveBeenCalled()
    useUiPrefs.getState().restoreCamShortcutDefaults()
    press('G', { shiftKey: true })
    expect(calls.computeAll).toHaveBeenCalledTimes(1)
  })

  it('a stored blob that is malformed leaves every default working', () => {
    useUiPrefs.setState({ camShortcutOverrides: { version: 1, bindings: { computeOperationToolpath: { key: 'g', shift: true } } } })
    press('g')
    expect(calls.computeOne).toHaveBeenCalledTimes(1)
  })

  it('a chord another row has is refused and the map does not change', () => {
    remap('computeOperationToolpath', 'r')
    const edit = useUiPrefs.getState().setCamShortcutBinding('computeAllToolpaths', { key: 'r', shift: false })
    expect(edit).toEqual({ ok: false, conflictWith: 'computeOperationToolpath' })
    press('G', { shiftKey: true })
    expect(calls.computeAll).toHaveBeenCalledTimes(1)
  })
})

describe('CAM shortcuts stay out of the way', () => {
  it('never fire with Ctrl, Cmd or Alt held, remapped or not', () => {
    remap('computeOperationToolpath', 'r')
    press('r', { ctrlKey: true }); press('r', { metaKey: true }); press('r', { altKey: true })
    press('n', { ctrlKey: true }); press('G', { shiftKey: true, altKey: true })
    expect(total()).toBe(0)
  })

  it.each([
    ['text input', () => { const el = document.createElement('input'); el.type = 'text'; return el }],
    ['number input', () => { const el = document.createElement('input'); el.type = 'number'; return el }],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    ['contenteditable', () => { const el = document.createElement('div'); el.setAttribute('contenteditable', 'true'); Object.defineProperty(el, 'isContentEditable', { value: true }); el.tabIndex = 0; return el }],
  ])('fire nothing while a %s has focus', (_name, make) => {
    remap('computeOperationToolpath', 'r')
    const el = make()
    document.body.appendChild(el)
    el.focus()
    press('r', {}, el); press('n', {}, el); press('G', { shiftKey: true }, el)
    expect(total()).toBe(0)
  })

  it('fire nothing while a modal is open, in sketch mode, or in the Model workspace', () => {
    remap('computeOperationToolpath', 'r')
    useCamStore.setState({ activeModal: 'settings' })
    press('r')
    useCamStore.setState({ activeModal: null, workspace: 'part' })
    press('r')
    useCamStore.setState((s) => ({ workspace: 'cam', viewer: { ...s.viewer, mode: 'sketch' } }))
    press('r')
    expect(total()).toBe(0)
  })

  it('leave other keys alone', () => {
    const event = press('x')
    expect(event.defaultPrevented).toBe(false)
    expect(total()).toBe(0)
  })
})
