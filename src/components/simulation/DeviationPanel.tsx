import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getOperationStockDomain, useCamStore } from '../../store'
import { wcsBoundStockId } from '../../lib/post/workOffsets'
import { loadDeviationTarget } from '../../lib/simulation/deviationTarget'
import { compareDeviation, readFinalStockSurface, type DeviationResult } from '../../lib/simulation/deviationComparison'
import { DEVIATION_COLORS } from '../../lib/viewport/deviationOverlay'
import { useText } from '../../i18n'
import type { Operation } from '../../types'

// Stylesheet, not words: kept out of the JSX so the English guard reads only text.
const STACK_OFFSET_CSS = `
      .viewport-axis-legend { bottom: calc(12px + var(--deviation-panel-h, 0px) + var(--sim-panel-h, 0px) + var(--sketch-prompt-h, 0px)) !important; }
      .tp-legend-wrap { bottom: calc(46px + var(--deviation-panel-h, 0px) + var(--sim-panel-h, 0px) + var(--sketch-prompt-h, 0px)) !important; }
    `

// A status line is a catalog key (so a language switch re-words it without a new
// comparison) or already-worded text from the comparison itself.
type StatusKey = 'comparing' | 'needStock' | 'domainUnavailable' | 'recomputing'
// An operation the final stock waits for, named as the Setup tree names it.
type WaitKind = 'waitGenerate' | 'waitComputing' | 'waitRegenerate'
type Waiting = { id: string; name: string; kind: WaitKind }
type Status = { key: StatusKey } | { text: string } | { waiting: readonly Waiting[] } | null
function waitingOn(operations: readonly Operation[], ids: readonly string[]): Waiting[] {
  return ids.flatMap(id => {
    const op = operations.find(candidate => candidate.id === id)
    if (!op) return []
    const kind: WaitKind = op.status === 'computing' ? 'waitComputing'
      : op.status === 'ready' || op.status === 'outdated' ? 'waitRegenerate' : 'waitGenerate'
    return [{ id, name: op.name || op.id, kind }]
  })
}
class StatusError extends Error {
  readonly key: StatusKey
  constructor(key: StatusKey) { super(key); this.key = key }
}

