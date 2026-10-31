// WO-3279 (UI M2 W1-B): the kit surfaces. Card, Section, PropRow, Pill, Tooltip, Dialog, Window,
// Confirm and BrowserRow, against the props in ../types. Looks come from surfaces.css on the
// token custom properties; focus, Escape, keyboard and accessibility live here, never in screens.
// Dialog, Window and Confirm join the ONE dialog stack in src/commands (Escape closes the top
// one only); this folder adds no keydown listener of its own beyond the element-level keys of
// the part being used.
import {
  useId, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode,
} from 'react'
import type {
  BrowserRowProps, CardProps, ConfirmProps, DialogProps, PillProps, PropRowProps, SectionProps, WindowProps,
} from '../types'
import { Footer } from './frame'
import { useModal } from './modal'
import './surfaces.css'

export { Tooltip, TOOLTIP_DELAY_MS } from './tooltip'

function Icon({ id }: { id: string | undefined }) {
  return id === undefined ? null : <span className="kit-icon" data-icon={id} aria-hidden="true" />
}

// ---------------------------------------------------------------- Pill
export function Pill(p: PillProps) {
  return <span className="kit-pill" data-kit="Pill" data-tone={p.tone} data-testid={p.testId}>{p.label}</span>
}

// ---------------------------------------------------------------- Card
type CardShellProps = CardProps & {
  /** Window only: lets the header act as the move handle. */
  readonly headerProps?: HTMLAttributes<HTMLElement> & { 'data-testid'?: string }
  readonly danger?: boolean
}

function CardShell(p: CardShellProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { 'data-testid': handleId, ...handle } = p.headerProps ?? {}
  return (
    <section className="kit-card" data-kit="Card" data-testid={p.testId} aria-label={p.title}>
      <header className="kit-card-header" data-testid={handleId} {...handle}>
        <Icon id={p.icon} />
        <span className="kit-card-title">{p.title}</span>
        {p.status && <Pill {...p.status} />}
        {p.menu !== undefined && (
          <span
            className="kit-card-menuwrap"
            onKeyDown={e => { if (e.key === 'Escape' && menuOpen) { e.stopPropagation(); setMenuOpen(false) } }}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false) }}
          >
            <button type="button" className="kit-card-more" aria-label={p.menuLabel ?? p.title} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)} />
            {menuOpen && <div className="kit-card-menu" role="menu" onClick={() => setMenuOpen(false)}>{p.menu}</div>}
          </span>
        )}
        {p.onClose && <button type="button" className="kit-card-close" data-kit-close="" aria-label={p.closeLabel} onClick={p.onClose} />}
      </header>
      <div className="kit-card-body">{p.children}</div>
      <Footer footer={p.footer} danger={p.danger} />
    </section>
  )
}

export function Card(p: CardProps) {
  return <CardShell {...p} />
}

