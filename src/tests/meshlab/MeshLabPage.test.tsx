// @vitest-environment jsdom
//
// Render/integration smoke tests for the Mesh Shop lab (WO INT-3, GATE M3), mirroring
// Lab3DView.smoke.test.tsx / Sketch3dLabPage.test.tsx's convention: worker faked at the facade
// boundary (createLocalMeshClient -- runs the REAL src/mesh facade + a real manifold-3d module
// synchronously, just off the worker thread, since jsdom can't load a module Worker) and
// THREE/WebGL faked at the scene-runtime boundary (fakeCreateSceneRuntime, reused unmodified
// from src/tests/model3d).
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MeshLabPage } from '../../components/meshlab'
import type { MeshClient } from '../../components/meshlab'
import { exportBinaryStl } from '../../mesh'
import { fakeCreateSceneRuntime } from '../model3d/fakeSceneRuntime'
import { createLocalMeshClient } from './support/localMeshClient'
import { sphereApprox, unitCube } from '../mesh/fixtures'

afterEach(() => {
  cleanup()
  delete window.__meshlabSnapshot
})

function stlFile(name: string, mesh: { positions: Float32Array; indices: Uint32Array }): File {
  const { bytes } = exportBinaryStl(mesh)
  return new File([bytes], name, { type: 'model/stl' })
}

async function waitForReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('meshlab-status').textContent).toMatch(/ready/i)
  })
}

describe('MeshLabPage render smoke test', () => {
  it('mounts and reaches ready against a real (off-thread) manifold-3d kernel', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()
    expect(screen.getByTestId('meshlab-canvas')).toBeTruthy()
  })
})

describe('MeshLabPage import + health panel', () => {
  it('imports a real STL and shows an honest health report (unwelded raw import first, then welded watertight)', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    const input = screen.getByTestId('meshlab-import-primary') as HTMLInputElement
    fireEvent.change(input, { target: { files: [stlFile('cube.stl', unitCube(10))] } })

    await waitFor(() => {
      expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight')
    })
    const text = screen.getByTestId('meshlab-primary-health').textContent ?? ''
    expect(text).toContain('12 tris') // unit cube = 12 triangles
    expect(text).not.toContain('NOT watertight') // weldByPosition must run BEFORE this panel renders
  })
})

describe('MeshLabPage repair', () => {
  it('repairs a mesh with a real hole and reports an honest fill count', async () => {
    // A cube missing one face -- a REAL, geometrically open solid (not an STL-unwelded artifact).
    const cube = unitCube(10)
    const openCube = { positions: cube.positions, indices: cube.indices.slice(0, cube.indices.length - 6) }
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('open-cube.stl', openCube)] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('NOT watertight'))

    fireEvent.click(screen.getByTestId('meshlab-repair'))
    await waitFor(() => expect(screen.getByTestId('meshlab-repair-result')).toBeTruthy())
    expect(screen.getByTestId('meshlab-repair-result').textContent).toContain('filled 1 hole')
    expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight')
  })
})

describe('MeshLabPage boolean, plane cut, export', () => {
  it('runs union then plane cut then exports STL and 3MF, both re-importable', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube.stl', unitCube(10))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight'))

    const secondCube = unitCube(10)
    for (let i = 0; i < secondCube.positions.length; i += 3) secondCube.positions[i] += 5 // offset so the union is non-trivial
    fireEvent.change(screen.getByTestId('meshlab-import-secondary') as HTMLInputElement, {
      target: { files: [stlFile('cube2.stl', secondCube)] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-secondary-health').textContent).toContain('watertight'))

    fireEvent.click(screen.getByTestId('meshlab-boolean-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-last-op').textContent).toContain('boolean union'))

    fireEvent.change(screen.getByTestId('meshlab-planecut-offset'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('meshlab-planecut-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-last-op').textContent).toContain('plane cut'))

    fireEvent.click(screen.getByTestId('meshlab-export-stl'))
    await waitFor(() => {
      const text = screen.getByTestId('meshlab-export-result').textContent ?? ''
      expect(text).toContain('STL')
      expect(text).toContain('re-import OK')
      // R1.2: export result must show elapsed ms and an honestly-labeled triangle count (raw
      // exported faces, explicitly distinguished from the health panel's analyzed-good count).
      expect(text).toMatch(/\d+ms/)
      expect(text).toContain('exported faces')
    })
    expect(screen.getByTestId('meshlab-last-op').textContent).toContain('export stl')

    fireEvent.click(screen.getByTestId('meshlab-export-3mf'))
    await waitFor(() => {
      const text = screen.getByTestId('meshlab-export-result').textContent ?? ''
      expect(text).toContain('3MF')
      expect(text).toContain('re-import OK')
      expect(text).toMatch(/\d+ms/)
      expect(text).toContain('exported faces')
    })
    expect(screen.getByTestId('meshlab-last-op').textContent).toContain('export 3mf')

    expect(window.__meshlabSnapshot?.opError).toBeNull()
  })
})

