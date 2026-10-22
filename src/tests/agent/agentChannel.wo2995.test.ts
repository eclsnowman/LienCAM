// WO-2995 (WO-2951 Order C): the Electron request channel, both sides.
//
// The main side is the real electron/agentChannel.cjs with a fake ipcMain and
// window; the renderer side is the real rendererBridge on the real model
// registry and a real ModelSession. The fake preload host is the same shape as
// electron/preload.cjs `liencamHost.agent`. Journey in the real Electron app:
// src/tests/evidence/WO-2995/proof-plan.json.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElementMap, FeatureDag, createModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { modelCommands } from '../../lib/agent/commands'
import { createAgentRequestHandler, installAgentBridge, type AgentHost } from '../../lib/agent/rendererBridge'

const require = createRequire(import.meta.url)
const { createAgentChannel } = require('../../../electron/agentChannel.cjs') as {
  createAgentChannel: (options: unknown) => { request: (command: string, args?: unknown, options?: unknown) => Promise<any> }
}

function openModel() {
  const session = createModelSession({
    modelItemId: LEGACY_MODEL_ITEM_ID,
    dag: new FeatureDag(),
    map: new ElementMap(),
    kernelOp: async () => ({ ok: true, diagnostics: [] }),
  })
  registerModelSession(session)
  return session
}

/** main <-> page, wired like Electron: ipcMain.handle + webContents.send + the preload host. */
function wire(options: { commands?: Parameters<typeof installAgentBridge>[1] extends infer O ? O : never; timeoutMs?: number } = {}) {
  const handlers = new Map<string, (event: { sender: unknown }, ...args: any[]) => unknown>()
  const listeners = new Set<(request: unknown) => void>()
  const webContents = { send: (_channel: string, message: unknown) => { for (const l of listeners) l(message) } }
  const window = { webContents, isDestroyed: () => false }
  const channel = createAgentChannel({
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    getWindow: () => window,
    timeoutMs: options.timeoutMs,
  })
  const host: AgentHost = {
    onRequest: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    respond: (id, result) => handlers.get('liencam:agent-response')!({ sender: webContents }, id, result),
  }
  const uninstall = installAgentBridge(host, options.commands)
  return { channel, host, handlers, webContents, uninstall }
}

beforeEach(() => { resetDocumentHolder() })
afterEach(() => { resetDocumentHolder(); vi.useRealTimers() })

