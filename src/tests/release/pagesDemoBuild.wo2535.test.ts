import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const { build, loadConfigFromFile } = vi.hoisted(() => ({ build: vi.fn(), loadConfigFromFile: vi.fn() }))
vi.mock('vite', () => typedMock<typeof import('vite')>({ build, loadConfigFromFile }))
// @ts-expect-error Standalone release script is plain JavaScript.
import { buildPages } from '../../../tools/release/build-pages.mjs'

const scratch: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WO-2535 Pages always builds the browser demo', () => {
  it.each([undefined, 'false', 'true'])('enables the demo with caller flag %s, without changing other builds', async flag => {
    vi.stubEnv('VITE_DEMO_BUILD', flag)
    const app = { define: { __BUILD_COMMIT__: '"original"', 'import.meta.env.VITE_DEMO_BUILD': '"false"' } }
    const site = { define: { __SITE__: 'true' } }
    loadConfigFromFile.mockImplementation((_env, filename: string) => Promise.resolve({
      config: filename.endsWith('vite.site.config.mts') ? site : app,
    }))
    const outDir = mkdtempSync(join(tmpdir(), 'liencam-wo2535-test-'))
    scratch.push(outDir)

    await buildPages({ outDir })

    expect(build).toHaveBeenCalledTimes(2)
    expect(build.mock.calls[0][0].define).toEqual({
      __BUILD_COMMIT__: '"original"', 'import.meta.env.VITE_DEMO_BUILD': '"true"',
    })
    expect(build.mock.calls[0][0].build.outDir).toBe(join(outDir, 'app'))
    expect(build.mock.calls[1][0].define).toEqual(site.define)
    expect(app.define['import.meta.env.VITE_DEMO_BUILD']).toBe('"false"')
    expect(process.env.VITE_DEMO_BUILD).toBe(flag)
  })
})
