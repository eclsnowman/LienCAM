// @vitest-environment jsdom
//
// WO-3293 (UI M2 polish of WO-3278): every unavailable gallery example says a reason that fits its
// own control, and an unavailable Slider has the same dashed edge as the other unavailable parts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { INPUT_GALLERY } from '../../components/kit/inputs/gallery'
import { hasMessage, resolveMessage } from '../../notices'

const CSS = readFileSync(join(__dirname, '..', '..', 'components/kit/inputs/kit-inputs.css'), 'utf8')
const ENTER_A_NUMBER = resolveMessage('sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber')
const PARTS = ['NumberField', 'TextField', 'Select', 'Segmented', 'Toggle', 'Slider']

afterEach(cleanup)

const unavailable = INPUT_GALLERY.filter(e => e.state === 'unavailable')

describe('WO-3293 gallery reasons', () => {
  it('has one unavailable example per part', () => {
    expect(unavailable.map(e => e.part)).toEqual(PARTS)
  })

  it.each(PARTS)('%s: the reason is its own and is not the number-entry sample', part => {
    const ex = unavailable.find(e => e.part === part)!
    const { container } = render(<div data-ui2="">{ex.element}</div>)
    const tip = container.querySelector('[role="tooltip"]')
    expect(tip, part).not.toBeNull()
    expect(tip!.textContent).not.toBe('')
    expect(tip!.textContent).not.toBe(ENTER_A_NUMBER)
  })

  it('no two parts share a reason, and each reason is a real catalogue message', () => {
    const texts: string[] = []
    for (const ex of unavailable) {
      const { container, unmount } = render(<div data-ui2="">{ex.element}</div>)
      const text = container.querySelector('[role="tooltip"]')!.textContent!
      expect(text, ex.part).toMatch(/\s/) // words, not an unresolved key
      texts.push(text)
      unmount()
    }
    expect(new Set(texts).size).toBe(PARTS.length)
    expect(hasMessage('probing-screens:probeRoutineEditor97')).toBe(true)
  })
})

describe('WO-3293 unavailable Slider edge', () => {
  it('gets the dashed edge in the same rule as the other unavailable fields', () => {
    const rule = CSS.split('}').map(b => b.trim()).find(b => b.includes('.kit-slider[data-unavailable]') && /border:\s*1px dashed var\(--b1\)/.test(b))
    expect(rule).toBeDefined()
    expect(rule).toContain('.kit-select[data-unavailable]')
  })

  it('keeps the slider the same size ready or unavailable (a transparent edge when ready)', () => {
    const base = CSS.split('}').map(b => b.trim()).find(b => /\[data-ui2\] \.kit-slider \{/.test(b))
    expect(base).toMatch(/border:\s*1px solid transparent/)
    expect(base).toMatch(/box-sizing:\s*border-box/)
  })
})
