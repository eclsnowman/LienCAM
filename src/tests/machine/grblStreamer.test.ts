import { describe, expect, it } from 'vitest'
import { CharacterCountStreamer } from '../../lib/machine/grbl/streamer'
import { isSendableGcodeLine, prepareProgram, stripGcodeComments } from '../../lib/gcode/text'

function makeStreamer(limit?: number) {
  const sent: string[] = []
  const s = new CharacterCountStreamer((text) => sent.push(text), limit)
  return { s, sent }
}

describe('stripGcodeComments', () => {
  it('strips both comment styles and trims', () => {
    expect(stripGcodeComments('G1 X10 (move over) Y2 ; tail')).toBe('G1 X10  Y2')
    expect(stripGcodeComments('; whole line')).toBe('')
    expect(stripGcodeComments('(whole line)')).toBe('')
  })
})

describe('isSendableGcodeLine', () => {
  it('matches exactly what prepareProgram drops: blanks, comments, % markers', () => {
    expect(isSendableGcodeLine('G1 X5 F100')).toBe(true)
    expect(isSendableGcodeLine('G1 X5 ; tail comment')).toBe(true)
    expect(isSendableGcodeLine('')).toBe(false)
    expect(isSendableGcodeLine('   ')).toBe(false)
    expect(isSendableGcodeLine('(comment only)')).toBe(false)
    expect(isSendableGcodeLine('%')).toBe(false)
    expect(isSendableGcodeLine('  % ; program end')).toBe(false)
    expect(isSendableGcodeLine('(header) %')).toBe(false)
  })
})

describe('prepareProgram', () => {
  it('drops blanks, comment-only lines, and % markers while preserving source lines', () => {
    const text = '%\nG21\n\n(setup)\nG90\nG1 X5 F100 ; cut\n%'
    const r = prepareProgram(text)
    expect(r.lines.map((l) => l.text)).toEqual(['G21', 'G90', 'G1 X5 F100'])
    expect(r.lines.map((l) => l.sourceLine)).toEqual([2, 5, 6])
    expect(r.skipped).toBe(4)
    expect(r.overlongLines).toEqual([])
  })

  it('flags lines over the 80-char GRBL line buffer', () => {
    const long = 'G1 X1' + ' Y2'.repeat(40)
    const r = prepareProgram(`G21\n${long}`)
    expect(r.overlongLines).toEqual([2])
  })
})

describe('CharacterCountStreamer', () => {
  it('fills the buffer up to the limit and no further', () => {
    // Lines cost 10+1=11 bytes each; limit 40 fits 3 in flight (33), not 4.
    const { s, sent } = makeStreamer(40)
    const lines = Array.from({ length: 6 }, (_, i) => ({
      text: `G1X${String(i).padStart(7, '0')}`,
      sourceLine: i + 1,
    }))
    for (const l of lines) expect(l.text.length).toBe(10)
    s.load(lines)
    s.start()
    expect(sent.length).toBe(3)
    expect(s.progress().bytesInFlight).toBe(33)
  })

  it('sends the next line on each ok and completes', () => {
    const { s, sent } = makeStreamer(40)
    const lines = Array.from({ length: 5 }, (_, i) => ({
      text: `G1X${String(i).padStart(7, '0')}`,
      sourceLine: i + 1,
    }))
    s.load(lines)
    s.start()
    let guard = 0
    while (s.progress().phase !== 'complete' && guard++ < 20) {
      expect(s.handleAck(true)).toBeNull()
    }
    expect(s.progress().phase).toBe('complete')
    expect(sent.length).toBe(5)
    expect(s.progress().ackedLines).toBe(5)
    // all acked -> nothing in flight
    expect(s.progress().bytesInFlight).toBe(0)
  })

  it('never exceeds the byte limit at any point in a long stream', () => {
    const sent: string[] = []
    const limit = 50
    const s = new CharacterCountStreamer((t) => sent.push(t), limit)
    const lines = Array.from({ length: 100 }, (_, i) => ({
      text: `G1 X${(i * 0.1).toFixed(3)} Y${(i * 0.2).toFixed(3)} F1500`,
      sourceLine: i + 1,
    }))
    s.load(lines)
    s.start()
    let maxInFlight = 0
    for (let i = 0; i < lines.length; i++) {
      maxInFlight = Math.max(maxInFlight, s.progress().bytesInFlight)
      expect(s.progress().bytesInFlight).toBeLessThanOrEqual(limit)
      s.handleAck(true)
    }
    expect(s.progress().phase).toBe('complete')
    expect(maxInFlight).toBeGreaterThan(0)
  })

  it('halts on error:N, reports the offending source line, and stops filling', () => {
    const { s, sent } = makeStreamer(200)
    s.load(prepareProgram('G21\nG90\nG1 X5 F100\nG1 X10').lines)
    s.start()
    expect(sent.length).toBe(4) // small program fits entirely in flight
    expect(s.handleAck(true)).toBeNull()
    const err = s.handleAck(false, 20)
    expect(err).not.toBeNull()
    expect(err!.code).toBe(20)
    expect(err!.sourceLine).toBe(2)
    expect(s.progress().phase).toBe('failed')
    // further acks for already-buffered lines do not resurrect the stream
    s.handleAck(true)
    expect(s.progress().phase).toBe('failed')
    expect(sent.length).toBe(4)
  })

  it('pause stops filling; resume refills', () => {
    const { s, sent } = makeStreamer(12) // fits exactly one 11-byte line
    const lines = Array.from({ length: 3 }, (_, i) => ({
      text: `G1X${String(i).padStart(7, '0')}`,
      sourceLine: i + 1,
    }))
    s.load(lines)
    s.start()
    expect(sent.length).toBe(1)
    s.pause()
    s.handleAck(true) // ack while paused frees bytes but must not send
    expect(sent.length).toBe(1)
    s.resume()
    expect(sent.length).toBe(2)
  })

  it('ignores acks that predate the loaded job (MDI traffic)', () => {
    const { s, sent } = makeStreamer()
    expect(s.handleAck(true)).toBeNull()
    expect(s.progress().phase).toBe('empty')
    s.load(prepareProgram('G21').lines)
    expect(s.ownsNextAck()).toBe(false) // nothing sent yet
    s.start()
    expect(s.ownsNextAck()).toBe(true)
    expect(sent.length).toBe(1)
  })

  it('progress reports acked and sent source lines for the UI cursor', () => {
    const { s } = makeStreamer(200)
    s.load(prepareProgram('G21\n(comment)\nG90\nG1 X2 F100').lines)
    s.start()
    s.handleAck(true)
    const p = s.progress()
    expect(p.ackedSourceLine).toBe(1)
    expect(p.sentSourceLine).toBe(4) // comment line skipped, mapping preserved
    expect(p.totalLines).toBe(3)
  })
})