describe('MeshLabPage plane cut keep-negative routing (INT-3-R2)', () => {
  it('replaces Primary with the negative side when keep=negative, and leaves Secondary untouched', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube.stl', unitCube(10))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight'))
    const preCutHealth = screen.getByTestId('meshlab-primary-health').textContent ?? ''
    expect(preCutHealth).toContain('cube.stl')

    // Secondary stays empty for this test -- keep=negative must not populate it, and must not
    // leave it populated by side effect of routing the negative result there instead of Primary.
    expect(screen.getByTestId('meshlab-secondary-health').textContent).toContain('(empty)')

    fireEvent.change(screen.getByTestId('meshlab-planecut-keep'), { target: { value: 'negative' } })
    fireEvent.change(screen.getByTestId('meshlab-planecut-offset'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('meshlab-planecut-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-last-op').textContent).toContain('plane cut'))

    // The bug (pre-fix): manifoldOps.planeCutMesh returns ONLY result.negative for keep=negative,
    // but MeshLabPage wrote result.positive (undefined here, so a no-op) to Primary and routed
    // result.negative to Secondary regardless of keep mode. That left Primary showing the
    // PRE-CUT mesh under a stale "plane cut" lastOp label, with Secondary silently populated.
    // Both assertions below fail against that pre-fix routing.
    const postCutHealth = screen.getByTestId('meshlab-primary-health').textContent ?? ''
    expect(postCutHealth).toContain('(cut-)')
    expect(postCutHealth).not.toBe(preCutHealth)
    expect(screen.getByTestId('meshlab-secondary-health').textContent).toContain('(empty)')

    // Repair/export results describing the old Primary mesh must not survive the swap either.
    expect(window.__meshlabSnapshot?.repairResult).toBeNull()
    expect(window.__meshlabSnapshot?.exportResult).toBeNull()
  })

  it('keep=both is explicit: Primary gets the positive side, Secondary gets the negative side', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube.stl', unitCube(10))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight'))

    fireEvent.change(screen.getByTestId('meshlab-planecut-keep'), { target: { value: 'both' } })
    fireEvent.change(screen.getByTestId('meshlab-planecut-offset'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('meshlab-planecut-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-last-op').textContent).toContain('plane cut'))

    expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('(cut+)')
    expect(screen.getByTestId('meshlab-secondary-health').textContent).toContain('(cut-)')
  })
})

describe('MeshLabPage stale result panels (R1.1)', () => {
  it('clears the export result when a new mesh is imported into the same slot', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube-a.stl', unitCube(10))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight'))

    fireEvent.click(screen.getByTestId('meshlab-export-stl'))
    await waitFor(() => expect(screen.getByTestId('meshlab-export-result').textContent).toContain('re-import OK'))

    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube-b.stl', unitCube(20))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('cube-b.stl'))

    // The prior export result (bytes/tris for cube-a) must not still be on screen under cube-b.
    expect(screen.queryByTestId('meshlab-export-result')).toBeNull()
    expect(window.__meshlabSnapshot?.exportResult).toBeNull()
  })

  it('clears repair and export results once a mesh-mutating op (decimate) replaces the primary mesh', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    // A plain closed cube -- Repair still runs (and sets a "filled 0 holes" result) even though
    // nothing was broken; this avoids the fan-triangulated patch a REAL hole-fill produces, which
    // manifold's own erosion/simplify ops can reject as "Not manifold" (an unrelated, pre-existing
    // fixture-geometry quirk, not part of this rework's scope).
    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube.stl', unitCube(10))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight'))

    fireEvent.click(screen.getByTestId('meshlab-repair'))
    await waitFor(() => expect(screen.getByTestId('meshlab-repair-result')).toBeTruthy())

    fireEvent.click(screen.getByTestId('meshlab-export-stl'))
    await waitFor(() => expect(screen.getByTestId('meshlab-export-result').textContent).toContain('re-import OK'))

    fireEvent.click(screen.getByTestId('meshlab-decimate-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-last-op').textContent).toContain('decimate'), { timeout: 15_000 })

    expect(screen.queryByTestId('meshlab-repair-result')).toBeNull()
    expect(screen.queryByTestId('meshlab-export-result')).toBeNull()
  }, 20_000)
})

