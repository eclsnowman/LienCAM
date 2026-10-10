// @vitest-environment jsdom
//
// WO-268: the app is called LienCAM.
//
// Operator pointed at the top-left wordmark. It was `CNC<em>CAM</em>` -- split
// across two elements, so a find-and-replace on the literal string "CNCCAM"
// misses the single most visible instance of the old name in the product.
// These tests mount the REAL header and read what a user actually sees, which
// is the only assertion that catches the split form.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the Zustand store persists on every set(). Install an in-memory Storage shim
// BEFORE importing the store. Test scaffolding only (same pattern as the
// neighboring component smoke tests).
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

const { TopToolbar } = await import('../../components/toolbar/TopToolbar')

afterEach(cleanup)

function renderHeader(): HTMLElement {
  render(<TopToolbar />)
  // The toolbar mounted at all (anchor: a control that is always present).
  expect(screen.getByText('Post Process')).not.toBeNull()
  const header = document.querySelector('header.top-toolbar')
  expect(header).not.toBeNull()
  return header as HTMLElement
}

describe('WO-268: the app header wordmark reads LienCAM', () => {
  it('renders the brand name as LienCAM', () => {
    renderHeader()
    const brand = document.querySelector('.brand-name')
    expect(brand).not.toBeNull()
    // textContent flattens the <em> split, which is exactly what the user
    // reads on screen. This is the assertion a literal-string search cannot
    // make.
    expect(brand!.textContent).toBe('LienCAM')
  })

  it('keeps the two-tone <em> treatment, with CAM as the accented half', () => {
    renderHeader()
    // Not a redesign guard -- a regression guard. The splash wordmark in
    // index.html is brand prefix + accented CAM; the header must not silently flatten
    // to a single-tone string while someone is renaming it.
    const em = document.querySelector('.brand-name em')
    expect(em).not.toBeNull()
    expect(em!.textContent).toBe('CAM')
  })

  it('renders no occurrence of the old name anywhere in the header', () => {
    const header = renderHeader()

    // Every rendered text node in the header, flattened. Covers the split form
    // (CNC + CAM in sibling elements) because textContent concatenates them.
    const rendered = header.textContent ?? ''
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered).not.toMatch(/CNCCAM/i)
    expect(rendered).not.toMatch(/CNC[ -]CAM/i)
    expect(rendered).not.toMatch(/LienCNC/i)

    // Attributes too: tooltips, aria-labels and titles are user-visible even
    // though they are not text nodes.
    const attrText = Array.from(header.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.attributes).map((a) => a.value))
      .join(' ')
    expect(attrText).not.toMatch(/CNCCAM/i)
    expect(attrText).not.toMatch(/CNC[ -]CAM/i)
    expect(attrText).not.toMatch(/LienCNC/i)
  })
})
