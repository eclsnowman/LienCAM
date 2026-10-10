import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const REF = process.env.WO2538_EXPORT_REF ?? 'HEAD'

it('WO-2538 reports zero hits through the committed public exporter and scanner CLI', async () => {
  const output = mkdtempSync(join(tmpdir(), 'liencam-wo2538-export-'))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { spawnSync } from 'node:child_process';
      import { join } from 'node:path';
      import { exportPublic } from './tools/release/export-public.mjs';
      const findings = [];
      const result = exportPublic(process.argv[1], process.argv[2], {
        log(line) { if (/\\[.*\\]/.test(line)) findings.push(line); },
      });
      const scan = spawnSync(process.execPath, [join(process.argv[2], 'tools/release/scan.mjs'), process.argv[2]], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      });
      console.log(JSON.stringify({ ...result, findings, scanStatus: scan.status, scanOutput: scan.stdout, scanError: scan.stderr }));
    `, REF, output], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    })
    const report = JSON.parse(stdout)
    console.log(JSON.stringify({ commit: report.commit, files: report.files, bytes: report.bytes, hits: report.hits, scanStatus: report.scanStatus }))
    // Prevent a broken or empty selection from making the zero-hit check vacuous.
    expect(report.files).toBeGreaterThan(4000)
    expect(report.hits, report.findings.join('\n')).toBe(0)
    expect(report.scanStatus, report.scanOutput + report.scanError).toBe(0)
    expect(report.scanOutput).toContain(`scan: clean - ${report.files} files`)
  } finally {
    // This fresh export has no .git or dependency links; never remove a worktree.
    rmSync(output, { recursive: true, force: true })
  }
}, 180_000)
