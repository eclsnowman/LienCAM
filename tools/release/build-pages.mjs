import { isMain } from '../lib/is-main.mjs';
import { mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadConfigFromFile } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function buildPages({ outDir = join(root, 'dist-pages') } = {}) {
  outDir = resolve(outDir)
  mkdirSync(outDir, { recursive: true })
  // A fresh output also keeps stale desktop/pendant artifacts out of the upload.
  // The CI checkout is fresh; local callers can pass --outDir with a temp path.
  if (readdirSync(outDir).length) throw new Error(`Pages output must be empty: ${outDir}`)
  const load = async filename => {
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(root, filename))
    if (!loaded) throw new Error(`Cannot load ${filename}`)
    return loaded.config
  }
  const app = await load('vite.config.mts')
  await build({
    ...app, root, configFile: false, base: './',
    // Pages always ships the browser demo; keep this local to its app build so
    // desktop, ordinary builds and subsequent callers retain their own flags.
    define: { ...app.define, 'import.meta.env.VITE_DEMO_BUILD': JSON.stringify('true') },
    build: {
      ...app.build, outDir: join(outDir, 'app'), emptyOutDir: true,
      // Replace (rather than merge) the desktop's multi-entry map. The pendant
      // and Electron evidence page are not browser-demo entry points.
      rollupOptions: { ...app.build?.rollupOptions, input: { app: join(root, 'index.html') } },
    },
  })
  const site = await load('vite.site.config.mts')
  await build({
    ...site, configFile: false,
    // The site must preserve the app built first into its sibling directory.
    build: { ...site.build, outDir, emptyOutDir: false },
  })
  const visit = directory => readdirSync(directory, { withFileTypes: true }).forEach(entry => {
    if (entry.name.toLowerCase() === 'pendant') throw new Error('Pages output contains a pendant folder')
    if (entry.isDirectory()) visit(join(directory, entry.name))
  })
  visit(outDir)
  return outDir
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--outDir')) throw new Error('Usage: build-pages.mjs [--outDir <empty directory>]')
  await buildPages(args.length ? { outDir: args[1] } : undefined)
}
