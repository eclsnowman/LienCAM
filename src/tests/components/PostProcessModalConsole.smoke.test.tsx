// @vitest-environment jsdom
//
// WO UI-11B POST lane (acceptance #1c): "post-processor generate success/
// refusal/error emits events (modal behavior unchanged - events are
// additive)". This test drives the REACHABLE outcome — Export succeeds —
// through the real modal end to end (render -> click Export -> download +
// console event), which also doubles as the AC6 render smoke for this modal.
//
// The refusal/error guards in handleExport (nothing selected / diagnostics
// contain an error / empty gcode) are defensive belt-and-suspenders code:
// canExport is recomputed from the SAME state on every render as the Export
// button's `disabled` prop, so those branches are structurally unreachable
// via a real click (a disabled <button> never dispatches its click handler —
// verified against this harness). That mirrors the existing "Unreachable...
// but never a silent no-op" ADR-0003 defensive style already used elsewhere
// in this codebase (e.g. src/store/index.ts's sketch tool-on-path guards).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { Project, Setup } from '../../types'
import {
  makeTool, makeOp, makeWcs, makeMachine, makeStock, stampGenerationCurrent,
} from '../post/helpers'

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
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  act(() => {
    useCamStore.getState().closeModal()
    const tool = makeTool()
    const op = makeOp({ toolId: tool.id }) // status:'ready' + a real toolpath move (helper default)
    const setup = {
      id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
      stock: makeStock(), operations: [op], notes: '',
    }
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    const project = { ...s.project, name: 'TestProject', machine: makeMachine(), setups: [setup] }
    // CAM-15 (52ac9e3e7): posting refuses any op whose generated inputs are not
    // fingerprint-current. Stamp against the same merged project view the modal
    // hands postProject ({ ...project, toolLibrary }).
    stampGenerationCurrent(
      { ...project, toolLibrary: [tool] } as unknown as Project,
      setup as unknown as Setup,
      op,
      tool,
    )
    useCamStore.setState({
      project,
      toolLibrary: [tool],
      consoleEvents: [], consoleReadThroughId: 0,
    } as never)
  })
})

describe('PostProcessModal console writer (POST lane)', () => {
  it('a successful Export lands exactly one success/post console event, additive to the download', async () => {
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    const exportBtn = screen.getByRole('button', { name: /Export \.nc/i })
    expect(exportBtn.hasAttribute('disabled')).toBe(false) // sanity: the real generate path is reachable

    fireEvent.click(exportBtn)

    // WO-1653: Export now stages a recompute (stageOperationsForEmission)
    // before it builds the program, so the download is no longer synchronous
    // with the click - wait for it rather than asserting immediately.
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled())

    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'post')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('success')
    expect(events[0].message).toContain('TestProject')
  })
})
