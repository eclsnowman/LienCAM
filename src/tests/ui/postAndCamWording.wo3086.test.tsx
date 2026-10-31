// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => [...mem.keys()][index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
} })
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { textFor, applyLanguage } = await import('../../i18n')

beforeEach(async () => {
  await applyLanguage('en')
  act(() => {
    useCamStore.getState().newProject()
    const tool = makeTool()
    const setup: Setup = { id: 'setup-1', name: 'Setup 1', wcs: makeWcs(), stock: makeStock(), operations: [makeOp()], notes: '' }
    const project = { ...useCamStore.getState().project, machine: makeMachine(), setups: [setup], activeSetupId: setup.id, toolLibrary: [tool] }
    stampGenerationCurrent(project, setup, setup.operations[0], tool)
    useCamStore.setState({ project, toolLibrary: [tool], activeModal: null })
  })
})
afterEach(cleanup)

describe('WO-3086 truthful Post and CAM wording', () => {
  it('says nothing is selected in combined and separate previews, then posts the selected operation', () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    // One setup starts fully selected; unticking it leaves an empty scope.
    expect(screen.getByTestId('post-gcode-preview').textContent).toContain('No operations selected')
    expect(document.querySelector('.diag')?.textContent).toContain('No operations selected')
    expect(document.querySelector('.diag')?.textContent).not.toContain('assembled cleanly')
    fireEvent.click(screen.getByRole('button', { name: 'Separate files (one per setup)' }))
    expect(document.querySelector('.diag')?.textContent).toContain('No operations selected')
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    expect(screen.getByTestId('post-gcode-preview').textContent).toContain('G54')
    expect(screen.getByRole('button', { name: /Export/ }).hasAttribute('disabled')).toBe(false)
  })

  it('shows the existing reason beside Create when the part belongs to another setup stock', async () => {
    act(() => useCamStore.setState(s => ({ project: { ...s.project,
      stocks: ['stock-1', 'stock-2'].map(id => ({ id, name: id, mode: 'explicit' as const,
        position: { x: 0, y: 0, z: 0 }, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 }, size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 } } })),
      setups: s.project.setups.map(setup => ({ ...setup, operations: [], wcs: { ...setup.wcs, stockId: 'stock-1' } })),
      geometry: [{ id: 'part-other-setup', name: 'Other setup part', type: 'curves_2d', format: 'svg', loaded: true, stockId: 'stock-2',
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
        loops: [{ id: 'outer', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true, type: 'contour', layerId: 'layer-1', area: 100 }],
      }] as ImportedGeometry[],
    } })))
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Test Tool'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-other-setup' } })
    const loop = document.querySelector('.op-loop-check input') as HTMLInputElement
    if (!loop.checked) fireEvent.click(loop)
    await waitFor(() => {
      const button = screen.getByTestId('op-create')
      expect(button.hasAttribute('disabled')).toBe(true)
      const reason = screen.getByTestId('op-create-reason')
      expect(reason.textContent).toBe(button.getAttribute('data-tooltip'))
      // WO-3137 forwards the resolver's actual stock mismatch beside Create.
      expect(reason.textContent).toBe("Contour Smart Height target 'Other setup part' belongs to stock 'stock-2', not this Setup's stock 'stock-1'.")
      expect(reason.closest('.modal-footer')).not.toBeNull()
    })
  })

  it('describes an automatically assigned tool number as a completed action', () => {
    act(() => useCamStore.setState(s => {
      const tool = { ...s.toolLibrary[0], toolNumber: undefined }
      const project = { ...s.project, toolLibrary: [tool] }
      stampGenerationCurrent(project, project.setups[0], project.setups[0].operations[0], tool)
      return { project, toolLibrary: [tool] }
    }))
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))
    const notice = document.querySelector('[data-code="TOOL_NUMBER_ASSIGNED"]')!
    expect(notice.classList.contains('diag-info')).toBe(true)
    expect(notice.textContent).toContain('Assigned T1 to "Test Tool" for this program.')
    expect(notice.textContent).not.toMatch(/has no|Give it|Assign a/)
    expect(screen.getByRole('button', { name: /Export/ }).hasAttribute('disabled')).toBe(false)
  })

  it.each(['en', 'de', 'es', 'fr'])('labels low rapid moves and candidate links separately in %s', async language => {
    await applyLanguage(language)
    const line = textFor('console-and-operator-messages')('index40', { value1: 'Finish', value2: '34', value3: '21' })
    expect(line).not.toMatch(/34 (of|von|de|sur) 21/)
    expect(line).toContain('34')
    expect(line).toContain('21')
    const empty = textFor('setup-stock-tools-machine-post')('PostProcessModal.no_operations_selected')
    const assigned = textFor('console-and-operator-messages')('postToolNumberAssigned', { number: 1, name: 'Test Tool' })
    const reason = textFor('cam-operations-new-operation')('NewOperationModalBody.part_on_other_stock', { part: 'Part', stock: 'Stock 2', setupStock: 'Stock 1' })
    for (const text of [empty, assigned, reason]) {
      expect(text).not.toContain('{{')
      if (language !== 'en') expect(text).not.toMatch(/No operations selected|Assigned T1|this setup uses/)
    }
    if (language === 'en') expect(line).toBe('Finish: checked 21 links; 34 rapid moves stay below Clearance over material removed by earlier operations.')
    else expect(line).not.toContain('rapid moves')
  })
})
