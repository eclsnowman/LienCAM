import { createServer } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'

const { gateChildEnv } = await import(new URL('../../../tools/test-gate.mjs', import.meta.url).href) as {
  gateChildEnv: (source?: NodeJS.ProcessEnv, platform?: string) => NodeJS.ProcessEnv
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

afterEach(() => vi.unstubAllEnvs())

describe('WO-2479: Spark live servers survive exhausted native watcher quotas', () => {
  it('makes Linux branch and main gate children use polling without mutating their parent', () => {
    const source = { CHOKIDAR_USEPOLLING: 'false', LIENCAM_TEST_ROOT: '/candidate', KEEP: 'value' }
    const env = gateChildEnv(source, 'linux')
    expect(env.CHOKIDAR_USEPOLLING).toBe('true')
    expect(env.KEEP).toBe('value')
    expect(env.LIENCAM_TEST_ROOT).toBeUndefined()
    expect(env.LIENCAM_NESTED_TEST_LOCK).toBe('per-process')
    expect(source.CHOKIDAR_USEPOLLING).toBe('false')
  })

  it('preserves the Windows watcher policy', () => {
    expect(gateChildEnv({}, 'win32').CHOKIDAR_USEPOLLING).toBeUndefined()
    expect(gateChildEnv({ CHOKIDAR_USEPOLLING: 'false' }, 'win32').CHOKIDAR_USEPOLLING).toBe('false')
  })

  it('starts real Vite and serves this checkout when fs.watch throws ENOSPC', async () => {
    const preload = path.resolve('src/tests/evidence/WO-2479/exhaust-native-watchers.cjs').replaceAll('\\', '/')
    const env = gateChildEnv(process.env, 'linux')
    vi.stubEnv('CHOKIDAR_USEPOLLING', env.CHOKIDAR_USEPOLLING!)
    vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS || ''} --require="${preload}"`)
    const port = await freePort()
    let base = ''
    await withViteCaptureServer({ port, timeoutMs: 15_000 }, async ({ baseUrl }) => {
      base = baseUrl
      const response = await fetch(baseUrl)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('/src/main.tsx')
      // Native watcher discovery is asynchronous after Vite's ready banner.
      // A server that reports ready and immediately dies must still fail here.
      await new Promise(resolve => setTimeout(resolve, 1_000))
      expect((await fetch(baseUrl)).status).toBe(200)
    })
    await expect(fetch(base)).rejects.toThrow()
  }, 30_000)
})
