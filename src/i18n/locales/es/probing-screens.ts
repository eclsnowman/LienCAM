// WO-2938: Spanish machine translation; wording only, no probing logic changes.
import type { Translation } from '../../index'
const words: Translation<'probing-screens'> = {
  probingPanel1: 'Aún no hay desfase de trabajo activo - Z0 se escribe en el que esté activo.',
  probingPanel2: '{{value1}} Z0: no se ha definido desde LienCAM desde su apertura - se usa {{value2}} Z guardado en el controlador.',
  probingPanel6: '{{value1}} Z0 en uso: definido a las {{value2}}{{value3}}.', probingPanel7: 'Parte superior del material en bruto',
  probingPanel8: 'Arista', probingPanel9: 'Una cara X/Y', probingPanel10: 'Esquina exterior', probingPanel11: 'Dos caras exteriores',
  probingPanel12: 'Esquina interior', probingPanel13: 'Dos caras interiores', probingPanel14: 'Ángulo', probingPanel15: 'Alineación por dos puntos',
  probingPanel16: 'Agujero', probingPanel17: 'Centro circular interior', probingPanel18: 'Saliente', probingPanel19: 'Centro circular exterior',
  probingPanel20: 'Cajera rectangular', probingPanel21: 'Cuatro caras interiores', probingPanel22: 'Saliente rectangular',
  probingPanel23: 'Cuatro caras exteriores', probingPanel24: 'Superficie Z', probingPanel25: 'Mapear superficie de corte',
  probingPanel26: 'Z de herramienta', probingPanel27: 'Medir herramienta activa', probingPanel28: 'Calibrar', probingPanel29: 'Radio del palpador X / Y',
  probingPanel39: 'Escribe {{value1}} {{value2}}',
  probingPanel40: 'Parar - cancela la rutina de palpado en curso. No es una PARADA DE EMERGENCIA: no queda enclavada.',
  probingPanel41: 'Aún no se conocen los límites de recorrido de la máquina - no se han leído los ajustes del controlador.',
  probingPanel44: 'Referencie la máquina antes de planificar un ciclo de palpado automático.',
  probingPanel45: 'Referencie la máquina antes de planificar el recorrido de la malla.', probingPanel55: 'Confirmar desfase {{value1}}',
  probingPanel60: 'sin definir', probingPanel78: 'Conecte primero con la máquina.',
  probingPanel79: 'Hay un ciclo de palpado en marcha - espere a que termine.',
  probingPanel80: 'Una pausa (un cambio de herramienta esperando su intervención) ocupa la máquina - pulse Inicio de ciclo para completarla, o Parar, y después ejecute el palpado.',
  probingPanel81: 'Hay un programa en marcha - pulse Pausa de avance y después Parar antes de palpar.',
  probingPanel82: 'La máquina está {{value1}} - espere hasta que esté inactiva.', probingPanel83: 'Lea primero la posición de máquina.',
  probingPanel84: 'Esta rutina aún no tiene un plan.', probingPanel90: 'Resultado del ángulo',
  probingPanel93: 'Palpando {{value1}} puntos de malla - mantenga la PARADA DE EMERGENCIA al alcance.',
  probingPanel96: 'Z0 de trabajo definido: {{value1}} Z0 = {{value2}} {{value3}}.',
}
export default words