describe('MeshLabPage cross-domain boolean (MSH-4-MESHLAB-PROOF)', () => {
  // Uses the REAL brep-operand builder (default createGeomOperand prop -> createGeomOperandClient
  // -> createLocalGeomService -> real occt-wasm, no Worker, same off-thread pattern
  // Lab3DViewMeasureRealKernel.integration.test.tsx already proves works fine under jsdom) AND the
  // real off-thread mesh kernel (createLocalMeshClient). Both real wasm kernels -- no mocks on
  // either side of the bridge, mirroring src/tests/mesh/crossDomainBoolean.test.ts's own standard.
  it('mesh cube MINUS a real tessellated brep box: watertight, honest approximate+tolerance labels, sane volume', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    // Primary: a 10mm mesh cube occupying [0,10]^3 (unitCube's own convention).
    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('cube10.stl', unitCube(10))] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('watertight'))

    // Brep operand: a 5mm box (also occupies [0,5]^3 by the kernel's own makeBox convention --
    // src/tests/mesh/crossDomainBoolean.test.ts's own criterion-1 test documents this placement) --
    // fully inside the mesh cube, so difference removes a clean corner-aligned sub-box.
    fireEvent.change(screen.getByTestId('meshlab-brep-box-x'), { target: { value: '5' } })
    fireEvent.change(screen.getByTestId('meshlab-brep-box-y'), { target: { value: '5' } })
    fireEvent.change(screen.getByTestId('meshlab-brep-box-z'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('meshlab-brep-build'))
    await waitFor(() => expect(screen.getByTestId('meshlab-brep-operand-summary')).toBeTruthy(), { timeout: 30_000 })
    const operandText = screen.getByTestId('meshlab-brep-operand-summary').textContent ?? ''
    expect(operandText).toContain('box')
    expect(operandText).toContain('0.1mm') // default tolerance
    // window.__meshlabSnapshot is written by a useEffect keyed on this same state, a separate
    // passive-effect commit from the DOM text above -- normally back-to-back, but under full-suite
    // CPU contention the gap between "DOM shows the summary" and "the effect ran" can widen past a
    // single synchronous read. Poll it with a bounded timeout rather than assuming lockstep.
    await waitFor(() => expect(window.__meshlabSnapshot?.brepOperand?.triangleCount).toBe(12)) // box -> 12 tris at any tolerance

    // crossDomainOp defaults to 'difference' -- run Primary (cube) minus the brep box.
    fireEvent.click(screen.getByTestId('meshlab-crossdomain-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-crossdomain-result')).toBeTruthy(), { timeout: 30_000 })

    const resultText = screen.getByTestId('meshlab-crossdomain-result').textContent ?? ''
    expect(resultText).toContain('APPROXIMATE: true') // honest labeling (WO ruling 2) -- ANY tessellated-brep operand is approximate by construction
    expect(resultText).toContain('0.1mm') // tessellation tolerance surfaced plainly
    expect(resultText).toContain('watertight')
    expect(resultText).not.toContain('NOT watertight')

    // Same lockstep-assumption hazard as the brep-operand summary above -- window.__meshlabSnapshot
    // is a separate useEffect commit from the DOM text just asserted on. This exact read is where
    // the full-gate run observed a real flake (crossDomainResult still null moments after the DOM
    // already showed the result), so it gets the bounded poll rather than a synchronous read.
    await waitFor(() => expect(window.__meshlabSnapshot?.crossDomainResult).not.toBeNull(), { timeout: 10_000 })
    const snap = window.__meshlabSnapshot?.crossDomainResult
    expect(snap).not.toBeNull()
    expect(snap?.approximate).toBe(true)
    expect(snap?.tessellationTolerance).toBe(0.1)
    expect(snap?.watertight).toBe(true)
    // Analytic: 10^3 cube minus a fully-contained 5^3 corner box = 1000 - 125 = 875.
    expect(snap?.volume).toBeCloseTo(875, 0)
    expect(snap?.triangleCount).toBeGreaterThan(0)

    // The primary slot must show the RESULT mesh (not the pre-op cube) -- same replace-Primary
    // convention the mesh-vs-mesh boolean/hollow/decimate handlers already use.
    const primaryHealth = screen.getByTestId('meshlab-primary-health').textContent ?? ''
    expect(primaryHealth).toContain('X-domain-difference')
    expect(window.__meshlabSnapshot?.opError).toBeNull()
  }, 60_000)

  it('FAIL-LOUD: a refused/invalid brep build surfaces the module error, never swallowed', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    fireEvent.change(screen.getByTestId('meshlab-brep-tolerance'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('meshlab-brep-build'))
    await waitFor(() => expect(screen.getByTestId('meshlab-brep-error')).toBeTruthy(), { timeout: 30_000 })
    expect(screen.getByTestId('meshlab-brep-error').textContent).toMatch(/tolerance/i)
    // No operand was minted -- the Run button must stay disabled.
    expect((screen.getByTestId('meshlab-crossdomain-run') as HTMLButtonElement).disabled).toBe(true)
  }, 30_000)
})

