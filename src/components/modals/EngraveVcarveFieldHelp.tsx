import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { i18n, useText } from '../../i18n'
import { engraveVcarveFields } from '../../help/engraveVcarveFields'

type FieldId = typeof engraveVcarveFields[number]['id']
const aliases: Partial<Record<FieldId, string[]>> = {
  toolSearch: ['Search tools'], toolLibrary: ['Tool library'], toolUsed: ['Used in project'],
  name: ['Operation name', 'Name'], tool: ['Tool', 'Search tools', 'Search tools...'],
  geometry: ['Geometry', 'Curves', 'Pick edges', 'Source'], loops: ['All loops', 'None', 'Select all', 'Clear selection'],
  mode: ['Mode', 'Trace', 'V-engrave'], style: ['Style'], slotWidth: ['Slot width'], advance: ['Advance per orbit'],
  widthDepth: ['Depth from line width'], lineWidth: ['Target line width'], depth: ['Engraving depth'],
  follow: ['Follow the surface'], stepdown: ['Stepdown', 'Maximum stepdown'], axial: ['Axial offset'],
  open: ['Open paths'], closed: ['Closed loops'], side: ['On the line', 'Left', 'Right'], sideOffset: ['Side offset'],
  direction: ['As drawn', 'Climb', 'Conventional'], leadIn: ['Lead-in radius'], leadOut: ['Lead-out radius'],
  bitLimit: ["Bit's own limit", "Use the bit's limit"], flatDepth: ['Flat depth', 'Set a flat depth'], startDepth: ['Start depth'],
  clearBit: ['Clear with this bit'], clearTool: ['Separate end mill', 'Clearing tool'], leave: ['Leave floors'],
  floorStep: ['Floor stepover'], allowance: ['Allowance'], tolerance: ['Tolerance'], shank: ['Shank clearance'],
  clearance: ['Clearance Height', 'Clearance'], retract: ['Retract Height', 'Retract'], feedHeight: ['Feed Height'],
  top: ['Top Height', 'Material Start'], bottom: ['Bottom Height', 'Target End'],
  reference: ['Reference plane'], offset: ['Z offset from plane', 'Z (WCS)'], minimize: ['Minimize Z travel'],
  override: ['Override tool feeds & speeds for this operation', 'Override feeds & speeds'],
  rpm: ['Spindle speed', 'Spindle', 'RPM'], cutFeed: ['Cutting feed', 'Feed'], plunge: ['Plunge feed', 'Plunge'],
  ramp: ['Ramp feed'], leadInFeed: ['Lead-in feed'], leadOutFeed: ['Lead-out feed'], traverse: ['Fast traverse feed'], finish: ['Finish feed'],
  tabs: ['Hold the part with tabs', 'Tab width', 'Tab height', 'Tab count', 'Tab shape'],
  entry: ['Entry type', 'Plunge', 'Ramp', 'Ramp (linear)', 'Helix'], rampAngle: ['Ramp angle'], rampDiameter: ['Helix diameter'],
  edit: ['Edit depth settings', 'Edit carve settings'],
}
const normalize = (value: string) => value.replace(/\{\{[^}]+\}\}/g, '').replace(/[✓:]/g, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase()

/** The dialog and Properties use several existing field widgets, some with
 * unlabelled NumericInput children. Attach only explanatory DOM attributes at
 * their common boundary; never replace handlers, values, names or tab order.
 * Observe child replacement too (Advanced, expanded height rows, QuickEdit).
 */
export function EngraveVcarveFieldHelp({ operation, children }: { operation: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const t = useText('engrave-vcarve-fields.wo3199')
  useLayoutEffect(() => {
    if (!root.current || !['engrave', 'vcarve'].includes(operation)) return
    const names = new Map<string, FieldId>()
    for (const [id, values] of Object.entries(aliases)) for (const name of values) names.set(normalize(name), id as FieldId)
    // Match the existing field labels in the active language, while keeping
    // new explanatory sentences in this order's small language files.
    const visit = (english: unknown, localized: unknown) => {
      if (typeof english === 'string' && typeof localized === 'string') {
        const id = names.get(normalize(english))
        if (id) names.set(normalize(localized), id)
      } else if (english && localized && typeof english === 'object' && typeof localized === 'object') {
        for (const key of Object.keys(english)) visit((english as Record<string, unknown>)[key], (localized as Record<string, unknown>)[key])
      }
    }
    visit(i18n.getResourceBundle('en', 'cam-operations-new-operation'), i18n.getResourceBundle(i18n.resolvedLanguage ?? 'en', 'cam-operations-new-operation'))
    const originals = new Map<HTMLElement, Array<[string, string | null]>>()
    const remember = (element: HTMLElement) => {
      if (!originals.has(element)) originals.set(element, ['title', 'data-tooltip', 'data-field-help', 'aria-description'].map(name => [name, element.getAttribute(name)]))
    }
    const annotate = () => {
      for (const [plane, id] of Object.entries({ clearance: 'clearance', retract: 'retract', feed: 'feedHeight', top: 'top', bottom: 'bottom' } as const)) {
        const row = root.current!.querySelector<HTMLElement>(`[data-testid="standard-height-${plane}"]`)
        if (row) { remember(row); row.setAttribute('data-field-help', id); row.setAttribute('title', t(id)); row.setAttribute('data-tooltip', t(id)) }
      }
      for (const element of root.current!.querySelectorAll<HTMLElement>('input, select, textarea, .op-toggle-btn, .op-pick-btn, .op-tool-row, [data-testid="quickedit-change-tool"]')) {
        const row = element.closest<HTMLElement>('.op-field-row, .props-group, .qe-field, .props-quickedit-feed, label')
        const label = row?.querySelector('.op-field-label, .props-label, .qe-label, .props-quickedit-flabel')?.textContent
          ?? (row?.tagName === 'LABEL' ? row.textContent : null)
        const candidates = [element.getAttribute('aria-label'), element.getAttribute('placeholder'), label, element.previousElementSibling?.matches('.op-field-label') ? element.previousElementSibling.textContent : null,
          element.tagName === 'BUTTON' ? element.textContent : null]
        let id = candidates.map(value => {
          if (!value) return undefined
          const label = normalize(value)
          return names.get(label) ?? [...names].find(([name]) => label.startsWith(`${name} `))?.[1]
        }).find(Boolean)
        const testId = element.getAttribute('data-testid') ?? ''
        if (testId === 'op-geometry-select') id = 'geometry'
        if (testId === 'engrave-flat-depth') id = 'engraveFlat'
        if (operation === 'engrave' && id === 'flatDepth') id = 'engraveFlat'
        if (/standard-height-.*-offset/.test(element.closest('[data-testid]')?.getAttribute('data-testid') ?? '')) id = 'offset'
        if (/standard-height-.*-source/.test(testId)) id = 'reference'
        if (/standard-height-.*-operator/.test(testId)) id = 'offset'
        if (element.closest('.op-tool-row')) id = 'tool'
        if (element.closest('.op-loop-check')) id = 'loops'
        if (testId === 'op-tool-filter-search') id = 'toolSearch'
        if (testId === 'op-tool-filter-library') id = 'toolLibrary'
        if (testId === 'op-tool-filter-used-toggle') id = 'toolUsed'
        if (testId === 'quickedit-change-tool') id = 'tool'
        if (element.matches('input.mform-input') && element.previousElementSibling?.matches('.op-section-label')) id = 'name'
        const explicit = element.closest('[data-engrave-vcarve-field]')?.getAttribute('data-engrave-vcarve-field')
        if (explicit && engraveVcarveFields.some(field => field.id === explicit)) id = explicit as FieldId
        if (!id) continue
        remember(element)
        const text = t(id)
        element.setAttribute('data-field-help', id)
        element.setAttribute('data-tooltip', text)
        element.setAttribute('title', text)
        element.setAttribute('aria-description', text)
        if (row) { remember(row); row.setAttribute('title', text); row.setAttribute('data-tooltip', text) }
      }
    }
    annotate()
    const observer = new MutationObserver(annotate)
    observer.observe(root.current, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const [element, attributes] of originals) for (const [name, value] of attributes) {
        if (value === null) element.removeAttribute(name)
        else element.setAttribute(name, value)
      }
    }
  }, [operation, children, t])
  return <div ref={root} style={{ display: 'contents' }}>{children}</div>
}
