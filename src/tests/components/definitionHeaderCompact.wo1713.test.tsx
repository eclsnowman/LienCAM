// @vitest-environment jsdom
//
// WO-1713 - the definition page header takes one line, not five.
//
// What this suite defends, matching the work order's acceptance:
//
//   1. The page renders no second element naming the selected machine - the
//      header's old repeated name badge (`machine-def-panel-machine-name`)
//      is gone. The one exception (WO-1712: a panel showing a machine
//      Control does not drive) still names both machines, in the authority
//      line - the only place that ever does.
//   2. Kind, Controller, Find any setting and Apply are all still present
//      and working - changing Kind changes the draft.
//   3. Every area tab still switches areas.
//
// Fix round (2026-09-19, Operator's phone screenshot):
//   4. The source tag is a short, COMPLETE label - never an ellipsis
//      mid-sentence - with the full, unchanged sentence on hover
//      (`data-tooltip`). The WO-1712 exception line stays a full sentence,
//      un-shrunk (covered by the exception test below, unchanged).
//   5. Kind and Controller still work (select a different value, the draft
//      changes) even though the fix round shortened the Controller
//      dropdown's own longest option label to keep the bar compact.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MachineConfig } from '../../types'

// Same in-memory localStorage shim the other machine suites use.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => [...mem.keys()][index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { requestMachineDefinitionSection } =
  await import('../../components/machine/definition/machineDefinitionSectionRequest')
const { createDefaultControllerDefinition, AXIS_NAMES } = await import('../../types')
const { DEF_GROUPS } = await import('../../components/machine/definition/DefinitionNavigation')
const { useCamStore } = await import('../../store')

function router(id: string, name: string): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES),
  }
}

/** Control drives A (project machine, no session, no explicit pick), the same
 *  resolution path WO-1712's suite seeds through. */
function seedControlDrivesA(): MachineConfig {
  const a = router('wo1713-a', 'WO-1713 Machine A')
  act(() => {
    useCamStore.setState((s) => ({
      machineLibrary: [a],
      project: { ...s.project, machine: a },
      control: { activeMachineId: null },
      consoleEvents: [],
    }))
  })
  return a
}

afterEach(() => { cleanup() })

