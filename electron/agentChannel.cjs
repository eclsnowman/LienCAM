'use strict'

// Main side of the agent request channel (WO-2995, WO-2951 Order C).
//
// `request(command, args, options)` sends `liencam:agent-request {id, requestId,
// command, args}` to the main window and resolves with whatever the renderer
// answers through `liencam:agent-response`. A call still unanswered after
// `timeoutMs` (30 s) resolves `{ pending: requestId }`; the renderer keeps the
// eventual result under that requestId, so the caller's retry with the same
// requestId returns it and never applies an edit twice. No listener, no token:
// those are Order D. Nothing here touches the machine-bridge channels.

const { randomUUID } = require('node:crypto')

const REQUEST_CHANNEL = 'liencam:agent-request'
const RESPONSE_CHANNEL = 'liencam:agent-response'
const DEFAULT_TIMEOUT_MS = 30_000

const refusal = (code, message) => ({ ok: false, code, message })

function createAgentChannel({ ipcMain, getWindow, timeoutMs = DEFAULT_TIMEOUT_MS, newId = randomUUID }) {
  const waiting = new Map()

  // Same guard as every other channel: only the main window's page may answer.
  ipcMain.handle(RESPONSE_CHANNEL, (event, id, result) => {
    const window = getWindow()
    if (window === null || event.sender !== window.webContents) return false
    const entry = typeof id === 'string' ? waiting.get(id) : undefined
    if (entry === undefined) return false
    entry.settle(result)
    return true
  })

  function request(command, args, options = {}) {
    const window = getWindow()
    if (window === null || window.isDestroyed?.() === true) {
      return Promise.resolve(refusal('refused', 'LienCAM has no open window to run that in. Open the app window, then try again.'))
    }
    if (typeof command !== 'string' || command === '') {
      return Promise.resolve(refusal('unknown-command', 'Send a command name. Ask for list_commands to see what is available.'))
    }
    const id = newId()
    const requestId = typeof options.requestId === 'string' && options.requestId !== '' ? options.requestId : id
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle({ pending: requestId }), timeoutMs)
      function settle(result) {
        clearTimeout(timer)
        waiting.delete(id)
        resolve(result)
      }
      waiting.set(id, { settle })
      const message = { id, requestId, command, args }
      if (options.expectRevision !== undefined) message.expectRevision = options.expectRevision
      try {
        window.webContents.send(REQUEST_CHANNEL, message)
      } catch {
        settle(refusal('refused', 'LienCAM could not reach its window to run that. Try again in a moment.'))
      }
    })
  }

  return { request }
}

module.exports = { createAgentChannel, REQUEST_CHANNEL, RESPONSE_CHANNEL, DEFAULT_TIMEOUT_MS }
