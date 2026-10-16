import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
// The measured score is independent of PNG/WebP encoding.
import { measurePixels, CHANNEL_THRESHOLD, AREA_THRESHOLD } from '../../../tools/capture/help/compare.mjs'

const root = process.cwd()
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/help/capture-manifest.json'), 'utf8'))
const run = JSON.parse(fs.readFileSync(path.join(root, 'src/tests/evidence/WO-2491/run.json'), 'utf8'))
// Later additions/replacements retain their own capture records. WO-2755
// replaced one WO-2709 image and adopted three historical accepted images.
const inherited = manifest.images.filter((e: any) => e.captureRecord?.order === 'WO-2709')
const added = manifest.images.filter((e: any) => e.captureRecord?.order === 'WO-2710')
const controls = manifest.images.filter((e: any) => e.captureRecord?.order === 'WO-2714')
const adopted = manifest.images.filter((e: any) => e.captureRecord?.order === 'WO-2755')
const later = [...inherited, ...added, ...controls, ...adopted]
const refreshed = manifest.images.filter((e: any) => !['WO-2709', 'WO-2710', 'WO-2714', 'WO-2755'].includes(e.captureRecord?.order))

describe('WO-2491 whole-frame Help refresh', () => {
  it('measures changes at both edges of the entire raster', () => {
    const before = Buffer.alloc(300)
    const after = Buffer.from(before)
    after[0] = 255
    after[299] = 255
    const result = measurePixels(before, after)
    expect(result.changedPixels).toBe(2)
    expect(result.changedFraction).toBe(0.02)
    expect(result.changedFraction).toBeGreaterThan(AREA_THRESHOLD)
  })
  it('ignores low channel noise without masking any region', () => {
    const result = measurePixels(Buffer.alloc(300), Buffer.alloc(300, CHANNEL_THRESHOLD))
    expect(result.changedPixels).toBe(0)
    expect(result.meanAbsoluteDifference).toBe(CHANNEL_THRESHOLD)
  })
  it('rejects mismatched comparison buffers', () => {
    expect(() => measurePixels(Buffer.alloc(3), Buffer.alloc(6))).toThrow('Mismatched')
  })
  it('accounts for exactly 119 refreshed + 1 WO-2709 + 10 WO-2710 + 10 WO-2714 + 4 WO-2755 unique manifest pictures and keeps every file present', () => {
    expect(refreshed).toHaveLength(119)
    expect(inherited).toHaveLength(1)
    expect(added).toHaveLength(10)
    expect(controls).toHaveLength(10)
    expect(adopted).toHaveLength(4)
    expect(new Set(manifest.images.map((e: any) => e.path + e.slot)).size).toBe(144)
    for (const e of manifest.images) expect(fs.statSync(path.join(root, e.path, e.slot + '.webp')).size).toBeGreaterThan(0)
  })
  it('keeps each later picture byte-identical to its own provenance record', () => {
    for (const e of later) {
      const record = e.captureRecord
      expect(record.status).toBe('captured')
      expect(record.approval).toContain(record.order)
      // Reuse receipts lacking exact capture times must say so, rather than
      // inventing a new timestamp. The adoption test below pins those receipts.
      if (record.captureKind === 'accepted-evidence-reuse' && record.capturedAt === null) {
        expect(record.captureTimeEvidence.length).toBeGreaterThan(0)
      } else expect(Number.isFinite(Date.parse(record.capturedAt))).toBe(true)
      expect(record.sourceCommit).toMatch(/^[a-f0-9]{40}$/)
      expect(record.sourceHash).toMatch(/^[a-f0-9]{64}$/)
      expect(record.viewport).toEqual(record.captureKind === 'accepted-evidence-reuse' ? record.afterDimensions : [1920, 1080])
      expect(record.appState.length).toBeGreaterThan(0)
      expect(record.file).toBe(path.posix.join(e.path, e.slot + '.webp'))
      expect(fs.statSync(path.join(root, record.candidate)).size).toBeGreaterThan(0)
      const bytes = fs.readFileSync(path.join(root, record.file))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256)
    }
  })
  it('pins all four WO-2755 adoptions to original source receipts and exact decoded pixels', async () => {
    const { default: sharp } = await import('sharp')
    const adoption = JSON.parse(fs.readFileSync('src/tests/evidence/WO-2755/IMAGE-ADOPTION.json', 'utf8'))
    const probing = JSON.parse(fs.readFileSync('src/tests/evidence/WO-2755/PROBING-IMAGE-ADOPTION.json', 'utf8'))
    expect(adopted.map((e: any) => `${e.topic}/${e.slot}`).sort()).toEqual([
      'form-workspace/rotate-axis', 'creating-operations/run-macro-properties',
      'sketch-modify-tools/edit-pattern', 'probing-tab/probing-outside-corner',
    ].sort())
    for (const e of adopted) {
      const record = e.captureRecord
      const image = adoption.images.find((a: any) => a.topic === e.topic && a.slot === e.slot)
      const receipt = JSON.parse(fs.readFileSync(record.provenance, 'utf8'))
      const provenance = e.topic === 'form-workspace' ? receipt.shots['centre-y-before.png']
        : e.topic === 'creating-operations' ? receipt.source
        : e.topic === 'sketch-modify-tools' ? receipt.shots['model-edit-four-circle-pattern.png'].sourceProvenance
        : receipt.shot.sourceProvenance
      expect(record.sourceProvenance).toEqual(provenance)
      expect(record.sourceCommit).toBe(provenance.commit)
      expect(record.sourceHash).toBe(provenance.sourceHash)
      expect(record.candidate).toBe(image?.src ?? probing.originalPng)
      expect(record.sha256).toBe(image?.outputSha256 ?? probing.newPublicSha256)
      const original = fs.readFileSync(record.candidate)
      expect(createHash('sha256').update(original).digest('hex')).toBe(image?.originalSha256 ?? probing.originalSha256)
      const metadata = await sharp(original).metadata()
      expect(record.viewport).toEqual([metadata.width, metadata.height])
      const decoded = await sharp(record.file).ensureAlpha().raw().toBuffer()
      expect(decoded.equals(await sharp(original).ensureAlpha().raw().toBuffer())).toBe(true)
      expect(fs.readFileSync(`docs/wiki/images/${e.topic}/${e.slot}.webp`).equals(fs.readFileSync(record.file))).toBe(true)
      if (image) {
        expect(record.captureKind).toBe('accepted-evidence-reuse')
        expect(record.reusedAtSourceCommit).toBe(adoption.reviewedHead)
        expect(record.provenance).toBe(image.receipt)
        expect(record.appState).toBe(image.subject)
        if (e.topic === 'form-workspace') {
          const measurements = JSON.parse(fs.readFileSync(record.captureTimeEvidence, 'utf8'))
          expect(record.capturedAt).toBe(measurements.files.find((f: any) => f.name === 'centre-y-before.png').modifiedAt)
        } else expect(record.capturedAt).toBeNull()
      } else {
        expect(record.captureKind).toBe('fresh')
        expect(record.capturedAt).toBe(receipt.ended)
        expect(record.viewport).toEqual(probing.viewport)
      }
    }
  })
  it('publishes exactly the ten accepted WO-2714 candidates without resizing or provenance drift', async () => {
    const { default: sharp } = await import('sharp')
    const names = controls.map((e: any) => path.basename(e.captureRecord.candidate, '.png')).sort()
    expect(names).toEqual([
      'C-2-uccnc-controller', 'C-4-offsets-typed', 'C-6a-m6-tool-change',
      'G03-routine-chooser', 'G05a-z-surface-setup', 'G06-tools-setter',
      'G06-tools-setter-apply', 'G07a-calibrate-plan',
      'G11-simulated-part', 'G11-simulated-part-full',
    ].sort())
    for (const e of controls) {
      const record = e.captureRecord
      const sidecar = JSON.parse(fs.readFileSync(record.candidate.replace(/\.png$/, '.json'), 'utf8'))
      for (const key of ['capturedAt', 'sourceCommit', 'sourceHash', 'sourceTreeDirty',
        'sourceScope', 'buildId', 'route', 'viewport', 'appState', 'crop', 'wholeFrame']) {
        expect(record[key], `${e.topic}/${e.slot} ${key}`).toEqual(sidecar[key])
      }
      for (const file of record.sourceFiles) expect(fs.existsSync(file), file).toBe(true)
      const expected = await sharp(record.candidate).webp({ quality: 88 }).toBuffer()
      expect(createHash('sha256').update(expected).digest('hex')).toBe(record.sha256)
      expect(fs.readFileSync(`docs/wiki/images/${e.topic}/${e.slot}.webp`)).toEqual(expected)
    }
  })
  it('records a successful capture from this run for every manifest picture', () => {
    const missing = refreshed.filter((e: any) => e.captureRecord?.status !== 'captured' || !Number.isFinite(Date.parse(e.captureRecord.capturedAt)) || Date.parse(e.captureRecord.capturedAt) < Date.parse(run.startedAt))
    expect(missing.map((e: any) => e.topic + '/' + e.slot)).toEqual([])
    for (const e of refreshed) {
      expect(e.captureRecord.viewport).toEqual([1920, 1080])
      expect(e.captureRecord.sourceCommit).toBe(run.sourceCommit)
      expect(e.captureRecord.approval).toBe('reviewed: whole-frame QA, WO-2491')
      expect(e.captureRecord.changedFraction).toBeGreaterThanOrEqual(0)
    }
  })
  it('retains the exact scored capture for each picture, including unchanged pictures', () => {
    for (const e of refreshed) {
      const record = e.captureRecord
      const bytes = fs.readFileSync(path.join(root, record.after))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256)
      expect(fs.statSync(path.join(root, record.difference)).size).toBeGreaterThan(0)
    }
  })
})
