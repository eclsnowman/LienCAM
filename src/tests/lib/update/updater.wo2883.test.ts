// @vitest-environment node
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareVersions as rendererCompare } from '../../../lib/update/releaseCheck'

// WO-2883: the main-process update route, driven with a fake GitHub. Proof plan
// rows covered here: s1 offer, s2 SHA-256 check, s3 install on the operator's
// word, s6 a bad download leaves the running version untouched, s7 no install
// while a program runs, s8 the portable build says plainly what it does.

const require = createRequire(import.meta.url)
const { createUpdateRoute, registerUpdateIpc, assetNameFor, parseSums, RELEASES_API } = require('../../../../electron/update/updater.cjs')
const { compareVersions } = require('../../../../electron/update/version.cjs')

const REPO = 'https://github.com/eclsnowman/LienCAM'
const current = '0.36.0-alpha.2'
const nextTag = 'v0.36.0-alpha.3'
const nextVersion = '0.36.0-alpha.3'
const installer = Buffer.from('MZ fake LienCAM 0.36.0-alpha.3 installer '.repeat(40000))
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

type Files = Record<string, Buffer | string>
function release(tag: string, files: Files, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, html_url: `${REPO}/releases/tag/${tag}`, draft: false, prerelease: true,
    published_at: '2026-10-20T12:00:00Z',
    assets: Object.entries(files).map(([name, data]) => ({
      name, size: Buffer.byteLength(data), browser_download_url: `${REPO}/releases/download/${tag}/${name}`,
    })),
    ...extra,
  }
}
function sums(files: Record<string, Buffer>) {
  return Object.entries(files).map(([name, data]) => `${sha(data)}  ${name}`).join('\n') + '\n'
}

/** A fake GitHub: the releases list, release-by-tag and the download URLs. */
function github(releases: ReturnType<typeof release>[], downloads: Files, opts: { offline?: boolean } = {}) {
  const requests: string[] = []
  const fetch = vi.fn(async (url: string) => {
    requests.push(url)
    if (opts.offline) throw new TypeError('fetch failed')
    if (url === RELEASES_API) return new Response(JSON.stringify(releases))
    const byTag = /\/releases\/tags\/(.+)$/.exec(url)
    if (byTag) {
      const found = releases.find(r => r.tag_name === decodeURIComponent(byTag[1]))
      return found ? new Response(JSON.stringify(found)) : new Response('{}', { status: 404 })
    }
    const name = url.split('/').pop()!
    if (name in downloads) return new Response(new Uint8Array(Buffer.from(downloads[name])))
    return new Response('missing', { status: 404 })
  })
  return { fetch, requests }
}

let dir: string
let updatesDir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wo2883-'))
  updatesDir = path.join(dir, 'updates')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A child process that starts: it emits 'spawn' on the next tick, as Node's does. */
