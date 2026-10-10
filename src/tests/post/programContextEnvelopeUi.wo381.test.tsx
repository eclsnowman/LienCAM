// @vitest-environment jsdom
//
// WO-381: what Operator sees. In Post Process: an "Include LienCAM context" toggle,
// ON by default for a certified post, whose preview then ends in the LCX1
// comment block; OFF = the plain program; disabled for an uncertified post;
// a plain-language reason for a multi-setup combined program. In Control: a
// file exported with the block binds its setup (chip "Setup: ... (G54)",
// current); a foreign file shows "No setup information".

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { Operation, Project, Setup, Stock } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import { typedMock } from '../support/typedMock'

vi.mock('../../components/machine/ProgramPreview', () =>
  typedMock<typeof import('../../components/machine/ProgramPreview')>({
    ProgramPreview: () => <div data-testid="program-preview-stub" />,
  }))

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

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { postProject, UCCNC_CONFIG } = await import('../../lib/post')

function makeStock(): Stock {
  return { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 }, material: 'aluminum' } as unknown as Stock
}
function twoMoveOp(id: string, name: string): Operation {
  return makeOp({
    id, name, toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}
function makeSetup(id: string, name: string, fixtureOffset: number): Setup {
  return {
    id, name,
    wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }),
    stock: makeStock(),
    operations: [twoMoveOp(`${id}-op`, `${name} face`)],
    notes: 'Shop notes.',
  }
}
function makeProject(setups: Setup[], controller = 'uccnc'): Project {
  const project: Project = {
    id: 'p-ui', name: 'UI Part', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine({ controller } as never),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 })],
    geometry: [], setups, activeSetupId: setups[0].id, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const setup of setups) for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  return project
}

const originalProject = useCamStore.getState().project
const originalToolLibrary = useCamStore.getState().toolLibrary

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
  useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
  act(() => { useMachineControl.getState().setProgram('', '', [], null) })
})

function openModal(project: Project): void {
  act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary } as never) })
  render(<PostProcessModal />)
  act(() => { useCamStore.getState().openModal('post-process') })
}

const toggleInput = () =>
  screen.getByTestId('post-include-context-row').querySelector('input[type="checkbox"]') as HTMLInputElement
const previewText = () => screen.getByTestId('post-gcode-preview').textContent ?? ''

describe('WO-381: Post Process "Include LienCAM context"', () => {
  it('is ON by default for a certified post (UCCNC from the machine), and the preview ends in the LCX1 block after M30', () => {
    openModal(makeProject([makeSetup('s1', 'Setup One', 54)]))
    expect(toggleInput().checked).toBe(true)
    expect(toggleInput().disabled).toBe(false)
    const text = previewText()
    expect(text).toMatch(/M30\n\( LCX1 v=1 n=\d+ bytes=\d+ \)\n\( LCX1 sha256=/)
    expect(text.trimEnd().endsWith('( LCX1 end )')).toBe(true)
    expect(screen.getByTestId('post-include-context-hint').textContent).toMatch(/written after M30 as \d+ comment lines/)
  })

  it('OFF removes the whole block and the preview is the plain program', () => {
    const project = makeProject([makeSetup('s1', 'Setup One', 54)])
    openModal(project)
    act(() => { fireEvent.click(toggleInput()) })
    expect(toggleInput().checked).toBe(false)
    expect(previewText()).not.toMatch(/LCX1/)
    expect(previewText().trimEnd().endsWith('M30')).toBe(true)
    expect(screen.getByTestId('post-include-context-hint').textContent).toMatch(/off - the file is the plain program only/)
  })

  it('is OFF and disabled for an uncertified post (Generic)', () => {
    openModal(makeProject([makeSetup('s1', 'Setup One', 54)], 'generic'))
    expect(toggleInput().checked).toBe(false)
    expect(toggleInput().disabled).toBe(true)
    expect(previewText()).not.toMatch(/LCX1/)
    expect(screen.getByTestId('post-include-context-hint').textContent).toMatch(/not certified for LienCAM context/)
  })

  it('WO-412: a combined multi-setup program carries one v=2 block and the hint names the setup count', () => {
    openModal(makeProject([makeSetup('s1', 'Setup One', 54), makeSetup('s2', 'Setup Two', 55)]))
    // WO-2043 (83472ff35) deliberately opens on the active setup. WO-2337:
    // request the wider scope explicitly before asserting the multi-setup block.
    const allOperations = screen.getByRole('checkbox', { name: /^All operations/ }) as HTMLInputElement
    expect(allOperations.checked).toBe(false)
    expect(previewText()).toMatch(/LCX1 v=1 /)
    act(() => { fireEvent.click(allOperations) })
    expect(allOperations.checked).toBe(true)
    expect(toggleInput().checked).toBe(true)
    expect(previewText()).toMatch(/LCX1 v=2 /)
    expect(previewText().match(/LCX1 v=2 /g)).toHaveLength(1)
    expect(previewText()).toMatch(/\nG54\n/)
    expect(previewText()).toMatch(/\nG55\n/)
    expect(screen.getByTestId('post-include-context-hint').textContent).toMatch(/setup information for 2 setups written after M30 as \d+ comment lines/)
  })
})

describe('WO-381: Control "Open file" binds an exported file to its setup', () => {
  async function openFile(name: string, text: string): Promise<void> {
    const input = screen.getByTestId('control-file-input') as HTMLInputElement
    const file = new File([text], name, { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
      await Promise.resolve()
    })
  }

  it('an exported file shows "Setup: Setup One (G54)" and is current; a tampered or foreign file shows "No setup information"', async () => {
    const project = makeProject([makeSetup('s1', 'Setup One', 54)])
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary } as never) })
    const exported = postProject(project, project.setups, UCCNC_CONFIG, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc', programContext: true,
    }).combined!.gcode
    expect(exported).toMatch(/LCX1 end/)
    render(<ProgramPanel />)

    await openFile('part.nc', exported)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('Setup: Setup One (G54)'))
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')
    expect(useMachineControl.getState().programContext?.source).toBe('verified-export')

    await openFile('edited.nc', exported.replace('X30', 'X31'))
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information'))
    expect(useMachineControl.getState().programContext).toBeNull()

    await openFile('foreign.nc', 'G21 G90\nG0 X0 Y0\nM30\n')
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information'))
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('no-context')
  })
})
