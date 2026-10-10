// @vitest-environment jsdom
//
// React-render SMOKE test for NestModal. The repo's vitest env is 'node' by
// default (see vite.config.ts); the directive above flips THIS file to jsdom so
// a real React tree can mount. jsdom is already a devDependency.
//
// WHY THIS EXISTS: a hooks-order bug shipped in NestModal — a useEffect was
// placed AFTER `if (!isOpen) return null`, so the closed->open transition tried
// to run one more hook than the previous (closed) render and React threw
// "Rendered more hooks than during the previous render." tsc and the pure-logic
// vitest suite did NOT catch it because there was no React render test. Test B
// below mounts the modal closed, then opens it, which is exactly that
// transition: if the timer effect ever moves back below the early return, React
// throws during the openModal act() and Test B fails. That is the regression
// guard we want.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags
// (`storage.setItem is not a function` — see the `--localstorage-file` warning),
// and the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store so its persist
// middleware has a working backend. Pure test scaffolding; no app change.
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

const { NestModal } = await import('../../components/modals/NestModal')
const { useCamStore } = await import('../../store')
const realCreateNest = useCamStore.getState().createNest
type CreateNestParams = Parameters<typeof realCreateNest>[0]

function nestableGeometry(id: string): ImportedGeometry {
  return {
    id,
    name: 'Keyboard Part',
    type: 'curves_2d',
    format: 'svg',
    loaded: true,
    loops: [{
      id: `${id}-outer`,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }],
      closed: true,
      type: 'contour',
      layerId: `${id}-layer`,
      area: 100,
    }],
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 0 },
    },
  } as ImportedGeometry
}

function installCreateNestResult(status: 'computing' | 'ready') {
  const createNest = vi.fn((params: CreateNestParams) => {
    const id = `nest-keyflow-${status}`
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [...(s.project.nests ?? []), {
          id,
          name: `Keyboard ${status} nest`,
          sheet: { ...params.sheet },
          style: params.style,
          spacing: { ...params.spacing },
          seed: params.seed,
          solver: params.solver,
          rotationCount: params.rotationCount,
          sources: params.sources.map((source) => ({ ...source })),
          placements: [],
          unplaced: [],
          utilization: 0,
          status,
          thickness: params.thickness,
          machiningOrder: params.machiningOrder,
        }],
      },
    }))
    return id
  })
  useCamStore.setState({ createNest })
  return createNest
}

afterEach(() => {
  cleanup()
  useCamStore.setState({ createNest: realCreateNest })
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

// The store is a process singleton; force activeModal closed before each test so
// the tests are order-independent (Test B opens it; without this reset a later
// test could inherit the open state).
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ createNest: realCreateNest })
    useCamStore.getState().closeModal()
  })
})

