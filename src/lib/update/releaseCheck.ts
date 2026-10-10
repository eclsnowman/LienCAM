import { isDemoBuild, isDesktopHost } from '../demoBuild'
import { APP_VERSION } from '../../version'

export const RELEASES_URL = 'https://api.github.com/repos/eclsnowman/LienCAM/releases?per_page=20'
export const RELEASE_CHECK_DELAY_MS = 3000

type Version = { core: string[]; pre: string[] }
type ReleaseNotice = { severity: 'info'; source: 'app'; message: string }
type Emit = (notice: ReleaseNotice) => void

function parseVersion(value: string): Version | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some(id => /^\d+$/.test(id) && id.length > 1 && id[0] === '0')) return null
  return { core: match.slice(1, 4), pre }
}

// Compare decimal strings without losing precision on long numeric identifiers.
function compareNumeric(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/** Semver precedence; build metadata has no effect, and invalid tags are ignored. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a), right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(left.core[i], right.core[i])
    if (order) return order
  }
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    return nx && ny ? compareNumeric(x, y) : nx !== ny ? (nx ? -1 : 1) : x < y ? -1 : 1
  }
  return 0
}

/** One best-effort request; all unavailable/malformed responses stay silent. */
export async function checkForNewRelease(currentVersion: string, emit: Emit, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const response = await fetcher(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return
    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) return
    let newest: { tag: string; url: string } | undefined
    for (const release of payload) {
      if (!release || typeof release !== 'object' || release.draft !== false ||
        typeof release.published_at !== 'string' || !release.published_at ||
        typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') continue
      const tag = release.tag_name, url = release.html_url
      if (!url.startsWith('https://github.com/eclsnowman/LienCAM/releases/tag/')) continue
      if ((compareVersions(tag, currentVersion) ?? 0) <= 0) continue
      if (!newest || (compareVersions(tag, newest.tag) ?? 0) > 0) newest = { tag, url }
    }
    if (newest) emit({
      severity: 'info', source: 'app',
      message: `LienCAM ${newest.tag.replace(/^v/, '')} is available (you have ${currentVersion}): ${newest.url}`,
    })
  } catch { /* Offline, rate limited, invalid JSON or timeout: no operator error. */ }
}

let scheduled = false

/** Renderer-launch lifetime, independent of React StrictMode or shell remounts. */
export function scheduleDesktopReleaseCheck(emit: Emit): void {
  if (scheduled || isDemoBuild() || !isDesktopHost()) return
  scheduled = true
  // Deliberately not cancelled on effect cleanup: StrictMode immediately remounts
  // the shell, and a workspace change must not suppress the launch's only check.
  setTimeout(() => { void checkForNewRelease(APP_VERSION, emit) }, RELEASE_CHECK_DELAY_MS)
}
