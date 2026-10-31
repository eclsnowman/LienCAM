// WO-3280: the view cube, lower left of the view, with the View style button beside it. It
// reports a picked view or style through its callbacks and knows nothing of the viewport.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ViewCubeProps, ViewPreset, ViewStyle } from '../types'
import { useText } from '../../../i18n'

const CUBE_FACES: readonly ViewPreset[] = ['top', 'front', 'right']
const SMALL_KEYS: readonly ViewPreset[] = ['bottom', 'back', 'left', 'iso']
const STYLES: readonly { readonly id: ViewStyle; readonly word: 'styleShaded' | 'styleShadedEdges' | 'styleWireframe' | 'styleHiddenEdges' }[] = [
  { id: 'shaded', word: 'styleShaded' },
  { id: 'shaded-edges', word: 'styleShadedEdges' },
  { id: 'wireframe', word: 'styleWireframe' },
  { id: 'hidden-edges', word: 'styleHiddenEdges' },
]

export function ViewCube(p: ViewCubeProps) {
  const t = useText('ui2-actions.wo3280')
  const [menu, setMenu] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])

  const current = useRef(p.style)
  useEffect(() => { current.current = p.style })
  useEffect(() => {
    if (!menu) return
    items.current[Math.max(0, STYLES.findIndex(s => s.id === current.current))]?.focus()
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) setMenu(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu])

  const close = () => { setMenu(false); opener.current?.focus() }
  const menuKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const at = items.current.findIndex(el => el === document.activeElement)
    const next = (at + (e.key === 'ArrowDown' ? 1 : STYLES.length - 1)) % STYLES.length
    items.current[next]?.focus()
  }

  return (
    <div className="kit-viewcube" ref={root} data-kit="ViewCube" data-testid={p.testId} data-style={p.style}
      onBlur={e => { if (menu && !root.current?.contains(e.relatedTarget as Node | null)) setMenu(false) }}
    >
      <div className="kit-viewcube-cube">
        {CUBE_FACES.map(v => (
          <button key={v} type="button" className="kit-viewcube-face" data-view={v} aria-label={p.faceLabels[v]} onClick={() => p.onView(v)} />
        ))}
      </div>
      <div className="kit-viewcube-keys">
        {SMALL_KEYS.map(v => (
          <button key={v} type="button" className="kit-viewcube-key" data-view={v} onClick={() => p.onView(v)}>{p.faceLabels[v]}</button>
        ))}
      </div>
      <button ref={opener} type="button" className="kit-viewcube-style" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
        {t('viewStyle')}
      </button>
      {menu && (
        <ul className="kit-viewcube-menu" role="menu" onKeyDown={menuKey}>
          {STYLES.map((s, i) => (
            <li key={s.id} role="none">
              <button
                ref={el => { items.current[i] = el }}
                type="button"
                role="menuitemradio"
                aria-checked={p.style === s.id}
                className="kit-viewcube-item"
                onClick={() => { p.onStyle(s.id); close() }}
              >
                {t(s.word)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
