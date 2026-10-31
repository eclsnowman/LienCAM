// WO-3305 (UI M2 W2-12): the Sketches window in the real New UI, in Chromium, held to spec 5.1:
// the window never scrolls, the dialog stays inside the window, no text is cut off (an ellipsis
// needs its full text in a tooltip), hit targets are at least 20 px after scaling. Every target
// size in all three M1 themes, interface scale 75 % and 150 %, and the four languages.
//
// The model is seeded the way the workbench seeds it: a model session registered for the legacy
// model item, here through the dev server's own module instances. A missing browser FAILS unless
// PW_SKIP_BROWSER=1.
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'
import { LAYOUT, THEMES } from '../../theme/tokens'

const REPO_ROOT = path.resolve('.')
const THEME_KEY = 'liencam.ui2.theme'
const SKIP = process.env.PW_SKIP_BROWSER === '1'

/** Registers a model with one sketch on the XY plane and one on the XZ plane (refused). */
// The page scripts are strings: vitest would rewrite an import() written inside a function.
const SEED_MODEL = `(async () => {
  const { newSeededModelDag } = await import('/src/doc/seedModelArchive.ts')
  const { createModelSession } = await import('/src/doc/modelSession.ts')
  const { registerModelSession } = await import('/src/doc/documentHolder.ts')
  const { ElementMap } = await import('/src/doc/element-map.ts')
  const rect = (prefix, w, h) => {
    const c = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]
    return c.map((p, i) => ({ id: prefix + i, kind: 'line', construction: false, start: p, end: c[(i + 1) % 4] }))
  }
  const sketch = (id, w) => ({ id, layerId: id + '-layer', entities: rect(id, w, 20), constraints: [], dimensions: [], solveStatus: null })
  const dag = newSeededModelDag()
  dag.insertNode({ id: 'sketch3d:top', kind: 'sketch', consumes: ['datum:XY'], payload: { sketch: sketch('top', 40), planeNodeId: 'datum:XY', externalRefs: [], dimensionDiagnostics: [], name: 'Lid outline with a long name for the row' } })
  dag.insertNode({ id: 'sketch3d:side', kind: 'sketch', consumes: ['datum:XZ'], payload: { sketch: sketch('side', 30), planeNodeId: 'datum:XZ', externalRefs: [], dimensionDiagnostics: [], name: 'Side profile' } })
  registerModelSession(createModelSession({ modelItemId: 'legacy', dag, map: new ElementMap() }))
})()`

/** Registers a model with one sketch on the XY plane and one on the XZ plane (refused). */
async function seedModel(page: Page): Promise<void> {
  await page.evaluate(SEED_MODEL)
}

async function setLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate(`import('/src/i18n/index.ts').then((m) => m.applyLanguage(${JSON.stringify(language)}))`)
}

/** Spec 5.1 rules 1 to 4 on the Sketches dialog. */
async function measure(page: Page, minHit: number): Promise<string[]> {
  return page.evaluate((minHit) => {
    const out: string[] = []
    const root = document.documentElement
    const w = window.innerWidth, h = window.innerHeight
    if (root.scrollWidth > w + 1 || root.scrollHeight > h + 1) out.push('window scrolls')
    const dialog = document.querySelector<HTMLElement>('[data-testid="sketch-input-dialog"]')
    if (!dialog || dialog.getClientRects().length === 0) return ['the Sketches dialog is not showing']
    const rows = dialog.querySelectorAll('[data-testid^="sketch-input-row-"]')
    if (rows.length !== 2) out.push(`${rows.length} sketch rows, expected 2`)
    const card = (dialog.querySelector<HTMLElement>('[data-kit="Card"], .kit-card') ?? dialog).getBoundingClientRect()
    if (card.left < -0.5 || card.top < -0.5 || card.right > w + 0.5 || card.bottom > h + 0.5) out.push('the dialog leaves the window')
    const label = (el: Element) => (el.getAttribute('data-testid') ?? el.textContent ?? el.tagName).trim().slice(0, 40)
    for (const el of dialog.querySelectorAll<HTMLElement>('*')) {
      if (el.getClientRects().length === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || el.getAttribute('role') === 'tooltip' || el.closest('[role="tooltip"]')) continue
      if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
        const told = el.hasAttribute('data-tooltip') || el.hasAttribute('title') || el.hasAttribute('aria-label') || el.closest('[data-tooltip]') !== null
        if (cs.textOverflow !== 'ellipsis' || !told) out.push(`text cut off in ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`)
      }
      if (el.matches('button')) {
        const r = el.getBoundingClientRect()
        if (r.width < minHit - 0.5 || r.height < minHit - 0.5) out.push(`hit target ${label(el)} is ${Math.round(r.width)} x ${Math.round(r.height)}`)
      }
    }
    return out
  }, minHit)
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
  await page.waitForTimeout(250)
}

