import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// WO-1717 follow-up: the pendant's own directory move (7ea7b39b8, "move the
// pendant out of tools/ and into pendant/") left THEME_FILE in
// pendant/server.mjs pointed one directory too high, so every remote-pendant
// page load 404'd on its shared theme stylesheet and rendered as unstyled
// black-on-white HTML. This drives the real pendant/server.mjs over HTTP -
// the same server the product spawns for the phone pairing link - so a
// regression in that path fails here instead of only in Operator's browser.

const projectRoot = resolve(import.meta.dirname, '../../..')
const serverPath = resolve(projectRoot, 'pendant/server.mjs')

let child: ChildProcessByStdio<null, Readable, Readable>
let port: number

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const found = typeof address === 'object' && address ? address.port : null
      probe.close(() => {
        if (found) resolvePort(found)
        else rejectPort(new Error('Could not determine a free port.'))
      })
    })
  })
}

beforeAll(async () => {
  port = await getFreePort()
  child = spawn(process.execPath, [serverPath, '--port', String(port)], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('Pendant simulator did not start.')), 5000)
    child.stdout.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes('LIVE')) return
      clearTimeout(timer)
      resolveReady()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`Pendant simulator exited early (${code}).`))
    })
  })
}, 10_000)

afterAll(async () => {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolveExit) => {
    child.once('exit', resolveExit)
    setTimeout(resolveExit, 2000)
  })
})

describe('the pendant server\'s served page can actually be styled', () => {
  it('serves the shared LienCAM theme stylesheet the pendant page @imports, as real CSS', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/src/theme/tokens.css`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/css/)

    const body = await response.text()
    expect(body.length).toBeGreaterThan(1000)
    expect(body).toMatch(/:root/)
  })

  it('serves the pendant page and its own stylesheet at the paths the page references', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/?pair=1234567890abcdef`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)

    const appCss = await fetch(`http://127.0.0.1:${port}/app.css`)
    expect(appCss.status).toBe(200)
    expect(appCss.headers.get('content-type')).toMatch(/text\/css/)
    expect((await appCss.text()).length).toBeGreaterThan(0)
  })
})
