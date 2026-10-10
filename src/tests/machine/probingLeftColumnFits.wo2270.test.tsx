// @vitest-environment jsdom
//
// WO-2270 - THE PROBING SCREEN'S LEFT COLUMN FITS OPERATOR'S WINDOW.
//
// Operator, 2026-09-30 at the machine: "on the left hand side the routines buttons
// and the settings for each routine below it run off on a scroll. I'd like to
// figure out how to make that more compact so that way required settings don't
// scroll off the bottom ... Maybe not all the way down to the general UI sizing
// but smaller than what it currently is."
//
// Route: the production Probing panel (ProbingPanel), with Operator's T19 in the
// spindle and a loaded program (Z surface plans its grid from it), every
// routine's YOU step at its default choices. Each one's markup is laid out
// with the app's real stylesheets (tokens, app.css, the Probing screen's own)
// in headless Chromium - jsdom has no layout and no CSS - in the box the
// Probing screen has at 1920x1080 and at Operator's 1680x979 (measured in the app:
// src/tests/evidence/WO-2270/measure-*.json), and measured there:
//   1. the left column does not scroll, and the last setup row ends inside it;
//   2. the routine buttons, the setup rows, "Picture key" and its rows, "More
//      about this step" and its text are each smaller than before WO-2270 and
//      still larger than the general UI's 13 px.
//
// Negative control (recorded in the work order): on main's probingScreen.css
// Z surface's Max X / Min Y / Max Y and its action row fall below the column
// at 1680x979, and the sizes read 14 / 14 / 15 / 17 / 15 / 22 / 22 px.

import React from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { chromium, type Browser } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

// The app's own fonts, inlined: a label that fits on one line in a narrower
// fallback face can wrap in DM Sans and take a second line.
const CSS = ['src/theme/tokens.css', 'src/styles/app.css', 'src/components/machine/probing/probingScreen.css']
  .map((f) => readFileSync(f, 'utf8')).join('\n')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (all, file: string) => existsSync(`public/fonts/${file}`)
    ? `url(data:font/woff2;base64,${readFileSync(`public/fonts/${file}`).toString('base64')})`
    : all)

const T19 = {
  id: 'wo2270-t19', toolNumber: 19, name: 'Rennie 1/8" single flute', type: 'flat', diameter: 3.1,
  fluteLength: 10, shankDiameter: 6, overallLength: 50, numberOfFlutes: 1, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 0, feedRate: 400, plungeRate: 50, depthOfCut: 0, stepover: 0, coolant: 'none' } },
}
const PROGRAM = 'G21 G90\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X60 F600\nG1 Y40\nG1 X0\nG1 Y0\nG0 Z5\nM30\n'
const ROUTINES = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ', 'calibrate'] as const
/** The Probing screen's box in the app at each window, and its picture box. */
const SIZES = [
  { name: '1920x1080', screenW: 1904, screenH: 968, w: 1100, h: 640 },
  { name: '1680x979', screenW: 1664, screenH: 867, w: 594, h: 548 },
]
/** Before WO-2270 (main c057ec76f..b87e2c385), and the general UI's size. */
const BEFORE = { routine: 14, setupLabel: 14, keyTitle: 15, keyRow: 17, moreTitle: 15, moreHeading: 22, moreText: 22 }
const GENERAL_UI = 13

