// WO-3282 (UI M2 W1-E): the command search panel. The shell (W1-H) places it under the search box
// at the right end of the tab row and opens it with '/' (spec 6.2, 10). While open it is on the
// dialog stack, so Escape closes it and no shortcut runs behind it. Up and Down move through the
// list and Enter runs the highlighted command; an unavailable command is listed with its own
// reason and never runs. Rows read availability() as it is at each draw, never a copy from when the
// list was built: a `changes` signal (or the registry's own) redraws them while the panel stays
// open, and a choice asks availability() again before it runs, so neither a stale refusal nor a
// stale "ready" stands in front of the registry's check at run.
import { useEffect, useReducer, useRef, useState } from 'react'
import { TextField } from '../../components/kit'
import { resolveMessage } from '../../notices'
import type { MessageKey, ResolveMessage } from '../../notices/types'
import { dialogStack as appDialogs, useDialogEntry } from '../dialogStack'
import { isMacPlatform, shortcutText } from '../shortcuts/spelling'
import type { CommandContext, CommandId, CommandPlace, CommandRegistry, DialogStack, Shortcut } from '../types'
import { searchCommands, type CommandSearchRow } from '.'
import './commandSearch.css'

const AREA = 'ui2-commands.wo3282'
const PLACE_KEY: Record<CommandPlace, string> = {
  setup: 'placeSetup', sketch: 'placeSketch', model: 'placeModel', toolpath: 'placeToolpath',
  simulate: 'placeSimulate', control: 'placeControl', global: 'placeGlobal',
}
const LIMIT = 12

export interface CommandSearchProps<Ctx extends CommandContext> {
  readonly open: boolean
  onClose(): void
  readonly registry: CommandRegistry<Ctx>
  readonly context: () => Ctx
  /** The bindings in force (ShortcutManager.bindings()), shown beside each command. */
  readonly shortcuts?: ReadonlyMap<Shortcut, CommandId>
  /** Catalogue resolver; default the app's one resolver. */
  readonly resolve?: ResolveMessage | ((key: MessageKey) => string)
  readonly dialogs?: DialogStack
  readonly isMac?: boolean
  /** Subscribes to changes in the context availability() reads (selection, workspace, job state);
   *  returns the unsubscribe. The rows redraw on each change. */
  readonly changes?: (listener: () => void) => () => void
  /** A chosen command that threw. Default: console.error. */
  readonly onError?: (id: CommandId, error: unknown) => void
  readonly testId?: string
}

export function CommandSearch<Ctx extends CommandContext>(p: CommandSearchProps<Ctx>) {
  useDialogEntry(p.open, 'command-search', p.onClose, p.dialogs ?? appDialogs)
  return p.open ? <SearchPanel {...p} /> : null
}

function SearchPanel<Ctx extends CommandContext>(p: CommandSearchProps<Ctx>) {
  const resolve = (p.resolve ?? resolveMessage) as ResolveMessage
  const words = (key: string, params?: Record<string, string>) => resolve(`${AREA}:${key}` as MessageKey, params)
  const isMac = p.isMac ?? isMacPlatform()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  // read at every draw: availability() is the one source, never cached between draws
  const rows = searchCommands(p.registry, query, { context: p.context(), resolve, shortcuts: p.shortcuts, limit: LIMIT, isMac })
  useEffect(() => { box.current?.querySelector('input')?.focus() }, [])
  const { changes, registry } = p
  useEffect(() => changes?.(redraw), [changes])
  useEffect(() => (registry as Partial<{ subscribe(l: () => void): () => void }>).subscribe?.(redraw), [registry])

  const readyNow = (id: CommandId): boolean => {
    try {
      return p.registry.availability(id, p.context()).ready
    } catch (error) {
      if (p.onError) p.onError(id, error)
      else console.error(`command ${id} availability failed`, error)
      return false
    }
  }
  const choose = (row: CommandSearchRow<Ctx> | undefined) => {
    if (!row) return
    // the row may have been drawn before the context changed: ask again, and redraw if it has
    if (!readyNow(row.id)) { redraw(); return }
    p.onClose()
    p.registry.run(row.id, p.context()).catch(error => {
      if (p.onError) p.onError(row.id, error)
      else console.error(`command ${row.id} failed`, error)
    })
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    // the Enter that commits an input method's composition is typing, not a choice
    if (e.nativeEvent.isComposing || e.key === 'Process') return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(at => rows.length ? (at + step + rows.length) % rows.length : 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[Math.min(active, rows.length - 1)])
    }
  }

  return (
    <div ref={box} className="ui2-cmd-search" role="dialog" aria-label={words('searchLabel')} data-testid={p.testId} onKeyDown={onKeyDown}>
      <TextField ariaLabel={words('searchLabel')} placeholder={words('placeholder')} value={query}
        onChange={value => { setQuery(value); setActive(0) }} />
      {query.trim() !== '' && rows.length === 0 && <p className="ui2-cmd-search__empty">{words('noMatch', { query: query.trim() })}</p>}
      {rows.length > 0 && (
        <ul className="ui2-cmd-search__list" role="listbox" aria-label={words('results')}>
          {rows.map((row, i) => (
            <li key={row.id} role="option" className="ui2-cmd-search__row" aria-selected={i === active}
              aria-disabled={!row.availability.ready} data-ready={row.availability.ready}
              onMouseEnter={() => setActive(i)} onClick={() => choose(row)}>
              <span className="ui2-cmd-search__label">{row.label}</span>
              <span className="ui2-cmd-search__place">{words(PLACE_KEY[row.place])}</span>
              {row.shortcut && <kbd className="ui2-cmd-search__key">{shortcutText(row.shortcut, isMac)}</kbd>}
              {row.reason && (
                <span className="ui2-cmd-search__reason">
                  {words('notNow')}: {row.reason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
