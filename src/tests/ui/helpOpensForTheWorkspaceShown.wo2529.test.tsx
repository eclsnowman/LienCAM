// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TopToolbar } from '../../components/toolbar/TopToolbar'
import { HelpCenterModal } from '../../components/modals/HelpCenterModal'
import { useCamStore } from '../../store'
import { openHelpTopic, useHelpOpen } from '../../help/helpOpen'
import { useHelpContext } from '../../help/helpContextStore'
import { deriveHelpContext, rankTopics } from '../../help/helpContext'
import { helpIndex } from '../../help/registry'
import { readFileSync } from 'node:fs'

beforeEach(() => {
  useCamStore.getState().newProject()
  const state = useCamStore.getState()
  useCamStore.setState({ workspace: 'cam', activeModal: null, consoleEvents: [],
    viewer: { ...state.viewer, mode: 'setup', selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    project: { ...state.project, activeOperationId: null },
  })
  useHelpOpen.setState({ requested: null, overlay: false })
  useHelpContext.setState({ pushed: [] })
})
afterEach(cleanup)

async function pressHelp(title: string) {
  render(<><TopToolbar /><HelpCenterModal /></>)
  fireEvent.click(screen.getByTestId('toolbar-help'))
  await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe(title))
}

describe('WO-2529: Help follows the workspace shown', () => {
  it('keeps the fresh Setup default on Your first toolpath', async () => {
    await pressHelp('Your first toolpath')
  })

  it('opens Simulate help for the actual starter kit with setup and final operation retained', async () => {
    await act(async () => {
      await useCamStore.getState().loadProjectFromFile(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
      useCamStore.getState().setViewerMode('simulation')
    })
    expect(useCamStore.getState().project.activeSetupId).toBeTruthy()
    expect(useCamStore.getState().project.activeOperationId).toBeTruthy()
    await pressHelp('Stock simulation')
  })

  it.each([
    ['cam', 'simulation', 'Stock simulation'],
    ['cam', 'sketch', 'Calibrating a reference image'],
    ['cam', 'toolpath', 'Reading the toolpath view'],
    ['part', 'simulation', 'The Model workspace'],
    ['control', 'simulation', 'The Control tab'],
  ] as const)('%s / %s beats a retained CAM selection', async (workspace, mode, title) => {
    const state = useCamStore.getState()
    useCamStore.setState({ workspace,
      viewer: { ...state.viewer, mode, selectedStockId: 'retained-stock' },
    })
    await pressHelp(title)
  })

  it('selects an operation topic within Setup', async () => {
    const state = useCamStore.getState()
    // Structural fixture: derivation only reads the operation id/type.
    const source = { ...state, project: { activeOperationId: 'op', setups: [{ operations: [{ id: 'op', type: 'drill' }] }] } }
    const ranked = rankTopics(helpIndex(), deriveHelpContext(source))
    expect(ranked.suggested[0].contextKeys).toContain('selection:operation:drill')
  })

  it.each(['simulation', 'sketch'] as const)('%s excludes every retained CAM selection route', mode => {
    const state = useCamStore.getState()
    for (const field of ['selectedGeometryId', 'selectedStockId', 'selectedNestId'] as const) {
      const keys = deriveHelpContext({ ...state, viewer: { ...state.viewer, mode, [field]: 'retained' } })
      expect(keys.some(key => key.startsWith('panel:') || key.startsWith('selection:'))).toBe(false)
    }
    const keys = deriveHelpContext({ ...state, viewer: { ...state.viewer, mode },
      project: { activeOperationId: 'op', setups: [{ operations: [{ id: 'op', type: 'drill' }] }] } })
    expect(keys.some(key => key.startsWith('panel:') || key.startsWith('selection:'))).toBe(false)
  })

  it('keeps the Model Form interaction more specific than its workspace overview', () => {
    const state = useCamStore.getState()
    const keys = [...deriveHelpContext({ ...state, workspace: 'part' }), 'interaction:form']
    expect(rankTopics(helpIndex(), keys).suggested[0].contextKeys).toContain('interaction:form')
  })

  it('preserves dialog suggestions when their scope is supplied', async () => {
    useHelpContext.getState().push('modal:new-setup')
    await pressHelp('Setup and WCS')
  })

  it('explicit hotlinks still win over the workspace', async () => {
    render(<HelpCenterModal />)
    act(() => openHelpTopic('setup-wcs'))
    await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe('Setup and WCS'))
  })

  it('the console error route still opens error details', async () => {
    render(<HelpCenterModal />)
    act(() => useCamStore.getState().openModal('help-errors'))
    await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe('Where error details live'))
  })
})
