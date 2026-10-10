// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveFile } from '../../lib/saveFile'

type HostGlobal = typeof globalThis & { liencamHost?: { saveFile?: (name: string, data: string | Uint8Array) => Promise<string | null> } }

describe('saveFile - every Save / Export writes a file (Operator 09-25: Export .nc did nothing)', () => {
  afterEach(() => {
    delete (globalThis as HostGlobal).liencamHost
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('in the desktop app hands the bytes to the host save dialog', async () => {
    const hostSave = vi.fn(async (_name: string, _data: string | Uint8Array) => 'C:\\workspace\\Downloads\\part.nc')
    ;(globalThis as HostGlobal).liencamHost = { saveFile: hostSave }
    await expect(saveFile('part.nc', 'G0 X0\n')).resolves.toBe('C:\\workspace\\Downloads\\part.nc')
    expect(hostSave).toHaveBeenCalledWith('part.nc', 'G0 X0\n')
  })

  it('sends binary as bytes and reports a cancelled dialog as null', async () => {
    const hostSave = vi.fn(async (_name: string, _data: string | Uint8Array): Promise<string | null> => null)
    ;(globalThis as HostGlobal).liencamHost = { saveFile: hostSave }
    await expect(saveFile('a.stl', new Blob([new Uint8Array([1, 2, 3])]))).resolves.toBeNull()
    expect(Array.from(hostSave.mock.calls[0][1] as Uint8Array)).toEqual([1, 2, 3])
  })

  it('in a browser keeps the link alive after the click, so a late download still finds it', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    void saveFile('part.nc', 'G0 X0\n')
    expect(click).toHaveBeenCalledTimes(1)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(revoke).toHaveBeenCalledWith('blob:x')
  })
})
