// @vitest-environment jsdom
//
// Pure presentational test for BodyListPanel: no session, no THREE, no
// GeomClient -- just props in, callbacks out.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { BodyListPanel, type BodyListEntry } from '../../components/model3d/BodyListPanel'

afterEach(cleanup)

const TWO_BODIES: BodyListEntry[] = [
  { bodyId: 'body-a-leaf', lineageId: 'body-a', name: 'Cut Box', visible: true },
  { bodyId: 'body-b-leaf', lineageId: 'body-b', name: 'Fillet Block', visible: false },
]

describe('BodyListPanel', () => {
  it('renders a row per body with the right name and visibility state', () => {
    render(<BodyListPanel bodies={TWO_BODIES} onToggleVisibility={vi.fn()} onDispose={vi.fn()} />)

    expect(screen.getByText('Cut Box')).not.toBeNull()
    expect(screen.getByText('Fillet Block')).not.toBeNull()
    expect((screen.getByTestId('body-visible-body-a-leaf') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('body-visible-body-b-leaf') as HTMLInputElement).checked).toBe(false)
  })

  it('clicking a visibility checkbox calls onToggleVisibility with the right bodyId', () => {
    const onToggleVisibility = vi.fn()
    render(<BodyListPanel bodies={TWO_BODIES} onToggleVisibility={onToggleVisibility} onDispose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('body-visible-body-b-leaf'))
    expect(onToggleVisibility).toHaveBeenCalledTimes(1)
    expect(onToggleVisibility).toHaveBeenCalledWith('body-b-leaf')
  })

  it('clicking dispose calls onDispose with the right bodyId', () => {
    const onDispose = vi.fn()
    render(<BodyListPanel bodies={TWO_BODIES} onToggleVisibility={vi.fn()} onDispose={onDispose} />)

    fireEvent.click(screen.getByTestId('body-dispose-body-a-leaf'))
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(onDispose).toHaveBeenCalledWith('body-a-leaf')
  })

  it('renders a placeholder when there are no bodies', () => {
    render(<BodyListPanel bodies={[]} onToggleVisibility={vi.fn()} onDispose={vi.fn()} />)
    expect(screen.getByTestId('lab3d-body-list').textContent).toContain('none yet')
  })

  // WO UI-25 (A3 entry-point fix): the embedded variant's per-body color swatch.
  it('embedded variant: onSetColor omitted renders no color control (Lab3DView parity, unchanged)', () => {
    render(<BodyListPanel variant="embedded" bodies={TWO_BODIES} onToggleVisibility={vi.fn()} onDispose={vi.fn()} />)
    expect(screen.queryByTestId('body-color-body-a-leaf')).toBeNull()
  })

  it('embedded variant: onSetColor provided renders a swatch+color input per body', () => {
    render(<BodyListPanel variant="embedded" bodies={TWO_BODIES} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onSetColor={vi.fn()} />)
    expect(screen.getByTestId('body-color-body-a-leaf')).not.toBeNull()
    expect(screen.getByTestId('body-color-input-body-a-leaf')).not.toBeNull()
    expect(screen.getByTestId('body-color-body-b-leaf')).not.toBeNull()
  })

  it('changing the color input calls onSetColor with the bodyId and parsed RGB', () => {
    const onSetColor = vi.fn()
    render(<BodyListPanel variant="embedded" bodies={TWO_BODIES} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onSetColor={onSetColor} />)

    fireEvent.change(screen.getByTestId('body-color-input-body-b-leaf'), { target: { value: '#00ff00' } })
    expect(onSetColor).toHaveBeenCalledTimes(1)
    const [bodyId, color] = onSetColor.mock.calls[0]
    expect(bodyId).toBe('body-b-leaf')
    expect(color[0]).toBeCloseTo(0, 1)
    expect(color[1]).toBeCloseTo(1, 1)
    expect(color[2]).toBeCloseTo(0, 1)
  })

  it("the swatch background reflects the entry's color, defaulting to neutral gray when unset", () => {
    const WITH_COLOR: BodyListEntry[] = [{ bodyId: 'body-c', name: 'Colored Body', visible: true, color: [1, 0, 0] }]
    render(<BodyListPanel variant="embedded" bodies={WITH_COLOR} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onSetColor={vi.fn()} />)
    const swatch = screen.getByTestId('body-color-body-c') as HTMLElement
    // backgroundColor, not the background shorthand: the shorthand resets
    // background-clip (UI-25-R1 audit major, fixed architect-direct at gate)
    expect(swatch.style.backgroundColor).toMatch(/#ff0000|rgb\(255,\s*0,\s*0\)/i)
  })

  it('embedded variant exposes lineage identity while selection targets the live leaf', () => {
    const onSelect = vi.fn()
    render(
      <BodyListPanel
        variant="embedded"
        bodies={TWO_BODIES}
        selectedBodyId="body-b-leaf"
        onSelect={onSelect}
        onToggleVisibility={vi.fn()}
        onDispose={vi.fn()}
      />,
    )

    const first = screen.getByTestId('body-row-body-a-leaf')
    const second = screen.getByTestId('body-row-body-b-leaf')
    expect(first.getAttribute('data-lineage-id')).toBe('body-a')
    expect(first.getAttribute('aria-selected')).toBe('false')
    expect(second.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByText('Cut Box'))
    expect(onSelect).toHaveBeenCalledWith('body-a-leaf')
  })

  // NAV-BODY-ROW: paths 1 (context menu) + 2 (inline icon) -- the reverse leg
  // of UI-EDIT-MODEL-FROM-BODY, gated on the SAME `hasCamRow`/`onShowInCam`
  // pair so the two paths can never disagree about which bodies are navigable.
  describe('NAV-BODY-ROW: Show in CAM (path 1 + path 2)', () => {
    const WITH_CAM_ROW: BodyListEntry[] = [
      { bodyId: 'body-a-leaf', lineageId: 'body-a', name: 'Cut Box', visible: true, hasCamRow: true },
      { bodyId: 'body-b-leaf', lineageId: 'body-b', name: 'Fillet Block', visible: false, hasCamRow: false },
    ]

    it('inline icon: omitted (not disabled) when the body has no CAM row yet', () => {
      render(
        <BodyListPanel variant="embedded" bodies={WITH_CAM_ROW} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onShowInCam={vi.fn()} />,
      )
      expect(screen.getByTestId('body-show-in-cam-body-a-leaf')).not.toBeNull()
      expect(screen.queryByTestId('body-show-in-cam-body-b-leaf')).toBeNull()
    })

    it('inline icon: omitted entirely when onShowInCam is not wired (Lab3DView parity, unchanged)', () => {
      render(<BodyListPanel variant="embedded" bodies={WITH_CAM_ROW} onToggleVisibility={vi.fn()} onDispose={vi.fn()} />)
      expect(screen.queryByTestId('body-show-in-cam-body-a-leaf')).toBeNull()
    })

    it('clicking the inline icon calls onShowInCam with the bodyId', () => {
      const onShowInCam = vi.fn()
      render(
        <BodyListPanel variant="embedded" bodies={WITH_CAM_ROW} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onShowInCam={onShowInCam} />,
      )
      fireEvent.click(screen.getByTestId('body-show-in-cam-body-a-leaf'))
      expect(onShowInCam).toHaveBeenCalledTimes(1)
      expect(onShowInCam).toHaveBeenCalledWith('body-a-leaf')
    })

    it('right-click on a body with a CAM row opens a one-item "Show in CAM" menu, which calls onShowInCam and closes', () => {
      const onShowInCam = vi.fn()
      render(
        <BodyListPanel variant="embedded" bodies={WITH_CAM_ROW} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onShowInCam={onShowInCam} />,
      )
      fireEvent.contextMenu(screen.getByTestId('body-row-body-a-leaf'), { clientX: 40, clientY: 60 })
      const menu = screen.getByTestId('tree-context-menu')
      expect(menu).not.toBeNull()
      // Only the "Show in CAM" item -- no suppress/hide/delete/folder/edit
      // items, since BodyListPanel wires nothing else into TreeContextMenu.
      expect(screen.queryByTestId('tree-context-menu-delete')).toBeNull()
      expect(screen.queryByTestId('tree-context-menu-edit')).toBeNull()

      fireEvent.click(screen.getByTestId('tree-context-menu-show-in-cam'))
      expect(onShowInCam).toHaveBeenCalledTimes(1)
      expect(onShowInCam).toHaveBeenCalledWith('body-a-leaf')
      expect(screen.queryByTestId('tree-context-menu')).toBeNull()
    })

    it('right-click on a body with NO CAM row never opens the menu (no dead-end item)', () => {
      const onShowInCam = vi.fn()
      render(
        <BodyListPanel variant="embedded" bodies={WITH_CAM_ROW} onToggleVisibility={vi.fn()} onDispose={vi.fn()} onShowInCam={onShowInCam} />,
      )
      fireEvent.contextMenu(screen.getByTestId('body-row-body-b-leaf'), { clientX: 40, clientY: 60 })
      expect(screen.queryByTestId('tree-context-menu')).toBeNull()
    })

    it('right-click never opens the menu when onShowInCam is not wired', () => {
      render(<BodyListPanel variant="embedded" bodies={WITH_CAM_ROW} onToggleVisibility={vi.fn()} onDispose={vi.fn()} />)
      fireEvent.contextMenu(screen.getByTestId('body-row-body-a-leaf'), { clientX: 40, clientY: 60 })
      expect(screen.queryByTestId('tree-context-menu')).toBeNull()
    })
  })
})
