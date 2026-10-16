// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size },
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  removeItem: (key: string) => { memory.delete(key) },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
} })
const { useCamStore } = await import('../../store')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const initial = useCamStore.getState()
let downloads: string[]
let blobs: Blob[]

function seed(controller: 'uccnc' | 'grbl' = 'uccnc', id = 'named-project') {
  const tool = makeTool()
  const setups: Setup[] = [54, 55].map((offset, index) => ({
    id: `setup-${index + 1}`, name: `Setup ${index + 1}`, notes: '',
    stock: makeStock(), wcs: makeWcs({ id: `wcs-${offset}`, fixtureOffset: offset, label: `G${offset}` }),
    operations: [makeOp({ id: `op-${index + 1}`, toolId: tool.id })],
  }))
  const project: Project = {
    ...initial.project, id, name: 'Full Suite', machine: makeMachine({ controller }),
    setups, activeSetupId: setups[0].id, toolLibrary: [tool], stocks: [], nests: [],
  }
  for (const setup of setups) stampGenerationCurrent(project, setup, setup.operations[0], tool)
  act(() => useCamStore.setState({ project, toolLibrary: [tool], consoleEvents: [], modelRefsVerifiedSinceLoad: true }))
}
function open() {
  render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
}
function field() { return screen.getByRole('textbox', { name: 'File name' }) as HTMLInputElement }
function typeName(name: string) {
  fireEvent.change(field(), { target: { value: name } })
  fireEvent.blur(field())
}
function separate() {
  fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Separate files (one per setup)' }))
  return screen.getAllByRole('textbox', { name: /^File name -/ }) as HTMLInputElement[]
}
async function exportFiles(count = 1) {
  const button = screen.getByRole('button', { name: /^Export (\.|\d+ files)/ })
  expect((button as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => expect(downloads).toHaveLength(count))
}
function consoleText() { return useCamStore.getState().consoleEvents.filter(e => e.source === 'post').map(e => e.message).join('\n') }

beforeEach(() => {
  memory.clear()
  downloads = []
  blobs = []
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:wo2771' }), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  act(() => useCamStore.setState({ project: initial.project, toolLibrary: initial.toolLibrary, activeModal: null }))
})

describe('WO-2771 operator names the exported file through Post Process', () => {
  it.each(['uccnc', 'grbl'] as const)('keeps the untouched combined %s name byte-identical', async controller => {
    seed(controller)
    open()
    const expected = `Full_Suite.${controller === 'grbl' ? 'gcode' : 'nc'}`
    expect(field().value).toBe(expected)
    await exportFiles()
    expect(downloads).toEqual([expected])
    expect(consoleText()).toContain(expected)
  })
  it('exports the operator name through the browser anchor and console', async () => {
    open()
    typeName('Setup2 roughing')
    expect(field().value).toBe('Setup2 roughing.nc')
    expect(screen.getByRole('button', { name: 'Export .nc' }).getAttribute('data-tooltip')).toBe('Download Setup2 roughing.nc')
    await exportFiles()
    expect(downloads).toEqual(['Setup2 roughing.nc'])
    expect(consoleText()).toContain('Setup2 roughing.nc')
    expect(blobs[0].size).toBeGreaterThan(0)
    expect(useCamStore.getState().project.name).toBe('Full Suite')
  })
  it.each([
    ['a.tap', 'a.tap'], ['a:b', 'a-b.nc'], ['CON', '_CON.nc'],
    ['a<>:"/\\|?*\u0001. ', 'a----------.nc'], ['   ', 'Full_Suite.nc'],
  ])('saves typed %j as %j, displaying the saved name', async (typed, expected) => {
    open()
    typeName(typed)
    expect(field().value).toBe(expected)
    await exportFiles()
    expect(downloads).toEqual([expected])
    expect(consoleText()).toContain(expected)
  })
  it.each(['uccnc', 'grbl'] as const)('passes the typed %s name and program bytes to the desktop Save dialog', async controller => {
    seed(controller)
    const ext = controller === 'grbl' ? 'gcode' : 'nc'
    const hostSave = vi.fn(async (filename: string, _data: string | Uint8Array) => `D:\\NC\\${filename}`)
    vi.stubGlobal('liencamHost', { saveFile: hostSave })
    open()
    typeName('bracket')
    fireEvent.click(screen.getByRole('button', { name: `Export .${ext}` }))
    await waitFor(() => expect(hostSave).toHaveBeenCalledTimes(1))
    expect(hostSave.mock.calls[0]).toEqual([`bracket.${ext}`, expect.stringContaining('G21')])
    expect(downloads).toEqual([])
    expect(consoleText()).toContain(`bracket.${ext}`)
  })
  it.each(['uccnc', 'grbl'] as const)('keeps untouched separate %s names byte-identical', async controller => {
    seed(controller)
    open()
    const fields = separate()
    const ext = controller === 'grbl' ? 'gcode' : 'nc'
    expect(fields.map(input => input.value)).toEqual([`Full_Suite-G54.${ext}`, `Full_Suite-G55.${ext}`])
    await exportFiles(2)
    expect(downloads).toEqual(fields.map(input => input.value))
    for (const name of downloads) expect(consoleText()).toContain(name)
  })
  it.each(['uccnc', 'grbl'] as const)('uses each separate %s name for its own file, retaining names when another setup is deselected', async controller => {
    seed(controller)
    open()
    const fields = separate()
    fireEvent.change(fields[0], { target: { value: 'roughing' } })
    fireEvent.blur(fields[0])
    fireEvent.change(fields[1], { target: { value: 'finish.tap' } })
    fireEvent.blur(fields[1])
    await exportFiles(2)
    expect(downloads).toEqual([`roughing.${controller === 'grbl' ? 'gcode' : 'nc'}`, 'finish.tap'])
    for (const name of downloads) expect(consoleText()).toContain(name)
    // WO-2862: All operations mirrors its setups; unticking Setup 1 leaves Setup 2 alone.
    fireEvent.click(document.querySelectorAll('.scope-setup-cb')[0])
    expect(Array.from(document.querySelectorAll('.scope-setup-cb')).map((cb) => (cb as HTMLInputElement).checked)).toEqual([false, true])
    expect((screen.getByRole('textbox', { name: /^File name -/ }) as HTMLInputElement).value).toBe('finish.tap')
  })
  it.each(['uccnc', 'grbl'] as const)('passes independently typed separate %s files and bytes to the desktop host', async controller => {
    seed(controller)
    const hostSave = vi.fn(async (filename: string, _data: string | Uint8Array) => `D:\\NC\\${filename}`)
    vi.stubGlobal('liencamHost', { saveFile: hostSave })
    open()
    const fields = separate()
    fireEvent.change(fields[0], { target: { value: 'roughing' } })
    fireEvent.blur(fields[0])
    fireEvent.change(fields[1], { target: { value: 'finish.tap' } })
    fireEvent.blur(fields[1])
    fireEvent.click(screen.getByRole('button', { name: 'Export 2 files' }))
    await waitFor(() => expect(hostSave).toHaveBeenCalledTimes(2))
    expect(hostSave.mock.calls).toEqual([
      [`roughing.${controller === 'grbl' ? 'gcode' : 'nc'}`, expect.stringContaining('G54')],
      ['finish.tap', expect.stringContaining('G55')],
    ])
    expect(downloads).toEqual([])
    for (const [name] of hostSave.mock.calls) expect(consoleText()).toContain(name)
  })
  it('retains a name on reopen and by project and combined scope for the app session', () => {
    open()
    typeName('setup one')
    act(() => useCamStore.getState().closeModal())
    act(() => useCamStore.getState().openModal('post-process'))
    expect(field().value).toBe('setup one.nc')
    fireEvent.click(screen.getByRole('checkbox', { name: /^All operations/ }))
    expect(field().value).toBe('Full_Suite.nc')
    typeName('both setups')
    // WO-2862: back to Setup 1 alone by unticking Setup 2 (the master box mirrors its setups).
    fireEvent.click(document.querySelectorAll('.scope-setup-cb')[1])
    expect(field().value).toBe('setup one.nc')
    seed('uccnc', 'other-project')
    expect(field().value).toBe('Full_Suite.nc')
    seed()
    expect(field().value).toBe('setup one.nc')
    expect(JSON.stringify(useCamStore.getState().project)).not.toContain('setup one.nc')
  })
})
