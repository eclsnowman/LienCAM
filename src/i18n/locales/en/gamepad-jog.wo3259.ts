// WO-3259: gamepad step jog - the Settings section, the Control status and the console sentences.
// Axis names (X+, Z-), button and axis numbers are filled in by the app and stay as written.

const words = {
  section: 'Gamepad step',
  hint: 'Jog one step per press from a gamepad, with a held deadman button. Step mode only: each press moves the Jog panel step at its feed, even while the Jog panel is set to Continuous. Settings never moves the machine.',
  pad: 'Gamepad',
  noPads: 'No gamepad seen yet. Plug one in and press any button on it.',
  padOption: '{{name}} (slot {{slot}})',
  savedPadAbsent: 'The saved gamepad is not connected: {{name}}',
  deadman: 'Deadman (hold to arm)',
  capture: 'Capture',
  capturing: 'Press or move it now...',
  clear: 'Clear',
  unmapped: 'Not mapped',
  button: 'Button {{index}}',
  axis: 'Axis {{index}} {{sign}}',
  invert: 'Invert {{axis}}',
  deadZone: 'Dead zone',
  speedScale: 'Speed (% of the Jog panel feed)',
  preview: 'Live preview (nothing moves from Settings)',
  previewDeadman: 'Deadman: {{state}}',
  held: 'held',
  released: 'released',
  previewNeutral: 'At rest',
  previewDirection: 'Would step {{direction}}',
  previewSimultaneous: 'Two directions at once - no step',
  apply: 'Apply',
  reset: 'Reset',
  enable: 'Enable gamepad step for this session',
  toggleOn: 'Gamepad step on',
  toggleOff: 'Gamepad step off',
  applied: 'Gamepad mapping applied.',
  clashDeadman: 'The deadman is also mapped to {{direction}}. Pick a different button for one of them.',
  clashShared: '{{first}} and {{second}} use the same input. Capture a different one for one of them.',
  unreadable: 'These saved gamepad settings are from another version and are not used. Edit and Apply, or Reset.',
  status: 'Gamepad step: {{state}}',
  stateOff: 'off',
  stateUnmapped: 'no deadman mapped',
  stateUnreadable: 'settings unreadable',
  stateNoPad: 'gamepad not connected',
  stateWaiting: 'let go of every button',
  stateReady: 'hold the deadman',
  stateArmed: 'armed',
  stateActive: 'stepping',
  stateAway: 'paused - Control is not in use',
  stateStale: 'paused - the gamepad stopped reporting',
  stateInvalid: 'paused - the gamepad reported a bad reading',
  stateNotEligible: 'jog is not available now',
  stateStopped: 'stopped - let go of every button',
  saySimultaneous: 'Gamepad step: moving two axes at once is not implemented, so nothing moved. Press one direction at a time.',
  sayAxisNotEnabled: 'Gamepad step: this machine has no {{axis}} axis to jog, so nothing moved.',
  sayRefused: 'Gamepad step: {{refusal}}',
}

export default words

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'gamepad-jog.wo3259': typeof words
  }
}
