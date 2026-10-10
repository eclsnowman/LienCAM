// WO-1496 / BUG-483: .props-op-title and .props-disclosure .disclosure-header
// are both `position: sticky; top: 0` inside the SAME Properties panel scroll
// container, distinguished only by z-index (6 vs 5). Once the panel is
// scrolled far enough that both are in their stuck state, the higher-stacked
// op-title paints directly over the disclosure header beneath it, and
// elementFromPoint at the toggle's visual center resolves to the title, not
// the button - a real browser hit-test/paint defect jsdom cannot see, so
// this drives real markup against the real stylesheet in headless Chromium.
import { readFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const css = `${readFileSync('src/theme/tokens.css', 'utf8')}\n${readFileSync('src/styles/app.css', 'utf8')}`

// Mirrors the real Properties panel structure (PropertiesPanel.tsx's
// .props-op-title banner followed by a CollapsibleGroup / DisclosureSection
// rendering .props-disclosure > button.disclosure-header + .disclosure-body)
// with enough filler above the Heights section that scrolling to the
// audited 500px offset lands with both headers in their stuck state, and
// enough body below it that the section itself hasn't scrolled past.
function panelMarkup(): string {
  // The panel's height must come from its FLEX PARENT (as in the real app;
  // .panel-body's own class carries `flex: 1`), not an inline height on
  // panel-body itself -- flex-basis overrides an inline height on a flex
  // item, which would silently make the scroll container grow to fit all
  // content (no overflow, nothing to scroll) instead of clipping at 700px.
  return `
    <div class="panel properties-panel" style="width:280px; height:744px; display:flex; flex-direction:column;">
      <div class="panel-header"><span class="panel-title">Properties</span></div>
      <div class="panel-body" data-testid="props-scroll">
        <div class="props-section props-section-op">
          <div class="props-group-header props-op-title" data-tooltip="Contour 1">Contour 1</div>
          <div class="props-group" data-testid="props-filler" style="height:400px;">earlier properties groups</div>
          <div class="disclosure-section props-disclosure">
            <button type="button" class="disclosure-header" data-testid="props-group-heights" aria-expanded="true">
              <span class="disclosure-chevron" aria-hidden="true">v</span>
              <span class="disclosure-title">Heights</span>
            </button>
            <div class="disclosure-body" data-testid="heights-body" style="height:800px;">Top / bottom height rows</div>
          </div>
        </div>
      </div>
    </div>
    <script>
      document.querySelector('[data-testid="props-group-heights"]').addEventListener('click', () => {
        const body = document.querySelector('[data-testid="heights-body"]')
        body.hidden = !body.hidden
        window.__wo1496Clicked = true
      })
    </script>
  `
}

// Mirrors PropertiesPanel.tsx's no-title views (GeometryProperties /
// ModelItemProperties, ~line 1660 / ~line 2186): a `.props-section` with a
// `.props-disclosure` group but NO `.props-op-title` sibling. These headers
// must keep sticking flush at the scroll container's top edge, exactly as
// on main - the audit caught a regression where the WO-1496 fix pushed them
// 28px down instead, exposing already-scrolled rows above them.
function noTitlePanelMarkup(): string {
  return `
    <div class="panel properties-panel" style="width:280px; height:744px; display:flex; flex-direction:column;">
      <div class="panel-header"><span class="panel-title">Properties</span></div>
      <div class="panel-body" data-testid="props-scroll">
        <div class="props-section">
          <div class="props-group" data-testid="props-filler" style="height:400px;">earlier geometry rows (e.g. layer rows)</div>
          <div class="disclosure-section props-disclosure">
            <button type="button" class="disclosure-header" data-testid="props-group-layers" aria-expanded="true">
              <span class="disclosure-chevron" aria-hidden="true">v</span>
              <span class="disclosure-title">Layers (40)</span>
            </button>
            <div class="disclosure-body" data-testid="layers-body" style="height:800px;">Layer rows</div>
          </div>
        </div>
      </div>
    </div>
  `
}

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 15_000)