describe('NestModal render smoke', () => {
  it('mounts closed without crashing', () => {
    // activeModal is null (beforeEach). The modal self-gates on
    // activeModal === 'new-nest' and returns null, so nothing renders.
    render(<NestModal />)
    expect(screen.queryByText('New Nest')).toBeNull()
  })

  it('opens without a hooks-order crash', () => {
    // Mount CLOSED first so the open is a true closed->open hook transition (the
    // exact path that threw before the fix), not a first-render-already-open.
    render(<NestModal />)
    expect(screen.queryByText('New Nest')).toBeNull()

    // Flip the singleton store open. If a hook sits below `if (!isOpen) return
    // null`, React throws "Rendered more hooks than during the previous render"
    // synchronously inside this act() and the test fails — the regression guard.
    act(() => {
      useCamStore.getState().openModal('new-nest')
    })

    // The header title proves the modal body rendered (the fixed code reaches
    // the JSX with all hooks called in a stable order). getByText throws if it
    // is absent, so a non-null return is sufficient — no jest-dom matchers
    // needed (kept off the dep list deliberately).
    expect(screen.getByText('New Nest')).not.toBeNull()

    // Item 3: the Thickness (Z) field must render whenever the modal is open
    // (every 2D part needs a cut depth; shown regardless of solver mode).
    expect(screen.getByText('Thickness (Z)')).not.toBeNull()

    // P7 ("many paths to same result"): the Cut order selector must render at
    // creation time too (the same field the Properties panel edits) and default
    // to 'by-operation' on a fresh open.
    const cutOrder = screen.getByTestId('nest-modal-machining-order') as HTMLSelectElement
    expect(cutOrder).not.toBeNull()
    expect(cutOrder.value).toBe('by-operation')

    // Flip back closed: it must unmount cleanly (no leftover modal title).
    act(() => {
      useCamStore.getState().closeModal()
    })
    expect(screen.queryByText('New Nest')).toBeNull()
  })

  it('Cut order selector is interactive (by-operation -> by-part)', () => {
    // The control writes machiningOrder state; the created nest then carries it
    // (mirrors the Thickness path). Asserting the created NestRecord would need
    // packable geometry + a worker, which the node/jsdom harness lacks; proving
    // the selector toggles its bound state is the render-level guard we want.
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })
    const cutOrder = screen.getByTestId('nest-modal-machining-order') as HTMLSelectElement
    expect(cutOrder.value).toBe('by-operation')
    act(() => { fireEvent.change(cutOrder, { target: { value: 'by-part' } }) })
    expect((screen.getByTestId('nest-modal-machining-order') as HTMLSelectElement).value).toBe('by-part')
    act(() => { useCamStore.getState().closeModal() })
  })

  it('re-opens cleanly after the provenance state was added (open effect runs twice)', () => {
    // Guards the new `ownedIds` state + its resets in the closed->open effect: a
    // second closed->open->closed cycle must not throw (the open effect calls
    // setOwnedIds; if that were placed below the early return it would crash on the
    // transition like the original timer-effect bug).
    render(<NestModal />)
    for (let i = 0; i < 2; i++) {
      act(() => { useCamStore.getState().openModal('new-nest') })
      expect(screen.getByText('New Nest')).not.toBeNull()
      act(() => { useCamStore.getState().closeModal() })
      expect(screen.queryByText('New Nest')).toBeNull()
    }
  })

  it('commits a numeric draft into the same Enter Calculate action', async () => {
    const createNest = vi.fn((_params: Parameters<typeof realCreateNest>[0]) => 'nest-keyflow')
    act(() => {
      useCamStore.setState((s) => ({
        createNest,
        project: { ...s.project, geometry: [nestableGeometry('keyboard-part')] },
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    fireEvent.click(screen.getByTestId('nest-part-check-keyboard-part'))
    const widthRow = screen.getByText('Sheet width').closest('.mform-row')
    const width = widthRow?.querySelector('input') as HTMLInputElement
    fireEvent.focus(width)
    fireEvent.change(width, { target: { value: '425' } })
    fireEvent.keyDown(width, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(createNest).toHaveBeenCalledTimes(1))
    expect(createNest.mock.calls[0]![0].sheet.width).toBe(425)
  })

  it('routes Enter to Accept exactly once when the provisional nest is ready', async () => {
    const createNest = installCreateNestResult('ready')
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestableGeometry('keyboard-part')] },
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    fireEvent.click(screen.getByTestId('nest-part-check-keyboard-part'))
    const widthRow = screen.getByText('Sheet width').closest('.mform-row')
    fireEvent.keyDown(widthRow?.querySelector('input') as HTMLInputElement, {
      key: 'Enter',
      code: 'Enter',
    })
    await waitFor(() => {
      expect(createNest).toHaveBeenCalledTimes(1)
      expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false)
    })

    const readyWidthRow = screen.getByText('Sheet width').closest('.mform-row')
    fireEvent.keyDown(readyWidthRow?.querySelector('input') as HTMLInputElement, {
      key: 'Enter',
      code: 'Enter',
    })

    await waitFor(() => expect(useCamStore.getState().activeModal).toBeNull())
    expect(createNest).toHaveBeenCalledTimes(1)
    expect(useCamStore.getState().project.nests?.[0]?.status).toBe('ready')
  })

  it('leaves Enter inert while packing is pending', async () => {
    const createNest = installCreateNestResult('computing')
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestableGeometry('keyboard-part')] },
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    fireEvent.click(screen.getByTestId('nest-part-check-keyboard-part'))
    const widthRow = screen.getByText('Sheet width').closest('.mform-row')
    fireEvent.keyDown(widthRow?.querySelector('input') as HTMLInputElement, {
      key: 'Enter',
      code: 'Enter',
    })
    await waitFor(() => {
      expect(createNest).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/Packing/)).not.toBeNull()
    })

    const packingWidthRow = screen.getByText('Sheet width').closest('.mform-row')
    fireEvent.keyDown(packingWidthRow?.querySelector('input') as HTMLInputElement, {
      key: 'Enter',
      code: 'Enter',
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(createNest).toHaveBeenCalledTimes(1)
    expect(useCamStore.getState().activeModal).toBe('new-nest')
  })

  it('leaves Enter inert while Calculate is disabled', async () => {
    const createNest = vi.fn(() => 'nest-keyflow')
    act(() => { useCamStore.setState({ createNest }) })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    const ordinaryInput = document.createElement('input')
    ordinaryInput.type = 'text'
    screen.getByTestId('nest-modal-panel').append(ordinaryInput)
    fireEvent.keyDown(ordinaryInput, { key: 'Enter', code: 'Enter' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(createNest).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModal).toBe('new-nest')
  })

  it('does not submit from multiline and disabled children on Enter', () => {
    const createNest = vi.fn(() => 'nest-keyflow')
    act(() => { useCamStore.setState({ createNest }) })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    const panel = screen.getByTestId('nest-modal-panel')
    const textarea = document.createElement('textarea')
    const disabledInput = document.createElement('input')
    disabledInput.type = 'text'
    disabledInput.disabled = true
    panel.append(textarea, disabledInput)

    for (const target of [textarea, disabledInput]) {
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
    }
    expect(createNest).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModal).toBe('new-nest')
  })

  it('routes unconsumed Escape from a multiline child through Cancel', () => {
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    const textarea = document.createElement('textarea')
    screen.getByTestId('nest-modal-panel').append(textarea)
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })

    expect(useCamStore.getState().activeModal).toBeNull()
  })

  it('uses Escape to cancel the nested part picker before closing the modal', async () => {
    let partPicker: ((id: string) => void) | null = null
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setPartPickMode: (callback: ((id: string) => void) | null) => { partPicker = callback },
      setPartPickSelection: vi.fn(),
    }
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestableGeometry('keyboard-part')] },
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })
    await waitFor(() => expect(screen.getByTestId('nest-part-pick-banner')).not.toBeNull())
    expect(partPicker).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('nest-part-pick-banner')).toBeNull()
    expect(screen.getByTestId('nest-modal-panel')).not.toBeNull()
    expect(useCamStore.getState().activeModal).toBe('new-nest')

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(useCamStore.getState().activeModal).toBeNull()
  })
})

