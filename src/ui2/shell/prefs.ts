// WO-3285 (UI M2 W1-H): the shell's own look settings: theme and interface scale. They live on
// keys of their own (the shipped preferences file belongs to another order) and are read when the
// shell mounts, so a changed or damaged value can only ever fall back to the default.
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_UI2_THEME, isUi2ThemeId, type Ui2ThemeId } from '../../theme/tokens'
import { resolveUiScale } from '../../store/uiPrefs'
import { PERSISTED_USER_DATA_REGISTRY, readRegisteredLocalData, writeRegisteredLocalData } from '../../store/persistedKeys'

export const SHELL_THEME_KEY = PERSISTED_USER_DATA_REGISTRY.ui2ShellTheme.key
export const SHELL_SCALE_KEY = PERSISTED_USER_DATA_REGISTRY.ui2ShellScale.key

/** Interface scale choices, spec 5.1 rule 8: 75 % to 150 % and Auto. */
export const SCALE_CHOICES = ['auto', 0.75, 0.8, 0.9, 1, 1.25, 1.5] as const
export type ScaleChoice = (typeof SCALE_CHOICES)[number]
export const DEFAULT_SCALE_CHOICE: ScaleChoice = 'auto'

export function isScaleChoice(value: unknown): value is ScaleChoice {
  return (SCALE_CHOICES as readonly unknown[]).includes(value)
}

type ShellPrefId = 'ui2ShellTheme' | 'ui2ShellScale'

function read(id: ShellPrefId): string | null {
  try { return readRegisteredLocalData(id) } catch { return null }
}

function write(id: ShellPrefId, value: string): void {
  try { writeRegisteredLocalData(id, value) } catch { /* private window: this load only */ }
}

export function readTheme(): Ui2ThemeId {
  const stored = read('ui2ShellTheme')
  return isUi2ThemeId(stored) ? stored : DEFAULT_UI2_THEME
}

export function readScaleChoice(): ScaleChoice {
  const stored = read('ui2ShellScale')
  if (stored === 'auto') return 'auto'
  const n = Number(stored)
  return stored !== null && isScaleChoice(n) ? n : DEFAULT_SCALE_CHOICE
}

/** The scale the layout multiplies by: a fixed choice, or Auto from the window and pixel ratio. */
export function resolveScale(choice: ScaleChoice, windowWidth: number, pixelRatio: number): number {
  return choice === 'auto' ? resolveUiScale('auto', windowWidth, pixelRatio) : choice
}

export interface WindowSize { readonly width: number; readonly height: number; readonly pixelRatio: number }

function currentWindow(): WindowSize {
  return { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio || 1 }
}

export function useWindowSize(): WindowSize {
  const [size, setSize] = useState(currentWindow)
  useEffect(() => {
    const sync = () => setSize(currentWindow())
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  return size
}

export interface ShellPrefs {
  readonly theme: Ui2ThemeId
  setTheme(theme: Ui2ThemeId): void
  readonly scaleChoice: ScaleChoice
  setScaleChoice(choice: ScaleChoice): void
}

export function useShellPrefs(): ShellPrefs {
  const [theme, setThemeState] = useState(readTheme)
  const [scaleChoice, setScaleState] = useState(readScaleChoice)
  const setTheme = useCallback((next: Ui2ThemeId) => { setThemeState(next); write('ui2ShellTheme', next) }, [])
  const setScaleChoice = useCallback((next: ScaleChoice) => { setScaleState(next); write('ui2ShellScale', String(next)) }, [])
  return { theme, setTheme, scaleChoice, setScaleChoice }
}
