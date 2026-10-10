// @vitest-environment jsdom
//
// WO-1452 (Codex audit BUG-446, family K6): a malformed SVG imported silently.
//
// DOMParser never throws on malformed XML; it returns a document carrying a
// <parsererror> element (and, in browsers, whatever content it recovered before
// the syntax error). importSVG only checked whether a <svg> element was
// findable, so a file truncated inside a tag whose <svg> was still recoverable
// walked its partial shapes and returned an ordinary Import2DResult -- which
// importGeometryFile reports to the operator as severity 'success' and adds to
// the project. These tests drive the REAL import path: the svgImporter fix plus
// importGeometryFile's existing outer catch (the console 'error' event + rethrow
// + no addGeometry), with the only missing browser primitive (SVG path geometry)
// polyfilled -- see svgPathGeometryPolyfill.ts.
//
// NOTE ON ENGINE BEHAVIOUR: jsdom parses a malformed XML document down to a
// bare <parsererror> root (no <svg> at all), whereas a browser keeps the
// recovered <svg> alongside it. Both are refusals once importSVG checks for the
// marker, so this suite asserts the marker-driven throw through the same
// production entry point in either engine rather than depending on the recovery
// behaviour. On the pre-fix importer this malformed input did not refuse: jsdom
// returned an empty result and importGeometryFile still reported success (the
// WO's acceptance #3). The `err.name` assertion is deliberately written without
// importing MalformedSvgError, so this file still loads and fails
// behaviourally against the unfixed importer.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { importSVG } = await import('../../lib/import/svgImporter')
const { importGeometryFile } = await import('../../lib/import/importGeometryFile')
const { installSvgPathGeometry } = await import('./svgPathGeometryPolyfill')

// The prefix is valid and yields one real <path>; the file then ends inside an
// unclosed <path> start tag -- the exact "ends inside an unclosed path-start
// tag" shape the WO names (its on-disk fixture is absent from the repo, so this
// is the equivalent inline fixture the WO allows).
const MALFORMED_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <path d="M 0 0 L 10 10"/>
  <path d="M 20 20 L 30 30`

const WELL_FORMED_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect x="0" y="0" width="10" height="10" style="stroke:#ff0000"/>
</svg>`

function svgFile(name: string, text: string): File {
  return new File([text], name, { type: 'image/svg+xml' })
}

function makeDeps() {
  return {
    importBrepGeometry: vi.fn(),
    addGeometry: vi.fn(),
  }
}

beforeEach(() => {
  installSvgPathGeometry(window as unknown as { SVGElement: { prototype: object } })
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})

describe('WO-1452: importSVG refuses a malformed SVG', () => {
  it('the parser reports the failure through a parsererror element, not an exception', () => {
    const doc = new DOMParser().parseFromString(MALFORMED_SVG, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).not.toBeNull()
  })

  it('throws a named error instead of returning recovered/empty geometry', () => {
    let caught: unknown
    try {
      importSVG(MALFORMED_SVG)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('MalformedSvgError')
    expect((caught as Error).message).toMatch(/malformed svg/i)
  })

  it('does not false-positive: a well-formed SVG still imports its geometry', () => {
    const result = importSVG(WELL_FORMED_SVG)
    expect(result.loops.length).toBeGreaterThan(0)
    expect(result.layers.length).toBeGreaterThan(0)
  })
})

describe('WO-1452: importGeometryFile surfaces the malformed import as a refusal', () => {
  it('rejects, lands one error event naming the file, adds no geometry row, no success event', async () => {
    const deps = makeDeps()

    await expect(importGeometryFile(svgFile('broken.svg', MALFORMED_SVG), deps))
      .rejects.toThrow(/malformed svg/i)

    expect(deps.importBrepGeometry).not.toHaveBeenCalled()
    expect(deps.addGeometry).not.toHaveBeenCalled()

    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ severity: 'error', source: 'import' })
    expect(events[0].message).toContain('broken.svg')
    expect(events[0].message).toMatch(/malformed svg/i)
  })

  it('still imports a well-formed SVG normally (success event, geometry added)', async () => {
    const deps = makeDeps()

    await importGeometryFile(svgFile('good.svg', WELL_FORMED_SVG), deps)

    expect(deps.addGeometry).toHaveBeenCalledTimes(1)
    expect(deps.addGeometry.mock.calls[0][0].loops.length).toBeGreaterThan(0)

    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ severity: 'success', source: 'import' })
    expect(events[0].message).toContain('good.svg'.replace('.svg', ''))
  })
})