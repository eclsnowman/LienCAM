// LineFramer - reassembles complete text lines from arbitrary byte chunks.
//
// Web Serial delivers reads at arbitrary boundaries: one GRBL line can span
// several chunks, several lines can share one chunk, and a multi-byte UTF-8
// sequence can split across reads. A stateful TextDecoder plus a carry buffer
// is therefore mandatory (see docs/machine/GRBL-PROTOCOL.md, Web Serial notes).

export class LineFramer {
  private decoder = new TextDecoder()
  private carry = ''

  /** Feed one chunk; returns every line completed by it (without terminators). */
  push(chunk: Uint8Array): string[] {
    this.carry += this.decoder.decode(chunk, { stream: true })
    const lines: string[] = []
    let nl: number
    while ((nl = this.carry.indexOf('\n')) >= 0) {
      let line = this.carry.slice(0, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      lines.push(line)
      this.carry = this.carry.slice(nl + 1)
    }
    return lines
  }

  /** Any unterminated tail (e.g. at disconnect). Clears the buffer. */
  flush(): string {
    const rest = this.carry + this.decoder.decode()
    this.carry = ''
    this.decoder = new TextDecoder()
    return rest
  }
}
