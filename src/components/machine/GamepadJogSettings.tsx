// WO-3259: Settings -> Gamepad step. Pick an observed pad, capture a raw
// button or axis half for X+/X-/Y+/Y-/Z+/Z- and one distinct deadman button,
// invert, set the dead zone and speed, watch a live preview, Apply - and the
// session-only Enable that lets Control read the pad.
//
// NOTHING HERE MOVES THE MACHINE. Settings is a dialog, and the Control hook
// drops its arm while any dialog is open; this section only reads the pad
// through the same snapshot provider and names what a press would do.

import { useEffect, useRef, useState } from 'react'
import { textFor, useText } from '../../i18n'
import { useUiPrefs } from '../../store/uiPrefs'
import { ThemedListbox } from '../ui/ThemedListbox'
import { NumericInput } from '../ui/NumericInput'
import {
  GAMEPAD_DEAD_ZONE_MAX,
  GAMEPAD_DEAD_ZONE_MIN,
  GAMEPAD_JOG_AXES,
  GAMEPAD_JOG_DIRECTIONS,
  capturedRawInput,
  connectedGamepads,
  deadmanHeld,
  emptyGamepadJogPrefs,
  findGamepad,
  gamepadFingerprint,
  gamepadMappingClash,
  gamepadSnapshots,
  readGamepadGesture,
  readGamepadJogPrefs,
  useGamepadJogSession,
  type GamepadJogDirection,
  type GamepadJogPrefs,
  type GamepadRawInput,
  type GamepadSnapshot,
  type GamepadSnapshotProvider,
} from '../../lib/machine/gamepadJogInput'

const gamepadText = textFor('gamepad-jog.wo3259')

function inputLabel(input: GamepadRawInput | null): string {
  if (input === null) return gamepadText('unmapped')
  return input.kind === 'button'
    ? gamepadText('button', { index: input.index })
    : gamepadText('axis', { index: input.index, sign: input.sign === 1 ? '+' : '-' })
}

function padSignature(pads: readonly GamepadSnapshot[]): string {
  return pads.map((pad) => `${pad.index}|${pad.id}|${pad.buttons.map((b) => (b.pressed ? 1 : 0)).join('')}|${pad.axes.map((a) => a.toFixed(2)).join(',')}`).join(';')
}

type Slot = GamepadJogDirection | 'deadman'

