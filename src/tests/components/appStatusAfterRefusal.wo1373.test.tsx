// @vitest-environment jsdom
//
// WO-1373 (Codex audit BUG-537): an enabled operation whose generation refused
// (status 'error') must surface in the global status bar as a failure count and
// must never emit the success-severity "Ready (N operations)" console line.
// Tier 2 rendered-component test, modelled on AppBottomConsole.smoke.test.tsx.
//
// The real Viewport constructs a THREE.WebGLRenderer on mount and jsdom has no
// WebGL context, so it is mocked at the component boundary exactly as that
// smoke test does; this isolates the App shell status wiring WO-1373 owns.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => mem.set(k, String(v)),
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { makeOp, makeWcs } = await import('../post/helpers')
type Operation = ReturnType<typeof makeOp>
type Setup = ReturnType<typeof useCamStore.getState>['project']['setups'][number]

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  })
})

function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: {} as Setup['stock'], operations: ops, notes: '',
  }
}

function statusText(): string {
  const el = document.querySelector('.status-bar .status-item')
  return (el?.textContent ?? '').trim()
}

function appEvents() {
  return useCamStore.getState().consoleEvents.filter(e => e.source === 'app')
}

function setSingleOp(op: Partial<Operation>): void {
  act(() => {
    useCamStore.setState(s => ({
      project: { ...s.project, setups: [makeSetup([{ ...makeOp({ id: 'op-1' }), ...op }])] },
    }))
  })
}

describe('WO-1373: global status after an operation refused', () => {
  it('an enabled errored op replaces Ready with a failure count and emits no success line', () => {
    render(<App />)
    setSingleOp({ status: 'error' })

    expect(statusText()).not.toBe('Ready')
    expect(statusText()).toBe('1 operation failed')
    expect(appEvents().some(e => e.severity === 'success')).toBe(false)
  })

  it('the defective computing -> error path never logs Ready (N operations)', () => {
    render(<App />)
    setSingleOp({ status: 'computing' })
    expect(appEvents().map(e => e.severity)).toEqual(['info'])

    setSingleOp({ status: 'error' })
    const all = appEvents()
    expect(all.some(e => e.severity === 'success')).toBe(false)
    expect(all.some(e => e.severity === 'error' && /operation failed/.test(e.message))).toBe(true)
    expect(statusText()).toBe('1 operation failed')
  })

  it('all operations ready still logs Ready (N operations), unchanged', () => {
    render(<App />)
    setSingleOp({ status: 'computing' })
    setSingleOp({ status: 'ready' })

    const events = appEvents()
    expect(events.length).toBe(2)
    expect(events[1].severity).toBe('success')
    expect(events[1].message).toBe('Ready (1 operation)')
    expect(statusText()).toBe('Ready')
  })

  it('a disabled errored op does not drive the global status', () => {
    render(<App />)
    setSingleOp({ status: 'error', enabled: false })
    expect(statusText()).toBe('Ready')
  })
})
