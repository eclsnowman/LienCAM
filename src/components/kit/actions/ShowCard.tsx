// WO-3280: the Show card (spec 9): bottom right of the view, its header is the button, the list
// opens upward, one eye per row. The screen keeps the open state when it wants it remembered.
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { ShowCardProps } from '../types'

export function ShowCard(p: ShowCardProps) {
  const [own, setOwn] = useState(false)
  const open = p.open ?? own
  const header = useRef<HTMLButtonElement>(null)
  const set = (next: boolean) => { setOwn(next); p.onOpenChange?.(next) }
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open) return
    e.stopPropagation()
    set(false)
    header.current?.focus()
  }
  return (
    <div className="kit-showcard" data-kit="ShowCard" data-testid={p.testId} data-open={open} data-dir="up" onKeyDown={keyDown}>
      {open && (
        <ul className="kit-showcard-list">
          {p.items.map(i => (
            <li key={i.id}>
              <label className="kit-showcard-row">
                <input type="checkbox" className="kit-showcard-check" checked={i.visible} onChange={e => p.onToggle(i.id, e.target.checked)} />
                {i.swatchVar !== undefined && <span className="kit-swatch" style={{ '--kit-swatch': `var(${i.swatchVar})` } as CSSProperties} aria-hidden="true" />}
                <span className="kit-showcard-label">{i.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button ref={header} type="button" className="kit-showcard-header" aria-expanded={open} onClick={() => set(!open)}>
        <span>{p.title}</span><span className="kit-caret" data-up aria-hidden="true" />
      </button>
    </div>
  )
}