function startedChild() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  setImmediate(() => child.emit('spawn'))
  return child
}
/** A child process the OS could not start: it emits 'error' instead of 'spawn'. */
function failedChild(code: string) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${code}`), { code })))
  return child
}

function route(fetch: unknown, overrides: Record<string, unknown> = {}) {
  const calls = {
    spawn: vi.fn(() => startedChild()), quit: vi.fn(), relaunch: vi.fn(),
    shutdown: vi.fn(async () => true), resume: vi.fn(),
    showItemInFolder: vi.fn(), openPath: vi.fn(async () => ''), emitProgress: vi.fn(),
  }
  let jobRunning = false
  const r = createUpdateRoute({
    currentVersion: current, platform: 'win32', arch: 'x64', packaged: true,
    updatesDir, fetch, isJobRunning: () => jobRunning, defer: (fn: () => void) => fn(), ...calls, ...overrides,
  })
  return { r, calls, setJobRunning: (on: boolean) => { jobRunning = on } }
}

const setupName = `LienCAM-${nextVersion}-win-x64-setup.exe`
function standardRelease(files: Files = { [setupName]: installer }, sumsText = sums({ [setupName]: installer })) {
  const all = { ...files, 'SHA256SUMS.txt': sumsText }
  return github([
    release('v0.36.0-alpha.1', {}),
    release(nextTag, all),
    release('v0.36.0-alpha.9', all, { draft: true }),
    release('v0.36.0-alpha.2', {}),
  ], all)
}

describe('WO-2883 release asset names match electron-builder.yml', () => {
  it.each([
    ['installer', 'x64', 'LienCAM-0.36.0-alpha.2-win-x64-setup.exe'],
    ['portable', 'x64', 'LienCAM-0.36.0-alpha.2-win-x64-portable.exe'],
    ['appimage', 'x64', 'LienCAM-0.36.0-alpha.2-linux-x86_64.AppImage'],
    ['archive', 'x64', 'LienCAM-0.36.0-alpha.2-linux-x64.tar.gz'],
    ['dmg', 'arm64', 'LienCAM-0.36.0-alpha.2-mac-arm64.dmg'],
  ])('%s %s is %s (as published for alpha.2)', (kind, arch, name) => {
    expect(assetNameFor(kind, '0.36.0-alpha.2', arch)).toBe(name)
  })
  it('reads the published SHA256SUMS.txt format', () => {
    const text = 'fea820541d9d247716dc997f8648d21165df3fbbde1dcc64ce293713d3424feb  LienCAM-0.36.0-alpha.2-linux-x64.tar.gz\r\n' +
      '3a24a9b69747f9f9383119ee3cb0aae9bffcaa1221b55f84564a5138859bab9b *LienCAM-0.36.0-alpha.2-win-x64-setup.exe\n'
    const parsed = parseSums(text)
    expect(parsed.get('LienCAM-0.36.0-alpha.2-win-x64-setup.exe')).toBe('3a24a9b69747f9f9383119ee3cb0aae9bffcaa1221b55f84564a5138859bab9b')
    expect(parsed.size).toBe(2)
  })
})

describe('WO-2883 version choice', () => {
  it.each([
    ['0.36.0-alpha.1', '0.36.0-alpha.2'], ['0.36.0-alpha.2', '0.36.0-beta.1'], ['0.36.0-beta.1', '0.36.0'],
    ['1.0.0-alpha.2', '1.0.0-alpha.10'], ['1.9.9', '1.10.0'], ['v0.36.0', '0.36.0+build.7'], ['bad', '0.36.0'],
  ])('main and renderer agree on %s vs %s', (a, b) => {
    expect(compareVersions(a, b)).toBe(rendererCompare(a, b))
    expect(compareVersions(b, a)).toBe(rendererCompare(b, a))
  })
})

describe('WO-2883 s1: the offer', () => {
  it('offers the newest published release newer than this copy, skipping drafts', async () => {
    const { fetch } = standardRelease()
    const result = await route(fetch).r.check()
    expect(result).toMatchObject({
      status: 'available', tag: nextTag, version: nextVersion, currentVersion: current, kind: 'installer',
      assetName: setupName, size: installer.length,
    })
    expect(result.message).toBeUndefined()
  })
  it('says nothing to offer when this copy is the newest', async () => {
    const { fetch } = github([release('v0.36.0-alpha.2', {})], {})
    expect(await route(fetch).r.check()).toEqual({ status: 'current', version: current })
  })
  it('offline is one plain line', async () => {
    const { fetch } = github([], {}, { offline: true })
    expect(await route(fetch).r.check()).toEqual({
      status: 'offline', message: 'LienCAM could not reach GitHub to check for updates; it keeps working as it is.',
    })
  })
  it('a source run is told to use git and is never downloaded', async () => {
    const { fetch, requests } = standardRelease()
    const { r } = route(fetch, { packaged: false })
    expect(await r.check()).toMatchObject({ status: 'available', kind: 'source', message: expect.stringContaining('git pull') })
    expect(await r.download(nextTag)).toEqual({ ok: false, message: expect.stringContaining('git pull') })
    expect(requests).toEqual([RELEASES_API])
  })
})

describe('WO-2883 s2: the download is checked against the published SHA-256 sums', () => {
  it('keeps a file whose SHA-256 matches and reports progress', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch)
    const result = await r.download(nextTag)
    expect(result).toMatchObject({ ok: true, version: nextVersion, kind: 'installer', sha256: sha(installer) })
    expect(readFileSync(result.file)).toEqual(installer)
    expect(calls.emitProgress).toHaveBeenLastCalledWith({ version: nextVersion, received: installer.length, total: installer.length })
    expect(readdirSync(path.dirname(result.file))).toEqual([setupName])
  })
  it('s6: a tampered download is deleted with one plain sentence and nothing installs', async () => {
    const tampered = Buffer.from(installer)
    tampered[100] ^= 0xff
    const { fetch } = standardRelease({ [setupName]: tampered }, sums({ [setupName]: installer }))
    const { r, calls } = route(fetch)
    expect(await r.download(nextTag)).toEqual({
      ok: false,
      message: `The downloaded ${setupName} did not match its published SHA-256 checksum, so it was deleted and nothing was installed.`,
    })
    expect(readdirSync(path.join(updatesDir, nextVersion))).toEqual([])
    expect(await r.install()).toEqual({ ok: false, downloadAgain: true, message: 'There is no checked update download to install.' })
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.quit).not.toHaveBeenCalled()
  })
  it('refuses when the published sums do not list the file', async () => {
    const { fetch } = standardRelease(undefined, sums({ 'other.exe': installer }))
    expect(await route(fetch).r.download(nextTag)).toEqual({
      ok: false, message: `SHA256SUMS.txt for LienCAM ${nextVersion} does not list ${setupName}, so it was not downloaded.`,
    })
  })
  it('refuses a release with no published sums', async () => {
    const files = { [setupName]: installer }
    const { fetch } = github([release(nextTag, files)], files)
    expect((await route(fetch).r.download(nextTag)).message).toContain('has no published SHA256SUMS.txt')
  })
  it('only downloads from this repository\'s release URLs', async () => {
    const all = { [setupName]: installer, 'SHA256SUMS.txt': sums({ [setupName]: installer }) }
    const evil = release(nextTag, all)
    evil.assets[0].browser_download_url = `https://example.com/${setupName}`
    const { fetch, requests } = github([evil], all)
    expect((await route(fetch).r.download(nextTag)).message).toContain('has no download for this computer')
    expect(requests.some(url => url.startsWith('https://example.com'))).toBe(false)
  })
  it('never downloads a release that is not newer', async () => {
    const { fetch, requests } = standardRelease()
    expect(await route(fetch).r.download('v0.36.0-alpha.1')).toEqual({
      ok: false, message: 'LienCAM 0.36.0-alpha.1 is not newer than this copy (0.36.0-alpha.2).',
    })
    expect(requests).toEqual([])
  })
  it('a dropped connection leaves no partial file', async () => {
    const all = { [setupName]: installer, 'SHA256SUMS.txt': sums({ [setupName]: installer }) }
    const base = github([release(nextTag, all)], all)
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith(setupName)) throw new TypeError('network reset')
      return base.fetch(url)
    })
    expect((await route(fetch).r.download(nextTag)).message)
      .toBe(`The download of LienCAM ${nextVersion} stopped (network reset); nothing was installed.`)
    expect(readdirSync(path.join(updatesDir, nextVersion))).toEqual([])
  })
})

