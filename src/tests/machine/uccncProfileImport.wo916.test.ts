// @vitest-environment jsdom
//
// WO-916: a .pro is optional input to LienCAM's editable machine record.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
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

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { getMachineController } = await import('../../lib/machine/machineSession')
const {
  PROFILE_PREVIEW_STALE,
  importUccncProfile,
  previewLocalUccncProfile,
  unimportedUccncProfileFields,
} = await import('../../lib/machine/uccncProfileImport')

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)
const OPEN_LOG = readFileSync(
  resolve(process.cwd(), 'src/tests/evidence/MACHINE-NEXT-BUILD/demo-startup-and-jobs.log'),
  'utf8',
)

const machine = (): MachineConfig => ({
  id: 'wo916', name: 'Blank UCCNC machine', type: 'gantry_router', controller: 'uccnc',
  travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
  maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
  toolChanger: 'manual', coolant: false, notes: '',
})

const state = () => useCamStore.getState()

function openModal(initial: MachineConfig = machine()): void {
  act(() => {
    useCamStore.setState({
      machineLibrary: [initial],
      project: { ...state().project, machine: initial },
      consoleEvents: [],
    })
    state().openModal('machine-config')
  })
  render(createElement(MachineLibraryModal))
}

async function chooseLocalProfile(text = PROFILE, name = 'LienCNCV2.pro'): Promise<void> {
  fireEvent.click(screen.getByTestId('disclosure-machine-uccnc-profile'))
  const input = screen.getByTestId('uccnc-profile-local-input')
  fireEvent.change(input, { target: { files: [new File([text], name, { type: 'text/plain' })] } })
  await waitFor(() => expect(screen.getByTestId('uccnc-profile-preview')).not.toBeNull())
}

afterEach(() => {
  cleanup()
  const controller = getMachineController() as ReturnType<typeof getMachineController> & {
    previewProfile?: unknown
  }
  delete controller.previewProfile
  act(() => { useMachineControl.getState().setBridgeHello(null) })
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mem.clear()
  act(() => {
    state().closeModal()
    useCamStore.setState({ machineLibrary: [], consoleEvents: [] } as never)
  })
})

