// @vitest-environment jsdom
//
// WO-2121 fix round 1: a geometry operation the kernel never finishes (Shell on the
// whole stage 4b part) held every later kernel call, operation and Undo rebuild -
// measured in the app, src/tests/evidence/FORM/stagehold-before. The status strip's
// Cancel abandons the worker's waiting calls through this wrapper so the stuck
// rebuild unwinds; these pin the wrapper. The app run each way is stagehold-before/
// (no Cancel) and stagehold/ (Cancel).

import { describe, expect, it, vi } from 'vitest'
import type { GeomClient } from '../../geom'
import { abandonableGeomClient } from '../../components/model3d/SolidsWorkbenchPage'

function fakeClient() {
  const never = new Promise<never>(() => {})
  const client = {
    init: vi.fn(async () => ({ kernel: 'fake' })),
    measure: vi.fn(async () => ({ kind: 'volume', value: 42 })),
    applyShell: vi.fn(() => never),
    terminate: vi.fn(async () => undefined),
  }
  return client
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('abandonable geometry client', () => {
  it('passes calls through and reports busy only while a call waits (init not counted)', async () => {
    const inner = fakeClient()
    let t = 1000
    const client = abandonableGeomClient(inner as unknown as GeomClient, { now: () => t })
    await client.init()
    expect(client.busySince()).toBeNull()
    await expect(client.measure(1 as never, 'volume')).resolves.toEqual({ kind: 'volume', value: 42 })
    expect(inner.measure).toHaveBeenCalledWith(1, 'volume')
    expect(client.busySince()).toBeNull()
    void client.applyShell({} as never)
    t = 2000
    void client.applyShell({} as never)
    expect(client.busySince()).toBe(1000)
  })

  it('abandon rejects the call that never returns, rejects later calls and kills the worker once', async () => {
    const inner = fakeClient()
    const client = abandonableGeomClient(inner as unknown as GeomClient)
    const stuck = client.applyShell({} as never)
    await flush()
    client.abandon('the operation was cancelled')
    await expect(stuck).rejects.toThrow('the operation was cancelled')
    expect(client.busySince()).toBeNull()
    await expect(client.measure(1 as never, 'volume')).rejects.toThrow('the operation was cancelled')
    await client.terminate()
    await flush()
    expect(inner.terminate).toHaveBeenCalledTimes(1)
  })

  it('terminate alone kills the worker and rejects nothing (unmount behaves as before)', async () => {
    const inner = fakeClient()
    const client = abandonableGeomClient(inner as unknown as GeomClient)
    let settled = false
    void client.applyShell({} as never).then(() => { settled = true }, () => { settled = true })
    await client.terminate()
    await flush()
    expect(inner.terminate).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
  })

  it('a restarted worker holds calls until its kernel has loaded', async () => {
    const inner = fakeClient()
    let loaded!: () => void
    inner.init.mockImplementationOnce(() => new Promise((r) => { loaded = () => r({ kernel: 'fake' }) }))
    const client = abandonableGeomClient(inner as unknown as GeomClient, { gateUntilInit: true })
    const volume = client.measure(1 as never, 'volume')
    const init = client.init()
    await flush()
    expect(inner.measure).not.toHaveBeenCalled()
    loaded()
    await init
    await expect(volume).resolves.toEqual({ kind: 'volume', value: 42 })
  })
})
