import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { NumericInput, OptionalNumericInput } from '../ui/NumericInput'
import { DisclosureSection } from '../ui/DisclosureSection'
import {
  X, Plus, Trash2, Upload, Download, Check,
  Wrench, ChevronRight, ChevronDown, Copy, Pencil, Library,
  ChevronUp,
} from 'lucide-react'
import { useCamStore } from '../../store'
import { importFusionTools, decodeToolLibraryFile, serializeHolderForFusion, parseFusionHolder, type FusionHolder } from '../../lib/fusionImporter'
import { rpmInMachineRange } from '../../lib/machine/spindleRange'
import { validateToolGeometry, validateToolRecordShape, type RecordDiagnostic } from '../../lib/tool/toolValidation'
import { ToolDiagram } from './ToolDiagram'
import {
  fmtDim, unitLabel, feedLabel,
  toDisplay, fromDisplay,
  surfaceSpeedToDisplay, surfaceSpeedFromDisplay, surfaceSpeedLabel,
} from '../../lib/ui/unitFormat'
import type { Tool, ToolType, ToolMaterial, ToolCoating, ToolCutHand, FeedsAndSpeeds, Units, ToolHolder, HolderSegment, ProbeContact } from '../../types'
import { DEFAULT_TOOL_LIBRARY_ID } from '../../store/migrations/projectMigrations'
import { TOOL_TYPE_ORDER, toolTypeMeta, fieldRelevanceForType } from '../../lib/tool/toolMeta'
import { buildHolderProfile } from '../../lib/tool/toolProfile'
import { normalizeToolCutHand } from '../../lib/tool/cutHand'
import { probeContactOf, probeInputOf } from '../../lib/tool/probeTool'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { saveFile } from '../../lib/saveFile'
import { useUiPrefs, resolveUiScale } from '../../store/uiPrefs'
import { ResizableSplit } from '../common/ResizableSplit'
import { PanelCollapseToggle, usePanelCollapsed } from '../common/CollapsiblePanel'

/** WO-2434: stored width of the tool list pane (uiPrefs.panelSizes) and its
 *  collapsed state (uiPrefs.collapsedPropsGroups). Default/min = the old fixed
 *  315px / 270px column; the editor keeps room for its diagram (360px) plus a
 *  form beside it. 400: .tool-modal-body is overflow:hidden, so a wider minimum
 *  pushes the diagram past the modal edge in a small window (1024x900 clipped
 *  at 800); main's editor had no minimum beyond the diagram's own 360. */
export const TOOL_LIST_PANE_KEY = 'tool-library-list'
export const TOOL_LIST_PANE_DEFAULT = 315
export const TOOL_LIST_PANE_MIN = 270
export const TOOL_LIST_PANE_MAX = 400
/** The editor keeps what the old fixed layout gave it - the dialog width less
 *  the default list and the bar - up to this much: the diagram's 360px plus a
 *  540px form (two fields per row, 128px label each). So the list can only
 *  grow while the editor stays at or above its default width (the 1200x900
 *  dialog is never squeezed below what main drew), and a small window cannot
 *  be pushed past its edge. */
export const TOOL_EDITOR_PANE_MIN = 900
const TOOL_SPLIT_BAR = 8

// ── Constants ────────────────────────────────────────────────────────────────

// Dropdown / list order + labels come from the single source of truth
// (src/lib/tool/toolMeta.ts) so the order is logical and shared with the
// diagram + angle-field logic. (value + label projection of the meta table.)
const TOOL_TYPES: { value: ToolType; label: string }[] =
  TOOL_TYPE_ORDER.map(type => ({ value: type, get label() { return words(`ToolLibraryModal.toolTypes.${type}`) } }))

const MATERIALS: { value: ToolMaterial; label: string }[] = [
  { value: 'carbide',        get label() { return words("ToolLibraryModal.carbide") }          },
  { value: 'hss',            get label() { return words("ToolLibraryModal.hss") }              },
  { value: 'cobalt',         get label() { return words("ToolLibraryModal.cobalt") }           },
  { value: 'ceramic',        get label() { return words("ToolLibraryModal.ceramic") }          },
  { value: 'diamond_coated', get label() { return words("ToolLibraryModal.diamond_coated") }   },
]

const COATINGS: { value: ToolCoating; label: string }[] = [
  { value: 'none',   get label() { return words("ToolLibraryModal.none_uncoated") }   },
  { value: 'tin',    get label() { return words("ToolLibraryModal.tin_gold") }         },
  { value: 'ticn',   get label() { return words("ToolLibraryModal.ticn_grey_gold") }   },
  { value: 'tialn',  get label() { return words("ToolLibraryModal.tialn_violet") }     },
  { value: 'dlc',    get label() { return words("ToolLibraryModal.dlc_black") }        },
  { value: 'zrn',    get label() { return words("ToolLibraryModal.zrn_pale_gold") }    },
]

const COOLANT_OPTS = [
  { value: 'none',  get label() { return words("ToolLibraryModal.none") }   },
  { value: 'flood', get label() { return words("ToolLibraryModal.flood") }  },
  { value: 'mist',  get label() { return words("ToolLibraryModal.mist") }   },
  { value: 'air',   get label() { return words("ToolLibraryModal.air") }    },
]

// ── Material recommendations (conservative for hobby CNC, 1–3 HP) ─────────────

const MATERIAL_RECS = [
  { get mat() { return words("ToolLibraryModal.softwood") },       vc: '350–700',   fz: '0.06–0.15',  get notes() { return words("ToolLibraryModal.any_carbide_o_flute_also_good") } },
  { get mat() { return words("ToolLibraryModal.hardwood") },       vc: '200–400',   fz: '0.04–0.10',  get notes() { return words("ToolLibraryModal.sharp_tools_watch_grain_direction") } },
  { get mat() { return words("ToolLibraryModal.mdf_plywood") },  vc: '300–600',   fz: '0.06–0.15',  get notes() { return words("ToolLibraryModal.vacuum_dust_abrasive_on_tools") } },
  { get mat() { return words("ToolLibraryModal.acrylic_pmma") }, vc: '100–250',   fz: '0.04–0.10',  get notes() { return words("ToolLibraryModal.o_flute_preferred_air_blast_avoid_heat") } },
  { get mat() { return words("ToolLibraryModal.hdpe_nylon") },   vc: '150–300',   fz: '0.05–0.15',  get notes() { return words("ToolLibraryModal.good_chip_clearing_avoid_sticky_chips") } },
  { get mat() { return words("ToolLibraryModal.abs_pom") },      vc: '100–200',   fz: '0.04–0.10',  get notes() { return words("ToolLibraryModal.watch_heat_buildup_use_sharp_tools") } },
  { get mat() { return words("ToolLibraryModal.foam_rigid") },    vc: '500–1500',  fz: '0.15–0.40',  get notes() { return words("ToolLibraryModal.any_speed_vacuum_dust_collection_essential") } },
  { get mat() { return words("ToolLibraryModal.aluminium_6061") }, vc: '50–150',    fz: '0.010–0.025',get notes() { return words("ToolLibraryModal.air_mist_coolant_clear_chips_aggressively") } },
  { get mat() { return words("ToolLibraryModal.brass") },          vc: '50–100',    fz: '0.010–0.025',get notes() { return words("ToolLibraryModal.2_flute_carbide_no_coolant_ok") } },
  { get mat() { return words("ToolLibraryModal.mild_steel") },     vc: '15–40',     fz: '0.008–0.018',get notes() { return words("ToolLibraryModal.very_rigid_setup_flood_coolant_if_possible") } },
  { get mat() { return words("ToolLibraryModal.carbon_fibre") },   vc: '100–200',   fz: '0.020–0.050',get notes() { return words("ToolLibraryModal.diamond_coated_bits_vacuum_never_flood") } },
] as const

type TabId = 'general' | 'cutter' | 'feeds' | 'post'

// ── Blank factory ────────────────────────────────────────────────────────────

function blankTool(): Tool {
  // WO-1748: the starting spindle speed reads the machine the project is on,
  // through the ONE in-range helper the new-operation feed seed uses. A
  // machine that states no range keeps 18000 as a plain suggestion.
  const machine = useCamStore.getState().project?.machine
  return {
    id: crypto.randomUUID(),
    name: words("ToolLibraryModal.new_tool"),
    type: 'flat_end_mill',
    diameter: 6,
    shankDiameter: 6,
    overallLength: 50,
    fluteLength: 18,
    shoulderLength: 0,
    lengthBelowHolder: undefined,
    numberOfFlutes: 2,
    cornerRadius: 0,
    angleFromAxisDeg: 59,
    material: 'carbide',
    coating: 'none',
    vendor: '',
    productId: '',
    toolNumber: undefined,
    cutHand: 'right',
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: rpmInMachineRange(18000, machine),
        feedRate: 1500,
        plungeRate: 500,
        depthOfCut: 1.5,
        stepover: 3,
        rampFeedrate: 750,
        leadInFeedrate: 1500,
        leadOutFeedrate: 1500,
        fastTraverseFeedrate: 3000,
        rampAngle: 2,
        coolant: 'none',
      },
    },
  }
}

// ── Type label helper ─────────────────────────────────────────────────────────

function typeLabel(t: ToolType): string {
  return TOOL_TYPES.find(x => x.value === t)?.label ?? t
}

// ── Main component ────────────────────────────────────────────────────────────

