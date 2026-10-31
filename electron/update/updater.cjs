'use strict'

// WO-2883: the desktop app updates itself from the published GitHub releases.
// The route reads github.com/eclsnowman/LienCAM releases, downloads the file for
// this build, keeps it only when its SHA-256 matches the release's published
// SHA256SUMS.txt (the builds are not code-signed), and installs it only when the
// operator says so and no program is running. It never touches the userData
// folder or the renderer's storage (ADR-0059: an update keeps your data).
//
// electron/main.cjs owns the app object, the window and the job wake lock; it
// passes them in (see createUpdateRoute options), so this module is testable
// without Electron.

const { createHash } = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { compareVersions } = require('./version.cjs')

const REPO = 'eclsnowman/LienCAM'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`
const RELEASE_PAGE_PREFIX = `https://github.com/${REPO}/releases/tag/`
const SUMS_NAME = 'SHA256SUMS.txt'
const MAX_SUMS_BYTES = 64 * 1024
const PROGRESS_STEP = 1024 * 1024

/** What this running copy is, which decides the release file it needs and what "install" means. */
function buildKind({ platform, packaged, portableFile, appImage }) {
  if (!packaged) return 'source'
  if (platform === 'win32') return portableFile ? 'portable' : 'installer'
  if (platform === 'linux') return appImage ? 'appimage' : 'archive'
  if (platform === 'darwin') return 'dmg'
  return 'unsupported'
}

/** The release asset name electron-builder.yml gives this build kind. */
function assetNameFor(kind, version, arch) {
  const base = `LienCAM-${version}`
  if (kind === 'installer') return `${base}-win-${arch}-setup.exe`
  if (kind === 'portable') return `${base}-win-${arch}-portable.exe`
  if (kind === 'appimage') return `${base}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`
  if (kind === 'archive') return `${base}-linux-${arch}.tar.gz`
  if (kind === 'dmg') return `${base}-mac-${arch}.dmg`
  return null
}

/** `<sha256>  <name>` lines (sha256sum format, text or binary marker). */
function parseSums(text) {
  const sums = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (match) sums.set(match[2].trim(), match[1].toLowerCase())
  }
  return sums
}

function releaseVersion(tag) {
  return String(tag).replace(/^v/, '')
}

function isPublished(release) {
  return release && typeof release === 'object' && release.draft === false &&
    typeof release.published_at === 'string' && release.published_at !== '' &&
    typeof release.tag_name === 'string' && typeof release.html_url === 'string' &&
    release.html_url.startsWith(RELEASE_PAGE_PREFIX) && Array.isArray(release.assets)
}

function downloadPrefix(tag) {
  return `https://github.com/${REPO}/releases/download/${tag}/`
}

function findAsset(release, name) {
  if (!name) return null
  const asset = release.assets.find((candidate) => candidate && candidate.name === name)
  if (!asset || typeof asset.browser_download_url !== 'string') return null
  if (!asset.browser_download_url.startsWith(downloadPrefix(release.tag_name))) return null
  return asset
}

function reasonOf(error) {
  if (error && typeof error === 'object' && 'message' in error && error.message) return String(error.message)
  return String(error)
}

