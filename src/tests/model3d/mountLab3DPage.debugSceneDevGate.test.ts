// @vitest-environment jsdom
//
// WO UI-24-R1 (audit finding 4, minor/hygiene): `?debugScene=<url>` + `window.__DEBUG_SCENE_IMPORT__`
// are production-reachable surfaces -- a crafted link can make the browser fetch an arbitrary URL
// before the workbench even mounts. Gated behind `import.meta.env.DEV` in mountLab3DPage.ts's
// resolveInitialDebugScene (exported there for exactly this test). Each `it` below flips DEV and
// proves the gate's actual effect: with DEV off, neither source is ever even READ (the global is
// ignored, and `fetch` -- spied, never stubbed to succeed -- is never called at all).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { DEBUG_SCENE_SCHEMA_VERSION, type DebugSceneExport } from '../../components/model3d/debugScene'
import { resolveInitialDebugScene } from '../../components/model3d/mountLab3DPage'

function validDebugScene(): DebugSceneExport {
  return {
    schemaVersion: DEBUG_SCENE_SCHEMA_VERSION,
    appVersion: '0.10.2',
    gitCommit: 'deadbeef',
    gitBranch: 'main',
    buildDate: '2026-07-11T00:00:00.000Z',
    exportedAt: '2026-07-11T12:00:00.000Z',
    dag: JSON.stringify({ nodes: [], order: [] }),
    featureOrder: [],
    rollbackMarker: { kind: 'end' },
    camera: {
      position: { x: 85, y: -85, z: 65 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 45,
      projection: 'perspective',
    },
    displayMode: 'shaded-edges',
    hiddenGenesisIds: [],
    skipped: [],
  }
}

afterEach(() => {
  delete window.__DEBUG_SCENE_IMPORT__
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

describe('WO UI-24-R1: debug-scene import channel is DEV-only', () => {
  it('DEV on: __DEBUG_SCENE_IMPORT__ is read and parsed (the ordinary dev/probe path)', async () => {
    vi.stubEnv('DEV', true)
    window.__DEBUG_SCENE_IMPORT__ = validDebugScene()
    const resolved = await resolveInitialDebugScene()
    expect(resolved).not.toBeUndefined()
    expect(resolved?.schemaVersion).toBe(DEBUG_SCENE_SCHEMA_VERSION)
  })

  it('DEV off: __DEBUG_SCENE_IMPORT__ is ignored entirely -- resolves undefined, the ordinary boot path', async () => {
    vi.stubEnv('DEV', false)
    window.__DEBUG_SCENE_IMPORT__ = validDebugScene()
    const resolved = await resolveInitialDebugScene()
    expect(resolved).toBeUndefined()
  })

  it('DEV off: ?debugScene=<url> is ignored -- fetch is never called (no arbitrary-URL request reaches the network)', async () => {
    vi.stubEnv('DEV', false)
    window.history.pushState(null, '', '/?workbench=1&debugScene=https%3A%2F%2Fevil.example%2Fpwn.json')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const resolved = await resolveInitialDebugScene()
    expect(resolved).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DEV on: ?debugScene=<url> IS fetched (gate does not affect the dev/probe path)', async () => {
    vi.stubEnv('DEV', true)
    window.history.pushState(null, '', '/?workbench=1&debugScene=/fixtures/scene.json')
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => validDebugScene() })
    vi.stubGlobal('fetch', fetchSpy)
    const resolved = await resolveInitialDebugScene()
    expect(fetchSpy).toHaveBeenCalledWith('/fixtures/scene.json')
    expect(resolved?.schemaVersion).toBe(DEBUG_SCENE_SCHEMA_VERSION)
  })
})
