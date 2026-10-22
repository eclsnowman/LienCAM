import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'
import { dismissMachineModal } from '../../../tools/capture/shoot.mjs'

const REPO_ROOT = path.resolve('.')
const PROJECT = path.join(
  REPO_ROOT,
  'src/tests/evidence/MACHINE-SESSION-TWO-SETUP/two-setup.camproject',
)
const VIEWPORT = { width: 1600, height: 950 }

type Measurement = {
  background: string
  className: string
  exempt: 'decorative' | 'disabled' | null
  foreground: string
  label: string
  ratio: number
  required: number
  selector: string
}

type Surface = 'Control' | 'Setup' | 'Toolpath'

async function arrangeSurface(page: Page, surface: Surface): Promise<void> {
  if (surface === 'Control') {
    await page.getByTestId('mode-tab-control').click()
    await page.getByTestId('control-page').waitFor({ state: 'visible', timeout: 30_000 })
    await page.locator('.control-dro-row > .control-dro-axis').first().waitFor({ state: 'visible' })
    return
  }

  await page.getByTestId(`mode-tab-${surface.toLowerCase()}`).click()
  await page.waitForFunction(
    mode => Reflect.get(window, '__camStore')?.getState().viewer.mode === mode,
    surface.toLowerCase(),
  )
  await page.locator('.tree-geo-drag-handle').first().waitFor({ state: 'visible' })
  await page.locator('.tree-op-drag-handle').first().waitFor({ state: 'visible' })
}

