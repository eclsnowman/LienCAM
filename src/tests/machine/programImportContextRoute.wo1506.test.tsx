// @vitest-environment jsdom
//
// WO-1506: BUG-437 + BUG-436, one shared cause. ProgramPanel's two raw-program
// entry points, loadFromFile and loadFromRecent, now share one
// decode-and-diagnose step before applyProgram. This proves both symptoms are
// gone through BOTH doors: a verified LCX1 block binds its setup whether the
// program is opened from disk or reopened from Recent (BUG-437), and a
// rejected block always reaches the operator's own console, not only
// devtools (BUG-436) - while a plain file with no block still loads silent
// and contextless (WO-381/WO-397 unchanged).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { Operation, Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import { typedMock } from '../support/typedMock'
import type { RecentProgramMeta } from '../../lib/machine/programLibrary'

let recentText = ''
const recentEntry: RecentProgramMeta = { id: 'rec1', name: 'recent.nc', size: 0, savedAt: 1000 }

vi.mock('../../lib/machine/programLibrary', () =>
  typedMock<typeof import('../../lib/machine/programLibrary')>({
    programLibrarySupported: () => true,
    listPrograms: vi.fn(() => Promise.resolve([recentEntry])),
    saveProgram: vi.fn(() => Promise.resolve()),
    readProgram: vi.fn((id: string) => Promise.resolve(id === recentEntry.id ? recentText : null)),
  }))

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { postProject, UCCNC_CONFIG } = await import('../../lib/post')

function twoMoveOp(id: string, name: string): Operation {
  return makeOp({
    id, name, toolId: 't1',
    toolpathMoves: [
      { type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' },
      { type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' },
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
function makeProject(setups: Setup[]): Project {
  const project: Project = {
    id: 'p-wo1506', name: 'WO-1506 Part', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine({ controller: 'uccnc' } as never),
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
  useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
  act(() => { useMachineControl.getState().setProgram('', '', [], null) })
  act(() => { useMachineControl.getState().clearConsole() })
})

function setupProject(): string {
  const project = makeProject([makeSetup('s1', 'Setup One', 54)])
  act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary } as never) })
  return postProject(project, project.setups, UCCNC_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc', programContext: true,
  }).combined!.gcode
}

async function openFile(name: string, text: string): Promise<void> {
  const input = screen.getByTestId('control-file-input') as HTMLInputElement
  const file = new File([text], name, { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
    await Promise.resolve()
  })
}

async function openRecent(text: string): Promise<void> {
  recentText = text
  fireEvent.click(screen.getByTestId('control-load-menu'))
  await waitFor(() => screen.getByTestId(`control-recent-item-${recentEntry.id}`))
  await act(async () => {
    fireEvent.click(screen.getByTestId(`control-recent-item-${recentEntry.id}`))
    await Promise.resolve()
  })
}

describe('WO-1506: loadFromFile and loadFromRecent share one context decode', () => {
  it('BUG-437: a verified LCX1 block binds its setup from Recent exactly as it does from File', async () => {
    const exported = setupProject()
    expect(exported).toMatch(/LCX1 end/)
    render(<ProgramPanel />)

    await openFile('part.nc', exported)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('Setup: Setup One (G54)'))
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')

    // Reset the session, then load the SAME bytes back only from Recent.
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
    await openRecent(exported)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('Setup: Setup One (G54)'))
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')
    expect(useMachineControl.getState().programContext?.source).toBe('verified-export')
  })

  // The fixture machine has no resolved travel envelope, so loadMachineProgram
  // itself always logs unrelated axis-envelope lines - noise this WO does not
  // touch. Isolate the ONE line this WO is responsible for.
  const contextWarnings = () =>
    useMachineControl.getState().consoleLines.filter(
      (l) => l.severity === 'warn' && l.text.includes('LienCAM setup information'),
    )

  it('BUG-436: a rejected block (damaged checksum) reaches the operator console from BOTH routes', async () => {
    const exported = setupProject()
    const tampered = exported.replace('X30', 'X31')
    render(<ProgramPanel />)

    await openFile('edited.nc', tampered)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information'))
    let warnings = contextWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ dir: 'rx', severity: 'warn' })
    expect(warnings[0].text).toMatch(/Ignoring the LienCAM setup information in this file/)

    act(() => { useMachineControl.getState().clearConsole() })
    act(() => { useMachineControl.getState().setProgram('', '', [], null) })

    await openRecent(tampered)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information'))
    warnings = contextWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ dir: 'rx', severity: 'warn' })
    expect(warnings[0].text).toMatch(/Ignoring the LienCAM setup information in this file/)
  })

  it('an ordinary .nc file with no LienCAM block loads silent and contextless from BOTH routes', async () => {
    setupProject()
    render(<ProgramPanel />)
    const plain = 'G21 G90\nG0 X0 Y0\nM30\n'

    await openFile('foreign.nc', plain)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information'))
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('no-context')
    expect(contextWarnings()).toHaveLength(0)

    act(() => { useMachineControl.getState().setProgram('', '', [], null) })
    await openRecent(plain)
    await waitFor(() => expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information'))
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('no-context')
    expect(contextWarnings()).toHaveLength(0)
  })
})
