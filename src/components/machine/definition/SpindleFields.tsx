import { type SettingSource } from './DefinitionFields'
import { NotSent } from './DefinitionFields'
import {
  type ControllerType,
  type MachineBoardSpeedSpindleDrive,
  type MachineSpindleDriveDefinition,
} from '../../../types'

export type { MachineBoardSpeedSpindleDrive, MachineSpindleDriveDefinition } from '../../../types'


/** The spindle record is edited here, but it remains OUTSIDE the live spindle
 * control path. Every key is `data-not-driven`: the value is stored with the
 * definition and nothing reads it back out, so no box here can start a spindle
 * and none may claim the bridge acts on it (WO-950 / WO-1039). */
export function SpindleNotSent({ label, settingKey, settings, section = 'Spindlesetupsettings' }: {
  label: string
  settingKey: string
  settings: SettingSource
  section?: 'Spindlesetupsettings' | 'SpindlePIDsettings'
}) {
  return (
    <NotSent
      label={label}
      settings={settings}
      settingKey={`${section}.${settingKey}`}
    />
  )
}

export const SPINDLE_SPEED_FIELDS = [
  ['PWM mode', 'IsSpindleinPWMMode'],
  ['PWM frequency', 'SpindlePWMfrequency'],
  ['PWM minimum %', 'SpindlePWMminpercent'],
  ['PWM maximum %', 'SpindlePWMmaxpercent'],
  ['steps per unit', 'Spindlestepsperunit'],
  ['acceleration', 'Spindleacceleration'],
  ['minimum velocity', 'Spindleminvelocity'],
  ['maximum velocity', 'Spindlemaxvelocity'],
] as const

export const SPINDLE_COMMAND_OUTPUT_ROWS = [
  ['PWM speed', 'SpindlePWMoutport', 'SpindlePWMoutpin', 'SpindlePWMoutpinnegate'],
  ['PWM direction', 'SpindlePWMdirport', 'SpindlePWMdirpin', 'SpindlePWMdirpinnegate'],
  ['Step pulse', 'Spindlestepport', 'Spindlesteppin', 'Spindlesteppinnegate'],
  ['Step direction', 'Spindledirport', 'Spindledirpin', 'Spindledirpinnegate'],
] as const

export const SPINDLE_RELAY_ROWS = [
  ['M3 clockwise', 'M3relayport', 'M3relaypin', 'M3relaypinnegate', 'M3ondelay', 'M3offdelay'],
  ['M4 counterclockwise', 'M4relayport', 'M4relaypin', 'M4relaypinnegate', 'M4ondelay', 'M4offdelay'],
  ['M7 mist', 'M7relayport', 'M7relaypin', 'M7relaypinnegate', 'M7ondelay', null],
  ['M8 flood', 'M8relayport', 'M8relaypin', 'M8relaypinnegate', 'M8ondelay', null],
] as const

export const SPINDLE_ENCODER_FIELDS = [
  ['A port', 'EncoderAport'],
  ['A pin', 'EncoderApin'],
  ['B port', 'EncoderBport'],
  ['B pin', 'EncoderBpin'],
  ['reverse direction', 'Encoderreversedirection'],
  ['pulses per revolution', 'EncoderPPR'],
] as const

export const SPINDLE_PID_FIELDS = [
  ['enabled', 'PIDenable'],
  ['proportional gain (Kp)', 'Kp'],
  ['derivative gain (Kd)', 'Kd'],
  ['integral gain (Ki)', 'Ki'],
  ['sampling time', 'Samplingtime'],
] as const

export const SPINDLE_PULLEY_ROWS = Array.from({ length: 15 }, (_, index) => index + 1)

/** WO-1760's one display vocabulary for the canonical stored drive type and
 * the legacy derived words. */
export type SpindleDriveKind =
  | 'modbus-vfd' | 'board-pwm' | 'board-analog' | 'relay' | 'manual'
  | 'vfd-modbus' | 'relay-pwm' | 'relay-only' | 'pwm-board' | 'none'

export const SPINDLE_DRIVE_KIND_LABEL: Record<SpindleDriveKind, string> = {
  'modbus-vfd': 'Modbus VFD',
  'board-pwm': 'PWM from the board',
  'board-analog': '0-10 V from the board',
  relay: 'Relay on/off',
  manual: 'Manual',
  'vfd-modbus': 'VFD over Modbus',
  'relay-pwm': 'Relay + PWM',
  'relay-only': 'Relay only',
  'pwm-board': 'PWM from the board',
  none: 'None',
}

/** A pre-WO-1760 record has no `spindleDrive`; absence is deliberately
 * returned as absence so the caller can preserve the exact legacy derivation
 * from its VFD link and imported controller settings. */
export function storedMachineSpindleDrive(machine: unknown): MachineSpindleDriveDefinition | undefined {
  if (typeof machine !== 'object' || machine === null || !('spindleDrive' in machine)) return undefined
  return (machine as { spindleDrive?: MachineSpindleDriveDefinition }).spindleDrive
}

export function storedSpindleDriveKind(drive: MachineSpindleDriveDefinition): SpindleDriveKind {
  if (drive.kind === 'modbus-vfd') return 'modbus-vfd'
  if (drive.kind === 'relay') return 'relay'
  if (drive.kind === 'manual') return 'manual'
  return drive.signal === 'pwm' ? 'board-pwm' : 'board-analog'
}

export function newBoardSpindleDrive(
  signal: MachineBoardSpeedSpindleDrive['signal'],
): MachineBoardSpeedSpindleDrive {
  return {
    kind: 'board-speed', signal, output: { port: 0, pin: 0, negate: null }, frequencyHz: null,
    minimumRpm: null, maximumRpm: null, minimumPercent: null, maximumPercent: null,
  }
}

/** WO-1691: WHAT ACTUALLY DRIVES THIS SPINDLE, in one word - derived, not
 *  stored. The record already states every fact this reads (the VFD link,
 *  and on a UCCNC machine `Spindlerelaysenabled`/`IsSpindleinPWMMode`), so a
 *  fifth field nobody would keep in step with the other four is not created
 *  to hold a summary of them. A usable inverter document wins outright: a
 *  machine can carry `Spindlerelaysenabled=True` from an old plugin block it
 *  no longer wires and still be driven by the VFD actually connected today.
 *  GRBL and grblhal have no `Spindlesetupsettings` catalogue at all, but
 *  drive a spindle exactly one way absent a stated VFD link - PWM straight
 *  off the board - so that is what they say; every other uncatalogued
 *  controller says only what it can prove, which today is nothing. */
export function spindleDriveKind({ hasVfdLink, controller, catalogued, relayEnabled, pwmMode }: {
  hasVfdLink: boolean
  controller: ControllerType
  catalogued: boolean
  relayEnabled: boolean
  pwmMode: boolean
}): SpindleDriveKind {
  if (hasVfdLink) return 'vfd-modbus'
  if (catalogued) {
    if (relayEnabled && pwmMode) return 'relay-pwm'
    if (relayEnabled) return 'relay-only'
    if (pwmMode) return 'pwm-board'
    return 'none'
  }
  return controller === 'grbl' || controller === 'grblhal' ? 'pwm-board' : 'none'
}
