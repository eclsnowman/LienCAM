// @vitest-environment jsdom
// WO-3227 (WO-3167 Draft 2): Tool Library > Cutting Data shows the programmed cut
// of the tool's own default preset, follows the live draft, says why a result has
// no value, and changes nothing it calculates: the saved tool and the posted
// G-code are byte-identical with the calculator present.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { postProject } from '../../lib/post/postProject'
import type { Project, Setup, Tool } from '../../types'
import {
  makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent,
} from '../post/helpers'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')

const LIBRARY_ID = 'wo3227-library'

// The WO-3167 light-engagement oracle: D10 z2 n10000 vf1000 ap5 ae1 ->
// phi = acos(0.8) = 36.87 deg, hmax = 0.03 mm, hm = 0.015539989 mm, Q = 5 cm3/min.
function flatTool(overrides: Partial<Tool> = {}): Tool {
  return makeTool({
    id: 'wo3227-tool',
    name: 'WO-3227 10 mm flat',
    libraryId: LIBRARY_ID,
    type: 'flat_end_mill',
    diameter: 10,
    numberOfFlutes: 2,
    fluteLength: 25,
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 5, stepover: 1, coolant: 'flood' },
    },
    ...overrides,
  })
}

function seedTool(tool: Tool): void {
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({
      toolLibrary: [tool],
      toolLibraries: [{ id: LIBRARY_ID, name: 'WO-3227 tools' }],
      holders: [],
    })
  })
}

function openCuttingData(): void {
  act(() => { useCamStore.getState().openModal('tool-library') })
  fireEvent.click(screen.getByRole('button', { name: 'Cutting Data' }))
  expect(group(), 'Programmed cut group').not.toBeNull()
}

function group(): HTMLElement | null {
  return document.querySelector('[data-testid="programmed-cut"]')
}

function result(label: string): string {
  const g = group()
  expect(g, 'Programmed cut group').not.toBeNull()
  const row = within(g!).getByText(label).closest('.mform-row')
  return row?.querySelector('span')?.textContent ?? ''
}

