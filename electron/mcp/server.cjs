'use strict'

// MCP server v0 for modeling (WO-3010, WO-2951 Order D).
//
// MCP Streamable HTTP on 127.0.0.1 only (random port, one JSON-RPC message per
// POST, JSON responses, no SSE). Every request must carry the per-launch bearer
// token, a local Host and an absent or local Origin (the DNS-rebinding guard the
// transport requires; the token does not replace it). The token and the URL go to
// a user-only endpoint file that the stdio shim (liencam-mcp.cjs) reads.
//
// The tools are whatever the model registry holds at the moment tools/list is
// asked: the server asks the page through the WO-2995 request channel
// (`list_commands`, `describe_command`) and runs a call through the same channel.
// It hard-codes no command, reaches no CAM or machine route, and writes no store
// state of its own. Framing is hand-written (design default 1); the official SDK
// is the conformance client in mcpServer.wo3010.test.ts only.

const http = require('node:http')
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { mkdir, rm, writeFile, chmod } = require('node:fs/promises')
const path = require('node:path')

const LATEST_PROTOCOL = '2025-11-25'
const SUPPORTED_PROTOCOLS = Object.freeze([LATEST_PROTOCOL, '2025-06-18', '2025-03-26'])
const ENDPOINT_FILE = 'endpoint.json'
const MAX_BODY_BYTES = 1024 * 1024
// A call the page has not finished after this long is answered as still running.
// The renderer keeps running it under the same requestId, so nothing is applied twice.
const DEFAULT_CALL_LIMIT_MS = 5 * 60_000
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

/** MCP tool names keep to letters, digits, `_` and `-` so every client accepts them. */
function toolNameFor(commandId) {
  return commandId.replace(/[^A-Za-z0-9_-]/g, '_')
}

function descriptionFor(command) {
  return command.effect === 'read'
    ? `Reads the model open in LienCAM (${command.id}). Changes nothing.`
    : `Changes the model open in LienCAM (${command.id}). One successful call is one step on the Model page's Undo.`
}

function sameToken(given, expected) {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function originIsLocal(origin) {
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTNAMES.has(url.hostname)
  } catch {
    return false
  }
}

function hostIsLocal(host, port) {
  if (typeof host !== 'string') return false
  return [...LOCAL_HOSTNAMES].some((name) => host === `${name}:${port}`)
}

/**
 * @param {object} options
 * @param {(command: string, args?: unknown, options?: object) => Promise<any>} options.request
 *   the WO-2995 channel's `request`
 * @param {string} options.endpointDir where the user-only endpoint file is written
 * @param {string} [options.version] the app version for serverInfo
 * @param {(state: object) => void} [options.onState] told whenever running/client changes
 */