describe('MeshLabPage mesh worker lifecycle (R1.3)', () => {
  function createSpyMeshClient(): MeshClient & { disposeCalled: boolean; terminateCalled: boolean } {
    const spy = {
      disposeCalled: false,
      terminateCalled: false,
      async init() {
        return { kernel: 'manifold-3d' as const, version: '3.5.1' as const, available: true }
      },
      async dispose() {
        spy.disposeCalled = true
        return { disposed: true as const }
      },
      terminate() {
        spy.terminateCalled = true
      },
      async importStl(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async exportStl(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async analyze(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async repair(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async measure(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async boolean(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async crossDomainBoolean(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async planeCut(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async hollow(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async mirror(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async transform(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
      async decimate(): Promise<never> {
        throw new Error('not implemented in lifecycle spy')
      },
    }
    return spy
  }

  it('disposes and terminates the mesh client on unmount, surviving a StrictMode double-invoke', async () => {
    const client = createSpyMeshClient()
    const { unmount } = render(
      <StrictMode>
        <MeshLabPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />
      </StrictMode>,
    )
    await waitForReady()
    // StrictMode's mount -> cleanup -> mount already exercised the dispose path once (on the
    // FIRST instance) before the real unmount below -- this is exactly the leak R1.3 fixes.
    expect(client.disposeCalled).toBe(true)
    expect(client.terminateCalled).toBe(true)

    unmount()
    await waitFor(() => expect(client.terminateCalled).toBe(true))
    expect(client.disposeCalled).toBe(true)
  })
})

describe('MeshLabPage perf guards (BK-17a)', () => {
  it('blocks Hollow above the measured triangle guard and explains why', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    // sphereApprox(radius, segments, rings) -- segments*rings*2-ish triangles; pick a size that
    // comfortably clears the hollow guard threshold (2,000 tris).
    const bigSphere = sphereApprox(10, 80, 40) // 6,240 triangles (same fixture size MSH-2 benched)
    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('big-sphere.stl', bigSphere)] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('tris'))

    const hollowButton = screen.getByTestId('meshlab-hollow-run') as HTMLButtonElement
    expect(hollowButton.disabled).toBe(true)
    expect(screen.getByTestId('meshlab-hollow-guard').textContent).toMatch(/decimate/i)
  })

  it('WO-1907: repairs the 14,160-triangle part with a hole instead of refusing it, and says what it closed', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    // The fixture INT-3 measured at 31.2s, with its north-pole fan (first 120 facets) cut away.
    const sphere = sphereApprox(10, 120, 60)
    const holed = { positions: sphere.positions, indices: sphere.indices.slice(120 * 3) }
    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('holed-sphere.stl', holed)] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('NOT watertight'))

    const repairButton = screen.getByTestId('meshlab-repair') as HTMLButtonElement
    expect(repairButton.disabled).toBe(false)
    expect(screen.queryByTestId('meshlab-repair-guard')).toBeNull()
    expect(document.body.textContent ?? '').not.toMatch(/repair is blocked/i)

    fireEvent.click(repairButton)
    await waitFor(() => expect(screen.getByTestId('meshlab-repair-result')).toBeTruthy(), { timeout: 15_000 })
    expect(screen.getByTestId('meshlab-repair-result').textContent).toContain('filled 1 hole')
    expect(screen.getByTestId('meshlab-repair-result').textContent).not.toContain('still not watertight')
    expect(screen.getByTestId('meshlab-primary-health').textContent).not.toContain('NOT watertight')
  }, 30_000)

  it('allows Decimate on the same oversized mesh, and Hollow becomes available once it is small enough', async () => {
    render(<MeshLabPage createClient={createLocalMeshClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitForReady()

    const bigSphere = sphereApprox(10, 80, 40)
    fireEvent.change(screen.getByTestId('meshlab-import-primary') as HTMLInputElement, {
      target: { files: [stlFile('big-sphere.stl', bigSphere)] },
    })
    await waitFor(() => expect(screen.getByTestId('meshlab-primary-health').textContent).toContain('tris'))
    expect((screen.getByTestId('meshlab-hollow-run') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByTestId('meshlab-decimate-target'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('meshlab-decimate-run'))
    await waitFor(() => expect(screen.getByTestId('meshlab-last-op').textContent).toContain('decimate'), { timeout: 15_000 })

    expect((screen.getByTestId('meshlab-hollow-run') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('meshlab-hollow-guard')).toBeNull()
  }, 20_000)
})
