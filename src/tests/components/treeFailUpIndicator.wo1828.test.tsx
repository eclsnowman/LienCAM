// @vitest-environment jsdom
//
// WO-1828: a collapsed setup/folder/nest/operation-folder row showed nothing
// when a hidden descendant needed recompute or had an error -- the tree read
// "fine" while the app's own status surfaces disagreed. Fix: one rollup rule
// (error > needs-recompute > clear), computed once (DesignTree.tsx's
// worseRollupTier/operationRollupTier/nestRollupTier/geometryRollupTier), and
// applied identically to every collapsible row kind. Operator's verdict (WO file,
// "icon at the end"): a trailing status icon reusing the existing per-
// operation status vocabulary (AlertCircle/status-error, Clock/status-
// outdated), appended after the row's own actions.
//
// These tests drive the real store action paths (addOperationFolder,
// setOperationFolderId, updateOperation, addGeometryFolder, setGeometryFolderId,
// applyNestResult) and render the real DesignTree component (Tier 2 evidence
// per LIENCAM.md rule 6) rather than asserting against a hand-built tree model.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the uiPrefs Zustand store uses persist() which writes on every set().
// Install a minimal in-memory Storage shim BEFORE importing the store (same
// scaffolding as DesignTreeSetupAutoExpand.test.tsx / DesignTreeNestZeroFitStatus.wo1406.test.tsx).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      expandedSetupIds: [],
      collapsedFolderIds: [],
      collapsedNestIds: [],
      collapsedOperationFolderIds: [],
    })
  })
})

const WCS = {
  id: 'wcs-1', label: 'G54', fixtureOffset: 54,
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
}

