import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone release script is plain JavaScript.
import { buildCommitLabel, releaseBuildEnv, shippedExamples, smokeProblems, waitForBodies } from '../../../tools/release/build-from-export.mjs'

// WO-2463: WO-2390's packaged smoke photographed the Lobed knob 0.3 s after the
// open, with 0 bodies, and passed on the feature row alone; About read
// "Build commit unknown" because the exported tree has no .git.

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const VERSION = '0.36.0-alpha.1'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const LABEL = '0123456789ab'
const KNOB = { topic: 'form-walkthrough-lobed-knob', file: 'lobed-knob.camproject', search: 'lobed knob' }
const GRIP = { topic: 'form-walkthrough-grip-handle', file: 'grip-handle.camproject', search: 'grip handle' }

/** A clock the waiter advances itself, so a 180 s wait runs in microseconds. */
function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('WO-2463 packaged smoke checks bodies, not just the open', () => {
  it('fails an example whose model never shows a body', async () => {
    const clock = fakeClock()
    await expect(waitForBodies(async () => 0, { timeout: 180_000, ...clock })).rejects.toThrow('0 bodies after 180000 ms (empty model)')
    expect(clock.now()).toBe(180_000)
  })

  it('waits through a cold Form compute and reports when the body arrived', async () => {
    const clock = fakeClock()
    // The packaged Lobed knob measured 0 bodies until ~20 s after the open.
    const result = await waitForBodies(async () => (clock.now() >= 20_000 ? 1 : 0), clock)
    expect(result).toEqual({ bodies: 1, ms: 20_000 })
  })

  it('rejects a record with an empty, missing or unstamped example', () => {
    const good = { verdict: 'PASS', aboutText: `Version ${VERSION}`, aboutCommit: LABEL,
      examples: [{ ...GRIP, bodies: 1 }, { ...KNOB, bodies: 1 }] }
    const expected = { version: VERSION, commit: LABEL, examples: [GRIP, KNOB] }
    expect(smokeProblems(good, expected)).toEqual([])
    // The WO-2390 record: About version right, commit unknown, knob empty.
    expect(smokeProblems({ ...good, aboutCommit: 'unknown', examples: [{ ...KNOB, bodies: 0 }] }, expected)).toEqual([
      `About commit reads "unknown", expected "${LABEL}"`,
      'example form-walkthrough-grip-handle/grip-handle.camproject was not opened',
      'example form-walkthrough-lobed-knob/lobed-knob.camproject opened with 0 bodies',
    ])
    expect(smokeProblems({ ...good, aboutText: 'Version 0.35.0' }, expected)).toEqual([`About reads "Version 0.35.0", expected "Version ${VERSION}"`])
  })

  it('finds every Help example the build ships, and refuses a build that ships none', () => {
    const root = mkdtempSync(join(tmpdir(), 'wo2463-'))
    scratch.push(root)
    expect(() => shippedExamples(root)).toThrow('No shipped examples')
    for (const example of [KNOB, GRIP]) {
      mkdirSync(join(root, 'dist/help', example.topic), { recursive: true })
      writeFileSync(join(root, 'dist/help', example.topic, example.file), '{}')
    }
    mkdirSync(join(root, 'dist/help/first-toolpath'), { recursive: true })
    writeFileSync(join(root, 'dist/help/first-toolpath/step-1.png'), '')
    expect(shippedExamples(root)).toEqual([GRIP, KNOB])
  })

  it('stamps the build with the exported commit', () => {
    expect(buildCommitLabel(COMMIT)).toBe(LABEL)
    expect(releaseBuildEnv(COMMIT)).toEqual({ LIENCAM_BUILD_COMMIT: LABEL, LIENCAM_BUILD_BRANCH: 'public-export' })
    expect(() => buildCommitLabel(undefined)).toThrow('did not name its source commit')
    expect(() => buildCommitLabel('HEAD')).toThrow('did not name its source commit')
  })

  it('vite.config puts the release commit into the build provenance About reads', async () => {
    const saved = { commit: process.env.LIENCAM_BUILD_COMMIT, branch: process.env.LIENCAM_BUILD_BRANCH }
    try {
      Object.assign(process.env, releaseBuildEnv(COMMIT))
      const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(__dirname, '../../../vite.config.mts'))
      const define = loaded!.config.define as Record<string, string>
      expect(JSON.parse(define.__APP_GIT_COMMIT__)).toMatch(new RegExp(`^${LABEL}:sha256-[0-9a-f]{64}$`))
      expect(JSON.parse(define.__APP_GIT_BRANCH__)).toBe('public-export')
    } finally {
      for (const [key, value] of [['LIENCAM_BUILD_COMMIT', saved.commit], ['LIENCAM_BUILD_BRANCH', saved.branch]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 60_000)
})
