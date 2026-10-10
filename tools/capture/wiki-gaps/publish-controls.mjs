// WO-2714: integrate only the ten architect-accepted production candidates.
// Original PNGs and sidecars stay immutable; publish at native size, WebP q88.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

export const accepted = [
  ['C-2-uccnc-controller', 'machine-definition-catalog', 'uccnc-controller'],
  ['C-4-offsets-typed', 'control-jog-zero', 'offsets-typed'],
  ['C-6a-m6-tool-change', 'control-run-job', 'm6-tool-change'],
  ['G03-routine-chooser', 'probing-tab', 'routine-chooser'],
  ['G05a-z-surface-setup', 'probing-tab', 'z-surface-setup'],
  ['G07a-calibrate-plan', 'probing-tab', 'calibrate-plan'],
  ['G06-tools-setter', 'control-tool-setter', 'tools-setter'],
  ['G06-tools-setter-apply', 'control-tool-setter', 'tools-setter-apply'],
  ['G11-simulated-part', 'control-simulator', 'simulated-part'],
  ['G11-simulated-part-full', 'control-simulator', 'simulated-part-full'],
]

const manifestPath = 'public/help/capture-manifest.json'
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const surroundings = ['top-toolbar', 'mode-tab-strip', 'control-machine-panel',
  'control-dro', 'control-safety-bar', 'control-console', 'console', 'status-bar']
const sourceFiles = {
  'C-2': ['src/components/machine/MachineDefinitionPanel.tsx', 'src/components/machine/definition/ControllerDefinitionSection.tsx'],
  'C-4': ['src/components/machine/OffsetsPanel.tsx'],
  'C-6': ['src/components/machine/ControlPage.tsx', 'src/components/machine/ProgramPanel.tsx'],
  G03: ['src/components/machine/ProbingPanel.tsx', 'src/components/machine/probing/ProbeStepPicture.tsx'],
  G05: ['src/components/machine/ProbingPanel.tsx', 'src/components/machine/probing/ProbingScreen.tsx'],
  G06: ['src/components/machine/ToolsProbePanel.tsx'],
  G07: ['src/components/machine/ProbingPanel.tsx', 'src/components/machine/probing/ProbeStepPicture.tsx'],
  G11: ['src/components/machine/SimulatedPartPanel.tsx'],
}

for (const [name, topic, slot] of accepted) {
  const candidate = `src/tests/evidence/WO-2714/candidates/${name}.png`
  const sidecar = JSON.parse(fs.readFileSync(candidate.replace(/\.png$/, '.json'), 'utf8'))
  const file = `public/help/${topic}/${slot}.webp`
  assert.equal(sidecar.picture, name + '.png')
  assert.equal(sidecar.bytes, fs.statSync(candidate).size)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const bytes = await sharp(candidate).webp({ quality: 88 }).toBuffer()
  fs.writeFileSync(file, bytes)
  const entry = {
    topic, slot, path: `public/help/${topic}/`, subject: sidecar.appState,
    surroundings: name === 'G03-routine-chooser' ? ['control-machine-panel'] : surroundings,
    generator: 'scripted', generatorCmd: sidecar.route, locked: false,
    reviewNotes: 'WO-2714: architect whole-frame acceptance 2026-10-09 6:41 PM CT; original production candidate converted at native size, WebP q88. No new hardware claim.',
    captureRecord: {
      ...sidecar, order: 'WO-2714', topic, slot, file, status: 'captured', candidate,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      approval: 'reviewed: architect whole-frame acceptance 2026-10-09 6:41 PM CT, WO-2714',
      sourceFiles: sourceFiles[sidecar.gap],
    },
  }
  const index = manifest.images.findIndex(e => e.topic === topic && e.slot === slot)
  if (index < 0) manifest.images.push(entry)
  else {
    assert.equal(manifest.images[index].captureRecord?.order, 'WO-2714')
    manifest.images[index] = entry
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('Published 10 WO-2714 pictures; manifest total ' + manifest.images.length)
