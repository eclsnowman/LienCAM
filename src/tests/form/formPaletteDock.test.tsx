// @vitest-environment jsdom
//
// Form stage 50: the Form palette docks at the side beside the tool rail, a column of the page like the rail, instead
// of floating over the view's top-left (it covered part of the view, and clicks meant for the canvas landed on it).
// Form stage 51: the docked column folds to a strip at the side with its chevron (the view gets its whole width back),
// remembered per viewer; the Relief palette docks the same way, its height map a foldable section in the column.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { useFormStore } from '../../form/formStore'

const session = {
  active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
  canUndo: false, canRedo: false, railSections: [],
}

describe('the Form palette docks beside the rail', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useFormStore.getState().openSession({ featureId: null, name: 'Form 1', tolerance: 0.01 })
  })
  afterEach(() => cleanup())

  it('its chevron folds it to a strip at the side (the view gets its width back) and back again, remembered per viewer', () => {
    const { unmount } = render(<FormPanel session={session} />)
    const shell = () => screen.getByTestId('form-palette-shell')
    expect(shell().getAttribute('data-folded')).toBe('false')
    fireEvent.click(screen.getByTestId('form-palette-shell-fold'))
    // folded: a slim strip, no rows, no Finish; only the unfold chevron and the name
    expect(shell().getAttribute('data-folded')).toBe('true')
    expect(shell().classList.contains('is-folded')).toBe(true)
    expect(screen.queryByTestId('form-palette')).toBeNull()
    expect(screen.queryByTestId('form-finish')).toBeNull()
    expect(screen.getByTestId('form-palette-shell-unfold').textContent).toContain('Form')
    // remembered: a fresh mount comes back folded
    unmount()
    render(<FormPanel session={session} />)
    expect(shell().getAttribute('data-folded')).toBe('true')
    fireEvent.click(screen.getByTestId('form-palette-shell-unfold'))
    expect(shell().getAttribute('data-folded')).toBe('false')
    expect(screen.getByTestId('form-palette')).toBeTruthy()
  })

  it('is a side column like the rail: an aside with the rail\'s panel class, in the page\'s flow (nothing fixed or layered over the view)', () => {
    render(<FormPanel session={session} />)
    const shell = screen.getByTestId('form-palette-shell')
    expect(shell.tagName).toBe('ASIDE')
    expect(shell.classList.contains('panel-right')).toBe(true)
    expect(shell.classList.contains('modal-container')).toBe(false)
    for (const prop of ['position', 'left', 'top', 'zIndex'] as const) expect(shell.style[prop]).toBe('')
    // the header, the rows, and the Finish row keep their places
    expect(shell.querySelector('.panel-header')?.textContent).toContain('Form')
    expect(shell.querySelector('.docked-panel-body [data-testid="form-palette"]')).not.toBeNull()
    expect(shell.querySelector('.docked-panel-footer [data-testid="form-finish"]')).not.toBeNull()
    expect(shell.querySelector('.docked-panel-footer [data-testid="form-status"]')).not.toBeNull()
    expect(shell.querySelector('.docked-panel-body [data-testid="form-status"]')).toBeNull()
  })

  it('is mounted in the Model screen\'s row right before the rail (with the Relief palette), so it sits beside it and the view narrows for it', () => {
    const page = readFileSync(path.resolve(__dirname, '../../components/model3d/SolidsWorkbenchPage.tsx'), 'utf8')
    const MOUNT = '{form.active && <FormPanel session={form} />}\n      {relief.active && <ReliefPanel session={relief} />}'
    const mount = page.indexOf(MOUNT)
    const rail = page.indexOf('<WorkbenchToolRail')
    expect(mount).toBeGreaterThan(0)
    // mounted once only, both palettes (they used to be mounted among the floating dialogs)
    expect(page.indexOf('<FormPanel', mount + MOUNT.length)).toBe(-1)
    expect(page.indexOf('<ReliefPanel', mount + MOUNT.length)).toBe(-1)
    // Reference images now share this row: the layer draws no DOM, gestures
    // portal their handles, and the editing palette is another docked column.
    // Keep the flow/order assertion and allow only those named JSX components.
    const between = page.slice(mount + MOUNT.length, rail).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim()
    expect(rail).toBeGreaterThan(mount)
    const parsed = ts.createSourceFile('row.tsx', `const row = <>${between}</>`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const tags: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) tags.push(node.tagName.getText(parsed))
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    expect(tags).toEqual(['ReferenceImageLayer', 'ReferenceImagePlacement', 'ReferenceImageCalibration', 'ReferenceImagePanel'])
  })
})

