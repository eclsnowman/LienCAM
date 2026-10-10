// Phase 5 (P8/P9): ui-prefs slice — persisted UI setup that MUST survive
// reload (VERDICTS P8 note). These tests assert the three required behaviors:
// persist (width written to localStorage under the dedicated key), restore
// (a fresh store rehydrates the persisted width, clamped to bounds), and reset
// (double-click handle -> default). Also covers per-group collapse persistence
// used by P9 collapsible sections.
//
// The test env is 'node' (no DOM), so we install a minimal in-memory
// localStorage shim BEFORE importing the store module (the persist middleware
// binds storage at module load).

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- in-memory localStorage shim (plain object: own enumerable methods) ----
const store = new Map<string, string>()
const mem = {
  get length() { return store.size },
  clear: () => store.clear(),
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
}
vi.stubGlobal('localStorage', mem)

// Import AFTER the shim is in place.
import {
  useUiPrefs, clampPanelWidth, UI_PREFS_STORAGE_KEY, UI_PREFS_VERSION,
  PANEL_LEFT_DEFAULT, PANEL_RIGHT_DEFAULT,
  PANEL_LEFT_MIN, PANEL_LEFT_MAX, PANEL_RIGHT_MIN, PANEL_RIGHT_MAX,
  MACHINE_PANEL_LEFT_DEFAULT, MACHINE_PANEL_RIGHT_DEFAULT,
  TREE_DENSITY_DEFAULT,
  PROGRAM_PREVIEW_DEFAULT_PERCENT,
  getSelectionGlow,
  resolveUiScale,
  UI_SCALE_DEFAULT,
} from '../../store/uiPrefs'
import {
  DEFAULT_SELECTION_GLOW,
  resolveSelectionGlowColors,
} from '../../lib/viewport/lighting/selectionGlowTokens'
import { DEFAULT_VIEWPORT_THEME } from '../../lib/viewport/lighting/viewportThemes'
import { resolveModeledBodyVisualStyle } from '../../lib/viewport/lighting/bodyVisualStyle'

beforeEach(() => {
  mem.clear()
  useUiPrefs.setState({
    panelLeftWidth: PANEL_LEFT_DEFAULT,
    panelRightWidth: PANEL_RIGHT_DEFAULT,
    panelLeftWidthCustomized: false,
    panelRightWidthCustomized: false,
    collapsedPropsGroups: {},
    treeDensity: TREE_DENSITY_DEFAULT,
    collapsedFolderIds: [],
    // Refresh-persistence slices (reset to defaults for order-independence).
    treeStockExpanded: true,
    treeGeometryExpanded: true,
    treeSetupsExpanded: true,
    expandedSetupIds: [],
    expandedLayerKeys: [],
    collapsedPartIds: [],
    expandedStockIds: [],
    savedCamera: null,
    lastFilletRadius: null,
    lastChamferSetback: null,
    machineProgramPreviewPercent: PROGRAM_PREVIEW_DEFAULT_PERCENT,
    machineLeftPanelW: MACHINE_PANEL_LEFT_DEFAULT,
    machineLeftPanelWCustomized: false,
    machineRightPanelW: MACHINE_PANEL_RIGHT_DEFAULT,
    machineRightPanelWCustomized: false,
    uiScale: UI_SCALE_DEFAULT,
  })
})

describe('resolveUiScale (WO-1154)', () => {
  it('keeps a 1080p display pixel-identical in Auto', () => {
    expect(resolveUiScale('auto', 1920, 1)).toBe(1)
  })

  it('keeps a QHD display pixel-identical in Auto', () => {
    expect(resolveUiScale('auto', 2560, 1)).toBe(1)
  })

  it('uses 150% for a 4K display at Windows 100% scaling', () => {
    expect(resolveUiScale('auto', 3840, 1)).toBe(1.5)
  })

  it('does not compound Windows 150% scaling on a 4K display', () => {
    expect(resolveUiScale('auto', 2560, 1.5)).toBe(1)
  })

  it('honors a manual override independently of display dimensions', () => {
    expect(resolveUiScale(1.25, 1920, 1)).toBe(1.25)
    expect(resolveUiScale(1.5, 2560, 1.5)).toBe(1.5)
  })
})