describe('WO-2883 s3/s7: install only on the operator\'s word, never while a program runs', () => {
  it('s7: refuses while a program runs and keeps the checked file for later', async () => {
    const { fetch } = standardRelease()
    const { r, calls, setJobRunning } = route(fetch)
    const { file } = await r.download(nextTag)
    setJobRunning(true)
    expect(await r.install()).toEqual({
      ok: false, message: 'LienCAM does not install an update while a program is running; finish or stop the program, then install.',
    })
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(true)
    setJobRunning(false)
    expect(await r.install()).toMatchObject({ ok: true, restarting: true })
  })
  it('s3: runs the checked installer quietly and closes the app; downloading alone installs nothing', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch)
    const { file } = await r.download(nextTag)
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(await r.install()).toEqual({
      ok: true, restarting: true,
      message: `Installing LienCAM ${nextVersion}; LienCAM and the machine bridge close now and LienCAM starts again when the installer finishes.`,
    })
    expect(calls.spawn).toHaveBeenCalledWith(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' })
    expect(calls.quit).toHaveBeenCalledTimes(1)
  })
  it('a file changed on disk after the check is deleted and not run', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch)
    const { file } = await r.download(nextTag)
    writeFileSync(file, 'swapped')
    expect((await r.install()).message).toBe(`The downloaded LienCAM ${nextVersion} changed on disk since it was checked, so it was deleted and nothing was installed.`)
    expect(existsSync(file)).toBe(false)
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  it('an AppImage is replaced in place and restarted', async () => {
    const name = `LienCAM-${nextVersion}-linux-x86_64.AppImage`
    const image = Buffer.from('new appimage bytes')
    const all = { [name]: image, 'SHA256SUMS.txt': sums({ [name]: image }) }
    const appImage = path.join(dir, 'LienCAM.AppImage')
    writeFileSync(appImage, 'old appimage bytes')
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { platform: 'linux', appImage })
    expect(r.kind).toBe('appimage')
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: true, restarting: true })
    expect(readFileSync(appImage)).toEqual(image)
    // POSIX execute bits exist only where AppImages run; Windows reports none.
    if (process.platform !== 'win32') expect(statSync(appImage).mode & 0o111).not.toBe(0)
    expect(calls.relaunch).toHaveBeenCalledWith(appImage)
  })
})

describe('WO-2883 s8: a copy that cannot replace itself says so plainly', () => {
  it('the Windows portable copy shows the checked file and says what to do', async () => {
    const name = `LienCAM-${nextVersion}-win-x64-portable.exe`
    const portable = Buffer.from('portable exe')
    const all = { [name]: portable, 'SHA256SUMS.txt': sums({ [name]: portable }) }
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { portableFile: 'D:\\Tools\\LienCAM.exe' })
    expect(r.kind).toBe('portable')
    const { file } = await r.download(nextTag)
    const result = await r.install()
    expect(result).toEqual({
      ok: true, restarting: false,
      message: `This portable copy cannot replace itself while it runs; the checked LienCAM ${nextVersion} is in ${path.dirname(file)}. Close LienCAM and start the new one.`,
    })
    expect(calls.showItemInFolder).toHaveBeenCalledWith(file)
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.quit).not.toHaveBeenCalled()
  })
})

