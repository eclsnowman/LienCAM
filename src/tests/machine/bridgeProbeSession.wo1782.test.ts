import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('pendant/uccnc-bridge/Bridge.cs', 'utf8')

describe('WO-1782 bridge session ownership boundary', () => {
  it('keeps TCP accept and handshake parsing outside the one-session slot', () => {
    const serve = source.slice(source.indexOf('static void Serve(TcpClient client)'), source.indexOf('/** What this controller can actually do.'))
    const handshake = serve.indexOf('if (!Handshake(net, delegate')
    const claim = serve.indexOf('Interlocked.CompareExchange(ref sessionBusy, 1, 0)')

    expect(handshake).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(handshake)
    expect(serve).toContain('ownsSession = true;')
  })

  it('lets only the claimant release ownership while only a live session runs safety cleanup', () => {
    const serve = source.slice(source.indexOf('static void Serve(TcpClient client)'), source.indexOf('/** What this controller can actually do.'))

    expect(serve).toContain('if (live)')
    // WO-3124 609b6f7067 carries departing staging ownership into cleanup.
    expect(serve).toContain('machine.PanicStop(departingStaging);')
    expect(serve).toContain('if (ownsSession) Interlocked.Exchange(ref sessionBusy, 0);')
    expect(serve).not.toMatch(/\n\s*Interlocked\.Exchange\(ref sessionBusy, 0\);/)
  })

  it('claims before sending 101 so competing valid clients cannot both open', () => {
    const handshake = source.slice(source.indexOf('static bool Handshake('), source.indexOf('// ---- minimal WebSocket frame codec'))

    expect(handshake.indexOf('if (!claimSession()) return false;')).toBeLessThan(
      handshake.indexOf('HTTP/1.1 101 Switching Protocols'),
    )
  })
})