describe('WO-916 parser honesty', () => {
  it('matches Operator real profile to the bridge Open/readback oracle', () => {
    const imported = importUccncProfile(PROFILE)
    const x = imported.definition?.axes.find((axis) => axis.axis === 'X')
    const y = imported.definition?.axes.find((axis) => axis.axis === 'Y')
    expect(OPEN_LOG).toContain('axis X readback (rc=0)')
    expect(OPEN_LOG).toContain('stepsPerUnit=400 maxVel=150 softLimits=0..738')
    expect(OPEN_LOG).toContain('axis Y readback (rc=0): enabled=True')
    expect(OPEN_LOG).toContain('slave=A stepsPerUnit=400')
    expect(x).toMatchObject({ stepsPerUnit: 400, maxVelocity: 9000, softLimitMin: 0, softLimitMax: 738 })
    expect(y?.slaveAxis).toBe('A')
    expect(imported.travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
  })

  it('matches keys case-insensitively while keeping raw port and pin values', () => {
    const imported = importUccncProfile([
      '[AXESSETTINGSCONTROLX]',
      'AXISENABLED=True',
      'STEPPORTNUMBER=7',
      'STEPPINNUMBER=12',
      'STEPPINNEGATE=False',
    ].join('\n'))
    expect(imported.definition?.axes[0].stepPin).toEqual({ port: 7, pin: 12, negate: false })
  })

  it('refuses a half pin pair and names the field it did not import', () => {
    const imported = importUccncProfile([
      '[axessettingscontrolX]',
      'Axisenabled=True',
      'Stepportnumber=7',
      'Steppinnumber=0',
    ].join('\n'))
    expect(imported.definition?.axes[0].stepPin).toMatchObject({ port: 0, pin: 0 })
    expect(imported.issues).toContainEqual(expect.objectContaining({
      key: 'axessettingscontrolX.Stepportnumber/Steppinnumber',
    }))
  })

  it('lists every purpose-built field that came from a default, not the file', () => {
    const imported = importUccncProfile('[axessettingscontrolX]\nAxisenabled=True\n')
    const gaps = unimportedUccncProfileFields(imported)
    expect(gaps).toContain('axessettingscontrolX.Stepsperunit')
    expect(gaps).toContain('IOsetupsettings.Estoppinnumber')
    expect(gaps).not.toContain('axessettingscontrolX.Axisenabled')
  })

  it('distinguishes stated unmodelled keys from values the profile omitted', () => {
    const preview = previewLocalUccncProfile(
      machine(),
      'future.pro',
      '[axessettingscontrolX]\nAxisenabled=True\n[Generalsettings]\nFutureMachineFact=42\n',
    )
    expect(preview.warnings).toContain(
      'Not imported - Generalsettings.FutureMachineFact: the profile stated this setting, but LienCAM does not model it; its original profile text will be preserved.',
    )
    expect(preview.warnings).toContain(
      'Not imported - axessettingscontrolX.Stepsperunit: the profile did not state a usable value.',
    )
  })

  it('never promotes profile-derived data to verified VFD data', () => {
    const imported = importUccncProfile(PROFILE)
    expect(JSON.stringify(imported)).not.toContain('"verified":true')
  })
})

describe('WO-916 local file workflow', () => {
  it('shows the complete preview before changing the machine record', async () => {
    openModal()
    const before = JSON.stringify(state().machineLibrary[0])
    await chooseLocalProfile()

    expect(JSON.stringify(state().machineLibrary[0])).toBe(before)
    expect(screen.getByTestId('uccnc-profile-pin-axis.X.stepPin').getAttribute('data-raw-after'))
      .toBe('port 1 pin 15, not inverted')
    // WO-1729: the neutral drive-fault mapping adds exactly one preview row for
    // Operator's profile - FaultSignals row 1 (Enable1=True, Port1=3, Pin1=13,
    // ActiveLow1=True) becomes driveFaultInputs.0. The count is pinned WITH the
    // added row named, so a future row cannot slip through a bare count bump.
    const driveFaultRow = screen.getByTestId('uccnc-profile-pin-driveFaultInputs.0')
    expect(driveFaultRow.getAttribute('data-raw-before')).toBe('not in this machine')
    expect(driveFaultRow.getAttribute('data-raw-after')).toBe('port 3 pin 13, inverted')
    expect(document.querySelectorAll('[data-testid^="uccnc-profile-pin-"]')).toHaveLength(40)
    expect(screen.getByTestId('uccnc-profile-local-source').textContent)
      .toBe("This local file updates only LienCAM's editable machine definition. No board or bridge is involved.")
    expect(screen.queryByTestId('uccnc-profile-board')).toBeNull()
    expect(screen.queryByText('Board now')).toBeNull()
    expect(screen.queryByText('Board after')).toBeNull()
    expect(screen.queryByText(/the bridge did not say/i)).toBeNull()
    expect(document.querySelector('[data-status="unreadable"]')).toBeNull()
    expect(screen.getAllByText(/^Not imported -/).length).toBeGreaterThan(0)
  })

  it('Cancel refuses every proposed overwrite', async () => {
    openModal()
    const before = JSON.stringify(state().machineLibrary[0])
    await chooseLocalProfile()
    fireEvent.click(screen.getByTestId('uccnc-profile-cancel'))
    expect(JSON.stringify(state().machineLibrary[0])).toBe(before)
    expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull()
  })

  it('Confirm writes only LienCAM machine data and needs no bridge', async () => {
    openModal()
    await chooseLocalProfile()
    fireEvent.click(screen.getByTestId('uccnc-profile-confirm'))

    await waitFor(() => {
      const saved = state().machineLibrary.find((entry) => entry.id === 'wo916')
      expect(saved?.travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
      expect(saved?.controllerDefinition?.axes.find((axis) => axis.axis === 'X')?.stepPin)
        .toEqual({ port: 1, pin: 15, negate: false })
    })
    expect(screen.getByTestId('uccnc-profile-imported-note').textContent)
      .toContain('Nothing was sent to a controller.')
  })

  it('confirms a local file while an abandoned bridge preview is still in flight', async () => {
    let releaseBridge!: () => void
    const bridgeReply = new Promise<never>((resolve) => { releaseBridge = () => resolve(null as never) })
    const controller = getMachineController() as ReturnType<typeof getMachineController> & {
      previewProfile?: ReturnType<typeof vi.fn>
    }
    controller.previewProfile = vi.fn(() => bridgeReply)
    act(() => {
      useMachineControl.getState().setBridgeHello({
        readOnly: false,
        vfd: null,
        uccnc: {
          installRoot: 'C:\\UCCNC',
          profile: null,
          uc100Dll: null,
          ftd2xxDll: null,
          profiles: ['C:\\UCCNC\\Profiles\\Bridge.pro'],
        },
      })
    })
    openModal()
    fireEvent.click(screen.getByTestId('disclosure-machine-uccnc-profile'))
    fireEvent.click(screen.getByTestId('uccnc-profile-row-0'))
    expect(controller.previewProfile).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('uccnc-profile-busy')).not.toBeNull()

    fireEvent.change(screen.getByTestId('uccnc-profile-local-input'), {
      target: { files: [new File([PROFILE], 'LienCNCV2.pro', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(screen.getByTestId('uccnc-profile-preview')).not.toBeNull())
    expect((screen.getByTestId('uccnc-profile-confirm') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('uccnc-profile-confirm'))

    await waitFor(() => {
      expect(state().machineLibrary[0].travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
      expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull()
    })
    await act(async () => { releaseBridge() })
    expect(state().machineLibrary[0].travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
    expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull()
  })

  it('describes an identical local re-import without board or bridge caveats', async () => {
    openModal()
    await chooseLocalProfile()
    fireEvent.click(screen.getByTestId('uccnc-profile-confirm'))
    await waitFor(() => expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull())

    fireEvent.change(screen.getByTestId('uccnc-profile-local-input'), {
      target: { files: [new File([PROFILE], 'LienCNCV2.pro', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(screen.getByTestId('uccnc-profile-preview')).not.toBeNull())

    const headline = screen.getByTestId('uccnc-profile-change-count').textContent ?? ''
    expect(headline).toContain('This profile matches the editable machine definition. Nothing would change.')
    expect(headline).toContain('Nothing is written until you confirm.')
    expect(headline).not.toMatch(/board|bridge|nobody can check|all-clear/i)
    expect(screen.getByTestId('uccnc-profile-row-count').textContent).toContain('0 changing')
  })

  it('retires an in-flight local read when the machine is edited', () => {
    let pending: { onload: ((event: ProgressEvent<FileReader>) => void) | null } | null = null
    class DeferredFileReader {
      result: string | ArrayBuffer | null = PROFILE
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
      readAsText(): void { pending = this }
    }
    vi.stubGlobal('FileReader', DeferredFileReader)

    openModal()
    fireEvent.click(screen.getByTestId('disclosure-machine-uccnc-profile'))
    fireEvent.change(screen.getByTestId('uccnc-profile-local-input'), {
      target: { files: [new File([PROFILE], 'LienCNCV2.pro', { type: 'text/plain' })] },
    })
    fireEvent.change(screen.getByDisplayValue('Blank UCCNC machine'), {
      target: { value: 'Edited while reading' },
    })
    act(() => pending?.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>))

    expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull()
    expect(screen.getByText(PROFILE_PREVIEW_STALE)).not.toBeNull()
  })

  it('still creates a scratch profile with no .pro and no bridge', () => {
    act(() => {
      useCamStore.setState({ machineLibrary: [] })
      state().openModal('machine-config')
    })
    render(createElement(MachineLibraryModal))
    const add = document.querySelector<HTMLButtonElement>('[data-tooltip="New machine"]')
    expect(add).not.toBeNull()
    fireEvent.click(add!)
    expect(state().machineLibrary).toHaveLength(1)
    expect(state().machineLibrary[0].controllerDefinition).toBeUndefined()
  })

  it('reports why a local profile cannot be previewed without a selected machine', () => {
    act(() => {
      useCamStore.setState({ machineLibrary: [], consoleEvents: [] })
      state().openModal('machine-config')
    })
    render(createElement(MachineLibraryModal))
    fireEvent.change(screen.getByTestId('uccnc-profile-local-input'), {
      target: { files: [new File([PROFILE], 'orphan.pro', { type: 'text/plain' })] },
    })

    expect(state().consoleEvents.at(-1)).toMatchObject({
      severity: 'warning',
      source: 'machine',
      message: 'Cannot preview "orphan.pro" without a machine. Select or create a machine first; nothing was imported.',
    })
    expect(screen.queryByTestId('uccnc-profile-preview')).toBeNull()
  })

  it('reports an unreadable local file and leaves the record untouched', async () => {
    openModal()
    const before = previewLocalUccncProfile(machine(), 'broken.pro', 'not an ini profile')
    expect(before.readable).toBe(false)
    expect(before.error).toContain('no [Section] headers')
    await chooseLocalProfile('not an ini profile', 'broken.pro')
    expect(screen.getByTestId('uccnc-profile-unreadable').textContent)
      .toContain('Nothing was changed.')
    expect(state().machineLibrary[0].controllerDefinition).toBeUndefined()
  })
})