describe('Control panel default-width eligibility (WO-1154)', () => {
  it('defaults both Control rails to scalable, uncustomized widths', () => {
    expect(useUiPrefs.getState()).toMatchObject({
      machineLeftPanelW: MACHINE_PANEL_LEFT_DEFAULT,
      machineLeftPanelWCustomized: false,
      machineRightPanelW: MACHINE_PANEL_RIGHT_DEFAULT,
      machineRightPanelWCustomized: false,
    })
  })

  it('recognizes a legacy non-default right width as operator-customized', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { machineRightPanelW: 320 },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().machineRightPanelW).toBe(320)
    expect(useUiPrefs.getState().machineRightPanelWCustomized).toBe(true)
  })
})

describe('clampPanelWidth', () => {
  it('clamps the left panel to its bounds', () => {
    expect(clampPanelWidth('left', 100)).toBe(PANEL_LEFT_MIN)
    expect(clampPanelWidth('left', 9999)).toBe(PANEL_LEFT_MAX)
    expect(clampPanelWidth('left', 320)).toBe(320)
  })
  it('clamps the right panel to its bounds', () => {
    expect(clampPanelWidth('right', 100)).toBe(PANEL_RIGHT_MIN)
    expect(clampPanelWidth('right', 9999)).toBe(PANEL_RIGHT_MAX)
    expect(clampPanelWidth('right', 380)).toBe(380)
  })
  it('falls back to default on non-finite input', () => {
    expect(clampPanelWidth('left', NaN)).toBe(PANEL_LEFT_DEFAULT)
    expect(clampPanelWidth('right', Infinity)).toBe(PANEL_RIGHT_DEFAULT)
  })
  it('rounds fractional widths', () => {
    expect(clampPanelWidth('left', 300.7)).toBe(301)
  })
})

describe('setPanelWidth + persistence (P8)', () => {
  it('sets and clamps a live width', () => {
    useUiPrefs.getState().setPanelWidth('right', 380)
    expect(useUiPrefs.getState().panelRightWidth).toBe(380)
    expect(useUiPrefs.getState().panelRightWidthCustomized).toBe(true)
    useUiPrefs.getState().setPanelWidth('right', 99999)
    expect(useUiPrefs.getState().panelRightWidth).toBe(PANEL_RIGHT_MAX)
  })

  it('PERSISTS the width to localStorage under the dedicated key', () => {
    useUiPrefs.getState().setPanelWidth('right', 360)
    const raw = mem.getItem(UI_PREFS_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.panelRightWidth).toBe(360)
  })

  it('RESTORES (rehydrates) the persisted width on a fresh hydrate, clamped', () => {
    // Simulate a prior session having written an out-of-bounds value.
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 9999, panelRightWidth: 300, collapsedPropsGroups: { 'op-heights': true } },
      version: 0,
    }))
    // Rehydrate from storage (what a page reload does).
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_MAX) // clamped
    expect(useUiPrefs.getState().panelRightWidth).toBe(300)           // in-bounds, restored
    expect(useUiPrefs.getState().collapsedPropsGroups['op-heights']).toBe(true)
  })
})

describe('resetPanelWidth (P8 double-click handle)', () => {
  it('resets each panel to its default', () => {
    useUiPrefs.getState().setPanelWidth('left', 420)
    useUiPrefs.getState().setPanelWidth('right', 420)
    useUiPrefs.getState().resetPanelWidth('left')
    useUiPrefs.getState().resetPanelWidth('right')
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT)
    expect(useUiPrefs.getState().panelRightWidth).toBe(PANEL_RIGHT_DEFAULT)
    expect(useUiPrefs.getState().panelLeftWidthCustomized).toBe(false)
    expect(useUiPrefs.getState().panelRightWidthCustomized).toBe(false)
  })
})

