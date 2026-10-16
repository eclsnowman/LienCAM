// @vitest-environment jsdom
//
// WO-2836: THE EXPANDED SPINDLE PANEL HEADER FITS ON ONE LINE.
//
// The operator, 2026-10-15, on a screenshot of the Control rail: "when did this happen
// on the spindle panel in control. This is bad text padding and fit". With the
// panel EXPANDED and the spindle reporting an rpm, the 26px rail header carried
// the title, the live "10000 rpm", the gear and the chevron; the title and the
// rpm each wrapped onto two lines and overflowed the row. WO-184 fixed the same
// wrap for the COLLAPSED panel only, by moving the readout to a body row.
//
// Round 2, the operator, 2026-10-15: "All I wanted was spindle and coolant and
// the RPM to not overlap in the header. I don't want you splitting this into
// subpanels." and "One easy solution is just call it. The spindle panel in the
// header don't have the /coolant wording". So the title is just "Spindle" on
// every machine and the live rpm stays IN the header (WO-116), beside it.
//
// jsdom does not lay out, so this renders the REAL SpindlePanel in jsdom (real
// stores, real catalog text), lifts that markup into headless Chromium with the
// app's real stylesheets and bundled fonts inside the rail's own ancestors
// (.control-page > .control-col-scroll, 280px - the default right rail), and
// measures what the operator sees.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { chromium, type Browser } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MachineConfig } from '../../types'

// jsdom's localStorage is broken under vitest's node launch flags and the
// stores persist on every set(); in-memory shim BEFORE the store imports.
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { CONTROL_PANEL_COLLAPSE_KEYS } = await import('../../components/machine/ControlPanelCollapseToggle')

const ORIGIN = 'http://wo2836.test'
const RAIL_W = 280
const CSS_FILES = ['src/theme/tokens.css', 'src/styles/app.css', 'src/app.css']

/** The three machine records that used to give the header its three long
 *  titles (WO-965 / WO-1058 / WO-1650) - each now reads just "Spindle". */
const CONFIGS: { config: string; coolantCapability: MachineConfig['coolantCapability'] }[] = [
  // Nothing stated: mist and flood stay, no vacuum (was "Spindle / Coolant").
  { config: 'coolant', coolantCapability: undefined },
  // No coolant at all, a vacuum on M8 (was "Spindle / Vacuum").
  { config: 'vacuum', coolantCapability: { mist: false, flood: false, vacuum: { onCode: 'M8' } } },
  // Coolant AND a vacuum on its own word (was "Spindle / Accessories").
  { config: 'accessories', coolantCapability: { vacuum: { onCode: 'M10' } } },
]

function mountPanel(coolantCapability: MachineConfig['coolantCapability'], collapsed: boolean): string {
  const base = useCamStore.getState().project.machine
  const machine = { ...base, coolantCapability } as MachineConfig
  act(() => {
    useCamStore.setState({ machineLibrary: [machine], project: { ...useCamStore.getState().project, machine } })
    useMachineControl.setState({ spindleRpm: 10000 })
    useUiPrefs.setState({
      machineSpindleRpm: 12000,
      collapsedPropsGroups: { [CONTROL_PANEL_COLLAPSE_KEYS.spindle]: collapsed },
    })
  })
  const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
  return container.innerHTML
}

function pageHtml(panel: string): string {
  const links = CSS_FILES.map((file) => `<link rel="stylesheet" href="/${file}">`).join('')
  return `<!doctype html><html data-ui-scale="1" style="--ui-scale:1"><head>${links}</head>`
    + `<body><div class="app-shell control-page" style="height:900px">`
    + `<aside class="control-col control-col-right" style="width:${RAIL_W}px;min-width:${RAIL_W}px;height:900px">`
    + `<div class="control-col-scroll">${panel}</div></aside></div></body></html>`
}

interface Measured {
  headerH: number
  headerKids: string[]
  titleText: string
  titleLines: number
  titleTruncated: boolean
  rpmText: string | null
  rpmLines: number
  /** px of horizontal overlap between neighbouring header items (0 = none). */
  overlaps: number[]
  overflowing: string[]
  panelText: string
}