let box = SIZES[0]
let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) }, 60_000)
afterAll(async () => { await browser?.close() })

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  // The right column opens the picture key on a screen 1000 px tall or more.
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 })
  useCamStore.getState().newProject()
  useCamStore.setState({ toolLibrary: [...useCamStore.getState().toolLibrary.filter((t) => t.toolNumber !== 19), T19 as never] })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: 19,
    tlo: null,
    programText: PROGRAM,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  // jsdom has no layout: the picture box reports the screen's measured size.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = this.getAttribute('data-testid') === 'probing-picture-box' ? { w: box.w, h: box.h } : { w: 0, h: 0 }
    return { x: 0, y: 0, left: 0, top: 0, right: r.w, bottom: r.h, width: r.w, height: r.h, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

interface Measured {
  dmSans: boolean
  screenH: number
  scrollHeight: number
  clientHeight: number
  colBottom: number
  lastRowBottom: number | null
  rowsBelow: string[]
  rows: number
  fonts: Record<string, number | null>
}

/** Lays one rendered screen out with the app's stylesheets and measures it. */
async function measure(html: string, size: typeof SIZES[number]): Promise<Measured> {
  const page = await browser.newPage({ viewport: { width: size.screenW + 16, height: size.screenH + 16 } })
  try {
    await page.setContent(`<!doctype html><html data-theme="dark"><head><style>${CSS}</style></head><body style="margin:8px">
      <div style="width:${size.screenW}px;height:${size.screenH}px">${html}</div></body></html>`)
    await page.evaluate(async () => {
      await Promise.all(['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 14px "DM Sans"`)))
      await document.fonts.ready
    })
    return await page.evaluate(() => {
      const px = (e: Element | null) => (e ? parseFloat(getComputedStyle(e).fontSize) : null)
      const q = (s: string) => document.querySelector(s)
      const col = q('[data-testid="control-probing-left"]')!
      const colR = col.getBoundingClientRect()
      const rows = Array.from(document.querySelectorAll('[data-testid="control-probe-setup-card"] .pbn-setup-rows > *'))
      const last = rows[rows.length - 1]
      return {
        dmSans: document.fonts.check('14px "DM Sans"'),
        screenH: Math.round(q('[data-testid="control-probing-panel"]')!.getBoundingClientRect().height),
        scrollHeight: col.scrollHeight,
        clientHeight: col.clientHeight,
        colBottom: Math.round(colR.bottom * 10) / 10,
        lastRowBottom: last ? Math.round(last.getBoundingClientRect().bottom * 10) / 10 : null,
        rowsBelow: rows.filter((r) => r.getBoundingClientRect().bottom > colR.bottom + 0.5).map((r) => (r.textContent ?? '').trim().slice(0, 40)),
        rows: rows.length,
        fonts: {
          routine: px(q('.pbn-routine')),
          setupLabel: px(q('.pbn-setup-row > span')),
          keyTitle: px(q('[data-testid="probing-key-panel"] .disclosure-title')),
          keyRow: px(q('.pbn-key-row')),
          moreTitle: px(q('[data-testid="probing-more-panel"] .disclosure-title')),
          moreHeading: px(q('.pbn-more-section h4')),
          moreText: px(q('.pbn-more-section p, .pbn-more-empty')),
        },
      }
    })
  } finally {
    await page.close()
  }
}

/** Every routine's YOU step (step 1) as rendered by the panel, and Bore with More about this step open. */
function renderedScreens(): Array<{ where: string; html: string }> {
  render(React.createElement(ProbingPanel))
  const out: Array<{ where: string; html: string }> = []
  for (const routine of ROUTINES) {
    fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
    const chip = screen.queryByTestId('probing-step-chip-1')
    if (chip) fireEvent.click(chip)
    out.push({ where: routine, html: screen.getByTestId('control-probing-panel').outerHTML })
  }
  fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
  fireEvent.click(screen.getByTestId('probing-more-toggle'))
  out.push({ where: 'bore, More about this step open', html: screen.getByTestId('control-probing-panel').outerHTML })
  cleanup()
  return out
}

describe('WO-2270 the Probing left column fits; its text, Picture key and More a step smaller', () => {
  for (const size of SIZES) {
    it(`every routine's setup is inside the left column at ${size.name}`, async () => {
      box = size
      const problems: string[] = []
      const fonts: Record<string, number> = {}
      const screens = renderedScreens()
      expect(screens.length).toBe(ROUTINES.length + 1)
      for (const { where, html } of screens) {
        const m = await measure(html, size)
        if (!m.dmSans) problems.push(`${where} ${size.name}: laid out without the app's DM Sans`)
        // The screen really is the app's box - the middle card did not stretch the row.
        if (m.screenH !== size.screenH || m.clientHeight > size.screenH) problems.push(`${where} ${size.name}: screen ${m.screenH} px tall, left column ${m.clientHeight}, want ${size.screenH}`)
        if (m.rows === 0 || m.lastRowBottom === null) problems.push(`${where} ${size.name}: no setup rows drawn`)
        if (m.scrollHeight > m.clientHeight) problems.push(`${where} ${size.name}: the left column scrolls (${m.scrollHeight} > ${m.clientHeight})`)
        if (m.rowsBelow.length) problems.push(`${where} ${size.name}: last row ends at ${m.lastRowBottom}, column at ${m.colBottom}; below: ${m.rowsBelow.join(' | ')}`)
        for (const [k, v] of Object.entries(m.fonts)) if (v !== null) fonts[k] = v
      }
      for (const [what, before] of Object.entries(BEFORE)) {
        const got = fonts[what]
        if (got === undefined) problems.push(`${size.name}: ${what} not drawn`)
        else if (!(got < before && got > GENERAL_UI)) problems.push(`${size.name}: ${what} is ${got} px, want under ${before} and over ${GENERAL_UI}`)
      }
      expect(problems).toEqual([])
    }, 120_000)
  }
})
