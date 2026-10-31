// WO-3256: Configuración guiada (unidades, máquina, herramientas).
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'guided-setup.wo3256'> = {
  title: 'Configuración guiada',
  intro: 'Tres cosas que la mayoría revisa antes de su primer trabajo. Cada una abre el editor que ya existe, y al cerrarlo vuelve aquí.',
  openerButton: 'Configuración guiada',
  openerTooltip: 'Recorrer unidades, máquina y herramientas. No se crea ni se cambia nada hasta que guarde en uno de esos editores.',
  settingsHeading: 'Primera configuración',
  settingsHint: 'Unidades, máquina y herramientas en una lista corta. Opcional; ábrala cuando quiera.',
  unitsTitle: 'Unidades',
  unitsSummary: 'Unidades de pantalla: {{display}}. Unidades de exportación de G-code: {{export}}.',
  unitsNote: 'Las unidades de pantalla y las de exportación de G-code son ajustes independientes.',
  unitMm: 'milímetros (mm)',
  unitIn: 'pulgadas (in)',
  unitsOpen: 'Abrir Ajustes',
  machineTitle: 'Máquina',
  machineSummary: 'Máquina del proyecto: {{name}}',
  machineNone: 'Máquina del proyecto: aún no se ha elegido',
  machineOpen: 'Abrir la biblioteca de máquinas',
  toolsTitle: 'Herramientas (opcional)',
  toolsSummary: 'Herramientas en su biblioteca: {{count}}',
  toolsOpen: 'Abrir la biblioteca de herramientas',
  savedNote: 'Los cambios guardados se conservan al salir de la configuración.',
  skip: 'Omitir configuración',
  continue: 'Continuar al proyecto',
  close: 'Cerrar la configuración guiada',
}

export default words
