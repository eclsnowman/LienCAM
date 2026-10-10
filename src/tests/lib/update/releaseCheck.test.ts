import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForNewRelease, compareVersions, RELEASES_URL } from '../../../lib/update/releaseCheck'

const current = '0.36.0-alpha.1'
const release = (tag = 'v0.36.0-alpha.2', extra: Record<string, unknown> = {}) => ({
  tag_name: tag, html_url: `https://github.com/eclsnowman/LienCAM/releases/tag/${tag}`,
  draft: false, prerelease: true, published_at: '2026-10-09T12:00:00Z', ...extra,
})
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })

describe('release semver precedence', () => {
  it.each([
    ['0.36.0-alpha.1', '0.36.0-alpha.2'],
    ['0.36.0-alpha.2', '0.36.0-beta.1'],
    ['0.36.0-beta.1', '0.36.0'],
    ['0.36.0', '0.37.0-alpha.1'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.2', '1.0.0-alpha.10'],
    ['1.0.0-2', '1.0.0-alpha'],
    ['1.0.0-B', '1.0.0-a'],
    ['1.9.9', '1.10.0'],
    ['1.0.0-alpha.9007199254740992', '1.0.0-alpha.9007199254740993'],
  ])('%s < %s (and reverse)', (a, b) => {
    expect(compareVersions(a, b)).toBeLessThan(0)
    expect(compareVersions(b, a)).toBeGreaterThan(0)
  })
  it('ignores the tag prefix and build metadata', () => {
    expect(compareVersions('v0.36.0-alpha.1+build.2', current)).toBe(0)
    expect(compareVersions('1.0.0+abc', '1.0.0+def')).toBe(0)
  })
  it.each(['1.0', '01.0.0', '1.0.0-alpha.01', '1.0.0-', 'latest', '1.0.0+'])('ignores invalid version %s', tag => {
    expect(compareVersions(tag, current)).toBeNull()
    expect(compareVersions(current, tag)).toBeNull()
  })
})

describe('one release-list read', () => {
  it('announces the highest published version once, independent of release-list order', async () => {
    const emit = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
      release(), release('v0.37.0-alpha.1'), release('v0.36.0'), release('v0.36.0-beta.1'),
    ]))
    await checkForNewRelease(current, emit, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(RELEASES_URL, expect.objectContaining({ credentials: 'omit' }))
    expect(emit).toHaveBeenCalledExactlyOnceWith({ severity: 'info', source: 'app',
      message: `LienCAM 0.37.0-alpha.1 is available (you have ${current}): https://github.com/eclsnowman/LienCAM/releases/tag/v0.37.0-alpha.1`,
    })
  })
  it('announces a newer prerelease with its tag and URL', async () => {
    const emit = vi.fn()
    await checkForNewRelease(current, emit, vi.fn<typeof fetch>().mockResolvedValue(response([release()])))
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: `LienCAM 0.36.0-alpha.2 is available (you have ${current}): ${release().html_url}`,
    }))
  })
  it.each([
    [release('v0.36.0-alpha.1'), release('v0.35.0')],
    [release('v0.36.0-alpha.1+build.7')],
    [release('v9.0.0', { draft: true })],
    [release('v9.0.0', { published_at: null })],
    [release('latest'), null, {}, release('v9.0.0', { html_url: 'https://other.invalid/' })],
    [],
  ])('silently ignores equal/older, draft, unpublished or invalid releases: %j', async (...entries) => {
    const emit = vi.fn()
    await checkForNewRelease(current, emit, vi.fn<typeof fetch>().mockResolvedValue(response(entries)))
    expect(emit).not.toHaveBeenCalled()
  })
  it.each([403, 429, 500])('silently ignores HTTP %s without another request', async status => {
    const emit = vi.fn(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([], status))
    await expect(checkForNewRelease(current, emit, fetcher)).resolves.toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([new Error('offline'), new DOMException('timed out', 'TimeoutError')])('silently ignores failed requests: %s', async error => {
    const emit = vi.fn(), fetcher = vi.fn<typeof fetch>().mockRejectedValue(error)
    await expect(checkForNewRelease(current, emit, fetcher)).resolves.toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['not json', '{}', 'null'])('silently ignores malformed response %s', async body => {
    const emit = vi.fn()
    await expect(checkForNewRelease(current, emit, vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))).resolves.toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('desktop launch scheduling', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.stubEnv('VITE_DEMO_BUILD', 'false') })
  it('waits three seconds, announces once, and never repeats on shell remount', async () => {
    vi.stubGlobal('liencamHost', {})
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([release('v999.0.0-alpha.2')]))
    vi.stubGlobal('fetch', fetcher)
    const { scheduleDesktopReleaseCheck } = await import('../../../lib/update/releaseCheck')
    const emit = vi.fn()
    scheduleDesktopReleaseCheck(emit)
    scheduleDesktopReleaseCheck(emit)
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetcher).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
    scheduleDesktopReleaseCheck(emit)
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])('does not retry a failed or empty response (failure=%s)', async failed => {
    vi.stubGlobal('liencamHost', {})
    const fetcher = vi.fn<typeof fetch>()
    if (failed) fetcher.mockRejectedValue(new Error('offline'))
    else fetcher.mockResolvedValue(response([]))
    vi.stubGlobal('fetch', fetcher)
    const { scheduleDesktopReleaseCheck } = await import('../../../lib/update/releaseCheck')
    const emit = vi.fn()
    scheduleDesktopReleaseCheck(emit)
    await vi.advanceTimersByTimeAsync(3000)
    scheduleDesktopReleaseCheck(emit)
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not request in a browser (demo=%s)', async demo => {
    vi.stubGlobal('liencamHost', undefined)
    vi.stubEnv('VITE_DEMO_BUILD', String(demo))
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const { scheduleDesktopReleaseCheck } = await import('../../../lib/update/releaseCheck')
    scheduleDesktopReleaseCheck(vi.fn())
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('never requests for a demo build even if a host is present', async () => {
    vi.stubGlobal('liencamHost', {})
    vi.stubEnv('VITE_DEMO_BUILD', 'true')
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const { scheduleDesktopReleaseCheck } = await import('../../../lib/update/releaseCheck')
    scheduleDesktopReleaseCheck(vi.fn())
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
