// FakeBytePipe - a scripted BytePipe test double (see BytePipe in
// src/lib/machine/controller.ts). WO-440: the harness grblProbe.test.ts used
// to get from SimulatedGrblTransport before WO-433 retired that transport.
// This is deliberately NOT protocol emulation: it does not know GRBL, does
// not model motion or time, and never answers anything on its own. A test
// feeds it exact wire lines with `feed()` and reads back exactly what the
// controller wrote with `writtenItems()`/`realtimeBytes()`. Whatever GRBL
// behaviour a test needs (an `ok`, a status report, a `[PRB:...]` line) is
// the test's own responsibility to script, byte for byte.

import type { BytePipe } from '../../lib/machine/controller'

export class FakeBytePipe implements BytePipe {
  private events: { onChunk: (d: Uint8Array) => void; onClose: (r: string | null) => void } | null = null
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private written: Uint8Array[] = []
  private closed = false

  async start(events: { onChunk: (d: Uint8Array) => void; onClose: (r: string | null) => void }): Promise<void> {
    this.events = events
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(data)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.events?.onClose(null)
  }

  /** Deliver raw text from the "controller" side of the wire, exactly as
   *  received - the caller supplies line terminators. */
  feed(text: string): void {
    if (!this.events) throw new Error('FakeBytePipe.feed() before start()')
    this.events.onChunk(this.encoder.encode(text))
  }

  /** Simulate the transport dying on its own (unplug, fatal read error) -
   *  the disconnect path GrblController must still settle pending work on. */
  unplug(reason = 'device disconnected'): void {
    if (this.closed) return
    this.closed = true
    this.events?.onClose(reason)
  }

  /** Every write so far, decoded: line writes as text (newline stripped),
   *  single realtime bytes as `[0xNN]`. */
  writtenItems(): string[] {
    return this.written.map((w) =>
      w.length === 1 && (w[0] < 0x20 || w[0] > 0x7e)
        ? `[0x${w[0].toString(16)}]`
        : this.decoder.decode(w).replace(/\n$/, ''),
    )
  }

  /** Single-byte realtime writes only (status query, feed hold, soft reset, ...). */
  realtimeBytes(): number[] {
    return this.written.filter((w) => w.length === 1).map((w) => w[0])
  }

  /** Discard everything written so far - callers use this after the connect
   *  handshake to keep later assertions focused on the traffic they care about. */
  clearWritten(): void {
    this.written = []
  }
}