let browser: Browser

async function measure(panel: string): Promise<Measured> {
  const page = await browser.newPage({ viewport: { width: 1680, height: 979 } })
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: pageHtml(panel) })
      const file = url.pathname.startsWith('/fonts/')
        ? path.join('public', url.pathname)
        : url.pathname.slice(1)
      if (!CSS_FILES.includes(file) && !url.pathname.startsWith('/fonts/')) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({
        contentType: file.endsWith('.css') ? 'text/css' : 'font/woff2',
        body: readFileSync(file),
      })
    })
    await page.goto(`${ORIGIN}/`)
    await page.evaluate(async () => { await document.fonts.ready })
    return await page.evaluate(() => {
      const lineCount = (el: Element): number => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const tops = new Set(
          Array.from(range.getClientRects())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => Math.round(r.top)),
        )
        return tops.size
      }
      const section = document.querySelector('.control-col-scroll > .control-panel')!
      const header = section.querySelector(':scope > .panel-header')!
      const title = header.querySelector('.panel-title') as HTMLElement
      const hb = header.getBoundingClientRect()
      const overflowing = Array.from(header.children)
        .filter((child) => {
          const b = child.getBoundingClientRect()
          return b.top < hb.top - 1 || b.bottom > hb.bottom + 1 || b.right > hb.right + 1 || b.left < hb.left - 1
        })
        .map((child) => child.className || child.tagName)
      const rpm = header.querySelector(':scope > .control-version')
      const kids = Array.from(header.children).map((c) => c.getBoundingClientRect())
      return {
        headerH: Math.round(hb.height),
        headerKids: Array.from(header.children).map((c) => c.getAttribute('data-testid') ?? c.classList[0]),
        titleText: title.textContent ?? '',
        titleLines: lineCount(title),
        titleTruncated: title.scrollWidth > title.clientWidth + 0.5,
        rpmText: rpm?.textContent ?? null,
        rpmLines: rpm ? lineCount(rpm) : 0,
        overlaps: kids.slice(1).map((b, i) => Math.max(0, Math.round(kids[i].right - b.left))),
        overflowing,
        panelText: section.textContent ?? '',
      }
    })
  } finally {
    await page.close()
  }
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 30_000)

afterAll(async () => {
  await browser?.close()
})

afterEach(() => {
  cleanup()
})

describe('WO-2836: the expanded Spindle panel header fits on one line', () => {
  for (const { config, coolantCapability } of CONFIGS) {
    it(`${config} machine at 10000 rpm: "Spindle", the rpm, gear and chevron on one 26px line, nothing overlapping`, async () => {
      const m = await measure(mountPanel(coolantCapability, false))
      expect(m.titleText, 'the title is just "Spindle" on every machine').toBe('Spindle')
      expect(m.headerH, 'the rail header keeps its 26px row').toBe(26)
      expect(m.titleLines, `"${m.titleText}" wrapped onto ${m.titleLines} lines`).toBe(1)
      expect(m.titleTruncated, 'the title fits whole at the default rail width - no ellipsis').toBe(false)
      // The live rpm stays IN the header (WO-116), on one line.
      expect(m.headerKids).toEqual(['panel-title', 'control-version', 'control-spindle-gear', 'control-spindle-toggle'])
      expect(m.rpmText).toBe('10000 rpm')
      expect(m.rpmLines, '"10000 rpm" wrapped').toBe(1)
      expect(m.overlaps, 'title, rpm, gear and chevron may not overlap').toEqual([0, 0, 0])
      expect(m.overflowing, 'nothing may overflow the header row').toEqual([])
    }, 30_000)
  }

  it('collapsed keeps the WO-184 readout row and a one-line header', async () => {
    const m = await measure(mountPanel(undefined, true))
    expect(m.titleText).toBe('Spindle')
    expect(m.headerKids).toEqual(['panel-title', 'control-spindle-toggle'])
    expect(m.titleLines).toBe(1)
    expect(m.overflowing).toEqual([])
    expect(m.panelText).toContain('10000 rpm Off | Off')
  }, 30_000)
})
