// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { InMemoryDocumentStorage } from '../../doc/persist'
import { resetDocumentHolder, setDocumentStorage } from '../../doc/documentHolder'
import { typedMock } from '../support/typedMock'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
vi.mock('../../components/model3d/SolidsWorkbenchPage', () => typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
  SolidsWorkbenchPage: () => <div data-testid="model-workspace-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { getLatestProjectOpenTimingSample } = await import('../../lib/perf/projectOpenTiming')

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

beforeEach(() => {
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  act(() => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        id: 'ui86-baseline',
        name: 'Baseline',
        geometry: [],
        setups: [],
        modelItems: [],
        modelItemPlacements: [],
      },
      projectOpen: null,
      workspace: 'cam',
      consoleEvents: [],
      consoleReadThroughId: 0,
    }))
  })
})


describe('WO-2703 project timing console visibility', () => {
  it.each([false, true])('keeps samples and emits operator timing only in development (DEV=%s)', async (dev) => {
    vi.stubEnv('DEV', dev)
    render(<App />)
    const text = JSON.stringify({ ...structuredClone(useCamStore.getState().project), id: 'opened-2703', name: 'Opened project' })
    await act(async () => {
      const store = useCamStore.getState()
      const request = store.beginProjectOpen()
      await store.loadProjectFromFile(text, request)
    })
    const timing = useCamStore.getState().consoleEvents.filter(e => e.message.startsWith('Project open timing'))
    expect(timing).toHaveLength(dev ? 1 : 0)
    expect(getLatestProjectOpenTimingSample()?.outcome).toBe('ended')
    expect(useCamStore.getState().consoleEvents.some(e => e.message.includes('Project opened: Opened project'))).toBe(true)
  })
})
