// @vitest-environment jsdom
//
// WO-2205 - THE PROBING SCREEN'S HELP LINK COMES BACK.
//
// Operator, 2026-09-29 (card Q-PROBING-SCREEN-PUT-ITS-HELP-LINK): "Put it back,
// nothing else changes." WO-2063's v2 rebuild dropped the '?' that sat in the
// old setup card's heading. It returns in the routine setup heading
// ("<Routine> setup"), the same HelpLink every other screen uses.
//
// Route: the production Probing panel (ProbingPanel) with the Help Center
// mounted beside it. For every routine the screen offers:
//   1. the setup heading carries exactly one help link, to 'probing-tab', and
//      it is the only help link on the whole screen;
//   2. clicking it opens the Help Center at "The Probing tab".
//
// Negative control (recorded in the work order): with the <HelpLink> removed
// from ProbingPanel.tsx both tests go red (no link found in the heading).

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useHelpOpen } = await import('../../help/helpOpen')

const PROGRAM = 'G21 G90\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X60 F600\nG1 Y40\nG1 X0\nG1 Y0\nG0 Z5\nM30\n'

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null })
    useHelpOpen.setState({ requested: null, overlay: false })
    useMachineToolTable.setState({ byMachine: {} })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      activeWcs: 'G54',
      programText: PROGRAM,
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
  })
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
  vi.restoreAllMocks()
})

/** Every routine button the screen shows, by its routine kind. */
function routineKinds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="control-work-probe-routine-"]'))
    .map((b) => b.getAttribute('data-testid')!.replace('control-work-probe-routine-', ''))
}

describe('WO-2205: the Probing screen has its help link back', () => {
  it('shows one link to "probing-tab" in the setup heading, for every routine, and no other help link', () => {
    render(React.createElement(ProbingPanel))
    const kinds = routineKinds()
    expect(kinds.length, 'no routine buttons found on the Probing screen').toBeGreaterThanOrEqual(10)
    for (const kind of kinds) {
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${kind}`))
      const card = screen.getByTestId('control-probe-setup-card')
      const title = card.querySelector('.panel-header .panel-title')!
      const links = Array.from(title.querySelectorAll('.help-link'))
      expect(links, `${kind}: setup heading help links`).toHaveLength(1)
      expect(links[0].getAttribute('data-help-topic'), kind).toBe('probing-tab')
      expect(links[0].getAttribute('data-help-anchor'), kind).toBeNull()
      expect(title.textContent, kind).toMatch(/ setup$/)
      expect(document.querySelectorAll('.help-link'), `${kind}: help links on the whole screen`).toHaveLength(1)
    }
  })

  it('opens the Help Center at "The Probing tab" when clicked', async () => {
    render(
      <>
        <ProbingPanel />
        <HelpCenterModal />
      </>,
    )
    expect(screen.queryByTestId('help-center')).toBeNull()
    const card = screen.getByTestId('control-probe-setup-card')
    fireEvent.click(within(card).getByTestId('control-probe-help-setup'))
    await waitFor(() => expect(screen.queryByTestId('help-center')).toBeTruthy())
    expect(useHelpOpen.getState().requested?.topicId).toBe('probing-tab')
    expect(useCamStore.getState().activeModal).toBe('help')
    await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe('The Probing tab'))
  })
})
