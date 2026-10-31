// @vitest-environment jsdom
//
// WO-3285 (UI M2 W1-H): the New UI test-drive shell. The frame (app bar, workspace tabs, ribbon,
// Browser and Properties cards, view, strip) is built from the layout rules of spec 5.1; the
// workspace tabs drive today's store actions; theme and scale switch live; the kit gallery
// answers at ?newui=1&gallery=1. Today's panels are stood in for here: the shell hosts them
// unchanged (src/ui2/shell/hosts.tsx), and the Playwright suite in src/tests/ui2-layout/ shows
// them in the real frame.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { KIT_PARTS } from '../../components/kit'
import { LAYOUT, THEMES } from '../../theme/tokens'
import { useCamStore } from '../../store'
import { frameMetrics } from '../../ui2/shell/layout'
import { Ui2Shell } from '../../ui2/shell'

vi.mock('../../ui2/shell/hosts', async () => {
  const { createElement: h } = await import('react')
  const { typedMock } = await import('../support/typedMock')
  const stand = (id: string) => () => h('div', { 'data-testid': id })
  return typedMock<typeof import('../../ui2/shell/hosts')>({
    BrowserHost: stand('host-browser'),
    PropertiesHost: stand('host-properties'),
    ConsoleHost: stand('host-console'),
    MachineStatusHost: () => h('span', { 'data-testid': 'host-machine-status' }),
    ViewportHost: ({ suspended }: { suspended: boolean; resetKey: string }) => h('div', { 'data-testid': 'host-viewport', 'data-suspended': suspended }),
    ModelWorkspaceHost: stand('host-model'),
    ControlWorkspaceHost: stand('host-control'),
    WindowHosts: stand('host-windows'),
    useAppWiring: () => {},
  })
})

/** The kit Select puts its test id on the field; the control an operator changes is the select inside. */
function pickerSelect(testId: string): HTMLSelectElement {
  return within(screen.getByTestId(testId)).getByRole('combobox') as HTMLSelectElement
}

const TAB_ORDER = ['setup', 'sketch', 'model', 'toolpath', 'simulate', 'control']

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/?newui=1')
  useCamStore.setState({ workspace: 'cam', activeModal: null, viewer: { ...useCamStore.getState().viewer, mode: 'setup' } })
})
afterEach(cleanup)

describe('WO-3285 frame metrics (spec 5.1)', () => {
  it('follows the class rules at every target size', () => {
    const at = (w: number, h: number) => frameMetrics(w, h)
    expect(LAYOUT.targets).toHaveLength(6)
    // Compact (under 1280): the Browser is a 44 px rail, Properties 280, search folds; short under 760 tall
    const touch = at(1024, 600)
    expect(touch.sizeClass).toEqual({ width: 'compact', short: true })
    expect(touch).toMatchObject({ browserRailed: true, browserWidth: LAYOUT.compact.rail, propertiesWidth: LAYOUT.compact.properties, searchFolded: true, groupBand: LAYOUT.short.groupBand, strip: LAYOUT.short.strip, groupCaptions: false })
    // Regular: default widths; 720 tall is short, 768 is not
    expect(at(1280, 720)).toMatchObject({ browserRailed: false, browserWidth: 264, propertiesWidth: 316, groupBand: 72, groupCaptions: false })
    expect(at(1366, 768)).toMatchObject({ browserWidth: 264, propertiesWidth: 316, groupBand: 86, strip: 44, groupCaptions: true, searchFolded: false })
    expect(at(1440, 900).sizeClass).toEqual({ width: 'regular', short: false })
    // Wide: Browser 300, Properties 360
    expect(at(1920, 1080)).toMatchObject({ browserWidth: LAYOUT.wide.browser, propertiesWidth: LAYOUT.wide.properties })
    expect(at(2560, 1440).sizeClass.width).toBe('wide')
  })

  it('reads the class after interface scale, so 75 % lays a 1024 x 600 panel out as 1365 x 800', () => {
    const scaled = frameMetrics(1024, 600, 0.75)
    expect(scaled.sizeClass).toEqual({ width: 'regular', short: false })
    expect(scaled.browserRailed).toBe(false)
    // and 1.5 on 2560 x 1440 is the 1707 x 960 regular layout
    expect(frameMetrics(2560, 1440, 1.5).sizeClass.width).toBe('regular')
  })
})

