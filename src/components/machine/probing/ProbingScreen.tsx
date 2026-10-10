// WO-2063 - the Probing screen's own pieces, laid out to
// docs/design/PROBING-SCREEN-V2.md (reference: src/tests/evidence/WO-2063/
// wireframe-v5-1920x1080.png). ProbingPanel owns the state and the runs; these
// only draw it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { DisclosureSection } from '../../ui/DisclosureSection'
import { ProbeStepPicture, meshHeightColor, pictureLayout, probeAt, type PictureMode, type PictureProgress } from './ProbeStepPicture'
import { moveLength, type P3, type ProbeScene, type ProbeStep, type StepMove } from './probeScene'
import './probingScreen.css'

/** The picture box's size, measured (jsdom has no layout: a 1240x675 default). */
function useBoxSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ w: 1240, h: 675 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

/**
 * Before Start, a MACHINE step plays its moves as a preview, one after the
 * other, then again (the Bore video, part 1): a hold at the start, each move
 * eased, a hold where it touches, a hold at the end. Off in tests (no
 * requestAnimationFrame there) and while the machine runs - then the picture
 * follows the machine instead.
 */
export function previewTimeline(moves: StepMove[], touchMove: number | null): { total: number; at: (ms: number) => PictureProgress } {
  const lead = 700
  const tail = 900
  const touchHold = 500
  const spans = moves.map((m, i) => ({
    ms: Math.round(Math.min(1800, Math.max(600, 450 + 60 * moveLength(m)))),
    hold: i === touchMove ? touchHold : 120,
  }))
  const total = lead + spans.reduce((a, s) => a + s.ms + s.hold, 0) + tail
  const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
  return {
    total,
    at: (ms: number) => {
      let e = ms % total
      if (e < lead) return { move: 0, t: 0 }
      e -= lead
      for (let i = 0; i < spans.length; i++) {
        if (e < spans[i].ms) return { move: i, t: ease(e / spans[i].ms) }
        e -= spans[i].ms
        if (e < spans[i].hold) return { move: i, t: 1 }
        e -= spans[i].hold
      }
      return { move: Math.max(0, spans.length - 1), t: 1 }
    },
  }
}

