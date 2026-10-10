/**
 * WO-1103: nothing on an auxiliary Control view may fall off the bottom with
 * no way to reach it.
 *
 * Operator, 2026-08-29, on the Machine > Definition tab at 1568x825:
 *   "What the hell happened middle of the page. Bad spacing and a huge waste
 *    of space... it drives things off the bottom. We can never have it off the
 *    bottom, and if it must be due to the amount of info, then there has to be
 *    scroll. Avoid scroll whereever possible. But if it needs it you HAVE to
 *    add the ability. It cannot drop off the page."
 *
 * Measured in his browser before the fix: the definition panel was 612px tall
 * holding 4720px of content, `overflow-y: hidden`, no scrollbar. 4108px -
 * every relay, the encoder and PID blocks, all fifteen pulley ranges - could
 * not be reached at any window size.
 *
 * THIS IS THE SECOND TIME. Operator reported the same class on the Probing tab on
 * 2026-08-21 (WO-411, "the Routines station below never came into view"). That
 * fix was written as
 *
 *     .control-aux-workspace > .control-panel > .panel-body
 *
 * with a child combinator at BOTH steps, so it only reached a panel that is a
 * direct child of the workspace. The Machine tab nests its definition panel one
 * level deeper, the rule missed it, and `.panel { overflow: hidden }` clipped
 * the content silently.
 *
 * So the assertion here is not "the rule exists" - it existed last time and the
 * bug still shipped. It is that the rule CANNOT BE DEPTH-SENSITIVE at the
 * workspace step, because the next panel someone nests will be at a depth
 * nobody predicted.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/styles/app.css', 'utf8')

/** The declaration block for a selector, or null. */
function ruleFor(selector: string): string | null {
  const at = css.indexOf(selector)
  if (at < 0) return null
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return css.slice(open + 1, close)
}

describe('WO-1103 an auxiliary Control panel always has a way to reach its content', () => {
  it('scopes the scrolling body by DESCENDANT, so a nested panel cannot slip past it', () => {
    // The exact shape that let this recur. If it comes back, this fails.
    expect(css).not.toContain('.control-aux-workspace > .control-panel > .panel-body')
    expect(css).toContain('.control-aux-workspace .control-panel > .panel-body')
  })

  it('makes that body an actual scroller, not merely visible', () => {
    const rule = ruleFor('.control-aux-workspace .control-panel > .panel-body')
    expect(rule).toBeTruthy()
    expect(rule).toMatch(/overflow-y:\s*auto/)
    // Without min-height:0 a flex column child refuses to shrink below its
    // content, so the scroller is never shorter than what it holds and never
    // scrolls - it just pushes the overflow out of the panel instead.
    expect(rule).toMatch(/min-height:\s*0/)
  })

  it('still scrolls only its OWN body, never a descendant panel\'s', () => {
    // The second step stays a child combinator on purpose: a panel nested
    // inside another must own its scrolling, or an outer panel scrolls content
    // that belongs to an inner one and the two fight.
    expect(css).toContain('.control-panel > .panel-body')
  })

  it('keeps the generic override that made the clipping silent scoped away from it', () => {
    // `.control-panel > .panel-body { overflow: visible }` is correct for the
    // Main tab, where the COLUMN scrolls. It is what turns an aux panel into a
    // silent clip when the rule above does not reach it, so it must stay
    // ahead of the aux rule in the cascade rather than be deleted.
    const generic = css.indexOf('.control-panel > .panel-body {')
    const aux = css.indexOf('.control-aux-workspace .control-panel > .panel-body')
    expect(generic).toBeGreaterThan(-1)
    expect(aux).toBeGreaterThan(generic)
  })
})
