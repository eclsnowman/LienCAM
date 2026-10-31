// WO-3207: controller network and second-side confirmation text.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'machine-definition.wo3207'> = {
  networkTitle: 'Red del controlador',
  networkHelp: 'El AXBB-E utiliza 10.10.10.11 y no tiene servidor DHCP. Elija su puerto de red cableada; esto solo configura el direccionamiento.',
  wiredPort: 'Puerto de red cableada',
  wiredPortLabel: 'Puerto de red cableada del controlador',
  chooseWiredPort: 'Elegir puerto de red cableada',
  portPlaceholder: 'p. ej. enp1s0',
  hostAddress: 'Dirección de este equipo',
  hostAddressLabel: 'Dirección del equipo del controlador',
  settingUp: 'Configurando...',
  setupNetwork: 'Configurar la red del controlador',
  listPortsError: 'No se pudieron enumerar los puertos de red cableada: {{error}}; introduzca el nombre del puerto a continuación.',
  setupError: 'No se pudo finalizar la configuración de la red del controlador: {{error}}',
  reuseTitle: '¿Reutilizar G{{fixtureOffset}}?',
  reuseBody: 'Los seis decalajes de origen (G54-G59) están en uso. ¿Reutilizar G{{fixtureOffset}} de "{{parentSetupName}}" para esta segunda cara?',
  reuseConfirm: 'Reutilizar G{{fixtureOffset}}',
  cancel: 'Cancelar',
}

export default words
