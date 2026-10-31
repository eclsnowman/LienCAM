// Capture a pinned source export without changing this worktree's product or
// creating another dependency junction. Modules resolve through the ancestors.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const release = 'ffe55d095810e310d5d25e8eca8cdc1d1200dab6'
export async function withFrozenV02Server(run) {
  const destination = path.join(root, 'tools/capture/clips-v2/.alpha3-source')
  if (existsSync(path.join(destination, 'node_modules'))) throw new Error('Capture export must never contain node_modules')
  const children = execFileSync('git', ['ls-tree', '--name-only', release + ':src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(x => x !== 'tests').map(x => 'src/' + x)
  const archive = execFileSync('git', ['archive', '--format=tar', release, ...children, 'src/tests/ui/support', 'public', 'brand/liencam-wordmark.svg', 'index.html', 'package.json', 'examples/01-fixture-plate'], { cwd: root, maxBuffer: 128 * 1024 * 1024 })
  mkdirSync(destination, { recursive: true })
  const tar = path.join(destination, 'source.tar')
  writeFileSync(tar, archive)
  execFileSync('C:/Windows/System32/tar.exe', ['-xf', tar, '-C', destination])
  const source = { commit: release, workingTreeDirty: false, exportArchiveSha256: createHash('sha256').update(archive).digest('hex'), method: 'git archive of current main production src, public, entry, package and supplied fixture plus dev overlay runtime support; no test suites or dependency links', root: path.relative(root, destination) }
  const server = await createServer({
    configFile: false, root: destination, plugins: [react(), {
      name: 'v02-cross-drive-wasm',
      configureServer(server) {
        const dependencies = realpathSync(path.join(root, 'node_modules')).replaceAll('\\', '/')
        const prefix = '/@fs/' + dependencies + '/'
        server.middlewares.use((req, res, next) => {
          const url = decodeURIComponent((req.url || '').split('?')[0])
          if (!(req.url || '').includes('?') && url.toLowerCase().startsWith(prefix.toLowerCase()) && url.endsWith('.wasm')) {
            const file = path.resolve(dependencies, url.slice(prefix.length))
            if (file.toLowerCase().startsWith(path.resolve(dependencies).toLowerCase() + path.sep) && existsSync(file)) {
              res.setHeader('Content-Type', 'application/wasm'); res.end(readFileSync(file)); return
            }
          }
          next()
        })
      },
    }],
    cacheDir: path.join(destination, '.vite-cache'),
    define: { __APP_GIT_COMMIT__: JSON.stringify(release), __APP_GIT_BRANCH__: JSON.stringify('main'), __APP_BUILD_DATE__: JSON.stringify('2026-10-28') },
    server: { host: '127.0.0.1', port: 2572, strictPort: true, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] }, watch: { ignored: ['**/src/tests/**', '**/.git/**'] } },
    optimizeDeps: { entries: ['index.html'], include: ['three'], exclude: ['occt-wasm', '@salusoft89/planegcs', 'clipper2-wasm'] },
  })
  try { await server.listen(); return await run({ baseUrl: 'http://127.0.0.1:2572/', source }) }
  finally { await server.close() }
}
