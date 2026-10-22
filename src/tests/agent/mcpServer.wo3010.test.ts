// WO-3010 (WO-2951 Order D): the MCP server v0 for modeling.
//
// Everything here is the real chain an MCP client reaches: electron/mcp/server.cjs
// on a real 127.0.0.1 listener -> the real WO-2995 channel (electron/agentChannel.cjs,
// fake ipcMain/window as in agentChannel.wo2995.test.ts) -> the real renderer bridge
// -> the real model registry on a real ModelSession. The conformance client is the
// official MCP TypeScript SDK (devDependency only), over Streamable HTTP and over
// stdio through the shim electron/mcp/liencam-mcp.cjs. Journey in the real Electron
// app: src/tests/evidence/WO-3010/proof-plan.json.

import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElementMap, FeatureDag, createModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { modelCommands } from '../../lib/agent/commands'
import { installAgentBridge, type AgentHost } from '../../lib/agent/rendererBridge'

const require = createRequire(import.meta.url)
const repo = path.resolve(__dirname, '../../..')
const SERVER_FILE = path.join(repo, 'electron/mcp/server.cjs')
const SHIM_FILE = path.join(repo, 'electron/mcp/liencam-mcp.cjs')
const { createAgentChannel } = require('../../../electron/agentChannel.cjs') as {
  createAgentChannel: (options: unknown) => { request: (command: string, args?: unknown, options?: unknown) => Promise<any> }
}
interface McpServer {
  start: () => Promise<{ running: boolean; port: number | null; clientName: string | null }>
  stop: () => Promise<{ running: boolean; port: number | null; clientName: string | null }>
  state: () => { running: boolean; port: number | null; clientName: string | null }
  endpointPath: string
}
const { createMcpServer, toolNameFor } = require('../../../electron/mcp/server.cjs') as {
  createMcpServer: (options: unknown) => McpServer
  toolNameFor: (id: string) => string
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

/** main <-> page, wired like Electron (same shape as agentChannel.wo2995.test.ts). */
function wireChannel() {
  const handlers = new Map<string, (event: { sender: unknown }, ...args: any[]) => unknown>()
  const listeners = new Set<(request: unknown) => void>()
  const webContents = { send: (_channel: string, message: unknown) => { for (const l of listeners) l(message) } }
  const window = { webContents, isDestroyed: () => false }
  const channel = createAgentChannel({
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    getWindow: () => window,
  })
  const host: AgentHost = {
    onRequest: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    respond: (id, result) => handlers.get('liencam:agent-response')!({ sender: webContents }, id, result),
  }
  const uninstall = installAgentBridge(host)
  return { channel, uninstall }
}

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: any }

function rawPost(port: number, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text === '' ? null : JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? '' : JSON.stringify(body))
  })
}

let dir: string
let server: McpServer
let uninstall: (() => void) | undefined
const states: Array<{ running: boolean; clientName: string | null }> = []

/** The listener's port; asserts first that the server is running. */
function livePort(target: McpServer = server): number {
  const state = target.state()
  expect(state.running).toBe(true)
  return state.port!
}
function endpoint(target: McpServer = server): { url: string; token: string } {
  expect(existsSync(target.endpointPath)).toBe(true)
  return JSON.parse(readFileSync(target.endpointPath, 'utf8'))
}
const auth = () => ({ Authorization: `Bearer ${endpoint().token}` })
const init = (id = 1, name = 'wo3010-raw') => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name, version: '1' } } })

beforeEach(async () => {
  resetDocumentHolder()
  dir = mkdtempSync(path.join(os.tmpdir(), 'wo3010-'))
  const wired = wireChannel()
  uninstall = wired.uninstall
  states.length = 0
  server = createMcpServer({ request: wired.channel.request, endpointDir: path.join(dir, 'mcp'), version: '9.9.9', onState: (s: any) => states.push(s) })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  uninstall?.()
  resetDocumentHolder()
  rmSync(dir, { recursive: true, force: true })
})