describe('WO-3285 shell frame', () => {
  it('draws the five parts of spec 5 around today\'s panels', () => {
    render(<Ui2Shell />)
    expect(screen.getByTestId('ui2-appbar')).toBeTruthy()
    expect(screen.getByTestId('ui2-ribbon')).toBeTruthy()
    const browser = screen.getByTestId('ui2-card-browser')
    const props = screen.getByTestId('ui2-card-properties')
    expect(within(browser).getByTestId('host-browser')).toBeTruthy()
    expect(within(props).getByTestId('host-properties')).toBeTruthy()
    expect(within(screen.getByTestId('ui2-view')).getByTestId('host-viewport')).toBeTruthy()
    expect(within(screen.getByTestId('ui2-strip')).getByTestId('host-console')).toBeTruthy()
    expect(screen.getByTestId('host-windows')).toBeTruthy()
    expect(screen.getByTestId('host-machine-status')).toBeTruthy()
  })

  it('lists the workspace tabs flat, in the shipped order, each with its number key', () => {
    render(<Ui2Shell />)
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab')
    expect(tabs.map(t => t.getAttribute('data-testid'))).toEqual(TAB_ORDER.map(id => `ui2-tab-${id}`))
    expect(tabs.map(t => t.getAttribute('data-key'))).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(screen.getByTestId('ui2-tab-setup').getAttribute('aria-selected')).toBe('true')
  })

  it('tabs drive the same store actions as the shipped tab strip', () => {
    render(<Ui2Shell />)
    const state = () => useCamStore.getState()
    fireEvent.click(screen.getByTestId('ui2-tab-toolpath'))
    expect(state().viewer.mode).toBe('toolpath')
    expect(screen.getByTestId('ui2-tab-toolpath').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByTestId('ui2-tab-simulate'))
    expect(state().viewer.mode).toBe('simulation')
    fireEvent.click(screen.getByTestId('ui2-tab-control'))
    expect(state().workspace).toBe('control')
    expect(screen.getByTestId('host-control')).toBeTruthy()
    expect(screen.getByTestId('ui2-tab-control').getAttribute('aria-selected')).toBe('true')
    // any CAM tab is the way back from Control
    fireEvent.click(screen.getByTestId('ui2-tab-setup'))
    expect(state().workspace).toBe('cam')
    expect(state().viewer.mode).toBe('setup')
    // the Model tab offers New model first, exactly like the shipped tab
    fireEvent.click(screen.getByTestId('ui2-tab-model'))
    expect(state().activeModal).toBe('new-model')
    expect(state().workspace).toBe('cam')
    // the Sketch tab is the selection-aware entry
    const enter = vi.fn()
    useCamStore.setState({ enterSketchWorkspace: enter })
    fireEvent.click(screen.getByTestId('ui2-tab-sketch'))
    expect(enter).toHaveBeenCalledOnce()
  })

  it('number keys 1 to 6 pick a workspace, never while typing or with a window open', () => {
    render(<Ui2Shell />)
    fireEvent.keyDown(document.body, { key: '4' })
    expect(useCamStore.getState().viewer.mode).toBe('toolpath')
    const field = document.createElement('input')
    document.body.appendChild(field)
    fireEvent.keyDown(field, { key: '5' })
    expect(useCamStore.getState().viewer.mode).toBe('toolpath')
    field.remove()
    act(() => useCamStore.setState({ activeModal: 'settings' }))
    fireEvent.keyDown(document.body, { key: '5' })
    expect(useCamStore.getState().viewer.mode).toBe('toolpath')
  })

  it('shows each workspace\'s own ribbon group with the real actions', () => {
    render(<Ui2Shell />)
    fireEvent.click(screen.getByTestId('ui2-ribbon-new-setup'))
    expect(useCamStore.getState().activeModal).toBe('new-setup')
    act(() => useCamStore.setState({ activeModal: null }))
    fireEvent.click(screen.getByTestId('ui2-tab-toolpath'))
    expect(screen.queryByTestId('ui2-ribbon-new-setup')).toBeNull()
    fireEvent.click(screen.getByTestId('ui2-ribbon-new-operation'))
    expect(useCamStore.getState().activeModal).toBe('new-operation')
    act(() => useCamStore.setState({ activeModal: null }))
    fireEvent.click(screen.getByTestId('ui2-ribbon-post'))
    expect(useCamStore.getState().activeModal).toBe('post-process')
  })

  it('opens libraries and settings as windows from the app bar, not as tabs', () => {
    render(<Ui2Shell />)
    const bar = screen.getByTestId('ui2-appbar')
    fireEvent.click(within(bar).getByTestId('ui2-open-tool-library'))
    expect(useCamStore.getState().activeModal).toBe('tool-library')
    fireEvent.click(within(bar).getByTestId('ui2-open-settings'))
    expect(useCamStore.getState().activeModal).toBe('settings')
  })

  it('the Show card flips the viewer flags the viewport already reads', () => {
    render(<Ui2Shell />)
    const card = screen.getByTestId('ui2-showcard')
    fireEvent.click(within(card).getByRole('button', { expanded: false }))
    const before = useCamStore.getState().viewer.showGrid
    fireEvent.click(within(card).getByRole('checkbox', { name: /Grid/ }))
    expect(useCamStore.getState().viewer.showGrid).toBe(!before)
  })

  it('the View cube asks the viewport camera for the picked view', () => {
    const setCameraView = vi.fn()
    Object.assign(window, { __cncViewport: { setCameraView } })
    render(<Ui2Shell />)
    fireEvent.click(within(screen.getByTestId('ui2-viewcube')).getByRole('button', { name: /^Front$/ }))
    expect(setCameraView).toHaveBeenCalledWith('front')
    Reflect.deleteProperty(window, '__cncViewport')
  })
})

