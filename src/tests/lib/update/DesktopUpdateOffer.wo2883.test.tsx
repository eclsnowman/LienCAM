// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateHost, UpdateCheck, UpdateProgress } from '../../../lib/update/desktopUpdate'

// WO-2883: the renderer's one update offer, through the real component with a
// fake liencamHost.update (the main-process route is covered in updater.wo2883).

const { DesktopUpdateOffer } = await import('../../../components/update/DesktopUpdateOffer')
const { resetDesktopUpdateCheckForTests, UPDATE_RECHECK_INTERVAL_MS } = await import('../../../lib/update/desktopUpdate')
const { RELEASE_CHECK_DELAY_MS } = await import('../../../lib/update/releaseCheck')

const available: UpdateCheck = {
  status: 'available', tag: 'v0.36.0-alpha.3', version: '0.36.0-alpha.3', currentVersion: '0.36.0-alpha.2',
  kind: 'installer', releaseUrl: 'https://github.com/eclsnowman/LienCAM/releases/tag/v0.36.0-alpha.3',
  assetName: 'LienCAM-0.36.0-alpha.3-win-x64-setup.exe', size: 229_094_498,
}

function host(overrides: Partial<DesktopUpdateHost> = {}) {
  let progress: ((p: UpdateProgress) => void) | null = null
  const update: DesktopUpdateHost = {
    check: vi.fn(async () => available),
    download: vi.fn(async () => ({ ok: true as const, version: '0.36.0-alpha.3', kind: 'installer' as const, file: 'C:\\t\\setup.exe', sha256: 'ab' })),
    install: vi.fn(async () => ({ ok: true as const, restarting: true, message: 'Installing LienCAM 0.36.0-alpha.3; LienCAM and the machine bridge close now and LienCAM starts again when the installer finishes.' })),
    onProgress: vi.fn((listener) => { progress = listener; return () => { progress = null } }),
    ...overrides,
  }
  vi.stubGlobal('liencamHost', { update })
  return { update, sendProgress: (p: UpdateProgress) => act(() => progress?.(p)) }
}

async function mountAndWait(emit = vi.fn()) {
  render(<DesktopUpdateOffer emit={emit} />)
  await act(async () => { vi.advanceTimersByTime(RELEASE_CHECK_DELAY_MS) })
  await act(async () => {})
  return emit
}
const offer = () => screen.queryByTestId('desktop-update-offer')

