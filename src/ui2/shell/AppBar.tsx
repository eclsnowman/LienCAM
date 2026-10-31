// WO-3285 (UI M2 W1-H): the app bar (spec 6.1). Wordmark, the machine status pill, the library and
// settings windows (windows, never tabs), then the test-drive controls: theme, interface scale and
// the way back to the classic interface.
import { useText } from '../../i18n'
import { Button, Select } from '../../components/kit'
import { UI2_THEME_IDS, type Ui2ThemeId } from '../../theme/tokens'
import { useCamStore } from '../../store'
import { setNewUi } from '../newUiSwitch'
import { MachineStatusHost } from './hosts'
import { SCALE_CHOICES, isScaleChoice, type ScaleChoice, type ShellPrefs } from './prefs'

const THEME_LABEL = { dark: 'themeDark', amber: 'themeAmber', light: 'themeLight' } as const satisfies Record<Ui2ThemeId, string>

/** The theme and scale selects, shared by the shell and the gallery so every theme can be looked at. */
export function LookControls({ prefs }: { prefs: ShellPrefs }) {
  const t = useText('ui2-shell.wo3285')
  const scaleLabel = (c: ScaleChoice) => c === 'auto' ? t('scaleAuto') : t('scalePercent', { percent: Math.round(c * 100) })
  return (
    <>
      <Select
        testId="ui2-theme-select"
        ariaLabel={t('theme')}
        value={prefs.theme}
        options={UI2_THEME_IDS.map(id => ({ value: id, label: t(THEME_LABEL[id]) }))}
        onChange={id => prefs.setTheme(id)}
      />
      <Select
        testId="ui2-scale-select"
        ariaLabel={t('scale')}
        value={String(prefs.scaleChoice)}
        options={SCALE_CHOICES.map(c => ({ value: String(c), label: scaleLabel(c) }))}
        onChange={v => { const n = v === 'auto' ? v : Number(v); if (isScaleChoice(n)) prefs.setScaleChoice(n) }}
      />
    </>
  )
}

export function AppBar({ prefs }: { prefs: ShellPrefs }) {
  const t = useText('ui2-shell.wo3285')
  const shell = useText('app-shell-settings-menus')
  const openModal = useCamStore(s => s.openModal)
  return (
    <header className="ui2-appbar" data-ui2-card="appbar" data-ui2-chrome="" data-testid="ui2-appbar" aria-label={t('appBar')}>
      <span className="ui2-brand">LienCAM</span>
      <MachineStatusHost />
      <div className="ui2-appbar-actions">
        <Button kind="momentary" testId="ui2-open-tool-library" label={shell('ModeTabStrip.toolLibrary2')} onPress={() => openModal('tool-library')} />
        <Button kind="momentary" testId="ui2-open-settings" label={shell('TopToolbar.settings')} onPress={() => openModal('settings')} />
        <Button kind="momentary" testId="ui2-open-help" label={shell('TopToolbar.help')} onPress={() => openModal('help')} />
      </div>
      <div className="ui2-appbar-look">
        <LookControls prefs={prefs} />
        <Button kind="momentary" testId="ui2-classic-ui" label={t('classicUi')} onPress={() => setNewUi(false)} />
      </div>
    </header>
  )
}