describe('the Relief palette docks beside the rail too, its height map a foldable section', () => {
  afterEach(() => cleanup())

  it('folding the column and unfolding it draws the Image thumbnail again (its canvas is new after the unfold)', async () => {
    window.localStorage.clear()
    const { ReliefPanel } = await import('../../components/model3d/relief/ReliefPanel')
    const { useReliefStore } = await import('../../components/model3d/relief/reliefStore')
    const { defaultSettings } = await import('../../relief/reliefHeights')
    const picture = { cols: 4, rows: 4, grey: new Float32Array(16).fill(0.5), bitDepth: 8 as const }
    const face = { centre: { x: 0, y: 0, z: 10 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, widthMm: 40, heightMm: 40 }
    useReliefStore.getState().openSession({
      featureId: null, name: 'Relief',
      target: { ownerId: 'B1', faceId: 'f1', face, bodyName: 'Body 1' },
      image: { dataUrl: 'data:image/png;base64,', fileName: 'art.png', cols: 4, rows: 4, bitDepth: 8 },
      picture, settings: defaultSettings(picture, face, null),
    })
    const reliefSession = { active: true, open: () => {}, apply: () => {}, cancel: () => {}, openFile: async () => {}, fileInputRef: { current: null }, pickAt: () => {}, settled: () => null, railSections: [] }
    const drawnOn: unknown[] = []
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      drawnOn.push(this)
      return null
    })
    try {
      render(<ReliefPanel session={reliefSession} />)
      expect(drawnOn).toContain(screen.getByTestId('relief-thumb'))
      fireEvent.click(screen.getByTestId('relief-palette-shell-fold'))
      expect(screen.queryByTestId('relief-thumb')).toBeNull()
      fireEvent.click(screen.getByTestId('relief-palette-shell-unfold'))
      // the canvas after the unfold is a new element; it must be drawn, not left blank
      expect(drawnOn).toContain(screen.getByTestId('relief-thumb'))
    } finally {
      ctx.mockRestore()
      useReliefStore.getState().closeSession()
    }
  })

  it('one docked column: the height map inside it, folding with its own chevron; the column folds like Form\'s', async () => {
    window.localStorage.clear()
    const { ReliefPanel } = await import('../../components/model3d/relief/ReliefPanel')
    const { useReliefStore } = await import('../../components/model3d/relief/reliefStore')
    const { defaultSettings } = await import('../../relief/reliefHeights')
    const picture = { cols: 4, rows: 4, grey: new Float32Array(16).fill(0.5), bitDepth: 8 as const }
    const face = { centre: { x: 0, y: 0, z: 10 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, widthMm: 40, heightMm: 40 }
    useReliefStore.getState().openSession({
      featureId: null, name: 'Relief',
      target: { ownerId: 'B1', faceId: 'f1', face, bodyName: 'Body 1' },
      image: { dataUrl: 'data:image/png;base64,', fileName: 'art.png', cols: 4, rows: 4, bitDepth: 8 },
      picture, settings: defaultSettings(picture, face, null),
    })
    const reliefSession = { active: true, open: () => {}, apply: () => {}, cancel: () => {}, openFile: async () => {}, fileInputRef: { current: null }, pickAt: () => {}, settled: () => null, railSections: [] }
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    try {
      render(<ReliefPanel session={reliefSession} />)
      const shell = screen.getByTestId('relief-palette-shell')
      expect(shell.tagName).toBe('ASIDE')
      expect(shell.classList.contains('panel-right')).toBe(true)
      for (const prop of ['position', 'left', 'top', 'zIndex'] as const) expect(shell.style[prop]).toBe('')
      // the height map is a section of the column, not a panel of its own over the view
      const map = screen.getByTestId('relief-map-shell')
      expect(shell.contains(map)).toBe(true)
      expect(map.classList.contains('modal-container')).toBe(false)
      // its chevron folds just the map
      fireEvent.click(screen.getByTestId('relief-map-toggle'))
      expect(screen.queryByTestId('relief-map-shell')).toBeNull()
      expect(screen.getByTestId('relief-palette')).toBeTruthy()
      fireEvent.click(screen.getByTestId('relief-map-toggle'))
      expect(screen.getByTestId('relief-map-shell')).toBeTruthy()
      // the column folds to the strip, and back
      fireEvent.click(screen.getByTestId('relief-palette-shell-fold'))
      expect(screen.getByTestId('relief-palette-shell').getAttribute('data-folded')).toBe('true')
      expect(screen.queryByTestId('relief-apply')).toBeNull()
      fireEvent.click(screen.getByTestId('relief-palette-shell-unfold'))
      expect(screen.getByTestId('relief-apply')).toBeTruthy()
    } finally {
      ctx.mockRestore()
      useReliefStore.getState().closeSession()
    }
  })
})

describe('a docked palette scrolls when its rows are taller than it (Form stage 52)', () => {
  it('the body scrolls on overflow, keeps its gutter, and draws a scrollbar wide and light enough to see', () => {
    const css = readFileSync(path.resolve(__dirname, '../../components/model3d/workbench/dockedPanel.css'), 'utf8')
    const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.:-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    const body = rule('.docked-panel-body')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/scrollbar-gutter:\s*stable/)
    const width = Number(rule('.docked-panel-body::-webkit-scrollbar').match(/width:\s*(\d+)px/)?.[1] ?? 0)
    expect(width).toBeGreaterThanOrEqual(8)
    // a lighter thumb than the app's default (--scrollbar-thumb), which read as no scrollbar on the dark panel
    expect(rule('.docked-panel-body::-webkit-scrollbar-thumb')).toMatch(/background:\s*var\(--border-light\)/)
  })
})
