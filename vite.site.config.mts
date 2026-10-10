import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const repository = 'https://github.com/eclsnowman/LienCAM'
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const sceneTasks: Record<string, string> = {
  'pipeline-sketch': 'Sketching soft jaws',
  'pipeline-model': 'Modeling soft jaws',
  'pipeline-toolpath': 'Generating fixture-plate toolpaths',
  'pipeline-simulate': 'Simulating fixture-plate stock removal',
  'pipeline-post': 'Posting fixture-plate G-code',
  'pipeline-control': 'Running a fixture-plate program in Control',
  form: 'Shaping a lobed knob', relief: 'Creating a relief from an image',
  '3d-finish': 'Finishing a knob with 3D toolpaths', 'setup-vise': 'Setting up soft jaws in a vise',
  probing: 'Previewing an inside-corner probing routine', 'tool-library': 'Choosing tools from the tool library',
  'machine-definition': 'Configuring a machine', 'light-theme': 'Viewing fixture-plate toolpaths in the light theme',
  'demo-first-open': 'Opening the browser demo',
}
const scenes = JSON.parse(readFileSync(join(projectRoot, 'tools/capture/scenes.json'), 'utf8')).scenes as Array<{ id: string; name: string }>
const sceneAlt = new Map(scenes.map(scene => [scene.id, sceneTasks[scene.name]]))

export function createSiteConfig(options: { strict?: boolean; siteRoot?: string; mediaRoot?: string } = {}) {
  const root = options.siteRoot ?? join(projectRoot, 'site')
  const mediaRoot = options.mediaRoot ?? join(projectRoot, 'docs/media')
  const pages = readdirSync(root).filter(name => name.endsWith('.html')).sort()
  const version = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version as string
  // These destinations remain useful before the sibling page orders land.
  // Once a page exists, every use of the route switches to the local page.
  const routes: Record<string, string> = {
    home: 'index.html', features: `${repository}/wiki`, machines: `${repository}/wiki/Set-Up-Your-Machine`,
    download: `${repository}/releases`, docs: `${repository}/wiki`, community: `${repository}/discussions`,
    github: repository, about: `${repository}#why-i-built-this`, credits: `${repository}/blob/main/CREDITS.md`,
    licence: `${repository}/blob/main/LICENSE`, bug: `${repository}/issues/new?template=bug_report.yml`,
    demo: 'https://eclsnowman.github.io/LienCAM/app/',
  }
  const pictures = new Map<string, string | undefined>()
  let base = '/LienCAM/'
  const findPicture = (id: string) => ['webp', 'png', 'jpg', 'jpeg'].map(ext => join(mediaRoot, `${id}.${ext}`)).find(existsSync)
  const frame: Plugin = {
    name: 'liencam-static-site',
    configResolved(config) { base = config.base },
    buildStart() {
      pictures.clear()
      for (const page of pages) {
        for (const match of readFileSync(join(root, page), 'utf8').matchAll(/\{\{scene:(S\d{2})\}\}/g)) {
          pictures.set(match[1], findPicture(match[1]))
        }
      }
      const pending = [...pictures].filter(([, path]) => !path).map(([id]) => id).sort()
      if (pending.length) {
        const message = `Pending site pictures: ${pending.join(', ')}`
        if (options.strict) this.error(message)
        this.warn(message)
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        html = html.replace(/<!-- partial:(header|footer) -->/g, (_, name: string) => readFileSync(join(root, 'partials', `${name}.html`), 'utf8'))
        const pageName = relative(root, context.filename).replaceAll('\\', '/')
        return html.replace(/\{\{route:(\w+)\}\}/g, (_, name: string) => {
          const local = `${name}.html`
          const destination = name === 'home' ? `${base}index.html` : pages.includes(local) ? `${base}${local}` : routes[name]
          if (!destination) throw new Error(`Unknown site route: ${name}`)
          return escapeHtml(destination)
        }).replaceAll('{{version}}', escapeHtml(version)).replaceAll('{{page}}', escapeHtml(pageName))
      },
    },
    generateBundle() {
      for (const [id, path] of pictures) {
        if (path) this.emitFile({ type: 'asset', fileName: `media/${id}${path.slice(path.lastIndexOf('.'))}`, source: readFileSync(path) })
      }
      if ([...pictures.values()].some(path => !path)) {
        this.emitFile({ type: 'asset', fileName: 'media/pending.svg', source: readFileSync(join(root, 'media/pending.svg')) })
      }
      const photo = findPicture('P02')
      if (photo) this.emitFile({ type: 'asset', fileName: `media/P02${photo.slice(photo.lastIndexOf('.'))}`, source: readFileSync(photo) })
      this.emitFile({ type: 'asset', fileName: 'pending-pictures.json', source: JSON.stringify([...pictures].filter(([, path]) => !path).map(([id]) => id).sort(), null, 2) + '\n' })
    },
  }
  const sceneHtml: Plugin = {
    name: 'liencam-site-pictures',
    transformIndexHtml: {
      // Insert emitted URLs after Vite's asset pass; source pages never depend
      // on missing files and real scene bytes are copied without alteration.
      order: 'post',
      handler(html) {
        html = html.replace(/\{\{scene:(S\d{2})\}\}/g, (_, id: string) => {
          const path = pictures.get(id) ?? findPicture(id)
          const file = path ? `media/${id}${path.slice(path.lastIndexOf('.'))}` : 'media/pending.svg'
          const alt = path ? sceneAlt.get(id) : 'Screenshot coming soon'
          if (alt === undefined) throw new Error(`Missing site description for scene: ${id}`)
          return `<img src="${base}${file}" alt="${escapeHtml(alt)}" width="480" height="300" loading="lazy">`
        })
        const photo = findPicture('P02')
        return html.replaceAll('{{part-photo}}', photo ? `<figure class="part-photo"><img src="${base}media/P02${photo.slice(photo.lastIndexOf('.'))}" alt="Finished parts cut on a real machine with LienCAM G-code" loading="lazy"><figcaption>Made on a real machine with LienCAM G-code.</figcaption></figure>` : '')
      },
    },
  }
  return defineConfig({
    root, base: '/LienCAM/', publicDir: false,
    cacheDir: join(projectRoot, '.vite-cache/site'),
    plugins: [frame, sceneHtml],
    build: { outDir: join(projectRoot, 'dist-site'), emptyOutDir: true, assetsInlineLimit: 0,
      rollupOptions: { input: pages.map(page => join(root, page)), output: {
        assetFileNames: asset => asset.names.some(name => ['mark.svg', 'wordmark.svg', 'favicon.svg'].includes(name))
          ? 'media/[name][extname]' : 'assets/[name]-[hash][extname]',
      } } },
  })
}

const config = createSiteConfig({ strict: process.argv.includes('--strict') })
export default config

// Vite's CLI does not accept --strict. The package script uses this small
// entry point, while `vite build --config vite.site.config.mts` works as usual.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--strict') continue
    if (arg === '--outDir' && args[index + 1]) config.build!.outDir = resolve(args[++index])
    else if (arg === '--base' && args[index + 1]) config.base = args[++index]
    else throw new Error(`Unknown site build argument: ${arg}`)
  }
  await build({ ...config, configFile: false })
}