function makeOp(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: id, type: 'pocket_2d', enabled: true, status,
    toolId: '', geometrySelections: [], heights: {}, passes: {}, linking: {}, params: {},
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('DesignTree collapsed-row fail-up rollup (WO-1828)', () => {
  it('a collapsed operation folder holding an errored operation shows the error badge; expanding it hides the badge again', () => {
    act(() => {
      useCamStore.getState().addSetup({
        id: 'setup-1', name: 'Setup 1', wcs: WCS, stock: { type: 'auto' },
        operations: [makeOp('op-error', 'error', { errorMessage: 'Referenced geometry is missing.' })],
        notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    })
    const folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    act(() => {
      useCamStore.getState().setOperationFolderId('setup-1', 'op-error', folderId)
      useUiPrefs.getState().toggleOperationFolderCollapsed(folderId)
    })

    render(<DesignTree />)

    const badge = document.querySelector(`[data-testid="tree-rollup-badge-opfolder-${folderId}"]`)
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-tier')).toBe('error')

    act(() => { useUiPrefs.getState().toggleOperationFolderCollapsed(folderId) })
    expect(document.querySelector(`[data-testid="tree-rollup-badge-opfolder-${folderId}"]`)).toBeNull()
  })

  it('fixing the errored operation clears the collapsed folder badge without expanding it', () => {
    act(() => {
      useCamStore.getState().addSetup({
        id: 'setup-1', name: 'Setup 1', wcs: WCS, stock: { type: 'auto' },
        operations: [makeOp('op-error', 'error')],
        notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    })
    const folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    act(() => {
      useCamStore.getState().setOperationFolderId('setup-1', 'op-error', folderId)
      useUiPrefs.getState().toggleOperationFolderCollapsed(folderId)
    })
    render(<DesignTree />)
    expect(document.querySelector(`[data-testid="tree-rollup-badge-opfolder-${folderId}"]`)).not.toBeNull()

    act(() => {
      useCamStore.getState().updateOperation('setup-1', 'op-error', { status: 'ready' })
    })
    expect(document.querySelector(`[data-testid="tree-rollup-badge-opfolder-${folderId}"]`)).toBeNull()
    // Still collapsed -- the fix cleared the badge, it did not expand the row.
    expect(useUiPrefs.getState().isOperationFolderCollapsed(folderId)).toBe(true)
  })

  it('error beats needs-recompute: a collapsed setup with one outdated op and one errored op (in different folders) rolls up to error', () => {
    act(() => {
      useCamStore.getState().addSetup({
        id: 'setup-1', name: 'Setup 1', wcs: WCS, stock: { type: 'auto' },
        operations: [makeOp('op-stale', 'outdated'), makeOp('op-error', 'error')],
        notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      // A second setup becomes active on add (CVU-1 auto-expand only follows
      // the ACTIVE setup), leaving setup-1 collapsed by default.
      useCamStore.getState().addSetup({
        id: 'setup-2', name: 'Setup 2', wcs: WCS, stock: { type: 'auto' }, operations: [], notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    })
    expect(useCamStore.getState().project.activeSetupId).toBe('setup-2')

    render(<DesignTree />)
    expect(useUiPrefs.getState().expandedSetupIds).not.toContain('setup-1')

    const badge = document.querySelector('[data-testid="tree-rollup-badge-setup-setup-1"]')
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-tier')).toBe('error')
  })

  it('an operation inside an operation folder (a grandchild of the setup) rolls its error up through the collapsed setup row too, independent of the folder\'s own collapse state', () => {
    act(() => {
      useCamStore.getState().addSetup({
        id: 'setup-1', name: 'Setup 1', wcs: WCS, stock: { type: 'auto' },
        operations: [makeOp('op-error', 'error')],
        notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      useCamStore.getState().addSetup({
        id: 'setup-2', name: 'Setup 2', wcs: WCS, stock: { type: 'auto' }, operations: [], notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    })
    const folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    act(() => {
      useCamStore.getState().setOperationFolderId('setup-1', 'op-error', folderId)
      // The folder itself is left EXPANDED -- only the setup is collapsed.
      // setup.operations is folder-independent, so the setup's own rollup
      // must see the error two levels down without the folder's help.
    })

    render(<DesignTree />)

    expect(document.querySelector(`[data-testid="tree-rollup-badge-opfolder-${folderId}"]`)).toBeNull()
    const setupBadge = document.querySelector('[data-testid="tree-rollup-badge-setup-setup-1"]')
    expect(setupBadge).not.toBeNull()
    expect(setupBadge!.getAttribute('data-tier')).toBe('error')
  })

  it('a collapsed nest with needsRecompute shows the stale badge; a fresh recompute result clears it', () => {
    let nestId = ''
    act(() => {
      // A closed loop, not an STL mesh: createNest silently skips a source
      // with no closed loops (DesignTreeNestZeroFitStatus.wo1406.test.tsx's
      // addSourceGeometry shape).
      useCamStore.getState().addGeometry({
        id: 'g-nest', name: 'Bracket', filename: 'bracket.dxf', type: 'curves_2d', format: 'dxf',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
          size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        loops: [
          { id: 'g-nest-outer', layerId: 'L', closed: true, type: 'contour', area: 100,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
        ],
        layers2d: [{ id: 'L', name: 'L', color: '#ffffff', visible: true }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      nestId = useCamStore.getState().createNest({
        sheet: { width: 100, height: 100 }, style: 'ninety',
        spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 }, seed: 1,
        sources: [{ geometryId: 'g-nest', quantity: 1 }],
      })
      const seedPartId = useCamStore.getState().project.nests!.find((n) => n.id === nestId)!.sources[0].geometryId
      useCamStore.getState().applyNestResult(nestId, {
        placements: [{ partId: seedPartId, instanceId: `${seedPartId}#0`, x: 0, y: 0, rotationDeg: 0, depth: 0 }],
        unplaced: [], utilization: 0.5, sheetUsed: { width: 100, height: 100 },
      })
      // Mirrors the real staleness trigger (a seed edit after the pack) without
      // depending on the sketcher/layer-edit path this WO does not touch.
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          nests: (s.project.nests ?? []).map((n) => (n.id === nestId ? { ...n, needsRecompute: true } : n)),
        },
      }))
      useUiPrefs.getState().toggleNestCollapsed(nestId)
    })

    render(<DesignTree />)
    const badge = document.querySelector(`[data-testid="tree-rollup-badge-nest-${nestId}"]`)
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-tier')).toBe('stale')

    act(() => {
      const seedPartId = useCamStore.getState().project.nests!.find((n) => n.id === nestId)!.sources[0].geometryId
      useCamStore.getState().applyNestResult(nestId, {
        placements: [{ partId: seedPartId, instanceId: `${seedPartId}#0`, x: 0, y: 0, rotationDeg: 0, depth: 0 }],
        unplaced: [], utilization: 0.5, sheetUsed: { width: 100, height: 100 },
      })
    })
    expect(document.querySelector(`[data-testid="tree-rollup-badge-nest-${nestId}"]`)).toBeNull()
  })

  it('a collapsed geometry folder holding a projection-stale part shows the stale badge', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Parts')
      useCamStore.getState().addGeometry({
        id: 'g-stale', name: 'Rotated Body', filename: 'rotated.stl', type: 'mesh', format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
          size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        projectionStale: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      useCamStore.getState().setGeometryFolderId('g-stale', folderId)
      useUiPrefs.getState().toggleFolderCollapsed(folderId)
    })

    render(<DesignTree />)
    const badge = document.querySelector(`[data-testid="tree-rollup-badge-folder-${folderId}"]`)
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-tier')).toBe('stale')
  })

  it('an expanded operation folder shows no rollup badge even though its operation still errors (expanded rows keep their own per-row indicator instead)', () => {
    act(() => {
      useCamStore.getState().addSetup({
        id: 'setup-1', name: 'Setup 1', wcs: WCS, stock: { type: 'auto' },
        operations: [makeOp('op-error', 'error')],
        notes: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    })
    const folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    act(() => {
      useCamStore.getState().setOperationFolderId('setup-1', 'op-error', folderId)
    })
    // Operation folders default EXPANDED (uiPrefs doc); never toggled here.
    render(<DesignTree />)
    expect(document.querySelector(`[data-testid="tree-rollup-badge-opfolder-${folderId}"]`)).toBeNull()
    // The operation's own per-row status icon is still there.
    expect(screen.getByText('op-error')).not.toBeNull()
  })
})