describe('collapsed props groups (P9)', () => {
  it('toggles per-group state and reports it', () => {
    expect(useUiPrefs.getState().isPropsGroupCollapsed('op-heights')).toBe(false)
    useUiPrefs.getState().togglePropsGroup('op-heights')
    expect(useUiPrefs.getState().isPropsGroupCollapsed('op-heights')).toBe(true)
    useUiPrefs.getState().togglePropsGroup('op-heights')
    expect(useUiPrefs.getState().isPropsGroupCollapsed('op-heights')).toBe(false)
  })

  it('persists collapse state across a rehydrate', () => {
    useUiPrefs.getState().togglePropsGroup('op-passes')
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.collapsedPropsGroups['op-passes']).toBe(true)
  })
})

describe('tree density (Phase 6, P10)', () => {
  it('defaults to "compact" (Tier 4 declutter)', () => {
    expect(useUiPrefs.getState().treeDensity).toBe('compact')
    expect(TREE_DENSITY_DEFAULT).toBe('compact')
  })

  it('toggles between default and compact', () => {
    // Pin a known start so the assertions don't depend on the default value.
    useUiPrefs.getState().setTreeDensity('default')
    useUiPrefs.getState().toggleTreeDensity()
    expect(useUiPrefs.getState().treeDensity).toBe('compact')
    useUiPrefs.getState().toggleTreeDensity()
    expect(useUiPrefs.getState().treeDensity).toBe('default')
  })

  it('setTreeDensity sets the value directly', () => {
    useUiPrefs.getState().setTreeDensity('compact')
    expect(useUiPrefs.getState().treeDensity).toBe('compact')
  })

  it('PERSISTS density to localStorage under the dedicated key', () => {
    useUiPrefs.getState().setTreeDensity('compact')
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.treeDensity).toBe('compact')
  })

  it('RESTORES persisted density on rehydrate (reload survives)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {}, treeDensity: 'compact' },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().treeDensity).toBe('compact')
  })

  it('RESTORES an explicitly persisted "default" density (not clobbered by the new compact default)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {}, treeDensity: 'default' },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().treeDensity).toBe('default')
  })

  it('falls back to the default (compact) for a missing/invalid persisted density', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().treeDensity).toBe(TREE_DENSITY_DEFAULT)
    expect(useUiPrefs.getState().treeDensity).toBe('compact')
  })
})

describe('geometry-folder collapse (Stage A)', () => {
  it('defaults a folder to EXPANDED (not collapsed)', () => {
    expect(useUiPrefs.getState().isFolderCollapsed('fold-1')).toBe(false)
  })

  it('toggles a folder collapsed/expanded and reports it', () => {
    useUiPrefs.getState().toggleFolderCollapsed('fold-1')
    expect(useUiPrefs.getState().isFolderCollapsed('fold-1')).toBe(true)
    expect(useUiPrefs.getState().collapsedFolderIds).toEqual(['fold-1'])
    useUiPrefs.getState().toggleFolderCollapsed('fold-1')
    expect(useUiPrefs.getState().isFolderCollapsed('fold-1')).toBe(false)
    expect(useUiPrefs.getState().collapsedFolderIds).toEqual([])
  })

  it('tracks multiple folders independently', () => {
    useUiPrefs.getState().toggleFolderCollapsed('a')
    useUiPrefs.getState().toggleFolderCollapsed('b')
    expect(useUiPrefs.getState().isFolderCollapsed('a')).toBe(true)
    expect(useUiPrefs.getState().isFolderCollapsed('b')).toBe(true)
    useUiPrefs.getState().toggleFolderCollapsed('a')
    expect(useUiPrefs.getState().isFolderCollapsed('a')).toBe(false)
    expect(useUiPrefs.getState().isFolderCollapsed('b')).toBe(true)
  })

  it('PERSISTS collapsed folder ids to localStorage under the dedicated key', () => {
    useUiPrefs.getState().toggleFolderCollapsed('fold-x')
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.collapsedFolderIds).toEqual(['fold-x'])
  })

  it('RESTORES collapsed folder ids on rehydrate (reload survives)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        treeDensity: 'default', collapsedFolderIds: ['keep-me'],
      },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().collapsedFolderIds).toEqual(['keep-me'])
    expect(useUiPrefs.getState().isFolderCollapsed('keep-me')).toBe(true)
  })

  it('falls back to [] for a missing/invalid persisted folder list', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().collapsedFolderIds).toEqual([])
  })
})

