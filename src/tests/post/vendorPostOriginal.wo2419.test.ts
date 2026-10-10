// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vendorJob } from './fixtures/wo2292/job'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { useCamStore } = await import('../../store')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { ExportModal } = await import('../../components/modals/ExportModal')
const { openExportWindow } = await import('../../lib/exportCenter')
const { importPostFile, parseUserPostConfig, serializeUserPostConfig, syncUserPostControllers, UCCNC_CONFIG } = await import('../../lib/post')

const hostSave = vi.fn<(name: string, data: string | Uint8Array) => Promise<string | null>>()
beforeEach(() => {
  memory.clear()
  syncUserPostControllers([])
  hostSave.mockReset().mockResolvedValue('saved')
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('liencamHost', { saveFile: hostSave })
  act(() => useCamStore.setState({ activeModal: null, consoleEvents: [], project: {
    ...useCamStore.getState().project, machine: { ...useCamStore.getState().project.machine, controller: 'uccnc' },
    setups: [], activeSetupId: null,
  } }))
})
afterEach(() => { cleanup(); syncUserPostControllers([]); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function open() {
  const view = render(createElement(PostProcessModal))
  render(createElement(ExportModal))
  act(() => useCamStore.getState().openModal('post-process'))
  return view
}
async function importThroughPicker(bytes: Uint8Array, filename: string) {
  const file = new NodeFile([bytes], filename)
  await act(async () => { fireEvent.change(screen.getByTestId('post-import-input'), { target: { files: [file] } }) })
  await waitFor(() => expect(JSON.parse(memory.get('liencam.userPosts') ?? '[]')).toHaveLength(1))
}
function pick(id: string) {
  fireEvent.click(screen.getByTestId('post-definition-select'))
  fireEvent.click(screen.getByTestId(`post-definition-select-option-${id}`))
}
async function exportOriginal() {
  const saved = JSON.parse(memory.get('liencam.userPosts')! ) as Array<{ id: string }>
  const rowId = `post:${saved.at(-1)!.id}`
  act(() => { openExportWindow(rowId) })
  fireEvent.click(screen.getByTestId(`export-format-${rowId}`))
  fireEvent.click(screen.getByTestId(`export-format-${rowId}-option-original`))
  await act(async () => { fireEvent.click(screen.getByTestId(`export-save-${rowId}`)) })
}
function sourceBytes(folder: string, filename: string) {
  // Include UTF-8 BOM, CRLF, and a legacy byte that text decoding would lose.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(readFileSync(`src/tests/post/fixtures/${folder}/${filename}`, 'utf8').replace(/\r?\n/g, '\r\n')),
    Buffer.from('\r\n'), Buffer.from([0xe9]), Buffer.from('\r\n')])
}

