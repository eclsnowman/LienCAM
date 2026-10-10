// @vitest-environment jsdom
//
// React-render SMOKE test for ToolLibraryModal (sub-libraries / scope filter).
// The repo's vitest env is 'node' by default (see vite.config.ts); the directive
// above flips THIS file to jsdom so a real React tree can mount. jsdom is already
// a devDependency.
//
// WHY THIS EXISTS (per feedback_render_gate_ui_changes): tsc + pure-logic vitest
// do NOT catch hooks-order bugs. This mounts the modal closed, opens it, and
// switches the selected library scope — the closed->open transition plus the
// scope-state change is exactly the path a misplaced hook would crash on. The
// guard: if any of that throws inside act(), the test fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a minimal
// in-memory Storage shim BEFORE importing the store. Pure test scaffolding.
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

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

// The store is a process singleton. Seed it with at least the default library
// plus a couple of tools, and force the modal closed before each test so the
// tests are order-independent.
beforeEach(() => {
  act(() => {
    const s = useCamStore.getState()
    s.closeModal()
    // Ensure a default library exists, then add two tools tagged to it.
    const libId = s.toolLibraries[0]?.id ?? 'lib-default'
    const mkTool = (name: string, n: number) => ({
      id: crypto.randomUUID(),
      name,
      type: 'flat_end_mill' as const,
      diameter: 6,
      shankDiameter: 6,
      overallLength: 50,
      fluteLength: 18,
      shoulderLength: 0,
      numberOfFlutes: 2,
      cornerRadius: 0,
      angleFromAxisDeg: 59,
      material: 'carbide' as const,
      coating: 'none' as const,
      toolNumber: n,
      notes: '',
      libraryId: libId,
      feedsAndSpeeds: {
        default: {
          rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5,
          stepover: 3, coolant: 'none' as const,
        },
      },
    })
    s.addTool(mkTool('Smoke Tool A', 101))
    s.addTool(mkTool('Smoke Tool B', 102))
  })
})

