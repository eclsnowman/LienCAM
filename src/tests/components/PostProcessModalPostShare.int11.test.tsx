// @vitest-environment jsdom

import { answerPendingConfirm } from './confirmDialog.support'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostConfig } from '../../lib/post'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const {
  parseUserPostConfig,
  UCCNC_CONFIG,
  userPostDefinitionFilename,
} = await import('../../lib/post')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

const USER_POSTS_KEY = 'liencam.userPosts'
const customPost: PostConfig = {
  ...structuredClone(UCCNC_CONFIG),
  id: 'user-shop-router',
  label: 'Shop / Router: Mk*2',
  builtin: false,
  format: {
    ...structuredClone(UCCNC_CONFIG.format),
    xyzDecimals: 5,
  },
}

let capturedBlobs: Array<{ parts: unknown[]; type: string }>
let capturedFilenames: string[]
let createObjectURL: ReturnType<typeof vi.fn>

function seedNoSetupProject(): void {
  act(() => {
    const current = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: {
        ...current.project,
        name: 'No Setup Project',
        machine: { controller: 'uccnc' },
        setups: [],
        activeSetupId: null,
      },
      consoleEvents: [],
      consoleReadThroughId: 0,
    } as never)
  })
}

beforeEach(() => {
  memory.clear()
  memory.set(USER_POSTS_KEY, JSON.stringify([customPost]))
  capturedBlobs = []
  capturedFilenames = []
  createObjectURL = vi.fn(() => 'blob:post-definition')

  class CapturedBlob {
    parts: unknown[]
    type: string

    constructor(parts: unknown[], options?: { type?: string }) {
      this.parts = parts
      this.type = options?.type ?? ''
      capturedBlobs.push({ parts, type: this.type })
    }
  }

  vi.stubGlobal('Blob', CapturedBlob)
  vi.stubGlobal('URL', {
    createObjectURL,
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureDownload(this: HTMLAnchorElement) {
    capturedFilenames.push(this.download)
  })
  act(() => useCamStore.getState().closeModal())
  seedNoSetupProject()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// The post-definition selector is now the themed custom listbox
// (UI-BRAND-B3-1), not a native <select>. Drive it like a user: click the
// trigger (aria-label "Post definition", testId "post-definition-select") to
// open, then click the option. Value/onChange semantics are unchanged.
function pickPost(id: string) {
  act(() => { fireEvent.click(screen.getByTestId('post-definition-select')) })
  act(() => { fireEvent.click(screen.getByTestId(`post-definition-select-option-${id}`)) })
}

describe('PostProcessModal portable post sharing (INT-11)', () => {
  it('downloads built-in-derived and custom definitions without a CAM setup', () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))

    expect(screen.getByText(/No CAM setup is available/)).not.toBeNull()
    expect(screen.queryByTestId('post-delete-custom')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Share Post...' }))
    expect(capturedFilenames[0]).toBe(userPostDefinitionFilename(UCCNC_CONFIG))
    expect(capturedBlobs[0].type).toBe('application/json')
    const builtInSource = String(capturedBlobs[0].parts[0])
    const builtInRoundTrip = parseUserPostConfig(builtInSource)
    expect(builtInRoundTrip.ok).toBe(true)
    if (builtInRoundTrip.ok) {
      expect(builtInRoundTrip.config.builtin).toBe(false)
      expect(builtInRoundTrip.config.label).toBe(UCCNC_CONFIG.label)
    }

    pickPost(customPost.id)
    expect(screen.getByTestId('post-delete-custom')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Share Post...' }))

    expect(capturedFilenames[1]).toBe('Shop_Router_Mk_2.lienpost.json')
    const customSource = String(capturedBlobs[1].parts[0])
    const customRoundTrip = parseUserPostConfig(customSource)
    expect(customRoundTrip.ok).toBe(true)
    if (customRoundTrip.ok) {
      expect(customRoundTrip.config.builtin).toBe(false)
      expect(customRoundTrip.config.label).toBe(customPost.label)
      expect(customRoundTrip.config.format.xyzDecimals).toBe(5)
    }
    expect(screen.getByRole('status').textContent).toContain('Shop_Router_Mk_2.lienpost.json')
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'success',
      source: 'post',
    })
  })

  it('reports a refused download visibly and through the post console', () => {
    createObjectURL.mockImplementationOnce(() => {
      throw new Error('downloads blocked')
    })
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))

    fireEvent.click(screen.getByRole('button', { name: 'Share Post...' }))

    expect(screen.getByRole('alert').textContent).toContain('downloads blocked')
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'post',
    })
  })

  it('deletes only the selected custom post after confirmation', async () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))

    expect(screen.queryByTestId('post-delete-custom')).toBeNull()
    pickPost(customPost.id)
    fireEvent.click(screen.getByTestId('post-delete-custom'))

    const asked = await answerPendingConfirm(true)
    expect(asked.title).toBe(`Delete saved post "${customPost.label}"?`)
    await waitFor(() => expect(screen.queryByTestId('post-delete-custom')).toBeNull())
    expect(screen.queryByTestId('post-delete-custom')).toBeNull()
    expect(screen.getByTestId('post-definition-select').textContent).toContain(UCCNC_CONFIG.label)
    expect(JSON.parse(memory.get(USER_POSTS_KEY) ?? 'null')).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(`Deleted ${customPost.label}`)
  })
})