describe('WO-3010 framing: hand-written JSON-RPC over Streamable HTTP', () => {
  it('initialize, notifications/initialized, ping, tools/list, tools/call round trip', async () => {
    const session = openModel()
    const port = livePort()
    const hello = await rawPost(port, init(), auth())
    expect(hello.status).toBe(200)
    expect(hello.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'liencam', version: '9.9.9' } } })
    const sessionId = hello.headers['mcp-session-id'] as string
    expect(typeof sessionId).toBe('string')
    expect(server.state().clientName).toBe('wo3010-raw')
    expect(states.at(-1)).toMatchObject({ running: true, clientName: 'wo3010-raw' })

    const headers = { ...auth(), 'Mcp-Session-Id': sessionId }
    const note = await rawPost(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers)
    expect(note.status).toBe(202)
    expect(note.body).toBeNull()

    expect((await rawPost(port, { jsonrpc: '2.0', id: 2, method: 'ping' }, headers)).body).toEqual({ jsonrpc: '2.0', id: 2, result: {} })

    const listed = await rawPost(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, headers)
    // Whatever the registry holds right now, nothing more and nothing less.
    const registry = modelCommands.list().map((c) => c.id)
    expect(listed.body.result.tools.map((t: any) => t.title)).toEqual(registry)
    expect(listed.body.result.tools.map((t: any) => t.name)).toEqual(registry.map(toolNameFor))
    for (const tool of listed.body.result.tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(tool.inputSchema).toEqual(modelCommands.describe(tool.title)!.input)
    }

    const called = await rawPost(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'model_parameter_set', arguments: { name: 'width', expression: '40' } } }, headers)
    expect(called.body.result.isError).toBe(false)
    expect(called.body.result.structuredContent).toMatchObject({ ok: true, command: 'model.parameter.set', value: { name: 'width', value: 40 } })
    expect(session.params.valueOf('width')).toBe(40)

    expect((await rawPost(port, { jsonrpc: '2.0', id: 5, method: 'resources/list' }, headers)).body.error.code).toBe(-32601)
    expect((await rawPost(port, [init(6)], headers)).status).toBe(400)
    expect((await rawPost(port, undefined, headers, 'GET')).status).toBe(405)

    const bye = await rawPost(port, undefined, headers, 'DELETE')
    expect(bye.status).toBe(200)
    expect(server.state().clientName).toBeNull()
    expect((await rawPost(port, { jsonrpc: '2.0', id: 7, method: 'ping' }, headers)).status).toBe(404)
  })

  it('a refusal from the registry comes back as a tool error in the app\'s own words', async () => {
    openModel()
    const port = livePort()
    const called = await rawPost(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'model_parameter_set', arguments: { name: 'width' } } }, auth())
    expect(called.body.result.isError).toBe(true)
    expect(called.body.result.structuredContent).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(called.body.result.content[0].text).toBe(called.body.result.structuredContent.message)
  })
})

