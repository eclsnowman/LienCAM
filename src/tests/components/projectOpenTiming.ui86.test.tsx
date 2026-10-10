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

afterEach(cleanup)

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

describe('UI-86 App project-open timing integration', () => {
  it('observes every real UI-85 phase and writes one privacy-safe console summary', async () => {
    render(<App />)
    const privateProjectName = 'Secret Customer Turbine'
    const privateProjectId = 'customer-path-project-4421'
    const projectText = JSON.stringify({
      ...structuredClone(useCamStore.getState().project),
      id: privateProjectId,
      name: privateProjectName,
      geometry: [],
      setups: [],
      modelItems: [],
      modelItemPlacements: [],
    })

    await act(async () => {
      const store = useCamStore.getState()
      const requestId = store.beginProjectOpen()
      await store.loadProjectFromFile(projectText, requestId)
    })

    const timingEvents = useCamStore.getState().consoleEvents.filter((event) =>
      event.source === 'app' && event.message.startsWith('Project open timing'),
    )
    expect(timingEvents).toHaveLength(1)
    expect(timingEvents[0].severity).toBe('info')
    expect(timingEvents[0].message).not.toContain(privateProjectName)
    expect(timingEvents[0].message).not.toContain(privateProjectId)

    const sample = getLatestProjectOpenTimingSample()
    expect(sample?.phases.map((phase) => phase.phase)).toEqual([
      'reading-file',
      'validating-project',
      'validating-model-documents',
      'restoring-checkpoints',
      'installing-project',
      'restoring-scene',
    ])
    expect(JSON.stringify(sample)).not.toContain(privateProjectName)
    expect(JSON.stringify(sample)).not.toContain(privateProjectId)
    for (const duration of [...(sample?.phases.map((phase) => phase.durationMs) ?? []), sample?.totalMs ?? 0]) {
      expect(Number.isFinite(duration)).toBe(true)
      expect(duration).toBeGreaterThanOrEqual(0)
    }
  })
})
