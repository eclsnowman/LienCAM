// @vitest-environment jsdom
//
// OP-TOOL-FILTER regression tests: the Tool tab filter bar (Operator's ask, his
// annotated screenshot at coordination/evidence/OP-TOOL-FILTER/operator-finding.png
// — "put a filter on the top for quick access of tools from long lists...
// organize by Tool libraries, and also for speed tools already used in the
// project"). Covers: text search narrowing, the "used in project" toggle
// (derived from every operation's toolId across the WHOLE project, not just
// the active setup), the library facet (this project DOES have a
// multi-library concept — Tool.libraryId / ToolLibrary — confirmed by
// recon of src/types/index.ts + ToolLibraryModal.tsx), filters composing
// (AND), the empty-result state, and that BOTH the New and Edit Operation
// paths share the same filtered list (one shared tab==='tool' block).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Same in-memory shim every other
// NewOperationModal render test in this suite uses.
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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const SETUP_ID = 'setup-tf'

function blankFeeds() {
  return {
    default: {
      rpm: 12000, feedRate: 1000, plungeRate: 300, depthOfCut: 1,
      stepover: 2, rampFeedrate: 500, leadInFeedrate: 1000, leadOutFeedrate: 1000,
      fastTraverseFeedrate: 2500, rampAngle: 2, coolant: 'none',
    },
  }
}

function tool(overrides: Record<string, unknown>) {
  return {
    id: overrides.id as string,
    name: overrides.name as string,
    type: (overrides.type as string) ?? 'flat_end_mill',
    diameter: (overrides.diameter as number) ?? 6,
    shankDiameter: 6, overallLength: 50, fluteLength: 18,
    numberOfFlutes: 2, material: 'carbide', coating: 'none',
    cutHand: 'right', notes: '', feedsAndSpeeds: blankFeeds(),
    ...overrides,
  }
}

// Two libraries ("Metric" / "Imperial"), 3 tools spread across them, and one
// existing operation on a THIRD setup (not the active one) referencing
// tool-b — proves "used in project" is project-wide, not setup-scoped.
function seedProjectWithToolsAndLibraries() {
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const usedOp = {
    id: 'op-used', name: 'Op used', type: 'contour_2d', geometryId: null, toolId: 'tool-b',
    heights: { topOfPartZ: 0, safeZ: 25, retractZ: 5, targetZ: -1, plungeType: 'ramp' },
    passes: { finishPasses: 1, springPasses: 0, stockToLeave: 0, overlapMm: 0 },
    linking: { entryType: 'ramp', exitType: 'lift', stayDown: false },
    params: {}, status: 'pending', toolpathMoves: undefined, computeTimeMs: undefined,
  }
  const otherSetup = { id: 'setup-other', name: 'Setup 0', wcs, stock: null, operations: [usedOp], notes: '' }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }

  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry: [], setups: [otherSetup, setup], activeSetupId: SETUP_ID },
      toolLibraries: [{ id: 'lib-metric', name: 'Metric' }, { id: 'lib-imperial', name: 'Imperial' }],
      toolLibrary: [
        tool({ id: 'tool-a', name: 'Alpha Flat 6mm', diameter: 6, type: 'flat_end_mill', toolNumber: 1, libraryId: 'lib-metric' }),
        tool({ id: 'tool-b', name: 'Bravo Ball 3mm', diameter: 3, type: 'ball_end_mill', toolNumber: 2, libraryId: 'lib-metric' }),
        tool({ id: 'tool-c', name: 'Charlie Vbit', diameter: 6.35, type: 'v_bit', toolNumber: 3, libraryId: 'lib-imperial' }),
      ],
    } as never)
  })
}

function openOnTool() {
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Tool'))
}

