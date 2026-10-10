// WebSerialTransport - MachineTransport over the browser's Web Serial API.
// Chromium desktop only; callers feature-detect with WebSerialTransport.isSupported()
// and surface plain guidance otherwise. requestPort() must run inside a user
// gesture (browser rule). See docs/machine/GRBL-PROTOCOL.md, Web Serial notes.

import type { MachineTransport, TransportEvents } from './types'
import type { BytePipe } from './controller'

/** Default line rate for a serial controller. WO-422: baud is a SERIAL
 *  concern, not a GRBL one - it lives with the transport that uses it so the
 *  Control page can offer a baud without importing anything from grbl/. */
export const SERIAL_BAUD_DEFAULT = 115200

/** WO-423: `BytePipe` is declared as well as `MachineTransport`. The two are
 *  the same shape - this class already satisfied both - but saying so makes
 *  the compiler check it at the DECLARATION rather than at each connect call,
 *  which is the point of contract v3 typing `ControllerBackend.transport`. */
export class WebSerialTransport implements MachineTransport, BytePipe {
  private readonly port: SerialPort
  private readonly baudRate: number
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private events: TransportEvents | null = null
  private closed = false

  constructor(port: SerialPort, baudRate: number = SERIAL_BAUD_DEFAULT) {
    this.port = port
    this.baudRate = baudRate
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  /** Must be called from a user gesture. Throws if the user cancels the picker. */
  static async requestPort(): Promise<SerialPort> {
    return navigator.serial.requestPort()
  }

  /** Ports the user granted in earlier sessions (for a reconnect flow). */
  static async grantedPorts(): Promise<SerialPort[]> {
    return navigator.serial.getPorts()
  }

  async start(events: TransportEvents): Promise<void> {
    this.events = events
    await this.port.open({ baudRate: this.baudRate })
    if (!this.port.readable || !this.port.writable) {
      await this.safeClosePort()
      throw new Error('Serial port opened without readable/writable streams')
    }
    this.writer = this.port.writable.getWriter()
    this.reader = this.port.readable.getReader()
    void this.readLoop()
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Transport not started')
    await this.writer.write(data)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.reader?.cancel()
    } catch {
      // reader may already be errored by an unplug - proceed with close
    }
    await this.safeClosePort()
    this.events?.onClose(null)
  }

  private async readLoop(): Promise<void> {
    const reader = this.reader
    if (!reader || !this.events) return
    let reason: string | null = null
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.length > 0) this.events.onChunk(value)
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (!this.closed) {
      // Device-initiated end (unplug or stream error): tear down and notify.
      this.closed = true
      await this.safeClosePort()
      this.events.onClose(reason ?? 'device disconnected')
    }
  }

  private async safeClosePort(): Promise<void> {
    try {
      this.reader?.releaseLock()
    } catch {
      // lock may already be released
    }
    try {
      this.writer?.releaseLock()
    } catch {
      // lock may already be released
    }
    this.reader = null
    this.writer = null
    try {
      await this.port.close()
    } catch {
      // port may already be closed/lost
    }
  }
}
