// @vitest-environment jsdom
//
// WO-2252 - Help for the Model screen and Form, with the walkthrough videos:
//   - Form's topics load under Modeling from their own module, and the Form
//     topic has a heading and a picture for every tool group on its rail
//   - a walkthrough plays its video inside Help (from a blob, so the desktop
//     build's file handler serves it too) with its step list beside it
//   - "Open this example" opens the project beside the video the way Open
//     does, closes Help and shows the Model screen
//   - Help opened while Form (or Relief) is open suggests that mode's topics
//     first

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { useCamStore, liveProjectSaveState } = await import('../../store')
const { useHelpOpen, openHelpTopic } = await import('../../help/helpOpen')
const { helpIndexEntry, loadTopic } = await import('../../help/registry')

const FORM_RAIL_GROUPS = ['start-from', 'edit-form', 'topology', 'select', 'openings', 'symmetry', 'display']

function fakeFetch(files: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const body = files[url]
    if (body === undefined) return new Response('Not found', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  })
}

describe('WO-2252: Form and Model help', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
    useHelpOpen.setState({ requested: null, overlay: false })
    URL.createObjectURL = vi.fn(() => 'blob:help-video')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    cleanup()
    globalThis.fetch = realFetch
    document.querySelectorAll('[data-testid="form-palette-shell"]').forEach((e) => e.remove())
  })

  it('Form topics sit under Modeling and the Form topic covers every rail group with a picture', async () => {
    for (const id of ['form-workspace', 'form-walkthrough-lobed-knob', 'form-walkthrough-grip-handle', 'model-relief']) {
      expect(helpIndexEntry(id)?.category, id).toBe('modeling')
    }
    const form = await loadTopic('form-workspace')
    expect(form).not.toBeNull()
    const anchors = form!.sections.flatMap((s) => (s.kind === 'heading' ? [s.anchor] : []))
    const slots = form!.sections.flatMap((s) => (s.kind === 'image' ? [s.slot] : []))
    for (const group of FORM_RAIL_GROUPS) {
      expect(anchors, `heading for ${group}`).toContain(group)
      expect(slots, `picture for ${group}`).toContain(group)
    }
    for (const image of form!.images) expect(image.status, image.slot).toBe('done')
  })

  it('a walkthrough plays its video from a blob inside Help, with the steps beside it', async () => {
    globalThis.fetch = fakeFetch({ '/help/form-walkthrough-lobed-knob/lobed-knob.mp4': 'mp4-bytes' }) as typeof fetch
    render(<HelpCenterModal />)
    act(() => { openHelpTopic('form-walkthrough-lobed-knob') })
    const video = await screen.findByTestId('help-video')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('data-src')).toBe('/help/form-walkthrough-lobed-knob/lobed-knob.mp4')
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:help-video'))
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob
    expect(blob.type).toBe('video/mp4')
    const steps = screen.getByTestId('help-walkthrough-steps')
    expect(steps.closest('[data-testid="help-walkthrough"]')).toBe(video.closest('[data-testid="help-walkthrough"]'))
    expect(steps.querySelectorAll('li').length).toBe(11)
    expect(steps.textContent).toContain('Start from: Cylinder')
  })

  it('"Open this example" opens the project beside the video and shows the Model screen', async () => {
    globalThis.fetch = fakeFetch({
      '/help/form-walkthrough-grip-handle/grip-handle.mp4': 'mp4-bytes',
      '/help/form-walkthrough-grip-handle/grip-handle.camproject': '{"the":"grip project"}',
    }) as typeof fetch
    const opened: string[] = []
    const enter = vi.fn()
    useCamStore.setState({
      loadProjectFromFile: async (json: string) => {
        opened.push(json)
        useCamStore.setState({ project: { ...useCamStore.getState().project, name: 'Grip handle' } })
      },
      enterModelWorkspace: enter,
    })
    render(<HelpCenterModal />)
    act(() => { openHelpTopic('form-walkthrough-grip-handle') })
    fireEvent.click(await screen.findByTestId('help-open-example'))
    await waitFor(() => expect(enter).toHaveBeenCalledTimes(1))
    expect(opened).toEqual(['{"the":"grip project"}'])
    expect(useCamStore.getState().activeModal).toBeNull()
  })

  it('a project that cannot be read is reported the way Open reports it, and Help stays', async () => {
    // Make the unsaved work explicit rather than inheriting a prior mock load.
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.getState().updateProjectMeta({ name: 'Unsaved Help project' })
    })
    expect(liveProjectSaveState()).toBe('unsaved')
    const before = useCamStore.getState().project
    globalThis.fetch = fakeFetch({ '/help/form-walkthrough-grip-handle/grip-handle.mp4': 'mp4-bytes' }) as typeof fetch
    const failed = vi.fn()
    const load = vi.fn()
    useCamStore.setState({ failProjectOpenRead: failed, loadProjectFromFile: load })
    render(<><HelpCenterModal /><ConfirmModal /></>)
    act(() => { openHelpTopic('form-walkthrough-grip-handle') })
    fireEvent.click(await screen.findByTestId('help-open-example'))
    await screen.findByTestId('confirm-dialog')
    expect(useCamStore.getState().project).toBe(before)
    expect(useCamStore.getState().activeModal).toBe('help')
    expect(failed).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/help/form-walkthrough-grip-handle/grip-handle.camproject')
    expect(screen.getByTestId('confirm-dialog-alt').textContent).toBe('Discard')
    fireEvent.click(screen.getByTestId('confirm-dialog-alt'))
    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1))
    expect(failed.mock.calls[0][1]).toBe('error')
    expect(String(failed.mock.calls[0][2])).toContain('grip-handle.camproject')
    expect(load).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModal).toBe('help')
    expect(useCamStore.getState().project).toBe(before)
    expect(globalThis.fetch).toHaveBeenCalledWith('/help/form-walkthrough-grip-handle/grip-handle.camproject')
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(screen.getByTestId('help-center-backdrop').hasAttribute('inert')).toBe(false)
  })

  it('Help opened while Form is open suggests the Form topic first', async () => {
    const palette = document.createElement('aside')
    palette.setAttribute('data-testid', 'form-palette-shell')
    document.body.append(palette)
    useCamStore.setState({ workspace: 'part' })
    render(<HelpCenterModal />)
    act(() => { useCamStore.getState().openModal('help') })
    const suggested = await screen.findByTestId('help-suggested')
    const rows = [...suggested.querySelectorAll('[data-testid^="help-topic-"]')].map((e) => e.getAttribute('data-testid'))
    expect(rows[0]).toBe('help-topic-form-workspace')
    expect(rows.slice(0, 3)).toEqual(['help-topic-form-workspace', 'help-topic-form-walkthrough-lobed-knob', 'help-topic-form-walkthrough-grip-handle'])
  })
})