describe('WO-3285 themes and scale', () => {
  it('switches theme live and keeps it for the next load', () => {
    const { unmount } = render(<Ui2Shell />)
    const root = screen.getByTestId('ui2-shell')
    expect(root.hasAttribute('data-ui2')).toBe(true)
    expect(root.getAttribute('data-ui2-theme')).toBe('dark')
    const select = pickerSelect('ui2-theme-select')
    expect([...select.options].map(o => o.value)).toEqual(Object.keys(THEMES))
    fireEvent.change(select, { target: { value: 'light' } })
    expect(root.getAttribute('data-ui2-theme')).toBe('light')
    fireEvent.change(select, { target: { value: 'amber' } })
    expect(root.getAttribute('data-ui2-theme')).toBe('amber')
    unmount()
    render(<Ui2Shell />)
    expect(screen.getByTestId('ui2-shell').getAttribute('data-ui2-theme')).toBe('amber')
  })

  it('ignores a stored theme or scale it does not know', () => {
    localStorage.setItem('liencam.ui2.theme', 'neon')
    localStorage.setItem('liencam.ui2.scale', '7')
    render(<Ui2Shell />)
    const root = screen.getByTestId('ui2-shell')
    expect(root.getAttribute('data-ui2-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--ui2-scale')).toBe('1')
  })

  it('scales every size together from 75 % to 150 % and Auto', () => {
    render(<Ui2Shell />)
    const root = screen.getByTestId('ui2-shell')
    const select = pickerSelect('ui2-scale-select')
    expect([...select.options].map(o => o.value)).toEqual(['auto', '0.75', '0.8', '0.9', '1', '1.25', '1.5'])
    fireEvent.change(select, { target: { value: '0.75' } })
    expect(root.style.getPropertyValue('--ui2-scale')).toBe('0.75')
    fireEvent.change(select, { target: { value: '1.5' } })
    expect(root.style.getPropertyValue('--ui2-scale')).toBe('1.5')
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(root.style.getPropertyValue('--ui2-scale')).toBe('1')
  })
})

describe('WO-3285 kit gallery route', () => {
  it('shows one section for every kit part at ?newui=1&gallery=1', () => {
    window.history.replaceState(null, '', '/?newui=1&gallery=1')
    render(<Ui2Shell />)
    const gallery = screen.getByTestId('ui2-gallery')
    for (const part of KIT_PARTS) expect(within(gallery).getByTestId(`ui2-gallery-part-${part}`)).toBeTruthy()
    expect(screen.queryByTestId('ui2-card-browser')).toBeNull()
    // the gallery wears the same theme switch, so every theme can be looked at
    fireEvent.change(pickerSelect('ui2-theme-select'), { target: { value: 'light' } })
    expect(screen.getByTestId('ui2-shell').getAttribute('data-ui2-theme')).toBe('light')
  })
})

describe('WO-3285 leaving the New UI', () => {
  it('the Classic UI button turns the switch off for the next load', async () => {
    const { NEW_UI_STORAGE_KEY } = await import('../../ui2/newUiSwitch')
    localStorage.setItem(NEW_UI_STORAGE_KEY, '1')
    render(<Ui2Shell />)
    fireEvent.click(screen.getByTestId('ui2-classic-ui'))
    expect(localStorage.getItem(NEW_UI_STORAGE_KEY)).toBe('0')
  })
})
