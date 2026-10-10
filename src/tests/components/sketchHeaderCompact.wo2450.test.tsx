// @vitest-environment jsdom
//
// WO-2450: sketch session header reads Finish / Cancel in both hosts; the
// "Not solved" chip stays but keeps a clear gap after the SKETCH title; Model
// Undo / Redo ride in the Finish / Cancel row (no HISTORY section).

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { Redo2, Undo2 } from 'lucide-react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox')
const { useCamStore } = await import('../../store')
const { createBlankSketch } = await import('../../lib/sketch/blankSketch')
const { WorkbenchToolRail } = await import('../../components/model3d/workbench/WorkbenchToolRail')

const appCss = readFileSync('src/styles/app.css', 'utf8')
const noop = () => {}

afterEach(() => cleanup())

describe('WO-2450 sketch header', () => {
  it('CAM host: Finish and Cancel buttons are the first actions, Not solved chip kept', () => {
    act(() => {
      useCamStore.setState({
        activeSketch: createBlankSketch('layer-wo2450', () => 'wo2450'),
        sketchSolveStatus: null,
      })
    })
    const { container } = render(<SketchToolbox />)
    const sticky = container.querySelector('.sketch-finish-sticky') as HTMLElement
    expect(sticky).not.toBeNull()
    expect(within(sticky).getByRole('button', { name: 'Finish' })).toBeTruthy()
    expect(within(sticky).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByTestId('cam-sketch-dof-chip').textContent).toContain('Not solved')
  })

  it('Model host: Finish and Cancel buttons are the first actions', () => {
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={[]}
        sketchHistoryTools={[]}
        onFinishSketch={noop}
        onCancelSketch={noop}
      />,
    )
    const toolbar = screen.getByTestId('workbench-package-sketch-toolbar')
    expect(within(toolbar).getByRole('button', { name: 'Finish' })).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('Model host: Undo / Redo are icon buttons in the Finish / Cancel row, no HISTORY section', () => {
    const calls: string[] = []
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={[]}
        sketchHistoryTools={[
          { testId: 'workbench-undo', label: 'Undo', icon: Undo2, onClick: () => calls.push('undo') },
          { testId: 'workbench-redo', label: 'Redo', icon: Redo2, disabled: true, onClick: () => calls.push('redo') },
        ]}
        onFinishSketch={noop}
        onCancelSketch={noop}
      />,
    )
    const row = screen.getByTestId('workbench-package-sketch-toolbar').querySelector('.sketch-session-actions') as HTMLElement
    const undo = within(row).getByTestId('workbench-undo') as HTMLButtonElement
    const redo = within(row).getByTestId('workbench-redo') as HTMLButtonElement
    expect(undo.getAttribute('data-tooltip')).toBe('Undo')
    expect(redo.getAttribute('data-tooltip')).toBe('Redo')
    expect(redo.disabled).toBe(true)
    fireEvent.click(undo)
    expect(calls).toEqual(['undo'])
    expect(screen.queryByTestId('workbench-rail-section-history')).toBeNull()
  })

  it('the chip has its own gap after the SKETCH title', () => {
    expect(appCss).toMatch(/\.panel-header > \.sketch-def-chip\s*\{[^}]*margin:\s*0 auto 0 10px;/s)
  })

  it('buttons use the compact modal-btn padding', () => {
    expect(appCss).toMatch(/\.sketch-session-actions-compact \.sketch-finish-btn,\s*\.sketch-session-actions-compact \.sketch-cancel-btn\s*\{[^}]*padding:\s*6px 8px;/s)
    // block-edit banner shares the base classes and must keep main's size
    expect(appCss).toMatch(/^\.sketch-finish-btn\s*\{[^}]*padding:\s*8px 12px;/ms)
    expect(appCss).toMatch(/^\.sketch-cancel-btn\s*\{[^}]*padding:\s*8px 12px;/ms)
  })
})
