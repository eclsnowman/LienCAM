// WO-3303: the spec 5.1 measurement of the Machine window, shared by the harness layout test and
// the real-shell test. Rules read, on every page including the hosted definition areas: 1 the page
// never scrolls, 2 the window stays inside the screen and no two cards inside it overlap, 3 no
// chrome text is cut off (an ellipsis needs the full text in a tooltip), 4 hit targets are at
// least the minimum. A page that shows no card to compare, or nothing to click, is reported.
import type { Page } from 'playwright'

export async function measure(page: Page, minHit: number): Promise<string[]> {
  return page.evaluate(({ minHit }) => {
    const out: string[] = []
    const root = document.documentElement
    const w = window.innerWidth, h = window.innerHeight
    if (root.scrollWidth > w + 1) out.push(`window scrolls sideways (${root.scrollWidth} > ${w})`)
    if (root.scrollHeight > h + 1) out.push(`window scrolls down (${root.scrollHeight} > ${h})`)
    const win = document.querySelector<HTMLElement>('[data-testid="machine-window"]')
    if (!win) return [...out, 'the Machine window was not found']
    const card = win.querySelector<HTMLElement>('.kit-card') ?? win
    const r = card.getBoundingClientRect()
    if (r.left < -0.5 || r.top < -0.5 || r.right > w + 0.5 || r.bottom > h + 0.5) out.push('the window leaves the screen')
    if (r.width < 1 || r.height < 1) out.push('the window has no area')
    const label = (el: Element) => (el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40)
    const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'

    // rule 2, pairwise: cards inside the window (the page's own cards and any card a hosted area draws)
    // never overlap; a card and the card that holds it are not a pair
    const cards = [...win.querySelectorAll<HTMLElement>('.kit-card')].filter(shown).map(el => ({ el, r: el.getBoundingClientRect() }))
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        if (cards[i].el.contains(cards[j].el) || cards[j].el.contains(cards[i].el)) continue
        const a = cards[i].r, b = cards[j].r
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (dx > 1 && dy > 1) out.push(`card ${label(cards[i].el)} overlaps card ${label(cards[j].el)}`)
      }
    }

    // rules 3 and 4 over everything the window draws, the hosted editors included
    for (const el of win.querySelectorAll<HTMLElement>('*')) {
      if (!shown(el)) continue
      const cs = getComputedStyle(el)
      if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 1) {
        const told = el.hasAttribute('data-tooltip') || el.hasAttribute('aria-label') || el.closest('[data-tooltip]') !== null
        if (cs.textOverflow !== 'ellipsis' || !told) out.push(`text cut off in ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`)
      }
      if (el.matches('button, select, input:not([type="hidden"]), textarea, [role="tab"], a[href]')) {
        const b = el.getBoundingClientRect()
        if (b.width < minHit - 0.5 || b.height < minHit - 0.5) out.push(`hit target ${label(el)} is ${Math.round(b.width)} x ${Math.round(b.height)}`)
      }
    }
    return out
  }, { minHit })
}
