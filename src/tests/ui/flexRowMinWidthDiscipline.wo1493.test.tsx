// WO-1493: three flex rows paired a variable-length, caller-supplied text
// with a fixed, load-bearing companion (a status badge, an action button, a
// measured diameter) and gave neither side the min-width: 0 / flex-shrink: 0
// discipline .props-value.props-resolved-heights already uses elsewhere in
// app.css -- so the browser's default flex behavior pushed the companion off
// (or raw-clipped it) instead of letting the free text truncate or wrap.
// Real layout only exists in a real browser -- jsdom does not compute flex
// geometry -- so these render real markup/components against the real
// stylesheet in headless Chromium and measure actual bounding boxes.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ResizeHoleDialog, type ResizeHoleListRow } from '../../components/model3d/dialogs/ResizeHoleDialog'

const css = `${readFileSync('src/theme/tokens.css', 'utf8')}\n${readFileSync('src/styles/app.css', 'utf8')}`

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 15_000)

afterAll(async () => {
  await browser?.close()
})

describe('WO-1493 flex row min-width discipline', () => {
  it('BUG-435: keeps the RAPID/rate badge fully inside the sim panel at the audited 474px width', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(`
        <style>${css}</style>
        <div class="sim-panel" style="width:474px; position:relative;">
          <div class="sim-controls">
            <button class="sim-btn" aria-label="Rewind to start"></button>
            <button class="sim-btn sim-btn-primary" aria-label="Play"></button>
            <button class="sim-btn" aria-label="Skip to end"></button>
            <div class="sim-speed-group">
              <span class="sim-speed-label">Speed</span>
              <button class="sim-speed-chip" data-testid="sim-speed-chip">1x</button>
            </div>
            <span class="sim-role-badge">
              <span class="sim-position-readout" data-testid="sim-position-readout">WCS X 123.456 Y 45.678 Z -12.345 mm</span>
              <span class="sim-move-readout badge badge-neutral">RAPID @ 6000 mm/min</span>
            </span>
          </div>
        </div>
      `)
      const result = await page.evaluate(() => {
        const panel = document.querySelector('.sim-panel')!.getBoundingClientRect()
        const badge = document.querySelector('.sim-move-readout')!.getBoundingClientRect()
        return {
          panelLeft: panel.left,
          panelRight: panel.right,
          badgeLeft: badge.left,
          badgeRight: badge.right,
          badgeWidth: badge.width,
        }
      })
      // The badge must actually be laid out (non-collapsed) AND fit within
      // the panel's own bounds -- the pre-fix row let it overflow past
      // panelRight instead.
      expect(result.badgeWidth).toBeGreaterThan(0)
      expect(result.badgeLeft).toBeGreaterThanOrEqual(result.panelLeft)
      expect(result.badgeRight).toBeLessThanOrEqual(result.panelRight)
    } finally {
      await page.close()
    }
  })

  it("BUG-448: keeps the full Boolean action text (or an explicit ellipsis, never a mid-word cut) visible and clickable at the sidebar's normal 260px width", async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(`
        <style>${css}</style>
        <div class="panel-right" style="width:260px; box-sizing:border-box;">
          <div class="props-group">
            <div class="props-label" data-tooltip="Boolean an imported mesh against a Model body (approximate result)">Boolean</div>
            <div class="props-value" style="padding:0">
              <button type="button" data-testid="pp-boolean-with-model" style="display:inline-flex;align-items:center;gap:6px;background:transparent;color:var(--text-primary);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:var(--font-size-sm);cursor:pointer;">
                <svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>
                Boolean with model body...
              </button>
            </div>
          </div>
        </div>
      `)
      const result = await page.evaluate(() => {
        const panel = document.querySelector('.panel-right')!.getBoundingClientRect()
        const btn = document.querySelector('button')!
        const rect = btn.getBoundingClientRect()
        const centerHit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          panelRight: panel.right,
          btnRight: rect.right,
          btnWidth: rect.width,
          text: btn.textContent?.trim(),
          clickableAtCenter: centerHit !== null && btn.contains(centerHit),
        }
      })
      // Full accessible name survives regardless of visual truncation --
      // the DOM text is never altered, only its rendering.
      expect(result.text).toBe('Boolean with model body...')
      expect(result.btnWidth).toBeGreaterThan(0)
      expect(result.clickableAtCenter).toBe(true)
      expect(result.btnRight).toBeLessThanOrEqual(result.panelRight)
    } finally {
      await page.close()
    }
  })

  it('BUG-451: keeps the feature class and diameter visible and readable when ownerLabel is a long imported body name', async () => {
    const rows: ResizeHoleListRow[] = [
      {
        ownerId: 'body-1',
        ownerLabel: 'Open CASCADE STEP translator 8.0 1',
        featureKey: 'hole:1:2:3:0:0:1:5',
        featureClass: 'throughHole',
        currentDiameter: 8.5,
      },
    ]
    const markup = renderToStaticMarkup(
      <ResizeHoleDialog rows={rows} onSelect={() => {}} onClose={() => {}} />,
    )
    const page = await browser.newPage()
    try {
      await page.setContent(`<style>${css}</style>${markup}`)
      const result = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="resize-hole-option-0"]')!
        const buttonRect = button.getBoundingClientRect()
        const spans = [...button.querySelectorAll('span')]
        const classSpan = spans[1]
        const diameterSpan = spans[spans.length - 1]
        const diameterRect = diameterSpan.getBoundingClientRect()
        const classRect = classSpan.getBoundingClientRect()
        return {
          buttonRight: buttonRect.right,
          classText: classSpan.textContent,
          classWidth: classRect.width,
          diameterText: diameterSpan.textContent,
          diameterWidth: diameterRect.width,
          diameterRight: diameterRect.right,
        }
      })
      expect(result.classText).toBe('Through hole')
      expect(result.classWidth).toBeGreaterThan(0)
      expect(result.diameterText).toBe('8.5 mm')
      expect(result.diameterWidth).toBeGreaterThan(0)
      // The diameter must stay inside the button's own box -- the pre-fix
      // row let the unbounded owner-label span push it past the edge.
      expect(result.diameterRight).toBeLessThanOrEqual(result.buttonRight)
    } finally {
      await page.close()
    }
  })
})
