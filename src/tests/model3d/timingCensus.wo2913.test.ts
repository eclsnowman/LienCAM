// Browser census through the real Model page, synchronous solver, Comlink
// worker, preview adapters and production fullResync. No mocked geometry.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WO-2913 production Model timing census', () => {
  it('captures three successful runs per workload and phase without changing product behavior', async () => {
    const record = process.env.WO2913_RECORD === '1'
    const output = record ? (process.env.WO2913_OUTPUT ?? 'src/tests/evidence/WO-2913') : mkdtempSync(join(tmpdir(), 'liencam-wo2913-'))
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['src/tests/evidence/WO-2913/census.mjs'], {
          cwd: process.cwd(), stdio: 'inherit', timeout: 480_000, env: { ...process.env, WO2913_OUTPUT: output },
        })
        child.on('error', reject)
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Browser census exited ${code}`)))
      })
      const census = JSON.parse(readFileSync(join(output, 'census.json'), 'utf8'))
      expect(census.instrumented).toHaveLength(5)
      for (const part of ['tiny', 'medium', 'real']) {
        for (const action of ['sketch-edit-finish', 'model-recalculate', 'preview-6', 'preview-7']) {
          const rows = census.rows.filter((row: { part: string; action: string }) => row.part === part && row.action === action)
          expect(rows.map((row: { run: number }) => row.run)).toEqual([1, 2, 3])
          for (const row of rows) {
            expect(row.wallMs).toBeGreaterThan(0)
            const body = row.witness.find((node: { id: string }) => node.id === 'F1')
            expect(body).toMatchObject({ status: 'ok', scene: true })
            // Independent analytic volume: a 40x24 plate, with 21 r1 through
            // holes in the medium case. Read from the production worker.
            expect(body.volume).toBeCloseTo((40 * 24 - (part === 'medium' ? 21 * Math.PI : 0)) * 5, 5)
            expect(row.sketch.solved).not.toBeNull()
            const events = census.events.filter((event: { part: string; start: number; end: number }) => event.part === part && event.start >= row.start && event.end <= row.end)
            expect(events.some((event: { method: string }) => event.method === 'makeExtrude')).toBe(true)
            if (process.env.WO2927_EXPECT_REUSE === '1' && part === 'real' && action === 'model-recalculate') {
              expect(events.filter((event: { phase: string }) => event.phase === 'step-parser')).toHaveLength(0)
            }
            if (action.startsWith('preview-')) expect(events.some((event: { phase: string; status: string }) => event.phase === 'preview' && event.status === 'ready')).toBe(true)
            expect(row.witness.filter((node: { status: string }) => ['failed', 'degraded', 'running'].includes(node.status))).toEqual([])
            if (part === 'real') expect(row.witness.find((node: { id: string }) => node.id === 'IMP1')).toMatchObject({ status: 'ok', scene: true })
          }
        }
        for (const phase of ['solver', 'dag', 'geometry-worker', 'mesh-worker', 'mesh-ingest', 'preview']) {
          expect(census.events.some((event: { part: string; phase: string }) => event.part === part && event.phase === phase)).toBe(true)
        }
      }
      for (const part of ['tiny', 'medium', 'real']) {
        const edits = census.rows.filter((row: { part: string; action: string }) => row.part === part && row.action === 'sketch-edit-finish')
        expect(new Set(edits.map((row: { witness: { id: string; hash: string }[] }) => row.witness.find(node => node.id === 'F1')?.hash)).size).toBe(3)
        const recalculations = census.rows.filter((row: { part: string; action: string }) => row.part === part && row.action === 'model-recalculate')
        for (let i = 0; i < 3; i++) expect(recalculations[i].witness.find((node: { id: string }) => node.id === 'F1').hash).toBe(edits[i].witness.find((node: { id: string }) => node.id === 'F1').hash)
      }
      expect(census.events.filter((event: { ok: boolean }) => !event.ok)).toEqual([])
      expect(census.errors).toEqual([])
    } finally {
      if (!record) rmSync(output, { recursive: true, force: true })
    }
  }, 510_000)
})
