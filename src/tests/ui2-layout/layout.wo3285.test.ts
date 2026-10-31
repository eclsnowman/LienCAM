// WO-3285 (UI M2 W1-H): the layout suite for the New UI, in the real app in Chromium. Spec 5.1
// rules, at every target window size, in all three M1 themes and at the interface-scale ends:
//   1 the window never scrolls, 2 cards never overlap and never leave the window, 3 no chrome
//   text is cut off (an ellipsis needs the full text in a tooltip), 4 hit targets are at least
//   20 px after scaling, 6 the clear view keeps its share (50 % of the width, 55 % of the height).
// It runs on the shell (Setup, Toolpath, Control) and on the kit gallery. Rules 5 and 7 (ribbon
// folding, Control module order) belong to the lanes that own those parts.
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'
import { LAYOUT, THEMES } from '../../theme/tokens'

const REPO_ROOT = path.resolve('.')
const THEME_KEY = 'liencam.ui2.theme'
const CLEAR = LAYOUT.rules

interface Measurement {
  readonly violations: readonly string[]
  readonly view: { readonly width: number; readonly height: number } | null
}

/** Measure the page the way an operator sees it: after zoom, in CSS px of the window. */
async function measure(page: Page, minHit: number): Promise<Measurement> {
  return page.evaluate(({ minHit, clearWidth, clearHeight }) => {
    const out: string[] = []
    const root = document.documentElement
    const w = window.innerWidth, h = window.innerHeight
    if (root.scrollWidth > w + 1) out.push(`window scrolls sideways (${root.scrollWidth} > ${w})`)
    if (root.scrollHeight > h + 1) out.push(`window scrolls down (${root.scrollHeight} > ${h})`)
    if (document.body.scrollWidth > w + 1 || document.body.scrollHeight > h + 1) out.push('body scrolls')

    const cards = [...document.querySelectorAll<HTMLElement>('[data-ui2-card]')]
      .filter(el => el.getClientRects().length > 0)
      .map(el => ({ name: el.dataset.ui2Card ?? '?', r: el.getBoundingClientRect() }))
    // a check that measured nothing must not pass: the frame's own cards have to be there
    const names = new Set(cards.map(c => c.name))
    const onControl = document.querySelector('[data-workspace="control"]') !== null
    const expected = document.querySelector('.ui2-gallery') ? ['appbar', 'view'] : onControl ? ['appbar', 'ribbon', 'workspace-control'] : ['appbar', 'ribbon', 'view', 'browser', 'properties']
    for (const n of expected) if (!names.has(n)) out.push(`card ${n} was not found`)
    for (const c of cards) {
      if (c.r.left < -0.5 || c.r.top < -0.5 || c.r.right > w + 0.5 || c.r.bottom > h + 0.5) out.push(`${c.name} leaves the window`)
      if (c.r.width < 1 || c.r.height < 1) out.push(`${c.name} has no area`)
    }
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i].r, b = cards[j].r
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (dx > 1 && dy > 1) out.push(`${cards[i].name} overlaps ${cards[j].name}`)
      }
    }

    const label = (el: Element) => (el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40)
    for (const el of document.querySelectorAll<HTMLElement>('[data-ui2-chrome], [data-ui2-chrome] *')) {
      if (el.getClientRects().length === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden') continue
      const clipsX = cs.overflowX !== 'visible'
      if (clipsX && el.scrollWidth > el.clientWidth + 1) {
        const told = el.hasAttribute('data-tooltip') || el.hasAttribute('aria-label') || el.closest('[data-tooltip]') !== null
        if (cs.textOverflow !== 'ellipsis' || !told) out.push(`text cut off in ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`)
      }
      if (el.matches('button, select, input, [role="tab"], a[href]')) {
        const r = el.getBoundingClientRect()
        if (r.width < minHit - 0.5 || r.height < minHit - 0.5) out.push(`hit target ${label(el)} is ${Math.round(r.width)} x ${Math.round(r.height)}`)
      }
    }

    // the clear view exists where the workspace has one (Control's preview is its own lane's rule 7)
    const view = document.querySelector<HTMLElement>('[data-testid="ui2-view"]')
    let size: { width: number; height: number } | null = null
    if (view && view.getClientRects().length > 0) {
      const r = view.getBoundingClientRect()
      size = { width: Math.round(r.width), height: Math.round(r.height) }
      if (r.width < w * clearWidth) out.push(`clear view is ${size.width} wide, under ${clearWidth * 100} % of ${w}`)
      if (r.height < h * clearHeight) out.push(`clear view is ${size.height} high, under ${clearHeight * 100} % of ${h}`)
    }
    return { violations: out, view: size }
  }, { minHit, clearWidth: CLEAR.clearWidth, clearHeight: CLEAR.clearHeight })
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
  await page.waitForTimeout(250)
}

describe('WO-3285 layout suite', () => {
  it('holds the spec 5.1 rules on the shell and the gallery at every target size and theme', async () => {
    const failures: string[] = []
    await withViteCaptureServer({ port: 4607, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true })
      try {
        for (const route of ['shell', 'gallery'] as const) {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
          const page = await context.newPage()
          await page.addInitScript(key => { try { localStorage.setItem(key, 'dark') } catch { /* private window */ } }, THEME_KEY)
          const url = new URL(baseUrl)
          url.searchParams.set('newui', '1')
          if (route === 'gallery') url.searchParams.set('gallery', '1')
          await page.goto(url.toString())
          await page.getByTestId(route === 'gallery' ? 'ui2-gallery' : 'ui2-view').waitFor({ state: 'visible', timeout: 120_000 })
          await settle(page)

          const check = async (label: string) => {
            const { violations } = await measure(page, CLEAR.minHit)
            for (const v of violations) failures.push(`${route} ${label}: ${v}`)
          }
          const setTheme = (theme: string) => page.getByTestId('ui2-theme-select').locator('select').selectOption(theme)
          const setScale = (scale: string) => page.getByTestId('ui2-scale-select').locator('select').selectOption(scale)
          const resize = async (width: number, height: number) => {
            await page.setViewportSize({ width, height })
            await page.waitForTimeout(200)
          }

          // every theme at every target size, scale 1, the Setup workspace
          await setScale('1')
          for (const theme of Object.keys(THEMES)) {
            await setTheme(theme)
            for (const t of LAYOUT.targets) {
              await resize(t.width, t.height)
              await check(`${theme} ${t.width}x${t.height}`)
            }
          }
          // interface scale at both ends, in the default theme; a window that scale would shrink
          // below the smallest target (1024 x 600 logical) is not a layout the spec asks for
          await setTheme('dark')
          const smallest = LAYOUT.targets[0]
          for (const scale of ['0.75', '1.5']) {
            await setScale(scale)
            for (const t of LAYOUT.targets) {
              if (t.width / Number(scale) < smallest.width || t.height / Number(scale) < smallest.height) continue
              await resize(t.width, t.height)
              await check(`dark ${t.width}x${t.height} scale ${scale}`)
            }
          }
          await setScale('1')
          // the other workspaces use the same frame
          if (route === 'shell') {
            for (const tab of ['toolpath', 'control']) {
              await page.getByTestId(`ui2-tab-${tab}`).click()
              await page.waitForTimeout(400)
              for (const t of LAYOUT.targets) {
                await resize(t.width, t.height)
                await check(`dark ${t.width}x${t.height} ${tab}`)
              }
            }
          }
          await context.close()
        }
      } finally {
        await browser.close()
      }
    })
    expect(failures).toEqual([])
  }, 1_800_000)
})
