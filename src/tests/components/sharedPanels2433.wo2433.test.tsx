// @vitest-environment jsdom
// WO-2433: the Post Process dialog's settings pane and G-code preview pane use
// the shared resizable split and collapse chevron. Drives the real dialog:
// arrow keys + double-click on the bar, folding the preview and reopening it,
// and a reload of the UI preferences bringing size and folded state back.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostProcessModal } from '../../components/modals/PostProcessModal'
import { useCamStore } from '../../store'
import { PERSISTED_USER_DATA_REGISTRY } from '../../store/persistedKeys'
import { useUiPrefs } from '../../store/uiPrefs'
import type { Project } from '../../types'

const originalProject = useCamStore.getState().project
const originalToolLibrary = useCamStore.getState().toolLibrary

const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
const PREF = 'post-process.preview'

const bar = () => screen.getByTestId('post-split-bar')
const previewPaneEl = () => screen.getByTestId('post-gcode-preview').closest('.resizable-split-pane') as HTMLElement

async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

function openDialog() {
  render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
}

describe('WO-2433 Post Process shared panes', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
    const project = JSON.parse(readFileSync(
      resolve('Example Projects/Full Suite.camproject'),
      'utf8',
    )) as Project
    project.activeSetupId = project.setups[0].id
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.setState({ project, toolLibrary: project.toolLibrary } as never)
    })
  })
  afterEach(() => {
    cleanup()
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
    })
    vi.restoreAllMocks()
  })

  it('splits settings and preview with the shared bar at the old 720px default', async () => {
    openDialog()
    await waitFor(() => expect(screen.getByTestId('post-split')).toBeTruthy())
    expect(bar().getAttribute('role')).toBe('separator')
    expect(bar().getAttribute('aria-valuenow')).toBe('720')
    expect(previewPaneEl().style.width).toBe('720px')
    // Every control of the settings pane and the preview head is still there.
    expect(screen.getByTestId('post-definition-select')).toBeTruthy()
    expect(screen.getByText('Output scope')).toBeTruthy()
    expect(screen.getByText('Expand')).toBeTruthy()
    expect(screen.getByText('Diagnostics')).toBeTruthy()
  })

  it('the pane limits grow with the UI scale so 150% settings are never covered', async () => {
    document.documentElement.style.setProperty('--ui-scale', '1.5')
    try {
      openDialog()
      await waitFor(() => expect(screen.getByTestId('post-split')).toBeTruthy())
      expect(bar().getAttribute('aria-valuenow')).toBe('1080')
      expect(bar().getAttribute('aria-valuemin')).toBe('630')
      expect(previewPaneEl().style.width).toBe('1080px')
    } finally {
      document.documentElement.style.removeProperty('--ui-scale')
    }
  })

  it('arrow keys step the bar, double-click resets, and the size survives a reload', async () => {
    openDialog()
    await waitFor(() => expect(screen.getByTestId('post-split')).toBeTruthy())
    // The preview is the right-hand sized pane: the bar moving left widens it.
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
    expect(previewPaneEl().style.width).toBe('728px')
    fireEvent.keyDown(bar(), { key: 'ArrowRight', shiftKey: true })
    expect(previewPaneEl().style.width).toBe('696px')
    expect(useUiPrefs.getState().panelSizes[PREF]).toBe(696)

    await reload()
    expect(useUiPrefs.getState().panelSizes[PREF]).toBe(696)
    expect(previewPaneEl().style.width).toBe('696px')

    fireEvent.doubleClick(bar())
    expect(previewPaneEl().style.width).toBe('720px')
    expect(useUiPrefs.getState().panelSizes[PREF]).toBeUndefined()
  })

  it('the preview folds to its header, keeps the verdict visible, reopens, and stays folded after a reload', async () => {
    openDialog()
    await waitFor(() => expect(screen.getByTestId('post-split')).toBeTruthy())
    expect(screen.getByTestId('post-gcode-preview')).toBeTruthy()

    fireEvent.click(screen.getByTestId('post-preview-collapse'))
    expect(screen.queryByTestId('post-gcode-preview')).toBeNull()
    expect(screen.queryByText('Diagnostics')).toBeNull()
    expect(screen.getByTestId('post-preview-folded-summary').textContent).toMatch(/error\(s\)/)
    // Folded: the bar rests (no separator to drag) but the settings pane stays whole.
    expect(bar().getAttribute('role')).toBeNull()
    expect(screen.getByTestId('post-definition-select')).toBeTruthy()
    // The header (title, Expand, chevron) is still there.
    expect(screen.getByText(/G-code preview/)).toBeTruthy()

    await reload()
    expect(screen.queryByTestId('post-gcode-preview')).toBeNull()

    fireEvent.click(screen.getByTestId('post-preview-collapse'))
    expect(screen.getByTestId('post-gcode-preview')).toBeTruthy()
    expect(screen.getByText('Diagnostics')).toBeTruthy()
    expect(bar().getAttribute('role')).toBe('separator')
  })

  it('the Preview tab shows the preview alone, with no split and no fold', async () => {
    openDialog()
    await waitFor(() => expect(screen.getByTestId('post-split')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByTestId('post-split')).toBeNull()
    expect(screen.queryByTestId('post-preview-collapse')).toBeNull()
    expect(screen.getByTestId('post-gcode-preview')).toBeTruthy()
  })
})
