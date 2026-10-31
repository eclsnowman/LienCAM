// WO-3288: French words of the Settings > Appearance row for the New UI switch.
import type { Translation } from '../../index'

const ui2SettingsRow: Translation<'ui2-settings-row.wo3288'> = {
  newUi: 'Nouvelle interface (aperçu bêta)',
  newUiHint: 'Passe à l’interface repensée. Vos projets et réglages ne changent pas. Désactivez pour revenir à l’interface actuelle.',
} as const

export default ui2SettingsRow