beforeEach(() => { vi.useFakeTimers(); resetDesktopUpdateCheckForTests() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('WO-2883 desktop update offer', () => {
  it('renders nothing in the browser (no update route)', async () => {
    vi.stubGlobal('liencamHost', undefined)
    await mountAndWait()
    expect(offer()).toBeNull()
  })

  it('renders nothing in a demo build', async () => {
    const { update } = host()
    vi.stubEnv('VITE_DEMO_BUILD', 'true')
    await mountAndWait()
    expect(update.check).not.toHaveBeenCalled()
    expect(offer()).toBeNull()
  })

  it('s1: offers a newer release once, after the launch delay; Not now hides it', async () => {
    const { update } = host()
    render(<DesktopUpdateOffer emit={vi.fn()} />)
    expect(update.check).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(RELEASE_CHECK_DELAY_MS) })
    await act(async () => {})
    expect(update.check).toHaveBeenCalledTimes(1)
    expect(offer()?.textContent).toContain('LienCAM 0.36.0-alpha.3 is available (you have 0.36.0-alpha.2), 218 MB.')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(offer()).toBeNull()
    expect(update.download).not.toHaveBeenCalled()
  })

  it('s2/s3: Download shows progress, then installs only when the operator clicks Install and restart', async () => {
    let finish: (value: Awaited<ReturnType<DesktopUpdateHost['download']>>) => void = () => {}
    const { update, sendProgress } = host({ download: vi.fn(() => new Promise<Awaited<ReturnType<DesktopUpdateHost['download']>>>(resolve => { finish = resolve })) })
    const emit = await mountAndWait()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(update.download).toHaveBeenCalledWith('v0.36.0-alpha.3')
    sendProgress({ version: '0.36.0-alpha.3', received: 114_547_249, total: 229_094_498 })
    expect(offer()?.textContent).toBe('Downloading LienCAM 0.36.0-alpha.3: 50%')
    await act(async () => { finish({ ok: true, version: '0.36.0-alpha.3', kind: 'installer', file: 'x', sha256: 'ab' }) })
    expect(offer()?.textContent).toContain('is downloaded and checked')
    expect(offer()?.textContent).toContain('Your settings, machine, tools and projects are kept.')
    expect(emit).toHaveBeenCalledWith({ severity: 'info', source: 'app', message: 'LienCAM 0.36.0-alpha.3 downloaded and matched its published SHA-256 checksum.' })
    expect(update.install).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install and restart' })) })
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(offer()?.textContent).toContain('LienCAM starts again when the installer finishes.')
  })

  it('s6: a refused download is one plain sentence in the offer and the console', async () => {
    const message = 'The downloaded LienCAM-0.36.0-alpha.3-win-x64-setup.exe did not match its published SHA-256 checksum, so it was deleted and nothing was installed.'
    host({ download: vi.fn(async () => ({ ok: false as const, message })) })
    const emit = await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    expect(offer()?.textContent).toBe(`${message}CloseDownload again`)
    expect(emit).toHaveBeenCalledWith({ severity: 'error', source: 'app', message })
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull()
  })

  it('s7: a refused install keeps the checked download and says why', async () => {
    const message = 'LienCAM does not install an update while a program is running; finish or stop the program, then install.'
    const { update } = host({ install: vi.fn(async () => ({ ok: false as const, message })) })
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install and restart' })) })
    expect(offer()?.textContent).toContain(message)
    expect(screen.getByRole('button', { name: 'Install and restart' })).toBeTruthy()
    expect(update.install).toHaveBeenCalledTimes(1)
  })

  it('s8: a portable copy offers to show the file instead of installing', async () => {
    host({
      check: vi.fn(async () => ({ ...available, kind: 'portable' as const, assetName: 'LienCAM-0.36.0-alpha.3-win-x64-portable.exe' })),
      download: vi.fn(async () => ({ ok: true as const, version: '0.36.0-alpha.3', kind: 'portable' as const, file: 'x', sha256: 'ab' })),
    })
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    expect(offer()?.textContent).toContain('This copy cannot replace itself')
    expect(screen.getByRole('button', { name: 'Show the file' })).toBeTruthy()
  })

  it('a download that rejects is one console line and an offer to download again', async () => {
    const download = vi.fn()
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockResolvedValueOnce({ ok: true as const, version: '0.36.0-alpha.3', kind: 'installer' as const, file: 'x', sha256: 'ab' })
    host({ download })
    const emit = await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    const message = 'LienCAM could not download 0.36.0-alpha.3 (EACCES: permission denied); nothing was installed.'
    expect(emit).toHaveBeenCalledWith({ severity: 'error', source: 'app', message })
    expect(offer()?.textContent).toBe(`${message}CloseDownload again`)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download again' })) })
    expect(download).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Install and restart' })).toBeTruthy()
  })

  it('Install and restart cannot be pressed twice while the file is checked again', async () => {
    let finish: (value: Awaited<ReturnType<DesktopUpdateHost['install']>>) => void = () => {}
    const { update } = host({ install: vi.fn(() => new Promise<Awaited<ReturnType<DesktopUpdateHost['install']>>>(resolve => { finish = resolve })) })
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }))
    expect(offer()?.textContent).toBe('Checking LienCAM 0.36.0-alpha.3 again before installing...')
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull()
    await act(async () => { finish({ ok: true, restarting: true, message: 'Installing LienCAM 0.36.0-alpha.3; LienCAM and the machine bridge close now and LienCAM starts again when the installer finishes.' }) })
    expect(update.install).toHaveBeenCalledTimes(1)
  })

  it('a checked file that vanished before install offers Download again, not Install', async () => {
    const message = 'The downloaded LienCAM 0.36.0-alpha.3 changed on disk since it was checked, so it was deleted and nothing was installed.'
    const { update } = host({ install: vi.fn(async () => ({ ok: false as const, downloadAgain: true, message })) })
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install and restart' })) })
    expect(offer()?.textContent).toBe(`${message}CloseDownload again`)
    expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download again' })) })
    expect(update.download).toHaveBeenCalledTimes(2)
  })

  it('offline is silent: no console line and no offer (WO-2720)', async () => {
    const message = 'LienCAM could not reach GitHub to check for updates; it keeps working as it is.'
    host({ check: vi.fn(async () => ({ status: 'offline' as const, message })) })
    const emit = await mountAndWait()
    expect(emit).not.toHaveBeenCalled()
    expect(offer()).toBeNull()
  })

  it('a source run is not offered a download (the console release line still says a newer one exists)', async () => {
    host({ check: vi.fn(async () => ({ ...available, kind: 'source' as const, message: 'update it with git pull' })) })
    await mountAndWait()
    expect(offer()).toBeNull()
  })
})