describe('WO-2419 original vendor post export', () => {
  for (const [folder, filename] of [
    ['wo2292', 'router-mm.pp'], ['wo2292', 'router-mm.cps'],
    ['wo2300', 'router-mm.scpost'], ['wo2300', 'router-mm.pst'],
  ]) {
    it(`exports ${filename} byte-for-byte through the picker and button after reload`, async () => {
      const bytes = sourceBytes(folder, filename)
      open()
      await importThroughPicker(bytes, filename)
      const [{ id }] = JSON.parse(memory.get('liencam.userPosts')!)
      act(() => { openExportWindow(`post:${id}`) })
      const button = screen.getByTestId(`export-save-post:${id}`)
      expect(button.previousElementSibling?.textContent).toBe('JSON')
      await exportOriginal()
      expect(hostSave).toHaveBeenLastCalledWith(filename, expect.any(Uint8Array))
      // Independent Node byte reader, rather than the production base64 decoder.
      expect(Buffer.from(hostSave.mock.calls.at(-1)![1] as Uint8Array)).toEqual(bytes)
      const [saved] = JSON.parse(memory.get('liencam.userPosts')!)
      cleanup()
      syncUserPostControllers([])
      open()
      pick(saved.id)
      await exportOriginal()
      expect(Buffer.from(hostSave.mock.calls.at(-1)![1] as Uint8Array)).toEqual(bytes)
      expect(hostSave.mock.calls.at(-1)![0]).toContain(filename)
    })
  }

  it('keeps original bytes after editor changes, Save Post As, and portable sharing', async () => {
    const bytes = sourceBytes('wo2292', 'router-mm.pp')
    const project = vendorJob()
    act(() => useCamStore.setState({ project, toolLibrary: project.toolLibrary }))
    open()
    await importThroughPicker(bytes, 'My original.PP')
    fireEvent.click(screen.getByRole('button', { name: /Output \/ Format/ }))
    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '6' } })
    vi.spyOn(window, 'prompt').mockReturnValue('Edited copy')
    fireEvent.click(screen.getByRole('button', { name: 'New / Save Post As...' }))
    await exportOriginal()
    expect(hostSave).toHaveBeenLastCalledWith('My original.PP', expect.any(Uint8Array))
    expect(Buffer.from(hostSave.mock.calls.at(-1)![1] as Uint8Array)).toEqual(bytes)
    const saved = JSON.parse(memory.get('liencam.userPosts')!)[1]
    expect(saved.label).toBe('Edited copy')
    expect(saved.format.xyzDecimals).toBe(6)
    const portable = parseUserPostConfig(serializeUserPostConfig(saved))
    expect(portable.ok).toBe(true)
    if (!portable.ok) return
    expect(Buffer.from(portable.config.originalVendorPost!.bytesBase64, 'base64')).toEqual(bytes)
  })

  it('downloads the original bytes and filename through the browser save route', async () => {
    vi.stubGlobal('liencamHost', undefined)
    let captured: Blob | undefined
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => { captured = blob; return 'blob:original-post' },
      revokeObjectURL: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('router-mm.cps')
    })
    const bytes = sourceBytes('wo2292', 'router-mm.cps')
    open()
    await importThroughPicker(bytes, 'router-mm.cps')
    await exportOriginal()
    expect(click).toHaveBeenCalledOnce()
    expect(Buffer.from(await captured!.arrayBuffer())).toEqual(bytes)
  })

  it('keeps built-ins and older saved posts usable without an original control', () => {
    const old = { ...structuredClone(UCCNC_CONFIG), id: 'old', builtin: false }
    memory.set('liencam.userPosts', JSON.stringify([old]))
    open()
    expect(screen.queryByRole('button', { name: 'Export original...' })).toBeNull()
    pick('old')
    expect(screen.queryByRole('button', { name: 'Export original...' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Share Post...' })).not.toBeNull()
    act(() => { openExportWindow() })
    for (const id of [UCCNC_CONFIG.id, 'old']) {
      const row = screen.getByTestId(`export-row-post:${id}`)
      expect(row.querySelector('[role="combobox"]')).toBeNull()
      expect(screen.getByTestId(`export-save-post:${id}`)).not.toBeNull()
    }
  })

  it('does not report success when desktop saving is cancelled or fails', async () => {
    open()
    await importThroughPicker(sourceBytes('wo2292', 'router-mm.pp'), 'router-mm.pp')
    hostSave.mockResolvedValueOnce(null)
    await exportOriginal()
    expect(screen.queryByRole('status')).toBeNull()
    expect(useCamStore.getState().consoleEvents.filter(event => event.severity === 'success' && event.source === 'export')).toEqual([])
    hostSave.mockRejectedValueOnce(new Error('disk full'))
    await exportOriginal()
    expect(useCamStore.getState().consoleEvents.at(-1)?.message).toContain('disk full')
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({ severity: 'warning', source: 'export' })
  })

  it('preserves the text-only import API and validates carried source bytes', () => {
    const source = readFileSync('src/tests/post/fixtures/wo2292/router-mm.pp', 'utf8')
    const imported = importPostFile(source, 'router-mm.pp')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(Buffer.from(imported.config.originalVendorPost!.bytesBase64, 'base64')).toEqual(Buffer.from(source))
    expect(parseUserPostConfig(serializeUserPostConfig(imported.config))).toMatchObject({ ok: true, config: imported.config })
    const invalid = { ...imported.config, originalVendorPost: { filename: 'router-mm.pp', bytesBase64: 'broken%' } }
    expect(parseUserPostConfig(JSON.stringify(invalid))).toMatchObject({ ok: false })
    const json = serializeUserPostConfig(UCCNC_CONFIG)
    expect(importPostFile(json, 'post.lienpost.json')).toEqual(parseUserPostConfig(json))
  })
})