describe('WO-2995 request reaches the registry and returns its exact result', () => {
  it('success: model.parameter.set through the channel equals what the registry returns', async () => {
    const session = openModel()
    const { channel } = wire()
    const viaChannel = await channel.request('model.parameter.set', { name: 'width', expression: '40' })
    expect(viaChannel).toMatchObject({ ok: true, command: 'model.parameter.set', step: expect.any(String), value: { name: 'width', expression: '40', value: 40 } })
    expect(session.revision()).toBe(viaChannel.revision)
    // The registry's own reading of the same state, through the same registry.
    const direct = await modelCommands.run('model.parameters')
    const viaRead = await channel.request('model.parameters')
    expect(viaRead).toEqual(JSON.parse(JSON.stringify(direct)))
  })

  it('refusal: bad arguments return the registry refusal, nothing changes', async () => {
    const session = openModel()
    const { channel } = wire()
    const result = await channel.request('model.parameter.set', { name: 'a', expression: 5 })
    expect(result).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.expression' })
    expect(session.revision()).toBe(0)
  })

  it('no model open: one plain sentence, no session made', async () => {
    const { channel } = wire()
    const result = await channel.request('model.parameter.set', { name: 'a', expression: '1' })
    expect(result).toMatchObject({ ok: false, code: 'no-model-open' })
    expect(result.message).toMatch(/Open the Model page/)
  })

  it('a thrown error is answered as a refusal, never a raw error', async () => {
    const boom = { run: async () => { throw new Error('kaboom at registry.ts:99') }, list: () => [], describe: () => null }
    const { channel } = wire({ commands: { commands: boom } })
    const result = await channel.request('model.parameter.set', { name: 'a', expression: '1' })
    expect(result).toMatchObject({ ok: false, code: 'refused' })
    expect(JSON.stringify(result)).not.toMatch(/kaboom|registry\.ts|Error/)
  })

  it('an unknown command is refused in one plain sentence plus its remedy', async () => {
    openModel()
    const { channel } = wire()
    const result = await channel.request('model.sketch.new', {})
    expect(result).toMatchObject({ ok: false, code: 'unknown-command' })
    expect(result.message.split(/(?<=[.!?])\s+/)).toHaveLength(2) // the sentence and its remedy, no stack, no code dump
    expect(result.message).toContain('"model.sketch.new"')
  })

  it('list_commands and describe_command answer from the registry; an unknown id is refused', async () => {
    openModel()
    const { channel } = wire()
    const list = await channel.request('list_commands')
    expect(list).toMatchObject({ ok: true, value: JSON.parse(JSON.stringify(modelCommands.list())) })
    const described = await channel.request('describe_command', { id: 'model.parameter.set' })
    expect(described.value).toEqual(JSON.parse(JSON.stringify(modelCommands.describe('model.parameter.set'))))
    expect(await channel.request('describe_command', { id: 'nope' })).toMatchObject({ ok: false, code: 'unknown-command' })
    expect(await channel.request('describe_command', {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })

  it('a message that is not a request is refused, not thrown', async () => {
    const handle = createAgentRequestHandler()
    expect(await handle(null)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await handle({ id: 7 })).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })
})

describe('WO-2995 the bridge is installed under Electron and absent in a plain browser', () => {
  it('no host, or a host with no agent channel: nothing is installed', () => {
    expect(installAgentBridge(undefined)).toBeUndefined()
    expect(installAgentBridge({} as AgentHost)).toBeUndefined()
    expect((globalThis as { liencamHost?: unknown }).liencamHost).toBeUndefined()
    expect(installAgentBridge()).toBeUndefined()
  })

  it('under a host the bridge answers requests, and once uninstalled answers none', async () => {
    openModel()
    const { channel, uninstall, host } = wire({ timeoutMs: 50 })
    expect(typeof uninstall).toBe('function')
    const answered = await channel.request('list_commands')
    expect(answered.ok).toBe(true)
    uninstall!()
    const respond = vi.spyOn(host, 'respond')
    expect(await channel.request('list_commands')).toEqual({ pending: expect.any(String) })
    expect(respond).not.toHaveBeenCalled()
  })

  it('App.tsx installs it outside any DEV check, and preload exposes the two channels', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toMatch(/useEffect\(\(\) => installAgentBridge\(\), \[\]\)/)
    expect(app).not.toMatch(/import\.meta\.env\.DEV[^\n]*installAgentBridge/)
    const preload = readFileSync('electron/preload.cjs', 'utf8')
    expect(preload).toContain("'liencam:agent-request'")
    expect(preload).toContain("'liencam:agent-response'")
    expect(preload).not.toMatch(/ipcRenderer\.(send|invoke)\([^)]*,\s*event/)
  })

  it('a packaged app ships agentChannel.cjs beside main.cjs', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8')
    expect(builder).toMatch(/^\s+- electron\/agentChannel\.cjs$/m)
    expect(readFileSync('electron/main.cjs', 'utf8')).toContain("require('./agentChannel.cjs')")
  })
})

describe('WO-2995 the same requestId never runs twice', () => {
  it('in flight: two requests with one requestId join one run', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const run = vi.fn(async () => { await gate; return { ok: true, command: 'x', step: 'x', revision: 1, changed: { created: [], edited: [], removed: [] }, status: {}, diagnostics: [], value: 1 } })
    const handle = createAgentRequestHandler({ commands: { run, list: () => [], describe: () => null } as never })
    const a = handle({ id: 'a', requestId: 'r1', command: 'model.parameter.set', args: {} })
    const b = handle({ id: 'b', requestId: 'r1', command: 'model.parameter.set', args: {} })
    release()
    expect(await a).toBe(await b)
    expect(run).toHaveBeenCalledTimes(1)
    // and an edit that finished is answered from its first result
    expect(await handle({ id: 'c', requestId: 'r1', command: 'model.parameter.set', args: {} })).toBe(await a)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('on the real registry: a retried edit applies once (one history step, one revision)', async () => {
    const session = openModel()
    const { channel } = wire()
    const first = await channel.request('model.parameter.set', { name: 'w', expression: '5' }, { requestId: 'same' })
    const second = await channel.request('model.parameter.set', { name: 'w', expression: '5' }, { requestId: 'same' })
    expect(second).toEqual(first)
    expect(session.history.size()).toBe(1)
    expect(session.revision()).toBe(first.revision)
  })

  it('main answers {pending} after the timeout and the retry gets the eventual result, applied once', async () => {
    vi.useFakeTimers()
    const session = openModel()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = {
      run: async (...args: Parameters<typeof modelCommands.run>) => { await gate; return modelCommands.run(...args) },
      list: modelCommands.list,
      describe: modelCommands.describe,
    }
    const { channel } = wire({ commands: { commands: slow }, timeoutMs: 30_000 })
    const first = channel.request('model.parameter.set', { name: 'w', expression: '7' }, { requestId: 'slow-1' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await first).toEqual({ pending: 'slow-1' })
    const retry = channel.request('model.parameter.set', { name: 'w', expression: '7' }, { requestId: 'slow-1' })
    release()
    await vi.advanceTimersByTimeAsync(0)
    const result = await retry
    expect(result).toMatchObject({ ok: true, value: { name: 'w', expression: '7', value: 7 } })
    expect(session.history.size()).toBe(1)
  })
})

describe('WO-2995 main side guards', () => {
  it('only the main window may answer; a foreign sender answering with the real request id is ignored', async () => {
    vi.useFakeTimers()
    const { channel, handlers, host } = wire({ timeoutMs: 1000, commands: { commands: { run: () => new Promise(() => {}), list: () => [], describe: () => null } } })
    let sentId = ''
    host.onRequest((request) => { sentId = (request as { id: string }).id })
    const pending = channel.request('model.undo', undefined, { requestId: 'g1' })
    expect(sentId).not.toBe('')
    const forged = { ok: true, command: 'model.undo', value: 'forged' }
    const accepted = await handlers.get('liencam:agent-response')!({ sender: { other: true } }, sentId, forged)
    expect(accepted).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ pending: 'g1' })
  })

  it('no window: a one-sentence refusal', async () => {
    const channel = createAgentChannel({ ipcMain: { handle: () => {} }, getWindow: () => null })
    expect(await channel.request('model.undo')).toMatchObject({ ok: false, code: 'refused' })
  })

  it('a missing command name is refused before anything is sent', async () => {
    const { channel } = wire()
    expect(await channel.request('')).toMatchObject({ ok: false, code: 'unknown-command' })
  })

  it('a send that throws is answered as a refusal', async () => {
    const channel = createAgentChannel({
      ipcMain: { handle: () => {} },
      getWindow: () => ({ webContents: { send: () => { throw new Error('destroyed') } }, isDestroyed: () => false }),
    })
    const result = await channel.request('model.undo')
    expect(result).toMatchObject({ ok: false, code: 'refused' })
    expect(JSON.stringify(result)).not.toContain('destroyed')
  })
})
