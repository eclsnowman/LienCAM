// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPref, useToolPaletteLayout, writePref } from '../../components/common/useToolPaletteLayout'
import { DockedPanel } from '../../components/model3d/workbench/DockedPanel'
import { PERSISTED_USER_DATA_REGISTRY, removeRegisteredLocalData } from '../../store/persistedKeys'
import { createShopDataBackup, inspectShopData, restoreShopDataBackup } from '../../store/userSpaceStorage'
import { useUiPrefs } from '../../store/uiPrefs'

const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
const paletteNames = ['rail', 'cam-sketch', 'form-palette', 'relief-palette']

describe('WO-2297 registered palette layout', () => {
  beforeEach(() => { window.localStorage.clear() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it.each(paletteNames)('remembers %s compact and folded groups across remounts without changing another palette', (palette) => {
    const first = renderHook(() => useToolPaletteLayout(palette))
    expect(first.result.current.compact).toBe(false)
    expect(first.result.current.isCollapsed('create')).toBe(false)
    act(() => { first.result.current.toggleCompact(); first.result.current.toggleSection('create') })
    first.unmount()
    const second = renderHook(() => useToolPaletteLayout(palette))
    expect(second.result.current.compact).toBe(true)
    expect(second.result.current.isCollapsed('create')).toBe(true)
    expect(second.result.current.isCollapsed('other')).toBe(false)
    const other = renderHook(() => useToolPaletteLayout('another-palette'))
    expect(other.result.current.compact).toBe(false)
    expect(other.result.current.isCollapsed('create')).toBe(false)
    act(() => { second.result.current.toggleCompact(); second.result.current.toggleSection('create') })
    second.unmount()
    const third = renderHook(() => useToolPaletteLayout(palette))
    expect(third.result.current.compact).toBe(false)
    expect(third.result.current.isCollapsed('create')).toBe(false)
  })

  it('remembers the actual dock fold and unfold across remounts', () => {
    const mount = () => render(<DockedPanel id="form-palette" testId="dock" title="Form"
      icon={null} width={300} onClose={() => {}} closeLabel="Close" closeTestId="close"
      footer={null}>Tools</DockedPanel>)
    mount()
    fireEvent.click(screen.getByTestId('dock-fold'))
    expect(screen.getByTestId('dock').getAttribute('data-folded')).toBe('true')
    cleanup()
    mount()
    expect(screen.getByTestId('dock').getAttribute('data-folded')).toBe('true')
    fireEvent.click(screen.getByTestId('dock-unfold'))
    cleanup()
    mount()
    expect(screen.getByTestId('dock').getAttribute('data-folded')).toBe('false')
  })

  it('drains all existing palette choices without touching other remembered keys', () => {
    window.localStorage.setItem(uiKey, JSON.stringify({ state: { panelLeftWidth: 280 }, version: 1 }))
    window.localStorage.setItem('unrelated', 'keep')
    for (const palette of paletteNames) {
      window.localStorage.setItem(`liencam.${palette}.compact`, 'true')
      window.localStorage.setItem(`liencam.${palette}.collapsed`, '["create",3]')
      window.localStorage.setItem(`liencam.${palette}.dock-folded`, 'true')
    }
    for (const palette of paletteNames) {
      const { result } = renderHook(() => useToolPaletteLayout(palette))
      expect(result.current.compact).toBe(true)
      expect(result.current.isCollapsed('create')).toBe(true)
      expect(readPref(`liencam.${palette}.dock-folded`)).toBe(true)
      for (const setting of ['compact', 'collapsed', 'dock-folded']) {
        expect(window.localStorage.getItem(`liencam.${palette}.${setting}`)).toBeNull()
      }
    }
    expect(JSON.parse(window.localStorage.getItem(uiKey)!).state.panelLeftWidth).toBe(280)
    expect(JSON.parse(window.localStorage.getItem(uiKey)!).version).toBe(1)
    expect(window.localStorage.getItem('unrelated')).toBe('keep')
  })

  it('preserves layout when the already hydrated UI store saves other preferences', async () => {
    await useUiPrefs.persist.rehydrate()
    const first = renderHook(() => useToolPaletteLayout('form-palette'))
    act(() => { first.result.current.toggleSection('create') })
    act(() => { useUiPrefs.getState().setPanelWidth('left', 280) })
    first.unmount()
    const second = renderHook(() => useToolPaletteLayout('form-palette'))
    expect(second.result.current.isCollapsed('create')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(uiKey)!).state.panelLeftWidth).toBe(280)
  })

  it('backs up and restores the hook and dock layout and clears it with the registered UI record', async () => {
    window.localStorage.setItem('liencam.relief-palette.dock-folded', 'true')
    const first = renderHook(() => useToolPaletteLayout('form-palette'))
    act(() => { first.result.current.toggleSection('create') })
    first.unmount()
    const options = { durableStorage: null, legacyStorage: window.localStorage }
    const backup = await createShopDataBackup(options)
    const bundle = JSON.parse(backup.text)
    expect(bundle.content.localRecords[uiKey]).toBeDefined()
    const saved = JSON.parse(bundle.content.localRecords[uiKey])
    expect(saved.state.toolPaletteLayout['liencam.form-palette.collapsed']).toEqual(['create'])
    expect(saved.state.toolPaletteLayout['liencam.relief-palette.dock-folded']).toBe(true)
    const inventory = await inspectShopData(options)
    expect(inventory.collections.find((row) => row.id === 'ui-customization')!.itemCount).toBeGreaterThan(0)
    removeRegisteredLocalData('uiPreferences')
    const cleared = renderHook(() => useToolPaletteLayout('form-palette'))
    expect(cleared.result.current.isCollapsed('create')).toBe(false)
    expect(readPref('liencam.relief-palette.dock-folded')).toBeUndefined()
    cleared.unmount()
    await restoreShopDataBackup(backup.text, options)
    const restored = renderHook(() => useToolPaletteLayout('form-palette'))
    expect(restored.result.current.isCollapsed('create')).toBe(true)
    expect(readPref('liencam.relief-palette.dock-folded')).toBe(true)
  })

  it('includes unopened legacy palettes in backup when UI preferences hydrate at boot', async () => {
    window.localStorage.setItem('liencam.relief-palette.dock-folded', 'true')
    await useUiPrefs.persist.rehydrate()
    const backup = await createShopDataBackup({ durableStorage: null, legacyStorage: window.localStorage })
    const bundle = JSON.parse(backup.text)
    expect(bundle.content.localRecords[uiKey]).toBeDefined()
    expect(JSON.parse(bundle.content.localRecords[uiKey]).state.toolPaletteLayout['liencam.relief-palette.dock-folded']).toBe(true)
  })

  it('keeps defaults for garbled choices and filters non-string folded group ids', () => {
    window.localStorage.setItem('liencam.rail.compact', '{bad')
    window.localStorage.setItem('liencam.rail.collapsed', '["create",3,null]')
    const { result } = renderHook(() => useToolPaletteLayout('rail'))
    expect(result.current.compact).toBe(false)
    expect(result.current.isCollapsed('create')).toBe(true)
    expect(result.current.isCollapsed('other')).toBe(false)
  })

  it('still changes the layout when browser storage throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const { result } = renderHook(() => useToolPaletteLayout('form-palette'))
    expect(result.current.compact).toBe(false)
    act(() => { result.current.toggleCompact(); result.current.toggleSection('create') })
    expect(result.current.compact).toBe(true)
    expect(result.current.isCollapsed('create')).toBe(true)
    expect(() => writePref('liencam.form-palette.dock-folded', true)).not.toThrow()
  })
})
