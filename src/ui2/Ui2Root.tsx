// WO-3275 (UI M2 Wave 0): the New UI skeleton. It owns the root element every token is scoped to
// ([data-ui2], tokens.ts) and the theme attribute; the shell inside is W1-H's (./shell/).
import { DEFAULT_UI2_THEME, tokenCss, UI2_THEME_ATTRIBUTE, type Ui2ThemeId } from '../theme/tokens'
import { useEffect } from 'react'
import { connectAppUnitPrefs } from '../lib/units/format/appPrefs'
import { Ui2Shell } from './shell'

const TOKEN_CSS = tokenCss()

export function Ui2Root({ theme = DEFAULT_UI2_THEME }: { theme?: Ui2ThemeId }) {
  useEffect(() => { connectAppUnitPrefs() }, [])
  const attrs = { 'data-ui2': '', [UI2_THEME_ATTRIBUTE]: theme }
  return (
    <div className="ui2-root" data-testid="ui2-root" {...attrs}>
      <style>{TOKEN_CSS}</style>
      <Ui2Shell />
    </div>
  )
}
