// Renderer side of the agent request channel (WO-2995, WO-2951 Order C).
//
// The Electron main process sends `liencam:agent-request {id, requestId, command,
// args}`; preload hands it to the callback installed here as
// `liencamHost.agent.onRequest`. This module runs it on the model registry
// (`modelCommands`) and answers with the registry's own result envelope through
// `liencamHost.agent.respond(id, result)`.
//
// - Every answer is a result or a refusal; a throw is answered as a refusal, never
//   as a raw error (LIENCAM.md rule 11: one plain sentence).
// - A request whose requestId is already running joins that run, and an edit that
//   already finished returns its first result. The same call is never applied twice,
//   even when main answered `{pending}` after 30 s and the agent retried.
// - Installed from App.tsx in EVERY Electron build; a plain browser has no
//   `liencamHost.agent`, so nothing is installed there.

import { modelCommands } from './commands'
import { refuse, type ModelCommandResult } from './registry'

export interface AgentRequest {
  id: string
  requestId?: string
  command: string
  args?: unknown
  expectRevision?: number
}

export interface AgentHost {
  onRequest(callback: (request: unknown) => void): () => void
  respond(id: string, result: unknown): Promise<unknown> | unknown
}

export interface AgentBridgeOptions {
  /** Defaults to the real model registry. */
  commands?: Pick<typeof modelCommands, 'run' | 'list' | 'describe'>
}

/** The most results kept for retries; the registry keeps its own window for edits. */
const KEPT_RESULTS = 64

const BAD_REQUEST = 'That request was not understood. Send a command name and, if it needs any, its arguments.'

function isRequest(value: unknown): value is AgentRequest {
  if (value === null || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return typeof request.id === 'string' && typeof request.command === 'string'
}

/** Builds the handler for one request; exported so tests can drive it without a host. */
export function createAgentRequestHandler(options: AgentBridgeOptions = {}) {
  const commands = options.commands ?? modelCommands
  const running = new Map<string, Promise<ModelCommandResult>>()
  const finished = new Map<string, ModelCommandResult>()

  async function execute(request: AgentRequest): Promise<ModelCommandResult> {
    const { command } = request
    if (command === 'list_commands') {
      return { ok: true, command, step: null, revision: 0, changed: { created: [], edited: [], removed: [] }, status: {}, diagnostics: [], value: commands.list() }
    }
    if (command === 'describe_command') {
      const id = (request.args as { id?: unknown } | undefined)?.id
      if (typeof id !== 'string') return refuse('invalid-arguments', 'describe_command needs the command id as text.', 'id')
      const described = commands.describe(id)
      if (described === null) {
        return refuse('unknown-command', `"${id}" is not a model command. Ask for the list of commands to see what is available.`)
      }
      return { ok: true, command, step: null, revision: 0, changed: { created: [], edited: [], removed: [] }, status: {}, diagnostics: [], value: described }
    }
    return commands.run(command, request.args, {
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      ...(request.expectRevision === undefined ? {} : { expectRevision: request.expectRevision }),
    })
  }

  async function answer(request: AgentRequest): Promise<ModelCommandResult> {
    try {
      return await execute(request)
    } catch {
      return refuse('refused', `${request.command} could not be run and nothing was changed. Check the command and try again.`)
    }
  }

  return function handle(raw: unknown): Promise<ModelCommandResult> {
    if (!isRequest(raw)) return Promise.resolve(refuse('invalid-arguments', BAD_REQUEST))
    const request = raw
    const key = typeof request.requestId === 'string' && request.requestId !== '' ? request.requestId : undefined
    if (key !== undefined) {
      const done = finished.get(key)
      if (done !== undefined) return Promise.resolve(done)
      const live = running.get(key)
      if (live !== undefined) return live
    }
    const run = answer(request)
    if (key === undefined) return run
    running.set(key, run)
    void run.then((result) => {
      running.delete(key)
      // Reads are cheap and must stay current; only a call that changed something is kept.
      if (result.ok && result.step !== null) {
        finished.set(key, result)
        if (finished.size > KEPT_RESULTS) finished.delete(finished.keys().next().value as string)
      }
    })
    return run
  }
}

/** Wires the handler to the host. Returns the uninstall function, or undefined when there is no agent host. */
export function installAgentBridge(
  host: AgentHost | undefined = (globalThis as { liencamHost?: { agent?: AgentHost } }).liencamHost?.agent,
  options: AgentBridgeOptions = {},
): (() => void) | undefined {
  if (host === undefined || typeof host.onRequest !== 'function' || typeof host.respond !== 'function') return undefined
  const handle = createAgentRequestHandler(options)
  return host.onRequest((raw) => {
    const id = isRequest(raw) ? raw.id : undefined
    if (id === undefined) return
    void handle(raw)
      .then((result) => host.respond(id, result))
      .catch(() => undefined) // main gave up waiting; nothing left to tell it
  })
}
