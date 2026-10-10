// @vitest-environment jsdom
//
// SKC-27 structural render smoke. jsdom does not perform sticky layout, so
// this gate proves the real CAM toolbox renders its Finish action first,
// applies the one production sticky class shared with Part Studio, and keeps
// the full production tool list in the sibling content block below it.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

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

const appCss = readFileSync('src/styles/app.css', 'utf8')
const camSource = readFileSync('src/components/panels/sketch/SketchToolbox.tsx', 'utf8')
const workbenchSource = readFileSync(
  'src/components/model3d/workbench/WorkbenchToolRail.tsx',
  'utf8',
)

afterEach(() => {
  cleanup()
  document.querySelectorAll('style[data-skc27-app-css]').forEach((style) => style.remove())
})

function installProductionStyles() {
  const style = document.createElement('style')
  style.dataset.skc27AppCss = 'true'
  style.textContent = appCss
  document.head.append(style)
}

describe('SKC-27: CAM Finish sketch shares the pinned first-action contract', () => {
  it('renders Finish first with long tool content beneath the shared sticky wrapper', () => {
    installProductionStyles()
    const { container } = render(<SketchToolbox />)

    const finish = screen.getByRole('button', { name: 'Finish' })
    const panelBody = container.querySelector('.sketch-toolbox > .panel-body')
    const sticky = panelBody?.firstElementChild
    const content = sticky?.nextElementSibling
    const sectionHeader = content?.querySelector('.tree-section-header')

    expect(finish).toBeTruthy()
    expect(panelBody).not.toBeNull()
    expect(sticky?.classList.contains('sketch-finish-sticky')).toBe(true)
    expect(sticky?.contains(finish)).toBe(true)
    expect(content?.classList.contains('sketch-toolbox-scroll-content')).toBe(true)
    expect(content?.querySelectorAll('.sketch-tool-btn').length).toBeGreaterThan(30)
    expect(content?.textContent).toContain('Utility')
    expect(appCss).toMatch(/\.sketch-finish-sticky\s*\{[^}]*position:\s*sticky;/s)

    expect(sticky).not.toBeNull()
    expect(sectionHeader).not.toBeNull()
    const finishZ = Number(getComputedStyle(sticky as Element).zIndex)
    const sectionHeaderZ = Number(getComputedStyle(sectionHeader as Element).zIndex)
    expect(Number.isFinite(finishZ)).toBe(true)
    expect(Number.isFinite(sectionHeaderZ)).toBe(true)
    expect(finishZ).toBeGreaterThan(sectionHeaderZ)
  })

  it('keeps one shared sticky class at both production call sites', () => {
    expect(camSource).toContain('className="sketch-finish-sticky"')
    expect(workbenchSource).toContain('className="sketch-finish-sticky"')
    expect(camSource).not.toContain('workbench-sketch-finish-toolbar')
    expect(workbenchSource).not.toContain('workbench-sketch-finish-toolbar')
  })
})
