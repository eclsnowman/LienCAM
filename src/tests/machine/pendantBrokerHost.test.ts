import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPendantBroker, stopPendantBroker } from '../../lib/machine/pendantBrokerHost'

describe('pendant broker host lifecycle client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('starts through the LienCAM host and returns the verified WebSocket address', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      brokerUrl: 'ws://127.0.0.1:8324/bridge',
      port: 8324,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(startPendantBroker()).resolves.toEqual({
      brokerUrl: 'ws://127.0.0.1:8324/bridge',
      port: 8324,
    })
    expect(fetchMock).toHaveBeenCalledWith('/__liencam/pendant-broker/start', expect.objectContaining({
      method: 'POST',
      headers: { 'X-LienCAM-Host': 'pendant' },
    }))
  })

  it('stops through the same host and surfaces lifecycle failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: 'The local pendant service did not become ready.',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(stopPendantBroker()).resolves.toBeUndefined()
    await expect(startPendantBroker()).rejects.toThrow('did not become ready')
  })
})
