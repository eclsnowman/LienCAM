// WO-1491: bare native <input>/<select> fell through to the browser's
// white-background/black-text default wherever a call site skipped its own
// styling (RevolveDialog's angle NumericInput + profile fallback select,
// DraftDialog's offset/angle NumericInputs + pull-axis select). Renders the
// real dialogs via Playwright/Chromium (jsdom does not resolve var()-based
// computed style reliably - see lightModeComponentGround.wo1255.test.tsx and
// toolDiagramGround.wo1258.test.tsx for the same pattern) and asserts each
// control's computed background-color/color match the app's dark surface
// tokens, not the UA default.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RevolveDialog } from '../../components/model3d/dialogs'
import { DraftDialog } from '../../components/model3d/dialogs/DraftDialog'
import { CommandHistory, FeatureDag } from '../../doc'

const css = `${readFileSync('src/theme/tokens.css', 'utf8')}\n${readFileSync('src/styles/app.css', 'utf8')}`

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) }, 15_000)
afterAll(async () => { await browser?.close() })

function revolveMarkup(): string {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1' } })
  const history = new CommandHistory(dag)
  const markup = renderToStaticMarkup(
    createElement(RevolveDialog, {
      dag,
      history,
      mode: 'create',
      sketchOptions: [{ id: 'SK1', label: 'Sketch SK1' }],
      onApplied: () => {},
      onClose: () => {},
    }),
  )
  // The profile fallback <select> lives behind a collapsed <details>
  // ("Choose profile by name fallback"); force it open so the computed
  // style below reflects what an operator who expands it actually sees.
  return markup.replace('<details>', '<details open="">')
}

function draftMarkup(): string {
  const dag = new FeatureDag()
  const history = new CommandHistory(dag)
  return renderToStaticMarkup(
    createElement(DraftDialog, {
      dag,
      history,
      mode: 'create',
      ownerId: 'F1',
      faceIds: ['face1'],
      onApplied: () => {},
      onClose: () => {},
    }),
  )
}

async function fieldStyles(markup: string, selectors: Record<string, string>) {
  const page = await browser.newPage()
  try {
    await page.setContent(`<style>${css}</style>${markup}`)
    return await page.evaluate((sel) => {
      document.documentElement.dataset.colorMode = 'dark'
      const probeBg = document.createElement('div')
      probeBg.style.backgroundColor = 'var(--surface-input)'
      document.body.append(probeBg)
      const probeFg = document.createElement('span')
      probeFg.style.color = 'var(--text-primary)'
      document.body.append(probeFg)
      const expected = {
        background: getComputedStyle(probeBg).backgroundColor,
        color: getComputedStyle(probeFg).color,
      }
      const found: Record<string, { background: string; color: string }> = {}
      for (const [name, selector] of Object.entries(sel)) {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`Selector not found: ${selector}`)
        const style = getComputedStyle(el)
        found[name] = { background: style.backgroundColor, color: style.color }
      }
      return { expected, found }
    }, selectors)
  } finally {
    await page.close()
  }
}

describe('WO-1491 native control theme fallback', () => {
  it('themes RevolveDialog angle NumericInput and profile select fallback dark, not browser-default white', async () => {
    const { expected, found } = await fieldStyles(revolveMarkup(), {
      angle: '[data-testid="revolve-angle"] input',
      select: '[data-testid="revolve-profile-select"]',
    })
    for (const [name, style] of Object.entries(found)) {
      expect(style.background, `${name} background`).toBe(expected.background)
      expect(style.color, `${name} color`).toBe(expected.color)
      expect(style.background, `${name} background must not be browser-default white`).not.toBe('rgb(255, 255, 255)')
      expect(style.color, `${name} color must not be browser-default black`).not.toBe('rgb(0, 0, 0)')
    }
  })

  it('themes DraftDialog offset/angle NumericInputs and pull-axis select dark, not browser-default white', async () => {
    const { expected, found } = await fieldStyles(draftMarkup(), {
      offset: '[data-testid="draft-offset"] input',
      angle: '[data-testid="draft-angle"] input',
      select: '[data-testid="draft-pull-axis"]',
    })
    for (const [name, style] of Object.entries(found)) {
      expect(style.background, `${name} background`).toBe(expected.background)
      expect(style.color, `${name} color`).toBe(expected.color)
      expect(style.background, `${name} background must not be browser-default white`).not.toBe('rgb(255, 255, 255)')
      expect(style.color, `${name} color must not be browser-default black`).not.toBe('rgb(0, 0, 0)')
    }
  })
})
