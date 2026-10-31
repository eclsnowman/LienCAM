'use strict'

// LienCAM MCP stdio shim (WO-3010, WO-2951 Order D).
//
// An MCP client that launches its servers (Claude Desktop, for one) runs this
// file with LienCAM's own executable and ELECTRON_RUN_AS_NODE=1. It reads
// newline-delimited JSON-RPC on stdin, forwards each message to the running
// app's loopback endpoint with the per-launch token from the user-only endpoint
// file, and writes each answer as one line on stdout. It ships outside asar
// (electron-builder.yml asarUnpack) so a plain Node runtime can load it.
//
// It uses Node built-ins only and talks to nothing but 127.0.0.1.
//
// Endpoint file, first found wins: --endpoint <file>, LIENCAM_MCP_ENDPOINT,
// <LIENCAM_USER_DATA_DIR>/mcp/endpoint.json, then the app's default user-data
// folder (LienCAM or liencam) for this platform.

const http = require('node:http')
const { existsSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const OFF_MESSAGE = 'LienCAM\'s MCP server is not running. Open LienCAM, then turn on Settings > AI assistant (MCP) > Allow MCP clients.'

function candidateEndpointFiles(argv = process.argv, env = process.env, platform = process.platform) {
  const files = []
  const flag = argv.indexOf('--endpoint')
  if (flag !== -1 && argv[flag + 1]) files.push(argv[flag + 1])
  if (env.LIENCAM_MCP_ENDPOINT) files.push(env.LIENCAM_MCP_ENDPOINT)
  if (env.LIENCAM_USER_DATA_DIR) files.push(path.join(env.LIENCAM_USER_DATA_DIR, 'mcp', 'endpoint.json'))
  const home = os.homedir()
  const base = platform === 'win32'
    ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || path.join(home, '.config')
  for (const name of ['LienCAM', 'liencam']) files.push(path.join(base, name, 'mcp', 'endpoint.json'))
  return files
}

function readEndpoint(files) {
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const endpoint = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof endpoint.url === 'string' && typeof endpoint.token === 'string') return endpoint
    } catch { /* being rewritten; try the next */ }
  }
  return null
}

function post(endpoint, method, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.url)
    if (url.hostname !== '127.0.0.1') return reject(new Error('not loopback'))
    const req = http.request({
      host: '127.0.0.1',
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${endpoint.token}`,
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function runShim({ input = process.stdin, output = process.stdout, files = candidateEndpointFiles() } = {}) {
  let sessionId
  let protocolVersion
  let initializeLine
  let queue = Promise.resolve()
  const write = (message) => output.write(`${JSON.stringify(message)}\n`)
  const fail = (id, text) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } }) }

  async function forward(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That MCP message is not valid JSON.' } })
    }
    const id = message && typeof message === 'object' ? message.id : undefined
    const endpoint = readEndpoint(files)
    if (endpoint === null) return fail(id, OFF_MESSAGE)
    const headers = () => ({
      ...(sessionId !== undefined && message.method !== 'initialize' ? { 'Mcp-Session-Id': sessionId } : {}),
      ...(protocolVersion !== undefined ? { 'MCP-Protocol-Version': protocolVersion } : {}),
    })
    if (message.method === 'initialize') initializeLine = line
    let answer
    try {
      answer = await post(endpoint, 'POST', line, headers())
      if (answer.status === 404 && sessionId !== undefined && initializeLine !== undefined) {
        // The server was switched off and on (or LienCAM restarted): its sessions are
        // gone. Introduce this client again, then send the message once more.
        sessionId = undefined
        const again = await post(endpoint, 'POST', initializeLine, headers())
        if (typeof again.headers['mcp-session-id'] === 'string') sessionId = again.headers['mcp-session-id']
        answer = await post(endpoint, 'POST', line, headers())
      }
    } catch {
      return fail(id, OFF_MESSAGE)
    }
    if (message.method === 'initialize' && typeof answer.headers['mcp-session-id'] === 'string') sessionId = answer.headers['mcp-session-id']
    if (answer.text === '') return undefined
    try {
      const parsed = JSON.parse(answer.text)
      if (message.method === 'initialize' && parsed.result && typeof parsed.result.protocolVersion === 'string') {
        protocolVersion = parsed.result.protocolVersion
      }
      // A refusal before the message was read carries id null; give it the caller's id.
      if (parsed.id === null && id !== undefined && id !== null) parsed.id = id
      if (id === undefined || id === null) return undefined
      return write(parsed)
    } catch {
      return fail(id, 'LienCAM sent an answer the shim could not read. Try again.')
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (line.trim() === '') return
    queue = queue.then(() => forward(line)).catch(() => undefined)
  })
  return new Promise((resolve) => {
    lines.on('close', () => {
      queue.then(async () => {
        const endpoint = readEndpoint(files)
        if (endpoint !== null && sessionId !== undefined) {
          await post(endpoint, 'DELETE', '', { 'Mcp-Session-Id': sessionId }).catch(() => undefined)
        }
        resolve()
      })
    })
  })
}

module.exports = { runShim, candidateEndpointFiles, readEndpoint, OFF_MESSAGE }

if (require.main === module) {
  void runShim().then(() => process.exit(0))
}
