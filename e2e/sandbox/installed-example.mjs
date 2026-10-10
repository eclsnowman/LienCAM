// Serialized by Playwright into Electron's main-process context. That context
// exposes process but not the CommonJS module-local require function.
export function packagedStarterExample({ app }) {
  const fs = process.getBuiltinModule('fs')
  const path = process.getBuiltinModule('path')
  const crypto = process.getBuiltinModule('crypto')
  const assets = path.join(app.getAppPath(), 'dist/assets')
  const files = fs.readdirSync(assets).filter(name => /^fixture-plate-.*\.camproject$/.test(name))
  if (files.length !== 1) throw new Error(`Installed package contains ${files.length} fixture plate examples`)
  const contents = fs.readFileSync(path.join(assets, files[0]), 'utf8')
  return { name: files[0], contents, sha256: crypto.createHash('sha256').update(contents).digest('hex') }
}
