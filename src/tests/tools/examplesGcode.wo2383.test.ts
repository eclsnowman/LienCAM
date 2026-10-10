// Re-run the actual browser Open -> staged Export -> postProject path.
import { execFile, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const dialects = ['uccnc', 'grbl', 'grblhal', 'linuxcnc', 'generic']
const folders = readdirSync(join(root, 'examples')).filter(f => /^\d\d-/.test(f))
const projects = folders.flatMap(folder => readdirSync(join(root, 'examples', folder))
  .filter(f => f.endsWith('.camproject')).map(file => ({ folder, file,
    project: JSON.parse(readFileSync(join(root, 'examples', folder, file), 'utf8')) })))
const machining = projects.filter(({ project }) => project.setups.some((s: { operations: { enabled: boolean }[] }) => s.operations.some(o => o.enabled)))
const stem = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')

describe('WO-2383 shipped example programs', () => {
  it('covers every machining project with exactly five named dialect files', () => {
    expect(machining.length).toBeGreaterThan(0)
    for (const { folder, project } of machining) expect(project.name).toMatch(new RegExp(`^${folder.slice(0, 2)} .+`))
    const expected = machining.flatMap(({ project }) => dialects.map(id => `${stem(project.name)}-${id}.nc`)).sort()
    expect(readdirSync(join(root, 'examples/gcode')).filter(f => f.endsWith('.nc')).sort()).toEqual(expected)
  })

  it('puts the current app version in every header', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const { project } of machining) for (const id of dialects) {
      const file = `${stem(project.name)}-${id}.nc`
      expect(readFileSync(join(root, 'examples/gcode', file), 'utf8').split('\n')[0], file)
        .toContain(`LienCAM ${version} - ${project.name} - ${id}`)
    }
  })

  it('passes the real release scanner with zero hits', () => {
    const scan = spawnSync(process.execPath, ['tools/release/scan.mjs', 'examples/gcode'], {
      cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    expect(scan.error, scan.error?.message).toBeUndefined()
    expect(scan.status, `${scan.stdout}\n${scan.stderr}`).toBe(0)
    expect(scan.stdout).toContain(`scan: clean - ${machining.length * dialects.length + 1} files`)
  })

  it('re-posts every example byte for byte and names any changed file', async () => {
    // Keep Vitest's RPC/event loop live while Chromium opens the real projects.
    const result = await new Promise<{ error: Error | null; status: string | number;
      stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['tools/examples/post-all.mjs', '--check'], {
        cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => resolve({
        error: error && typeof error.code !== 'number' ? error : null,
        status: error?.code ?? 0, stdout, stderr,
      }))
    })
    expect(result.error, result.error?.message).toBeNull()
    const line = result.stdout.split(/\r?\n/).find(l => l.startsWith('WO2383_RESULT='))
    expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined()
    const report = JSON.parse(line!.slice('WO2383_RESULT='.length))
    expect(report.files.length).toBe(machining.length * dialects.length)
    expect(report.differences, `${result.stdout}\n${result.stderr}`).toEqual([])
    expect(result.status, result.stderr).toBe(0)
  }, 650_000)
})