// ── Tree expand/collapse refresh-persistence (Part 1) ──────────────────────
describe('tree section expand/collapse persistence', () => {
  it('defaults all three sections to EXPANDED (true)', () => {
    expect(useUiPrefs.getState().treeStockExpanded).toBe(true)
    expect(useUiPrefs.getState().treeGeometryExpanded).toBe(true)
    expect(useUiPrefs.getState().treeSetupsExpanded).toBe(true)
  })

  it('toggleTreeSection flips one section; setTreeSectionExpanded sets it', () => {
    useUiPrefs.getState().toggleTreeSection('geometry')
    expect(useUiPrefs.getState().treeGeometryExpanded).toBe(false)
    expect(useUiPrefs.getState().treeStockExpanded).toBe(true)   // others untouched
    useUiPrefs.getState().setTreeSectionExpanded('geometry', true)
    expect(useUiPrefs.getState().treeGeometryExpanded).toBe(true)
    useUiPrefs.getState().setTreeSectionExpanded('setups', false)
    expect(useUiPrefs.getState().treeSetupsExpanded).toBe(false)
  })

  it('PERSISTS a collapsed section to localStorage', () => {
    useUiPrefs.getState().setTreeSectionExpanded('geometry', false)
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.treeGeometryExpanded).toBe(false)
  })

  it('RESTORES an explicitly-collapsed section on rehydrate (the merge-fix)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        treeGeometryExpanded: false,
      },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().treeGeometryExpanded).toBe(false)
    // Absent flags fall back to the default (true), not clobbered.
    expect(useUiPrefs.getState().treeStockExpanded).toBe(true)
    expect(useUiPrefs.getState().treeSetupsExpanded).toBe(true)
  })

  it('falls back to expanded for missing section flags (old stored prefs)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().treeGeometryExpanded).toBe(true)
  })
})

describe('tree node expand/collapse id lists persistence', () => {
  it('toggle + bulk-set the setup / layer / part / stock id lists', () => {
    useUiPrefs.getState().toggleExpandedSetup('s1')
    expect(useUiPrefs.getState().expandedSetupIds).toEqual(['s1'])
    useUiPrefs.getState().toggleExpandedSetup('s1')
    expect(useUiPrefs.getState().expandedSetupIds).toEqual([])

    useUiPrefs.getState().toggleExpandedLayer('g1:l1')
    expect(useUiPrefs.getState().expandedLayerKeys).toEqual(['g1:l1'])

    useUiPrefs.getState().toggleCollapsedPart('g1')
    expect(useUiPrefs.getState().collapsedPartIds).toEqual(['g1'])

    useUiPrefs.getState().setExpandedStockIds(['stk1', 'stk2'])
    expect(useUiPrefs.getState().expandedStockIds).toEqual(['stk1', 'stk2'])
    // addExpandedStock is idempotent (no duplicate on re-add).
    useUiPrefs.getState().addExpandedStock('stk1')
    useUiPrefs.getState().addExpandedStock('stk3')
    expect(useUiPrefs.getState().expandedStockIds).toEqual(['stk1', 'stk2', 'stk3'])
  })

  it('PERSISTS then RESTORES the id lists on rehydrate', () => {
    useUiPrefs.getState().toggleExpandedSetup('keep-setup')
    useUiPrefs.getState().toggleCollapsedPart('keep-part')
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.expandedSetupIds).toEqual(['keep-setup'])
    expect(raw.state.collapsedPartIds).toEqual(['keep-part'])

    // Simulate a prior session and rehydrate (what a refresh does).
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        expandedSetupIds: ['rs'], expandedLayerKeys: ['rg:rl'],
        collapsedPartIds: ['rp'], expandedStockIds: ['rstk'],
      },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().expandedSetupIds).toEqual(['rs'])
    expect(useUiPrefs.getState().expandedLayerKeys).toEqual(['rg:rl'])
    expect(useUiPrefs.getState().collapsedPartIds).toEqual(['rp'])
    expect(useUiPrefs.getState().expandedStockIds).toEqual(['rstk'])
  })

  it('falls back to [] for missing id lists (old stored prefs)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().expandedSetupIds).toEqual([])
    expect(useUiPrefs.getState().expandedStockIds).toEqual([])
  })
})

