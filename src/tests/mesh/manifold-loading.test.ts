// MSH-3 ruling 3a pin test: the defaultManifoldFactory must resolve manifold-3d
// through a REAL, literal `import('manifold-3d')` expression that Vite's import
// analysis can see (so the FROZEN worker entry bundles the wasm), NOT the old
// `new Function('specifier','return import(specifier)')` indirection that Vite
// could not follow. Asserting against the SOURCE FILE text is deliberate: a
// `.toString()` of the transpiled function would show vite-node's SSR dynamic-
// import shim, not the literal the bundler needs — the source is the contract.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultManifoldFactory } from '../../mesh/manifoldKernel';

const SOURCE = readFileSync('src/mesh/manifoldKernel.ts', 'utf8');

describe('ruling 3a: manifold-3d browser loading', () => {
  it('the factory source contains a literal import() Vite can bundle', () => {
    expect(SOURCE).toMatch(/import\(\s*['"]manifold-3d['"]\s*\)/);
  });

  it('the old new Function() indirection is gone', () => {
    expect(SOURCE).not.toContain("new Function('specifier'");
    expect(SOURCE).not.toContain('new Function("specifier"');
  });

  it('defaultManifoldFactory is exported for this pin test', () => {
    expect(typeof defaultManifoldFactory).toBe('function');
  });
});
