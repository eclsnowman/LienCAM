// WO-3207: controller network and second-side confirmation text.

const words = {
  networkTitle: 'Controller network',
  networkHelp: 'The AXBB-E uses 10.10.10.11 and has no DHCP server. Choose its wired port; this only sets addressing.',
  wiredPort: 'Wired port',
  wiredPortLabel: 'Controller wired port',
  chooseWiredPort: 'Choose wired port',
  portPlaceholder: 'e.g. enp1s0',
  hostAddress: 'This computer\'s address',
  hostAddressLabel: 'Controller host address',
  settingUp: 'Setting up...',
  setupNetwork: 'Set up controller network',
  listPortsError: 'Could not list wired ports: {{error}}; enter the port name below.',
  setupError: 'Controller network setup could not finish: {{error}}',
  reuseTitle: 'Reuse G{{fixtureOffset}}?',
  reuseBody: 'All six work offsets (G54-G59) are in use. Reuse G{{fixtureOffset}} from "{{parentSetupName}}" for this second side?',
  reuseConfirm: 'Reuse G{{fixtureOffset}}',
  cancel: 'Cancel',
} as const

export default words

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'machine-definition.wo3207': typeof words
  }
}