async function measureSurface(
  page: Page,
  surface: Surface,
  mode: 'dark' | 'light',
  theme: 'amber' | 'default',
): Promise<Measurement[]> {
  await arrangeSurface(page, surface)
  // Measure settled colours, never a frame mid-transition (1 in 5 alone runs read a 0.1 s fade, 10-09).
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
  await page.evaluate(({ mode, theme }) => {
    const prefs = Reflect.get(window, '__camUiPrefs').getState()
    prefs.setUiTheme(theme)
    prefs.setUiColorMode(mode)
  }, { mode, theme })
  await page.waitForFunction(
    ({ mode, theme }) => document.documentElement.dataset.colorMode === (mode === 'dark' ? undefined : mode)
      && document.documentElement.dataset.theme === (theme === 'default' ? undefined : theme),
    { mode, theme },
  )
  await page.waitForTimeout(150)

  return page.evaluate((surface): Measurement[] => {
    type Rgba = [number, number, number, number]

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas color parser unavailable')
    const cache = new Map<string, Rgba>()
    const parse = (value: string): Rgba => {
      const cached = cache.get(value)
      if (cached) return [...cached]
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const bytes = [...context.getImageData(0, 0, 1, 1).data]
      const color: Rgba = [bytes[0], bytes[1], bytes[2], bytes[3] / 255]
      cache.set(value, color)
      return [...color]
    }
    const over = (front: Rgba, back: Rgba): Rgba => {
      const alpha = front[3] + back[3] * (1 - front[3])
      return [
        (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
        (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
        (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
        alpha,
      ]
    }
    const background = (element: Element): Rgba => {
      let result: Rgba = [255, 255, 255, 1]
      const layers: Rgba[] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color[3] > 0) layers.push(color)
        if (color[3] === 1) break
      }
      for (const layer of layers.reverse()) result = over(layer, result)
      return result
    }
    const luminance = (color: Rgba) => {
      const linear = color.slice(0, 3).map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const contrast = (a: Rgba, b: Rgba) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const cssColor = (color: Rgba) =>
      `rgb(${color.slice(0, 3).map(Math.round).join(', ')})`
    const roots = surface === 'Control'
      ? [...document.querySelectorAll<HTMLElement>('[data-testid="control-page"]')]
      : [...document.querySelectorAll<HTMLElement>('.panel-left, .panel-right')]
    if (roots.length === 0) throw new Error(`${surface} product panel roots did not render`)

    const elements = [...new Set(roots.flatMap(root => [...root.querySelectorAll<HTMLElement>('*')]))]
    return elements.flatMap((element): Measurement[] => {
      const text = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
      if (!text) return []
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0
        || rect.bottom <= 0 || rect.top >= innerHeight
        || rect.right <= 0 || rect.left >= innerWidth) return []
      const chain: HTMLElement[] = []
      for (let node: HTMLElement | null = element; node; node = node.parentElement) chain.push(node)
      const opacity = chain.reduce((value, node) => value * Number(getComputedStyle(node).opacity), 1)
      if (opacity === 0 || chain.some((node) => {
        const style = getComputedStyle(node)
        return style.display === 'none' || style.visibility === 'hidden'
      })) return []

      const style = getComputedStyle(element)
      const back = background(element)
      const color = parse(style.color)
      const foreground = over([color[0], color[1], color[2], color[3] * opacity], back)
      const large = Number.parseFloat(style.fontSize) >= 24
        || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
      const exempt = element.closest(':disabled,[aria-disabled="true"]')
        ? 'disabled'
        : element.closest('[aria-hidden="true"],[role="none"],[role="presentation"]')
          ? 'decorative'
          : null
      const selector = element.getAttribute('data-testid')
        ? `[data-testid="${element.getAttribute('data-testid')}"]`
        : element.classList.length > 0
          ? `.${[...element.classList].join('.')}`
          : element.tagName.toLowerCase()
      return [{
        background: cssColor(back),
        className: element.className,
        exempt,
        foreground: cssColor(foreground),
        label: `${surface}: ${text}`,
        ratio: contrast(foreground, back),
        required: large ? 3 : 4.5,
        selector,
      }]
    })
  }, surface)
}

function assertProductWitnesses(surface: Surface, measurements: Measurement[]): void {
  const has = (className: string, text?: string) => measurements.some(run =>
    run.className.split(' ').includes(className) && (text === undefined || run.label.endsWith(`: ${text}`)),
  )
  if (surface !== 'Control') {
    expect(has('tree-geo-drag-handle'), `${surface} geometry drag handle`).toBe(true)
    expect(has('tree-op-drag-handle'), `${surface} operation drag handle`).toBe(true)
    expect(has('tree-layer-count'), `${surface} layer count`).toBe(true)
    expect(has('tree-setup-cuttime'), `${surface} setup cut time`).toBe(true)
    expect(
      measurements.some(run => run.selector.startsWith('[data-testid="props-height-authority-')),
      `${surface} rendered PropertiesPanel authority`,
    ).toBe(true)
    return
  }

  expect(has('control-dro-work'), 'real Control DRO Work header').toBe(true)
  expect(has('control-dro-machine', 'Machine'), 'real Control DRO Machine header').toBe(true)
  for (const axis of ['X', 'Y', 'Z']) {
    expect(has('control-dro-axis', axis), `real Control DRO ${axis} row label`).toBe(true)
  }
  expect(has('control-ovr-unavailable'), 'real Control unavailable override copy').toBe(true)
}

describe('WO-1296 rendered product panel text contrast', () => {
  it('keeps every enabled readable run at WCAG AA in both identities and modes', async () => {
    await withViteCaptureServer({ port: 4596, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({ viewport: VIEWPORT })
      const pageErrors: string[] = []
      let defaultLightControl: Measurement[] = []
      let defaultLightSetup: Measurement[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForSelector('canvas', { state: 'attached', timeout: 60_000 })
        await dismissMachineModal(page)
        await page.setInputFiles('input[type="file"][accept=".camproject"]', PROJECT)
        await page.waitForFunction(
          () => Reflect.get(window, '__camStore')?.getState().project.setups.length === 2,
          null,
          { timeout: 120_000 },
        )
        await page.getByTestId('project-open-indicator').waitFor({ state: 'detached', timeout: 120_000 })
        await dismissMachineModal(page)
        // WO-2977: the fixture's toolpaths carry camgen-v3 stamps, and WO-2904's contract v4 reopens
        // them as outdated (recompute once, ADR-0040), so the setup cut-time witness has nothing to
        // show until they regenerate. Regenerate through the store, then measure.
        await page.evaluate(() => Reflect.get(window, '__camStore').getState().computeAllToolpaths())
        await page.waitForFunction(
          () => Reflect.get(window, '__camStore')?.getState().project.setups
            .every((setup: { operations: { status: string }[] }) => setup.operations.every(op => op.status === 'ready')),
          null,
          { timeout: 120_000 },
        )
        await page.evaluate(() => {
          const prefs = Reflect.get(window, '__camUiPrefs').getState()
          prefs.setTreeSectionExpanded('geometry', true)
          prefs.setTreeSectionExpanded('stock', false)
          prefs.setTreeSectionExpanded('setups', true)
        })

        for (const theme of ['default', 'amber'] as const) {
          for (const mode of ['dark', 'light'] as const) {
            for (const surface of ['Setup', 'Toolpath', 'Control'] as const) {
              const measurements = await measureSurface(page, surface, mode, theme)
              if (theme === 'default' && mode === 'light' && surface === 'Control') {
                defaultLightControl = measurements
              }
              if (theme === 'default' && mode === 'light' && surface === 'Setup') {
                defaultLightSetup = measurements
              }
              assertProductWitnesses(surface, measurements)
              const failures = measurements.filter(run => !run.exempt && run.ratio < run.required)
              expect(
                failures.map(run =>
                  `${run.label} (${run.selector}): ${run.foreground} on ${run.background} = `
                    + `${run.ratio.toFixed(2)}:1, needs ${run.required}:1`,
                ),
                `${theme} ${mode} ${surface}`,
              ).toEqual([])
            }
          }
        }

        expect(
          defaultLightControl.some(run =>
            run.className.includes('control-jog-label') && run.exempt === 'disabled',
          ),
          'a descendant text run inherits the disabled control exemption',
        ).toBe(true)
        expect(
          defaultLightSetup.find(run => run.className.includes('tree-geo-drag-handle'))?.exempt,
          'the unnamed reorder affordance is not decorative',
        ).toBeNull()
        expect(pageErrors).toEqual([])
      } finally {
        await page.close()
        await browser.close()
      }
    })
  }, 300_000)
})
