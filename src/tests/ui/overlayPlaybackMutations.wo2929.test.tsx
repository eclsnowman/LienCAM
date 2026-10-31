// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  drainGuard, getGuardRefusals, getReclassifyPassCount, installOverlayAttachGuard,
  resetGuardRefusals, uninstallOverlayAttachGuard,
} from './support/overlayAttachGuard'

beforeEach(() => {
  document.body.replaceChildren()
  resetGuardRefusals()
})
afterEach(() => {
  uninstallOverlayAttachGuard()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  document.head.querySelectorAll('[data-wo2929]').forEach(node => node.remove())
})
function style(css: string): HTMLStyleElement {
  const element = document.createElement('style')
  element.setAttribute('data-wo2929', '')
  element.textContent = css
  document.head.append(element)
  return element
}
function refused(name: string): boolean {
  return getGuardRefusals().some(refusal => refusal.classes.includes(name))
}

describe('WO-2929 full guard scans without redundant classification', () => {
  it('classifies each document, open/closed nested shadow and iframe element only once per pass', () => {
    const host = document.createElement('div')
    const ordinary = document.createElement('span')
    const frame = document.createElement('iframe')
    document.body.append(host, ordinary, frame)
    const open = host.attachShadow({ mode: 'open' })
    const nestedHost = document.createElement('div')
    open.append(nestedHost)
    // Install before creating CLOSED roots, so the guard records them.
    installOverlayAttachGuard(document)
    const closed = nestedHost.attachShadow({ mode: 'closed' })
    const inner = document.createElement('span')
    closed.append(inner)
    const child = frame.contentDocument!.createElement('span')
    frame.contentDocument!.body.append(child)
    drainGuard()
    const outerSpy = vi.spyOn(window, 'getComputedStyle')
    const childSpy = vi.spyOn(frame.contentDocument!.defaultView!, 'getComputedStyle')
    ordinary.setAttribute('aria-label', 'changed playback label')
    const passes = getReclassifyPassCount()
    drainGuard()
    const counts = [ordinary, host, nestedHost, inner].map(element =>
      outerSpy.mock.calls.filter(([target]) => target === element).length)
    const childCount = childSpy.mock.calls.filter(([target]) => target === child).length
    console.info(JSON.stringify({ mainAndShadowClassifications: counts, iframeClassifications: childCount }))
    expect(getReclassifyPassCount() - passes).toBe(1)
    expect(counts, 'each element needs exactly one classification per full scan').toEqual([1, 1, 1, 1])
    expect(childCount).toBe(1)
    // Deduplication must be local to ONE pass; no stale classification cache.
    inner.style.position = 'fixed'
    child.style.position = 'fixed'
    drainGuard()
    expect(getGuardRefusals().filter(refusal => refusal.position === 'fixed')).toHaveLength(2)
  })

  it('still invalidates on unchanged aria/text writes and catches arbitrary attribute selectors', () => {
    style('[aria-valuetext="00:01"] ~ .aria-target { position: fixed }')
    const slider = document.createElement('input')
    slider.setAttribute('aria-valuetext', '00:00')
    const text = document.createElement('span')
    text.textContent = 'CUT @ 1200.0 mm/min'
    const target = document.createElement('div')
    target.className = 'aria-target'
    document.body.append(slider, text, target)
    installOverlayAttachGuard(document)
    const passes = getReclassifyPassCount()
    slider.setAttribute('aria-valuetext', '00:00')
    text.textContent = 'CUT @ 1200.0 mm/min'
    drainGuard()
    expect(getReclassifyPassCount() - passes).toBe(1)
    expect(refused('aria-target')).toBe(false)
    slider.setAttribute('aria-valuetext', '00:01')
    drainGuard()
    expect(refused('aria-target')).toBe(true)
  })

  it('still catches characterData edits to stylesheet text', () => {
    const sheet = style('.style-target { position: static }')
    const target = document.createElement('div')
    target.className = 'style-target'
    document.body.append(target)
    installOverlayAttachGuard(document)
    expect(refused('style-target')).toBe(false)
    sheet.firstChild!.nodeValue = '.style-target { position: fixed }'
    drainGuard()
    expect(refused('style-target')).toBe(true)
  })

  it('still catches a text replacement crossing an :empty selector boundary', () => {
    style('.empty-source:empty ~ .empty-target { position: fixed }')
    const source = document.createElement('span')
    source.className = 'empty-source'
    source.textContent = 'WCS X 1.000'
    const target = document.createElement('div')
    target.className = 'empty-target'
    document.body.append(source, target)
    installOverlayAttachGuard(document)
    expect(refused('empty-target')).toBe(false)
    source.textContent = ''
    drainGuard()
    expect(refused('empty-target')).toBe(true)
  })
})