describe('WO-1713 - the definition page header takes one line', () => {
  it('the header no longer names the machine a second time', () => {
    const a = seedControlDrivesA()
    render(<MachineDefinitionPanel />)

    expect(screen.queryByTestId('machine-def-panel-machine-name')).toBeNull()
    expect(screen.queryByText(a.name)).toBeNull()
    // The panel is still scoped to the right record - just not by a header
    // banner that repeats what the operator already picked above.
    expect(screen.getByTestId('machine-definition-panel').getAttribute('data-machine-id')).toBe(a.id)
  })

  it('a panel showing a machine Control does not drive still names both machines - the one exception', () => {
    const a = seedControlDrivesA()
    const b = router('wo1713-b', 'WO-1713 Machine B')
    act(() => { useCamStore.setState((s) => ({ machineLibrary: [...s.machineLibrary, b] })) })
    act(() => { requestMachineDefinitionSection(b.id, 'machine') })
    render(<MachineDefinitionPanel />)

    expect(screen.queryByTestId('machine-def-panel-machine-name')).toBeNull()
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent).toBe(
      `This is ${b.name} - not the machine connected now (${a.name}). `
      + `Changes are saved to ${b.name}; apply them when ${b.name} is connected.`,
    )
  })

  it('Kind, Controller, Find any setting and Apply are present and working', () => {
    seedControlDrivesA()
    render(<MachineDefinitionPanel />)

    expect(screen.getByTestId('machine-def-bar-kind')).toBeTruthy()
    expect(screen.getByTestId('machine-def-bar-controller')).toBeTruthy()
    expect(screen.getByTestId('machine-def-bar-search')).toBeTruthy()
    expect(screen.getByTestId('machine-def-bar-apply')).toBeTruthy()

    fireEvent.change(screen.getByTestId('machine-def-bar-kind'), { target: { value: 'laser' } })
    expect((screen.getByTestId('machine-def-bar-kind') as HTMLSelectElement).value).toBe('laser')
    expect(screen.getByTestId('machine-def-panel-save').getAttribute('data-save-state')).toBe('dirty')
  })

  it('every area tab still switches areas', () => {
    seedControlDrivesA()
    render(<MachineDefinitionPanel />)

    // WO-1757: the Legacy tab is gone; the seven permanent areas in
    // DEF_GROUPS (Overview .. All settings) are the whole tab row.
    for (const [key] of DEF_GROUPS) {
      fireEvent.click(screen.getByTestId(`machine-def-tab-${key}`))
      expect(screen.getByTestId(`machine-def-tab-${key}`).getAttribute('aria-selected')).toBe('true')
    }

    // Spot check real content swapped, not only the tab's own selected state.
    fireEvent.click(screen.getByTestId('machine-def-tab-overview'))
    expect(screen.getByTestId('machine-def-overview')).toBeTruthy()
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))
    expect(screen.getByTestId('machine-def-group-machine')).toBeTruthy()
  })

  // ---- Fix round: Operator's phone screenshot, 2026-09-19 -----------------------
  // "Saved profile. It becomes runtime auth..." - a sentence cut off with an
  // ellipsis. The tag must never do that again: short and COMPLETE, with the
  // unchanged full sentence reachable on hover.
  it('the source tag is short and complete, never an ellipsis, with the full sentence on hover', () => {
    seedControlDrivesA()
    render(<MachineDefinitionPanel />)

    const tag = screen.getByTestId('machine-def-panel-authority-status')
    expect(tag.className).toContain('machine-def-authority-tag')
    // Short and COMPLETE: a whole label, not a fragment of the sentence.
    expect(tag.textContent).toBe('Saved profile')
    expect(tag.textContent).not.toMatch(/\.\.\.|…/)
    // The full sentence is unchanged and still reachable, on hover.
    expect(tag.getAttribute('data-tooltip')).toBe(
      'Saved profile. It becomes runtime authority when this machine connects.',
    )
  })

  it('the WO-1712 exception line is never shrunk to a tag - it keeps the full sentence, visibly, not just on hover', () => {
    const a = seedControlDrivesA()
    const b = router('wo1713-b2', 'WO-1713 Machine B2')
    act(() => { useCamStore.setState((s) => ({ machineLibrary: [...s.machineLibrary, b] })) })
    act(() => { requestMachineDefinitionSection(b.id, 'machine') })
    render(<MachineDefinitionPanel />)

    const line = screen.getByTestId('machine-def-panel-authority-status')
    expect(line.className).toContain('machine-def-authority-line')
    expect(line.className).not.toContain('machine-def-authority-tag')
    // Visible text IS the full sentence - not a tooltip-only fallback.
    expect(line.textContent).toBe(
      `This is ${b.name} - not the machine connected now (${a.name}). `
      + `Changes are saved to ${b.name}; apply them when ${b.name} is connected.`,
    )
    expect(line.getAttribute('data-tooltip')).toBeNull()
  })

  it('Kind and Controller keep working after the fix round shortened the Controller dropdown\'s longest option', () => {
    seedControlDrivesA()
    render(<MachineDefinitionPanel />)

    const controller = screen.getByTestId('machine-def-bar-controller') as HTMLSelectElement
    // The option this fix round shortened for display (base.ts's
    // "Generic (linear only)", 21 characters - what forced Kind onto its
    // own line, away from Controller, on a phone). The VALUE is untouched;
    // only the option's own rendered text changed.
    const generic = [...controller.options].find((o) => o.value === 'generic')
    expect(generic).toBeTruthy()
    expect(generic!.textContent).toBe('Generic')

    fireEvent.change(controller, { target: { value: 'generic' } })
    expect(controller.value).toBe('generic')
    expect(screen.getByTestId('machine-def-panel-save').getAttribute('data-save-state')).toBe('dirty')
  })
})
