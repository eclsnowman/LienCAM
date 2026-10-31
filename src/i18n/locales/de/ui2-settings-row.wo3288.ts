// WO-3288: German words of the Settings > Appearance row for the New UI switch.
import type { Translation } from '../../index'

const ui2SettingsRow: Translation<'ui2-settings-row.wo3288'> = {
  newUi: 'Neue Oberfläche (Beta-Vorschau)',
  newUiHint: 'Wechselt zur neu gestalteten Oberfläche. Ihre Projekte und Einstellungen bleiben unverändert. Ausschalten, um zur aktuellen Oberfläche zurückzukehren.',
} as const

export default ui2SettingsRow
