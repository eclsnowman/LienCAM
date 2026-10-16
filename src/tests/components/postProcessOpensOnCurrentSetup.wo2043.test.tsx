// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../types'
import { move, stampGenerationCurrent } from '../post/helpers'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

const originalProject = useCamStore.getState().project
const originalToolLibrary = useCamStore.getState().toolLibrary

function fullSuiteWithOnlySetup1Generated(): Project {
  const project = JSON.parse(readFileSync(
    resolve('Example Projects/Full Suite.camproject'),
    'utf8',
  )) as Project
  const setup = project.setups[0]
  project.activeSetupId = setup.id
  // The shipped example carries every setup's results (WO-2861); this scenario
  // is the one where only Setup 1 has been generated.
  for (const other of project.setups.slice(1)) {
    for (const operation of other.operations) {
      operation.status = 'pending'
      operation.toolpathMoves = undefined
    }
  }

  setup.operations.forEach((operation) => {
    operation.status = 'ready'
  })
  setup.operations.forEach((operation) => {
    const tool = project.toolLibrary.find((candidate) => candidate.id === operation.toolId)
    if (!tool) throw new Error(`Full Suite fixture has no tool ${operation.toolId}`)
    stampGenerationCurrent(project, setup, operation, tool)
  })
  setup.operations.forEach((operation, index) => {
    const { clearance, bottom } = operation.resolvedHeights!.machine
    operation.toolpathMoves = [
      move({ type: 'rapid', role: 'rapid', x: index * 10, y: 0, z: clearance }),
      move({ type: 'feed', role: 'plunge', x: index * 10, y: 0, z: bottom, feed: 300 }),
      move({ type: 'feed', role: 'cut', x: index * 10 + 5, y: 5, z: bottom, feed: 1200 }),
      move({ type: 'rapid', role: 'rapid', x: index * 10 + 5, y: 5, z: clearance }),
    ]
  })
  return project
}

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:wo-2043'),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const project = fullSuiteWithOnlySetup1Generated()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({
      project,
      toolLibrary: project.toolLibrary,
      consoleEvents: [],
      consoleReadThroughId: 0,
    } as never)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({
      project: originalProject,
      toolLibrary: originalToolLibrary,
    })
  })
})

describe('WO-2043 Post Process scope', () => {
  it('opens on the active generated setup and omits named pending operations from All operations export', async () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))

    const allOperations = screen.getByRole('checkbox', { name: /^All operations/ }) as HTMLInputElement
    await waitFor(() => expect(allOperations.checked).toBe(false))

    const setupRows = Array.from(document.querySelectorAll('.scope-setup-row'))
    const setupSelection = setupRows.map((row) => ({
      name: row.querySelector('.scope-setup-name')?.textContent,
      checked: (row.querySelector('.scope-setup-cb') as HTMLInputElement).checked,
    }))
    expect(setupSelection).toEqual([
      { name: 'Setup 1', checked: true },
      { name: 'Setup 2', checked: false },
      { name: 'Setup 4', checked: false },
      { name: 'Setup 5', checked: false },
    ])
    expect(document.querySelector('.modal-title')?.textContent).toContain('1 setup, 3 operations')
    expect(Array.from(document.querySelectorAll('.diag-err')).map((row) => row.textContent)).toEqual([])

    // Select the posted program download, not another export action's prefix.
    const exportButton = screen.getByRole('button', { name: /^Export \./ }) as HTMLButtonElement
    expect(exportButton.disabled).toBe(false)

    fireEvent.click(allOperations)

    const pendingNames = [
      'Drill 2',
      '3D Rough 2',
      'Face 1',
      '3D Rough 1',
      '3D Finish 3',
      'Contour 2',
    ]
    // The row is found by its sentence; the raw code stays off screen (WO-2880).
    const omissionText = await screen.findByText((text) => text.includes('Generate them first.'))
    const omission = omissionText.closest('.diag-row')
    if (!omission) throw new Error('OPS_NOT_GENERATED diagnostic row is missing')
    expect(omission.getAttribute('data-code')).toBe('OPS_NOT_GENERATED')
    expect(omission.textContent).not.toContain('OPS_NOT_GENERATED')
    for (const name of pendingNames) expect(omission.textContent).toContain(name)
    expect(omission.textContent?.match(/Generate them first\./g)).toHaveLength(1)
    expect(Array.from(document.querySelectorAll('.diag-err')).map((row) => row.textContent)).toEqual([])
    expect(exportButton.disabled).toBe(false)

    const preview = screen.getByTestId('post-gcode-preview').textContent ?? ''
    expect(preview).toContain('Setup 1')
    expect(preview).not.toContain('Setup 2')

    fireEvent.click(exportButton)
    await waitFor(() => {
      expect(useCamStore.getState().consoleEvents.some(
        (event) => event.source === 'post' && event.message.startsWith('Posted '),
      )).toBe(true)
    })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
  })
})
