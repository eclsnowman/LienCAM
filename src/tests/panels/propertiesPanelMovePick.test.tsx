// @vitest-environment jsdom
//
// PP-MOVE-PICK (workplan row 17): render-gate + interaction tests for the
// MoveProperties Properties-panel branch shown when a toolpath MOVE/SEGMENT is
// picked in the viewport (viewer.selectedMove). Store-level exclusion coverage
// lives in src/tests/store/selectedMove.test.ts; the segment->facts resolution
// in src/tests/cam/toolpathSegments.test.ts. This file covers:
//  - the panel renders the picked move's facts (index, role, start/end, length,
//    feed rate + SOURCE, est. duration, owning operation);
//  - the feed SOURCE precedence (baked feed / by-role / rapid), via the exported
//    pure resolveMoveFeed and via the rendered value;
//  - "Go to operation" activates the owning op (which clears the move), so the
//    panel swaps back off MoveProperties — the render-gate (hooks-order) proof.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { Operation, Setup, Tool, SelectedMove } from '../../types'

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

const { PropertiesPanel, resolveMoveFeed } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

function seedOpAndTool() {
  const tool = {
    id: 't1', name: 'EM6', type: 'endmill',
    feedsAndSpeeds: { default: { feedRate: 1000, plungeRate: 300 } },
  } as unknown as Tool
  const op = {
    id: 'op1', name: 'Finish contour', type: 'contour_2d', toolId: 't1',
    params: {}, status: 'ready',
  } as unknown as Operation
  const setup = { id: 's1', name: 'Setup 1', operations: [op] } as unknown as Setup
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({
      toolLibrary: [tool],
      project: {
        ...s.project,
        setups: [setup],
        machine: { ...s.project.machine, rapidRate: 5000 },
      },
    }))
  })
}

function move(over: Partial<SelectedMove> = {}): SelectedMove {
  return {
    operationId: 'op1', moveIndex: 4, moveCount: 20,
    moveType: 'feed', role: 'cut',
    from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, lengthMm: 10,
    feed: 800, ...over,
  }
}

describe('MoveProperties render branch', () => {
  beforeEach(seedOpAndTool)

  it('renders the picked move facts: index, role, coords, length, feed source, op', () => {
    act(() => { useCamStore.getState().setSelectedMove(move()) })
    render(<PropertiesPanel />)

    expect(screen.getByTestId('move-properties')).toBeTruthy()
    expect(screen.getByTestId('move-properties').textContent).toContain('Move 5 of 20')
    expect(screen.getByTestId('move-role').textContent).toContain('Cut')
    expect(screen.getByTestId('move-length').textContent).toMatch(/10/)
    // baked feed source, with the value
    const feedText = screen.getByTestId('move-feed').textContent ?? ''
    expect(feedText).toContain('Baked feed')
    expect(feedText).toMatch(/800/)
    // est. duration resolves (10 mm @ 800 mm/min = 0.75 s), not the em-dash
    expect(screen.getByTestId('move-duration').textContent).not.toBe('--')
    // owning operation + jump affordance
    expect(screen.getByTestId('move-properties').textContent).toContain('Finish contour')
    expect(screen.getByTestId('move-goto-op-btn')).toBeTruthy()
  })

  it('a rapid move shows the machine-traverse source; an arc keeps its arc type', () => {
    act(() => { useCamStore.getState().setSelectedMove(move({ moveType: 'rapid', role: 'rapid', feed: undefined })) })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('move-role').textContent).toContain('Rapid')
    expect(screen.getByTestId('move-feed').textContent).toContain('Rapid (machine traverse)')
    cleanup()

    act(() => { useCamStore.getState().setSelectedMove(move({ moveType: 'arc_cw', role: 'cut' })) })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('move-role').textContent).toContain('arc CW')
  })

  it('"Go to operation" activates the owning op AND clears the move (panel swaps)', () => {
    act(() => { useCamStore.getState().setSelectedMove(move()) })
    const { queryByTestId } = render(<PropertiesPanel />)
    expect(queryByTestId('move-properties')).toBeTruthy()

    act(() => { fireEvent.click(screen.getByTestId('move-goto-op-btn')) })

    expect(useCamStore.getState().project.activeOperationId).toBe('op1')
    expect(useCamStore.getState().viewer.selectedMove).toBeNull()
    // The panel is no longer on MoveProperties (render-gate: no hooks-order crash
    // when the branch changes under it).
    expect(queryByTestId('move-properties')).toBeNull()
  })
})

describe('resolveMoveFeed — source precedence (pure)', () => {
  const tool = {
    id: 't1', name: 'EM', type: 'endmill',
    feedsAndSpeeds: { default: { feedRate: 1000, plungeRate: 300 } },
  } as unknown as Tool
  const op = { id: 'op1', name: 'Op', type: 'contour_2d', toolId: 't1', params: {} } as unknown as Operation

  it('rapid -> machine rapid rate', () => {
    expect(resolveMoveFeed(move({ moveType: 'rapid', role: 'rapid', feed: undefined }), op, tool, 5000))
      .toEqual({ rate: 5000, source: 'Rapid (machine traverse)' })
  })
  it('fast_traverse -> by-role fast traverse', () => {
    const r = resolveMoveFeed(move({ role: 'fast_traverse', feed: undefined }), op, tool, 5000)
    expect(r?.source).toBe('By role: fast traverse')
  })
  it('finish -> by-role finish', () => {
    const r = resolveMoveFeed(move({ role: 'finish', feed: undefined }), op, tool, 5000)
    expect(r?.source).toBe('By role: finish')
  })
  it('ordinary cut -> baked feed on the move', () => {
    expect(resolveMoveFeed(move({ role: 'cut', feed: 640 }), op, tool, 5000))
      .toEqual({ rate: 640, source: 'Baked feed' })
  })
  it('a feedless non-rapid cut refuses (null) rather than guessing', () => {
    expect(resolveMoveFeed(move({ role: 'cut', feed: undefined }), op, tool, 5000)).toBeNull()
  })
})