afterAll(async () => {
  await browser?.close()
})

describe('WO-1496 sticky Properties headers do not paint over each other', () => {
  it('BUG-483: the disclosure toggle stays hit-testable and clickable beneath the sticky op title at the audited 500px scroll offset', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    try {
      await page.setContent(`<style>${css}</style>${panelMarkup()}`)
      await page.evaluate(() => {
        document.querySelector('[data-testid="props-scroll"]')!.scrollTop = 500
      })

      const before = await page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="props-group-heights"]') as HTMLElement
        const rect = toggle.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const hit = document.elementFromPoint(cx, cy)
        return {
          cx,
          cy,
          resolvesToToggle: hit === toggle || (hit !== null && toggle.contains(hit)),
          hitClass: hit ? (hit as HTMLElement).className : null,
        }
      })
      expect(before.resolvesToToggle, `hit-test resolved to "${before.hitClass}" instead of the toggle`).toBe(true)

      await page.mouse.click(before.cx, before.cy)
      const clicked = await page.evaluate(() => (window as unknown as { __wo1496Clicked?: boolean }).__wo1496Clicked === true)
      expect(clicked, 'click at the toggle center did not reach its click handler').toBe(true)

      const bodyHiddenAfterClick = await page.evaluate(() =>
        (document.querySelector('[data-testid="heights-body"]') as HTMLElement).hidden)
      expect(bodyHiddenAfterClick, 'clicking the toggle should have collapsed the section').toBe(true)
    } finally {
      await page.close()
    }
  })

  it('keeps both headers correctly stacked with no visual jump on re-scroll', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    try {
      await page.setContent(`<style>${css}</style>${panelMarkup()}`)
      const scroller = page.locator('[data-testid="props-scroll"]')

      const measure = () => page.evaluate(() => {
        const title = document.querySelector('.props-op-title')!.getBoundingClientRect()
        const header = document.querySelector('.disclosure-header')!.getBoundingClientRect()
        return { titleTop: title.top, titleBottom: title.bottom, headerTop: header.top }
      })

      await scroller.evaluate((el) => { el.scrollTop = 500 })
      const stuck = await measure()
      // Stuck: header sits below the title with no overlap.
      expect(stuck.headerTop).toBeGreaterThanOrEqual(stuck.titleBottom)

      await scroller.evaluate((el) => { el.scrollTop = 0 })
      const atTop = await measure()
      expect(atTop.headerTop).toBeGreaterThanOrEqual(atTop.titleBottom)

      await scroller.evaluate((el) => { el.scrollTop = 500 })
      const restuck = await measure()
      // Re-stuck at the exact same position as before - no visual jump.
      expect(restuck.titleTop).toBe(stuck.titleTop)
      expect(restuck.headerTop).toBe(stuck.headerTop)
      expect(restuck.headerTop).toBeGreaterThanOrEqual(restuck.titleBottom)
    } finally {
      await page.close()
    }
  })

  it('leaves the disclosure header flush at the panel top in no-title views (geometry, model-item)', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    try {
      await page.setContent(`<style>${css}</style>${noTitlePanelMarkup()}`)

      const stickyTop = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.props-disclosure .disclosure-header') as HTMLElement).top)
      expect(stickyTop, 'a no-title section header must stick at the container top, not 28px below it').toBe('0px')

      await page.evaluate(() => {
        document.querySelector('[data-testid="props-scroll"]')!.scrollTop = 500
      })

      const hit = await page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="props-scroll"]') as HTMLElement
        const scrollerTop = scroller.getBoundingClientRect().top
        // 10px below the scroller's own top edge, matching the audit's
        // reproduction: on a regressed build this lands on an
        // already-scrolled-past filler row instead of the stuck header.
        const el = document.elementFromPoint(scroller.getBoundingClientRect().left + 10, scrollerTop + 10)
        return el ? el.closest('[data-testid]')?.getAttribute('data-testid') ?? el.className : null
      })
      expect(hit).toBe('props-group-layers')
    } finally {
      await page.close()
    }
  })
})