function inputFor(label: string, scope: HTMLElement = document.body): HTMLInputElement {
  const row = within(scope).getByText(label).closest('.mform-row')
  const input = row?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} input not rendered`)
  return input
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
  })
}

function postSavedTool(tool: Tool): string {
  const op = makeOp({
    id: 'wo3227-op',
    name: 'WO-3227 contour',
    toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 500, role: 'cut' }),
    ],
  })
  const setup: Setup = {
    id: 'wo3227-setup', name: 'WO-3227 setup', wcs: makeWcs({ id: 'wo3227-wcs' }),
    stock: makeStock(), operations: [op], notes: '',
  }
  const current = useCamStore.getState().project
  const project: Project = {
    ...current, machine: makeMachine(), toolLibrary: [tool], geometry: [],
    setups: [setup], activeSetupId: setup.id, activeOperationId: op.id,
  }
  stampGenerationCurrent(project, setup, op, tool)
  const posted = postProject(project, [setup], UCCNC_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'wo3227', ext: 'nc',
  })
  expect(posted.ok).toBe(true)
  return posted.combined!.gcode
}

beforeEach(() => {
  mem.clear()
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-3227 Tool Library programmed cut', () => {
  it('shows engagement, max and mean chip and removal rate for the preset, with the trust sentence', () => {
    seedTool(flatTool())
    render(<ToolLibraryModal />)
    openCuttingData()

    expect(group()).not.toBeNull()
    expect(result('Engagement angle')).toBe('37°')
    expect(result('Max chip thickness')).toBe('0.0300 mm')
    expect(result('Mean chip thickness')).toBe('0.0155 mm')
    expect(result('Removal rate')).toBe('5 cm³/min')
    expect(within(group()!).getByText(
      'This estimates the programmed cut; actual engagement, tool stiffness and holding strength have not been verified.',
    )).toBeTruthy()
    // No coefficient source exists: power and torque never appear on screen.
    expect(group()!.textContent).not.toMatch(/power|torque|\bW\b|N·?\*?m/i)
    expect(group()!.textContent).not.toMatch(/the edge may rub/)
  })

  it('follows live edits of RPM, feed, depth and stepover', () => {
    seedTool(flatTool())
    render(<ToolLibraryModal />)
    openCuttingData()

    type(inputFor('Spindle speed (RPM)'), '5000')      // fz 0.1 -> hmax 0.06
    expect(result('Max chip thickness')).toBe('0.0600 mm')
    type(inputFor('Cutting feed'), '2000')              // fz 0.2 -> hmax 0.12, Q 10
    expect(result('Max chip thickness')).toBe('0.1200 mm')
    expect(result('Removal rate')).toBe('10 cm³/min')
    type(inputFor('Stepover (ae)', group()!), '10')     // full slot: phi 180, hmax = fz
    expect(result('Engagement angle')).toBe('180°')
    expect(result('Max chip thickness')).toBe('0.2000 mm')
    expect(result('Removal rate')).toBe('100 cm³/min')
    type(inputFor('Depth of cut (ap)', group()!), '2')
    expect(result('Removal rate')).toBe('40 cm³/min')
  })

  it('notes possible rubbing when the max chip is below 0.005 mm', () => {
    seedTool(flatTool())
    render(<ToolLibraryModal />)
    openCuttingData()

    type(inputFor('Cutting feed'), '160')                // fz 0.008, hmax 0.0048
    expect(result('Max chip thickness')).toBe('0.0048 mm')
    expect(group()!.textContent).toMatch(/thinner than 0\.0050 mm: the edge may rub rather than cut/)
  })

  it('says why a result has no value instead of showing NaN', () => {
    seedTool(flatTool())
    render(<ToolLibraryModal />)
    openCuttingData()

    type(inputFor('Stepover (ae)', group()!), '0')
    expect(result('Engagement angle')).toBe('— no stepover, no contact')
    expect(result('Removal rate')).toBe('0 cm³/min')
    type(inputFor('Stepover (ae)', group()!), '12')
    expect(result('Max chip thickness')).toBe('— stepover is wider than the diameter')
    expect(group()!.textContent).not.toMatch(/NaN|Infinity/)
  })

  it('a ball cutter and a depth past the flutes say the model does not apply; fields stay', () => {
    seedTool(flatTool({ type: 'ball_end_mill' }))
    render(<ToolLibraryModal />)
    openCuttingData()

    expect(within(group()!).getByText(
      'This calculator models a flat end mill cutting on its side; the model does not apply to this cutter.',
    )).toBeTruthy()
    expect(within(group()!).queryByText('Max chip thickness')).toBeNull()
    expect(inputFor('Spindle speed (RPM)').value).toBe('10000')
    cleanup()

    seedTool(flatTool())
    render(<ToolLibraryModal />)
    openCuttingData()
    type(inputFor('Depth of cut (ap)', group()!), '30')
    expect(within(group()!).getByText(
      'The depth of cut is longer than the flute length; the model does not apply.',
    )).toBeTruthy()
  })

  it('writes nothing it calculates: the saved tool and the posted G-code are unchanged', () => {
    const original = flatTool()
    seedTool(original)
    const before = postSavedTool(original)
    render(<ToolLibraryModal />)
    openCuttingData()
    expect(result('Max chip thickness')).toBe('0.0300 mm')

    // Touch an input and put it back so Save is offered; the calculator adds nothing.
    type(inputFor('Stepover (ae)', group()!), '2')
    type(inputFor('Stepover (ae)', group()!), '1')
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    const saved = useCamStore.getState().toolLibrary[0]
    expect(saved).toEqual(original)
    expect(postSavedTool(saved)).toBe(before)
  })
})
