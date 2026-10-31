import { isDemoBuild } from '../demoBuild'
import { compareVersions } from './releaseCheck'

// WO-2883: the renderer side of the desktop update route
// (electron/update/updater.cjs, exposed by electron/preload.cjs as
// liencamHost.update). The main process does the network, the checksum and the
// install; the renderer only offers, shows progress and passes the operator's word.

export type UpdateKind = 'installer' | 'portable' | 'appimage' | 'archive' | 'dmg' | 'source' | 'unsupported'

export type UpdateCheck =
  | { status: 'current'; version: string }
  | { status: 'offline'; message: string }
  | {
    status: 'available'; tag: string; version: string; currentVersion: string; kind: UpdateKind
    releaseUrl: string; assetName: string | null; size: number | null; message?: string
  }

export type UpdateDownload =
  | { ok: true; version: string; kind: UpdateKind; file: string; sha256: string }
  | { ok: false; message: string }

export type UpdateInstall =
  | { ok: true; restarting: boolean; message: string }
  // downloadAgain: the checked file is gone or changed, so only a new download can continue.
  | { ok: false; message: string; downloadAgain?: boolean }

export type UpdateProgress = { version: string; received: number; total: number | null }

export interface DesktopUpdateHost {
  check: () => Promise<UpdateCheck>
  download: (tag: string) => Promise<UpdateDownload>
  install: () => Promise<UpdateInstall>
  onProgress: (listener: (progress: UpdateProgress) => void) => () => void
}

/** The update route, when this is the desktop app with an update-capable shell. */
export function desktopUpdateHost(): DesktopUpdateHost | null {
  if (isDemoBuild()) return null
  const host = (globalThis as typeof globalThis & { liencamHost?: { update?: DesktopUpdateHost } }).liencamHost
  const update = host?.update
  if (!update || typeof update.check !== 'function' || typeof update.download !== 'function' ||
    typeof update.install !== 'function' || typeof update.onProgress !== 'function') return null
  return update
}

/** True when this build can fetch the file itself (a source run or a release without its file cannot). */
export function offersDownload(check: UpdateCheck): check is Extract<UpdateCheck, { status: 'available' }> {
  return check.status === 'available' && check.kind !== 'source' && check.kind !== 'unsupported' && check.assetName !== null
}

/** True when installing replaces this copy and restarts it (the installer and the AppImage). */
export function installRestarts(kind: UpdateKind): boolean {
  return kind === 'installer' || kind === 'appimage'
}

export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

/** While the app stays open the offer checks again this often, silently (owner ruling 10-17: a second release comes out). */
export const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let launchCheckClaimed = false
let recheckTimer: ReturnType<typeof setInterval> | null = null
let dismissedVersion: string | null = null

/** The offer checks once per renderer launch (StrictMode remounts the shell); true for the first caller. */
export function claimLaunchUpdateCheck(): boolean {
  if (launchCheckClaimed) return false
  launchCheckClaimed = true
  return true
}

/** Runs the silent re-check for the rest of this run; only the launch check's claimer starts it. */
export function startUpdateRecheck(check: () => void): void {
  if (recheckTimer === null) recheckTimer = setInterval(check, UPDATE_RECHECK_INTERVAL_MS)
}

/** "Not now" or "Later": that version is not offered again in this run of the app. */
export function dismissUpdateVersion(version: string): void {
  dismissedVersion = version
}

/** True when the operator already put this version (or a newer one) off in this run. */
export function isUpdateDismissed(version: string): boolean {
  if (dismissedVersion === null) return false
  const order = compareVersions(version, dismissedVersion)
  return order === null ? version === dismissedVersion : order <= 0
}

/** Test seam for the launch claim, the re-check and the dismissed version. */
export function resetDesktopUpdateCheckForTests(): void {
  launchCheckClaimed = false
  if (recheckTimer !== null) clearInterval(recheckTimer)
  recheckTimer = null
  dismissedVersion = null
}