function createMcpServer({ request, endpointDir, version = '0.0.0', onState = () => {}, callLimitMs = DEFAULT_CALL_LIMIT_MS }) {
  let server = null
  let token = null
  let port = null
  const sessions = new Map() // session id -> client name

  const endpointPath = path.join(endpointDir, ENDPOINT_FILE)

  function state() {
    const names = [...sessions.values()]
    return Object.freeze({
      running: server !== null && port !== null,
      port,
      clientName: names.length === 0 ? null : names[names.length - 1],
    })
  }
  const announce = () => { try { onState(state()) } catch { /* the window may be gone */ } }

  async function listTools() {
    const listed = await request('list_commands')
    if (!listed || listed.ok !== true || !Array.isArray(listed.value)) return []
    const tools = []
    for (const command of listed.value) {
      if (!command || typeof command.id !== 'string') continue
      const described = await request('describe_command', { id: command.id })
      const input = described && described.ok === true && described.value && typeof described.value.input === 'object'
        ? described.value.input
        : { type: 'object' }
      tools.push({
        name: toolNameFor(command.id),
        title: command.id,
        description: descriptionFor(command),
        inputSchema: input,
        annotations: { readOnlyHint: command.effect === 'read', destructiveHint: false, openWorldHint: false },
        _command: command.id,
      })
    }
    return tools
  }

  async function runCommand(command, args) {
    const requestId = randomUUID()
    const deadline = Date.now() + callLimitMs
    let result = await request(command, args, { requestId })
    // The channel answers {pending} after 30 s; asking again with the same requestId
    // joins the run already going in the page, it never starts a second one.
    while (result && typeof result === 'object' && 'pending' in result && Date.now() < deadline) {
      result = await request(command, args, { requestId })
    }
    return result
  }

  async function callTool(params) {
    const name = params && typeof params.name === 'string' ? params.name : null
    if (name === null) return { error: [-32602, 'tools/call needs the tool name.'] }
    const tools = await listTools()
    const tool = tools.find((t) => t.name === name)
    if (tool === undefined) return { error: [-32602, `Unknown tool: ${name}. Ask for tools/list to see what LienCAM offers.`] }
    const args = params.arguments === undefined ? {} : params.arguments
    const result = await runCommand(tool._command, args)
    if (result && typeof result === 'object' && 'pending' in result) {
      return { result: {
        content: [{ type: 'text', text: `${tool._command} is still running in LienCAM. Ask for the model again in a moment to see whether it finished.` }],
        isError: true,
      } }
    }
    if (!result || typeof result !== 'object') {
      return { result: { content: [{ type: 'text', text: `${tool._command} gave no answer and nothing was changed. Try again.` }], isError: true } }
    }
    const text = result.ok === false && typeof result.message === 'string' ? result.message : JSON.stringify(result)
    return { result: { content: [{ type: 'text', text }], structuredContent: result, isError: result.ok === false } }
  }

  async function handleMessage(message, sessionId) {
    const { id, method, params } = message
    switch (method) {
      case 'initialize': {
        const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null
        const clientName = params && params.clientInfo && typeof params.clientInfo.name === 'string'
          ? params.clientInfo.name.slice(0, 80)
          : 'MCP client'
        const newSession = randomUUID()
        sessions.set(newSession, clientName)
        announce()
        return {
          session: newSession,
          body: rpcResult(id, {
            protocolVersion: asked !== null && SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'liencam', title: 'LienCAM', version },
            instructions: 'Edits the model open on LienCAM\'s Model page. Each successful edit is one Undo step there. No CAM and no machine commands.',
          }),
        }
      }
      case 'ping':
        return { body: rpcResult(id, {}) }
      case 'tools/list': {
        const tools = await listTools()
        return { body: rpcResult(id, { tools: tools.map(({ _command, ...tool }) => tool) }) }
      }
      case 'tools/call': {
        const outcome = await callTool(params)
        return { body: outcome.error ? rpcError(id, outcome.error[0], outcome.error[1]) : rpcResult(id, outcome.result) }
      }
      default:
        return { body: rpcError(id, -32601, `LienCAM does not offer ${String(method)}.`) }
    }
  }

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers })
    res.end(text)
  }

  async function onRequest(req, res) {
    // Order matters only for what the refused caller learns; every check must pass.
    if (!originIsLocal(req.headers.origin)) {
      return send(res, 403, rpcError(null, -32000, 'LienCAM refuses MCP requests from a web page.'))
    }
    if (!hostIsLocal(req.headers.host, port)) {
      return send(res, 403, rpcError(null, -32000, 'LienCAM answers MCP requests on this computer only.'))
    }
    const auth = req.headers.authorization
    const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token === null || !sameToken(given, token)) {
      return send(res, 401, rpcError(null, -32001, 'This MCP request does not carry LienCAM\'s current token. Start the client through the LienCAM MCP shim.'),
        { 'WWW-Authenticate': 'Bearer' })
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return send(res, 404, rpcError(null, -32000, 'Not found.'))
    const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
    if (req.method === 'DELETE') {
      if (sessionId !== undefined && sessions.delete(sessionId)) announce()
      return send(res, 200)
    }
    if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST, DELETE' })
    if (sessionId !== undefined && !sessions.has(sessionId)) {
      return send(res, 404, rpcError(null, -32000, 'That MCP session has ended. Initialize again.'))
    }

    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return send(res, 413, rpcError(null, -32600, 'That MCP message is too large.'))
      chunks.push(chunk)
    }
    let message
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return send(res, 400, rpcError(null, -32700, 'That MCP message is not valid JSON.'))
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return send(res, 400, rpcError(null, -32600, 'Send one JSON-RPC 2.0 message per request.'))
    }
    if (typeof message.method !== 'string') return send(res, 202) // a response or stray reply: nothing to answer
    if (message.id === undefined || message.id === null) return send(res, 202) // a notification
    try {
      const { body, session } = await handleMessage(message, sessionId)
      return send(res, 200, body, session === undefined ? {} : { 'Mcp-Session-Id': session })
    } catch {
      return send(res, 200, rpcError(message.id, -32603, `LienCAM could not answer ${message.method}. Nothing was changed. Try again.`))
    }
  }

  async function writeEndpoint() {
    await mkdir(endpointDir, { recursive: true, mode: 0o700 })
    await writeFile(endpointPath, JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, token, pid: process.pid }), { mode: 0o600 })
    // writeFile's mode applies only when it creates the file.
    await chmod(endpointPath, 0o600).catch(() => {})
  }

  async function doStart() {
    if (server !== null) return state()
    token = randomBytes(32).toString('hex')
    const candidate = http.createServer((req, res) => {
      onRequest(req, res).catch(() => { if (!res.headersSent) send(res, 500) })
    })
    server = candidate
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject)
        candidate.listen(0, '127.0.0.1', () => {
          port = candidate.address().port
          resolve()
        })
      })
      await writeEndpoint()
    } catch (error) {
      await doStop()
      throw error
    }
    announce()
    return state()
  }

  async function doStop() {
    const closing = server
    server = null
    port = null
    token = null
    sessions.clear()
    await rm(endpointPath, { force: true }).catch(() => {})
    if (closing !== null) {
      closing.closeAllConnections?.()
      await new Promise((resolve) => closing.close(() => resolve()))
    }
    announce()
    return state()
  }

  // The Settings switch can flip faster than a listener opens or closes: run each
  // start and stop after the one before it has finished, so the last one wins and
  // no endpoint file or listener is left behind by an earlier one.
  let queue = Promise.resolve()
  function serialized(step) {
    const run = queue.then(step, step)
    queue = run.catch(() => undefined)
    return run
  }
  const start = () => serialized(doStart)
  const stop = () => serialized(doStop)

  return { start, stop, state, endpointPath }
}

module.exports = { createMcpServer, toolNameFor, originIsLocal, LATEST_PROTOCOL, SUPPORTED_PROTOCOLS, ENDPOINT_FILE }
