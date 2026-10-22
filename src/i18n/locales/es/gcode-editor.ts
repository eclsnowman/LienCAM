// WO-2938: Spanish machine translation; G-code content is never translated.
import type { Translation } from '../../index'
const words: Translation<'gcode-editor'> = {
  editor: {
    label: 'Editor de código G', goToLine: 'Ir a la línea', go: 'Ir', find: 'Buscar', findPlaceholder: 'Buscar',
    replacePlaceholder: 'Reemplazar por', findNext: 'Siguiente', findPrevious: 'Anterior', replace: 'Reemplazar', replaceAll: 'Reemplazar todo',
    noMatches: 'Sin coincidencias', matchOf: '{{index}} de {{count}}', matchCount: '{{count}} coincidencias', replacedCount: '{{count}} reemplazadas',
    undo: 'Deshacer', redo: 'Rehacer', undoTip: 'Deshacer (Ctrl+Z)', redoTip: 'Rehacer (Ctrl+Y o Ctrl+Shift+Z)',
    findTip: 'Buscar y reemplazar (Ctrl+F)', goToTip: 'Ir a la línea (Ctrl+G)', position: 'Lín. {{line}}, Col. {{column}} - {{lines}} líneas',
    readOnly: 'Solo lectura', markedLine: 'Línea {{line}}: {{message}}', markTip: 'La lectura se detiene en esta línea: {{message}}', close: 'Cerrar',
  },
  menu: {
    title: 'Línea {{line}}', runFromHere: 'Ejecutar desde aquí', insertLine: 'Insertar línea',
    insertPlaceholder: 'Nueva línea después de la línea {{line}} - Enter la añade, Esc cancela',
    findReplace: 'Buscar / Reemplazar', find: 'Buscar', goToLine: 'Ir a la línea', undo: 'Deshacer', redo: 'Rehacer',
  },
  changes: {
    none: 'Ninguna línea modificada', addedOne: '1 línea añadida después de la línea {{after}}',
    addedMany: '{{count}} líneas añadidas después de la línea {{after}}', addedAtStartOne: '1 línea añadida al inicio',
    addedAtStartMany: '{{count}} líneas añadidas al inicio', removedOne: 'línea {{from}} eliminada',
    removedMany: '{{count}} líneas eliminadas desde la línea {{from}}', replacedOne: 'línea {{line}} modificada',
    replaced: 'líneas {{from}}-{{to}} reemplazadas por {{count}} líneas', replacedByOne: 'líneas {{from}}-{{to}} reemplazadas por 1 línea',
    replacedLine: 'línea {{line}} reemplazada por {{count}} líneas', several: '{{changed}} líneas modificadas en {{places}} puntos',
  },
  post: {
    edit: 'Editar', editTip: 'Edite este código G a mano. Exportar y Enviar a Control incluyen sus cambios.',
    handEdited: 'Editado a mano: {{summary}}', discardEdits: 'Descartar cambios',
    discardEditsTip: 'Volver al programa posprocesado y descartar sus cambios manuales',
    staleEdits: 'El posprocesado cambió desde que editó este programa. Volver a posprocesar reemplaza sus cambios manuales ({{summary}}).',
    keepEdits: 'Conservar mis cambios', keepEditsTip: 'Conservar su texto editado; es lo que usan Exportar y Enviar a Control',
    repost: 'Volver a posprocesar', repostTip: 'Usar el nuevo posprocesado y descartar sus cambios manuales',
    sendToControl: 'Enviar a Control', sendToControlTip: 'Cargar este programa en la pantalla de Control, exactamente como se muestra aquí',
    sendToControlSeparateTip: 'Cargar el archivo de la vista previa ({{name}}) en la pantalla de Control, exactamente como se muestra aquí',
    sentToControl: '{{name}} enviado a Control ({{lines}} líneas){{edited}}', sentEdited: ', editado a mano: {{summary}}',
    exportedEdited: '{{name}} exportado con cambios manuales: {{summary}}',
  },
  control: {
    editNothingTip: 'Cargue primero un programa',
    stagedNotRun: 'Esta ejecución usa el programa cargado; sus cambios pendientes ({{summary}}) no están incluidos - pulse Aplicar primero para ejecutarlos.',
    stagedDropped: 'Se descartaron los cambios pendientes en "{{old}}": se cargó "{{now}}" en su lugar.',
    title: 'Editar programa - {{name}}', apply: 'Aplicar', applyTip: 'Cargar el programa editado en lugar del que está cargado ahora',
    applyUnchangedTip: 'Aún no hay cambios', saveFile: 'Guardar en archivo', saveFileTip: 'Guardar el texto editado en un archivo de código G',
    discard: 'Descartar', discardTip: 'Descartar los cambios pendientes; el programa cargado se mantiene como está',
    close: 'Cerrar', closeTip: 'Cerrar el editor', closeStagedTip: 'Cerrar el editor. Sus cambios quedan pendientes hasta que pulse Aplicar o Descartar.',
    runningReadOnly: 'El programa está en marcha o en pausa. El controlador retiene el programa en ejecución y no se puede modificar mientras tanto - pulse Parar (o Reiniciar) para editarlo.',
    edited: 'Programa editado: {{summary}}', savedFile: 'Programa editado guardado como {{name}}',
    refused: 'No se cargó el programa editado: {{reason}}',
    postedForEdit: 'Este programa se cargó desde las trayectorias de la configuración, por lo que el editor lo muestra posprocesado para {{controller}}. Aplicar carga el texto editado como archivo.',
    postRefused: 'Este programa se cargó desde las trayectorias de la configuración y no se pudo posprocesar como texto para editar: {{reason}}',
  },
}
export default words