describe('ToolLibraryModal render smoke', () => {
  it('mounts closed without crashing', () => {
    render(<ToolLibraryModal />)
    expect(screen.queryByText('Tool Library')).toBeNull()
  })

  it('opens, switches library scope, and stays mounted', () => {
    // Mount CLOSED first so the open is a true closed->open hook transition.
    render(<ToolLibraryModal />)
    expect(screen.queryByText('Tool Library')).toBeNull()

    act(() => { useCamStore.getState().openModal('tool-library') })

    // The header title proves the modal body rendered with stable hook order.
    expect(screen.getByText('Tool Library')).not.toBeNull()

    // The library scope selector must render; default is "All libraries".
    const scope = screen.getByTestId('tool-library-scope') as HTMLSelectElement
    expect(scope).not.toBeNull()
    expect(scope.value).toBe('all')

    // Switch to the default library scope — a state change that must not crash.
    const libId = useCamStore.getState().toolLibraries[0]?.id ?? 'lib-default'
    act(() => { fireEvent.change(scope, { target: { value: libId } }) })
    expect((screen.getByTestId('tool-library-scope') as HTMLSelectElement).value).toBe(libId)

    // Flip back to "All libraries".
    act(() => { fireEvent.change(scope, { target: { value: 'all' } }) })
    expect((screen.getByTestId('tool-library-scope') as HTMLSelectElement).value).toBe('all')

    // Close: it must unmount cleanly.
    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByText('Tool Library')).toBeNull()
  })

  // Helper: the segment-table cells for the selected holder. Column 0 = Height,
  // 1 = Lower OD, 2 = Upper OD.
  const heightInputs = () =>
    Array.from(
      document.querySelectorAll('table.feeds-guide-table tbody tr td:first-child input'),
    ) as HTMLInputElement[]

  it('Holders view: Add segment + edit height + reorder drive the store via the real DOM', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })
    expect(screen.getByText('Tool Library')).not.toBeNull()

    // Switch to the Holders view, then create a fresh holder via its REAL button.
    act(() => { fireEvent.click(screen.getByTestId('tool-view-holders')) })
    const holdersBefore = useCamStore.getState().holders.length
    act(() => { fireEvent.click(screen.getByTestId('holder-new')) })
    expect(useCamStore.getState().holders.length).toBe(holdersBefore + 1)
    const holderId = useCamStore.getState().holders[holdersBefore].id
    const segs = () => useCamStore.getState().holders.find(h => h.id === holderId)!.segments

    // ISSUE 1a — "adding segments don't work": click the actual Add segment
    // button and assert the store holder's segment count went up.
    const segCountBefore = segs().length
    act(() => { fireEvent.click(screen.getByTestId('holder-add-segment')) })
    expect(segs().length).toBe(segCountBefore + 1)

    // ISSUE 1b — "height field ... like it is hard coded": type a NEW height into
    // the first segment's height input (a real <input>), blur to commit, and
    // assert the store reflects the typed value (not the hard-coded default).
    const hi0 = heightInputs()[0]
    expect(hi0).toBeTruthy()
    act(() => {
      fireEvent.focus(hi0)
      fireEvent.change(hi0, { target: { value: '37' } })
      fireEvent.blur(hi0)
    })
    expect(segs()[0].height).toBe(37)

    // Give the SECOND segment a distinct height so a reorder is observable.
    const hi1 = heightInputs()[1]
    act(() => {
      fireEvent.focus(hi1)
      fireEvent.change(hi1, { target: { value: '52' } })
      fireEvent.blur(hi1)
    })
    expect(segs()[1].height).toBe(52)

    // ISSUE 1c — reorder: move the first segment DOWN via its real arrow button;
    // the store order must swap (37 was at idx0, 52 at idx1 -> now 52, 37).
    expect(segs().map(s => s.height)).toEqual([37, 52])
    act(() => { fireEvent.click(screen.getByTestId('holder-seg-down-0')) })
    expect(segs().map(s => s.height)).toEqual([52, 37])

    // Move it back UP to prove the up control works too.
    act(() => { fireEvent.click(screen.getByTestId('holder-seg-up-1')) })
    expect(segs().map(s => s.height)).toEqual([37, 52])

    // Back to Tools view: the toggle must survive without crashing.
    act(() => { fireEvent.click(screen.getByTestId('tool-view-tools')) })
    expect(screen.getByText('Tool Library')).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByText('Tool Library')).toBeNull()
  })

  // Row 0 inputs of the segment table: [0]=Height, [1]=Lower OD, [2]=Upper OD.
  const row0Inputs = () =>
    Array.from(
      document.querySelectorAll('table.feeds-guide-table tbody tr:first-child td input'),
    ) as HTMLInputElement[]
  const setNum = (input: HTMLInputElement, v: string) => {
    act(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: v } })
      fireEvent.blur(input)
    })
  }
  // Bounding box of the rendered holder-preview polygon (in SVG user units).
  const previewBBox = () => {
    const poly = document.querySelector('[data-testid="holder-preview-poly"]') as SVGPolygonElement | null
    if (!poly) return { w: 0, h: 0 }
    const pts = poly.getAttribute('points')!.trim().split(/\s+/).map(p => p.split(',').map(Number))
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }

  // Guards the REAL requirement Operator flagged (not the store proxy): the holder
  // PREVIEW silhouette must reflect the true aspect ratio and CHANGE when a
  // segment is edited. The prior bug used independent x/y scales, stretching
  // every holder to fill the box so edits made no visible difference.
  it('Holders view: preview reflects true aspect ratio and responds to edits', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })
    act(() => { fireEvent.click(screen.getByTestId('tool-view-holders')) })
    act(() => { fireEvent.click(screen.getByTestId('holder-new')) })

    // Make segment 0 WIDE and SHORT: OD 34/34, height 10.
    setNum(row0Inputs()[1], '34')
    setNum(row0Inputs()[2], '34')
    setNum(row0Inputs()[0], '10')
    const wide = previewBBox()
    // True aspect: a 34mm-wide x 10mm-tall holder must draw WIDER than it is tall.
    expect(wide.w).toBeGreaterThan(wide.h)

    // Now make it TALL (height 80): the silhouette must visibly respond and flip
    // to taller-than-wide. (Old non-uniform scale would leave it unchanged.)
    setNum(row0Inputs()[0], '80')
    const tall = previewBBox()
    expect(tall.h).toBeGreaterThan(tall.w)
    expect(tall.h).not.toBe(wide.h)

    act(() => { useCamStore.getState().closeModal() })
  })

  it('exposes the Holder dropdown in the tool editor general tab', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })
    // Open the General tab where the Holder dropdown lives.
    act(() => { fireEvent.click(screen.getByText('General')) })
    expect(screen.getByTestId('tool-holder-select')).not.toBeNull()
    act(() => { useCamStore.getState().closeModal() })
  })

  it('duplicateTool store action clones with a new id and (copy) name', () => {
    const before = useCamStore.getState().toolLibrary
    const src = before[0]
    let newId = ''
    act(() => { newId = useCamStore.getState().duplicateTool(src.id) })
    expect(newId).not.toBe('')
    const copy = useCamStore.getState().toolLibrary.find(t => t.id === newId)!
    expect(copy.id).not.toBe(src.id)
    expect(copy.name).toBe(`${src.name} (copy)`)
    expect(copy.libraryId).toBe(src.libraryId)
  })
})
