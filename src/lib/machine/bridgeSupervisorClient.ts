import type {
  BridgeProcessStatus,
  BridgeRestartResult,
  BridgeStopResult,
} from './bridgeHost'

export const BRIDGE_SUPERVISOR_PORT_OFFSET = 1
const REQUEST_TIMEOUT_MS = 12_000

export class BridgeSupervisorUnavailableError extends Error {
  constructor(message = 'The bridge supervisor is not reachable on this computer.') {
    super(message)
    this.name = 'BridgeSupervisorUnavailableError'
  }
}

function supervisorUrl(bridgePort: number, path: string): string {
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort >= 65535) {
    throw new Error(`Bridge port ${bridgePort} cannot have a supervisor on port + 1.`)
  }
  return `http://127.0.0.1:${bridgePort + BRIDGE_SUPERVISOR_PORT_OFFSET}${path}`
}

async function supervisorRequest<T>(
  bridgePort: number,
  path: '/status' | '/start' | '/restart' | '/stop',
  method: 'GET' | 'POST',
  args?: string[],
): Promise<T> {
  let timer: number | undefined
  try {
    const response = await Promise.race([
      fetch(supervisorUrl(bridgePort, path), {
        method,
        cache: 'no-store',
        ...(args === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ args }),
        }),
      }),
      new Promise<Response>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(
          new BridgeSupervisorUnavailableError('The bridge supervisor request timed out.'),
        ), REQUEST_TIMEOUT_MS)
      }),
    ])
    if (!response.ok) {
      throw new Error(`Bridge supervisor ${path} returned HTTP ${response.status}.`)
    }
    return await response.json() as T
  } catch (error) {
    if (error instanceof BridgeSupervisorUnavailableError) throw error
    throw new BridgeSupervisorUnavailableError(
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

export function supervisorBridgeStatus(bridgePort: number): Promise<BridgeProcessStatus> {
  return supervisorRequest(bridgePort, '/status', 'GET')
}

export function supervisorStartBridge(bridgePort: number, args: string[]): Promise<BridgeRestartResult> {
  return supervisorRequest(bridgePort, '/start', 'POST', args)
}

export function supervisorRestartBridge(bridgePort: number, args: string[]): Promise<BridgeRestartResult> {
  return supervisorRequest(bridgePort, '/restart', 'POST', args)
}

export function supervisorStopBridge(bridgePort: number): Promise<BridgeStopResult> {
  return supervisorRequest(bridgePort, '/stop', 'POST')
}
