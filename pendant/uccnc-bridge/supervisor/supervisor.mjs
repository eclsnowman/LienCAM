import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const START_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5_000
const STATUS_SOCKET_TIMEOUT_MS = 250
const MAX_LOG_LINES = 50
const MAX_REQUEST_BYTES = 16_384
const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/

function readOption(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

function positivePort(value, name, allowZero = false) {
  const port = Number(value)
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new Error(`${name} must be an integer from ${minimum} through 65535.`)
  }
  return port
}

export function createBridgeSupervisor({
  bridgePath,
  bridgeArgs = [],
  bridgePort = 8325,
  supervisorPort = bridgePort + 1,
  host = '127.0.0.1',
  startTimeoutMs = START_TIMEOUT_MS,
  stopTimeoutMs = STOP_TIMEOUT_MS,
} = {}) {
  const executable = resolve(bridgePath)
  const port = positivePort(bridgePort, 'bridge port')
  const httpPort = positivePort(supervisorPort, 'supervisor port', true)
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('The bridge supervisor may listen only on this computer.')
  }

  let child = null
  let starting = false
  let requestedStop = false
  let lastExit = null
  let failureReason = null
  const lastLogs = []

  const appendLog = (source, chunk) => {
    for (const text of String(chunk).split(/\r?\n/)) {
      if (!text) continue
      lastLogs.push(`${source}: ${text}`)
      if (lastLogs.length > MAX_LOG_LINES) lastLogs.shift()
    }
  }

  const requestArguments = async (request) => {
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) throw new Error('Bridge supervisor request body is too large.')
      chunks.push(chunk)
    }
    if (bytes === 0) return null
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body === null || !Array.isArray(body.args) || body.args.some((arg) => typeof arg !== 'string')) {
      throw new Error('Bridge supervisor start arguments must be an array of strings.')
    }
    return body.args
  }

  const socketListening = (timeoutMs = STATUS_SOCKET_TIMEOUT_MS) => new Promise((resolveSocket) => {
    let settled = false
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (answer) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveSocket(answer)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })

  const waitForStart = async (startedChild) => {
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      if (child !== startedChild || startedChild.exitCode !== null) return false
      if (await socketListening()) return true
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    return false
  }

  const status = async () => {
    const configured = existsSync(executable)
    const running = child !== null && child.exitCode === null
    let health = running ? (starting ? 'starting' : 'failing') : 'stopped'
    let reason = failureReason
    if (running && await socketListening()) {
      health = 'healthy'
      reason = null
    } else if (running && !starting) {
      reason = reason ?? `Bridge process is running but is not answering on port ${port}.`
    } else if (!running && lastExit !== null && !requestedStop) {
      health = 'failing'
      reason = reason ?? `Bridge process stopped with exit code ${lastExit.code ?? 'unknown'}.`
    }
    return {
      configured,
      running,
      pid: running ? child.pid ?? null : null,
      bridgePort: port,
      health,
      failureReason: reason,
      lastExit,
      lastLogs: [...lastLogs],
      respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
    }
  }

  const startBridge = async (requestedArgs = null) => {
    if (!existsSync(executable)) return { ok: false, reason: 'not-configured' }
    if (child !== null && child.exitCode === null) {
      if (await socketListening()) return { ok: true, pid: child.pid, port }
      return { ok: false, reason: 'no-socket', pid: child.pid, port }
    }
    requestedStop = false
    failureReason = null
    starting = true
    const launchArgs = requestedArgs ?? bridgeArgs
    const startedChild = spawn(executable, [...launchArgs, '--port', String(port)], {
      cwd: dirname(executable),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = startedChild
    startedChild.stdout?.on('data', (chunk) => appendLog('stdout', chunk))
    startedChild.stderr?.on('data', (chunk) => appendLog('stderr', chunk))
    startedChild.once('error', (error) => {
      appendLog('supervisor', error.message)
      failureReason = `Bridge process could not start: ${error.message}`
    })
    startedChild.once('exit', (code, signal) => {
      lastExit = { code, signal, error: failureReason }
      if (!requestedStop && failureReason === null) {
        failureReason = `Bridge process stopped with exit code ${code ?? 'unknown'}.`
      }
      if (child === startedChild) child = null
    })
    const listening = await waitForStart(startedChild)
    starting = false
    if (listening && child === startedChild) {
      return { ok: true, pid: startedChild.pid, port }
    }
    if (startedChild.exitCode !== null || child !== startedChild) {
      return { ok: false, reason: 'exited', lastExit }
    }
    failureReason = `Bridge process is running but is not answering on port ${port}.`
    return { ok: false, reason: 'no-socket', pid: startedChild.pid, port }
  }

  const stopBridge = async () => {
    const stoppedChild = child
    if (stoppedChild === null || stoppedChild.exitCode !== null) {
      requestedStop = true
      failureReason = null
      return { ok: true }
    }
    requestedStop = true
    failureReason = null
    stoppedChild.kill()
    const stopped = await new Promise((resolveStop) => {
      const timer = setTimeout(() => resolveStop(false), stopTimeoutMs)
      stoppedChild.once('exit', () => {
        clearTimeout(timer)
        resolveStop(true)
      })
    })
    if (!stopped) return { ok: false, reason: 'stop-timeout' }
    return { ok: true }
  }

  const restartBridge = async (requestedArgs = null) => {
    const stopped = await stopBridge()
    if (!stopped.ok) return stopped
    return startBridge(requestedArgs)
  }

  const sendJson = (response, statusCode, body, origin = null) => {
    const headers = {
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    }
    if (origin !== null) headers['Access-Control-Allow-Origin'] = origin
    response.writeHead(statusCode, headers)
    response.end(JSON.stringify(body))
  }

  const server = createServer((request, response) => {
    const origin = request.headers.origin ?? null
    if (origin !== null && !LOOPBACK_ORIGIN.test(origin)) {
      sendJson(response, 403, { ok: false, error: 'Bridge supervisor accepts only loopback browser origins.' })
      return
    }
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, null, origin)
      return
    }
    const route = `${request.method} ${request.url}`
    const operation = route === 'GET /status' ? async () => status()
      : route === 'POST /start' ? async () => startBridge(await requestArguments(request))
        : route === 'POST /restart' ? async () => restartBridge(await requestArguments(request))
          : route === 'POST /stop' ? stopBridge
            : null
    if (operation === null) {
      sendJson(response, 404, { ok: false, error: 'Unknown bridge supervisor route.' }, origin)
      return
    }
    void operation()
      .then((body) => sendJson(response, 200, body, origin))
      .catch((error) => sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, origin))
  })

  return {
    address: () => server.address(),
    close: async () => {
      await stopBridge()
      await new Promise((resolveClose, rejectClose) => server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      }))
    },
    listen: () => new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(httpPort, host, () => resolveListen(server.address()))
    }),
    restartBridge,
    startBridge,
    status,
    stopBridge,
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url))
  const bridgePath = readOption('bridge', resolve(here, 'liencam-bridge.exe'))
  const bridgeArgs = JSON.parse(readOption('bridge-args-json', '[]'))
  if (!Array.isArray(bridgeArgs) || bridgeArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('bridge-args-json must be a JSON array of strings.')
  }
  const bridgePort = positivePort(readOption('port', '8325'), 'bridge port')
  const supervisorPort = positivePort(
    readOption('supervisor-port', String(bridgePort + 1)),
    'supervisor port',
  )
  const supervisor = createBridgeSupervisor({ bridgePath, bridgeArgs, bridgePort, supervisorPort })
  const address = await supervisor.listen()
  console.log(`LienCAM bridge supervisor listening on 127.0.0.1:${address.port}.`)
  const close = async () => {
    await supervisor.close()
    process.exit(0)
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
}
