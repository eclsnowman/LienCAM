// WO-2911 grant condition (architect 10-17 12:20 PM CT): moving Save's project
// assembly into assembleProjectFile is a pure extraction, so Save writes the
// same bytes as before. This test prints the SHA-256 of what Save writes for
// two shipped examples (fixed clock); the evidence file runs it against main's
// src/store/index.ts and this branch's and compares the printed hashes. On
// this branch it also checks the report's Current project is those same bytes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const saved = vi.hoisted(() => [] as string[])
vi.mock('../../lib/saveFile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/saveFile')>()
  return typedMock<typeof import('../../lib/saveFile')>({
    ...real,
    saveFile: async (_name: string, contents: string | Blob) => { saved.push(typeof contents === 'string' ? contents : await contents.text()); return 'saved.camproject' },
  })
})

vi.useFakeTimers({ toFake: ['Date'] })
vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
// Opening a project mints library ids: a counter instead, so two runs compare.
let minted = 0
vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`)
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const store = await import('../../store')
const { useCamStore } = store
const ROOT = path.resolve(__dirname, '../../..')
const EXAMPLES = ['Adaptive Clearing Shapes.camproject', 'Corner Helix Bar.camproject']
  .map((name) => path.join(ROOT, 'Example Projects', name))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('WO-2911 Save writes the same bytes after the extraction', () => {
  it('both shipped examples are present (a missing one would compare nothing)', () => {
    for (const file of EXAMPLES) expect(fs.existsSync(file), file).toBe(true)
  })

  it.each(EXAMPLES)('Save of %s', async (file) => {
    saved.length = 0
    await useCamStore.getState().loadProjectFromFile(fs.readFileSync(file, 'utf8'))
    expect(await useCamStore.getState().packageProjectToFile()).toBe('saved')
    expect(saved).toHaveLength(1)
    if (process.env.WO2911_DUMP) fs.writeFileSync(path.join(process.env.WO2911_DUMP, path.basename(file)), saved[0])
    console.log(`SAVE-SHA256 ${path.basename(file)} ${sha(saved[0])}`)
    const snapshot = (store as { snapshotCurrentProjectFile?: () => Promise<string | null> }).snapshotCurrentProjectFile
    if (snapshot) expect(await snapshot()).toBe(saved[0])
  }, 120_000)
})
