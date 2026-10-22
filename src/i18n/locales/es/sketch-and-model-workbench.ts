// WO-2938: Spanish machine translation; see docs/i18n/GLOSSARY-es.md.
import type { Translation } from '../../index'
const words: Translation<'sketch-and-model-workbench'> = {
  ModelWorkspaceHeader: { designTree: 'Árbol de diseño', doubleClickToRenameThisModel: 'Doble clic para cambiar el nombre de este modelo',
    switchModel: 'Cambiar modelo', newModel: 'Nuevo modelo', finish: 'Finalizar' },
  DialogShell: { apply: 'Aplicar', cancel: 'Cancelar' },
  ExtrudeDialog: {
    editExtrude: 'Editar extrusión', extrude3: 'Extrusión', stopPicking: 'Dejar de seleccionar', cancel: 'Cancelar', donePicking: 'Finalizar selección',
    pickProfileInViewport: 'Seleccionar perfil en la vista', sketch: 'Boceto: ', useWholeSketch: 'Usar todo el boceto',
    profile: 'Perfil', region: 'Región ', end: 'Fin', direction: 'Dirección', distance: 'Distancia', offset: 'Desfase',
    pickFaceOrPlane: 'Seleccionar cara o plano', pickPartOrBody: 'Seleccionar pieza o cuerpo', pickVertexOrPoint: 'Seleccionar vértice o punto',
    none: 'ninguno', result: 'Resultado', pickBodyInViewport: 'Seleccionar cuerpo en la vista', target: 'Objetivo',
    noBodyAvailable: '(ningún cuerpo disponible)', updatingPreview: 'Actualizando vista previa...', livePreviewReady: 'Vista previa en vivo lista',
  },
  FilletDialog: {
    editFilletCommand: 'Editar comando de redondeo', filletCommand: 'Comando de redondeo', fillet3: 'Redondeo',
    selectEdgesInTheViewport: 'Seleccione aristas en la vista', clickEdgesToAddOrRemove: 'Haga clic en aristas para añadirlas o quitarlas',
    radius: 'Radio', filletRadius: 'Radio de redondeo', updating: 'Actualizando...', ready: 'Listo', applyFillet: 'Aplicar redondeo',
    applyFilletEnter: 'Aplicar redondeo (Enter)', apply: 'Aplicar', cancelFillet: 'Cancelar redondeo', cancelFilletEscape: 'Cancelar redondeo (Escape)', cancel: 'Cancelar',
  },
  WorkbenchToolRail: {
    create: 'Crear', line: 'Línea', rectangle: 'Rectángulo', centerRect: 'Rectángulo desde el centro', circle: 'Círculo',
    '3PtCircle': 'Círculo por 3 puntos', ellipse: 'Elipse', spline: 'Spline', controlSpline: 'Spline por puntos de control',
    bezier: 'Bézier', conicArc: 'Arco cónico', '3PtArc': 'Arco por 3 puntos', tangentArc: 'Arco tangente', centerArc: 'Arco desde el centro',
    gear: 'Engranaje', polygon: 'Polígono', slot: 'Ranura', point: 'Punto', modify: 'Modificar', smartDim: 'Cota inteligente',
    trim: 'Recortar', split: 'Dividir', extend: 'Extender', fillet: 'Redondeo', chamfer: 'Chaflán', offset: 'Desfase', mirror: 'Simetría',
    linearPat: 'Patrón lineal', circularPat: 'Patrón circular', pathPat: 'Patrón sobre trayectoria', move: 'Mover', rotate: 'Girar', scale: 'Escalar',
    coincident: 'Coincidente', concentric: 'Concéntrico', parallel: 'Paralelo', perpendicular: 'Perpendicular', collinear: 'Colineal',
    horizontal: 'Horizontal', vertical: 'Vertical', tangent: 'Tangente', resizeToolRail: 'Cambiar tamaño de la barra de herramientas',
    select: 'Seleccionar', utility: 'Utilidades', projectUse: 'Proyectar / Usar',
  },
  SketchToolbox: {
    create: 'Crear', line: 'Línea', rectangle: 'Rectángulo', centerRect: 'Rectángulo desde el centro', circle: 'Círculo',
    '3PtCircle': 'Círculo por 3 puntos', ellipse: 'Elipse', ellipticalArc: 'Arco elíptico', spline: 'Spline', controlSpline: 'Spline por puntos de control',
    bezier: 'Bézier', conicArc: 'Arco cónico', text: 'Texto', '3PtArc': 'Arco por 3 puntos', tangentArc: 'Arco tangente', centerArc: 'Arco desde el centro',
    gear: 'Engranaje', polygon: 'Polígono', slot: 'Ranura', arcSlot: 'Ranura en arco', point: 'Punto', construction: 'Construcción',
    modify: 'Modificar', smartDim: 'Cota inteligente', reference: 'Referencia', trim: 'Recortar', split: 'Dividir', extend: 'Extender',
    fillet: 'Redondeo', chamfer: 'Chaflán', offset: 'Desfase', mirror: 'Simetría', linearPat: 'Patrón lineal', circularPat: 'Patrón circular',
    pathPat: 'Patrón sobre trayectoria', move: 'Mover', rotate: 'Girar', scale: 'Escalar', delete: 'Eliminar', constraints: 'Restricciones',
    coincident: 'Coincidente', concentric: 'Concéntrico', parallel: 'Paralelo', perpendicular: 'Perpendicular', collinear: 'Colineal',
    horizontal: 'Horizontal', vertical: 'Vertical', tangent: 'Tangente',
  },
  AgentCommands: { setParameter: 'Agente: definir {{name}} = {{expression}}', extrude: 'Agente: Extruir', deleteFeature: 'Agente: Eliminar', revolve: 'Agente: Revolución', fillet: 'Agente: Redondeo', chamfer: 'Agente: Chaflán', hole: 'Agente: Agujero', sketch: 'Agente: Boceto' },
}
export default words
