// WO-3257: remappable CAM shortcuts - the Settings editor, the Help map and the tooltip hints.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'cam-shortcuts.wo3257'> = {
  section: 'Atajos de teclado',
  hint: 'Haga clic en una casilla de tecla y pulse la letra que quiera usar (mantenga Mayús si debe incluirse). Intro aplica, Escape cancela. Funcionan en CAM fuera de Sketch, y no mientras escribe en un campo ni con una ventana abierta.',
  actionSelected: 'Generar la operación seleccionada',
  actionAll: 'Generar todas las trayectorias',
  actionNewOperation: 'Nueva operación',
  unassigned: 'Sin asignar',
  apply: 'Aplicar',
  clear: 'Borrar',
  restore: 'Restablecer',
  restoreAll: 'Restablecer todos los valores',
  keyBoxLabel: 'Tecla para {{action}}',
  conflict: '{{key}} ya la usa "{{action}}". Borre o cambie primero ese atajo.',
  mapHeading: 'Sus atajos de CAM',
  mapScope: 'Funcionan en CAM fuera de Sketch. Las teclas de desplazamiento, transporte, Sketch, deshacer y suprimir no forman parte de esta lista.',
  mapTitle: 'Atajos de teclado CAM de LienCAM',
  mapScopeText: 'Ámbito: CAM, fuera de Sketch',
  download: 'Descargar mapa imprimible de atajos CAM',
  downloadName: 'liencam-atajos-cam.txt',
  computeToolpath: 'Calcular trayectoria ({{key}})',
  computeToolpathNone: 'Calcular trayectoria',
  regenerateAll: 'Regenerar todas las trayectorias ({{key}})',
  regenerateAllNone: 'Regenerar todas las trayectorias',
  addOperation: 'Añadir operación ({{key}})',
  addOperationNone: 'Añadir operación',
  computeRegenerate: 'Calcular (regenerar) la trayectoria de esta operación ({{key}})',
  computeRegenerateNone: 'Calcular (regenerar) la trayectoria de esta operación',
}

export default words
