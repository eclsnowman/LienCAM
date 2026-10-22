// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'

// WO-2898: within one open project, reopening Post Process starts on the post
// the operator last chose and the operation ticks he last left (the operator's card
// Q-POST-DIALOG-REMEMBER-YOUR-LAST-P, 10-16: after Export UCCNC with Thread
// Mill 3 unticked, reopening showed GRBL with every operation ticked).

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size },
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  removeItem: (key: string) => { memory.delete(key) },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
} })
const { useCamStore } = await import('../../store')
const { removeRegisteredLocalData } = await import('../../store/persistedKeys')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const initial = useCamStore.getState()
const tool = makeTool()

function op(id: string, name: string): Operation {
  return makeOp({ id, name, toolId: tool.id })
}
function seed(id = 'wo2898-project') {
  const setup: Setup = {
    id: 'setup-1', name: 'Setup 1', notes: '',
    stock: makeStock(), wcs: makeWcs({ id: 'wcs-54', fixtureOffset: 54, label: 'G54' }),
    operations: [op('op-1', 'Facing 1'), op('op-2', 'Contour 2'), op('op-3', 'Thread Mill 3')],
  }
  const project: Project = {
    ...initial.project, id, name: 'Bracket', machine: makeMachine({ controller: 'grbl' }),
    setups: [setup], activeSetupId: setup.id, toolLibrary: [tool], stocks: [], nests: [],
  }
  for (const o of setup.operations) stampGenerationCurrent(project, setup, o, tool)
  act(() => useCamStore.setState({ project, toolLibrary: [tool], consoleEvents: [], modelRefsVerifiedSinceLoad: true }))
}
function editOperations(edit: (ops: Operation[]) => Operation[]) {
  act(() => {
    const project = useCamStore.getState().project
    const setup = project.setups[0]
    const next: Setup = { ...setup, operations: edit(setup.operations) }
    const nextProject: Project = { ...project, setups: [next] }
    for (const o of next.operations) stampGenerationCurrent(nextProject, next, o, tool)
    useCamStore.setState({ project: nextProject })
  })
}
const openDialog = () => act(() => useCamStore.getState().openModal('post-process'))
const closeDialog = () => act(() => useCamStore.getState().closeModal())
const picker = () => screen.getByTestId('post-definition-select')
function choosePost(id: string) {
  fireEvent.click(picker())
  fireEvent.click(screen.getByTestId(`post-definition-select-option-${id}`))
}
const tick = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
function ticks(): Record<string, boolean> {
  return Object.fromEntries(useCamStore.getState().project.setups[0].operations
    .map(o => [o.name, tick(o.name).checked]))
}

beforeEach(() => {
  memory.clear()
  closeDialog()
  seed()
  render(<PostProcessModal />)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  act(() => useCamStore.setState({ project: initial.project, toolLibrary: initial.toolLibrary, activeModal: null }))
})

describe('WO-2898 Post dialog remembers the last post and selection', () => {
  it('opens on the setup machine post with every operation ticked the first time', () => {
    openDialog()
    expect(picker().textContent).toContain('GRBL')
    expect(ticks()).toEqual({ 'Facing 1': true, 'Contour 2': true, 'Thread Mill 3': true })
  })

  it('reopens on the post and ticks the operator left', () => {
    openDialog()
    choosePost('uccnc')
    fireEvent.click(tick('Thread Mill 3'))
    closeDialog()
    openDialog()
    expect(picker().textContent).toContain('UCCNC')
    expect(screen.getByRole('button', { name: 'Export .nc' })).toBeTruthy()
    expect(ticks()).toEqual({ 'Facing 1': true, 'Contour 2': true, 'Thread Mill 3': false })
  })

  it('drops an operation deleted since the last post', () => {
    openDialog()
    fireEvent.click(tick('Thread Mill 3'))
    closeDialog()
    editOperations(ops => ops.filter(o => o.id !== 'op-2'))
    openDialog()
    expect(ticks()).toEqual({ 'Facing 1': true, 'Thread Mill 3': false })
    expect(screen.queryByRole('checkbox', { name: 'Contour 2' })).toBeNull()
  })

  it('ticks an operation added since the last post', () => {
    openDialog()
    fireEvent.click(tick('Thread Mill 3'))
    closeDialog()
    editOperations(ops => [...ops, op('op-4', 'Drill 4')])
    openDialog()
    expect(ticks()).toEqual({ 'Facing 1': true, 'Contour 2': true, 'Thread Mill 3': false, 'Drill 4': true })
  })

  it('falls back to the machine post when the remembered post was removed', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('My UCCNC')
    openDialog()
    choosePost('uccnc')
    fireEvent.click(screen.getByRole('button', { name: 'New / Save Post As...' }))
    expect(picker().textContent).toContain('My UCCNC')
    closeDialog()
    removeRegisteredLocalData('userPosts')
    openDialog()
    expect(picker().textContent).toContain('GRBL')
    expect(picker().textContent).not.toContain('My UCCNC')
  })

  it('starts another project on the defaults', () => {
    openDialog()
    choosePost('uccnc')
    fireEvent.click(tick('Thread Mill 3'))
    closeDialog()
    seed('another-project')
    openDialog()
    expect(picker().textContent).toContain('GRBL')
    expect(ticks()).toEqual({ 'Facing 1': true, 'Contour 2': true, 'Thread Mill 3': true })
  })

  // Fix round 1 (astra): reopening restores the post, never the operator's
  // export-unit choice; a vendor inch post switched to mm reopens on mm.
  it('reopens a vendor post on the export units the operator left', async () => {
    openDialog()
    const source = readFileSync('src/tests/post/fixtures/wo2292/router-inch.pp', 'utf8')
    await act(async () => {
      fireEvent.change(screen.getByTestId('post-import-input'), {
        target: { files: [{ name: 'router-inch.pp', size: source.length, text: async () => source }] },
      })
    })
    const units = (value: 'mm' | 'inch') =>
      document.querySelector(`input[name="post-export-units"][value="${value}"]`) as HTMLInputElement
    if (screen.getByTestId('disclosure-output-format').getAttribute('aria-expanded') === 'false') {
      fireEvent.click(screen.getByTestId('disclosure-output-format'))
    }
    expect(units('inch').checked).toBe(true)
    fireEvent.click(units('mm'))
    expect(units('mm').checked).toBe(true)
    closeDialog()
    openDialog()
    if (screen.getByTestId('disclosure-output-format').getAttribute('aria-expanded') === 'false') {
      fireEvent.click(screen.getByTestId('disclosure-output-format'))
    }
    expect(units('mm').checked).toBe(true)
    expect(screen.getByTestId('post-gcode-preview').textContent).toContain('G21')
  })

  it('keeps the memory out of the saved project', () => {
    openDialog()
    choosePost('uccnc')
    fireEvent.click(tick('Thread Mill 3'))
    closeDialog()
    expect(JSON.stringify(useCamStore.getState().project)).not.toMatch(/uccnc/i)
  })
})
