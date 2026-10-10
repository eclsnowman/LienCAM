import { describe, expect, it } from 'vitest'
import { LineFramer } from '../../lib/machine/lineFramer'

const enc = new TextEncoder()

describe('LineFramer', () => {
  it('emits complete lines from a single chunk', () => {
    const f = new LineFramer()
    expect(f.push(enc.encode('ok\r\nok\n'))).toEqual(['ok', 'ok'])
  })

  it('reassembles a line split across chunks', () => {
    const f = new LineFramer()
    expect(f.push(enc.encode('<Idle|MPos:0.000,'))).toEqual([])
    expect(f.push(enc.encode('0.000,0.000|FS:0,0>\r\n'))).toEqual([
      '<Idle|MPos:0.000,0.000,0.000|FS:0,0>',
    ])
  })

  it('handles many lines plus a partial tail in one chunk', () => {
    const f = new LineFramer()
    const lines = f.push(enc.encode('ok\nerror:9\nALARM:1\n<Idl'))
    expect(lines).toEqual(['ok', 'error:9', 'ALARM:1'])
    expect(f.push(enc.encode('e>\n'))).toEqual(['<Idle>'])
  })

  it('strips lone CR before LF but keeps interior content intact', () => {
    const f = new LineFramer()
    expect(f.push(enc.encode('Grbl 1.1h [\'$\' for help]\r\n'))).toEqual([
      "Grbl 1.1h ['$' for help]",
    ])
  })

  it('flush returns the unterminated tail and resets', () => {
    const f = new LineFramer()
    f.push(enc.encode('partial'))
    expect(f.flush()).toBe('partial')
    expect(f.push(enc.encode('ok\n'))).toEqual(['ok'])
  })

  it('survives a multi-byte character split across chunk boundaries', () => {
    const f = new LineFramer()
    const bytes = enc.encode('[MSG:é]\n') // e-acute is 2 bytes in UTF-8
    const cut = 6 // split inside the 2-byte sequence
    expect(f.push(bytes.slice(0, cut))).toEqual([])
    expect(f.push(bytes.slice(cut))).toEqual(['[MSG:é]'])
  })
})