describe('WO-2883 s7: a running program holds only the install that replaces this copy', () => {
  const running = 'LienCAM does not install an update while a program is running; finish or stop the program, then install.'
  const routes: Array<[string, string, Record<string, unknown>]> = [
    ['portable', `LienCAM-${nextVersion}-win-x64-portable.exe`, { portableFile: 'D:\\Tools\\LienCAM.exe' }],
    ['archive', `LienCAM-${nextVersion}-linux-x64.tar.gz`, { platform: 'linux' }],
    ['dmg', `LienCAM-${nextVersion}-mac-arm64.dmg`, { platform: 'darwin', arch: 'arm64' }],
  ]
  it.each(routes)('the %s copy still shows its checked file while a program runs', async (kind, name, overrides) => {
    const bytes = Buffer.from(`${kind} bytes`)
    const all = { [name]: bytes, 'SHA256SUMS.txt': sums({ [name]: bytes }) }
    const { r, calls, setJobRunning } = route(github([release(nextTag, all)], all).fetch, overrides)
    expect(r.kind).toBe(kind)
    const { file } = await r.download(nextTag)
    setJobRunning(true)
    expect(await r.install()).toMatchObject({ ok: true, restarting: false })
    const revealed = kind === 'dmg' ? calls.openPath : calls.showItemInFolder
    expect(revealed).toHaveBeenCalledWith(file)
    expect(calls.quit).not.toHaveBeenCalled()
    expect(calls.relaunch).not.toHaveBeenCalled()
  })
  it('the AppImage is not replaced while a program runs', async () => {
    const name = `LienCAM-${nextVersion}-linux-x86_64.AppImage`
    const image = Buffer.from('new appimage bytes')
    const all = { [name]: image, 'SHA256SUMS.txt': sums({ [name]: image }) }
    const appImage = path.join(dir, 'LienCAM.AppImage')
    writeFileSync(appImage, 'old appimage bytes')
    const { r, calls, setJobRunning } = route(github([release(nextTag, all)], all).fetch, { platform: 'linux', appImage })
    await r.download(nextTag)
    setJobRunning(true)
    expect(await r.install()).toEqual({ ok: false, message: running })
    expect(readFileSync(appImage, 'utf8')).toBe('old appimage bytes')
    expect(calls.relaunch).not.toHaveBeenCalled()
  })
})

describe('WO-2883 fix round 2: every failure is an answer the operator can act on', () => {
  it('a download that cannot be saved answers with one sentence instead of rejecting', async () => {
    const { fetch } = standardRelease()
    const blocked = path.join(dir, 'not-a-folder')
    writeFileSync(blocked, 'a file where the update folder should go')
    const result = await route(fetch, { updatesDir: blocked }).r.download(nextTag)
    expect(result).toMatchObject({ ok: false })
    expect((result as { message: string }).message)
      .toMatch(new RegExp(`^LienCAM could not save the download of ${nextVersion.replace(/\./g, '\\.')} \\(.+\\); nothing was installed\\.$`))
  })
  it('a double click on Install and restart runs the installer once', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch)
    await r.download(nextTag)
    const [first, second] = await Promise.all([r.install(), r.install()])
    expect(first).toMatchObject({ ok: true, restarting: true })
    expect(second).toEqual(first)
    expect(await r.install()).toEqual(first)
    expect(calls.spawn).toHaveBeenCalledTimes(1)
    expect(calls.quit).toHaveBeenCalledTimes(1)
  })
  it('a checked file deleted before install asks for a new download', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch)
    const { file } = await r.download(nextTag)
    rmSync(file)
    expect(await r.install()).toMatchObject({ ok: false, downloadAgain: true })
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(r.ready()).toBeNull()
  })
  it('a checked file changed before install asks for a new download', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch)
    const { file } = await r.download(nextTag)
    writeFileSync(file, 'swapped')
    expect(await r.install()).toMatchObject({ ok: false, downloadAgain: true })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
})

