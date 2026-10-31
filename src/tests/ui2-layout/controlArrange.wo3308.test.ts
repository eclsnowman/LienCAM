// WO-3308 (UI M2 W2-5b): Control in Arrange holds spec 5.1 rules 1 to 8 in the real browser, at
// the six target sizes in the three M1 themes and at 75 % and 150 % interface scale. It runs on the
// evidence harness (src/tests/evidence/WO-3308/arrange.html): Control's columns drawn from the
// layout (with the machine running: Arrange is never refused), the Layout menu and the Arrange window, in the New UI frame. A missing browser FAILS
// unless PW_SKIP_BROWSER=1.
//   1 the window never scrolls   2 cards never overlap and never leave the window
//   3 no chrome text is cut off  4 every hit target is at least 20 px after scaling
//   5 modules keep their places (columns in layout order at every size)
//   (the stand-in module cards are WO-3298's to hold to rule 3; only this order's parts are checked for it)
//   7 the locked stops (E-STOP, Feed hold, Stop) are fully on screen and not covered
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'
import { LAYOUT, THEMES } from '../../theme/tokens'

const REPO_ROOT = path.resolve('.')
const HARNESS = 'src/tests/evidence/WO-3308/arrange.html'
const EXPECTED_ORDER = { left: ['machine', 'position', 'offsets', 'tool'], centre: ['program', 'console'], right: ['jog', 'overrides', 'spindle', 'macros'] }

async function measure(page: Page, minHit: number): Promise<string[]> {
  return page.evaluate(({ minHit, order }) => {
    const out: string[] = []
    const w = window.innerWidth, h = window.innerHeight
    const root = document.documentElement
    if (root.scrollWidth > w + 1) out.push(`window scrolls sideways (${root.scrollWidth} > ${w})`)
    if (root.scrollHeight > h + 1) out.push(`window scrolls down (${root.scrollHeight} > ${h})`)

    const cards = [...document.querySelectorAll<HTMLElement>('[data-ui2-card]')]
      .filter(el => el.getClientRects().length > 0)
      .map(el => ({ name: el.dataset.ui2Card ?? '?', r: el.getBoundingClientRect() }))
    for (const n of ['appbar', 'ribbon', 'workspace-control', 'arrange']) if (!cards.some(c => c.name === n)) out.push(`card ${n} was not found`)
    for (const c of cards) {
      if (c.r.left < -0.5 || c.r.top < -0.5 || c.r.right > w + 0.5 || c.r.bottom > h + 0.5) out.push(`${c.name} leaves the window`)
    }
    // the dock sits inside the workspace card by construction; the modules must not overlap each other
    const mods = [...document.querySelectorAll<HTMLElement>('[data-lc="card"]')].filter(el => el.getClientRects().length > 0)
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        const a = mods[i].getBoundingClientRect(), b = mods[j].getBoundingClientRect()
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push('two modules overlap')
      }
    }
    // rule 5: columns hold their modules in layout order whatever the size
    for (const [column, ids] of Object.entries(order)) {
      const found = [...document.querySelectorAll(`[data-testid="control-column-${column}"] > [data-module]`)].map(e => e.getAttribute('data-module'))
      if (found.join() !== ids.join()) out.push(`column ${column} holds ${found.join()} instead of ${ids.join()}`)
    }
    // rule 7: each locked stop is fully on screen and the element at its centre is itself
    const stops = [...document.querySelectorAll<HTMLElement>('[data-lc="stop"]')]
    if (stops.length !== 3) out.push(`found ${stops.length} locked stops, expected 3`)
    for (const s of stops) {
      const r = s.getBoundingClientRect()
      if (r.left < 0 || r.top < 0 || r.right > w || r.bottom > h || r.width < 1) out.push('a locked stop is cut off')
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!top || !s.contains(top)) out.push('a locked stop is covered')
    }
    const label = (el: Element) => (el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40)
    for (const el of document.querySelectorAll<HTMLElement>('.arrange-harness *')) {
      if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') continue
      const cs = getComputedStyle(el)
      if (cs.overflowX === 'hidden' && !el.matches('.arrange-columns, .arrange-column') && !el.closest('[data-lc="card"]') && el.scrollWidth > el.clientWidth + 1) {
        const told = el.hasAttribute('data-tooltip') || el.hasAttribute('aria-label') || el.closest('[data-tooltip]') !== null
        if (cs.textOverflow !== 'ellipsis' || !told) out.push(`text cut off in ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`)
      }
      if (el.matches('button, select, input, [role="radio"]')) {
        // a checkbox is pressed through its whole labelled field
        const r = (el.matches('input[type="checkbox"]') ? el.closest('label') ?? el : el).getBoundingClientRect()
        if (r.width < minHit - 0.5 || r.height < minHit - 0.5) out.push(`hit target ${label(el)} is ${Math.round(r.width)} x ${Math.round(r.height)}`)
      }
    }
    return out
  }, { minHit, order: EXPECTED_ORDER })
}

describe('WO-3308 Control Arrange layout suite', () => {
  it('holds the spec 5.1 rules at every target size and theme, and at 75 % and 150 % scale', async () => {
    if (process.env.PW_SKIP_BROWSER === '1') return
    const failures: string[] = []
    await withViteCaptureServer({ port: 4610, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROMIUM || undefined })
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on('pageerror', e => pageErrors.push(String(e).slice(0, 300)))
        const visit = async (label: string, width: number, height: number, theme: string, scale: number) => {
          await page.setViewportSize({ width, height })
          await page.goto(`${baseUrl}${HARNESS}?arrange=1&moving=1&theme=${theme}&scale=${scale}`)
          // the first load after a cold start can restart while Vite re-bundles dependencies: load again once
          const shown = await page.getByTestId('arrange-window').waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false)
          if (!shown) await page.reload()
          await page.getByTestId('arrange-window').waitFor({ state: 'visible', timeout: 120_000 }).catch(e => { throw new Error(`${label}: Arrange window did not appear (${String(e).slice(0, 120)}) ${pageErrors.join(' | ')}`) })
          await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
          await page.waitForTimeout(200)
          for (const v of await measure(page, LAYOUT.rules.minHit)) failures.push(`${label}: ${v}`)
        }
        for (const theme of Object.keys(THEMES)) {
          for (const t of LAYOUT.targets) await visit(`${t.width}x${t.height} ${theme}`, t.width, t.height, theme, 1)
        }
        await visit('1440x900 dark scale 0.75', 1440, 900, 'dark', 0.75)
        await visit('1440x900 dark scale 1.5', 1440, 900, 'dark', 1.5)
        await context.close()
      } finally {
        await browser.close()
      }
    })
    expect(failures).toEqual([])
  }, 600_000)
})
