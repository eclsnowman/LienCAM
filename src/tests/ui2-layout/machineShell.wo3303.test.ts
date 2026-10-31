// WO-3303 (UI M2 W2-10): the Machine window in the REAL New UI shell (?newui=1), not the harness.
// The window is opened through its own state (the app bar draws today's status chip until the
// shell draws registered app bar items), and held to spec 5.1 (rules 1 to 4, see machineMeasure.wo3303.ts) at the six target sizes in the three M1
// themes and at interface scale 75 % and 150 %, on the Library, Overview and Machine pages, and in
// every shipped language (de, es, fr) with no unresolved key on screen.
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'
import { LAYOUT, THEMES } from '../../theme/tokens'
import { measure } from './machineMeasure.wo3303'

const REPO_ROOT = path.resolve('.')
const THEME_KEY = 'liencam.ui2.theme'
const PAGES = ['library', 'overview', 'machine', 'spindle', 'outputs', 'probing', 'controller', 'allSettings'] as const
const LANGUAGES = ['en', 'de', 'es', 'fr'] as const

describe('WO-3303 machine window in the real shell', () => {
  it('holds the spec 5.1 rules in every theme, size, scale and language, with the window opened', async () => {
    const failures: string[] = []
    const seen = { shell: 0, windows: 0 }
    const navText = new Map<string, string>()
    await withViteCaptureServer({ port: 4609, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        const page = await context.newPage()
        await page.addInitScript(key => { try { localStorage.setItem(key, 'dark') } catch { /* private window */ } }, THEME_KEY)
        const url = new URL(baseUrl)
        url.searchParams.set('newui', '1')
        await page.goto(url.toString())
        await page.getByTestId('ui2-view').waitFor({ state: 'visible', timeout: 120_000 })
        seen.shell++
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })

        // the app's own modules, by URL: a string, so the test runner does not rewrite the import
        const setLanguage = (language: string) => page.evaluate(`import('/src/store/uiPrefs.ts').then(m => m.useUiPrefs.getState().setLanguage(${JSON.stringify(language)}))`)
        const showPage = (name: string) => page.evaluate(`import('/src/ui2/machine/windowState.ts').then(m => m.setMachinePage(${JSON.stringify(name)}))`)
        const setTheme = (theme: string) => page.getByTestId('ui2-theme-select').locator('select').selectOption(theme)
        const setScale = (scale: string) => page.getByTestId('ui2-scale-select').locator('select').selectOption(scale)
        const keysOnScreen = (p: Page) => p.evaluate(() => (document.querySelector('[data-testid="machine-window"]')?.textContent ?? '').match(/[a-z0-9-]+\.wo\d+[:.][A-Za-z]+/g) ?? [])

        const open = async () => {
          await page.evaluate("import('/src/ui2/machine/windowState.ts').then(m => m.openMachineWindow())")
          await page.getByTestId('machine-window').waitFor({ state: 'visible', timeout: 30_000 })
          seen.windows++
        }
        const check = async (label: string) => {
          for (const v of await measure(page, LAYOUT.rules.minHit)) failures.push(`${label}: ${v}`)
          for (const k of await keysOnScreen(page)) failures.push(`${label}: unresolved text key ${k}`)
        }

        await setScale('1')
        await open()
        for (const theme of Object.keys(THEMES)) {
          await setTheme(theme)
          for (const name of PAGES) {
            await showPage(name)
            for (const t of LAYOUT.targets) {
              await page.setViewportSize({ width: t.width, height: t.height })
              await page.waitForTimeout(120)
              await check(`${theme} ${name} ${t.width}x${t.height}`)
            }
          }
        }
        const smallest = LAYOUT.targets[0]
        for (const scale of ['0.75', '1.5']) {
          await setScale(scale)
          for (const theme of Object.keys(THEMES)) {
            await setTheme(theme)
            for (const name of PAGES) {
              await showPage(name)
              for (const t of LAYOUT.targets) {
                if (t.width / Number(scale) < smallest.width || t.height / Number(scale) < smallest.height) continue
                await page.setViewportSize({ width: t.width, height: t.height })
                await page.waitForTimeout(120)
                await check(`${theme} ${name} ${t.width}x${t.height} scale ${scale}`)
              }
            }
          }
        }
        await setTheme('dark')
        await setScale('1')
        for (const language of LANGUAGES) {
          await setLanguage(language)
          await page.waitForTimeout(300)
          navText.set(language, await page.locator('[data-testid="machine-window"] .kit-window-nav').innerText())
          for (const name of PAGES) {
            await showPage(name)
            for (const t of LAYOUT.targets) {
              await page.setViewportSize({ width: t.width, height: t.height })
              await page.waitForTimeout(120)
              await check(`${language} ${name} ${t.width}x${t.height}`)
            }
          }
        }
        await context.close()
      } finally {
        await browser.close()
      }
    })
    // a run that never found the shell or the window must not pass
    expect(seen.shell).toBe(1)
    expect(seen.windows).toBe(1)
    // the language switch really changed the words: four languages, four different navs
    expect(new Set(navText.values()).size).toBe(LANGUAGES.length)
    expect(failures).toEqual([])
  }, 1_800_000)

  it('keeps today\'s machine editor reachable in the shell: from the status chip and from the window\'s Edit details', async () => {
    const seen = { shell: 0, chipEditor: 0, windowEditor: 0 }
    await withViteCaptureServer({ port: 4610, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
        const url = new URL(baseUrl)
        url.searchParams.set('newui', '1')
        await page.goto(url.toString())
        await page.getByTestId('ui2-view').waitFor({ state: 'visible', timeout: 120_000 })
        seen.shell++
        // today's editor, the one with the profile import in it
        const editor = page.getByTestId('machine-library-import')
        await page.getByTestId('machine-status-chip').click()
        seen.chipEditor += await editor.waitFor({ state: 'visible', timeout: 8_000 }).then(() => 1, () => 0)
        await page.keyboard.press('Escape')
        await page.evaluate("import('/src/ui2/machine/windowState.ts').then(m => m.openMachineWindow())")
        await page.getByTestId('machine-window').waitFor({ state: 'visible', timeout: 30_000 })
        await page.getByTestId('machine-library-editor').click()
        seen.windowEditor += await editor.waitFor({ state: 'visible', timeout: 8_000 }).then(() => 1, () => 0)
      } finally {
        await browser.close()
      }
    })
    expect(seen).toEqual({ shell: 1, chipEditor: 1, windowEditor: 1 })
  }, 300_000)
})