async function hashFile(fs, file) {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(PROGRESS_STEP)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * options:
 *   currentVersion   app.getVersion()
 *   platform, arch   process.platform / process.arch
 *   packaged         app.isPackaged
 *   portableFile     process.env.PORTABLE_EXECUTABLE_FILE (electron-builder portable)
 *   appImage         process.env.APPIMAGE (AppImage runtime)
 *   updatesDir       where checked downloads are kept (inside the temp folder, never userData)
 *   fetch            net.fetch in the app; any fetch in tests
 *   isJobRunning     () => true while a program runs (main.cjs job wake lock)
 *   spawn            child_process.spawn
 *   shutdown         () => Promise<boolean>, stops the pendant and waits for the machine bridge
 *                    to exit (false when it would not); awaited before this copy is replaced
 *   resume           () => void, starts the machine bridge again after a replace that failed
 *   quit             () => void, closes the app (app.quit)
 *   relaunch         (execPath) => void, restarts from execPath (app.relaunch + app.exit)
 *   showItemInFolder, openPath   shell
 *   emitProgress     ({ version, received, total }) => void
 *   fs               node:fs/promises (tests may pass a wrapper)
 *   defer            (fn) => void, runs after the IPC reply (setTimeout in the app)
 */
function createUpdateRoute(options) {
  const fetcher = options.fetch
  const fs = options.fs ?? fsp
  const kind = buildKind(options)
  const defer = options.defer ?? ((fn) => setTimeout(fn, 250))
  let ready = null
  let downloading = false
  let installing = null // the install in flight, so a second click joins it
  let restarted = null // the answer of an install that already handed over to the new version

  /**
   * Every host call (network, file system, child process, shell) goes through here:
   * it resolves to { ok: true, value } or { ok: false, message } with the operator's
   * sentence, and never rejects or throws (fix round 3: the failure class, not the instance).
   */
  async function attempt(call, sentence) {
    try {
      return { ok: true, value: await call() }
    } catch (error) {
      return { ok: false, message: sentence(reasonOf(error)) }
    }
  }

  /** A host call whose failure has nobody to answer (progress, the deferred quit): logged, never thrown. */
  function quietly(call) {
    try {
      call()
    } catch (error) {
      console.warn(`[LienCAM] update: ${reasonOf(error)}`)
    }
  }

  async function getJson(url) {
    const response = await fetcher(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    return response.json()
  }

  async function removeQuietly(file) {
    if (file) await attempt(() => fs.rm(file, { force: true }), () => '')
  }

  async function fail(file, message) {
    await removeQuietly(file)
    return { ok: false, message }
  }

  /** The newest published release newer than this copy, or why there is none. */
  async function check() {
    const list = await attempt(() => getJson(RELEASES_API),
      () => 'LienCAM could not reach GitHub to check for updates; it keeps working as it is.')
    if (!list.ok) return { status: 'offline', message: list.message }
    const releases = list.value
    if (!Array.isArray(releases)) {
      return { status: 'offline', message: 'LienCAM could not read the release list from GitHub; it keeps working as it is.' }
    }
    let newest = null
    for (const release of releases) {
      if (!isPublished(release)) continue
      if ((compareVersions(release.tag_name, options.currentVersion) ?? 0) <= 0) continue
      if (!newest || (compareVersions(release.tag_name, newest.tag_name) ?? 0) > 0) newest = release
    }
    if (!newest) return { status: 'current', version: options.currentVersion }
    const version = releaseVersion(newest.tag_name)
    const asset = findAsset(newest, assetNameFor(kind, version, options.arch))
    return {
      status: 'available',
      tag: newest.tag_name,
      version,
      currentVersion: options.currentVersion,
      kind,
      releaseUrl: newest.html_url,
      assetName: asset ? asset.name : null,
      size: asset && Number.isFinite(asset.size) ? asset.size : null,
      ...(kind === 'source' ? { message: 'This copy of LienCAM runs from source; update it with git pull, not from releases.' } : {}),
      ...(kind !== 'source' && !asset ? { message: `LienCAM ${version} has no download for this computer; the release page has every file: ${newest.html_url}` } : {}),
    }
  }

  /** Streams the release file to `part`, hashing as it goes; resolves to its SHA-256 and size. */
  async function fetchToFile(url, part, version, total) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
    if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`)
    const hash = createHash('sha256')
    let received = 0
    let reported = 0
    const handle = await fs.open(part, 'w')
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        hash.update(chunk)
        await handle.write(chunk)
        received += chunk.length
        if (received - reported >= PROGRESS_STEP) {
          reported = received
          quietly(() => options.emitProgress?.({ version, received, total }))
        }
      }
    } finally {
      await handle.close()
    }
    quietly(() => options.emitProgress?.({ version, received, total }))
    return hash.digest('hex')
  }

  /** Downloads the release file for this build and keeps it only if its SHA-256 matches the published sums. */
  async function download(tag) {
    const outcome = await attempt(() => downloadRelease(tag),
      (reason) => `LienCAM could not download the update (${reason}); nothing was installed.`)
    return outcome.ok ? outcome.value : { ok: false, message: outcome.message }
  }

  async function downloadRelease(tag) {
    if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(tag)) {
      return { ok: false, message: 'That is not a LienCAM release tag.' }
    }
    if (kind === 'source') return { ok: false, message: 'This copy of LienCAM runs from source; update it with git pull, not from releases.' }
    if (downloading) return { ok: false, message: 'An update is already downloading.' }
    if ((compareVersions(tag, options.currentVersion) ?? 0) <= 0) {
      return { ok: false, message: `LienCAM ${releaseVersion(tag)} is not newer than this copy (${options.currentVersion}).` }
    }
    downloading = true
    let part = null
    try {
      const version = releaseVersion(tag)
      const fetched = await attempt(() => getJson(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`),
        (reason) => `LienCAM could not reach GitHub to download the update (${reason}); nothing was changed.`)
      if (!fetched.ok) return fetched
      const release = fetched.value
      if (!isPublished(release) || release.tag_name !== tag) {
        return { ok: false, message: `LienCAM ${version} is not a published release, so nothing was downloaded.` }
      }
      const asset = findAsset(release, assetNameFor(kind, version, options.arch))
      if (!asset) return { ok: false, message: `LienCAM ${version} has no download for this computer; the release page has every file: ${release.html_url}` }
      const sumsAsset = findAsset(release, SUMS_NAME)
      if (!sumsAsset) return { ok: false, message: `LienCAM ${version} has no published ${SUMS_NAME}, so its download cannot be checked and was not made.` }

      const sums = await attempt(async () => {
        const response = await fetcher(sumsAsset.browser_download_url, { signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
        const text = await response.text()
        if (text.length > MAX_SUMS_BYTES) throw new Error(`${SUMS_NAME} is larger than expected`)
        return parseSums(text).get(asset.name)
      }, (reason) => `LienCAM could not read ${SUMS_NAME} for ${version} (${reason}); nothing was downloaded.`)
      if (!sums.ok) return sums
      const expected = sums.value
      if (!expected) return { ok: false, message: `${SUMS_NAME} for LienCAM ${version} does not list ${asset.name}, so it was not downloaded.` }

      const savingFailed = (reason) => `LienCAM could not save the download of ${version} (${reason}); nothing was installed.`
      const dir = path.join(options.updatesDir, version)
      const made = await attempt(() => fs.mkdir(dir, { recursive: true }), savingFailed)
      if (!made.ok) return made
      const target = path.join(dir, asset.name)
      part = `${target}.part`
      const total = Number.isFinite(asset.size) ? asset.size : null
      const streamed = await attempt(() => fetchToFile(asset.browser_download_url, part, version, total),
        (reason) => `The download of LienCAM ${version} stopped (${reason}); nothing was installed.`)
      if (!streamed.ok) return await fail(part, streamed.message)
      if (streamed.value !== expected) {
        return await fail(part, `The downloaded ${asset.name} did not match its published SHA-256 checksum, so it was deleted and nothing was installed.`)
      }
      const kept = await attempt(async () => {
        await fs.rm(target, { force: true })
        await fs.rename(part, target)
      }, savingFailed)
      if (!kept.ok) return await fail(part, kept.message)
      part = null
      ready = { tag, version, file: target, sha256: expected, kind }
      return { ok: true, version, kind, file: target, sha256: expected }
    } finally {
      downloading = false
      await removeQuietly(part)
    }
  }

  /** Starts the installer; resolves only once the OS reports it started ('spawn') or could not ('error'). */
  function startInstaller(file, version) {
    const couldNot = (reason) => `LienCAM could not start the installer for ${version} (${reason}); this copy is unchanged and keeps running.`
    return new Promise((resolve) => {
      let child
      try {
        child = options.spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' })
      } catch (error) {
        resolve({ ok: false, message: couldNot(reasonOf(error)) })
        return
      }
      child.once('error', (error) => resolve({ ok: false, message: couldNot(reasonOf(error)) }))
      child.once('spawn', () => {
        quietly(() => child.unref())
        resolve({ ok: true })
      })
    })
  }

  /**
   * Installs the checked download on the operator's word. Only the routes that replace
   * and restart this copy (installer, AppImage) wait for a running program to finish;
   * showing the file or opening the disk image replaces nothing, so it always works.
   */
  function install() {
    if (restarted) return Promise.resolve(restarted)
    if (!installing) {
      installing = attempt(installChecked, (reason) => `LienCAM could not install the update (${reason}); this copy is unchanged.`)
        .then((outcome) => outcome.ok ? outcome.value : { ok: false, message: outcome.message })
        .then((result) => {
          if (result.ok && result.restarting) restarted = result
          installing = null
          return result
        })
    }
    return installing
  }

  async function installChecked() {
    if (!ready) return { ok: false, downloadAgain: true, message: 'There is no checked update download to install.' }
    const { version, file } = ready
    const hashed = await attempt(() => hashFile(fs, file),
      (reason) => `The downloaded LienCAM ${version} could not be read again (${reason}); download it again.`)
    if (!hashed.ok) {
      ready = null
      return { ...hashed, downloadAgain: true }
    }
    if (hashed.value !== ready.sha256) {
      ready = null
      return { ...(await fail(file, `The downloaded LienCAM ${version} changed on disk since it was checked, so it was deleted and nothing was installed.`)), downloadAgain: true }
    }
    if (ready.kind === 'installer' || ready.kind === 'appimage') {
      // Read right before replacing this copy, after the re-hash, so a program started
      // meanwhile still holds the install (the order: never while a program runs).
      const running = await attempt(() => options.isJobRunning(),
        (reason) => `LienCAM could not tell whether a program is running (${reason}), so it did not install.`)
      if (!running.ok) return running
      if (running.value) {
        return { ok: false, message: 'LienCAM does not install an update while a program is running; finish or stop the program, then install.' }
      }
      // Fix round 5: the one shutdown every install-and-restart path takes. The installer
      // starts, and the AppImage is swapped, only once the machine bridge has exited.
      const stopped = await attempt(() => options.shutdown(),
        (reason) => `LienCAM could not close the machine bridge (${reason}), so it did not install; this copy is unchanged.`)
      if (!stopped.ok) return stopped
      if (stopped.value !== true) {
        return { ok: false, message: 'The machine bridge did not close, so LienCAM did not install; this copy is unchanged. Close LienCAM, start it again, then install.' }
      }
    }
    if (ready.kind === 'installer') {
      const started = await startInstaller(file, version)
      if (!started.ok) {
        quietly(() => options.resume())
        return started
      }
      defer(() => quietly(() => options.quit()))
      return { ok: true, restarting: true, message: `Installing LienCAM ${version}; LienCAM and the machine bridge close now and LienCAM starts again when the installer finishes.` }
    }
    if (ready.kind === 'appimage') {
      const staged = `${options.appImage}.update`
      const replaced = await attempt(async () => {
        await fs.copyFile(file, staged)
        await fs.chmod(staged, 0o755)
        await fs.rename(staged, options.appImage)
      }, (reason) => `LienCAM could not replace ${options.appImage} (${reason}); this copy is unchanged. The checked file is in ${path.dirname(file)}.`)
      if (!replaced.ok) {
        quietly(() => options.resume())
        return await fail(staged, replaced.message)
      }
      defer(() => quietly(() => options.relaunch(options.appImage)))
      return { ok: true, restarting: true, message: `LienCAM ${version} replaced this AppImage; LienCAM and the machine bridge restart now.` }
    }
    if (ready.kind === 'dmg') {
      // shell.openPath resolves to '' on success and to the reason on failure.
      const opened = await attempt(async () => {
        const reason = await options.openPath(file)
        if (reason) throw new Error(reason)
      }, (reason) => `LienCAM could not open the checked disk image (${reason}); it is in ${path.dirname(file)}. Open it from there, drag LienCAM to Applications, then start the new one.`)
      if (!opened.ok) return opened
      return { ok: true, restarting: false, message: `LienCAM ${version} is checked and opened; drag LienCAM to Applications, then quit this copy and start the new one.` }
    }
    const shown = await attempt(() => options.showItemInFolder(file),
      (reason) => `LienCAM could not show the checked file (${reason}); it is ${file}. Close LienCAM and start the new one.`)
    if (!shown.ok) return shown
    const what = ready.kind === 'portable' ? 'This portable copy cannot replace itself while it runs' : 'This copy cannot replace itself'
    return { ok: true, restarting: false, message: `${what}; the checked LienCAM ${version} is in ${path.dirname(file)}. Close LienCAM and start the new one.` }
  }

  return { kind, check, download, install, ready: () => ready }
}

/** IPC for the renderer (electron/preload.cjs liencamHost.update). Only the app window may drive it; it never rejects. */
function registerUpdateIpc({ ipcMain, route, isTrustedSender }) {
  const guard = (handler) => async (event, ...args) => {
    try {
      // A destroyed window throws on webContents; that sender is not trusted either.
      let trusted = false
      try { trusted = isTrustedSender(event.sender) } catch { trusted = false }
      if (!trusted) return { ok: false, message: 'Only the LienCAM window can update LienCAM.' }
      return await handler(...args)
    } catch (error) {
      return { ok: false, message: `LienCAM could not finish the update step (${reasonOf(error)}); nothing was installed.` }
    }
  }
  ipcMain.handle('liencam:update-check', guard(() => route.check()))
  ipcMain.handle('liencam:update-download', guard((tag) => route.download(tag)))
  ipcMain.handle('liencam:update-install', guard(() => route.install()))
}

module.exports = { createUpdateRoute, registerUpdateIpc, buildKind, assetNameFor, parseSums, RELEASES_API }