// ── Camera refresh-persistence (Part 2) ────────────────────────────────────
describe('saved camera persistence', () => {
  const cam = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], zoom: 1.5 }

  it('defaults to null', () => {
    expect(useUiPrefs.getState().savedCamera).toBeNull()
  })

  it('setSavedCamera stores the pose keyed by project id', () => {
    useUiPrefs.getState().setSavedCamera('proj-1', cam)
    expect(useUiPrefs.getState().savedCamera).toEqual({ projectId: 'proj-1', camera: cam })
  })

  it('PERSISTS then RESTORES the saved camera on rehydrate', () => {
    useUiPrefs.getState().setSavedCamera('proj-1', cam)
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.savedCamera).toEqual({ projectId: 'proj-1', camera: cam })

    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        savedCamera: { projectId: 'proj-2', camera: cam },
      },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().savedCamera).toEqual({ projectId: 'proj-2', camera: cam })
  })

  it('falls back to null for missing savedCamera (old stored prefs)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: 0,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().savedCamera).toBeNull()
  })
})

// ---- SKC-46: staged-size (fillet radius / chamfer setback) memory ---------------------------

describe('staged-size memory (SKC-46)', () => {
  it('defaults to null for both tools', () => {
    expect(useUiPrefs.getState().lastFilletRadius).toBeNull()
    expect(useUiPrefs.getState().lastChamferSetback).toBeNull()
  })

  it('setLastFilletRadius / setLastChamferSetback store independently (per-tool memory)', () => {
    useUiPrefs.getState().setLastFilletRadius(6)
    expect(useUiPrefs.getState().lastFilletRadius).toBe(6)
    expect(useUiPrefs.getState().lastChamferSetback).toBeNull()
    useUiPrefs.getState().setLastChamferSetback(3)
    expect(useUiPrefs.getState().lastChamferSetback).toBe(3)
    expect(useUiPrefs.getState().lastFilletRadius).toBe(6) // unaffected by the chamfer write
  })

  it('rejects a non-finite / zero / negative write (charter item 3: no invalid value sails through)', () => {
    useUiPrefs.getState().setLastFilletRadius(6)
    useUiPrefs.getState().setLastFilletRadius(NaN)
    useUiPrefs.getState().setLastFilletRadius(0)
    useUiPrefs.getState().setLastFilletRadius(-4)
    useUiPrefs.getState().setLastFilletRadius(Infinity)
    expect(useUiPrefs.getState().lastFilletRadius).toBe(6) // every rejected write left it alone
  })

  it('PERSISTS then RESTORES the last size on rehydrate', () => {
    useUiPrefs.getState().setLastFilletRadius(7.5)
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.lastFilletRadius).toBe(7.5)

    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        lastFilletRadius: 12, lastChamferSetback: 2.5,
      },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().lastFilletRadius).toBe(12)
    expect(useUiPrefs.getState().lastChamferSetback).toBe(2.5)
  })

  it('falls back to null for missing fields (old stored prefs)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().lastFilletRadius).toBeNull()
    expect(useUiPrefs.getState().lastChamferSetback).toBeNull()
  })

  it('merge guard: a tampered stored value (0 / negative / non-numeric) falls back to null', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { lastFilletRadius: -5, lastChamferSetback: 'bogus' },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().lastFilletRadius).toBeNull()
    expect(useUiPrefs.getState().lastChamferSetback).toBeNull()
  })
})

