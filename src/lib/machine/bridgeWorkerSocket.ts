// WO-3121: the socket and cadence belong to a dedicated worker, but process
// existence is NOT UI liveness. Each tick needs a fresh, single-use response.
// No response means no frame; no socket close or substitute stop is invented.
export const BRIDGE_SOCKET_WORKER_SOURCE = `
let socket, timer = null, epoch = 0, challenge = 0, pending = null;
const clear = () => { clearInterval(timer); timer = null; pending = null; };
self.onmessage = ({data: message}) => {
  if (message.type === 'connect') {
    const opened = socket = new WebSocket(message.url);
    opened.onopen = () => self.postMessage({type: 'open'});
    opened.onmessage = event => self.postMessage({type: 'message', data: event.data});
    opened.onerror = () => self.postMessage({type: 'error'});
    opened.onclose = event => {
      clear();
      self.postMessage({type: 'close', code: event.code, reason: event.reason});
    };
  } else if (message.type === 'cadence') {
    clear();
    epoch = message.epoch;
    if (!message.intervalMs) return;
    timer = setInterval(() => {
      // Replace rather than accumulate: queued UI work cannot authorize a
      // later tick, and a consumed token can never refresh the watchdog twice.
      pending = {epoch, challenge: ++challenge, expires: performance.now() + message.intervalMs};
      self.postMessage({type: 'progress', epoch, challenge});
    }, message.intervalMs);
  } else if (message.type === 'ack') {
    if (!pending || message.epoch !== pending.epoch || message.challenge !== pending.challenge
        || performance.now() >= pending.expires) {
      self.postMessage({type: 'ackResult', epoch: message.epoch, challenge: message.challenge, sent: false});
      return;
    }
    pending = null;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message.data);
      self.postMessage({type: 'ackResult', epoch: message.epoch, challenge: message.challenge, sent: true});
    }
  } else if (message.type === 'send') {
    if (socket.readyState === WebSocket.OPEN) socket.send(message.data);
  } else if (message.type === 'close') {
    clear();
    socket.close();
  }
};
`

/** The existing transport owns parsing, retry and close semantics. Only this
 * small WebSocket-shaped boundary moves bytes and scheduling off the UI. */
export interface BridgeSocket {
  readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): Promise<boolean> | void
  close(): void
  startKeepAlive?: (intervalMs: number, onTick: () => void) => void
  stopKeepAlive?: () => void
}

export class BridgeWorkerSocket implements BridgeSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private readonly worker: Worker
  private epoch = 0
  private onTick: (() => void) | null = null
  private readonly deliveries = new Map<string, (sent: boolean) => void>()
  private authorization: { epoch: number; challenge: number } | null = null

  constructor(url: string) {
    const blob = URL.createObjectURL(new Blob([BRIDGE_SOCKET_WORKER_SOURCE], { type: 'text/javascript' }))
    try { this.worker = new Worker(blob) }
    finally { URL.revokeObjectURL(blob) }
    this.worker.onmessage = ({ data }) => {
      if (this.readyState === 3) return
      if (data.type === 'open') {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.onopen?.(new Event('open'))
      } else if (data.type === 'message') {
        this.onmessage?.({ data: data.data } as MessageEvent)
      } else if (data.type === 'error') {
        this.onerror?.(new Event('error'))
      } else if (data.type === 'close') {
        this.finish(data.code, data.reason)
      } else if (data.type === 'ackResult') {
        const key = `${data.epoch}:${data.challenge}`
        const settle = this.deliveries.get(key)
        this.deliveries.delete(key)
        settle?.(data.sent)
      } else if (data.type === 'progress' && this.readyState === 1 && data.epoch === this.epoch && this.onTick) {
        this.authorization = { epoch: data.epoch, challenge: data.challenge }
        try { this.onTick() }
        finally { this.authorization = null }
      }
    }
    this.worker.onerror = () => {
      this.onerror?.(new Event('error'))
      this.finish(1006, 'machine bridge worker failed')
    }
    this.worker.postMessage({ type: 'connect', url })
  }

  send(data: string): Promise<boolean> | void {
    if (this.readyState !== 1) throw new Error('Transport not started')
    // Only that tick's query is authorized. Report its local delivery outcome
    // separately from bridge replies; stale authorizations never reach the wire.
    if (this.authorization && JSON.parse(data).m === 'queryStatus') {
      const authorization = this.authorization
      this.authorization = null
      const key = `${authorization.epoch}:${authorization.challenge}`
      const result = new Promise<boolean>(resolve => { this.deliveries.set(key, resolve) })
      try { this.worker.postMessage({ type: 'ack', ...authorization, data }) }
      catch (err) { this.deliveries.delete(key); throw err }
      return result
    } else {
      this.worker.postMessage({ type: 'send', data })
    }
  }

  startKeepAlive(intervalMs: number, onTick: () => void): void {
    this.onTick = onTick
    this.worker.postMessage({ type: 'cadence', epoch: ++this.epoch, intervalMs })
  }

  stopKeepAlive(): void {
    this.onTick = null
    this.authorization = null
    this.worker.postMessage({ type: 'cadence', epoch: ++this.epoch, intervalMs: 0 })
  }

  close(): void {
    if (this.readyState >= 2) return
    this.readyState = 2
    this.onTick = null
    // Termination closes the worker-owned WebSocket, including during startup.
    this.worker.terminate()
    this.finish(1000, '')
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onTick = null
    this.authorization = null
    this.worker.terminate()
    // Controller teardown owns connection-loss failures. Release all local
    // outcome waiters too, so none can retain a dead socket/session.
    for (const settle of this.deliveries.values()) settle(false)
    this.deliveries.clear()
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

export function createBridgeSocket(url: string): BridgeSocket {
  if (typeof Worker !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try { return new BridgeWorkerSocket(url) }
    catch { /* Same renderer timer/socket fallback as before if workers are unavailable. */ }
  }
  return new WebSocket(url)
}
