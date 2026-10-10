// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Operation, Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs } from '../post/helpers'

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

type SelectionSnapshot = {
  setups: {
    name: string
    checked: boolean
    operations: { name: string; checked: boolean }[]
  }[]
}

type SelectionEvidence = {
  hiddenProgress: { before: SelectionSnapshot; after: SelectionSnapshot }
  shownProgress: { before: SelectionSnapshot; after: SelectionSnapshot }
  userUncheckProgress: { before: SelectionSnapshot; after: SelectionSnapshot }
  disabledOperation: SelectionSnapshot
  addedSetup: SelectionSnapshot
}

// WO-2620: re-recorded after WO-2043 - Post Process opens on the active setup
// (others unchecked; collapsed on each open) and an active-setup change while
// open re-answers the scope. Progress writes still change nothing.
const evidence = JSON.parse(readFileSync(
  'src/tests/evidence/WO-2620/post-process-selection-snapshots.json',
  'utf8',
)) as SelectionEvidence

const originalProject = useCamStore.getState().project
const originalToolLibrary = useCamStore.getState().toolLibrary

function operation(setupNumber: number, operationNumber: number): Operation {
  return makeOp({
    id: `setup-${setupNumber}-operation-${operationNumber}`,
    name: `Setup ${setupNumber} operation ${operationNumber}`,
    toolId: 'wo1172-tool',
  })
}

function setup(setupNumber: number, operationCount = 4): Setup {
  return {
    id: `setup-${setupNumber}`,
    name: `Setup ${setupNumber}`,
    wcs: makeWcs({
      id: `setup-${setupNumber}-wcs`,
      label: `G${53 + setupNumber}`,
      fixtureOffset: 53 + setupNumber,
    }),
    stock: makeStock(),
    operations: Array.from(
      { length: operationCount },
      (_, index) => operation(setupNumber, index + 1),
    ),
    notes: '',
  }
}

function project(): Project {
  const setups = [setup(1), setup(2), setup(3)]
  return {
    ...originalProject,
    id: 'wo1172-project',
    name: 'WO-1172 selection seed',
    machine: makeMachine(),
    geometry: [],
    setups,
    activeSetupId: setups[0].id,
    activeOperationId: null,
  }
}

function seedStore(): void {
  const nextProject = project()
  const toolLibrary = [makeTool({ id: 'wo1172-tool' })]
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ project: nextProject, toolLibrary } as never)
  })
}

function openScopeTree(): void {
  act(() => useCamStore.getState().openModal('post-process'))
  // WO-2043: Post Process opens with All operations off, the scope tree shown.
  expect((screen.getByRole('checkbox', { name: /^All operations/ }) as HTMLInputElement).checked).toBe(false)
  for (const expand of screen.getAllByRole('button', { name: 'Expand operations' })) {
    fireEvent.click(expand)
  }
}

function captureSelection(): SelectionSnapshot {
  const tree = document.querySelector('.scope-tree')
  if (!tree) throw new Error('Post Process scope tree is not visible')

  return {
    setups: Array.from(tree.children).map((setupContainer) => {
      const setupName = setupContainer.querySelector('.scope-setup-name')?.textContent ?? ''
      const setupCheckbox = setupContainer.querySelector('.scope-setup-cb') as HTMLInputElement
      return {
        name: setupName,
        checked: setupCheckbox.checked,
        operations: Array.from(setupContainer.querySelectorAll('.scope-op-row')).map((row) => {
          const checkbox = row.querySelector('.scope-op-cb') as HTMLInputElement
          return {
            name: row.querySelector('label')?.textContent?.trim() ?? '',
            checked: checkbox.checked,
          }
        }),
      }
    }),
  }
}

function writeProgress(count = 200): void {
  act(() => {
    for (let index = 0; index < count; index++) {
      const setupNumber = index % 3 + 1
      const operationNumber = index % 4 + 1
      useCamStore.getState().updateOperation(
        `setup-${setupNumber}`,
        `setup-${setupNumber}-operation-${operationNumber}`,
        { progress: (index + 1) / count, progressPhase: `WO-1172 batch ${index + 1}` },
      )
    }
  })
}

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

describe('WO-1172 Post Process selection seeding under progress writes', () => {
  it('stays quiet while hidden and seeds the same selection when shown again', () => {
    seedStore()
    const consoleError = vi.spyOn(console, 'error')
    render(<PostProcessModal />)
    openScopeTree()
    const before = captureSelection()

    act(() => useCamStore.getState().closeModal())
    writeProgress()
    act(() => useCamStore.getState().openModal('post-process'))
    const after = captureSelection()

    expect(consoleError).toHaveBeenCalledTimes(0)
    expect({ before, after }).toEqual(evidence.hiddenProgress)
  })

  it('preserves user selection on progress and reseeds only for selectable changes', () => {
    seedStore()
    const consoleError = vi.spyOn(console, 'error')
    render(<PostProcessModal />)
    openScopeTree()

    const shownBefore = captureSelection()
    writeProgress()
    const shownAfter = captureSelection()
    expect(shownAfter).toEqual(shownBefore)
    expect({ before: shownBefore, after: shownAfter }).toEqual(evidence.shownProgress)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Setup 1 operation 1' }))
    const userBefore = captureSelection()
    writeProgress()
    const userAfter = captureSelection()
    expect(userAfter).toEqual(userBefore)
    expect({ before: userBefore, after: userAfter }).toEqual(evidence.userUncheckProgress)

    act(() => useCamStore.getState().updateOperation(
      'setup-1',
      'setup-1-operation-2',
      { enabled: false },
    ))
    expect(captureSelection()).toEqual(evidence.disabledOperation)
    expect(screen.queryByRole('checkbox', { name: 'Setup 1 operation 2' })).toBeNull()

    // WO-2043: adding a setup makes it active, and an active-setup change while
    // open re-answers the scope - the new setup alone, checked and expanded.
    act(() => useCamStore.getState().addSetup(setup(4, 1)))
    expect(captureSelection()).toEqual(evidence.addedSetup)
    expect((screen.getByRole('checkbox', {
      name: 'Setup 4 operation 1',
    }) as HTMLInputElement).checked).toBe(true)
    expect(consoleError).toHaveBeenCalledTimes(0)
  })
})