// ---- WO-270: brand identity, not a free for all -----------------------------
//
// The Settings > Display selectors for UI theme, Viewport theme and Selection
// glow are GONE, and with them their setters, their persist validation and the
// one-time legacy dev-gate migration. What used to be three preference suites
// here (round-trip, invalid-write rejection, tampered-value fallback, legacy
// key migration) is now one question worth asking: can a value left over from
// the removed controls still reach the app? It cannot.

describe('frozen appearance (WO-270)', () => {
  it('WO-1200 persists color mode independently from the identity theme', () => {
    const beforeTheme = useUiPrefs.getState().uiTheme
    expect(useUiPrefs.getState().uiColorMode).toBe('dark')
    useUiPrefs.getState().setUiColorMode('light')
    expect(useUiPrefs.getState()).toMatchObject({ uiTheme: beforeTheme, uiColorMode: 'light' })
    expect(JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!).state.uiColorMode).toBe('light')
    useUiPrefs.getState().setUiColorMode('dark')
  })

  // WO-324 (Operator: "Make it an alternate theme in settings. I will need to
  // drive it for a while before I can decide.") brings setUiTheme back as a
  // real, validated setter -- it is no longer one of the frozen three.
  // Viewport theme and Selection glow are unaffected and still have none.
  it('exposes no setter for Viewport theme or Selection glow; Theme keeps a real one', () => {
    const state = useUiPrefs.getState() as unknown as Record<string, unknown>
    expect(state.setViewportTheme).toBeUndefined()
    expect(state.setSelectionGlow).toBeUndefined()
    expect(typeof state.setUiTheme).toBe('function')
  })

  it('ships one viewport theme and one selection glow', () => {
    expect(useUiPrefs.getState().viewportTheme).toBe(DEFAULT_VIEWPORT_THEME)
    expect(useUiPrefs.getState().selectionGlow).toBe(DEFAULT_SELECTION_GLOW)
    expect(getSelectionGlow()).toBe(DEFAULT_SELECTION_GLOW)
  })

  it('IGNORES a stored value from the removed controls on rehydrate -- the case that bites', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 300, panelRightWidth: 260, collapsedPropsGroups: {},
        viewportTheme: 'deep-slate',
        selectionGlow: 'brightness-halo',
        uiTheme: 'high-contrast',
      },
      version: UI_PREFS_VERSION,
    }))
    expect(() => useUiPrefs.persist.rehydrate()).not.toThrow()

    expect(useUiPrefs.getState().viewportTheme).toBe(DEFAULT_VIEWPORT_THEME)
    expect(useUiPrefs.getState().selectionGlow).toBe(DEFAULT_SELECTION_GLOW)
    expect(getSelectionGlow()).toBe(DEFAULT_SELECTION_GLOW)
    // Unrelated prefs in the SAME blob still rehydrate -- ignoring the removed
    // three must not cost a user their panel layout.
    expect(useUiPrefs.getState().panelLeftWidth).toBe(300)
  })

  // ---- WO-286 -------------------------------------------------------------
  //
  // CNCViewport.ts used to field-init `viewportThemeId` from
  // useUiPrefs.getState().viewportTheme and `selectionGlow` from
  // getSelectionGlow(), then subscribe to both. WO-270 had already pinned
  // those two store fields to the shipped constants, so the reads resolved one
  // value and the subscriptions could never fire. WO-286 points the viewport
  // at the constants directly.
  //
  // These assert the RESOLVED LOOK rather than the wiring: the values the
  // viewport paints from must be the ones it painted from before, and the
  // stored-value guarantee must be worth something (a look the user picked is
  // genuinely different from the shipped one, so "ignored" is not vacuous).

  it('WO-286: the constants the viewport imports resolve the look the store handed it', () => {
    const fromStore = resolveModeledBodyVisualStyle(useUiPrefs.getState().viewportTheme)
    const fromConstant = resolveModeledBodyVisualStyle(DEFAULT_VIEWPORT_THEME)
    expect(fromConstant).toEqual(fromStore)

    const glowFromStore = resolveSelectionGlowColors(
      getSelectionGlow(), useUiPrefs.getState().viewportTheme,
    )
    const glowFromConstant = resolveSelectionGlowColors(
      DEFAULT_SELECTION_GLOW, DEFAULT_VIEWPORT_THEME,
    )
    expect(glowFromConstant).toEqual(glowFromStore)
  })

  it('WO-286: a stored look really is a DIFFERENT look, so ignoring it is a real guarantee', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { viewportTheme: 'deep-slate', selectionGlow: 'brightness-halo' },
      version: UI_PREFS_VERSION,
    }))
    expect(() => useUiPrefs.persist.rehydrate()).not.toThrow()

    // What the viewport paints after a rehydrate from that blob.
    expect(resolveModeledBodyVisualStyle(DEFAULT_VIEWPORT_THEME))
      .not.toEqual(resolveModeledBodyVisualStyle('deep-slate'))
    expect(resolveSelectionGlowColors(DEFAULT_SELECTION_GLOW, DEFAULT_VIEWPORT_THEME))
      .not.toEqual(resolveSelectionGlowColors('brightness-halo', 'deep-slate'))
  })

  it('does not delete the stored values it ignores (Operator did not ask for that)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { uiTheme: 'high-contrast' },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    const raw = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.uiTheme).toBe('high-contrast')
  })
})