export function ToolLibraryModal() {
  const words = useText('setup-stock-tools-machine-post')
  const activeModal  = useCamStore((s) => s.activeModal)
  const closeModal   = useCamStore((s) => s.closeModal)
  const toolLibrary  = useCamStore((s) => s.toolLibrary)
  const toolLibraries = useCamStore((s) => s.toolLibraries)
  const addTool      = useCamStore((s) => s.addTool)
  const updateTool   = useCamStore((s) => s.updateTool)
  const removeTool   = useCamStore((s) => s.removeTool)
  const addToolLibrary    = useCamStore((s) => s.addToolLibrary)
  const renameToolLibrary = useCamStore((s) => s.renameToolLibrary)
  const removeToolLibrary = useCamStore((s) => s.removeToolLibrary)
  const duplicateTool     = useCamStore((s) => s.duplicateTool)
  const addConsoleEvent   = useCamStore((s) => s.addConsoleEvent)
  const holders      = useCamStore((s) => s.holders)
  const addHolder    = useCamStore((s) => s.addHolder)
  const updateHolder = useCamStore((s) => s.updateHolder)
  const removeHolder = useCamStore((s) => s.removeHolder)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)

  const isOpen = activeModal === 'tool-library'
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()
  const listCollapsed = usePanelCollapsed(TOOL_LIST_PANE_KEY)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(0)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setBodyWidth(el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  })
  // The list column's text, gaps and padding are rem-scaled by the interface
  // scale, so its pixel bounds scale with it (main: 19.6875rem / 16.875rem).
  const uiScalePreference = useUiPrefs((s) => s.uiScale)
  const [viewport, setViewport] = useState(() => ({
    cssWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    dpr: typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1),
  }))
  useEffect(() => {
    const sync = () => setViewport({ cssWidth: window.innerWidth, dpr: window.devicePixelRatio || 1 })
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  const uiScale = resolveUiScale(uiScalePreference, viewport.cssWidth, viewport.dpr)
  const listDefault = Math.round(TOOL_LIST_PANE_DEFAULT * uiScale)
  const listMin = Math.round(TOOL_LIST_PANE_MIN * uiScale)
  const listMax = Math.round(TOOL_LIST_PANE_MAX * uiScale)
  const editorPaneMin = bodyWidth > 0
    ? Math.min(TOOL_EDITOR_PANE_MIN, Math.max(0, bodyWidth - listDefault - TOOL_SPLIT_BAR))
    : TOOL_EDITOR_PANE_MIN

  // Top-level view: the Tools library editor, or the Holders editor. Holders are
  // a sibling library (a tool references one via holderId); editing them happens
  // in its own view so the tool editor stays focused.
  const [view, setView] = useState<'tools' | 'holders'>('tools')
  const [selectedHolderId, setSelectedHolderId] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft,      setDraft]      = useState<Tool | null>(null)
  const [isDirty,    setIsDirty]    = useState(false)
  const [saved,      setSaved]      = useState(false)
  // WO UI-11B alert() policy: tool-import success/fail is now a console event
  // + this non-blocking inline readout (replaces window.alert), auto-clears
  // like the Save confirmation (`saved`) above.
  const [importFeedback, setImportFeedback] = useState<{ kind: 'success' | 'warning' | 'error'; text: string } | null>(null)
  const [activeTab,     setActiveTab]     = useState<TabId>('cutter')
  const [showFeedsHelp, setShowFeedsHelp] = useState(false)
  const [showAngleHelp, setShowAngleHelp] = useState(false)

  // Left-list navigation: search + filters + sort. The library grows long in a
  // real shop, so the flat type-grouped list needs find/narrow controls. These
  // are sticky across opens (the shop's working view), and never touch storage.
  // Selected LIBRARY scope. 'all' = show every tool across all libraries;
  // otherwise a ToolLibrary.id scopes the tool list + the find/filter/sort
  // controls below to that library. Sticky across opens (the shop's view).
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | 'all'>('all')
  const [renamingLibrary,   setRenamingLibrary]   = useState(false)
  const [libraryNameDraft,  setLibraryNameDraft]  = useState('')

  const [search,         setSearch]         = useState('')
  const [filterType,     setFilterType]     = useState<ToolType | 'all'>('all')
  const [filterMaterial, setFilterMaterial] = useState<ToolMaterial | 'all'>('all')
  const [sortMode,       setSortMode]       = useState<'type' | 'name' | 'diameter' | 'tnumber'>('type')
  // Collapsed type groups (Type sort only). A set of the tool types whose
  // section is currently folded shut.
  const [collapsedTypes, setCollapsedTypes] = useState<Set<ToolType>>(new Set())

  const importRef = useRef<HTMLInputElement>(null)

  // A pristine new draft is saveable even though it is not "dirty". Keep
  // creation state separate from edit state so discard warnings remain tied
  // only to changes the operator actually made.
  const isUnsavedNew = draft !== null && selectedId === null

  useEffect(() => {
    if (!isOpen) return
    const first = toolLibrary[0] ?? null
    if (first) { setSelectedId(first.id); setDraft({ ...first }) }
    else       { setSelectedId(null);     setDraft(null)         }
    setIsDirty(false)
    setSaved(false)
    setView('tools')
    setSelectedHolderId(holders[0]?.id ?? null)
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null

  // ── Handlers ────────────────────────────────────────────────────────────────

  // Tool edits live ONLY in `draft` and persist ONLY via Save (commitDraft).
  // Any action that would abandon an unsaved draft (close, switch tool, New)
  // first asks to discard, so closing with the X never silently keeps an edit.
  // WO-1268: the app's own themed dialog instead of the native bubble. An
  // unsaved draft is local state no Undo restores, so the prompt is
  // legitimate; a clean draft asks nothing and the action runs synchronously.
  const withDiscard = (action: () => void): void => {
    if (!isDirty) { action(); return }
    void useCamStore.getState().requestConfirm({
      title: words("ToolLibraryModal.discard_unsaved_changes"),
      body: words("ToolLibraryModal.this_tool_has_edits_that_were_not"),
      confirmLabel: words("ToolLibraryModal.discard"),
      cancelLabel: words("ToolLibraryModal.keep_editing"),
      tone: 'danger',
    }).then((ok) => { if (ok) action() })
  }

  const handleSelect = (t: Tool) => withDiscard(() => {
    setSelectedId(t.id)
    setDraft({ ...t })
    setIsDirty(false)
    setSaved(false)
  })

  // The library a freshly-created / duplicated tool should land in: the selected
  // library, or the default library when "All libraries" is the active scope.
  const targetLibraryId = () =>
    selectedLibraryId === 'all'
      ? (toolLibraries[0]?.id ?? DEFAULT_TOOL_LIBRARY_ID)
      : selectedLibraryId

  const handleNew = () => withDiscard(() => {
    // A new tool is a local draft (selectedId = null); it is NOT added to the
    // library until Save (commitDraft takes the addTool path). It is tagged with
    // the currently-selected library so Save lands it in the right place.
    setSelectedId(null)
    setDraft({ ...blankTool(), libraryId: targetLibraryId() })
    setIsDirty(false)
    setSaved(false)
    setActiveTab('cutter')
  })

  const handleDuplicate = () => {
    if (!selectedId) return
    withDiscard(() => {
      const newId = duplicateTool(selectedId)
      if (!newId) return
      // Select the copy for editing (read it back from the freshly-updated store).
      const copy = useCamStore.getState().toolLibrary.find(t => t.id === newId)
      if (copy) { setSelectedId(newId); setDraft({ ...copy }) }
      setIsDirty(false)
      setSaved(false)
    })
  }

  // ── Library handlers ──────────────────────────────────────────────────────

  const handleAddLibrary = () => withDiscard(() => {
    const name = window.prompt(words("ToolLibraryModal.new_library_name"), words("ToolLibraryModal.new_library"))
    if (name == null) return
    const trimmed = name.trim() || words("ToolLibraryModal.new_library")
    const id = addToolLibrary(trimmed)
    setSelectedLibraryId(id)
    // No tools yet in the new library — clear the editor.
    setSelectedId(null)
    setDraft(null)
    setIsDirty(false)
  })

  const beginRenameLibrary = () => {
    if (selectedLibraryId === 'all') return
    const lib = toolLibraries.find(l => l.id === selectedLibraryId)
    setLibraryNameDraft(lib?.name ?? '')
    setRenamingLibrary(true)
  }

  const commitRenameLibrary = () => {
    if (selectedLibraryId !== 'all') {
      const name = libraryNameDraft.trim()
      if (name) renameToolLibrary(selectedLibraryId, name)
    }
    setRenamingLibrary(false)
  }

  const handleRemoveLibrary = () => {
    if (selectedLibraryId === 'all') return
    const lib = toolLibraries.find(l => l.id === selectedLibraryId)
    const n = toolLibrary.filter(t => t.libraryId === selectedLibraryId).length
    const ok = window.confirm(
      words("ToolLibraryModal.delete_library_and_its_tool_this_cannot", { value1: lib?.name ?? selectedLibraryId, value2: n, value3: n === 1 ? '' : 's' })
    )
    if (!ok) return
    removeToolLibrary(selectedLibraryId)
    setSelectedLibraryId('all')
    setSelectedId(null)
    setDraft(null)
    setIsDirty(false)
  }

  // ── Holder handlers ─────────────────────────────────────────────────────
  // Holder edits commit IMMEDIATELY to the store (no separate draft/Save like
  // tools) — a holder has no derived/feeds state to stage, so an immediate
  // updateHolder keeps the editor and the 3D assembly in lockstep.
  const selectedHolder = holders.find(h => h.id === selectedHolderId) ?? null

  const handleNewHolder = () => {
    const id = addHolder({
      id: '',
      name: words("ToolLibraryModal.new_holder"),
      segments: [{ height: 20, lowerDiameter: 10, upperDiameter: 30 }],
    })
    setSelectedHolderId(id)
  }

  const handleDeleteHolder = () => {
    if (!selectedHolderId) return
    const h = holders.find(x => x.id === selectedHolderId)
    const ok = window.confirm(
      words("ToolLibraryModal.delete_holder_tools_using_it_will_fall", { value1: h?.name ?? selectedHolderId })
    )
    if (!ok) return
    removeHolder(selectedHolderId)
    const remaining = holders.filter(x => x.id !== selectedHolderId)
    setSelectedHolderId(remaining[0]?.id ?? null)
  }

  const patchHolder = (updates: Partial<ToolHolder>) => {
    if (!selectedHolderId) return
    updateHolder(selectedHolderId, updates)
  }

  // Every segment edit READS the holder LIVE from the store (selectedHolder is
  // derived from the subscribed `holders` slice) and WRITES the whole new
  // segments array back through updateHolder, so edits persist + re-render.
  const patchSegment = (idx: number, updates: Partial<HolderSegment>) => {
    if (!selectedHolder) return
    const segments = selectedHolder.segments.map((s, i) => (i === idx ? { ...s, ...updates } : s))
    patchHolder({ segments })
  }

  const addSegment = () => {
    if (!selectedHolder) return
    // A new segment defaults to a 10mm-tall cylinder whose diameter continues
    // from the previous segment's top (upperDiameter), or 10 if it's the first.
    const last = selectedHolder.segments[selectedHolder.segments.length - 1]
    const lower = last ? last.upperDiameter : 10
    patchHolder({ segments: [...selectedHolder.segments, { height: 10, lowerDiameter: lower, upperDiameter: lower }] })
  }

  const removeSegment = (idx: number) => {
    if (!selectedHolder) return
    patchHolder({ segments: selectedHolder.segments.filter((_, i) => i !== idx) })
  }

  // Reorder a segment up (toward the holder top) or down (toward the tool side)
  // by swapping it with its neighbor. dir = -1 moves the row UP in the table
  // (toward index 0), dir = +1 moves it DOWN.
  const moveSegment = (idx: number, dir: -1 | 1) => {
    if (!selectedHolder) return
    const j = idx + dir
    if (j < 0 || j >= selectedHolder.segments.length) return
    const segments = [...selectedHolder.segments]
    ;[segments[idx], segments[j]] = [segments[j], segments[idx]]
    patchHolder({ segments })
  }

  const patch = (updates: Partial<Tool>) => {
    setDraft(d => d ? { ...d, ...updates } : d)
    setIsDirty(true)
    setSaved(false)
  }

  const patchFeeds = (updates: Partial<FeedsAndSpeeds>) => {
    setDraft(d => {
      if (!d) return d
      const prev = d.feedsAndSpeeds?.default ?? {}
      return { ...d, feedsAndSpeeds: { ...d.feedsAndSpeeds, default: { ...prev, ...updates } } }
    })
    setIsDirty(true)
    setSaved(false)
  }

  const commitDraft = () => {
    if (!draft) return
    // addTool/updateTool run the shared validator (toolValidation) before
    // writing; a rejection logs its reason to the console and leaves the
    // store untouched (rule: never a UI notice for this) — Save simply
    // does not commit, so isDirty stays true and the button stays visible.
    const ok = selectedId ? updateTool(selectedId, draft) : addTool(draft)
    if (!ok) return
    if (!selectedId) setSelectedId(draft.id)  // new tool -> now tracked
    setIsDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const handleDelete = () => {
    if (!selectedId) return
    removeTool(selectedId)
    const remaining = toolLibrary.filter(t => t.id !== selectedId)
    if (remaining.length > 0) { setSelectedId(remaining[0].id); setDraft({ ...remaining[0] }) }
    else                      { setSelectedId(null); setDraft(null) }
    setIsDirty(false)
  }

  // Serialize a tool for export, re-embedding a wrapped-format-compatible `holder` block
  // when the tool references a holder we can resolve. Omits holder otherwise.
  const serializeToolForExport = (t: Tool): Record<string, unknown> => {
    const portableTool = { ...t, cutHand: normalizeToolCutHand(t.cutHand) }
    if (!t.holderId) return portableTool
    const h = holders.find(x => x.id === t.holderId)
    if (!h) return portableTool
    return { ...portableTool, holder: serializeHolderForFusion(h) }
  }

  const handleExport = () => {
    if (!draft) return
    void saveFile(`${draft.name.replace(/\s+/g, '_')}.tool.json`, JSON.stringify(serializeToolForExport(draft), null, 2), 'application/json')
  }

  const handleExportAll = () => {
    void saveFile('tool_library.json', JSON.stringify(toolLibrary.map(serializeToolForExport), null, 2), 'application/json')
  }

  // Export only the selected library's tools (reuses the same serialization as
  // export-all). When "All libraries" is the scope this falls back to all tools.
  const handleExportLibrary = () => {
    const tools = selectedLibraryId === 'all'
      ? toolLibrary
      : toolLibrary.filter(t => t.libraryId === selectedLibraryId)
    const lib = toolLibraries.find(l => l.id === selectedLibraryId)
    const fname = selectedLibraryId === 'all'
      ? 'tool_library.json'
      : `${(lib?.name ?? 'library').replace(/\s+/g, '_')}.json`
    void saveFile(fname, JSON.stringify(tools.map(serializeToolForExport), null, 2), 'application/json')
  }

  // WO UI-11B alert() policy: auto-clears like the Save confirmation above
  // (setSaved(...1500...)) — 4s so a longer message stays legible.
  const flashImportFeedback = (kind: 'success' | 'warning' | 'error', text: string) => {
    setImportFeedback({ kind, text })
    setTimeout(() => setImportFeedback(null), 4000)
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportFeedback(null)
    // An import creates a NEW named library from the file name (extension
    // stripped) and tags every imported tool with that library's id, instead of
    // dumping into the flat pool. Preserves per-file library grouping.
    const libName = file.name.replace(/\.[^.]+$/, '').trim() || words("ToolLibraryModal.imported_library")
    const reader = new FileReader()
    reader.onerror = () => {
      addConsoleEvent({ severity: 'error', source: 'tool', message: words("ToolLibraryModal.tool_library_import_could_not_read_the") })
      flashImportFeedback('error', words("ToolLibraryModal.could_not_read_the_selected_file"))
    }
    reader.onload = () => {
      try {
        // A `.tools` file is a ZIP wrapping tools.json; a .json export is
        // plain JSON. decodeToolLibraryFile handles both (and throws loudly on a
        // bad archive / malformed JSON rather than failing silently — ADR-0003).
        // Decode FIRST so a malformed file throws before we create a library.
        const bytes = new Uint8Array(reader.result as ArrayBuffer)
        const parsed = decodeToolLibraryFile(bytes)
        const newLibId = addToolLibrary(libName)
        // Detect the wrapped tool-library format: { "data": [...] } wrapper or array with geometry field
        const dataArray = Array.isArray(parsed) ? parsed
          : (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string,unknown>).data))
            ? (parsed as Record<string,unknown>).data as unknown[]
            : null
        const firstItem = dataArray?.[0]
        const isFusion = dataArray !== null && firstItem != null
          && typeof firstItem === 'object' && 'geometry' in (firstItem as object)
        let count = 0
        // One flat diagnostics list for the WHOLE batch (WO-1441 rule 3): every
        // rejected record/segment and every unrecognized-type notice lands here,
        // and the caller reports it as ONE console summary — never a bare count.
        const diagnostics: RecordDiagnostic[] = []
        if (isFusion) {
          const { tools: importedTools, holders: importedHolders, diagnostics: fusionDiagnostics } = importFusionTools(parsed)
          diagnostics.push(...fusionDiagnostics)
          // Push the embedded holders first (deduped by guid in the store) so the
          // tools' holderId links resolve. addHolder is a no-op for a known id.
          importedHolders.forEach(h => addHolder(h))
          // Preserve each tool's holderId link (set by the importer) while
          // re-minting the tool id and tagging the new library.
          importedTools.forEach(t => { addTool({ ...t, id: crypto.randomUUID(), libraryId: newLibId }); count++ })
        } else {
          // Internal format: array of Tool or single Tool. Each record runs
          // through the shared validator before it reaches the store (rule:
          // never blank the whole batch for one bad record — valid records
          // still import, only the invalid ones are skipped, with a reason).
          const rawList: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
          rawList.forEach((raw, i) => {
            const label =
              raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).name === 'string'
                ? String((raw as Record<string, unknown>).name)
                : words("ToolLibraryModal.recordNumber", { number: i + 1 })
            const shapeCheck = validateToolRecordShape(raw)
            if (!shapeCheck.ok) {
              diagnostics.push({ label, reason: shapeCheck.reason })
              return
            }
            // WO-1542 (rule 11): the shape gate recovers what it can (a geometry
            // field written as numeric text; a nameless record gets a generated
            // name). Say so once, then import the record.
            const { tool: normalized, nameGenerated } = shapeCheck.record
            if (nameGenerated) {
              addConsoleEvent({
                severity: 'info',
                source: 'tool',
                message: words("ToolLibraryModal.tool_library_import_record_had_no_name", { value1: i + 1, value2: String(normalized.name) }),
              })
            }
            const t = normalized as unknown as Tool & { holder?: FusionHolder }
            const feedsAndSpeeds = t.feedsAndSpeeds ?? { default: blankTool().feedsAndSpeeds.default }
            // Rehydrate an embedded `holder` block (serializeToolForExport re-embeds one
            // whenever the exported tool had a resolvable holder) the same way the fusion
            // branch does, so the reimported tool's holderId resolves instead of dangling.
            // Holder segments are always stored in mm, so unit is fixed at 'millimeters'.
            const { holder: embeddedHolder, ...toolFields } = t
            const geometryCheck = validateToolGeometry(toolFields)
            if (!geometryCheck.ok) {
              diagnostics.push({ label, reason: geometryCheck.reason })
              return
            }
            const holderParse = embeddedHolder ? parseFusionHolder(embeddedHolder, 'millimeters') : undefined
            holderParse?.rejectedSegments.forEach(r => diagnostics.push({ label: words("ToolLibraryModal.holder", { value1: label, value2: r.label }), reason: r.reason }))
            const holderId = holderParse?.holder ? addHolder(holderParse.holder) : t.holderId
            addTool({
              ...toolFields,
              type: t.type ?? 'flat_end_mill',  // guard: type is required for rendering
              feedsAndSpeeds,
              holderId,
              id: crypto.randomUUID(),
              libraryId: newLibId,
            })
            count++
          })
        }
        if (count === 0) {
          // Nothing imported -> roll back the empty library we provisionally made.
          removeToolLibrary(newLibId)
          const msg = diagnostics.length > 0
            ? words("ToolLibraryModal.0_tools_imported", { value1: diagnostics.map(d => words("ToolLibraryModal.diagnostic", { label: d.label, reason: d.reason })).join('; ') })
            : words("ToolLibraryModal.no_tools_were_found_in_that_file")
          addConsoleEvent({ severity: 'warning', source: 'tool', message: words("ToolLibraryModal.tool_library_import", { value1: msg }) })
          flashImportFeedback('warning', diagnostics.length > 0 ? words("ToolLibraryModal.no_valid_tools_were_found_see_console") : msg)
        } else {
          // Scope the view to the freshly-imported library so the user sees them.
          setSelectedLibraryId(newLibId)
          const base = words("ToolLibraryModal.imported_tool_into_library", { value1: count, value2: count === 1 ? '' : 's', value3: libName })
          const msg = diagnostics.length > 0
            ? words("ToolLibraryModal.flaggedDiagnostics", { base, count: diagnostics.length, diagnostics: diagnostics.map(d => words("ToolLibraryModal.diagnostic", { label: d.label, reason: d.reason })).join('; ') })
            : base
          addConsoleEvent({ severity: diagnostics.length > 0 ? 'warning' : 'success', source: 'tool', message: msg })
          flashImportFeedback(
            diagnostics.length > 0 ? 'warning' : 'success',
            diagnostics.length > 0 ? words("ToolLibraryModal.flagged_see_console", { value1: base, value2: diagnostics.length }) : base,
          )
        }
      } catch (err) {
        console.error(words("ToolLibraryModal.tool_library_import_failed"), err)
        const msg = words("ToolLibraryModal.tool_library_import_failed_2", { value1: err instanceof Error ? err.message : words('ToolLibraryModal.unrecognizedFormat') })
        addConsoleEvent({ severity: 'error', source: 'tool', message: msg })
        flashImportFeedback('error', msg)
      }
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  const handleClose = () => withDiscard(() => {
    closeModal()   // never silently persist on close (X / backdrop)
  })

  const feeds = draft?.feedsAndSpeeds?.default
  const isProbe = draft?.type === 'probe'

  // ── Derived cutting-data values ──────────────────────────────────────────────
  const _diam   = draft?.diameter        ?? 6
  const _flutes = draft?.numberOfFlutes  ?? 2
  const _rpm    = feeds?.rpm             ?? 0
  const _fr     = feeds?.feedRate        ?? 0
  const _plunge = feeds?.plungeRate      ?? 0

  // Surface speed (m/min) = π × D(mm) × N(rpm) / 1000
  const derivedSurfaceSpeed     = _rpm > 0 && _diam > 0 ? (Math.PI * _diam * _rpm) / 1000 : 0
  // Feed per tooth (mm) = Vf(mm/min) / (N × z)
  const derivedFeedPerTooth     = _rpm > 0 && _flutes > 0 ? _fr / (_rpm * _flutes) : 0
  // Plunge feed per revolution (mm/rev) = plunge(mm/min) / N
  const derivedPlungeFeedPerRev = _rpm > 0 ? _plunge / _rpm : 0

  // Back-calculation handlers: editing a derived field updates the primary
  const handleSurfaceSpeedEdit = (vc: number) => {
    if (_diam <= 0 || vc <= 0) return
    patchFeeds({ rpm: Math.max(1, Math.round((vc * 1000) / (Math.PI * _diam))) })
  }
  const handleFeedPerToothEdit = (fz: number) => {
    if (_rpm <= 0 || _flutes <= 0 || fz <= 0) return
    patchFeeds({ feedRate: Math.max(1, Math.round(fz * _rpm * _flutes)) })
  }
  const handlePlungeFeedPerRevEdit = (fpr: number) => {
    if (_rpm <= 0 || fpr <= 0) return
    patchFeeds({ plungeRate: Math.max(1, Math.round(fpr * _rpm)) })
  }

  // ── Filter + sort the list ────────────────────────────────────────────────

  const q = search.trim().toLowerCase()
  const searchActive = q !== ''
  // The TYPE dropdown is a "focus" control (expand that type, collapse the rest)
  // rather than a hide-filter, so it does NOT reduce the list. Only search and
  // the material dropdown actually hide tools.
  const filtersActive = searchActive || filterMaterial !== 'all'

  const byType = (a: Tool, b: Tool) => {
    const ai = TOOL_TYPES.findIndex(x => x.value === a.type)
    const bi = TOOL_TYPES.findIndex(x => x.value === b.type)
    return ai - bi || (a.name ?? '').localeCompare(b.name ?? '')
  }

  // Tools in the selected LIBRARY scope (or every tool when 'all'). The
  // find/filter/sort controls below operate within this scope.
  const scopedTools = selectedLibraryId === 'all'
    ? toolLibrary
    : toolLibrary.filter(t => t.libraryId === selectedLibraryId)

  const visibleTools = [...scopedTools]
    .filter(t => t && typeof t === 'object' && t.id)  // guard against malformed entries
    .filter(t => filterMaterial === 'all' || t.material === filterMaterial)
    .filter(t => {
      if (!q) return true
      const name  = (t.name ?? '').toLowerCase()
      const tnum  = t.toolNumber !== undefined ? `t${t.toolNumber}` : ''
      const tType = typeLabel(t.type).toLowerCase()
      return name.includes(q) || tnum.includes(q) || tType.includes(q)
    })
    .sort((a, b) => {
      switch (sortMode) {
        case 'name':     return (a.name ?? '').localeCompare(b.name ?? '')
        case 'diameter': return (a.diameter ?? 0) - (b.diameter ?? 0) || (a.name ?? '').localeCompare(b.name ?? '')
        case 'tnumber': {
          const an = a.toolNumber ?? Number.POSITIVE_INFINITY
          const bn = b.toolNumber ?? Number.POSITIVE_INFINITY
          return an - bn || (a.name ?? '').localeCompare(b.name ?? '')
        }
        case 'type':
        default:         return byType(a, b)
      }
    })

  const clearFilters = () => {
    setSearch(''); setFilterType('all'); setFilterMaterial('all'); setCollapsedTypes(new Set())
  }

  // Type-group headers only make sense when sorting BY type; other sorts show a
  // flat list (a header per row would be noise).
  const grouped = sortMode === 'type'

  // Per-type counts for the collapsible group headers (counts AFTER filtering).
  const typeCounts = new Map<ToolType, number>()
  for (const t of visibleTools) typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + 1)

  // UI-BRAND B2-10: group consecutive same-type tools into runs so each run
  // can render as one DisclosureSection (visibleTools is already sorted
  // type-then-name when `grouped`, so one pass suffices). Ungrouped sorts
  // (name/diameter/T#) render visibleTools flat, unchanged.
  const toolGroups: { type: ToolType; tools: Tool[] }[] = []
  if (grouped) {
    for (const t of visibleTools) {
      const last = toolGroups[toolGroups.length - 1]
      if (last && last.type === t.type) last.tools.push(t)
      else toolGroups.push({ type: t.type, tools: [t] })
    }
  }

  // Choosing a type in the dropdown FOCUSES it: that group expands, the rest
  // collapse (but stay visible as headers). It also forces Type sort so the
  // grouping that makes "focus" meaningful is on. 'all' expands everything.
  const focusType = (ty: ToolType | 'all') => {
    setFilterType(ty)
    if (ty === 'all') {
      setCollapsedTypes(new Set())
    } else {
      setSortMode('type')
      setCollapsedTypes(new Set(TOOL_TYPES.map(x => x.value).filter(v => v !== ty)))
    }
  }

  const toggleType = (ty: ToolType) =>
    setCollapsedTypes(prev => {
      const next = new Set(prev)
      if (next.has(ty)) next.delete(ty); else next.add(ty)
      return next
    })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div
      className="modal-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div className="modal-container tool-modal" ref={dialogFocusRef}>

        {/* Header */}
        <div className="modal-header">
          <Wrench size={14} className="modal-header-icon" />
          <span className="modal-title" style={{ flex: 'none' }}>{words("ToolLibraryModal.tool_library")}</span>
          {/* Mode switch (Tools editor vs Holders editor): a cohesive segmented
              control next to the title (left, discoverable) rather than tucked
              at the far right. */}
          <div className="seg-toggle" style={{ marginLeft: 6 }}>
            <button
              className={`seg-toggle-btn${view === 'tools' ? ' seg-toggle-btn-active' : ''}`}
              onClick={() => withDiscard(() => setView('tools'))}
              data-testid="tool-view-tools"
            >{words("ToolLibraryModal.tools")}</button>
            <button
              className={`seg-toggle-btn${view === 'holders' ? ' seg-toggle-btn-active' : ''}`}
              onClick={() => withDiscard(() => setView('holders'))}
              data-testid="tool-view-holders"
            >{words("ToolLibraryModal.holders")}</button>
          </div>
          <div style={{ flex: 1 }} />
          <button className="modal-close-btn" onClick={handleClose}><X size={14} /></button>
        </div>

        {view === 'holders' ? (
          <HolderEditorPanel
            holders={holders}
            selectedHolder={selectedHolder}
            selectedHolderId={selectedHolderId}
            setSelectedHolderId={setSelectedHolderId}
            onNew={handleNewHolder}
            onDelete={handleDeleteHolder}
            patchHolder={patchHolder}
            patchSegment={patchSegment}
            addSegment={addSegment}
            removeSegment={removeSegment}
            moveSegment={moveSegment}
          />
        ) : (
        <>
        <div className="tool-modal-body" ref={bodyRef}>
        <ResizableSplit
          className="tool-modal-split"
          testId="tool-library-split"
          prefKey={TOOL_LIST_PANE_KEY}
          sizedPane="first"
          defaultSize={listDefault}
          minSize={listMin}
          maxSize={listMax}
          fillMinSize={editorPaneMin}
          label={words("ToolLibraryModal.resize_the_tool_list_and_tool_editor")}
          sizedCollapsed={listCollapsed}
          first={

          /* ── Left: tool list ── */
          <div className="tool-list-col" style={{ width: 'auto', minWidth: 0, flex: '1 1 auto' }}>
            {listCollapsed ? (
              <div className="tool-list-controls" data-testid="tool-list-collapsed">
                <div className="tool-list-control-row">
                  <Wrench size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{words("ToolLibraryModal.tools_2", { value1: toolLibrary.length })}</span>
                  <PanelCollapseToggle
                    panelKey={TOOL_LIST_PANE_KEY}
                    testId="tool-list-collapse"
                    collapseTip={words("ToolLibraryModal.collapse_the_tool_list")}
                    expandTip={words("ToolLibraryModal.expand_the_tool_list")}
                  />
                </div>
              </div>
            ) : (
            <>

            {/* ── Library selector ── A list of named libraries plus an "All
                libraries" entry. Selecting one scopes the tool list + the
                find/filter/sort controls to that library; rename/remove act on
                the selected library; (+) creates a new one. */}
            <div className="tool-list-controls">
              <div className="tool-list-control-row">
                <Library size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
                {renamingLibrary && selectedLibraryId !== 'all' ? (
                  <input
                    className="tool-list-search"
                    style={{ flex: 1 }}
                    autoFocus
                    value={libraryNameDraft}
                    onChange={(e) => setLibraryNameDraft(e.target.value)}
                    onBlur={commitRenameLibrary}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRenameLibrary()
                      if (e.key === 'Escape') setRenamingLibrary(false)
                    }}
                  />
                ) : (
                  <select
                    className="tool-list-select"
                    style={{ flex: 1 }}
                    value={selectedLibraryId}
                    onChange={(e) => {
                      const next = e.target.value as string | 'all'
                      withDiscard(() => setSelectedLibraryId(next))
                    }}
                    data-tooltip={words("ToolLibraryModal.library_scope")}
                    data-testid="tool-library-scope"
                  >
                    <option value="all">{words("ToolLibraryModal.all_libraries")}</option>
                    {toolLibraries.map(l => {
                      const n = toolLibrary.filter(t => t.libraryId === l.id).length
                      return <option key={l.id} value={l.id}>{l.name}{words("ToolLibraryModal.symbol")}{n}{words("ToolLibraryModal.symbol_2")}</option>
                    })}
                  </select>
                )}
                <button className="tool-list-clear" onClick={handleAddLibrary} data-tooltip={words("ToolLibraryModal.new_library_2")}
                aria-label={words("ToolLibraryModal.new_library_2")}>
                  <Plus size={12} />
                </button>
                <PanelCollapseToggle
                  panelKey={TOOL_LIST_PANE_KEY}
                  testId="tool-list-collapse"
                  collapseTip={words("ToolLibraryModal.collapse_the_tool_list")}
                  expandTip={words("ToolLibraryModal.expand_the_tool_list")}
                />
                {selectedLibraryId !== 'all' && (
                  <>
                    <button className="tool-list-clear" onClick={beginRenameLibrary} data-tooltip={words("ToolLibraryModal.rename_library")}
                    aria-label={words("ToolLibraryModal.rename_library")}>
                      <Pencil size={12} />
                    </button>
                    <button className="tool-list-clear" onClick={handleRemoveLibrary} data-tooltip={words("ToolLibraryModal.delete_library_and_its_tools")}
                    aria-label={words("ToolLibraryModal.delete_library_and_its_tools")}>
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Find / narrow / sort controls (empty scope hides them) */}
            {scopedTools.length > 0 && (
              <div className="tool-list-controls">
                <input
                  className="tool-list-search"
                  type="text"
                  placeholder={words("ToolLibraryModal.search_name_type_t")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="tool-list-control-row">
                  <select
                    className="tool-list-select"
                    value={filterType}
                    onChange={(e) => focusType(e.target.value as ToolType | 'all')}
                    data-tooltip={words("ToolLibraryModal.jump_to_a_tool_type_expands_it")}
                  >
                    <option value="all">{words("ToolLibraryModal.all_types")}</option>
                    {TOOL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <select
                    className="tool-list-select"
                    value={filterMaterial}
                    onChange={(e) => setFilterMaterial(e.target.value as ToolMaterial | 'all')}
                    data-tooltip={words("ToolLibraryModal.filter_by_material")}
                  >
                    <option value="all">{words("ToolLibraryModal.all_materials")}</option>
                    {MATERIALS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div className="tool-list-control-row">
                  <select
                    className="tool-list-select"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as 'type' | 'name' | 'diameter' | 'tnumber')}
                    data-tooltip={words("ToolLibraryModal.sort_order")}
                  >
                    <option value="type">{words("ToolLibraryModal.sort_type")}</option>
                    <option value="name">{words("ToolLibraryModal.sort_name")}</option>
                    <option value="diameter">{words("ToolLibraryModal.sort_diameter")}</option>
                    <option value="tnumber">{words("ToolLibraryModal.sort_tool")}</option>
                  </select>
                  {filtersActive && (
                    <button className="tool-list-clear" onClick={clearFilters} data-tooltip={words("ToolLibraryModal.clear_search_and_filters")}>{words("ToolLibraryModal.clear")}</button>
                  )}
                </div>
                {filtersActive && (
                  <div className="tool-list-count">{words("ToolLibraryModal.of_tools", { value1: visibleTools.length, value2: scopedTools.length })}</div>
                )}
              </div>
            )}

            <div className="tool-list">
              {grouped ? (
                // UI-BRAND B2-10: each type run renders as one DisclosureSection
                // in CONTROLLED mode - `open` is derived the SAME way the old
                // per-row `collapsed` calc was (search forces everything open;
                // otherwise honor collapsedTypes), and `onToggle` still writes
                // into the SAME collapsedTypes Set via toggleType, so focusType
                // (the type-dropdown "focus" control) and the search override
                // behave exactly as before the port.
                toolGroups.map((group) => {
                  const open = searchActive || !collapsedTypes.has(group.type)
                  return (
                    <DisclosureSection
                      key={group.type}
                      className="tool-list-disclosure"
                      title={typeLabel(group.type)}
                      summary={<span className="tool-list-group-count">{typeCounts.get(group.type)}</span>}
                      open={open}
                      onToggle={() => toggleType(group.type)}
                      testId={`tool-group-${group.type}`}
                    >
                      {group.tools.map((t) => (
                        <div
                          key={t.id}
                          className={`tool-list-item${selectedId === t.id ? ' tool-list-item-active' : ''}`}
                          onClick={() => handleSelect(t)}
                        >
                          <div className="tool-list-name" data-tooltip={t.name ?? words("ToolLibraryModal.unnamed")}>{t.name ?? words("ToolLibraryModal.unnamed")}</div>
                          <div className="tool-list-meta">{words("ToolLibraryModal.symbol_3")}{fmtDim(t.diameter ?? 0, displayUnits, displayUnits === 'inch' ? 3 : 1)}{unitLabel(displayUnits)}{words("ToolLibraryModal.symbol_4")}{t.type === 'probe' ? words("ToolLibraryModal.probeMeta") : words("ToolLibraryModal.fluteMeta", { count: t.numberOfFlutes ?? '?' })}{selectedLibraryId === 'all' && t.libraryId ? words("ToolLibraryModal.libraryMeta", { name: toolLibraries.find(l => l.id === t.libraryId)?.name ?? '' }) : ''}</div>
                          {t.toolNumber !== undefined && (
                            <span className="badge badge-accent">{words("ToolLibraryModal.t", { value1: t.toolNumber })}</span>
                          )}
                        </div>
                      ))}
                    </DisclosureSection>
                  )
                })
              ) : (
                visibleTools.map((t) => (
                  <div
                    key={t.id}
                    className={`tool-list-item${selectedId === t.id ? ' tool-list-item-active' : ''}`}
                    onClick={() => handleSelect(t)}
                  >
                    <div className="tool-list-name" data-tooltip={t.name ?? words("ToolLibraryModal.unnamed")}>{t.name ?? words("ToolLibraryModal.unnamed")}</div>
                    <div className="tool-list-meta">{words("ToolLibraryModal.symbol_3")}{fmtDim(t.diameter ?? 0, displayUnits, displayUnits === 'inch' ? 3 : 1)}{unitLabel(displayUnits)}{words("ToolLibraryModal.symbol_4")}{t.type === 'probe' ? words("ToolLibraryModal.probeMeta") : words("ToolLibraryModal.fluteMeta", { count: t.numberOfFlutes ?? '?' })}{selectedLibraryId === 'all' && t.libraryId ? words("ToolLibraryModal.libraryMeta", { name: toolLibraries.find(l => l.id === t.libraryId)?.name ?? '' }) : ''}</div>
                    {t.toolNumber !== undefined && (
                      <span className="badge badge-accent">{words("ToolLibraryModal.t", { value1: t.toolNumber })}</span>
                    )}
                  </div>
                ))
              )}
              {scopedTools.length === 0 && (
                <div className="tool-list-empty">{words("ToolLibraryModal.no_tools_add_one_or_import")}</div>
              )}
              {scopedTools.length > 0 && visibleTools.length === 0 && (
                <div className="tool-list-empty">{words("ToolLibraryModal.no_tools_match_your_search_or_filters")}<br />
                  <button className="tool-list-clear" onClick={clearFilters}>{words("ToolLibraryModal.clear_filters")}</button>
                </div>
              )}
            </div>

            <div className="tool-list-actions">
              <button className="machine-list-btn" onClick={handleNew} data-tooltip={words("ToolLibraryModal.new_tool_2")}>
                <Plus size={11} />{words("ToolLibraryModal.new")}</button>
              <button className="machine-list-btn" onClick={handleDuplicate} disabled={!selectedId} data-tooltip={words("ToolLibraryModal.duplicate_selected_tool")}>
                <Copy size={11} />{words("ToolLibraryModal.dup")}</button>
              <button className="machine-list-btn" onClick={() => importRef.current?.click()} data-tooltip={words("ToolLibraryModal.import_a_tools_json_file_as_a")}>
                <Upload size={11} />{words("ToolLibraryModal.import")}</button>
              <button
                className="machine-list-btn"
                onClick={selectedLibraryId === 'all' ? handleExportAll : handleExportLibrary}
                data-tooltip={selectedLibraryId === 'all' ? words("ToolLibraryModal.export_all_tools") : words("ToolLibraryModal.export_this_library")}
              >
                <Download size={11} /> {selectedLibraryId === 'all' ? words("ToolLibraryModal.all") : words("ToolLibraryModal.lib")}
              </button>
            </div>
            {importFeedback && (
              <div
                className={`op-hint console-severity-${importFeedback.kind}`}
                data-testid="tool-import-feedback"
              >
                {importFeedback.text}
              </div>
            )}
            </>
            )}
            <input ref={importRef} type="file" accept=".json,.tools" style={{ display: 'none' }} onChange={handleImport} />
          </div>
          }
          second={

          /* ── Right: editor ── */
          <div className="tool-editor-col">
            {!draft ? (
              <div className="tool-editor-empty">
                <Wrench size={28} style={{ opacity: 0.2, marginBottom: 8 }} />
                <div>{words("ToolLibraryModal.select_a_tool_or_create_a_new")}</div>
              </div>
            ) : (
              <>
                {/* Tabs */}
                <div className="tool-tabs">
                  {([
                    { id: 'general', label: words("ToolLibraryModal.general")      },
                    { id: 'cutter',  label: words("ToolLibraryModal.cutter")       },
                    { id: 'feeds',   label: words("ToolLibraryModal.cutting_data") },
                    { id: 'post',    label: words("ToolLibraryModal.post")         },
                  ] as { id: TabId; label: string }[]).map(tab => (
                    <button
                      key={tab.id}
                      className={`tool-tab${activeTab === tab.id ? ' tool-tab-active' : ''}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="tool-editor-content">

                  {/* Form area */}
                  <div className="tool-form-col">

                    {/* ── General tab ── */}
                    {activeTab === 'general' && (
                      <div className="tool-form-section">
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.name")}</label>
                          <input className="mform-input" value={draft.name}
                            onChange={(e) => patch({ name: e.target.value })} />
                        </div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.type")}</label>
                          <select className="mform-select" value={draft.type}
                            onChange={(e) => patch({ type: e.target.value as ToolType })}>
                            {TOOL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                        </div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.material")}</label>
                          <select className="mform-select" value={draft.material}
                            onChange={(e) => patch({ material: e.target.value as ToolMaterial })}>
                            {MATERIALS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                          </select>
                        </div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.coating")}</label>
                          <select className="mform-select" value={draft.coating}
                            onChange={(e) => patch({ coating: e.target.value as ToolCoating })}>
                            {COATINGS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                        </div>
                        <div className="mform-section-header">{words("ToolLibraryModal.holder_2")}</div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.holder_2")}</label>
                          <select
                            className="mform-select"
                            value={draft.holderId ?? ''}
                            data-testid="tool-holder-select"
                            onChange={(e) => patch({ holderId: e.target.value === '' ? undefined : e.target.value })}
                          >
                            <option value="">{words("ToolLibraryModal.none")}</option>
                            {holders.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                          </select>
                        </div>
                        {/* P12a (clutter audit): the EDITABLE "Length below holder"
                            input lives on the Cutter tab (Dimensions). This is a
                            read-only reference so the Holder section still answers
                            "how much tool sticks out" without a second write path
                            to the same store field (draft.lengthBelowHolder). */}
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.length_below_holder")}</label>
                          <span
                            className="post-readonly"
                            data-testid="tool-lbh-readout"
                            data-tooltip={words("ToolLibraryModal.edit_on_the_cutter_tab_dimensions_section")}
                          >
                            {fmtDim(draft.lengthBelowHolder ?? Math.max(draft.fluteLength, draft.shoulderLength ?? 0), displayUnits)} {unitLabel(displayUnits)}
                          </span>
                        </div>

                        <div className="mform-section-header">{words("ToolLibraryModal.vendor")}</div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.vendor")}</label>
                          <input className="mform-input" value={draft.vendor ?? ''}
                            onChange={(e) => patch({ vendor: e.target.value })} placeholder={words("ToolLibraryModal.e_g_tool_vendor")} />
                        </div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.product_id")}</label>
                          <input className="mform-input" value={draft.productId ?? ''}
                            onChange={(e) => patch({ productId: e.target.value })} placeholder={words("ToolLibraryModal.e_g_cm_102_2")} />
                        </div>
                        <div className="mform-section-header">{words("ToolLibraryModal.notes")}</div>
                        <textarea className="mform-textarea" value={draft.notes} rows={4}
                          onChange={(e) => patch({ notes: e.target.value })}
                          placeholder={words("ToolLibraryModal.tool_notes_material_recommendations_storage_location")} />
                      </div>
                    )}

                    {/* ── Cutter tab ── */}
                    {activeTab === 'cutter' && (
                      <div className="tool-form-section">
                        <div className="mform-section-header">{words("ToolLibraryModal.dimensions", { value1: unitLabel(displayUnits).toUpperCase() })}</div>
                        <NumField label={isProbe ? words("ToolLibraryModal.ball_tip_diameter") : words("ToolLibraryModal.diameter")} value={draft.diameter} min={0.1} step={0.5}  onChange={(v) => patch({ diameter: v })} units={displayUnits} />
                        <NumField label={words("ToolLibraryModal.shank_diameter")}       value={draft.shankDiameter}       min={0.1} step={0.5}  onChange={(v) => patch({ shankDiameter: v })} units={displayUnits} />
                        <NumField label={words("ToolLibraryModal.overall_length")}       value={draft.overallLength}       min={1}   step={1}    onChange={(v) => patch({ overallLength: v })} units={displayUnits} />
                        <NumField label={isProbe ? words("ToolLibraryModal.stylus_length_from_tip") : words("ToolLibraryModal.flute_length_from_tip")} value={draft.fluteLength} min={0.1} step={0.5}  onChange={(v) => patch({ fluteLength: v })} units={displayUnits} />
                        <NumField label={words("ToolLibraryModal.shoulder_length_from_tip")} value={draft.shoulderLength ?? 0} min={0}   step={0.5}  onChange={(v) => patch({ shoulderLength: v })} units={displayUnits} />
                        <NumField label={words("ToolLibraryModal.length_below_holder")}  value={draft.lengthBelowHolder ?? Math.max(draft.fluteLength, draft.shoulderLength ?? 0)} min={0} step={1}
                          onChange={(v) => patch({ lengthBelowHolder: v })} units={displayUnits} />

                        <div className="mform-section-header">{words("ToolLibraryModal.geometry")}</div>
                        {!isProbe && (
                          <div className="mform-row">
                            <label className="mform-label">{words("ToolLibraryModal.flutes")}</label>
                            <NumericInput min={1} max={16} step={1}
                              className="mform-input mform-input-mono"
                              value={draft.numberOfFlutes}
                              onChange={(v) => patch({ numberOfFlutes: Math.round(v) })} />
                          </div>
                        )}

                        {(draft.type === 'bull_nose') && (
                          <NumField label={words("ToolLibraryModal.corner_radius")}      value={draft.cornerRadius ?? 0}   min={0}   step={0.1}  onChange={(v) => patch({ cornerRadius: v })} />
                        )}

                        {/* WO-2154: the probe's wiring and calibration. The
                            calibrated radii stay blank until a calibration sets
                            them; blank means the ball radius is used. */}
                        {isProbe && (
                          <>
                            <div className="mform-row">
                              <label className="mform-label">{words("ToolLibraryModal.stem_diameter")}</label>
                              <OptionalNumericInput min={0} step={0.1}
                                className="mform-input mform-input-mono"
                                value={draft.neckDiameter}
                                placeholder={words("ToolLibraryModal.auto")}
                                ariaLabel={words("ToolLibraryModal.stem_diameter")}
                                units={displayUnits}
                                onChange={(v) => patch({ neckDiameter: v })} />
                            </div>
                            <div className="mform-section-header">{words("ToolLibraryModal.probe")}</div>
                            <div className="mform-row">
                              <label className="mform-label">{words("ToolLibraryModal.probe_input")}</label>
                              <select className="mform-select" data-testid="tool-probe-input"
                                value={probeInputOf(draft)}
                                onChange={(e) => patch({ probeInput: e.target.value === '2' ? 2 : 1 })}>
                                <option value="1">{words("ToolLibraryModal.probe_1")}</option>
                                <option value="2">{words("ToolLibraryModal.probe_2")}</option>
                              </select>
                            </div>
                            <div className="mform-row">
                              <label className="mform-label">{words("ToolLibraryModal.contact")}</label>
                              <select className="mform-select" data-testid="tool-probe-contact"
                                value={probeContactOf(draft)}
                                onChange={(e) => patch({ probeContact: e.target.value as ProbeContact })}>
                                <option value="normally_open">{words("ToolLibraryModal.open_no")}</option>
                                <option value="normally_closed">{words("ToolLibraryModal.closed_nc")}</option>
                              </select>
                            </div>
                            <div className="mform-row">
                              <label className="mform-label">{words("ToolLibraryModal.calibrated_radius_x")}</label>
                              <OptionalNumericInput min={0} step={0.001}
                                className="mform-input mform-input-mono"
                                value={draft.probeEffectiveRadiusX}
                                placeholder={words("ToolLibraryModal.ballRadius", { radius: fmtDim(draft.diameter / 2, displayUnits, displayUnits === 'inch' ? 4 : 3) })}
                                ariaLabel={words("ToolLibraryModal.calibrated_radius_x")}
                                units={displayUnits}
                                onChange={(v) => patch({ probeEffectiveRadiusX: v })} />
                            </div>
                            <div className="mform-row">
                              <label className="mform-label">{words("ToolLibraryModal.calibrated_radius_y")}</label>
                              <OptionalNumericInput min={0} step={0.001}
                                className="mform-input mform-input-mono"
                                value={draft.probeEffectiveRadiusY}
                                placeholder={words("ToolLibraryModal.ballRadius", { radius: fmtDim(draft.diameter / 2, displayUnits, displayUnits === 'inch' ? 4 : 3) })}
                                ariaLabel={words("ToolLibraryModal.calibrated_radius_y")}
                                units={displayUnits}
                                onChange={(v) => patch({ probeEffectiveRadiusY: v })} />
                            </div>
                            <div className="tool-post-tip">
                              <ChevronRight size={11} />{words("ToolLibraryModal.blank_calibrated_radius_the_ball_radius_is")}</div>
                          </>
                        )}

                        {/* Relieved neck (undercut) — relevant to dovetail / disc /
                            lollipop / thread families. The builders already respect
                            neckDiameter + shoulderLength; exposing them here gives
                            the user control over the relief above the cutting form. */}
                        {!isProbe && fieldRelevanceForType(draft.type).neckDiameter && (
                          <>
                            <NumField label={words("ToolLibraryModal.neck_diameter")}            value={draft.neckDiameter ?? 0}   min={0}   step={0.1}  onChange={(v) => patch({ neckDiameter: v })} units={displayUnits} />
                            <NumField label={words("ToolLibraryModal.relief_shoulder_length")} value={draft.shoulderLength ?? 0} min={0}   step={0.5}  onChange={(v) => patch({ shoulderLength: v })} units={displayUnits} />
                          </>
                        )}

                        {/* Neck -> shank transition cone angle (thread mills). 90 =
                            sharp radial step; smaller = gentler/taller taper. */}
                        {fieldRelevanceForType(draft.type).neckTransitionAngle && (
                          <>
                            <NumField label={words("ToolLibraryModal.neck_transition_angle_from_axis")} value={draft.neckTransitionAngleDeg ?? 30} min={1} step={1}
                              onChange={(v) => patch({ neckTransitionAngleDeg: v })} />
                            <div className="tool-post-tip">
                              <ChevronRight size={11} />{words("ToolLibraryModal.angle_of_the_neck_to_shank_blend")}</div>
                          </>
                        )}

                        {/* Thread-mill form. threadPitch blank/0 -> plain cylinder.
                            threadTeethCount 1 = single-point, more = full-form. */}
                        {fieldRelevanceForType(draft.type).threadPitch && (
                          <>
                            <div className="mform-section-header">{words("ToolLibraryModal.thread_form")}</div>
                            <div className="mform-row">
                              <label className="mform-label">{words("ToolLibraryModal.thread_teeth_vertical")}</label>
                              <NumericInput min={1} max={64} step={1}
                                className="mform-input mform-input-mono"
                                value={draft.threadTeethCount ?? 1}
                                onChange={(v) => patch({ threadTeethCount: Math.max(1, Math.round(v)) })} />
                            </div>
                            <NumField label={words("ToolLibraryModal.thread_form_angle_included")} value={draft.threadFormAngleDeg ?? 60} min={10} step={1}
                              onChange={(v) => patch({ threadFormAngleDeg: v })} />
                            <NumField label={words("ToolLibraryModal.thread_pitch_blank_plain_cylinder")} value={draft.threadPitch ?? 0} min={0} step={0.05}
                              onChange={(v) => patch({ threadPitch: v > 0 ? v : undefined })} units={displayUnits} />
                            <div className="tool-post-tip">
                              <ChevronRight size={11} />{words("ToolLibraryModal.1_tooth_single_point_cutter_more_full")}</div>
                          </>
                        )}
                        {(() => {
                          // Angle field visibility + input convention come from the
                          // single source of truth (toolMeta). The math is unchanged:
                          //   included -> field shows angleFromAxisDeg*2, stores /2,
                          //               echo "(= X per side)"
                          //   perSide  -> field shows angleFromAxisDeg as-is, stores
                          //               as-is, echo "(= X included)"
                          const meta = toolTypeMeta(draft.type)
                          if (!meta.hasAngle) return null
                          if (meta.angleInputStyle === 'perSide') {
                            // Tapered endmill: user enters the PER-SIDE taper angle = canonical, stored as-is.
                            const perSide = draft.angleFromAxisDeg ?? 5
                            return (
                              <>
                                <div className="mform-row">
                                  <label className="mform-label">{words("ToolLibraryModal.taper_angle_per_side")}<button
                                      type="button"
                                      className="angle-help-btn"
                                      onClick={() => setShowAngleHelp(v => !v)}
                                      data-tooltip={words("ToolLibraryModal.how_to_enter_tool_angles")}
                                      aria-label={words("ToolLibraryModal.tool_angle_help")}
                                    >{words("ToolLibraryModal.symbol_5")}</button>
                                  </label>
                                  <NumericInput
                                    className="mform-input mform-input-mono"
                                    value={perSide} min={0.1} step={0.1}
                                    onChange={(v) => patch({ angleFromAxisDeg: v })}
                                  />
                                </div>
                                <div className="mform-row angle-echo-row">
                                  <span className="angle-echo">{words("ToolLibraryModal.included", { value1: (perSide * 2) })}</span>
                                </div>
                              </>
                            )
                          }
                          // Pointed tools (angleInputStyle === 'included'): user enters
                          // the FULL INCLUDED angle; stored = included / 2.
                          const included = (draft.angleFromAxisDeg ?? 59) * 2
                          return (
                            <>
                              <div className="mform-row">
                                <label className="mform-label">{words("ToolLibraryModal.included_tip_angle")}<button
                                    type="button"
                                    className="angle-help-btn"
                                    onClick={() => setShowAngleHelp(v => !v)}
                                    data-tooltip={words("ToolLibraryModal.how_to_enter_tool_angles")}
                                    aria-label={words("ToolLibraryModal.tool_angle_help")}
                                  >{words("ToolLibraryModal.symbol_5")}</button>
                                </label>
                                <NumericInput
                                  className="mform-input mform-input-mono"
                                  value={included} min={10} step={1}
                                  onChange={(v) => patch({ angleFromAxisDeg: v / 2 })}
                                />
                              </div>
                              <div className="mform-row angle-echo-row">
                                <span className="angle-echo">{words("ToolLibraryModal.per_side", { value1: (included / 2) })}</span>
                              </div>
                            </>
                          )
                        })()}

                        {/* Per-type angle DIAGRAM (replaces the old wordy help text).
                            A small inline SVG that shows the convention for the
                            selected tool's input style, with numbers computed live
                            from the draft angle. No external file references. */}
                        {showAngleHelp && toolTypeMeta(draft.type).hasAngle && (
                          <AngleHelpDiagram
                            inputStyle={toolTypeMeta(draft.type).angleInputStyle}
                            angleFromAxisDeg={draft.angleFromAxisDeg ?? (toolTypeMeta(draft.type).angleInputStyle === 'perSide' ? 5 : 59)}
                          />
                        )}
                      </div>
                    )}

                    {/* ── Cutting Data tab ── */}
                    {activeTab === 'feeds' && feeds && (
                      <div className="tool-form-section">

                        {/* Section header + material guide toggle */}
                        <div className="feeds-hdr-row">
                          <span className="feeds-hdr-label">{words("ToolLibraryModal.speed")}</span>
                          <button
                            className="feeds-guide-btn"
                            onClick={() => setShowFeedsHelp(v => !v)}
                            data-tooltip={words("ToolLibraryModal.show_conservative_feed_speed_recommendations_for_hobby")}
                          >
                            {showFeedsHelp ? words("ToolLibraryModal.close_guide") : words("ToolLibraryModal.material_guide")}
                          </button>
                        </div>

                        <NumField label={words("ToolLibraryModal.spindle_speed_rpm")}   value={feeds.rpm}      min={100} step={500}
                          onChange={(v) => patchFeeds({ rpm: v })} />
                        <CalcField
                          label={words("ToolLibraryModal.surface_speed", { value1: surfaceSpeedLabel(displayUnits) })}
                          computedValue={surfaceSpeedToDisplay(derivedSurfaceSpeed, displayUnits)}
                          decimals={displayUnits === 'inch' ? 0 : 1} step={10}
                          onBackCalc={(v) => handleSurfaceSpeedEdit(surfaceSpeedFromDisplay(v, displayUnits))}
                        />

                        <div className="mform-section-header">{words("ToolLibraryModal.feedrates", { value1: feedLabel(displayUnits) })}</div>
                        <NumField label={words("ToolLibraryModal.cutting_feed")}          value={feeds.feedRate} min={0} step={100}
                          onChange={(v) => patchFeeds({ feedRate: v })} units={displayUnits} kind="feed" />
                        <CalcField
                          label={words("ToolLibraryModal.feed_per_tooth", { value1: unitLabel(displayUnits) })}
                          computedValue={toDisplay(derivedFeedPerTooth, displayUnits)}
                          decimals={displayUnits === 'inch' ? 5 : 4}
                          step={displayUnits === 'inch' ? 0.00001 : 0.0001}
                          onBackCalc={(v) => handleFeedPerToothEdit(fromDisplay(v, displayUnits))}
                        />
                        <NumField label={words("ToolLibraryModal.lead_in_feed")}          value={feeds.leadInFeedrate  ?? feeds.feedRate} min={0} step={50}
                          onChange={(v) => patchFeeds({ leadInFeedrate: v })} units={displayUnits} kind="feed" />
                        <NumField label={words("ToolLibraryModal.lead_out_feed")}         value={feeds.leadOutFeedrate ?? feeds.feedRate} min={0} step={50}
                          onChange={(v) => patchFeeds({ leadOutFeedrate: v })} units={displayUnits} kind="feed" />
                        <NumField label={words("ToolLibraryModal.fast_traverse_feed")}    value={feeds.fastTraverseFeedrate ?? 3000} min={0} step={50}
                          onChange={(v) => patchFeeds({ fastTraverseFeedrate: v })} units={displayUnits} kind="feed" />
                        <NumField label={words("ToolLibraryModal.finish_feed")}           value={feeds.finishFeedrate ?? feeds.feedRate} min={0} step={50}
                          onChange={(v) => patchFeeds({ finishFeedrate: v })} units={displayUnits} kind="feed" />
                        <NumField label={words("ToolLibraryModal.ramp_feed")}             value={feeds.rampFeedrate ?? feeds.feedRate * 0.5} min={0} step={50}
                          onChange={(v) => patchFeeds({ rampFeedrate: v })} units={displayUnits} kind="feed" />
                        <NumField label={words("ToolLibraryModal.ramp_angle")}        value={feeds.rampAngle ?? 2} min={0.5} step={0.5}
                          onChange={(v) => patchFeeds({ rampAngle: v })} />

                        <div className="mform-section-header">{words("ToolLibraryModal.vertical_feedrates")}</div>
                        <NumField label={words("ToolLibraryModal.plunge_feed", { value1: feedLabel(displayUnits) })}  value={feeds.plungeRate} min={0} step={50}
                          onChange={(v) => patchFeeds({ plungeRate: v })} units={displayUnits} kind="feed" />
                        <CalcField
                          label={words("ToolLibraryModal.plunge_per_rev", { value1: unitLabel(displayUnits) })}
                          computedValue={toDisplay(derivedPlungeFeedPerRev, displayUnits)}
                          decimals={displayUnits === 'inch' ? 5 : 4}
                          step={displayUnits === 'inch' ? 0.00001 : 0.0001}
                          onBackCalc={(v) => handlePlungeFeedPerRevEdit(fromDisplay(v, displayUnits))}
                        />

                        <div className="mform-section-header">{words("ToolLibraryModal.coolant")}</div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.coolant")}</label>
                          <select className="mform-select" value={feeds.coolant ?? 'none'}
                            onChange={(e) => patchFeeds({ coolant: e.target.value as FeedsAndSpeeds['coolant'] })}>
                            {COOLANT_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>

                        {/* Material guide panel */}
                        {showFeedsHelp && (
                          <div className="feeds-guide-panel">
                            <div className="feeds-guide-title">{words("ToolLibraryModal.feed_speed_guide_hobby_cnc")}<span className="feeds-guide-subtitle">{words("ToolLibraryModal.conservative_values_for_low_rigidity_machines_1")}</span>
                            </div>
                            <table className="feeds-guide-table">
                              <thead>
                                <tr>
                                  <th className="fgt-mat">{words("ToolLibraryModal.material")}</th>
                                  <th className="fgt-num">{words("ToolLibraryModal.vc_m_min")}</th>
                                  <th className="fgt-num">{words("ToolLibraryModal.fz_mm_tooth")}</th>
                                  <th className="fgt-note">{words("ToolLibraryModal.notes")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {MATERIAL_RECS.map(r => (
                                  <tr key={r.mat}>
                                    <td className="feeds-guide-mat">{r.mat}</td>
                                    <td className="feeds-guide-num">{r.vc}</td>
                                    <td className="feeds-guide-num">{r.fz}</td>
                                    <td className="feeds-guide-note">{r.notes}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="feeds-guide-footer">{words("ToolLibraryModal.vc_surface_speed_m_min_use_with")}</div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Post Processor tab ── */}
                    {activeTab === 'post' && (
                      <div className="tool-form-section">
                        <div className="mform-section-header">{words("ToolLibraryModal.post_processor")}</div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.tool_number")}</label>
                          <OptionalNumericInput min={1} max={999} step={1}
                            className="mform-input mform-input-mono"
                            value={draft.toolNumber}
                            placeholder={words("ToolLibraryModal.auto_post")}
                            ariaLabel={words("ToolLibraryModal.tool_number")}
                            onChange={(v) => patch({ toolNumber: v === undefined ? undefined : Math.round(v) })} />
                        </div>
                        <div className="mform-row">
                          <label className="mform-label">{words("ToolLibraryModal.cutting_hand")}</label>
                          <select
                            className="mform-select"
                            data-testid="tool-cut-hand"
                            value={normalizeToolCutHand(draft.cutHand)}
                            onChange={(event) => patch({ cutHand: event.target.value as ToolCutHand })}
                          >
                            <option value="right">{words("ToolLibraryModal.right_hand_cutting_standard")}</option>
                            <option value="left">{words("ToolLibraryModal.left_hand_cutting_reverse_spindle")}</option>
                          </select>
                        </div>
                        <div className="tool-post-tip">
                          <ChevronRight size={11} />{words("ToolLibraryModal.tool_number_controls_the_t_word_cutting")}</div>
                      </div>
                    )}
                  </div>

                  {/* ── Diagram (always visible) ── */}
                  <div className="tool-diagram-col">
                    <ToolDiagram
                      type={draft.type ?? 'flat_end_mill'}
                      diameter={draft.diameter || 6}
                      shankDiameter={draft.shankDiameter || 6}
                      overallLength={draft.overallLength || 50}
                      fluteLength={draft.fluteLength || 18}
                      shoulderLength={draft.shoulderLength}
                      lengthBelowHolder={draft.lengthBelowHolder}
                      cornerRadius={draft.cornerRadius}
                      angleFromAxisDeg={draft.angleFromAxisDeg}
                      neckDiameter={draft.neckDiameter}
                      threadFormAngleDeg={draft.threadFormAngleDeg}
                      threadTeethCount={draft.threadTeethCount}
                      threadPitch={draft.threadPitch}
                      neckTransitionAngleDeg={draft.neckTransitionAngleDeg}
                      coating={draft.coating ?? 'none'}
                      units={displayUnits}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
          }
        />
        </div>

        {/* Footer */}
        <div className="modal-footer machine-modal-footer">
          <div className="machine-footer-left">
            {draft && (
              <>
                <button className="modal-btn modal-btn-danger" onClick={handleDelete} disabled={!selectedId} data-tooltip={words("ToolLibraryModal.delete_tool")}>
                  <Trash2 size={12} />{words("ToolLibraryModal.delete")}</button>
                <button className="modal-btn modal-btn-ghost" onClick={handleExport} disabled={!selectedId} data-tooltip={words("ToolLibraryModal.export_this_tool")}>
                  <Download size={12} />{words("ToolLibraryModal.export")}</button>
              </>
            )}
          </div>
          <div className="machine-footer-right">
            {(isDirty || isUnsavedNew) && (
              <button className="modal-btn modal-btn-primary" onClick={commitDraft}>
                {saved ? <><Check size={12} />{words("ToolLibraryModal.saved")}</> : words("ToolLibraryModal.save_changes")}
              </button>
            )}
            {!isDirty && saved && (
              <span className="machine-saved-badge"><Check size={11} />{words("ToolLibraryModal.saved")}</span>
            )}
          </div>
        </div>
        </>
        )}

      </div>
    </div>
  )
}

// ── Numeric field helper ─────────────────────────────────────────────────────

function NumField({ label, value, min, step, onChange, units, kind = 'dim' }: {
  label: string; value: number; min: number; step: number
  onChange: (v: number) => void
  units?: Units
  kind?: 'dim' | 'feed'
}) {
  return (
    <div className="mform-row">
      <label className="mform-label">{label}</label>
      <NumericInput
        className="mform-input mform-input-mono"
        value={value} min={min} step={step}
        onChange={onChange}
        units={units} kind={kind}
      />
    </div>
  )
}

// ── Auto-calculated field ─────────────────────────────────────────────────────
// Shows a computed value with an "fx" badge.
// Editing it back-calculates and updates the primary source field.

function CalcField({ label, computedValue, decimals = 4, step = 0.0001, onBackCalc }: {
  label: string
  computedValue: number
  decimals?: number
  step?: number
  onBackCalc: (v: number) => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  const [editVal, setEditVal] = useState<string | null>(null)
  const safe    = isFinite(computedValue) && !isNaN(computedValue) ? computedValue : 0
  const display = editVal ?? safe.toFixed(decimals)

  return (
    <div className="mform-row">
      <label className="mform-label">{label}</label>
      <div className="calc-field-wrap">
        <input
          type="text"
          inputMode="decimal"
          step={step}
          className="mform-input mform-input-mono calc-field-input"
          value={display}
          onChange={(e) => setEditVal(e.target.value)}
          onFocus={(e) => { setEditVal(safe.toFixed(decimals)); e.target.select() }}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0) onBackCalc(v)
            setEditVal(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = parseFloat(e.currentTarget.value)
              if (!isNaN(v) && v > 0) { onBackCalc(v); setEditVal(null); e.currentTarget.blur() }
            }
            if (e.key === 'Escape') { setEditVal(null); e.currentTarget.blur() }
          }}
        />
        <span className="calc-field-badge" data-tooltip={words("ToolLibraryModal.auto_calculated_edit_to_back_calculate_the")}>{words("ToolLibraryModal.fx")}</span>
      </div>
    </div>
  )
}

// ── Angle convention diagram ──────────────────────────────────────────────────
// Replaces the old wordy angle-help text with a compact per-type SVG that shows
// the convention for the selected tool's input style. Numbers are computed live
// from the canonical half-angle (angleFromAxisDeg). No external file links.
//
//   'included' (pointed): a downward cone; labels the FULL included angle across
//                         the apex + one side as per-side. Enter the INCLUDED angle.
//   'perSide'  (tapered): a frustum (walls down to a flat bottom, NOT a point);
//                         labels ONE wall per-side + the included total. Enter PER-SIDE.

function AngleHelpDiagram({ inputStyle, angleFromAxisDeg }: {
  inputStyle: 'included' | 'perSide' | 'none'
  angleFromAxisDeg: number
}) {
  const words = useText('setup-stock-tools-machine-post')
  if (inputStyle === 'none') return null

  // Canonical store is the half-angle. included = 2 x half; perSide = half.
  const perSide  = angleFromAxisDeg
  const included = angleFromAxisDeg * 2
  const fmt = (n: number) => Number.isInteger(n) ? `${n}` : n.toFixed(1)

  // Technical drawing ink, shared with the tool and holder previews (WO-1258).
  const BG     = 'var(--diagram-ground)'
  const METAL  = 'var(--diagram-outline)'
  const FILL   = 'var(--diagram-profile-fill)'
  const AXIS   = 'var(--diagram-axis)'
  const LABEL  = 'var(--diagram-label)'
  const MUTED  = 'var(--diagram-muted-label)'
  const ACCENT = 'var(--diagram-angle-label)'

  // ── Geometry ───────────────────────────────────────────────────────────────
  // A downward V/cone with a small tip flat at the BOTTOM. The included angle is
  // the full tip-to-tip sweep about the (virtual) apex; per-side is axis-to-one-
  // edge. Wider side margins leave room to route the angle labels OFF to the
  // sides (included on the LEFT, per-side on the RIGHT) so neither the cone
  // silhouette nor the axis/tip-flat labels are obscured.
  const W = 300, H = 190
  const cx = W / 2
  const tipY = H - 50          // y of the tip flat (bottom)
  const halfTip = 6            // px half-width of the tip flat
  const coneH = 104            // px from tip flat up to the major-dia mouth
  // Draw the cone at the real angle but CLAMPED to a legible window [12, 42]
  // deg/side, so the V tracks the actual tool where it can yet a wide tip (e.g.
  // 59 deg/side) stays inside the box instead of overflowing and colliding with
  // the labels. The numbers beside it always carry the true values.
  const aRad = Math.max(12, Math.min(42, perSide)) * Math.PI / 180
  const topY = tipY - coneH    // y of the wide mouth (top)
  const topHalf = halfTip + coneH * Math.tan(aRad)
  const lx = cx - halfTip, rx = cx + halfTip
  // Virtual apex below the tip flat (where the two edges would meet).
  const apexY = tipY + halfTip / Math.tan(aRad)

  // Point on an edge ray from the apex at radius r. Angle 0 = straight up the
  // axis; +a swings toward the RIGHT edge, -a toward the LEFT edge.
  const onRay = (r: number, signedA: number) => ({
    x: cx + r * Math.sin(signedA),
    y: apexY - r * Math.cos(signedA),
  })
  // Arc string between two signed angles about the apex (large radius so the arcs
  // ride UP near the wide mouth where the opening reads clearly).
  const arc = (r: number, a0: number, a1: number, sweep: 0 | 1) => {
    const p0 = onRay(r, a0), p1 = onRay(r, a1)
    return `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`
  }
  // Radii chosen so both arcs sit high in the cone (near the mouth) without
  // touching the silhouette walls. coneH is the apex->mouth axial distance on
  // the +/-a edges; keep arc radius a bit below that.
  const edgeLen = coneH / Math.cos(aRad)
  const rIncl = Math.min(edgeLen * 0.82, coneH * 0.86)   // tip-to-tip arc (up high)
  const rPer  = Math.min(edgeLen * 0.55, coneH * 0.58)   // axis-to-edge arc (a touch lower)

  // included arc: left edge -> right edge (symmetric about the axis), drawn UP.
  const inclArc = arc(rIncl, -aRad, +aRad, 1)
  // per-side arc: axis -> right edge.
  const perArc  = arc(rPer, 0, +aRad, 1)

  // Each label sits just OUTSIDE the cone next to ITS OWN arc end, joined by a
  // short stub -- the included arc's LEFT end carries the included label (to its
  // left), the per-side arc's RIGHT end carries the per-side label (to its
  // right). No long leader reaching to the far side or running under the text.
  const GAP = 24                                // leader length: keep the text well clear of the cone lines
  const inclArcL = onRay(rIncl, -aRad)         // left end of included arc (near the left label)
  const perArcR  = onRay(rPer,  +aRad)         // right end of per-side arc (near the right label)
  const inclLabelX = inclArcL.x - GAP          // right-anchored: text ends just left of the arc
  const inclLabelY = inclArcL.y
  const perLabelX  = perArcR.x + GAP           // left-anchored: text starts just right of the arc
  const perLabelY  = perArcR.y

  // Highlight the label the user actually enters for this input style.
  const inclColor = inputStyle === 'included' ? ACCENT : LABEL
  const perColor  = inputStyle === 'perSide'  ? ACCENT : LABEL
  const instruction = inputStyle === 'included'
    ? words("ToolLibraryModal.enter_the_included_angle_tip_to_tip")
    : words("ToolLibraryModal.enter_the_per_side_angle_axis_to")

  return (
    <div className="feeds-guide-panel">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
        <rect width={W} height={H} fill={BG} rx={6} />

        {/* dashed centerline axis through the apex (label tucked at the very top,
            centered, so it never collides with the side leaders) */}
        <line x1={cx} y1={topY - 14} x2={cx} y2={tipY + 12} stroke={AXIS} strokeWidth="0.75" strokeDasharray="4,3" />
        <text x={cx + 5} y={topY - 6} fontSize={10} fontFamily="monospace" fill={AXIS}>{words("ToolLibraryModal.axis")}</text>

        {/* V/cone silhouette: wide mouth (top) -> tip flat (bottom) -> back up */}
        <path
          d={`M ${cx - topHalf} ${topY} L ${lx} ${tipY} L ${rx} ${tipY} L ${cx + topHalf} ${topY}`}
          fill={FILL} stroke={METAL} strokeWidth="1.5"
        />

        {/* tip flat (short horizontal segment at the bottom) */}
        <line x1={lx} y1={tipY} x2={rx} y2={tipY} stroke={LABEL} strokeWidth="2" />
        <text x={cx} y={tipY + 24} textAnchor="middle" fontSize={10} fontFamily="monospace" fill={MUTED}>{words("ToolLibraryModal.tip_flat_tipdiameter")}</text>

        {/* ── INCLUDED angle: arc + short stub to the label just LEFT of its end ── */}
        <path d={inclArc} fill="none" stroke={inclColor} strokeWidth="1.2" />
        <line x1={inclArcL.x} y1={inclArcL.y} x2={inclLabelX} y2={inclLabelY}
          stroke={inclColor} strokeWidth="0.6" />
        <text x={inclLabelX} y={inclLabelY - 2} textAnchor="end" fontSize={11} fontWeight="600"
          fill={inclColor} fontFamily="monospace">{words("ToolLibraryModal.deg", { value1: fmt(included) })}</text>
        <text x={inclLabelX} y={inclLabelY + 11} textAnchor="end" fontSize={11} fontFamily="monospace" fill={inclColor}>{words("ToolLibraryModal.included_2")}</text>

        {/* ── PER-SIDE angle: arc + short stub to the label just RIGHT of its end ── */}
        <path d={perArc} fill="none" stroke={perColor} strokeWidth="1.2" />
        <line x1={perArcR.x} y1={perArcR.y} x2={perLabelX} y2={perLabelY}
          stroke={perColor} strokeWidth="0.6" />
        <text x={perLabelX} y={perLabelY - 2} textAnchor="start" fontSize={11} fontWeight="600"
          fill={perColor} fontFamily="monospace">{words("ToolLibraryModal.deg", { value1: fmt(perSide) })}</text>
        <text x={perLabelX} y={perLabelY + 11} textAnchor="start" fontSize={11} fontFamily="monospace" fill={perColor}>{words("ToolLibraryModal.per_side_2")}</text>

        {/* bottom instruction */}
        <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fontFamily="monospace" fill={LABEL}>
          {instruction}
        </text>
      </svg>
    </div>
  )
}

// ── Holder editor panel ───────────────────────────────────────────────────────
// A sibling view to the tool editor: a list of holders (left) + a holder editor
// with identity fields + a segment table (right). Segments stack from the holder
// BOTTOM (tool side) upward. Edits commit immediately via updateHolder.

function holderSummary(h: ToolHolder): string {
  const n = h.segments.length
  const maxOD = h.segments.reduce(
    (m, s) => Math.max(m, s.lowerDiameter, s.upperDiameter), 0
  )
  return words("ToolLibraryModal.segment_max_od", { value1: n, value2: n === 1 ? '' : 's', value3: maxOD.toFixed(1) })
}

function HolderEditorPanel({
  holders, selectedHolder, selectedHolderId, setSelectedHolderId,
  onNew, onDelete, patchHolder, patchSegment, addSegment, removeSegment, moveSegment,
}: {
  holders: ToolHolder[]
  selectedHolder: ToolHolder | null
  selectedHolderId: string | null
  setSelectedHolderId: (id: string) => void
  onNew: () => void
  onDelete: () => void
  patchHolder: (updates: Partial<ToolHolder>) => void
  patchSegment: (idx: number, updates: Partial<HolderSegment>) => void
  addSegment: () => void
  removeSegment: (idx: number) => void
  moveSegment: (idx: number, dir: -1 | 1) => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  return (
    <div className="tool-modal-body">

      {/* ── Left: holder list ── */}
      <div className="tool-list-col">
        <div className="tool-list">
          {holders.map(h => (
            <div
              key={h.id}
              className={`tool-list-item${selectedHolderId === h.id ? ' tool-list-item-active' : ''}`}
              onClick={() => setSelectedHolderId(h.id)}
            >
              <div className="tool-list-name" data-tooltip={h.name}>{h.name}</div>
              <div className="tool-list-meta">{holderSummary(h)}</div>
            </div>
          ))}
          {holders.length === 0 && (
            <div className="tool-list-empty">{words("ToolLibraryModal.no_holders_add_one")}</div>
          )}
        </div>
        <div className="tool-list-actions">
          <button className="machine-list-btn" onClick={onNew} data-tooltip={words("ToolLibraryModal.new_holder")} data-testid="holder-new">
            <Plus size={11} />{words("ToolLibraryModal.new")}</button>
          <button className="machine-list-btn" onClick={onDelete} disabled={!selectedHolderId} data-tooltip={words("ToolLibraryModal.delete_holder")}>
            <Trash2 size={11} />{words("ToolLibraryModal.delete")}</button>
        </div>
      </div>

      {/* ── Right: holder editor ── */}
      <div className="tool-editor-col">
        {!selectedHolder ? (
          <div className="tool-editor-empty">
            <Wrench size={28} style={{ opacity: 0.2, marginBottom: 8 }} />
            <div>{words("ToolLibraryModal.select_a_holder_or_create_a_new")}</div>
          </div>
        ) : (
          <div className="tool-editor-content">
            <div className="tool-form-col">
              <div className="tool-form-section">
                <div className="mform-section-header">{words("ToolLibraryModal.identity")}</div>
                <div className="mform-row">
                  <label className="mform-label">{words("ToolLibraryModal.name")}</label>
                  <input className="mform-input" value={selectedHolder.name}
                    onChange={(e) => patchHolder({ name: e.target.value })} />
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("ToolLibraryModal.vendor")}</label>
                  <input className="mform-input" value={selectedHolder.vendor ?? ''}
                    onChange={(e) => patchHolder({ vendor: e.target.value })} placeholder={words("ToolLibraryModal.e_g_er20")} />
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("ToolLibraryModal.product_id")}</label>
                  <input className="mform-input" value={selectedHolder.productId ?? ''}
                    onChange={(e) => patchHolder({ productId: e.target.value })} />
                </div>
                <div className="mform-row">
                  <label className="mform-label">{words("ToolLibraryModal.gauge_length")}</label>
                  <NumericInput
                    className="mform-input mform-input-mono"
                    value={selectedHolder.gaugeLength ?? 0} min={0} step={1}
                    onChange={(v) => patchHolder({ gaugeLength: v })}
                  />
                </div>

                <div className="mform-section-header">{words("ToolLibraryModal.segments_bottom_tool_side_up")}</div>
                <table className="feeds-guide-table">
                  <thead>
                    <tr>
                      <th className="fgt-num">{words("ToolLibraryModal.height")}</th>
                      <th className="fgt-num">{words("ToolLibraryModal.lower_od")}</th>
                      <th className="fgt-num">{words("ToolLibraryModal.upper_od")}</th>
                      <th className="fgt-num">{words("ToolLibraryModal.order")}</th>
                      <th className="fgt-num"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedHolder.segments.map((seg, idx) => (
                      <tr key={idx}>
                        <td>
                          <NumericInput className="mform-input mform-input-mono" value={seg.height} min={0} step={1}
                            onChange={(v) => patchSegment(idx, { height: v })} />
                        </td>
                        <td>
                          <NumericInput className="mform-input mform-input-mono" value={seg.lowerDiameter} min={0} step={0.5}
                            onChange={(v) => patchSegment(idx, { lowerDiameter: v })} />
                        </td>
                        <td>
                          <NumericInput className="mform-input mform-input-mono" value={seg.upperDiameter} min={0} step={0.5}
                            onChange={(v) => patchSegment(idx, { upperDiameter: v })} />
                        </td>
                        <td>
                          {/* Reorder this segment within the stack (top = holder
                              top, bottom = tool side). Disabled at the ends. */}
                          <div className="holder-seg-reorder">
                            <button
                              className="tool-list-clear"
                              onClick={() => moveSegment(idx, -1)}
                              disabled={idx === 0}
                              data-tooltip={words("ToolLibraryModal.move_segment_up")}
                              aria-label={words("ToolLibraryModal.move_segment_up")}
                              data-testid={`holder-seg-up-${idx}`}
                            >
                              <ChevronUp size={11} />
                            </button>
                            <button
                              className="tool-list-clear"
                              onClick={() => moveSegment(idx, 1)}
                              disabled={idx === selectedHolder.segments.length - 1}
                              data-tooltip={words("ToolLibraryModal.move_segment_down")}
                              aria-label={words("ToolLibraryModal.move_segment_down")}
                              data-testid={`holder-seg-down-${idx}`}
                            >
                              <ChevronDown size={11} />
                            </button>
                          </div>
                        </td>
                        <td>
                          <button className="tool-list-clear" onClick={() => removeSegment(idx)} data-tooltip={words("ToolLibraryModal.remove_segment")}
                          aria-label={words("ToolLibraryModal.remove_segment")}
                            data-testid={`holder-seg-remove-${idx}`}>
                            <Trash2 size={11} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="machine-list-btn" onClick={addSegment} data-tooltip={words("ToolLibraryModal.add_segment")} data-testid="holder-add-segment">
                  <Plus size={11} />{words("ToolLibraryModal.add_segment_2")}</button>
              </div>
            </div>

            {/* 2D preview: mirrored holder silhouette from buildHolderProfile. */}
            <div className="tool-diagram-col">
              <HolderPreview holder={selectedHolder} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Small mirrored SVG silhouette of the holder profile (bottom at the bottom).
function HolderPreview({ holder }: { holder: ToolHolder }) {
  const words = useText('setup-stock-tools-machine-post')
  const verts = buildHolderProfile(holder)
  if (verts.length === 0) {
    return <div className="tool-editor-empty" style={{ fontSize: 11 }}>{words("ToolLibraryModal.no_segments_to_preview")}</div>
  }
  const maxZ = verts.reduce((m, v) => Math.max(m, v.z), 0) || 1
  const maxR = verts.reduce((m, v) => Math.max(m, v.r), 0) || 1
  const W = 160, H = 240, pad = 16
  const cx = W / 2
  // UNIFORM scale (same for radius and height) so the silhouette keeps its TRUE
  // aspect ratio: a wide-short holder draws wide and short, a tall-thin one tall
  // and thin, and adding/resizing a segment visibly changes the shape. (A prior
  // version used independent sx/sy, which stretched every holder to fill the box
  // so edits made no visible change.)
  const s = Math.min((W / 2 - pad) / maxR, (H - 2 * pad) / maxZ)
  // Holder bottom (z=0) at the bottom of the viewport; build upward.
  const X = (r: number) => cx + r * s
  const Y = (z: number) => H - pad - z * s
  const right = verts.map(v => `${X(v.r).toFixed(1)},${Y(v.z).toFixed(1)}`)
  const left  = [...verts].reverse().map(v => `${X(-v.r).toFixed(1)},${Y(v.z).toFixed(1)}`)
  const pts = [...right, ...left].join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      <rect width={W} height={H} fill="var(--diagram-ground)" rx={6} />
      <line x1={cx} y1={pad} x2={cx} y2={H - pad} stroke="var(--diagram-axis)" strokeWidth="0.75" strokeDasharray="4,3" />
      <polygon data-testid="holder-preview-poly" points={pts} fill="var(--diagram-profile-fill)" stroke="var(--diagram-outline)" strokeWidth="1.5" />
      <text x={cx} y={H - 4} textAnchor="middle" fontSize={9} fill="var(--diagram-muted-label)">{words("ToolLibraryModal.tool_side_bottom")}</text>
    </svg>
  )
}