describe('WO-2883 fix round 3: every host call answers with a sentence and never rejects', () => {
  const dmgName = `LienCAM-${nextVersion}-mac-arm64.dmg`
  function dmgRoute(overrides: Record<string, unknown> = {}) {
    const bytes = Buffer.from('dmg bytes')
    const all = { [dmgName]: bytes, 'SHA256SUMS.txt': sums({ [dmgName]: bytes }) }
    return route(github([release(nextTag, all)], all).fetch, { platform: 'darwin', arch: 'arm64', ...overrides })
  }

  it('an installer the OS cannot start keeps the app open and the checked file ready', async () => {
    const { fetch } = standardRelease()
    const spawn = vi.fn().mockImplementationOnce(() => failedChild('EACCES')).mockImplementation(() => startedChild())
    const { r, calls } = route(fetch, { spawn })
    await r.download(nextTag)
    expect(await r.install()).toEqual({
      ok: false, message: `LienCAM could not start the installer for ${nextVersion} (spawn EACCES); this copy is unchanged and keeps running.`,
    })
    expect(calls.quit).not.toHaveBeenCalled()
    expect(r.ready()).not.toBeNull()
    expect(await r.install()).toMatchObject({ ok: true, restarting: true })
    expect(calls.quit).toHaveBeenCalledTimes(1)
  })
  it('an installer spawn that throws at once is the same answer', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch, { spawn: vi.fn(() => { throw new Error('spawn EINVAL') }) })
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: false, message: expect.stringContaining('could not start the installer') })
    expect(calls.quit).not.toHaveBeenCalled()
  })
  it('success and the quit wait for the installer to report it started', async () => {
    const { fetch } = standardRelease()
    let start: () => void = () => {}
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      start = () => child.emit('spawn')
      return child
    })
    const { r, calls } = route(fetch, { spawn })
    await r.download(nextTag)
    let settled = false
    const pending = r.install().then((result: unknown) => { settled = true; return result })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(calls.quit).not.toHaveBeenCalled()
    start()
    expect(await pending).toMatchObject({ ok: true, restarting: true })
    expect(calls.quit).toHaveBeenCalledTimes(1)
  })
  it('a disk image macOS cannot open is one sentence, not success', async () => {
    const { r } = dmgRoute({ openPath: vi.fn(async () => 'Failed to open path') })
    const { file } = await r.download(nextTag)
    expect(await r.install()).toEqual({
      ok: false, message: `LienCAM could not open the checked disk image (Failed to open path); it is in ${path.dirname(file)}. Open it from there, drag LienCAM to Applications, then start the new one.`,
    })
  })
  it('a folder that cannot be shown names the checked file instead', async () => {
    const name = `LienCAM-${nextVersion}-linux-x64.tar.gz`
    const bytes = Buffer.from('tar bytes')
    const all = { [name]: bytes, 'SHA256SUMS.txt': sums({ [name]: bytes }) }
    const { r } = route(github([release(nextTag, all)], all).fetch, { platform: 'linux', showItemInFolder: vi.fn(() => { throw new Error('no file manager') }) })
    const { file } = await r.download(nextTag)
    expect(await r.install()).toEqual({ ok: false, message: `LienCAM could not show the checked file (no file manager); it is ${file}. Close LienCAM and start the new one.` })
  })
  it('a job state that cannot be read does not install and says so', async () => {
    const { fetch } = standardRelease()
    const { r, calls } = route(fetch, { isJobRunning: () => { throw new Error('window gone') } })
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: false, message: expect.stringContaining('could not tell whether a program is running (window gone)') })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  it('an AppImage that cannot be replaced leaves no staged file and this copy unchanged', async () => {
    const name = `LienCAM-${nextVersion}-linux-x86_64.AppImage`
    const image = Buffer.from('new appimage bytes')
    const all = { [name]: image, 'SHA256SUMS.txt': sums({ [name]: image }) }
    const appImage = path.join(dir, 'missing-folder', 'LienCAM.AppImage')
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { platform: 'linux', appImage })
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: false, message: expect.stringContaining(`LienCAM could not replace ${appImage}`) })
    expect(existsSync(`${appImage}.update`)).toBe(false)
    expect(calls.relaunch).not.toHaveBeenCalled()
    // Fix round 5: the bridge was shut down for the swap, so this copy starts it again.
    expect(calls.resume).toHaveBeenCalledTimes(1)
  })
  it('a quit, relaunch or progress listener that throws breaks nothing', async () => {
    const { fetch } = standardRelease()
    const { r } = route(fetch, { quit: vi.fn(() => { throw new Error('quit failed') }), emitProgress: vi.fn(() => { throw new Error('window gone') }) })
    expect(await r.download(nextTag)).toMatchObject({ ok: true })
    expect(await r.install()).toMatchObject({ ok: true, restarting: true })
  })
  it('with every host call failing, check, download and install still resolve to sentences', async () => {
    const boom = () => { throw new Error('host down') }
    const brokenFs = new Proxy({}, { get: () => async () => { throw new Error('disk gone') } })
    const r = createUpdateRoute({
      currentVersion: current, platform: 'win32', arch: 'x64', packaged: true, updatesDir,
      fetch: vi.fn(async () => { throw new TypeError('fetch failed') }), fs: brokenFs, isJobRunning: boom,
      spawn: boom, shutdown: boom, resume: boom, quit: boom, relaunch: boom, showItemInFolder: boom, openPath: boom, emitProgress: boom, defer: (fn: () => void) => fn(),
    })
    await expect(r.check()).resolves.toMatchObject({ status: 'offline' })
    await expect(r.download(nextTag)).resolves.toMatchObject({ ok: false, message: expect.any(String) })
    await expect(r.install()).resolves.toMatchObject({ ok: false, message: expect.any(String) })
    const withFiles = route(standardRelease().fetch, { fs: brokenFs }).r
    await expect(withFiles.download(nextTag)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('could not save the download') })
  })
})