function toolRowNames(): string[] {
  return Array.from(document.querySelectorAll('.op-tool-row .op-tool-name')).map(el => el.textContent ?? '')
}

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('OP-TOOL-FILTER: NewOperationModal Tool tab filter bar', () => {
  it('renders the filter bar and the full unfiltered list at rest', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    expect(screen.getByTestId('op-tool-filter-bar')).not.toBeNull()
    expect(toolRowNames()).toEqual(['Alpha Flat 6mm', 'Bravo Ball 3mm', 'Charlie Vbit'])
  })

  it('text search narrows by name', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: 'bravo' } })
    expect(toolRowNames()).toEqual(['Bravo Ball 3mm'])
  })

  it('text search narrows by diameter', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: '6.35' } })
    expect(toolRowNames()).toEqual(['Charlie Vbit'])
  })

  it('text search narrows by type', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: 'ball' } })
    expect(toolRowNames()).toEqual(['Bravo Ball 3mm'])
  })

  it('"Used in project" toggle shows only tools referenced by an operation ANYWHERE in the project (project-wide, not setup-scoped)', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    // Precondition: the active setup (setup-tf) has NO operations of its own;
    // the only reference is on a DIFFERENT setup (setup-other).
    const toggle = screen.getByTestId('op-tool-filter-used-toggle')
    expect(toggle.textContent).toContain('(1)')

    fireEvent.click(toggle)
    expect(toolRowNames()).toEqual(['Bravo Ball 3mm'])
    expect(toggle.className).toContain('op-toggle-active')

    fireEvent.click(toggle)
    expect(toolRowNames()).toEqual(['Alpha Flat 6mm', 'Bravo Ball 3mm', 'Charlie Vbit'])
  })

  it('library facet filters to the selected library', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    const select = screen.getByTestId('op-tool-filter-library') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'lib-imperial' } })
    expect(toolRowNames()).toEqual(['Charlie Vbit'])

    fireEvent.change(select, { target: { value: 'lib-metric' } })
    expect(toolRowNames()).toEqual(['Alpha Flat 6mm', 'Bravo Ball 3mm'])

    fireEvent.change(select, { target: { value: 'all' } })
    expect(toolRowNames()).toEqual(['Alpha Flat 6mm', 'Bravo Ball 3mm', 'Charlie Vbit'])
  })

  it('filters compose: search + used-in-project + library facet all apply together (AND)', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    fireEvent.change(screen.getByTestId('op-tool-filter-library'), { target: { value: 'lib-metric' } })
    fireEvent.click(screen.getByTestId('op-tool-filter-used-toggle'))
    // Alpha is in lib-metric but NOT used -> excluded by the used toggle.
    expect(toolRowNames()).toEqual(['Bravo Ball 3mm'])

    // Narrow further by search text that does NOT match Bravo -> empty.
    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: 'alpha' } })
    expect(toolRowNames()).toEqual([])
  })

  it('empty-result state uses the wizard\'s .op-no-tool-notice idiom and Clear restores the list', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: 'zzz-no-match' } })
    const empty = screen.getByTestId('op-tool-filter-empty')
    expect(empty.className).toContain('op-no-tool-notice')
    expect(screen.queryByText('Alpha Flat 6mm')).toBeNull()

    fireEvent.click(screen.getByText('Clear'))
    expect(toolRowNames()).toEqual(['Alpha Flat 6mm', 'Bravo Ball 3mm', 'Charlie Vbit'])
  })

  it('filter state resets on modal close -> reopen (no persistence across opens)', () => {
    seedProjectWithToolsAndLibraries()
    render(<NewOperationModal />)
    openOnTool()

    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: 'bravo' } })
    expect(toolRowNames()).toEqual(['Bravo Ball 3mm'])

    act(() => { useCamStore.getState().closeModal() })
    openOnTool()
    expect((screen.getByTestId('op-tool-filter-search') as HTMLInputElement).value).toBe('')
    expect(toolRowNames()).toEqual(['Alpha Flat 6mm', 'Bravo Ball 3mm', 'Charlie Vbit'])
  })

  it('the Edit Operation path shares the SAME filtered Tool tab (filter bar present, search narrows)', () => {
    seedProjectWithToolsAndLibraries()
    // Add an operation to the ACTIVE setup so edit mode has something to open.
    act(() => {
      const s = useCamStore.getState() as unknown as { project: { setups: Array<{ id: string; operations: unknown[] }> } }
      const editOp = {
        id: 'op-edit', name: 'Op edit', type: 'contour_2d', geometryId: null, toolId: 'tool-a',
        heights: { topOfPartZ: 0, safeZ: 25, retractZ: 5, targetZ: -1, plungeType: 'ramp' },
        passes: { finishPasses: 1, springPasses: 0, stockToLeave: 0, overlapMm: 0 },
        linking: { entryType: 'ramp', exitType: 'lift', stayDown: false },
        params: {}, status: 'pending', toolpathMoves: undefined, computeTimeMs: undefined,
      }
      useCamStore.setState({
        project: {
          ...s.project,
          setups: s.project.setups.map(su => su.id === SETUP_ID ? { ...su, operations: [editOp] } : su),
        },
      } as never)
    })

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-edit') })
    fireEvent.click(screen.getByText('Tool'))

    expect(screen.getByTestId('op-tool-filter-bar')).not.toBeNull()
    fireEvent.change(screen.getByTestId('op-tool-filter-search'), { target: { value: 'charlie' } })
    expect(toolRowNames()).toEqual(['Charlie Vbit'])
  })
})
