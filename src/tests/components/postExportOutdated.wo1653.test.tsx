// @vitest-environment jsdom
//
// WO-1653 fix round: independent audit (a29f0da54) FAILED the branch because
// `canExport` (PostProcessModal.tsx) read the LIVE, unstaged project's
// OP_OUTDATED diagnostic - an operation that is outdated only because an
// earlier one changed disabled the Export button, so the new
// stageOperationsForEmission recompute (handleExport) was unreachable by a
// real click. That is exactly the refusal rule 11 forbids: the software CAN
// recompute a merely-outdated op (it is not the same as a genuinely
// uncomputable one), so it must not refuse first.
//
// This reproduces the auditor's own repro with the same src/tests/post/
// helpers.ts fixtures: one op seeded `status: 'outdated'`, no edit machinery
// needed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { makeTool, makeOp, makeWcs, makeMachine, makeStock } from '../post/helpers'

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
    // WO-1653: the auditor's exact precondition - an op whose status is
    // 'outdated' in the live project (the audit's repro used the same
    // makeOp default, no edit or predecessor machinery required).
    const op = makeOp({ toolId: tool.id, status: 'outdated' })
    const setup = {
      id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
      stock: makeStock(), operations: [op], notes: '',
    }
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    const project = { ...s.project, name: 'TestProject', machine: makeMachine(), setups: [setup] }
    useCamStore.setState({
      project,
      toolLibrary: [tool],
      consoleEvents: [], consoleReadThroughId: 0,
    } as never)
  })
})

describe('PostProcessModal Export button (WO-1653 fix round)', () => {
  it('an outdated-only op does not disable Export - the click reaches the recompute', async () => {
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    const exportBtn = screen.getByRole('button', { name: /Export \.nc/i })

    // THE DEFECT: before the fix, canExport read the live OP_OUTDATED
    // diagnostic and this was `true` (button disabled), with tooltip "Fix
    // the errors below before exporting" - the click never happened.
    expect(exportBtn.hasAttribute('disabled')).toBe(false)
    expect(exportBtn.getAttribute('data-tooltip')).not.toBe('Fix the errors below before exporting')

    fireEvent.click(exportBtn)

    // The click is reachable: handleExport runs (stages a recompute attempt)
    // and reports through the console, rather than the button silently
    // swallowing the click by staying disabled.
    await waitFor(() => {
      const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'post')
      expect(events.length).toBeGreaterThan(0)
    })
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'post')
    expect(events[events.length - 1].message).not.toMatch(/nothing selected/i)
  })
})
