// WO-2626: the three BLOCKS rows of the WO-2624 stranger read
// (src/tests/evidence/WO-2624/DOCS-READ.md F01-F03) and the commercial-name
// row (F81), pinned against the source truth each row cites rather than
// against fixed prose, so a later change to that truth fails here too.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { topics as machineTopics } from '../../help/topics/machine'
import { topics as postingTopics } from '../../help/topics/posting-gcode'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n')
const prose = (topic: { sections: Array<{ kind: string; text?: string; steps?: string[] }> }) =>
  topic.sections.flatMap(s => s.text !== undefined ? [s.text] : s.steps ?? []).join(' ')

describe('WO-2626 stranger-read BLOCKS stay fixed', () => {
  it('F01: the kernel build page does not promise the Dockerfile rebuilds the shipped kernel', () => {
    const page = read('docs/wiki/Geometry-Kernel-Build.md')
    const applied = [...read('Dockerfile').matchAll(/patch -p1[^<\n]*<\s*\/liencam-patches\/(\S+\.patch)/g)].map(m => m[1])
    const shipped = readdirSync(join(root, 'patches')).filter(name => name.endsWith('.patch'))
    const pinned = /"occt-wasm":\s*"file:vendor\/occt-wasm\/([^"]+)"/.exec(read('package.json'))![1]
    expect(applied.length).toBeGreaterThan(0)
    if (applied.length < shipped.length) {
      // The recipe is short of the shipped kernel: the page must say so and name what ships.
      expect(page).not.toMatch(/applies the patches, regenerates/)
      expect(page).toContain('does not yet build the kernel we ship')
      expect(page).toContain(pinned)
      for (const name of applied) expect(page).toContain(name)
    }
    // How to get the package out of the image.
    expect(page).toContain('npm pack')
    expect(page).toContain('docker cp')
  })

  it('F02: the Linux page names the AppImage the way electron-builder writes it', () => {
    const require = createRequire(import.meta.url)
    const { Arch, getArtifactArchName } = require(join(root, 'node_modules/builder-util/out/arch.js'))
    const template = /^artifactName:\s*"([^"]+)"/m.exec(read('electron-builder.yml'))![1]
    const name = (ext: string) => template.replace('${productName}', 'LienCAM').replace('${version}', '<version>')
      .replace('${os}', 'linux').replace('${arch}', getArtifactArchName(Arch.x64, ext)).replace('${ext}', ext)
    const page = read('docs/wiki/Install-on-Linux.md')
    expect(name('AppImage')).toBe('LienCAM-<version>-linux-x86_64.AppImage')
    expect(page).toContain(name('AppImage'))
    expect(page).toContain(name('tar.gz'))
    expect(page).toContain('chmod +x LienCAM-*-linux-x86_64.AppImage')
    expect(page).toContain('./LienCAM-*-linux-x86_64.AppImage')
    expect(page).not.toContain('linux-x64.AppImage')
  })

  it('F03: Help and the wiki say Start probing moves at once, with no tick box on the Probing tab', () => {
    // The truth: the Probing screen has no path-clear tick (WO-2063).
    expect(read('src/components/machine/ProbingPanel.tsx')).toMatch(/const pathClearConfirmed = true/)
    const topic = machineTopics.find(t => t.id === 'probing-tab')!
    const help = prose(topic)
    const wiki = read('docs/wiki/Probing.md').split('<a id="probe-routines"></a>')[0]
    for (const text of [help, wiki]) {
      expect(text).not.toMatch(/tick that the path is clear/)
      expect(text).toContain('press Start probing - it moves straight away, with no further confirmation')
      expect(text).not.toMatch(/Feature setup|Guided automatic cycle|Manual touches|Live probe path/)
    }
  })

  it('F81: the post Help and its wiki page name no commercial CAM product other than Fusion', () => {
    const forbidden = /\b(?:Vectric|Estlcam|HSM|SheetCAM|Mastercam|Autodesk|Fusion 360)\b/
    const topic = postingTopics.find(t => t.id === 'post-basics')!
    expect(prose(topic)).not.toMatch(forbidden)
    expect(read('docs/wiki/Post-Process.md')).not.toMatch(forbidden)
    expect(prose(topic)).toContain('post files from other CAM programs (.pp, Fusion .cps, .scpost, .pst)')
  })
})
