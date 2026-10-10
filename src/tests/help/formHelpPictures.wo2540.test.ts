// WO-2540: the eight Form Help pictures were re-shot after WO-2504 hid "Pull to body".
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { measurePixels } from '../../../tools/capture/help/compare.mjs'

const WO_2504_COMMIT = '3b45548a6'
const SLOTS = ['display', 'edit-form', 'form-overview', 'openings', 'select', 'start-from', 'symmetry', 'topology']
const EVIDENCE = 'src/tests/evidence/WO-2540'
const provenance = JSON.parse(fs.readFileSync(`${EVIDENCE}/provenance.json`, 'utf8'))

describe('WO-2540 Form help pictures are current', () => {
  it('was captured from a commit at or after WO-2504', () => {
    expect(() => execFileSync('git', ['merge-base', '--is-ancestor', WO_2504_COMMIT, provenance.sourceCommit], { stdio: 'pipe' })).not.toThrow()
  })

  it('records exactly the eight Form pictures', () => {
    expect(provenance.pictures.map((p: { slot: string }) => p.slot).sort()).toEqual(SLOTS)
  })

  it.each(SLOTS)('%s on disk is the recorded capture, whole 1920x1080 frame, and differs from the old picture', async (slot) => {
    const file = `public/help/form-workspace/${slot}.webp`
    const rec = provenance.pictures.find((p: { slot: string }) => p.slot === slot)
    expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(rec.sha256)
    const raw = async (f: string) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const now = await raw(file), before = await raw(`${EVIDENCE}/before/${slot}.webp`)
    expect([now.info.width, now.info.height]).toEqual([1920, 1080])
    expect(before.info.width).toBe(now.info.width)
    expect(measurePixels(before.data, now.data).changedPixels).toBeGreaterThan(0)
  })
})
