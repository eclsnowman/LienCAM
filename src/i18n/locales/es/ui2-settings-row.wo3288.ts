// WO-3288: Spanish words of the Settings > Appearance row for the New UI switch.
import type { Translation } from '../../index'

const ui2SettingsRow: Translation<'ui2-settings-row.wo3288'> = {
  newUi: 'Nueva interfaz (vista previa beta)',
  newUiHint: 'Cambia a la interfaz rediseñada. Tus proyectos y ajustes no cambian. Desactívala para volver a la interfaz actual.',
} as const

export default ui2SettingsRow
