// @vitest-environment jsdom
//
// WO-2464 - Control's Load reads a file's comments the way the ACTIVE controller does.
//
// Through the production path: the Control file input of the rendered ProgramPanel
// receives a File, and the lint pass it runs is observed at lintGcode (the panel keeps
// the findings in `meta`; the spy is the only seam that shows which comment style was
// handed to it). The real lintGcode still runs, so the findings are asserted too.
//
// NOT CLAIMED: hardware. Nothing here touches a board.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

const lintCalls: Array<{ style: string | undefined; codes: string[] }> = []
vi.mock('../../lib/gcode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/gcode')>()
  return typedMock<typeof import('../../lib/gcode')>({
    ...real,
    lintGcode: (text: string, opts: Parameters<typeof real.lintGcode>[1]) => {
      const findings = real.lintGcode(text, opts)
      lintCalls.push({ style: opts?.commentStyle, codes: findings.map((f) => f.code) })
      return findings
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { connectMachine, disconnectMachine } = await import('../../lib/machine/machineSession')

const SEMICOLON_PROGRAM = ['G21 G90 G54 ; units', 'G0 Z5', 'G0 X0 Y0 ; start', 'M30'].join('\n')

async function loadThroughControl(controller: 'grbl' | 'uccnc' | 'linuxcnc'): Promise<void> {
  const machine = useCamStore.getState().project.machine
  act(() => {
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: `wo2464-${controller}`,
      name: `WO-2464 ${controller}`,
      controller,
      controllerDefinition: undefined,
      unsentSettings: undefined,
    })
  })
  // The session pins the machine it connects under, so connect AFTER choosing it.
  await connectMachine('simulator', 115200)
  lintCalls.length = 0
  render(<ProgramPanel />)
  const input = screen.getByTestId('control-file-input') as HTMLInputElement
  const file = new File([SEMICOLON_PROGRAM], 'semi.nc', { type: 'text/plain' })
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
  await waitFor(() => expect(lintCalls.length).toBeGreaterThan(0))
}

describe('WO-2464: Control Load comment style follows the active controller', () => {
  afterEach(async () => {
    cleanup()
    await disconnectMachine()
  })

  it('LinuxCNC machine: semicolon comments are valid, no comment-style finding', async () => {
    await loadThroughControl('linuxcnc')
    const last = lintCalls[lintCalls.length - 1]
    expect(last.style).toBe('semicolon')
    expect(last.codes).not.toContain('WRONG_COMMENT_STYLE')
    // The session's own readiness check lints the same Load: every call must read semicolons.
    expect(lintCalls.every((c) => c.style === 'semicolon')).toBe(true)
    expect(useMachineControl.getState().programReadiness.reason).not.toMatch(/Semicolon comment/)
  })

  it('GRBL machine keeps today\'s finding', async () => {
    await loadThroughControl('grbl')
    const last = lintCalls[lintCalls.length - 1]
    expect(last.style).toBe('paren')
    expect(last.codes).toContain('WRONG_COMMENT_STYLE')
  })

  it('UCCNC machine keeps today\'s finding', async () => {
    await loadThroughControl('uccnc')
    const last = lintCalls[lintCalls.length - 1]
    expect(last.style).toBe('paren')
    expect(last.codes).toContain('WRONG_COMMENT_STYLE')
  })
})