describe('WO-2883 fix round 3: each host call in the table fails on its own and is answered', () => {
  /** The real fs/promises, with one operation made to fail (handle methods included). */
  function faultyFs(fails: {
    open?: (file: string, flags: string) => boolean; write?: boolean; close?: boolean; read?: boolean
    rename?: boolean | ((from: string, to: string) => boolean); rm?: boolean; chmod?: boolean
  }) {
    return {
      ...fsp,
      rename: async (from: string, to: string) => {
        if (typeof fails.rename === 'function' ? fails.rename(from, to) : fails.rename) throw new Error('EBUSY: rename')
        return fsp.rename(from, to)
      },
      rm: async (file: string, options: Parameters<typeof fsp.rm>[1]) => { if (fails.rm) throw new Error('EPERM: rm'); return fsp.rm(file, options) },
      chmod: async (file: string, mode: number) => { if (fails.chmod) throw new Error('EPERM: chmod'); return fsp.chmod(file, mode) },
      open: async (file: string, flags: string) => {
        if (fails.open?.(file, flags)) throw new Error(`EACCES: open ${path.basename(file)}`)
        const handle = await fsp.open(file, flags)
        return {
          write: (chunk: Buffer) => fails.write ? Promise.reject(new Error('ENOSPC: disk full')) : handle.write(chunk),
          read: (...args: Parameters<typeof handle.read>) => fails.read ? Promise.reject(new Error('EIO: read')) : handle.read(...args),
          close: async () => { await handle.close(); if (fails.close) throw new Error('EIO: close') },
        }
      },
    }
  }
  const all = { [setupName]: installer, 'SHA256SUMS.txt': sums({ [setupName]: installer }) }
  const leftovers = () => existsSync(path.join(updatesDir, nextVersion)) ? readdirSync(path.join(updatesDir, nextVersion)) : []

  it('a release list whose JSON cannot be read is offline', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token') } }))
    expect(await route(fetch).r.check()).toMatchObject({ status: 'offline' })
  })
  it('SHA256SUMS.txt that cannot be fetched downloads nothing', async () => {
    const base = github([release(nextTag, all)], all)
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('SHA256SUMS.txt')) throw new TypeError('sums reset')
      return base.fetch(url)
    })
    expect((await route(fetch).r.download(nextTag)).message)
      .toBe(`LienCAM could not read SHA256SUMS.txt for ${nextVersion} (sums reset); nothing was downloaded.`)
    expect(base.fetch.mock.calls.some(([url]) => String(url).endsWith(setupName))).toBe(false)
  })
  it('a stream that breaks mid-read leaves no partial file', async () => {
    const base = github([release(nextTag, all)], all)
    const fetch = vi.fn(async (url: string) => url.endsWith(setupName)
      ? { ok: true, body: { getReader: () => ({ read: async () => { throw new Error('connection reset mid-stream') } }) } }
      : base.fetch(url))
    expect((await route(fetch).r.download(nextTag)).message)
      .toBe(`The download of LienCAM ${nextVersion} stopped (connection reset mid-stream); nothing was installed.`)
    expect(leftovers()).toEqual([])
  })
  it.each([
    ['opening the .part file', { open: (file: string) => file.endsWith('.part') }, 'EACCES: open'],
    ['writing it', { write: true }, 'ENOSPC: disk full'],
    ['closing it', { close: true }, 'EIO: close'],
  ])('a failure %s stops the download with one sentence and no partial file', async (_what, fails, reason) => {
    const result = await route(github([release(nextTag, all)], all).fetch, { fs: faultyFs(fails) }).r.download(nextTag)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(`The download of LienCAM ${nextVersion} stopped (${reason}`) })
    expect(leftovers()).toEqual([])
  })
  it('a checked file that cannot be renamed into place is not kept', async () => {
    const result = await route(github([release(nextTag, all)], all).fetch, { fs: faultyFs({ rename: true }) }).r.download(nextTag)
    expect(result).toEqual({ ok: false, message: `LienCAM could not save the download of ${nextVersion} (EBUSY: rename); nothing was installed.` })
    expect(leftovers()).toEqual([])
  })
  it('a checked file that cannot be read again asks for a new download', async () => {
    const reads = { fail: false }
    const fs = faultyFs({ open: (_file, flags) => flags === 'r' && reads.fail })
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { fs })
    await r.download(nextTag)
    reads.fail = true
    expect(await r.install()).toMatchObject({ ok: false, downloadAgain: true, message: expect.stringContaining('could not be read again (EACCES: open') })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  it('a program started while the file is checked again still holds the install', async () => {
    let running = false
    const fs = faultyFs({ open: (_file, flags) => { if (flags === 'r') running = true; return false } })
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { fs, isJobRunning: () => running })
    await r.download(nextTag)
    running = false
    expect(await r.install()).toEqual({ ok: false, message: 'LienCAM does not install an update while a program is running; finish or stop the program, then install.' })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  // Fix round 4: the rows astra noted were covered only through a neighbouring failure.
  it('a cleanup that cannot delete still answers the refusal (tampered download)', async () => {
    const files = { [setupName]: installer, 'SHA256SUMS.txt': sums({ [setupName]: Buffer.from('other bytes') }) }
    const { r, calls } = route(github([release(nextTag, files)], files).fetch, { fs: faultyFs({ rm: true }) })
    expect(await r.download(nextTag)).toEqual({ ok: false, message: `The downloaded ${setupName} did not match its published SHA-256 checksum, so it was deleted and nothing was installed.` })
    expect(await r.install()).toMatchObject({ ok: false, downloadAgain: true })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  it('a cleanup that cannot delete still answers the refusal (file changed on disk)', async () => {
    const reads = { rm: false }
    const fs = { ...faultyFs({}), rm: async (file: string, options: Parameters<typeof fsp.rm>[1]) => { if (reads.rm) throw new Error('EPERM: rm'); return fsp.rm(file, options) } }
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { fs })
    const downloaded = await r.download(nextTag)
    writeFileSync(downloaded.file, 'changed')
    reads.rm = true
    expect(await r.install()).toEqual({ ok: false, downloadAgain: true, message: `The downloaded LienCAM ${nextVersion} changed on disk since it was checked, so it was deleted and nothing was installed.` })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  it.each([
    ['reading', { read: true }, 'EIO: read'],
    ['closing', { close: true }, 'EIO: close'],
  ])('a checked file that fails %s again asks for a new download', async (_what, fails, reason) => {
    const state = { on: false }
    const fs = faultyFs({})
    const failing = faultyFs(fails)
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { fs: { ...fs, open: (file: string, flags: string) => (state.on ? failing : fs).open(file, flags) } })
    expect(await r.download(nextTag)).toMatchObject({ ok: true })
    state.on = true
    expect(await r.install()).toEqual({ ok: false, downloadAgain: true, message: `The downloaded LienCAM ${nextVersion} could not be read again (${reason}); download it again.` })
    expect(calls.spawn).not.toHaveBeenCalled()
  })
  it.each([
    ['its execute bit cannot be set', { chmod: true }, 'EPERM: chmod'],
    ['it cannot be moved over this copy', { rename: (_from: string, to: string) => to.endsWith('LienCAM.AppImage') }, 'EBUSY: rename'],
  ])('an AppImage whose %s leaves this copy and no staged file', async (_what, fails, reason) => {
    const name = `LienCAM-${nextVersion}-linux-x86_64.AppImage`
    const image = Buffer.from('new appimage bytes')
    const files = { [name]: image, 'SHA256SUMS.txt': sums({ [name]: image }) }
    const appImage = path.join(dir, 'LienCAM.AppImage')
    writeFileSync(appImage, 'old appimage bytes')
    const { r, calls } = route(github([release(nextTag, files)], files).fetch, { platform: 'linux', appImage, fs: faultyFs(fails) })
    expect(await r.download(nextTag)).toMatchObject({ ok: true })
    expect(await r.install()).toMatchObject({ ok: false, message: expect.stringContaining(`LienCAM could not replace ${appImage} (${reason}); this copy is unchanged.`) })
    expect(readFileSync(appImage, 'utf8')).toBe('old appimage bytes')
    expect(existsSync(`${appImage}.update`)).toBe(false)
    expect(calls.relaunch).not.toHaveBeenCalled()
  })
  it('a relaunch that throws after the AppImage is replaced breaks nothing', async () => {
    const name = `LienCAM-${nextVersion}-linux-x86_64.AppImage`
    const image = Buffer.from('new appimage bytes')
    const files = { [name]: image, 'SHA256SUMS.txt': sums({ [name]: image }) }
    const appImage = path.join(dir, 'LienCAM.AppImage')
    writeFileSync(appImage, 'old appimage bytes')
    const relaunch = vi.fn(() => { throw new Error('relaunch failed') })
    const { r } = route(github([release(nextTag, files)], files).fetch, { platform: 'linux', appImage, relaunch })
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: true, restarting: true })
    expect(relaunch).toHaveBeenCalledWith(appImage)
  })
})