describe('WO-3010 guards: token, Origin, Host, 127.0.0.1', () => {
  it('a request without the token, or with a wrong one, is refused and changes nothing', async () => {
    const session = openModel()
    const port = livePort()
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'model_parameter_set', arguments: { name: 'width', expression: '40' } } }
    const none = await rawPost(port, call)
    expect(none.status).toBe(401)
    const wrong = await rawPost(port, call, { Authorization: `Bearer ${'0'.repeat(64)}` })
    expect(wrong.status).toBe(401)
    const shortToken = await rawPost(port, call, { Authorization: 'Bearer abc' })
    expect(shortToken.status).toBe(401)
    expect(session.params.valueOf('width')).toBeUndefined()
    const right = await rawPost(port, call, auth())
    expect(right.status).toBe(200)
    expect(session.params.valueOf('width')).toBe(40)
  })

  it('a request from Origin http://evil.example WITH a valid token is refused and changes nothing', async () => {
    const session = openModel()
    const port = livePort()
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'model_parameter_set', arguments: { name: 'width', expression: '40' } } }
    const evil = await rawPost(port, call, { ...auth(), Origin: 'http://evil.example' })
    expect(evil.status).toBe(403)
    expect(session.params.valueOf('width')).toBeUndefined()
    const nullOrigin = await rawPost(port, call, { ...auth(), Origin: 'null' })
    expect(nullOrigin.status).toBe(403)
    const rebound = await rawPost(port, call, { ...auth(), Host: `evil.example:${port}` })
    expect(rebound.status).toBe(403)
    expect(session.params.valueOf('width')).toBeUndefined()
    const local = await rawPost(port, call, { ...auth(), Origin: `http://localhost:${port}` })
    expect(local.status).toBe(200)
    expect(session.params.valueOf('width')).toBe(40)
  })

  it('binds 127.0.0.1 only and writes a user-only endpoint file that names it', async () => {
    const port = livePort()
    const file = endpoint()
    expect(file.url).toBe(`http://127.0.0.1:${port}/mcp`)
    expect(file.token).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') expect(statSync(server.endpointPath).mode & 0o077).toBe(0)
    const external = Object.values(os.networkInterfaces()).flat()
      .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)
    if (external !== undefined) {
      const reached = await new Promise<string>((resolve) => {
        const req = http.request({ host: external.address, port, path: '/mcp', method: 'POST', timeout: 2000 }, () => resolve('answered'))
        req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
        req.on('timeout', () => { req.destroy(); resolve('timeout') })
        req.end('{}')
      })
      expect(reached).not.toBe('answered')
    }
    // The bind address itself, read from the server's own source.
    expect(readFileSync(SERVER_FILE, 'utf8')).toMatch(/\.listen\(0, '127\.0\.0\.1'/)
  })

  it('switching on and off quickly leaves no endpoint file and no listener behind', async () => {
    await server.stop()
    const on = server.start()
    const off = server.stop()
    await Promise.allSettled([on, off])
    expect({ file: existsSync(server.endpointPath), state: server.state() })
      .toEqual({ file: false, state: { running: false, port: null, clientName: null } })
    const again = [server.start(), server.stop(), server.start()]
    await Promise.allSettled(again)
    const port = livePort()
    expect((await rawPost(port, init(), auth())).status).toBe(200)
  })

  it('a new start gets a new token; the old one is refused', async () => {
    const old = endpoint().token
    await server.stop()
    expect(existsSync(server.endpointPath)).toBe(false)
    await server.start()
    expect(endpoint().token).not.toBe(old)
    const refused = await rawPost(livePort(), init(), { Authorization: `Bearer ${old}` })
    expect(refused.status).toBe(401)
  })
})

describe('WO-3010 boundary: no machine or CAM channel is reachable', () => {
  const BANNED = [
    /machine-bridge/, /choose-machine-path/, /set-job-wake-lock/, /pendant/i,
    /\b9222\b/, /\b8324\b/, /\b8325\b/, /child_process/, /webContents/, /ipcMain/, /useCamStore/, /camCommands/,
  ]

  it('the server and the shim reference no banned channel, port or spawn, and load only Node built-ins', () => {
    for (const file of [SERVER_FILE, SHIM_FILE]) {
      const source = readFileSync(file, 'utf8')
      const found = BANNED.filter((re) => re.test(source)).map(String)
      expect({ file: path.basename(file), found }).toEqual({ file: path.basename(file), found: [] })
      const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
      expect(requires.every((spec) => spec.startsWith('node:'))).toBe(true)
    }
  })

  it('the read commands outside the model registry, and CAM/machine names, are unknown tools', async () => {
    openModel()
    const port = livePort()
    for (const name of ['project_summary', 'tool_library', 'machine_limits', 'feature_details', 'list_commands', 'describe_command', 'cam_operation_add', 'machine_jog']) {
      const answer = await rawPost(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, auth())
      expect({ name, code: answer.body.error?.code }).toEqual({ name, code: -32602 })
    }
  })

  it('a call still running after the channel\'s 30 s answer is asked again with the SAME requestId, never twice', async () => {
    const seen: Array<{ command: string; requestId: unknown }> = []
    let pendingLeft = 2
    const fake = createMcpServer({
      endpointDir: path.join(dir, 'fake'),
      request: async (command: string, _args: unknown, options: { requestId?: string } = {}) => {
        if (command === 'list_commands') return { ok: true, value: [{ id: 'model.parameter.set', effect: 'edit' }] }
        if (command === 'describe_command') return { ok: true, value: { input: { type: 'object' } } }
        seen.push({ command, requestId: options.requestId })
        if (pendingLeft-- > 0) return { pending: options.requestId }
        return { ok: true, command, step: 'x', value: 1 }
      },
    })
    await fake.start()
    const port = livePort(fake)
    const token = endpoint(fake).token
    const answer = await rawPost(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'model_parameter_set', arguments: {} } }, { Authorization: `Bearer ${token}` })
    await fake.stop()
    expect(answer.body.result.structuredContent).toMatchObject({ ok: true, value: 1 })
    expect(seen).toHaveLength(3)
    expect(new Set(seen.map((s) => s.requestId)).size).toBe(1)
    expect(typeof seen[0].requestId).toBe('string')
  })
})

