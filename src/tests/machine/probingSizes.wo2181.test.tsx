// @vitest-environment jsdom
//
// WO-2181 - THE PROBING SCREEN'S TEXT GOES HALFWAY TO THE REST OF THE UI, AND
// BACK / NEXT / PREVIEW STEPS MATCH THE STEP-NUMBER BUTTONS.
//
// Operator ruling 2026-09-29: "Somewhere in between ... just go in between. Also I don't
// like that the BACK, NEXT and PREVIEW buttons are not the same size a the
// number buttons. That is bad UI. Fix it."
//
// Route: the production Probing panel (ProbingPanel), with Operator's T19 in the
// spindle, its picture box at the sizes it has on the 1920x1080 and 1440x900
// screens (1228x696 and 748x441, the WO-2179 captures). Step 1 and the first
// MACHINE step of every routine are rendered here; each one's markup is then
// laid out with the app's real stylesheets (tokens, app.css, the Probing
// screen's own) in headless Chromium - jsdom has no layout and no CSS - and
// measured there:
//   1. computed font sizes, halfway between today's and the UI's
//      (round((today + normal) / 2)): view titles and the step sentence 20 px,
//      the picture's labels 19-20 px and its BEFORE START / RUNNING strip 20 px,
//      "Picture key" and "More about this step" 14 px, the key's rows 15 px
//      (WO-2270 took them a step smaller: Operator 09-30, "the more about this
//      step or the picture key"; were 15 / 17 px),
//      step numbers 20 px (19 / 18 where the row narrows them, from 24 / 22),
//      the current step 4 px larger, "YOU" 14 px;
//   2. Back, Next and Preview steps: a step number's height, top and foot, text
//      size, corner radius and border;
//   3. no two of the picture's words overlap.
//
// Negative control (recorded in the work order): on main's probingScreen.css /
// ProbingScreen.tsx / ProbeStepPicture.tsx the sizes read 26 / 18 / 21 / 26 /
// 30 / 16 and 24-28 in the picture, and the three buttons are 54 px against
// 62 px step numbers.

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

// The app's own fonts, inlined: a row that fits in a narrower fallback face
// can still wrap in DM Sans (Preview steps did, at 1440x900).
const CSS = ['src/theme/tokens.css', 'src/styles/app.css', 'src/components/machine/probing/probingScreen.css']
  .map((f) => readFileSync(f, 'utf8')).join('\n')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (all, file: string) => existsSync(`public/fonts/${file}`)
    ? `url(data:font/woff2;base64,${readFileSync(`public/fonts/${file}`).toString('base64')})`
    : all)

const T19 = {
  id: 'wo2181-t19', toolNumber: 19, name: 'Rennie 1/8" single flute', type: 'flat', diameter: 3.1,
  fluteLength: 10, shankDiameter: 6, overallLength: 50, numberOfFlutes: 1, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 0, feedRate: 400, plungeRate: 50, depthOfCut: 0, stepover: 0, coolant: 'none' } },
}
const PROGRAM = 'G21 G90\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X60 F600\nG1 Y40\nG1 X0\nG1 Y0\nG0 Z5\nM30\n'
const ROUTINES = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ', 'calibrate'] as const
/** The picture box on each screen, and the width the three columns take there. */
const SIZES = [
  { name: '1920x1080', w: 1228, h: 696, screenW: 1904, screenH: 1000, chip: 20 },
  { name: '1440x900', w: 748, h: 441, screenW: 1424, screenH: 820, chip: null },
]

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
  fonts: Record<string, number | null>
  svg: number[]
  banner: number | null
  chip: { h: number; top: number; bottom: number; font: number; radius: string; border: string } | null
  buttons: Array<{ id: string; h: number; top: number; bottom: number; font: number; radius: string; border: string }>
  overlaps: string[]
}

