// @vitest-environment jsdom
// WO-2432: the Model workbench's feature tree and viewport sit either side of
// the shared ResizableSplit, and the tree folds to its header with the shared
// chevron. Drives the real page: drag, arrow keys, double-click reset,
// collapse + reopen, and a reload of the UI preferences.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => [...memory.keys()][index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, value) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { PERSISTED_USER_DATA_REGISTRY } = await import('../../store/persistedKeys')

const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
const KEY = 'workbench-left-panel'

function pointer(type: string, init: { clientX?: number; pointerId?: number }) {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

async function mount() {
  render(createElement(SolidsWorkbenchPage, {
    embedded: true,
    createClient: createFakeGeomClient,
    createSceneRuntime: () => createFakeSceneRuntime(),
  }))
  await waitFor(() => expect(screen.getByTestId('workbench-split-bar')).toBeTruthy())
}

const bar = () => screen.getByTestId('workbench-split-bar')
const treePane = () => screen.getByTestId('workbench-left-panel').parentElement as HTMLElement

async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

describe('WO-2432 Model workbench shared panels', () => {
  beforeEach(() => {
    memory.clear()
    useCamStore.getState().newProject()
    useCamStore.setState({ workspace: 'part' })
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
  })
  afterEach(() => {
    cleanup()
    useCamStore.setState({ workspace: 'cam' })
  })

  it('starts at the tree\'s long-standing 280px and keeps every tree control', async () => {
    await mount()
    expect(treePane().style.width).toBe('280px')
    expect(screen.getByTestId('workbench-section-model-header')).toBeTruthy()
    expect(screen.getByTestId('workbench-section-bodies-header')).toBeTruthy()
    expect(screen.getByTestId('workbench-left-panel-collapse')).toBeTruthy()
    expect(screen.getByTestId('solids-workbench-canvas')).toBeTruthy()
  })

  it('drags the bar, steps it with arrow keys, resets on double-click, and reloads the size', async () => {
    await mount()
    act(() => { bar().dispatchEvent(pointer('pointerdown', { clientX: 280 })) })
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 340 })) })
    act(() => { window.dispatchEvent(pointer('pointerup', { clientX: 340 })) })
    expect(treePane().style.width).toBe('340px')
    expect(useUiPrefs.getState().panelSizes[KEY]).toBe(340)

    fireEvent.keyDown(bar(), { key: 'ArrowRight' })
    expect(treePane().style.width).toBe('348px')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(treePane().style.width).toBe('316px')

    await reload()
    expect(treePane().style.width).toBe('316px')

    fireEvent.doubleClick(bar())
    expect(treePane().style.width).toBe('280px')
  })

  it('never goes below the tree minimum', async () => {
    await mount()
    fireEvent.keyDown(bar(), { key: 'Home' })
    expect(treePane().style.width).toBe('220px')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(treePane().style.width).toBe('220px')
  })

  it('collapses the tree to its header, reopens it, and remembers the fold across a reload', async () => {
    await mount()
    expect(screen.getByTestId('workbench-section-model-header')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workbench-left-panel-collapse'))
    expect(screen.queryByTestId('workbench-section-model-header')).toBeNull()
    expect(screen.getByTestId('workbench-left-panel-collapse').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('workbench-left-panel')).toBeTruthy()

    await reload()
    expect(screen.queryByTestId('workbench-section-model-header')).toBeNull()

    fireEvent.click(screen.getByTestId('workbench-left-panel-collapse'))
    expect(screen.getByTestId('workbench-section-model-header')).toBeTruthy()
  })
})
