import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// Execute the actual Electron handler block, with disk I/O real and only the
// Electron window/dialog shell substituted. No controller process is started.
const main = readFileSync('electron/main.cjs', 'utf8')
const block = main.slice(main.indexOf('// WO-2725 desktop recent projects.'), main.indexOf("ipcMain.on('liencam:set-job-wake-lock'"))
let directory: string
let handlers: Map<string, (...args: any[]) => Promise<any>>
let event: { sender: object }
let dialog: { showOpenDialog: ReturnType<typeof vi.fn>; showSaveDialog: ReturnType<typeof vi.fn> }
function boot() {
  handlers = new Map()
  event = { sender: {} }
  dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
  runInNewContext(block, {
    app: { getPath: () => directory }, path, process, console,
    readFile: promises.readFile, writeFile: promises.writeFile, mkdir: promises.mkdir, rename: promises.rename, statSync: fs.statSync,
    mainWindow: { webContents: event.sender }, dialog,
    ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler) },
  })
}
const call = (name: string, ...args: unknown[]) => handlers.get(`liencam:${name}`)!(event, ...args)
async function add(name: string, thumbnail?: string) {
  const filename = path.join(directory, `${name}.camproject`)
  writeFileSync(filename, JSON.stringify({ name }))
  dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filename] })
  expect((await call('open-project-file')).text).toBe(JSON.stringify({ name }))
  await call('remember-project', { path: filename, name, thumbnail })
  return filename
}
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'wo2725-')); boot() })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
it('keeps ten unique recent paths, most recently opened first, across a host restart', async () => {
  for (let i = 0; i < 12; i++) await add(`project-${i}`)
  let entries = await call('recent-projects')
  expect(entries).toHaveLength(10)
  expect(entries[0].name).toBe('project-11')
  const earlier = entries[4]
  await call('remember-project', earlier)
  boot()
  entries = await call('recent-projects')
  expect(entries).toHaveLength(10)
  expect(entries[0].path).toBe(earlier.path)
})
it('lists cached thumbnails without reading project contents and reports/removes missing paths', async () => {
  const filename = await add('plate', 'data:image/png;base64,YQ==')
  writeFileSync(filename, 'not even JSON: listing must not parse this')
  let entries = await call('recent-projects')
  expect(entries[0].thumbnail).toBe('data:image/png;base64,YQ==')
  expect(entries[0].missing).toBe(false)
  rmSync(filename)
  entries = await call('recent-projects')
  expect(entries[0].missing).toBe(true)
  await expect(call('open-project-file', filename)).rejects.toThrow()
  await call('remove-recent-project', filename)
  expect(await call('recent-projects')).toHaveLength(0)
})
it('rejects ungranted paths and foreign renderers; a cancelled dialog changes nothing', async () => {
  await expect(call('open-project-file', path.join(directory, 'unselected.camproject'))).rejects.toThrow('Browse first')
  await expect(call('remember-project', { path: path.join(directory, 'unselected.camproject'), name: 'forged' })).rejects.toThrow('Browse first')
  dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await call('open-project-file')).toBeNull()
  expect(await call('recent-projects')).toHaveLength(0)
  expect(await handlers.get('liencam:open-project-file')!({ sender: {} })).toBeNull()
})
it('serializes writes and strips unsafe/oversized thumbnail URLs', async () => {
  const a = await add('a', 'https://example.com/spy.png')
  const b = await add('b', `data:image/png;base64,${'A'.repeat(400000)}`)
  await Promise.all([call('remember-project', { path: a, name: 'A' }), call('remember-project', { path: b, name: 'B' })])
  const entries = await call('recent-projects')
  expect(entries.map((item: { name: string }) => item.name)).toEqual(['B', 'A'])
  expect(entries.every((item: { thumbnail?: string }) => item.thumbnail === undefined)).toBe(true)
})
it('recovers a truncated cache without preventing Browse', async () => {
  writeFileSync(path.join(directory, 'recent-projects.json'), '{broken')
  expect(await call('recent-projects')).toHaveLength(0)
  await add('new')
  expect(await call('recent-projects')).toHaveLength(1)
})
it('a successful native Save authorizes its exact path for recents, while Cancel does not', async () => {
  const savedPath = path.join(directory, 'saved.camproject')
  dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: savedPath })
  expect(await call('save-file', 'saved.camproject', '{"name":"Saved"}')).toBe(savedPath)
  await call('remember-project', { path: savedPath, name: 'Saved' })
  expect((await call('recent-projects'))[0].path).toBe(savedPath)
  expect((await call('open-project-file', savedPath)).text).toBe('{"name":"Saved"}')
  const cancelledPath = path.join(directory, 'cancelled.camproject')
  dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: cancelledPath })
  expect(await call('save-file', 'cancelled.camproject', '{}')).toBeNull()
  await expect(call('remember-project', { path: cancelledPath, name: 'Cancelled' })).rejects.toThrow('Browse first')
})
it('About opens only the two requested GitHub links from the trusted window', async () => {
  const openExternal = vi.fn(async () => {})
  const start = main.indexOf("ipcMain.handle('liencam:open-project-link'")
  const end = main.indexOf('// WO-2725 desktop recent projects.', start)
  runInNewContext(main.slice(start, end), {
    mainWindow: { webContents: event.sender }, shell: { openExternal },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler) },
  })
  await call('open-project-link', 'https://github.com/eclsnowman/LienCAM')
  await call('open-project-link', 'https://github.com/eclsnowman/LienCAM/releases')
  expect(openExternal).toHaveBeenCalledTimes(2)
  await expect(call('open-project-link', 'file:///C:/secret')).rejects.toThrow('Unknown project link')
  await handlers.get('liencam:open-project-link')!({ sender: {} }, 'https://github.com/eclsnowman/LienCAM')
  expect(openExternal).toHaveBeenCalledTimes(2)
})
