// WO-2938: Spanish machine translation of application messages only.
// Controller replies remain verbatim and are not part of this catalog.
import type { Translation } from '../../index'
const words: Translation<'console-and-operator-messages'> = {
  "postToolNumberAssigned": "Se asignó T{{number}} a «{{name}}» para este programa.",
  "g53BottomOfTravel": "«{{name}}», línea {{line}}: {{code}} va a Z de máquina {{z}}, el extremo inferior del recorrido Z de esta máquina. Se ejecuta tal como está escrito.",
  "g53BottomOfTravelMore": "«{{name}}»: {{count}} líneas más también van al extremo inferior del recorrido Z; la siguiente es la línea {{line}}.",
  "interpreterHandover": "«{{name}}»: la línea {{line}} ({{word}}) la lee el intérprete de archivos que usa el puente de la máquina, así que todo el archivo se lee allí.",
  "interpreterHandoverNoLine": "«{{name}}»: este archivo lo lee el intérprete de archivos que usa el puente de la máquina, así que todo el archivo se lee allí.",
  "index40": "{{value1}}: se comprobaron {{value3}} enlaces; {{value2}} movimientos rápidos permanecen por debajo de la altura de seguridad sobre material ya retirado.",
  outdatedReasonEarlierChanged: '{{name}} se modificó después de este cálculo',
  outdatedReasonEarlierRemoved: '{{name}} se eliminó después de este cálculo',
  outdatedReasonEarlierEnabled: '{{name}} se activó después de este cálculo',
  outdatedReasonEarlierDisabled: '{{name}} se desactivó después de este cálculo',
  outdatedReasonOrder: 'se cambió el orden de las operaciones después de este cálculo',
  outdatedReasonTool: 'se modificó su herramienta', outdatedReasonGeometry: 'se modificó su geometría',
  outdatedReasonSettings: 'se modificaron sus ajustes', outdatedReasonStock: 'se modificó el material en bruto',
  outdatedReasonOrigin: 'se modificó el origen de la configuración', outdatedReasonParts: 'se modificaron las piezas usadas para el cálculo',
  outdatedReasonWorkholding: 'se modificaron los elementos de sujeción', outdatedReasonMachine: 'se modificó la máquina',
  outdatedReasonNest: 'es necesario recalcular su anidado', outdatedReasonChangedWhileComputing: 'se modificaron sus datos durante el cálculo',
  outdatedReasonHistory: 'Deshacer la restauró sin su trayectoria', outdatedReasonInterrupted: 'aún se estaba calculando al cerrar la aplicación',
  outdatedReasonNoToolpath: 'no tiene trayectoria guardada', outdatedReasonOpened: 'su trayectoria guardada no coincide con sus datos actuales',
  outdatedReasonInputs: 'se modificaron sus datos después de este cálculo',
}
export default words
