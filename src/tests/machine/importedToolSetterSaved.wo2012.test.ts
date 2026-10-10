// WO-2012: Operator's FixedProbePos must reach the SAVED machine record and survive
// save + reload, through the bridge-shaped import, the local-file import and
// the store's load door (adoptMachineDocument), which never invents one.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MachineConfig } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => [...mem.keys()][index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { adoptMachineDocument } = await import('../../store')
const { DEFAULT_MACHINE_PROBE_DEFAULTS } = await import('../../lib/machine/toolTable')
const { fixedToolSetterPosition } = await import('../../lib/machine/machineSession')
const {
  bridgeProfileSettingsText, importUccncProfile, previewBridgeProfileChanges,
  previewLocalUccncProfile, withImportedUccncToolSetter,
} = await import('../../lib/machine/uccncProfileImport')

const PROFILE = readFileSync(resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')
const SAMPLE_MACHINE = 'True,0,True,738,True,724.5,True,120,False,0,False,0,False,0,54.9,False,0'
const withTuple = (tuple: string): string =>
  PROFILE.replace(/^FixedProbePos=.*$/m, `FixedProbePos=${tuple}`)

function target(): MachineConfig {
  return {
    id: 'wo2012', name: 'Operator', type: 'gantry_router', kind: 'router', controller: 'uccnc',
    travel: { x: 800, y: 800, z: 120 },
    probing: { ...DEFAULT_MACHINE_PROBE_DEFAULTS },
    rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

function bridgeReply(text: string) {
  const settings: { section: string; key: string; value: string }[] = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const head = /^\[(.+)\]$/.exec(line)
    if (head) { section = head[1]; continue }
    const eq = line.indexOf('=')
    if (section && eq > 0) settings.push({ section, key: line.slice(0, eq), value: line.slice(eq + 1) })
  }
  return { ok: true, reason: null, path: 'C:/UCCNC/Profiles/operator.pro', fileHash: 'abc', settings }
}

function saveAndReload(machine: MachineConfig): MachineConfig {
  return adoptMachineDocument(JSON.parse(JSON.stringify(machine)) as MachineConfig)
}

describe('WO-2012 - the imported tool setter reaches the saved machine', () => {
  it('bridge-shaped import writes the setter and it survives save + reload', () => {
    const preview = previewBridgeProfileChanges(target(), bridgeReply(withTuple(SAMPLE_MACHINE)) as never)
    expect(preview.toolSetter).toEqual({ x: 738, y: 724.5, z: 120 })
    const imported = withImportedUccncToolSetter(
      { ...target(), controllerDefinition: preview.definition! }, preview.toolSetter ?? null,
    )
    const reloaded = saveAndReload(imported)
    expect(reloaded.probing?.toolSetter).toEqual({ x: 738, y: 724.5, z: 120 })
    expect(fixedToolSetterPosition(reloaded)).toEqual({ x: 738, y: 724.5, z: 120 })
  })

  it('local-file import writes the setter and it survives save + reload', () => {
    const preview = previewLocalUccncProfile(target(), 'operator.pro', withTuple(SAMPLE_MACHINE))
    const imported = withImportedUccncToolSetter(
      { ...target(), controllerDefinition: preview.definition! }, preview.toolSetter ?? null,
    )
    expect(saveAndReload(imported).probing?.toolSetter).toEqual({ x: 738, y: 724.5, z: 120 })
  })

  it('flags False leave the setter unset', () => {
    const text = withTuple('False,0,False,738,False,724.5,False,120,False,0,False,0,False,0,54.9,False,0')
    expect(importUccncProfile(text).toolSetter).toBeNull()
    const preview = previewBridgeProfileChanges(target(), bridgeReply(text) as never)
    const imported = withImportedUccncToolSetter(
      { ...target(), controllerDefinition: preview.definition! }, preview.toolSetter ?? null,
    )
    expect(saveAndReload(imported).probing?.toolSetter).toBeUndefined()
  })

  it('a cleared setter stays cleared through reload (WO-1730 clear-all contract)', () => {
    const preview = previewLocalUccncProfile(target(), 'operator.pro', withTuple(SAMPLE_MACHINE))
    const cleared = { ...target(), controllerDefinition: preview.definition! }
    expect(saveAndReload(cleared).probing?.toolSetter).toBeUndefined()
  })

  it('bridge settings text round-trips the tuple', () => {
    const text = bridgeProfileSettingsText(bridgeReply(withTuple(SAMPLE_MACHINE)).settings)
    expect(importUccncProfile(text).toolSetter).toEqual({ x: 738, y: 724.5, z: 120 })
  })
})