/** Lays one rendered screen out with the app's stylesheets and measures it. */
async function measure(html: string, size: typeof SIZES[number]): Promise<Measured> {
  const page = await browser.newPage({ viewport: { width: size.screenW + 16, height: size.screenH + 16 } })
  try {
    await page.setContent(`<!doctype html><html data-theme="dark"><head><style>${CSS}</style></head><body style="margin:8px">
      <div style="width:${size.screenW}px;height:${size.screenH}px">${html}</div></body></html>`)
    await page.evaluate(async () => {
      await Promise.all(['400', '500', '700'].map((w) => document.fonts.load(`${w} 20px "DM Sans"`)))
      await document.fonts.ready
    })
    return await page.evaluate(() => {
      const px = (e: Element | null) => (e ? parseFloat(getComputedStyle(e).fontSize) : null)
      const q = (s: string) => document.querySelector(s)
      const svg = q('[data-testid="probe-picture"]') as SVGSVGElement | null
      const scale = svg?.getScreenCTM()?.a ?? 1
      const texts = Array.from(svg?.querySelectorAll('text') ?? [])
      const svgPx = (t: Element) => Math.round(parseFloat(getComputedStyle(t).fontSize) * scale * 10) / 10
      const boxOf = (e: Element) => {
        const r = e.getBoundingClientRect()
        const s = getComputedStyle(e)
        return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), radius: s.borderTopLeftRadius, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}` }
      }
      const chipEl = q('.pbn-chip:not(.pbn-chip-current)')
      const chip = chipEl ? { ...boxOf(chipEl), font: px(chipEl.querySelector('.pbn-chip-n'))! } : null
      const buttons = ['back', 'next', 'play'].flatMap((id) => {
        const e = q(`[data-testid="probing-step-${id}"]`)
        return e ? [{ id, ...boxOf(e), font: px(e)! }] : []
      })
      const words = texts.filter((t) => (t.textContent ?? '').trim()).map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }))
      const overlaps: string[] = []
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) {
          const a = words[i].r; const b = words[j].r
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(`"${words[i].t}" x "${words[j].t}"`)
        }
      }
      const banner = q('[data-testid="probe-caption"] text')
      return {
        dmSans: document.fonts.check('20px "DM Sans"'),
        fonts: {
          caption: px(q('[data-testid="probing-caption-side"]')),
          captionTop: px(q('[data-testid="probing-caption-top"]')),
          sentence: px(q('[data-testid="probing-step-sentence"]')),
          keyTitle: px(q('[data-testid="probing-key-panel"] .disclosure-title')),
          keyRow: px(q('.pbn-key-row')),
          moreTitle: px(q('[data-testid="probing-more-panel"] .disclosure-title')),
          chipCurrent: px(q('.pbn-chip-current .pbn-chip-n')),
          you: px(q('.pbn-chip-you')),
        },
        svg: [...new Set(texts.map(svgPx))].sort((a, b) => a - b),
        banner: banner ? svgPx(banner) : null,
        chip,
        buttons,
        overlaps,
      }
    })
  } finally {
    await page.close()
  }
}

/** Step 1 and the first MACHINE step of every routine, as rendered by the panel. */
function renderedSteps(): Array<{ where: string; html: string }> {
  render(React.createElement(ProbingPanel))
  const out: Array<{ where: string; html: string }> = []
  for (const routine of ROUTINES) {
    fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
    const machine = document.querySelector('[data-testid^="probing-step-chip-"][data-owner="machine"]')
    const steps = ['1', machine?.getAttribute('data-testid')?.replace('probing-step-chip-', '')].filter((s, i, a): s is string => !!s && a.indexOf(s) === i)
    for (const n of steps) {
      const chip = screen.queryByTestId(`probing-step-chip-${n}`)
      if (chip) fireEvent.click(chip)
      out.push({ where: `${routine} step ${n}`, html: screen.getByTestId('control-probing-panel').outerHTML })
    }
  }
  cleanup()
  return out
}

describe('WO-2181 Probing text halfway to the UI size; Back / Next / Preview match the step numbers', () => {
  for (const size of SIZES) {
    it(`every routine, step 1 and a MACHINE step, at ${size.name}`, async () => {
      box = size
      const problems: string[] = []
      const seenButtons = new Set<string>()
      const shots = renderedSteps()
      expect(shots.length).toBeGreaterThanOrEqual(ROUTINES.length * 2 - 1)
      for (const { where, html } of shots) {
        const m = await measure(html, size)
        if (!m.dmSans) problems.push(`${where} ${size.name}: laid out without the app's DM Sans`)
        const want = (what: string, got: number | null | undefined, ok: number[]) => {
          if (got == null || !ok.includes(got)) problems.push(`${where} ${size.name}: ${what} is ${got ?? 'missing'} px, want ${ok.join(' or ')}`)
        }
        want('the side view title', m.fonts.caption, [20])
        want('the top view title', m.fonts.captionTop, [20])
        want('the step sentence', m.fonts.sentence, [20])
        want('"Picture key"', m.fonts.keyTitle, [14])
        want('a picture key row', m.fonts.keyRow, [15])
        want('"More about this step"', m.fonts.moreTitle, [14])
        want('a step number', m.chip?.font, size.chip ? [size.chip] : [20, 19, 18])
        want('the current step number', m.fonts.chipCurrent, [(m.chip?.font ?? 20) + 4])
        if (m.fonts.you !== null) want('"YOU"', m.fonts.you, [14])
        for (const s of m.svg) want('a picture label', s, [19, 20])
        if (m.banner !== null) want('the BEFORE START / RUNNING strip', m.banner, [20])
        if (!m.chip) { problems.push(`${where} ${size.name}: no step number drawn`); continue }
        for (const b of m.buttons) {
          seenButtons.add(b.id)
          const same = (what: string, a: unknown, c: unknown) => { if (a !== c) problems.push(`${where} ${size.name}: ${b.id} ${what} ${String(a)}, a step number's ${String(c)}`) }
          same('height', b.h, m.chip.h)
          same('top', b.top, m.chip.top)
          same('foot', b.bottom, m.chip.bottom)
          same('text size', b.font, m.chip.font)
          same('corner radius', b.radius, m.chip.radius)
          same('border', b.border, m.chip.border)
        }
        for (const o of m.overlaps) problems.push(`${where} ${size.name}: picture words overlap: ${o}`)
      }
      expect(problems).toEqual([])
      // The buttons were really measured: Back, Next and Preview steps show on
      // the full-size screen.
      if (size.chip) expect([...seenButtons].sort()).toEqual(['back', 'next', 'play'])
    }, 120_000)
  }
})