describe('WO-2883 IPC', () => {
  it('only the app window drives the route', async () => {
    const handlers: Record<string, (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>> = {}
    const ipcMain = { handle: (channel: string, fn: (typeof handlers)[string]) => { handlers[channel] = fn } }
    const appWindow = {}
    const fake = { check: vi.fn(async () => 'checked'), download: vi.fn(async (tag: string) => tag), install: vi.fn(async () => 'installed') }
    registerUpdateIpc({ ipcMain, route: fake, isTrustedSender: (sender: unknown) => sender === appWindow })
    expect(Object.keys(handlers).sort()).toEqual(['liencam:update-check', 'liencam:update-download', 'liencam:update-install'])
    expect(await handlers['liencam:update-download']({ sender: appWindow }, nextTag)).toBe(nextTag)
    expect(await handlers['liencam:update-install']({ sender: {} })).toEqual({ ok: false, message: 'Only the LienCAM window can update LienCAM.' })
    expect(fake.install).not.toHaveBeenCalled()
  })
  it('a sender check that throws (a destroyed window) is an untrusted sender, not a rejection', async () => {
    const handlers: Record<string, (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>> = {}
    const ipcMain = { handle: (channel: string, fn: (typeof handlers)[string]) => { handlers[channel] = fn } }
    const fake = { check: vi.fn(), download: vi.fn(), install: vi.fn() }
    registerUpdateIpc({ ipcMain, route: fake, isTrustedSender: () => { throw new TypeError('Object has been destroyed') } })
    expect(await handlers['liencam:update-install']({ sender: {} })).toEqual({ ok: false, message: 'Only the LienCAM window can update LienCAM.' })
    expect(fake.install).not.toHaveBeenCalled()
  })
  it('a route that throws still answers the window with a sentence', async () => {
    const handlers: Record<string, (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>> = {}
    const ipcMain = { handle: (channel: string, fn: (typeof handlers)[string]) => { handlers[channel] = fn } }
    const appWindow = {}
    const fake = { check: vi.fn(async () => { throw new Error('bug') }), download: vi.fn(), install: vi.fn() }
    registerUpdateIpc({ ipcMain, route: fake, isTrustedSender: (sender: unknown) => sender === appWindow })
    expect(await handlers['liencam:update-check']({ sender: appWindow })).toEqual({ ok: false, message: 'LienCAM could not finish the update step (bug); nothing was installed.' })
  })
})

describe('WO-2883 fix round 5: the installer starts and the AppImage is swapped only after the bridge shutdown', () => {
  /** A shutdown the test resolves by hand, so the order around it can be seen. */
  function heldShutdown(log: string[]) {
    let finish: (stopped: boolean) => void = () => {}
    const shutdown = vi.fn(() => {
      log.push('shutdown started')
      return new Promise<boolean>((resolve) => { finish = (stopped) => { log.push('bridge exited'); resolve(stopped) } })
    })
    return { shutdown, finish: (stopped = true) => finish(stopped) }
  }
  const appImageName = `LienCAM-${nextVersion}-linux-x86_64.AppImage`
  const appImageBytes = Buffer.from('new appimage bytes')
  const appImageFiles = { [appImageName]: appImageBytes, 'SHA256SUMS.txt': sums({ [appImageName]: appImageBytes }) }

  it('the Windows installer is spawned only after the bridge shutdown resolves, and the quit after that', async () => {
    const log: string[] = []
    const held = heldShutdown(log)
    const spawn = vi.fn(() => { log.push('installer spawned'); return startedChild() })
    const quit = vi.fn(() => { log.push('quit') })
    const { r } = route(standardRelease().fetch, { spawn, quit, shutdown: held.shutdown })
    await r.download(nextTag)
    const pending = r.install()
    await vi.waitFor(() => expect(held.shutdown.mock.calls.length + spawn.mock.calls.length).toBeGreaterThan(0))
    await new Promise(resolve => setImmediate(resolve))
    expect(spawn).not.toHaveBeenCalled()
    held.finish()
    expect(await pending).toMatchObject({ ok: true, restarting: true })
    expect(log).toEqual(['shutdown started', 'bridge exited', 'installer spawned', 'quit'])
  })
  it('the AppImage is swapped and relaunched only after the bridge shutdown resolves', async () => {
    const log: string[] = []
    const held = heldShutdown(log)
    const appImage = path.join(dir, 'LienCAM.AppImage')
    writeFileSync(appImage, 'old appimage bytes')
    const relaunch = vi.fn(() => { log.push(`relaunch, AppImage ${readFileSync(appImage, 'utf8')}`) })
    const { r } = route(github([release(nextTag, appImageFiles)], appImageFiles).fetch, { platform: 'linux', appImage, relaunch, shutdown: held.shutdown })
    await r.download(nextTag)
    const pending = r.install()
    await vi.waitFor(() => expect(held.shutdown.mock.calls.length + relaunch.mock.calls.length).toBeGreaterThan(0))
    await new Promise(resolve => setImmediate(resolve))
    expect(readFileSync(appImage, 'utf8')).toBe('old appimage bytes')
    expect(relaunch).not.toHaveBeenCalled()
    held.finish()
    expect(await pending).toMatchObject({ ok: true, restarting: true })
    expect(log).toEqual(['shutdown started', 'bridge exited', 'relaunch, AppImage new appimage bytes'])
  })
  it('a bridge that does not close installs nothing and says so', async () => {
    const { r, calls } = route(standardRelease().fetch, { shutdown: vi.fn(async () => false) })
    await r.download(nextTag)
    expect(await r.install()).toEqual({ ok: false, message: 'The machine bridge did not close, so LienCAM did not install; this copy is unchanged. Close LienCAM, start it again, then install.' })
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.quit).not.toHaveBeenCalled()
  })
  it('a bridge that is updating the controller firmware is not stopped and nothing is installed', async () => {
    const appImage = path.join(dir, 'LienCAM.AppImage')
    writeFileSync(appImage, 'old appimage bytes')
    const shutdown = vi.fn(async () => { throw new Error('the controller is updating its firmware') })
    const { r, calls } = route(github([release(nextTag, appImageFiles)], appImageFiles).fetch, { platform: 'linux', appImage, shutdown })
    await r.download(nextTag)
    expect(await r.install()).toEqual({ ok: false, message: 'LienCAM could not close the machine bridge (the controller is updating its firmware), so it did not install; this copy is unchanged.' })
    expect(readFileSync(appImage, 'utf8')).toBe('old appimage bytes')
    expect(calls.relaunch).not.toHaveBeenCalled()
    expect(calls.resume).not.toHaveBeenCalled()
  })
  it('an installer the OS cannot start after the shutdown starts the bridge again and keeps this copy open', async () => {
    const { r, calls } = route(standardRelease().fetch, { spawn: vi.fn(() => failedChild('ENOENT')) })
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: false, message: expect.stringContaining('could not start the installer') })
    expect(calls.shutdown).toHaveBeenCalledTimes(1)
    expect(calls.resume).toHaveBeenCalledTimes(1)
    expect(calls.quit).not.toHaveBeenCalled()
  })
  it('routes that replace nothing never shut the bridge down', async () => {
    const name = `LienCAM-${nextVersion}-linux-x64.tar.gz`
    const bytes = Buffer.from('tar bytes')
    const all = { [name]: bytes, 'SHA256SUMS.txt': sums({ [name]: bytes }) }
    const { r, calls } = route(github([release(nextTag, all)], all).fetch, { platform: 'linux' })
    await r.download(nextTag)
    expect(await r.install()).toMatchObject({ ok: true, restarting: false })
    expect(calls.shutdown).not.toHaveBeenCalled()
  })
})
