// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

function seedPostOperation(): void {
  const tool = makeTool()
  const operation = makeOp({ toolId: tool.id })
  const setup = { id: 'wo1152-setup', name: 'WO-1152 setup', wcs: makeWcs(), stock: makeStock(), operations: [operation], notes: '' }
  act(() => {
    const current = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    const project = { ...current.project, name: 'WO-1152 layout', machine: makeMachine(), setups: [setup], activeSetupId: setup.id }
    stampGenerationCurrent({ ...project, toolLibrary: [tool] } as unknown as Project, setup as unknown as Setup, operation, tool)
    useCamStore.setState({ project, toolLibrary: [tool] } as never)
    useCamStore.getState().openModal('post-process')
  })
}

beforeEach(seedPostOperation)
afterEach(() => {
  cleanup()
  act(() => useCamStore.getState().closeModal())
})

describe('WO-1152 Post Process split layout controls', () => {
  it('uses native radios for export units and updates the output code', () => {
    render(<PostProcessModal />)
    fireEvent.click(screen.getByTestId('disclosure-output-format'))

    const metric = screen.getByRole('radio', { name: 'mm' }) as HTMLInputElement
    const imperial = screen.getByRole('radio', { name: 'in' }) as HTMLInputElement
    expect(metric.checked).toBe(true)
    expect(imperial.checked).toBe(false)

    fireEvent.click(imperial)
    expect(metric.checked).toBe(false)
    expect(imperial.checked).toBe(true)
    expect(screen.getByText((_, element) => element?.classList.contains('badge-config') === true
      && element.textContent?.replace(/\s+/g, ' ').trim() === 'G20 (in)')).toBeTruthy()
  })
})