// ---------------------------------------------------------------- Section
export function Section(p: SectionProps) {
  const [own, setOwn] = useState(p.defaultOpen ?? true)
  const bodyId = useId()
  const open = p.open ?? own
  const toggle = () => { setOwn(!open); p.onToggle?.(!open) }
  return (
    <div className="kit-section" data-kit="Section" data-testid={p.testId} data-open={open}>
      <button type="button" className="kit-section-header" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className="kit-section-caption">{p.caption}</span>
        {p.summary !== undefined && <span className="kit-section-summary">{p.summary}</span>}
      </button>
      {open && <div id={bodyId} className="kit-section-body">{p.children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- PropRow
export function PropRow(p: PropRowProps) {
  const labelId = useId()
  return (
    <div className="kit-proprow" role="group" aria-labelledby={labelId} data-kit="PropRow" data-testid={p.testId}>
      <span id={labelId} className="kit-proprow-label">{p.label}</span>
      <div className="kit-proprow-value">{p.children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- Dialog
function DialogFrame(p: { open: boolean; kind: 'dialog' | 'window' | 'alertdialog'; title: string; onClose(): void; testId?: string; style?: CSSProperties; children: ReactNode; className: string; danger?: boolean; describedBy?: string }) {
  const id = useId()
  const frame = useRef<HTMLDivElement>(null)
  const onKeyDown = useModal(p.open, `${p.kind}:${id}`, p.onClose, frame)
  if (!p.open) return null
  return (
    <div className="kit-scrim">
      <div
        ref={frame}
        className={p.className}
        role={p.kind === 'window' ? 'dialog' : p.kind}
        aria-modal="true"
        aria-label={p.title}
        aria-describedby={p.describedBy}
        tabIndex={-1}
        data-kit={p.kind === 'dialog' ? 'Dialog' : p.kind === 'window' ? 'Window' : 'Confirm'}
        data-testid={p.testId}
        data-danger={p.danger === undefined ? undefined : p.danger}
        style={p.style}
        onKeyDown={onKeyDown}
      >
        {p.children}
      </div>
    </div>
  )
}

export function Dialog(p: DialogProps) {
  return (
    <DialogFrame open={p.open} kind="dialog" title={p.title} onClose={p.onClose} testId={p.testId} className="kit-dialog">
      <CardShell title={p.title} onClose={p.onClose} closeLabel={p.closeLabel} footer={p.footer}>{p.children}</CardShell>
    </DialogFrame>
  )
}

// ---------------------------------------------------------------- Window
const placed = new Map<string, { x: number; y: number }>()
const NUDGE = 16
/** Header px that always stay inside the viewport. */
const HEADER_KEEP = 80

export function Window(p: WindowProps) {
  const key = p.testId ?? p.title
  const [pos, setPos] = useState(() => placed.get(key) ?? { x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null)
  const move = (x: number, y: number) => {
    // the window is 80% of the viewport, centred: keep its header on screen
    const W = window.innerWidth
    const H = window.innerHeight
    const next = {
      x: Math.max(-(0.9 * W - HEADER_KEEP), Math.min(0.9 * W - HEADER_KEEP, x)),
      y: Math.max(-0.1 * H, Math.min(0.9 * H - HEADER_KEEP, y)),
    }
    placed.set(key, next)
    setPos(next)
  }
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    const d = ({ ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] } as Record<string, number[]>)[e.key]
    if (d) { e.preventDefault(); move(pos.x + d[0], pos.y + d[1]) }
  }
  const handle = {
    'data-testid': p.testId === undefined ? undefined : `${p.testId}-handle`,
    tabIndex: 0,
    onKeyDown: onKey,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target !== e.currentTarget && (e.target as HTMLElement).closest('button'))) return
      drag.current = { x: e.clientX, y: e.clientY, from: pos }
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current
      if (d) move(d.from.x + e.clientX - d.x, d.from.y + e.clientY - d.y)
    },
    onPointerUp: () => { drag.current = null },
    onPointerCancel: () => { drag.current = null },
  }
  return (
    <DialogFrame
      open={p.open}
      kind="window"
      title={p.title}
      onClose={p.onClose}
      testId={p.testId}
      className="kit-window"
      style={{ '--kit-x': `${pos.x}px`, '--kit-y': `${pos.y}px` } as CSSProperties}
    >
      <CardShell title={p.title} onClose={p.onClose} closeLabel={p.closeLabel} footer={p.footer} headerProps={handle}>
        <div className="kit-window-split">
          {p.nav && (
            <nav className="kit-window-nav">
              {p.nav.map(n => (
                <button
                  key={n.id}
                  type="button"
                  aria-current={n.id === p.activeNav ? 'page' : undefined}
                  onClick={() => p.onNav?.(n.id)}
                  onKeyDown={e => {
                    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
                    if (!step) return
                    e.preventDefault()
                    const all = [...e.currentTarget.parentElement!.querySelectorAll<HTMLElement>('button')]
                    all[(all.indexOf(e.currentTarget) + step + all.length) % all.length].focus()
                  }}
                >
                  <Icon id={n.icon} />
                  {n.label}
                </button>
              ))}
            </nav>
          )}
          <div className="kit-window-page">{p.children}</div>
        </div>
      </CardShell>
    </DialogFrame>
  )
}

// ---------------------------------------------------------------- Confirm
export function Confirm(p: ConfirmProps) {
  const danger = p.danger ?? false
  const sentenceId = useId()
  return (
    <DialogFrame describedBy={sentenceId} open={p.open} kind="alertdialog" title={p.title} onClose={p.onCancel} testId={p.testId} className="kit-confirm" danger={danger}>
      <CardShell
        title={p.title}
        danger={danger}
        footer={{
          cancel: { label: p.cancelLabel, onPress: p.onCancel },
          primary: { label: p.actionLabel, onPress: p.onConfirm },
        }}
      >
        <p id={sentenceId} className="kit-confirm-sentence">{p.sentence}</p>
      </CardShell>
    </DialogFrame>
  )
}

// ---------------------------------------------------------------- BrowserRow
export function BrowserRow(p: BrowserRowProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect?.() }
    else if (e.key === 'ArrowRight' && p.expanded === false) { e.preventDefault(); p.onToggle?.() }
    else if (e.key === 'ArrowLeft' && p.expanded === true) { e.preventDefault(); p.onToggle?.() }
  }
  return (
    <div
      className="kit-browserrow"
      role="treeitem"
      tabIndex={0}
      aria-selected={p.selected ?? false}
      aria-expanded={p.expanded}
      aria-level={p.depth + 1}
      data-kit="BrowserRow"
      data-testid={p.testId}
      data-status={p.status}
      data-muted={p.muted ?? false}
      style={{ '--kit-depth': String(p.depth) } as CSSProperties}
      onClick={p.onSelect}
      onKeyDown={onKeyDown}
    >
      {p.expanded !== undefined
        ? <button type="button" className="kit-browserrow-chevron" data-expanded={p.expanded} aria-label={p.toggleLabel} tabIndex={-1} onClick={e => { e.stopPropagation(); p.onToggle?.() }} />
        : <span className="kit-browserrow-chevron" aria-hidden="true" />}
      <Icon id={p.icon} />
      {p.status && <span className="kit-browserrow-status" aria-hidden="true" />}
      <span className="kit-browserrow-name">{p.name}</span>
      {p.meta !== undefined && <span className="kit-browserrow-meta">{p.meta}</span>}
      {p.actions && <span className="kit-browserrow-actions">{p.actions}</span>}
    </div>
  )
}
