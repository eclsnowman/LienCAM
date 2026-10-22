import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(resolve('docs/machine/CONTROLLER-QUALIFICATION.md'), 'utf8');
const rows = doc.split(/\r?\n/).filter(line => /^\| Q\d{2} \|/.test(line))
  .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
const ids = Array.from({ length: 18 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`);

describe('WO-2846 controller qualification contract', () => {
  it('enumerates each named check exactly once', () => {
    expect(rows.map(row => row[0])).toEqual(ids);
  });

  it.each(ids)('%s has an executable kit reference, board step and distinct evidence destination', id => {
    const row = rows.find(candidate => candidate[0] === id)!;
    expect(row).toHaveLength(5);
    expect(row[1].length).toBeGreaterThan(20);
    expect(row[2]).toMatch(/G6|Native probe-check\.mjs|WO-284[35]/);
    expect(row[2].length).toBeGreaterThan(60);
    const board = row[3].match(/^(B[1-5])(?:\/B[1-5])*:/);
    expect(board).not.toBeNull();
    expect(doc).toContain(`- ${board![1]} (`);
    expect(row[3].length).toBeGreaterThan(60);
    expect(row[4]).toBe(`${id}.json`);
  });

  it('covers every original F-row and native G6 group', () => {
    const coverage = rows.map(row => row[1]).join(' ');
    for (let i = 1; i <= 8; i++) expect(coverage).toContain(`F${i}`);
    for (const group of ['core', 'files', 'extra']) expect(doc).toContain(`G6 ${group}`);
    for (const assumption of ['Puffer', 'CurrentID', 'Stop returns rc 7', 'SetAxisSetting',
      'Close/Open', 'GetInput', 'JogOnSpeed', '16-51 ms', 'Probe finish', 'rc 10']) {
      expect(coverage).toContain(assumption);
    }
  });

  it('does not promote kit limitations into firmware passes', () => {
    for (const id of ['Q04', 'Q06', 'Q07', 'Q08', 'Q13', 'Q16']) {
      expect(rows.find(row => row[0] === id)![2]).toContain('NOT MODELLED');
    }
    expect(doc).toContain('A kit pass\nalone cannot create a proven row.');
    expect(doc).toContain('Untested versions continue to connect per D2');
    expect(doc).toContain('Never ProbeStop after contact');
    expect(doc).toContain('Do not overflow the ring');
  });

  it('specifies reproducible identity and future artifact destinations', () => {
    for (const field of ['source commit', 'executable SHA256', 'wrapper SHA256',
      'DLL path/version/SHA256', 'board type/serial', 'firmware', 'hardware and API']) {
      expect(doc).toContain(field);
    }
    expect(doc).toContain('src/tests/evidence/WO-2846/runs/<run-id>/');
    expect(new Set(rows.map(row => row[4])).size).toBe(18);
    expect(doc).toContain('not claims that those captures exist today');
  });

  it('keeps the native kit instructions and G6 references resolvable', () => {
    for (const file of ['NATIVE-PROBE-REHEARSAL/README.md',
      'NATIVE-PROBE-REHEARSAL/probe-check.mjs', 'NATIVE-PROBE-REHEARSAL/build.ps1',
      'G6-NATIVE-KIT-2026-10-09/README.md', 'G6-NATIVE-KIT-2026-10-09/driver/final19-desk.mjs']) {
      expect(existsSync(resolve('src/tests/evidence', file))).toBe(true);
    }
  });

  it('has a captured production-bridge dry run with actual simulated readbacks', () => {
    const output = readFileSync(resolve('src/tests/evidence/WO-2846/kit-dry-run.txt'), 'utf8');
    expect(output).toContain('37 passed, 0 failed');
    for (const reading of ['got 46.94', 'got 195.2525', 'got 48.203', 'got 48.263',
      'retract RAN', 'bare-face search ends at its bound']) expect(output).toContain(reading);
    const log = readFileSync(resolve('src/tests/evidence/WO-2846/kit-bridge.log'), 'utf8');
    expect(log).toContain('SIMULATED UC100');
    expect(log).toContain('controller: AXBB-E serial 7777 fw 7777 hw 1 api 1');
  });
});