// Fix round 4, owner ruling 10-17 6:55 AM CT: "if later is chosen by the user, it doesn't come
// up again until the software is closed and restarted, or if it was open so long a
// second release comes out."
describe('WO-2883 a put-off update stays put off for this run; a newer release comes back', () => {
  const newer: UpdateCheck = {
    ...available, tag: 'v0.36.0-alpha.4', version: '0.36.0-alpha.4',
    releaseUrl: 'https://github.com/eclsnowman/LienCAM/releases/tag/v0.36.0-alpha.4',
    assetName: 'LienCAM-0.36.0-alpha.4-win-x64-setup.exe',
  }
  const recheck = async () => {
    await act(async () => { vi.advanceTimersByTime(UPDATE_RECHECK_INTERVAL_MS) })
    await act(async () => {})
  }

  it('re-checks silently every 6 hours while the app stays open, not sooner', async () => {
    const { update } = host({ check: vi.fn(async () => ({ status: 'current' as const, version: '0.36.0-alpha.2' })) })
    const emit = await mountAndWait()
    expect(update.check).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(UPDATE_RECHECK_INTERVAL_MS - 1) })
    expect(update.check).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    await recheck()
    expect(update.check).toHaveBeenCalledTimes(3)
    expect(emit).not.toHaveBeenCalled()
    expect(offer()).toBeNull()
  })

  it('Not now keeps that version hidden across re-checks', async () => {
    const { update } = host()
    await mountAndWait()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await recheck()
    await recheck()
    expect(update.check).toHaveBeenCalledTimes(3)
    expect(offer()).toBeNull()
  })

  it('Later keeps the downloaded version hidden across re-checks', async () => {
    const { update } = host()
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(offer()).toBeNull()
    await recheck()
    expect(update.check).toHaveBeenCalledTimes(2)
    expect(offer()).toBeNull()
    expect(update.install).not.toHaveBeenCalled()
  })

  it('a release newer than the put-off one shows the card again, and only that one', async () => {
    const check = vi.fn<DesktopUpdateHost['check']>(async () => available)
    host({ check })
    await mountAndWait()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    check.mockImplementation(async () => newer)
    await recheck()
    expect(offer()?.textContent).toContain('LienCAM 0.36.0-alpha.4 is available (you have 0.36.0-alpha.2)')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await recheck()
    expect(offer()).toBeNull()
    // An older answer (a stale mirror) never brings back what was put off.
    check.mockImplementation(async () => available)
    await recheck()
    expect(offer()).toBeNull()
  })

  it('a restart offers the newest release again', async () => {
    host()
    await mountAndWait()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(offer()).toBeNull()
    cleanup()
    // A restart is a new renderer: fresh modules, nothing remembered.
    vi.resetModules()
    const restarted = await import('../../../components/update/DesktopUpdateOffer')
    render(<restarted.DesktopUpdateOffer emit={vi.fn()} />)
    await act(async () => { vi.advanceTimersByTime(RELEASE_CHECK_DELAY_MS) })
    await act(async () => {})
    expect(offer()?.textContent).toContain('LienCAM 0.36.0-alpha.3 is available')
    ;(await import('../../../lib/update/desktopUpdate')).resetDesktopUpdateCheckForTests()
  })

  it('an offline re-check is silent and keeps the card as it was', async () => {
    const message = 'LienCAM could not reach GitHub to check for updates; it keeps working as it is.'
    const check = vi.fn<DesktopUpdateHost['check']>(async () => available)
    host({ check })
    const emit = await mountAndWait()
    check.mockImplementation(async () => ({ status: 'offline' as const, message }))
    await recheck()
    expect(offer()?.textContent).toContain('LienCAM 0.36.0-alpha.3 is available')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await recheck()
    expect(offer()).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('Close keeps that version hidden too: after a shown file and after a failed download', async () => {
    const shown = 'LienCAM showed the checked file; start it to update.'
    const check = vi.fn<DesktopUpdateHost['check']>(async () => ({ ...available, kind: 'portable' as const }))
    host({ check, download: vi.fn(async () => ({ ok: true as const, version: '0.36.0-alpha.3', kind: 'portable' as const, file: 'x', sha256: 'ab' })),
      install: vi.fn(async () => ({ ok: true as const, restarting: false, message: shown })) })
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show the file' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await recheck()
    expect(offer()).toBeNull()
  })

  it('Close after a failed download keeps that version hidden across re-checks', async () => {
    const { update } = host({ download: vi.fn(async () => ({ ok: false as const, message: 'The download of LienCAM 0.36.0-alpha.3 stopped (reset); nothing was installed.' })) })
    await mountAndWait()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await recheck()
    expect(update.check).toHaveBeenCalledTimes(2)
    expect(offer()).toBeNull()
  })

  it('a re-check never interrupts a download in progress', async () => {
    const check = vi.fn<DesktopUpdateHost['check']>(async () => available)
    host({ check, download: vi.fn(() => new Promise<never>(() => {})) })
    await mountAndWait()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    check.mockImplementation(async () => newer)
    await recheck()
    expect(offer()?.textContent).toBe('Downloading LienCAM 0.36.0-alpha.3...')
  })
})
