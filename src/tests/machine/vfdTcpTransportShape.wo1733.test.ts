import { afterEach, describe, expect, it } from 'vitest'
import {
  __setActiveVfdPortLinkForTest,
  BRIDGE_SET_VFD_PORT,
  installVfdPortMemory,
  publishAppliedVfdDefinition,
  readBridgeVfdEndpoint,
  VFD_PORT_REFUSAL,
  VfdPortLink,
  type BridgeCallMessage,
  type BridgeMessage,
  type BridgeVfdEndpoint,
} from '../../lib/machine/bridgeTransport'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import type { VfdDefinition } from '../../lib/machine/vfd'

const RTU_ENDPOINT: BridgeVfdEndpoint = {
  transport: 'rtu', port: 'COM3', slaveAddress: 1,
}
const TCP_ENDPOINT: BridgeVfdEndpoint = {
  transport: 'tcp', host: '127.0.0.1', tcpPort: 15020, slaveAddress: 7,
}

function definition(transport: 'rtu' | 'tcp'): VfdDefinition {
  const value = structuredClone(HUANYANG_GT)
  if (transport === 'tcp') {
    value.id = 'wo1733-loopback'
    value.link = {
      transport: 'tcp', host: '127.0.0.1', tcpPort: 15020, slaveAddress: 7,
      pollIntervalMs: 40, retryCount: 2, timeoutMs: 350,
    }
  }
  return value
}

function hello(endpoint: BridgeVfdEndpoint): BridgeMessage {
  return {
    t: 'hello',
    v: {
      protocol: 1,
      bridge: 'wo1733-test',
      capabilities: {},
      readOnly: false,
      vfd: { present: true, verified: false, name: 'test drive', endpoint },
    },
  } as BridgeMessage
}

function status(endpoint: BridgeVfdEndpoint): BridgeMessage {
  return {
    t: 'vfd',
    v: {
      up: true,
      running: false,
      faulted: false,
      runStateWord: 3,
      commandWord: 0,
      setpointWord: 0,
      consecutiveFailures: 0,
      lastStopReason: 'none',
      lastError: null,
      statusWords: [],
      status: {},
      upToSpeed: null,
      endpoint,
      ...(endpoint.transport === 'rtu' ? { port: endpoint.port } : {}),
    },
  }
}

afterEach(() => {
  __setActiveVfdPortLinkForTest(null)
  installVfdPortMemory(null)
})

describe('WO-1733 typed VFD endpoint contract', () => {
  it('accepts only complete RTU and TCP endpoint facts at the socket boundary', () => {
    expect(readBridgeVfdEndpoint(RTU_ENDPOINT)).toEqual(RTU_ENDPOINT)
    expect(readBridgeVfdEndpoint(TCP_ENDPOINT)).toEqual(TCP_ENDPOINT)
    expect(readBridgeVfdEndpoint({ transport: 'tcp', host: '', tcpPort: 15020, slaveAddress: 7 })).toBeNull()
    expect(readBridgeVfdEndpoint({ transport: 'tcp', host: '127.0.0.1', tcpPort: 0, slaveAddress: 7 })).toBeNull()
    expect(readBridgeVfdEndpoint({ transport: 'rtu', port: 'COM3', slaveAddress: 0 })).toBeNull()
  })

  it('preserves typed RTU port moves and waits for the pushed endpoint as the readback', async () => {
    const sent: BridgeCallMessage[] = []
    const link = new VfdPortLink((call) => sent.push(call), () => {}, 1000, 'erics-machine')
    link.handleFrame(hello(RTU_ENDPOINT))
    link.handleFrame(status(RTU_ENDPOINT))

    expect(link.state().reportedEndpoint).toEqual(RTU_ENDPOINT)
    expect(link.state().reportedPort).toBe('COM3')

    const moving = link.selectPort('COM7')
    expect(sent.at(-1)).toMatchObject({ m: BRIDGE_SET_VFD_PORT, a: { port: 'COM7' } })
    const seq = sent.at(-1)?.seq
    if (seq === undefined) throw new Error('setVfdPort was not sent')
    link.handleFrame({ t: 'reply', seq, ok: true })
    expect(await moving).toEqual({ ok: true, error: null })
    expect(link.state().reportedPort).toBe('COM3')

    const moved = { ...RTU_ENDPOINT, port: 'COM7' } as const
    link.handleFrame(status(moved))
    expect(link.state().reportedEndpoint).toEqual(moved)
    expect(link.state().reportedPort).toBe('COM7')
  })

  it('never replays or sends a serial port command to a reported TCP link', async () => {
    const sent: BridgeCallMessage[] = []
    installVfdPortMemory({
      read: () => 'COM9',
      write: () => { throw new Error('a TCP endpoint must not remember a COM port') },
    })
    const link = new VfdPortLink((call) => sent.push(call), () => {}, 1000, 'tcp-machine')
    link.handleFrame(hello(TCP_ENDPOINT))
    link.handleFrame(status(TCP_ENDPOINT))

    expect(link.state().reportedEndpoint).toEqual(TCP_ENDPOINT)
    expect(link.state().reportedPort).toBeNull()
    expect(sent).toEqual([])
    await expect(link.selectPort('COM7')).resolves.toEqual({
      ok: false,
      error: VFD_PORT_REFUSAL.tcpLink,
    })
    expect(sent).toEqual([])
  })

  it('keeps apply receipts separate from endpoint readback and rejects stale-machine publication', () => {
    const oldLink = new VfdPortLink(() => {}, () => {}, 1000, 'old-machine')
    const liveLink = new VfdPortLink(() => {}, () => {}, 1000, 'live-machine')
    liveLink.handleFrame(hello(TCP_ENDPOINT))
    liveLink.handleFrame(status(TCP_ENDPOINT))
    __setActiveVfdPortLinkForTest(liveLink)

    publishAppliedVfdDefinition('old-machine', definition('rtu'))
    expect(liveLink.state().applied).toBeNull()

    publishAppliedVfdDefinition('live-machine', definition('rtu'))
    expect(liveLink.state().applied?.link.transport).toBe('rtu')
    // The receipt confirms a held document; only hello/status can claim which
    // endpoint is live, so the TCP readback remains until such a frame arrives.
    expect(liveLink.state().reportedEndpoint).toEqual(TCP_ENDPOINT)
    expect(liveLink.state().reportedPort).toBeNull()
    expect(oldLink.state().applied).toBeNull()
  })
})