describe('WO-3010 SDK conformance (@modelcontextprotocol/sdk client)', () => {
  it('Streamable HTTP: initialize, tools/list, tools/call model.parameter.set returns the registry\'s own envelope', async () => {
    const session = openModel()
    livePort()
    const transport = new StreamableHTTPClientTransport(new URL(endpoint().url), { requestInit: { headers: auth() } })
    const client = new Client({ name: 'wo3010-sdk', version: '1.0.0' })
    await client.connect(transport)
    expect(client.getServerVersion()).toMatchObject({ name: 'liencam', version: '9.9.9' })
    expect(server.state().clientName).toBe('wo3010-sdk')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(modelCommands.list().map((c) => toolNameFor(c.id)))
    const called = await client.callTool({ name: 'model_parameter_set', arguments: { name: 'width', expression: '40' } })
    await client.close()
    expect(session.params.valueOf('width')).toBe(40)

    // Same call straight on the registry, on a twin model: the same envelope (T2).
    resetDocumentHolder()
    openModel()
    const direct = await modelCommands.run('model.parameter.set', { name: 'width', expression: '40' })
    expect(called.structuredContent).toEqual(JSON.parse(JSON.stringify(direct)))
    expect(called.isError).toBe(false)
  })

  it('stdio through the shim: initialize, tools/list, tools/call, then switching the server off refuses the client, and on again serves it', async () => {
    const session = openModel()
    livePort()
    const transport = new StdioClientTransport({ command: process.execPath, args: [SHIM_FILE, '--endpoint', server.endpointPath], stderr: 'pipe' })
    const client = new Client({ name: 'wo3010-stdio', version: '1.0.0' })
    await client.connect(transport)
    expect(server.state().clientName).toBe('wo3010-stdio')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.title)).toEqual(modelCommands.list().map((c) => c.id))
    const called = await client.callTool({ name: 'model_parameter_set', arguments: { name: 'depth', expression: '12' } })
    expect(called.structuredContent).toMatchObject({ ok: true, value: { name: 'depth', value: 12 } })
    expect(session.params.valueOf('depth')).toBe(12)

    await server.stop()
    await expect(client.callTool({ name: 'model_parameter_set', arguments: { name: 'depth', expression: '13' } }))
      .rejects.toThrow(/MCP server is not running/)
    expect(session.params.valueOf('depth')).toBe(12)

    // Switched on again: the same client works without a restart, and is named again.
    await server.start()
    const back = await client.callTool({ name: 'model_parameter_set', arguments: { name: 'depth', expression: '14' } })
    expect(back.structuredContent).toMatchObject({ ok: true, value: { name: 'depth', value: 14 } })
    expect(server.state().clientName).toBe('wo3010-stdio')
    await client.close()
  })
})
