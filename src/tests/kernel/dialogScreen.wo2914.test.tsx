// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NewOperationModal } from '../../components/modals/NewOperationModal'
import { useCamStore } from '../../store'
import { textFor } from '../../i18n'

const tx = textFor('cam-operations-new-operation')
const types = ['2D_Contour', '2D_Pocket', 'Drill', 'Bore', '2D_Chamfer', '2D_Face',
  'Engrave_Trace', 'V_Carve', '2D_Adaptive_Clearing', 'Thread_Mill', 'Parallel_Finish_3D',
  'Waterline_Finish_3D', 'Scallop_Finish_3D', 'Pencil_Cleanup_3D', 'Steep_and_Shallow_3D', 'Adaptive_Rough_3D'] as const

afterEach(cleanup)
beforeEach(async () => {
  await useCamStore.getState().loadProjectFromFile(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
  act(() => {
    useCamStore.setState({ toolLibrary: [], toolLibraries: [] })
    useCamStore.getState().closeModal()
  })
})

describe('WO-2914 actual screen uses the common authoring outcome', () => {
  it.each(types)('%s explains its first unmet authoring prerequisite', type => {
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText(tx(`NewOperationModalBody.${type}`)))
    const button = screen.getByTestId('op-create') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    // WO-3137 (92480ccd92): these families need closed profiles before a preview can start.
    expect(button.getAttribute('data-tooltip')).toBe(tx(type === 'V_Carve' || type === 'Thread_Mill'
      ? 'NewOperationModalBody.No_closed_profiles_to_machine'
      : 'NewOperationModalBody.Go_to_the_Tool_tab_and_select_a_tool'))
    const before = useCamStore.getState().project
    fireEvent.click(button)
    expect(useCamStore.getState().project).toBe(before)
  })
})
