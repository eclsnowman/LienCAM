// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildViewportContextMenu,
  ViewportContextMenu,
  type ViewportContextAction,
} from '../../components/viewport/ViewportContextMenu'

afterEach(cleanup)

describe('ViewportContextMenu', () => {
  it('builds target-aware commands and dispatches an existing viewport action', () => {
    const items = buildViewportContextMenu(
      { kind: 'part', id: 'part-1', label: 'Bracket' },
      { stock: true, workpiece: true, toolpath: false, grid: true },
    )
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining([
      'Part: Bracket',
      'Open Properties',
      'Hide part',
      'Fit all',
      'Show toolpaths',
      'Hide grid',
    ]))

    const actions: ViewportContextAction[] = []
    const close = vi.fn()
    render(
      <ViewportContextMenu
        at={{ x: 20, y: 30 }}
        target={{ kind: 'part', id: 'part-1', label: 'Bracket' }}
        visibility={{ stock: true, workpiece: true, toolpath: false, grid: true }}
        onAction={(action) => actions.push(action)}
        onClose={close}
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Fit all' }))
    expect(actions).toEqual(['fit-all'])
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps an empty-space menu limited to camera and visibility commands', () => {
    const items = buildViewportContextMenu(
      { kind: 'empty' },
      { stock: false, workpiece: true, toolpath: true, grid: false },
    )
    expect(items.some((item) => item.action === 'open-properties')).toBe(false)
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining([
      'Fit all',
      'Show stock',
      'Hide parts',
      'Hide toolpaths',
      'Show grid',
    ]))
  })
})
