// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Icon } from '../../components/kit/actions/icon'
import { Button, RibbonGroup } from '../../components/kit'
import { UI2_ICON_IDS, ui2IconSvg } from '../../components/icons/ui2'

afterEach(cleanup)

describe('WO-3318 kit icon', () => {
  it('renders the shipped SVG for every known id inside the reserved box', () => {
    for (const id of UI2_ICON_IDS) {
      const { container, unmount } = render(<Icon id={id} />)
      const slot = container.querySelector('.kit-icon')!
      const svg = slot.querySelector('svg')
      expect(svg, id).not.toBeNull()
      expect(svg!.getAttribute('viewBox'), id).toBe('0 0 48 48')
      const expected = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      expected.innerHTML = ui2IconSvg(id)
      expect(svg!.innerHTML, id).toBe(expected.innerHTML)
      expect(slot.getAttribute('aria-hidden')).toBe('true')
      expect(svg!.getAttribute('focusable')).toBe('false')
      unmount()
    }
  })

  it('keeps unknown ids as empty reserved boxes, including object prototype names', () => {
    for (const id of ['no-such-icon', 'constructor', '__proto__', 'toString']) {
      const { container, unmount } = render(<Icon id={id} />)
      const slot = container.querySelector('.kit-icon')!
      expect(slot.getAttribute('data-icon')).toBe(id)
      expect(slot.childNodes).toHaveLength(0)
      expect(slot.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }
  })

  it('uses the same slot in big, small and icon button forms and ribbons', () => {
    const { container } = render(<RibbonGroup caption="Draw">
      {(['big', 'small', 'icon'] as const).map(form => <Button key={form} kind="momentary" form={form} icon="line" label="Line" onPress={() => {}} />)}
      <Button kind="momentary" icon="no-such-icon" label="Missing" onPress={() => {}} />
    </RibbonGroup>)
    expect(container.querySelectorAll('.kit-icon')).toHaveLength(4)
    expect(container.querySelectorAll('.kit-icon svg')).toHaveLength(3)
    expect(container.querySelectorAll('.kit-button-label')).toHaveLength(3)
  })
})

