import { describe, expect, it } from 'vitest'
import {
  createShopDataBackup,
  DEFAULT_USER_SPACE_STORAGE_KEY,
  previewShopDataRestore,
  restoreShopDataBackup,
  type LegacyStorage,
} from '../../store/userSpaceStorage'

const STORAGE_KEY = DEFAULT_USER_SPACE_STORAGE_KEY

class MemoryLegacyStorage implements LegacyStorage {
  readonly values = new Map<string, string>()

  getItem(name: string): string | null {
    return this.values.get(name) ?? null
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeItem(name: string): void {
    this.values.delete(name)
  }
}

function payload(state: Record<string, unknown>): string {
  return JSON.stringify({ state, version: 6 })
}

const MACHINE_OPERATOR_STATE = {
  control: { activeMachineId: 'machine-mill' },
  machineWorkOffsets: {
    'machine-mill': { G54: { x: 12.5, y: -3.25, z: 0 } },
  },
  machineDatumRevokedAxes: { 'machine-mill': ['X', 'Y'] },
} as const

function sourceWith(payloadText: string): MemoryLegacyStorage {
  const legacy = new MemoryLegacyStorage()
  legacy.setItem(STORAGE_KEY, payloadText)
  return legacy
}

describe('WO-1504 shop-data backup discloses machine operator state', () => {
  it('backs up a payload carrying work offsets, revoked datum axes and a control selection', async () => {
    const legacy = sourceWith(payload({ machineLibrary: [{ id: 'machine-mill' }], ...MACHINE_OPERATOR_STATE }))

    const backup = await createShopDataBackup({ durableStorage: null, legacyStorage: legacy })
    const bundle = JSON.parse(backup.text) as {
      content: { manifest: Array<{ id: string; itemCount: number }> }
    }
    const row = bundle.content.manifest.find((entry) => entry.id === 'machines')

    // The machine collection is the disclosed owner of all three operator keys:
    // 1 machine-library entry + the control selection + work offsets + revoked axes.
    expect(row).toBeDefined()
    expect(row!.itemCount).toBe(4)
  })

  it('discloses each machine operator key on its own', async () => {
    for (const [key, value] of Object.entries(MACHINE_OPERATOR_STATE)) {
      const legacy = sourceWith(payload({ [key]: value }))
      const backup = await createShopDataBackup({ durableStorage: null, legacyStorage: legacy })
      const bundle = JSON.parse(backup.text) as { content: { manifest: unknown[] } }
      expect(bundle.content.manifest.length).toBeGreaterThan(0)
    }
  })

  it('round-trips the three keys through preview and restore', async () => {
    const source = sourceWith(payload(MACHINE_OPERATOR_STATE))
    const backup = await createShopDataBackup({ durableStorage: null, legacyStorage: source })

    const preview = await previewShopDataRestore(backup.text, {
      durableStorage: null,
      legacyStorage: source,
    })
    expect(preview.checksum).toBe(backup.checksum)
    expect(preview.collectionCount).toBeGreaterThan(0)

    const target = new MemoryLegacyStorage()
    await restoreShopDataBackup(backup.text, { durableStorage: null, legacyStorage: target })
    const restored = JSON.parse(target.getItem(STORAGE_KEY)!) as { state: Record<string, unknown> }

    expect(restored.state.control).toEqual(MACHINE_OPERATOR_STATE.control)
    expect(restored.state.machineWorkOffsets).toEqual(MACHINE_OPERATOR_STATE.machineWorkOffsets)
    expect(restored.state.machineDatumRevokedAxes).toEqual(MACHINE_OPERATOR_STATE.machineDatumRevokedAxes)
  })

  it('still refuses a genuinely new uncataloged persisted collection', async () => {
    const legacy = sourceWith(payload({ brandNewCollection: { a: 1 } }))

    await expect(createShopDataBackup({ durableStorage: null, legacyStorage: legacy }))
      .rejects.toThrow(/undisclosed persisted collections.*brandNewCollection/)
  })
})
