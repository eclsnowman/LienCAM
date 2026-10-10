// WO-1987: the socket to the LinuxCNC gateway (pendant/linuxcnc-gateway/,
// docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md).
//
// LinuxCNC's own code. It shares a wire FORMAT with the UCCNC bridge - one
// JSON object per text frame - and nothing else: Operator ruling 2026-09-26, "UCCNC and
// LinuxCNC are completely different software". No UCCNC bridge code is used
// here or behind it.

import type { MessageChannel } from '../controller'

// MachineConfig's declaration is outside WO-2101's owned paths. Augment the
// persisted record from LinuxCNC's own module (as grbl/settings.ts does for
// `grblSettings`), so the address is a machine fact with no second store.
declare module '../../../types' {
  interface MachineConfig {
    /**
     * WO-2101: where this machine's LinuxCNC gateway listens - the LinuxCNC
     * PC's network address, `host` or `host:port`. Absent or blank: this
     * computer (127.0.0.1) on gateway.py's default port. LinuxCNC machines
     * only; no other controller reads it.
     */
    linuxcncGatewayAddress?: string
  }
}

/** gateway.py's own default (`--port`). */
export const LINUXCNC_GATEWAY_DEFAULT_PORT = 8327

const THIS_COMPUTER = '127.0.0.1'

export function linuxcncGatewayUrl(port: number = LINUXCNC_GATEWAY_DEFAULT_PORT, host: string = THIS_COMPUTER): string {
  const bare = host.replace(/^\[|\]$/g, '')
  return `ws://${bare.includes(':') ? `[${bare}]` : bare}:${port}/`
}

/** The gateway address a machine definition states, read as a host and an
 *  optional port. Accepts `host`, `host:port`, `[v6]`, `[v6]:port`, a bare
 *  IPv6 address and a `ws://host:port/` URL. Blank means this computer. */
export function parseLinuxcncGatewayAddress(
  text: string | null | undefined,
): { host: string; port?: number } {
  const typed = (text ?? '').trim()
  if (!typed) return { host: THIS_COMPUTER }
  if (!/^wss?:\/\//i.test(typed) && (typed.match(/:/g) ?? []).length > 1 && !typed.startsWith('[')) {
    return { host: typed }  // a bare IPv6 address: no port
  }
  let url: URL
  try {
    url = new URL(/^wss?:\/\//i.test(typed) ? typed : `ws://${typed}`)
  } catch {
    throw new Error(`"${typed}" is not a network address. Type the LinuxCNC PC's address, `
      + 'e.g. 192.0.2.20 or 192.0.2.20:8327.')
  }
  return url.port ? { host: url.hostname, port: Number(url.port) } : { host: url.hostname }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

type SocketFactory = (url: string) => WebSocket

/**
 * One WebSocket to the gateway - on this computer, or (WO-2101) on the
 * LinuxCNC PC across the network, where gateway.py runs with `--host 0.0.0.0`.
 */
export class LinuxcncGatewayTransport implements MessageChannel {
  readonly url: string
  private readonly openSocket: SocketFactory
  private socket: WebSocket | null = null
  private closed = false

  constructor(
    url: string = linuxcncGatewayUrl(),
    openSocket: SocketFactory = (target) => new WebSocket(target),
  ) {
    this.url = url
    this.openSocket = openSocket
  }

  start(events: { onMessage: (m: unknown) => void; onClose: (r: string | null) => void }): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false
      const socket = this.openSocket(this.url)
      this.socket = socket
      socket.addEventListener('open', () => {
        opened = true
        resolve()
      })
      socket.addEventListener('message', (event) => {
        let message: unknown
        try {
          message = JSON.parse(String((event as MessageEvent).data))
        } catch {
          return
        }
        events.onMessage(message)
      })
      socket.addEventListener('error', () => {
        if (opened) return
        const local = LOOPBACK_HOSTS.has(new URL(this.url).hostname)
        reject(new Error(local
          ? `The LinuxCNC gateway at ${this.url} did not accept the connection. Start gateway.py on this `
            + 'computer (python3 pendant/linuxcnc-gateway/gateway.py) with LinuxCNC running; it takes one '
            + 'LienCAM window at a time.'
          : `The LinuxCNC gateway at ${this.url} did not accept the connection. On the LinuxCNC PC, start `
            + 'gateway.py listening on the network (python3 gateway.py --host 0.0.0.0) with LinuxCNC running, '
            + 'and check the address on Machine > Definition > Controller; it takes one LienCAM window at a time.'))
      })
      socket.addEventListener('close', (event) => {
        this.socket = null
        if (!opened) return
        const close = event as CloseEvent
        events.onClose(this.closed ? null : close.reason || `The LinuxCNC gateway closed the connection (${close.code}).`)
      })
    })
  }

  send(message: unknown): void {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    socket.send(JSON.stringify(message))
  }

  close(): Promise<void> {
    this.closed = true
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState <= 1) socket.close()
    return Promise.resolve()
  }
}