export interface DeviationPanelProps {
  onOverlay(result: DeviationResult | null, opacity: number, scaleMm: number): void
}
export function DeviationPanel({ onOverlay }: DeviationPanelProps) {
  const t = useText('simulation-deviation')
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLElement>(null)
  const [atEnd, setAtEnd] = useState(false)
  // WO-3052: the last value set, so the observer below sets only a change.
  const atEndNow = useRef(false)
  const project = useCamStore(state => state.project)
  const mode = useCamStore(state => state.viewer.mode)
  const selectedStockId = useCamStore(state => state.viewer.selectedStockId)
  const [enabled, setEnabled] = useState(false)
  const [toleranceMm, setTolerance] = useState(0.1)
  const [maxCellMm, setCell] = useState(0.5)
  const [opacity, setOpacity] = useState(0.75)
  const [scaleMm, setScale] = useState(2)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<DeviationResult | null>(null)
  const [message, setMessage] = useState<Status>(null)
  // Every finished check leaves a stamp, so Compare again never looks like nothing happened.
  const [checked, setChecked] = useState<{ at: Date; count: number } | null>(null)
  const checks = useRef(0)
  const setup = project.setups.find(candidate => candidate.id === project.activeSetupId)
  const stockId = selectedStockId ?? (setup ? wcsBoundStockId(setup.wcs) : undefined)

  // SimulationPanel owns the clock privately and writes this slider on every
  // seek (scrub, rewind, skip-end and rAF playback). Read that same cursor;
  // the legacy viewer.simulationProgress field is not updated by playback.
  useEffect(() => {
    const root = anchor.current?.parentElement
    if (!root) return
    const update = () => {
      const slider = root.querySelector<HTMLInputElement>('.sim-scrubber')
      // Frame durations can end between integer milliseconds; range step=1
      // exposes the last reachable tick, which is still the fully-right slider.
      const next = !!slider && Number(slider.max) > 0 &&
        Number(slider.max) - Number(slider.value) < (Number(slider.step) || 1)
      // WO-3052: the observer fires on every viewport DOM change; set only a change.
      if (next !== atEndNow.current) { atEndNow.current = next; setAtEnd(next) }
    }
    const observer = new MutationObserver(update)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuetext', 'max'] })
    root.addEventListener('input', update)
    update()
    return () => { observer.disconnect(); root.removeEventListener('input', update) }
  }, [mode])

  // Keep the existing legend/axis stack above this diagnostic, including when
  // its controls expand. Reuse the playback bar's live height, not a constant.
  useLayoutEffect(() => {
    const root = anchor.current?.parentElement
    const element = panel.current
    if (!root || !element) return
    const publish = () => root.style.setProperty('--deviation-panel-h', `${element.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => { observer.disconnect(); root.style.removeProperty('--deviation-panel-h') }
  }, [mode, atEnd, enabled])

  // WO-3052: clear only a result that exists. This panel is always mounted, and
  // `project` changes on every store write (each toolpath progress tick), so an
  // unconditional setResult(null) here scheduled a re-render per write even with
  // the panel off; during REGEN ALL those chained into React's nested-update
  // limit ("Maximum update depth exceeded") and a lost write hung the batch.
  const hasResult = useRef(false)
  useEffect(() => { hasResult.current = result !== null }, [result])
  useEffect(() => {
    if (hasResult.current) setResult(null)
    if (!enabled || mode !== 'simulation') return
    const controller = new AbortController()
    let off: (() => void) | undefined
    let target: Awaited<ReturnType<typeof loadDeviationTarget>> | undefined
    const stamp = () => { if (!controller.signal.aborted) setChecked({ at: new Date(), count: ++checks.current }) }
    // WO-3052: start on the next task, not inside this commit. Open in Simulate,
    // every store write re-runs this effect, and state set here would chain each
    // commit into the next one exactly as the idle panel's did.
    const start = setTimeout(() => void (async () => {
      setMessage({ key: 'comparing' })
      setChecked(null)
      try {
        if (!setup || !stockId) throw new StatusError('needStock')
        const domain = getOperationStockDomain(setup.id, stockId)
        if (!domain) throw new StatusError('domainUnavailable')
        // Subscribe before reading: settlement may happen while loading target.
        off = domain.authority.subscribe(() => { controller.abort(); setResult(null); setRevision(value => value + 1) })
        const read = readFinalStockSurface(domain)
        if (read.status === 'recomputing') {
          const waiting = waitingOn(setup.operations, read.waitingFor)
          setMessage(waiting.length ? { waiting } : { key: 'recomputing' })
          stamp()
          return
        }
        if (read.status !== 'ready') throw new Error(read.reason)
        target = await loadDeviationTarget(project, stockId, domain.frame, controller.signal)
        const compared = await compareDeviation(read.surface, target, { toleranceMm, maxCellMm, signal: controller.signal })
        controller.signal.throwIfAborted()
        if (!domain.authority.isCurrent(read.surface.token) || useCamStore.getState().project !== project) return
        setResult({ ...compared, estimatedBytes: compared.estimatedBytes + target.estimatedBytes })
        setMessage(null)
        stamp()
      } catch (error) {
        if (!controller.signal.aborted) { stamp(); setMessage(error instanceof StatusError ? { key: error.key } : { text: error instanceof Error ? error.message : String(error) }); setResult(null) }
      } finally { target?.dispose(); target = undefined }
    })(), 0)
    return () => { clearTimeout(start); controller.abort(); off?.(); target?.dispose() }
  }, [enabled, mode, project, setup, stockId, toleranceMm, maxCellMm, revision])

  useEffect(() => {
    onOverlay(enabled && atEnd && mode === 'simulation' ? result : null, opacity, scaleMm)
    return () => onOverlay(null, opacity, scaleMm)
  }, [enabled, atEnd, mode, result, opacity, scaleMm, onOverlay])

  return (<>
    <span hidden ref={anchor} />
    {mode === 'simulation' && atEnd && <>
    <style>{STACK_OFFSET_CSS}</style>
    <section ref={panel} aria-label={t('title')} data-testid="deviation-panel" data-ui78-sanctioned=""
      className="tp-legend-wrap deviation-legend">
      {enabled && <div className="tp-legend">
        <div className="tp-legend-title">{t('title')}</div>
        <span>{t('subtitle')}</span>
        <label>{t('cellSizeLabel')} <select aria-label={t('cellSizeAria')} value={maxCellMm} onChange={event => setCell(Number(event.target.value))}>
          <option value={0.25}>0.25</option><option value={0.5}>0.5</option><option value={1}>1</option><option value={2}>2</option>
        </select></label>
        <label>{t('toleranceLabel')} <input aria-label={t('toleranceAria')} type="number" min={0} max={10} step={0.05} value={toleranceMm}
          onChange={event => setTolerance(Number(event.target.value))} /></label>
        <label>{t('scaleLabel', { value1: scaleMm })} <input aria-label={t('scaleAria')} type="range" min={0.1} max={10} step={0.1}
          value={scaleMm} onChange={event => setScale(Number(event.target.value))} /></label>
        <label>{t('opacityLabel', { value1: Math.round(opacity * 100) })} <input aria-label={t('opacityAria')} type="range" min={0} max={1} step={0.05}
          value={opacity} onChange={event => setOpacity(Number(event.target.value))} /></label>
        <div aria-label={t('legendAria')}>
          {([['gouge', t('legendGouge')], ['residual', t('legendResidual')], ['match', t('legendMatch')],
            ['possible-residual', t('legendPossibleResidual')], ['unknown', t('legendUnknown')]] as const).map(([kind, label]) =>
            <span className="tp-legend-item" key={kind}><i className="tp-legend-line" style={{ background: DEVIATION_COLORS[kind] }} />{label}{result ? `: ${result.counts[kind]}` : ''}</span>)}
        </div>
        <div role="status" data-testid="deviation-status">{message && ('waiting' in message ? <>
          {t('waitingHeader')}
          <ul>{message.waiting.map(item => <li key={item.id}>{t(item.kind, { value1: item.name })}</li>)}</ul>
        </> : 'key' in message ? t(message.key) : message.text)}{result && <>
          <div>{t('cells', { value1: result.sourceCellMm.toFixed(3), value2: result.cellMm.toFixed(3) })}</div>
          <div>{t('samples', { value1: result.cells.length.toLocaleString(), value2: result.elapsedMs.toFixed(0), value3: (result.estimatedBytes / 1048576).toFixed(1) })}</div>
        </>}</div>
        {checked && <div aria-live="polite" data-testid="deviation-checked">{t('checkedAt', { value1: checked.at.toLocaleTimeString(), value2: checked.count })}</div>}
        <small>{t('stockHint')}</small>
        <small>{t('caveat')}</small>
        <button type="button" className="sim-speed-btn" onClick={() => setRevision(value => value + 1)}>{t('compareAgain')}</button>
      </div>}
      <button type="button" className="tp-legend-chip" role="checkbox" aria-checked={enabled}
        aria-expanded={enabled} onClick={() => setEnabled(value => !value)}>
        <span className="tp-legend-chip-text">{t('title')}</span>
        {enabled ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
    </section>
    </>}
  </>)
}