function usePreviewLoop(active: boolean, moves: StepMove[], touchMove: number | null, stepKey: string, once = false): (PictureProgress & { held?: boolean }) | null {
  const [progress, setProgress] = useState<(PictureProgress & { held?: boolean }) | null>(null)
  // WO-2178: read each frame, so turning it on or off never restarts the loop.
  const onceRef = useRef(once)
  onceRef.current = once
  useEffect(() => {
    if (!active || moves.length === 0 || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setProgress(null)
      return
    }
    const line = previewTimeline(moves, touchMove)
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      // Once through, it holds on its last frame instead of starting again.
      const held = onceRef.current && now - t0 >= line.total - 1
      setProgress(held ? { ...line.at(line.total - 1), held } : line.at(now - t0))
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
    // The step's key names its moves; the array itself is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepKey])
  return progress
}

/**
 * While the routine runs, the drawn probe glides from where it is drawn to
 * each newly reported position, along the straight line between them, over
 * the time the last report took to arrive - so it moves smoothly at the
 * screen's own frame rate and arrives just as the next report comes, never
 * ahead of the machine (WO-2063: Operator saw the running probe jump; measured
 * 18 reports/s against 8 redraws/s). Tests (no requestAnimationFrame) draw
 * each report as it comes.
 */
export function useGlide(target: P3 | null): P3 | null {
  const [shown, setShown] = useState<P3 | null>(target)
  const glide = useRef<{ from: P3; to: P3; t0: number; ms: number } | null>(null)
  const lastReport = useRef(0)
  const raf = useRef(0)
  const tx = target?.x
  const ty = target?.y
  const tz = target?.z
  useEffect(() => {
    const cancel = () => { if (raf.current && typeof window !== 'undefined') window.cancelAnimationFrame(raf.current); raf.current = 0 }
    if (tx === undefined || ty === undefined || tz === undefined) {
      cancel()
      glide.current = null
      setShown(null)
      return
    }
    const to = { x: tx, y: ty, z: tz }
    const canAnimate = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const g = glide.current
    if (!canAnimate || !g) {
      glide.current = { from: to, to, t0: now, ms: 1 }
      lastReport.current = now
      setShown(to)
      return
    }
    const at = (x: typeof g, t: number): P3 => {
      const k = Math.max(0, Math.min(1, (t - x.t0) / x.ms))
      return { x: x.from.x + (x.to.x - x.from.x) * k, y: x.from.y + (x.to.y - x.from.y) * k, z: x.from.z + (x.to.z - x.from.z) * k }
    }
    const ms = Math.max(30, Math.min(250, now - lastReport.current))
    lastReport.current = now
    const next = { from: at(g, now), to, t0: now, ms }
    glide.current = next
    cancel()
    const tick = (t: number) => {
      setShown(at(next, t))
      raf.current = t - next.t0 < next.ms ? window.requestAnimationFrame(tick) : 0
    }
    raf.current = window.requestAnimationFrame(tick)
    return cancel
  }, [tx, ty, tz])
  return target ? shown ?? target : null
}

/**
 * WO-2126: how long Play stays on a step before the next - a MACHINE step's
 * preview once through (the loop's own length), a YOU step long enough to read
 * its sentence (Operator, 09-28: he had to discover the step numbers play each
 * step's animation).
 */
export function playStepMs(step: ProbeStep): number {
  return step.owner === 'machine' && step.moves.length > 0 ? previewTimeline(step.moves, step.touchMove).total : 2500
}

/**
 * WO-2126: the Preview steps hover. It must never read as Start probing
 * (Operator, 09-28 8:02 AM): words, not a play triangle, and it says so.
 */
export const PREVIEW_STEPS_HOVER = 'Plays the steps in the picture only - the machine does not move. Start probing runs the routine.'

/**
 * WO-2126: Play walks the before-Start preview through the steps, one after
 * the other, each for its own animation, and stops on the last. Anything else
 * that picks a step stops it where it is.
 */
function usePlayThrough(steps: ProbeStep[], index: number, stepKey: string, show: (i: number) => void, stopIf: boolean, routine: string, holdEnd: boolean) {
  const [playing, setPlaying] = useState(false)
  // WO-2178: the play-through finished on the last step (holdEnd only).
  const [ended, setEnded] = useState(false)
  // Each press of Play counts: the step on screen replays from its start.
  const [run, setRun] = useState(0)
  const showRef = useRef(show)
  showRef.current = show
  useEffect(() => { if (stopIf) { setPlaying(false); setEnded(false) } }, [stopIf])
  useEffect(() => { setPlaying(false); setEnded(false) }, [routine])
  const step = steps[index]
  const last = steps.length - 1
  useEffect(() => {
    if (!playing || !step) return
    const timer = setTimeout(() => {
      if (index < last) showRef.current(index + 1)
      else { setPlaying(false); if (holdEnd) setEnded(true) }
    }, playStepMs(step))
    return () => clearTimeout(timer)
    // The step's key names its moves; the step object is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, last, stepKey])
  return {
    playing,
    ended,
    run,
    start: () => { setRun((r) => r + 1); setEnded(false); setPlaying(true) },
    // Leaving a held end (a step number, Back, Next): the step shown plays
    // its loop again from its start, as picking a step always does.
    stop: () => { setPlaying(false); if (ended) { setEnded(false); setRun((r) => r + 1) } },
  }
}

export interface LiveStepState {
  /** Index of the step the machine is on. */
  step: number
  move: number
  t: number
  touched: boolean
  /** WO-2113: where the drawn probe stands if the run ends here (a miss goes
   *  as far as the machine went, not held short of the drawn top). */
  stoppedAt?: P3 | null
}

export function StepCard({
  scene,
  shown,
  onShow: showStep,
  live,
  runState,
  stoppedWhy = null,
  notStarted = false,
  reportedTip = null,
  confirm,
  refusal,
}: {
  scene: ProbeScene
  /** The step on screen (index), when paging before Start. */
  shown: number
  onShow: (index: number) => void
  /** While the routine runs: where the machine is. */
  live: LiveStepState | null
  /** 'running' | 'paused' | 'stopped' | 'done' | 'idle' */
  runState: 'idle' | 'running' | 'paused' | 'stopped' | 'done'
  /** WO-2113: why the run stopped - its console line, word for word. */
  stoppedWhy?: string | null
  /** WO-2664: the last Start was refused before any motion; `stoppedWhy` is
   *  its reason, in place of the previous run's. */
  notStarted?: boolean
  /** WO-2587: reported tip in the feature datum; changes depth only at the part. */
  reportedTip?: P3 | null
  /** The Confirm control and result words, drawn beside the Confirm step's sentence. */
  confirm: ReactNode
  refusal: string | null
}) {
  const [boxRef, size] = useBoxSize<HTMLDivElement>()
  const steps = scene.steps
  const following = live !== null && (runState === 'running' || runState === 'paused')
  const index = following ? Math.min(live!.step, steps.length - 1) : Math.min(shown, Math.max(0, steps.length - 1))
  const step = steps[index]
  const touchMove = step?.touchMove ?? (step?.moves.length ?? 1) - 1
  const previewing = !following && runState !== 'done' && runState !== 'stopped'
  const stepKey = `${scene.routine}:${index}:${step?.sentence}:${step?.moves.map((m) => `${m.to.x},${m.to.y},${m.to.z}`).join(';')}`
  // WO-2126: Play steps through the preview; a step number, Back or Next
  // stops it where it is. Hidden while a real run is followed.
  // WO-2178 (Operator 09-29: "angle probing preview keeps repeating step 5"):
  // Angle has no Confirm step (WO-2112), so its play-through ends on a MACHINE
  // step, and that step's preview looped for ever after the play-through
  // stopped. Its last step now plays once and holds on its end, as the other
  // routines end on a still step. Work Z0 and Tool Z also end on a MACHINE
  // step; they are left as they were (the order: no other routine changes).
  // WO-2180 (Operator 09-29: "tool z probe preview keeps repeating step 6"): the
  // same cause on Tool Z, the same cure. Work Z0 is still left as it was.
  const holdEnd = scene.routine === 'angle' || scene.routine === 'toolZ'
  const play = usePlayThrough(steps, index, stepKey, showStep, following, scene.routine, holdEnd)
  const playOnce = holdEnd && index === steps.length - 1 && (play.playing || play.ended)
  const preview = usePreviewLoop(previewing && step?.owner === 'machine', step?.moves ?? [], step?.touchMove ?? null, `${stepKey}:${play.run}`, playOnce)
  const onShow = (i: number) => { play.stop(); showStep(i) }
  const canPlay = !following && steps.length > 1
  const togglePlay = () => {
    if (play.playing) { play.stop(); return }
    // From the step on screen; from step 1 on the last step or after a run.
    showStep(index >= steps.length - 1 || !previewing ? 0 : index)
    play.start()
  }
  const progress: PictureProgress | null = following ? { move: live!.move, t: live!.t } : previewing ? preview : null
  // The touch lights (a ring in the preview) once the move that makes it is
  // done; a face's step carries on past it: back off and the way back.
  const past = (p: PictureProgress | null) => p !== null && (p.move > touchMove || (p.move === touchMove && p.t >= 1))
  const touched = following ? live!.touched || past(live) : previewing ? past(preview) : runState === 'done'
  const mode: PictureMode = following && runState !== 'paused' ? 'running' : previewing ? 'preview' : 'after'
  // Where the real probe is: before Start, at the operator's start (nothing
  // has moved); after a run, where the run left it.
  const stoppedStep = runState === 'stopped' && live ? steps[Math.min(live.step, steps.length - 1)] : null
  const real: P3 = stoppedStep && live
    ? live.stoppedAt ?? probeAt(stoppedStep, { move: live.move, t: live.t })
    : runState === 'done'
      ? [...steps].reverse().find((s) => s.owner === 'machine' && s.moves.length)?.end ?? scene.start
      : scene.start
  // WO-2152: the probe move a stopped run ended on without touching (a miss).
  const stoppedMove = stoppedStep && live && !live.touched && stoppedStep === step ? stoppedStep.moves[live.move] : undefined
  const missed = stoppedMove?.kind === 'probe' ? stoppedMove : null
  // Running: the probe drawn where the machine is, glided between reports.
  const glided = useGlide(following && step ? probeAt(step, { move: live!.move, t: live!.t }) : null)
  // WO-2184: a Z surface run has a step per move for every point, but shows
  // the 8 plan steps (each step says which it shows as) and counts the points.
  const chipOf = (i: number) => steps[i]?.chip ?? steps[i]?.n ?? i + 1
  const chipSeen = new Set<number>()
  const chipList = steps.flatMap((s, i) => (chipSeen.has(chipOf(i)) ? [] : (chipSeen.add(chipOf(i)), [{ n: chipOf(i), first: i, owner: s.owner }])))
  const chipIndex = Math.max(0, chipList.findIndex((c) => c.n === chipOf(index)))
  const liveChip = runState === 'done' ? Infinity : following || runState === 'stopped' ? chipOf(live?.step ?? 0) : -Infinity
  const pictureH = Math.max(200, size.h)
  const { sideW } = pictureLayout(scene, size.w, pictureH)
  // One row of step numbers, whatever the count (Boss has 22): each chip
  // takes its share of the card, 60 px at most; the numbers stay 18 px or more.
  // Back / Next when there is room for them beside full-size numbers; on a
  // narrow card the numbers alone page (each one is a button). When even
  // 30 px chips do not fit, the row is a window of chips round the current
  // step with the first and last numbers at the ends (the approved design).
  // Play takes its own room first (WO-2126): its width at a step number's
  // text size and its gap (WO-2181 measured "Preview steps" 158 px at 20 px;
  // 150 wrapped it under the numbers).
  const playW = canPlay ? 160 : 0
  const paging = !following && (size.w - playW - 2 * 96 - 6 * chipList.length) / Math.max(1, chipList.length) >= 36
  const pagingW = playW + (paging ? 2 * 96 : 0)
  const fits = size.w <= 0 ? chipList.length : Math.max(3, Math.floor((size.w - pagingW + 6) / (30 + 6)))
  const shownChips = chipWindow(chipList.length, chipIndex, fits)
  const chipW = Math.max(30, Math.min(60, Math.floor((size.w - pagingW - 6 * shownChips.length) / Math.max(1, shownChips.length))))
  // WO-2181: halfway between the old 26 / 24 / 22 and the UI's 14.
  const chipFont = chipW >= 44 ? 20 : chipW >= 36 ? 19 : 18
  // WO-2184: while a Z surface run is followed, stopped or done, which point it is on.
  const pointWords = scene.mesh && step?.point !== undefined && (following || runState === 'stopped' || runState === 'done')
    ? `Point ${step.point} of ${scene.mesh.points.length}`
    : null
  const legend = scene.mesh?.legend ?? null
  // The step named is the plan step (chip) it shows as - one of the chips on screen.
  const statusWords = runState === 'paused'
    ? `Paused at step ${chipOf(index)}`
    : runState === 'stopped'
      ? notStarted ? 'Did not start' : `Stopped at step ${chipOf(live?.step ?? index)}`
      : null
  // WO-2664 (machine session 10-07: "no visual indication on the screen that any fault had
  // occurred"): a stopped run's line reads in the console's error red.
  const stoppedTone = runState === 'stopped' ? { color: 'var(--accent-red)' } : undefined

  return (
    <section className="panel control-panel pbn-card" data-testid="probing-step-card">
      <div className="pbn-captions" style={{ gridTemplateColumns: `${sideW + 48}px 1fr` }}>
        {/* WO-2127: named by the real view. The side drawing puts its axis to
            the right and Z up: along X it looks toward +Y (Front view), along
            Y it looks toward -X with +Y to the right (Right view). */}
        <span className="pbn-caption" data-testid="probing-caption-side">{step?.view === 'Y' ? 'Right view' : 'Front view'}</span>
        <span className="pbn-caption" data-testid="probing-caption-top">Top view</span>
      </div>
      <div className="pbn-picture-box" ref={boxRef} data-testid="probing-picture-box">
        {step
          ? <ProbeStepPicture scene={scene} step={step} width={size.w} height={pictureH} progress={progress} touched={touched}
              mode={mode} real={following && glided ? glided : real} reportedTip={following || runState === 'stopped' ? reportedTip : null} missed={missed}
              previewPhase={following ? 'live' : preview === null || preview.held ? 'still' : preview.move === 0 && preview.t === 0 ? 'start' : 'playing'} />
          : <div className="pbn-refusal" data-testid="probing-scene-refusal">{refusal ?? scene.refusal ?? 'This routine has no steps yet.'}</div>}
      </div>
      <div className="pbn-sentence-row">
        <p className="pbn-sentence" data-testid="probing-step-sentence" data-owner={step?.owner}>
          {step?.sentence ?? ''}
        </p>
        {step?.confirm && confirm}
        {legend && (
          <div className="pbn-mesh-legend" data-testid="probing-mesh-heights">
            <span data-testid="probing-mesh-low">{legend.low}</span>
            <span className="pbn-mesh-ramp" aria-hidden="true" style={{ background: `linear-gradient(to right, ${meshHeightColor(0)}, ${meshHeightColor(0.5)}, ${meshHeightColor(1)})` }} />
            <span data-testid="probing-mesh-high">{legend.high}</span>
            <span className="pbn-mesh-range" data-testid="probing-mesh-range">range {legend.range}</span>
          </div>
        )}
      </div>
      <div className="pbn-band" aria-hidden="true" />
      <div
        className="pbn-strip"
        data-testid="probing-step-strip"
        style={{ '--pbn-chip-w': `${chipW}px`, '--pbn-chip-font': `${chipFont}px` } as React.CSSProperties}
      >
        {paging && (
          <button type="button" className="pbn-page" data-testid="probing-step-back" disabled={chipIndex <= 0} onClick={() => onShow(chipList[chipIndex - 1].first)}>Back</button>
        )}
        <ol className="pbn-chips">
          {shownChips.map((ci) => {
            const s = chipList[ci]
            const done = s.n < liveChip
            const current = ci === chipIndex
            return (
              <li key={s.n}>
                <button
                  type="button"
                  className={`pbn-chip${current ? ' pbn-chip-current' : ''}${done ? ' pbn-chip-done' : ''}`}
                  data-testid={`probing-step-chip-${s.n}`}
                  data-owner={s.owner}
                  data-done={done ? 'true' : undefined}
                  aria-current={current ? 'step' : undefined}
                  disabled={following}
                  onClick={() => onShow(s.first)}
                >
                  <span className="pbn-chip-n">{s.n}</span>
                  <span className="pbn-chip-foot">
                    {done && <Check size={16} strokeWidth={3} className="pbn-chip-tick" aria-label="done" />}
                    {s.owner === 'you' && <span className="pbn-chip-you">YOU</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {paging && (
          <button type="button" className="pbn-page" data-testid="probing-step-next" disabled={chipIndex >= chipList.length - 1} onClick={() => onShow(chipList[chipIndex + 1].first)}>Next</button>
        )}
        {canPlay && (
          <button
            type="button"
            className={`pbn-page pbn-play${play.playing ? ' pbn-play-on' : ''}`}
            data-testid="probing-step-play"
            data-playing={play.playing ? 'true' : 'false'}
            aria-pressed={play.playing}
            data-tooltip={PREVIEW_STEPS_HOVER}
            onClick={togglePlay}
          >
            <span>{play.playing ? 'Stop preview' : 'Preview steps'}</span>
          </button>
        )}
        {pointWords && <span className="pbn-point-counter" data-testid="probing-point-counter">{pointWords}</span>}
        {statusWords && (
          <span className={`pbn-run-line${runState === 'stopped' && stoppedWhy ? ' pbn-run-line-why' : ''}`} data-testid="probing-run-line">
            <span className="pbn-run-state" data-testid="probing-run-state" style={stoppedTone}>{statusWords}</span>
            {runState === 'stopped' && stoppedWhy && <span className="pbn-run-why" data-testid="probing-run-why" style={stoppedTone}>{stoppedWhy}</span>}
          </span>
        )}
      </div>
    </section>
  )
}

/** Which step indexes the row shows: all when they fit; else the first, the
 *  last, and a run round the current step. */
export function chipWindow(count: number, current: number, fits: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i)
  if (count <= fits) return all
  const middle = Math.max(1, fits - 2)
  const from = Math.min(Math.max(1, current - Math.floor(middle / 2)), Math.max(1, count - 1 - middle))
  return [0, ...all.slice(from, Math.min(count - 1, from + middle)), count - 1]
}

/** The six marks, each drawn as the pictures draw it (the approved key). */
export function PictureKey() {
  const row = (sample: ReactNode, words: string, id: string) => (
    <li className="pbn-key-row" data-testid={`probing-key-${id}`}>
      <svg className="pbn-key-sample" viewBox="0 0 64 34" width={64} height={34} aria-hidden="true">{sample}</svg>
      <span>{words}</span>
    </li>
  )
  return (
    <ul className="pbn-key" data-testid="probing-picture-key">
      {row(<circle cx={32} cy={17} r={12} className="pbn-ghost" />, 'Faded probe: where this step starts', 'ghost')}
      {row(<><line x1={4} y1={17} x2={44} y2={17} stroke="var(--vp-axis-x)" strokeWidth={5} /><polygon points="60,17 42,7 42,27" fill="var(--vp-axis-x)" /></>, 'Solid arrow: moves to a position', 'move')}
      {row(<><line x1={4} y1={17} x2={44} y2={17} stroke="var(--vp-axis-x)" strokeWidth={5} strokeDasharray="10 6" /><polygon points="60,17 42,7 42,27" fill="var(--vp-axis-x)" /></>, 'Dashed arrow: probes, stops at the first touch', 'probe')}
      {row(<><line x1={4} y1={17} x2={44} y2={17} stroke="var(--role-identity-light)" strokeWidth={5} strokeDasharray="3 6" /><polygon points="60,17 42,7 42,27" fill="var(--role-identity-light)" /></>, 'Dotted arrow: you jog the probe here', 'jog')}
      {row(<circle cx={32} cy={17} r={9} fill="var(--select-viewport)" />, 'Orange dot: where it touched', 'touch')}
      {row(<><circle cx={17} cy={17} r={13} fill="none" stroke="var(--text-primary)" strokeWidth={2.5} /><text x={17} y={23} textAnchor="middle" fontSize={17} fontWeight={700} fill="var(--text-primary)">1</text><circle cx={47} cy={17} r={13} fill="none" stroke="var(--text-primary)" strokeWidth={2.5} /><text x={47} y={23} textAnchor="middle" fontSize={17} fontWeight={700} fill="var(--text-primary)">2</text></>, 'Numbers: two moves, in this order', 'numbers')}
    </ul>
  )
}

export function MoreAboutStep({ sections }: { sections: Array<{ heading: string; lines: string[] }> }) {
  if (sections.length === 0) {
    return <p className="pbn-more-empty" data-testid="probing-more-empty">Nothing more to this step - the picture and its sentence say it all.</p>
  }
  return (
    <div className="pbn-more" data-testid="probing-more">
      {sections.map((s) => (
        <div key={s.heading} className="pbn-more-section">
          <h4>{s.heading}</h4>
          {s.lines.map((line) => <p key={line}>{line}</p>)}
        </div>
      ))}
    </div>
  )
}

/** The right column's two disclosures: they open one at a time. */
export function KeyAndMore({ more }: { more: Array<{ heading: string; lines: string[] }> }) {
  // Open with the key where the column has room for it under the jog pad and
  // above the E-STOP (1080 tall); on a shorter screen both start closed, so
  // the E-STOP, Start probing and Stop are never pushed off the screen.
  const [open, setOpen] = useState<'key' | 'more' | null>(() => (typeof window !== 'undefined' && window.innerHeight < 1000 ? null : 'key'))
  return (
    <>
      <section className={`panel control-panel pbn-disclosure${open === 'key' ? ' pbn-disclosure-open' : ''}`} data-testid="probing-key-panel">
        <DisclosureSection
          title="Picture key"
          open={open === 'key'}
          onToggle={() => setOpen((o) => (o === 'key' ? null : 'key'))}
          testId="probing-key-toggle"
        >
          <PictureKey />
        </DisclosureSection>
      </section>
      <section className={`panel control-panel pbn-disclosure pbn-more-panel${open === 'more' ? ' pbn-disclosure-open pbn-more-open' : ''}`} data-testid="probing-more-panel">
        <DisclosureSection
          title="More about this step"
          open={open === 'more'}
          onToggle={() => setOpen((o) => (o === 'more' ? null : 'more'))}
          testId="probing-more-toggle"
        >
          <MoreAboutStep sections={more} />
        </DisclosureSection>
      </section>
    </>
  )
}
