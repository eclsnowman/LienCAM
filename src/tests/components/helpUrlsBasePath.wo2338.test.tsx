// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HelpCenterModal } from '../../components/modals/HelpCenterModal'
import { openHelpTopic, useHelpOpen } from '../../help/helpOpen'
import { useCamStore } from '../../store'

const originalStore = useCamStore.getState()

beforeEach(() => {
  useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
  useHelpOpen.setState({ requested: null, overlay: false })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('asset bytes')))
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:help-video')
    static revokeObjectURL = vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useCamStore.setState(originalStore)
})

describe.each(['/', '/LienCAM/app/', './'])('WO-2338 Help URLs with base %s', (base) => {
  it('uses the base for the picture and its enlarged view', async () => {
    vi.stubEnv('BASE_URL', base)
    render(<HelpCenterModal />)
    act(() => openHelpTopic('form-workspace'))
    const enlarge = await screen.findByRole('button', { name: /^Enlarge Start from:/ })
    const image = enlarge.querySelector('img')!
    expect(image.getAttribute('src')).toBe(`${base}help/form-workspace/start-from.webp`)
    fireEvent.click(enlarge)
    expect(screen.getByTestId('help-image-lightbox-image').getAttribute('src')).toBe(image.getAttribute('src'))
  })

  it('fetches the video and opens the adjacent example on the Model screen', async () => {
    vi.stubEnv('BASE_URL', base)
    const load = vi.fn(async (_json: string) => {
      useCamStore.setState({ project: { ...useCamStore.getState().project, name: 'Opened example' } })
    })
    const enter = vi.fn(async () => {})
    useCamStore.setState({ loadProjectFromFile: load, enterModelWorkspace: enter })
    render(<HelpCenterModal />)
    act(() => openHelpTopic('form-walkthrough-lobed-knob'))
    const video = await screen.findByTestId('help-video')
    expect(video.getAttribute('data-src')).toBe(`${base}help/form-walkthrough-lobed-knob/lobed-knob.mp4`)
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:help-video'))
    expect(fetch).toHaveBeenCalledWith(`${base}help/form-walkthrough-lobed-knob/lobed-knob.mp4`)
    const button = screen.getByTestId('help-open-example')
    expect(button.getAttribute('data-project')).toBe(`${base}help/form-walkthrough-lobed-knob/lobed-knob.camproject`)
    fireEvent.click(button)
    await waitFor(() => expect(enter).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledWith(`${base}help/form-walkthrough-lobed-knob/lobed-knob.camproject`)
    expect(load.mock.calls[0][0]).toBe('asset bytes')
    expect(useCamStore.getState().activeModal).toBeNull()
  })
})