// ---- WO-137: program preview/list divider percent (declared + validated) ----
//
// machineProgramPreviewPercent was injected at runtime by WO-117 (undeclared
// in UiPrefsState, unvalidated in merge). WO-137 declares it and validates it
// on rehydrate so a future field allowlist cannot silently drop it.

describe('machineProgramPreviewPercent (WO-137)', () => {
  it('defaults to PROGRAM_PREVIEW_DEFAULT_PERCENT (60)', () => {
    expect(PROGRAM_PREVIEW_DEFAULT_PERCENT).toBe(60)
    expect(useUiPrefs.getState().machineProgramPreviewPercent).toBe(60)
  })

  it('RESTORES a valid in-range percent on rehydrate (round-trip)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        machineProgramPreviewPercent: 70.1,
      },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().machineProgramPreviewPercent).toBe(70.1)
  })

  it('falls back to 60 for a missing field (old / pre-WO-137 stored prefs)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {} },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().machineProgramPreviewPercent).toBe(60)
  })

  it('falls back to 60 for a non-number persisted value (tampered storage)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        machineProgramPreviewPercent: 'bogus',
      },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().machineProgramPreviewPercent).toBe(60)
  })

  it('falls back to 60 for an out-of-range persisted value (> 100 or < 0)', () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        machineProgramPreviewPercent: 150,
      },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().machineProgramPreviewPercent).toBe(60)

    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: {
        panelLeftWidth: 280, panelRightWidth: 260, collapsedPropsGroups: {},
        machineProgramPreviewPercent: -5,
      },
      version: UI_PREFS_VERSION,
    }))
    useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().machineProgramPreviewPercent).toBe(60)
  })
})