// NEST-MODAL-SPACING-VET: EDIT mode against a nest record with an incomplete
// spacing/sheet must not crash. Before the fix, NestModal's edit-open effect
// read `target.spacing`/`target.sheet` straight off the stored NestRecord with
// no fallback and fed the result directly into NumericInput's `value` prop;
// NumericInput.formatNum calls `value.toFixed(10)` unconditionally, so a
// missing field throws the instant Edit opens (confirmed via a hand-seeded
// capture fixture, coordination/reports/PP-UTILITY-S2.report.md). A REAL
// project can reach this shape via the load boundary (a hand-edited/legacy
// .camproject, or any nests[] entry not written by this modal) -- see
// projectMigration.test.ts's "NEST-MODAL-SPACING-VET" describe block for the
// load-side fix (normalizeNestRecords). This test proves the MODAL's own
// defense-in-depth: it must stay total for an in-memory record too (e.g. one
// seeded directly by a test/capture harness, which bypasses migration).
describe('NEST-MODAL-SPACING-VET: EDIT mode survives an incomplete nest record', () => {
  // Deliberately loose (no NestRecord type annotation): `sheet` is OMITTED
  // ENTIRELY (a pre-P1.0-shape / hand-edited-file case) and `spacing` is
  // missing `windowGap` -- the exact shape the PP-UTILITY-S2 capture fixture
  // crashed on before it was hand-patched (never fixed at source, see
  // coordination/reports/PP-UTILITY-S2.report.md).
  const INCOMPLETE_NEST = {
    id: 'nest-incomplete',
    name: 'Legacy Nest',
    style: 'ninety',
    seed: 1,
    spacing: { partGap: 4, sheetMargin: 6 },
    sources: [],
    placements: [],
    unplaced: [],
    utilization: 0,
    visible: true,
  }

  // Reads the numeric input bound to a given `.mform-row` label's field.
  function rowInputValue(label: string): string {
    const row = screen.getByText(label).closest('.mform-row')
    const input = row?.querySelector('input') as HTMLInputElement | null | undefined
    return input?.value ?? '<missing input>'
  }

  it('opening Edit against a nest missing spacing.windowGap + the whole sheet object does not throw, and normalizes the fields to engine defaults', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, nests: [INCOMPLETE_NEST as never] },
      }))
      useCamStore.getState().setNestEditTarget('nest-incomplete')
    })

    render(<NestModal />)
    // The render above mounts CLOSED (activeModal is reset in beforeEach);
    // flip through open explicitly so the edit-detection effect (gated on the
    // closed->open transition) runs -- this is the exact transition that threw
    // before the fix.
    act(() => { useCamStore.getState().openModal('new-nest') })

    expect(screen.getByText('Edit Nest')).not.toBeNull()

    // Sheet width/height backfilled to the engine default sheet size (300x300)
    // -- the NumericInput would have thrown synchronously inside the act()
    // above if either were still undefined.
    expect(rowInputValue('Sheet width')).toBe('300')
    expect(rowInputValue('Sheet height')).toBe('300')

    // Spacing: the PRESENT fields (partGap 4, sheetMargin 6) are preserved
    // untouched; only the ABSENT windowGap is backfilled to the engine default (2).
    expect(rowInputValue('Part gap')).toBe('4')
    expect(rowInputValue('Sheet margin')).toBe('6')
    expect(rowInputValue('Window gap')).toBe('2')

    act(() => { useCamStore.getState().closeModal() })
  })
})
