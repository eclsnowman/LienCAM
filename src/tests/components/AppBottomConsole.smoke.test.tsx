// @vitest-environment jsdom
//
// React-render SMOKE test for the App shell with BottomConsole mounted (WO
// UI-11A acceptance #4, the hooks-order gate) — and the App status-transition
// console writer (acceptance #2, writer (a): the only one of the three
// writers that lives in a component effect rather than the store).
//
// Viewport is mocked at the component boundary: it constructs a real
// THREE.WebGLRenderer on mount (src/lib/viewport/CNCViewport.ts), and jsdom
// has no WebGL context, so mounting the REAL Viewport throws for reasons
// entirely unrelated to this WO (see Lab3DView.smoke.test.tsx for the same
// constraint documented against that subsystem). Viewport is out of this
// WO's ownership manifest (forbidden: src/components/model3d/**, and
// Viewport's CNCViewport dependency lives in src/lib/**, also forbidden) —
// stubbing it is the only way to render App at all, and it isolates exactly
// what this WO owns: the shell wiring + BottomConsole.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

describe('App render smoke test (BottomConsole mounted)', () => {
  it('mounts without throwing or a hooks-order violation', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<App />)).not.toThrow()
      const hooksOrderCalls = errorSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg),
      )
      expect(hooksOrderCalls).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('mounts the BottomConsole strip in the shell', () => {
    render(<App />)
    expect(screen.getByTestId('console-strip')).toBeTruthy()
  })

  it('writer (a): a statusLabel transition to Computing... then back to Ready lands exactly one info + one success app event', () => {
    render(<App />)

    act(() => {
      useCamStore.setState(s => ({
        project: { ...s.project, setups: [makeSetup([{ ...makeOp({ id: 'op-1' }), status: 'computing' }])] },
      }))
    })
    let appEvents = useCamStore.getState().consoleEvents.filter(e => e.source === 'app')
    expect(appEvents.length).toBe(1)
    expect(appEvents[0].severity).toBe('info')
    expect(appEvents[0].message).toMatch(/Computing/)

    act(() => {
      useCamStore.setState(s => ({
        project: {
          ...s.project,
          setups: s.project.setups.map(su => ({ ...su, operations: su.operations.map(op => ({ ...op, status: 'ready' as const })) })),
        },
      }))
    })
    appEvents = useCamStore.getState().consoleEvents.filter(e => e.source === 'app')
    expect(appEvents.length).toBe(2)
    expect(appEvents[1].severity).toBe('success')
    expect(appEvents[1].message).toMatch(/Ready/)
  })

  it('writer (a): mounting (no real transition) emits no app event', () => {
    render(<App />)
    expect(useCamStore.getState().consoleEvents.filter(e => e.source === 'app')).toEqual([])
  })
})