export function GamepadJogSettings({
  provider = gamepadSnapshots,
  pollMs = 50,
}: {
  provider?: GamepadSnapshotProvider
  pollMs?: number
} = {}) {
  const t = useText('gamepad-jog.wo3259')
  const stored = useUiPrefs((s) => s.gamepadJog)
  const setGamepadJog = useUiPrefs((s) => s.setGamepadJog)
  const enabled = useGamepadJogSession((s) => s.enabled)
  const setEnabled = useGamepadJogSession((s) => s.setEnabled)
  const read = readGamepadJogPrefs(stored)
  const [draft, setDraft] = useState<GamepadJogPrefs>(() =>
    read.status === 'ok' ? read.prefs : emptyGamepadJogPrefs())
  const [applied, setApplied] = useState(false)
  const [pads, setPads] = useState<GamepadSnapshot[]>([])
  const [capturing, setCapturing] = useState<Slot | null>(null)
  const [clash, setClash] = useState<string | null>(null)
  const baseline = useRef<GamepadSnapshot | null>(null)
  const signature = useRef('')
  const capturingRef = useRef<Slot | null>(null)
  // The first pad seen is the draft's pad until the operator picks one.
  const fingerprint = draft.deviceFingerprint ?? (pads.length > 0 ? gamepadFingerprint(pads[0]) : null)
  const fingerprintRef = useRef<string | null>(fingerprint)
  useEffect(() => { fingerprintRef.current = fingerprint }, [fingerprint])

  const beginCapture = (slot: Slot | null, from: GamepadSnapshot | null) => {
    capturingRef.current = slot
    baseline.current = from
    setCapturing(slot)
  }

  useEffect(() => {
    // Capture: the first input that moved from where it rested when Capture
    // was pressed. Read in the poll, so nothing waits on a render.
    const capture = (now: readonly GamepadSnapshot[]) => {
      const slot = capturingRef.current
      if (slot === null) return
      const target = findGamepad(now, fingerprintRef.current)
      if (target === null) return
      if (baseline.current === null || baseline.current.index !== target.index) {
        baseline.current = target
        return
      }
      const got = capturedRawInput(baseline.current, target, slot === 'deadman')
      if (got === null) return
      setDraft((d) => slot === 'deadman'
        ? { ...d, deadman: got.kind === 'button' ? got : d.deadman }
        : { ...d, mappings: { ...d.mappings, [slot]: got } })
      setClash(null)
      beginCapture(null, null)
    }
    const poll = () => {
      const next = connectedGamepads(provider())
      capture(next)
      const sig = padSignature(next)
      if (sig === signature.current) return
      signature.current = sig
      setPads(next)
    }
    poll()
    const timer = setInterval(poll, pollMs)
    return () => clearInterval(timer)
  }, [provider, pollMs])

  const pad = findGamepad(pads, fingerprint)

  const startCapture = (slot: Slot) => beginCapture(slot, pad)

  const clear = (slot: Slot) => {
    setDraft((d) => slot === 'deadman'
      ? { ...d, deadman: null }
      : { ...d, mappings: { ...d.mappings, [slot]: null } })
    setClash(null)
  }

  const apply = () => {
    const found = gamepadMappingClash(draft)
    if (found !== null) {
      setClash(found.kind === 'deadman-is-direction'
        ? t('clashDeadman', { direction: found.direction })
        : t('clashShared', { first: found.first, second: found.second }))
      setApplied(false)
      return
    }
    setClash(null)
    setGamepadJog({ ...draft, deviceFingerprint: fingerprint })
    setApplied(true)
  }

  const reset = () => {
    setGamepadJog(null)
    setDraft(emptyGamepadJogPrefs(pad === null ? null : gamepadFingerprint(pad)))
    beginCapture(null, null)
    setClash(null)
    setApplied(false)
  }

  const preview = (() => {
    if (pad === null) return null
    const gesture = readGamepadGesture(pad, draft)
    const motion = gesture.kind === 'neutral'
      ? t('previewNeutral')
      : gesture.kind === 'simultaneous'
        ? t('previewSimultaneous')
        : t('previewDirection', { direction: `${gesture.axis}${gesture.sign === 1 ? '+' : '-'}` })
    const held = deadmanHeld(pad, draft) ? t('held') : t('released')
    return { motion, deadman: t('previewDeadman', { state: held }) }
  })()

  const padOptions = pads.map((p) => ({
    value: gamepadFingerprint(p),
    label: t('padOption', { name: p.id, slot: p.index }),
  }))

  const slotRow = (slot: Slot, label: string, input: GamepadRawInput | null) => (
    <div key={slot} className="mform-row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid={`gamepad-jog-row-${slot}`}>
      <label className="mform-label" style={{ minWidth: '13rem' }}>{label}</label>
      <span data-testid={`gamepad-jog-map-${slot}`} style={{ minWidth: '6rem' }}>
        {capturing === slot ? t('capturing') : inputLabel(input)}
      </span>
      <button
        type="button"
        className="modal-btn modal-btn-ghost"
        data-testid={`gamepad-jog-capture-${slot}`}
        disabled={pad === null}
        onClick={() => startCapture(slot)}
      >{t('capture')}</button>
      <button
        type="button"
        className="modal-btn modal-btn-ghost"
        data-testid={`gamepad-jog-clear-${slot}`}
        onClick={() => clear(slot)}
      >{t('clear')}</button>
    </div>
  )

  return (
    <div data-testid="settings-gamepad-jog">
      <div className="mform-section-header">{t('section')}</div>
      <div className="mform-hint">{t('hint')}</div>
      {read.status === 'unreadable' && (
        <div className="mform-hint" role="alert" data-testid="gamepad-jog-unreadable">{t('unreadable')}</div>
      )}
      <div className="mform-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="mform-label">{t('pad')}</label>
        {pads.length === 0
          ? <span className="mform-hint" data-testid="gamepad-jog-no-pads">{t('noPads')}</span>
          : (
            <ThemedListbox
              testId="gamepad-jog-pad"
              ariaLabel={t('pad')}
              value={fingerprint ?? ''}
              options={padOptions}
              onChange={(chosen) => setDraft((d) => ({ ...d, deviceFingerprint: chosen }))}
            />
          )}
      </div>
      {fingerprint !== null && pad === null && (
        <div className="mform-hint" data-testid="gamepad-jog-pad-absent">
          {t('savedPadAbsent', { name: fingerprint })}
        </div>
      )}
      {GAMEPAD_JOG_DIRECTIONS.map((direction) => slotRow(direction, direction, draft.mappings[direction]))}
      {slotRow('deadman', t('deadman'), draft.deadman)}
      <div className="mform-row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {GAMEPAD_JOG_AXES.map((axis) => (
          <label key={axis} className="op-check-label">
            <input
              type="checkbox"
              data-testid={`gamepad-jog-invert-${axis}`}
              checked={draft.inverted[axis]}
              onChange={(e) => setDraft((d) => ({ ...d, inverted: { ...d.inverted, [axis]: e.target.checked } }))}
            />
            <span>{t('invert', { axis })}</span>
          </label>
        ))}
      </div>
      <div className="mform-row" style={{ gap: 8 }}>
        <label className="mform-label">{t('deadZone')}</label>
        <NumericInput
          className="mform-input mform-input-sm"
          ariaLabel={t('deadZone')}
          value={draft.deadZone}
          min={GAMEPAD_DEAD_ZONE_MIN}
          max={GAMEPAD_DEAD_ZONE_MAX}
          step={0.05}
          onChange={(deadZone) => setDraft((d) => ({ ...d, deadZone }))}
        />
      </div>
      <div className="mform-row" style={{ gap: 8 }}>
        <label className="mform-label">{t('speedScale')}</label>
        <NumericInput
          className="mform-input mform-input-sm"
          ariaLabel={t('speedScale')}
          value={Math.round(draft.speedScale * 100)}
          min={1}
          max={100}
          step={5}
          onChange={(percent) => setDraft((d) => ({ ...d, speedScale: percent / 100 }))}
        />
      </div>
      <div className="mform-row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="gamepad-jog-preview">
        <label className="mform-label">{t('preview')}</label>
        {preview !== null && (
          <>
            <span data-testid="gamepad-jog-preview-motion">{preview.motion}</span>
            <span data-testid="gamepad-jog-preview-deadman">{preview.deadman}</span>
          </>
        )}
      </div>
      {clash !== null && (
        <div className="mform-hint" role="alert" data-testid="gamepad-jog-clash">{clash}</div>
      )}
      {applied && clash === null && (
        <p className="mform-help" role="status" data-testid="gamepad-jog-applied">{t('applied')}</p>
      )}
      <div className="mform-row" style={{ gap: 8 }}>
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="gamepad-jog-apply" onClick={apply}>{t('apply')}</button>
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="gamepad-jog-reset" onClick={reset}>{t('reset')}</button>
      </div>
      <div className="mform-row">
        <label className="op-check-label">
          <input
            type="checkbox"
            data-testid="gamepad-jog-enable"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{t('enable')}</span>
        </label>
      </div>
    </div>
  )
}
