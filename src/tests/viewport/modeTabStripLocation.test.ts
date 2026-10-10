// The mode-tab strip's LOCATION history, shortest form: P13 moved it from the
// top toolbar into the viewport workspace bar; UI-73 made it floating viewport
// chrome portalled per-workspace from App; WO-047 (Operator APPROVED the WO-036
// design, card Q-CONTROL-LAYOUT-RULES) ends the floating era and moves the
// strip NATIVELY into the top header for every tab, centered between the left
// file commands and the right utilities. Two former right-side utilities also
// became tabs: Tool Library (leftmost, endmill icon, same modal) and Post
// Process (between Simulate and Control, a workflow stage).
//
// This is a structural relocation, not a behavior change: the strip is still
// the shared ModeTabStrip component and the SAME store handlers (setViewerMode,
// the sketch-entry chooser gate) drive its CAM tabs from the new location.
// These tests assert the relocation at the source-composition level (the
// established node-env test pattern here has no React renderer); the rendered
// order/behavior gate is headerModeTabs.wo047.test.tsx.
//   - ModeTabStrip exists and owns the mode tabs + the sketch gate.
//   - TopToolbar hosts the one shared strip, centered (.header-mode-tabs).
//   - The floating/portal mechanism is GONE from App and ViewportToolbar.
//     WO-060 owns a late CSS override rather than the legacy base stylesheet;
//     inert historical selectors may remain in that unowned base file.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const componentsDir = resolve(here, '../../components')
const srcDir = resolve(here, '../..')

const read = (rel: string) => readFileSync(resolve(componentsDir, rel), 'utf8')
const readSrc = (rel: string) => readFileSync(resolve(srcDir, rel), 'utf8')

describe('WO-047 mode tab strip relocation (header-native)', () => {
  const modeStrip = read('toolbar/ModeTabStrip.tsx')
  const viewportToolbar = read('viewport/ViewportToolbar.tsx')
  const topToolbar = read('toolbar/TopToolbar.tsx')
  const app = readSrc('App.tsx')
  const baseCss = readSrc('styles/app.css')
  const headerCss = readSrc('app.css')
  const store = readSrc('store/index.ts')

  it('ModeTabStrip owns all four mode tabs plus the two modal-opener tabs', () => {
    for (const label of ['setup', 'toolpath', 'simulate', 'sketch']) {
      expect(modeStrip).toContain(`return shellText('ModeTabStrip.${label}')`)
    }
    // WO-047: Tool Library and Post Process are tabs in the strip itself.
    expect(modeStrip).toContain('mode-tab-toollibrary')
    expect(modeStrip).toContain('mode-tab-postprocess')
    expect(modeStrip).toContain("openModal('tool-library')")
    expect(modeStrip).toContain("openModal('post-process')")
    // Operator's ruling: a cutting-tool icon, never a wrench, on Tool Library.
    expect(modeStrip).toContain('EndmillIcon')
  })

  // GEO-UNIFY Stage 5 (NAV-SKETCH-TAB-SELECTION, commit 1663c004c, Operator-
  // ordered restructure per NAV-PARITY-AUDIT Gap 1) moved the sketch-entry
  // chooser gate OUT of ModeTabStrip.tsx's inline onClick and into a single
  // store action, enterSketchWorkspace, that ALSO adds selection-aware
  // routing (a part with exactly one sketch-editable layer opens directly,
  // 2+ opens the chooser pre-filtered to that part). The gate itself is not
  // gone -- sketchTabNeedsChooser is still the mechanism, just called one
  // level down, inside enterSketchWorkspace's own no-selection fallback
  // branch (store/index.ts) instead of inline here. Proven still-live via
  // GEO-UNIFY-S5's RED->GREEN mutation proof + headed real-GPU capture
  // (coordination/reports/GEO-UNIFY-S5.report.md secs 3, 5).
  it('ModeTabStrip drives non-sketch tabs via setViewerMode and routes the sketch tab through enterSketchWorkspace', () => {
    expect(modeStrip).toContain('setViewerMode')
    expect(modeStrip).toContain('enterSketchWorkspace')
  })

  it('enterSketchWorkspace (the sketch tab\'s target action) keeps the sketch-entry chooser gate', () => {
    const start = store.indexOf('enterSketchWorkspace: () => {')
    expect(start, 'enterSketchWorkspace implementation not found in store/index.ts').toBeGreaterThan(-1)
    const body = store.slice(start, start + 1200)
    expect(body).toContain('sketchTabNeedsChooser')
    expect(body).toContain("openModal('sketch-entry')")
    expect(body).toContain('setViewerMode')
  })

  it('ModeTabStrip keeps the cyan active identity + focusable native buttons', () => {
    // .mode-tab-active carries the cyan identity (P3); native <button> gets the
    // global :focus-visible ring for keyboard reachability.
    expect(modeStrip).toContain('mode-tab-active')
    expect(modeStrip).toContain('<button')
  })

  it('TopToolbar hosts the one shared strip, centered in the header (WO-047)', () => {
    expect(topToolbar).toContain('ModeTabStrip')
    expect(topToolbar).toContain('header-mode-tabs')
    // The strip took over both former right-side utilities: no Tools button,
    // no right-side Post Process button remain in the header chrome.
    expect(topToolbar).not.toContain('>Tools<')
    expect(topToolbar).not.toContain('>Post Process<')
    // Flat on the header surface: the active tab wears the bottom-accent
    // underline; no pill container around the set.
    expect(headerCss).toMatch(/\.header-mode-tabs \.mode-tab-active[\s\S]{0,200}inset 0 -2px 0 var\(--accent-cyan\)/)
  })

  it('the floating strip and its portal mechanism are gone everywhere (WO-047)', () => {
    for (const source of [app, viewportToolbar, topToolbar, modeStrip]) {
      expect(source).not.toContain('data-mode-tab-portal')
      expect(source).not.toContain('app-mode-tabs-floating')
      expect(source).not.toContain('FloatingModeTabs')
    }
    // The rejected INT-13A full-width row must not come back either.
    expect(app).not.toContain('className="workspace-bar"')
    expect(baseCss).not.toMatch(/\.workspace-bar\s*\{/)
    // WO-047 removes the mechanism, including its otherwise inert CSS. Keeping
    // these selectors would make a future accidental render silently revive
    // the superseded floating geometry contract.
    expect(baseCss).not.toContain('.app-mode-tabs-floating')
    expect(baseCss).not.toContain('[data-mode-tab-portal')
    expect(baseCss).not.toContain('.mode-tab-portal-target')
  })

  it('keeps right utilities icon-only through the last clipped width', () => {
    // WO-2473 allows Linux Chromium's font metrics before restoring labels.
    expect(headerCss).toMatch(/@media \(max-width: 1649px\)\s*\{\s*\.toolbar-section-right \.tb-btn span\s*\{\s*display:\s*none/)
  })
})