const CLOSE = /^(Close|Schließen|Cerrar|Fermer)$/

async function closeSketches(page: Page): Promise<void> {
  const dialog = page.getByTestId('sketch-input-dialog')
  if (await dialog.count() === 0 || !(await dialog.isVisible())) return
  await dialog.getByRole('button', { name: CLOSE }).first().click()
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
}

async function openSketches(page: Page): Promise<void> {
  await closeSketches(page)
  await page.getByRole('button', { name: /^(Use sketch|Skizze verwenden|Usar boceto|Utiliser l’esquisse)$/ }).first().click()
  await page.getByTestId('sketch-input-dialog').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(150)
}

describe('WO-3305 Sketches window layout', () => {
  it('holds the spec 5.1 rules at every target size, theme, scale end and language', async () => {
    if (SKIP) return
    const failures: string[] = []
    await withViteCaptureServer({ port: 4611, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      let browser: Browser | undefined
      try {
        browser = await chromium.launch({ headless: true })
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        const page = await context.newPage()
        await page.addInitScript(key => { try { localStorage.setItem(key, 'dark') } catch { /* private window */ } }, THEME_KEY)
        const url = new URL(baseUrl)
        url.searchParams.set('newui', '1')
        await page.goto(url.toString())
        await page.getByTestId('ui2-view').waitFor({ state: 'visible', timeout: 120_000 })
        await settle(page)
        await seedModel(page)
        await page.getByTestId('ui2-tab-toolpath').click()
        await page.waitForTimeout(400)
        await openSketches(page)

        const setTheme = (theme: string) => page.getByTestId('ui2-theme-select').locator('select').selectOption(theme)
        const setScale = (scale: string) => page.getByTestId('ui2-scale-select').locator('select').selectOption(scale)
        const resize = async (width: number, height: number) => {
          await page.setViewportSize({ width, height })
          await page.waitForTimeout(200)
        }
        const check = async (what: string) => {
          for (const v of await measure(page, LAYOUT.rules.minHit)) failures.push(`${what}: ${v}`)
        }

        for (const theme of Object.keys(THEMES)) {
          await closeSketches(page)
          await setTheme(theme)
          await openSketches(page)
          for (const t of LAYOUT.targets) {
            await resize(t.width, t.height)
            await check(`${theme} ${t.width}x${t.height}`)
          }
        }
        await closeSketches(page)
        await setTheme('dark')
        const smallest = LAYOUT.targets[0]
        for (const scale of ['0.75', '1.5']) {
          await closeSketches(page)
          await setScale(scale)
          await openSketches(page)
          for (const t of LAYOUT.targets) {
            if (t.width / Number(scale) < smallest.width || t.height / Number(scale) < smallest.height) continue
            await resize(t.width, t.height)
            await check(`dark ${t.width}x${t.height} scale ${scale}`)
          }
        }
        await closeSketches(page)
        await setScale('1')
        for (const language of ['de', 'es', 'fr', 'en']) {
          await setLanguage(page, language)
          await openSketches(page)
          for (const t of [LAYOUT.targets[0], LAYOUT.targets[LAYOUT.targets.length - 1]]) {
            await resize(t.width, t.height)
            await check(`${language} ${t.width}x${t.height}`)
          }
        }
        await context.close()
      } finally {
        await browser?.close()
      }
    })
    expect(failures).toEqual([])
  }, 1_800_000)
})
