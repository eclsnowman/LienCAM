// WO-425 - Operator's inverter, and the ONLY definition that ships.
//
// Transcribed from two files that are already working on his machine, not from
// a datasheet:
//   - Profiles/LienCNC.pro, section [ModbusMaster]:
//       Conn0="VFD & SPINDLE",True,25,1,297,RTU,COM3,19200,8,None,1,True,4
//       Conn0Fn0="ON-OFF-RESET",  Write_SingleRegister, 1 word, 4096
//       Conn0Fn1="VFD Speed",     Write_SingleRegister, 1 word, 8192
//       Conn0Fn2="VFD Error",     Read_HoldingRegisters, 1 word, 4097
//         ^ the plugin's own label, and it is wrong - 4097 is 0x1001, the
//           operating-state word. We copied the label with the address.
//           WO-1056 audited both; WO-1074 renamed the role to runState.
//       Conn0Fn3="VFD Status",    Read_HoldingRegisters, 5 words, 12291
//   - Profiles/Macro_LienCNC/M20002.txt, the UCCNC macro loop that drives it.
//
// `verified: false`, and that is not a formality. Nobody has run THIS code
// against the inverter - transcribing a working configuration is not the same
// as having talked to the hardware with it. Section 11.4 of
// docs/research/uccnc-control-plan.md is the flow that changes this flag, and
// until it has been walked, spindle-on is refused (vfdSafety.ts).
//
// No other definition ships. Ten definitions written from datasheets are ten
// untested claims about hardware that spins at 24,000 RPM.

import type { VfdDefinition } from './vfdDefinition'
import { VFD_DEFINITION_FORMAT, VFD_DEFINITION_SCHEMA_VERSION } from './vfdDefinition'

export const HUANYANG_GT_ID = 'huanyang-gt'

export const HUANYANG_GT: VfdDefinition = {
  format: VFD_DEFINITION_FORMAT,
  schemaVersion: VFD_DEFINITION_SCHEMA_VERSION,
  id: HUANYANG_GT_ID,
  name: 'Huanyang GT',
  verified: false,
  provenance: {
    kind: 'factory',
    source: "transcribed from the operator's UCCNC profile [ModbusMaster] and macro M20002",
  },
  link: {
    transport: 'rtu',
    // Only seeds fresh definitions; persisted definitions retain their own port.
    port: typeof navigator !== 'undefined' && /linux/i.test(navigator.platform) ? '/dev/ttyUSB0' : 'COM3',
    baud: 19200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    rs485: 'two-wire',
    slaveAddress: 1,
    // Measured on Operator's machine. Half-duplex turnaround at 19200 is
    // timing-sensitive; these are known-good and are copied, not re-derived.
    pollIntervalMs: 25,
    retryCount: 1,
    timeoutMs: 297,
  },
  protocol: {
    readFunction: 0x03,
    writeFunction: 0x06,
    wordOrder: 'high-first',
  },
  registers: {
    command: { address: 0x1000, count: 1 },
    setpoint: {
      address: 0x2000,
      count: 1,
      // Operator's own calibration, from his measured displayed-RPM / register
      // table - not a datasheet formula.
      scale: 'set.rpm / 2.4',
      // The macro's Convert.ToUInt16 rounds; 24,000 RPM is 10,000 counts.
      encode: { round: 'nearest', min: 0, max: 10000 },
    },
    // WO-1074: the inverter's operating-state word, not a fault code. See
    // VfdRegisterMap.runState. WO-1721 keeps every measured meaning beside
    // that register; the `fault` RULE below still tests its 4 separately.
    // Direction is the inverter's label only. On Operator's machine this word
    // reports the opposite direction, so physical direction remains commanded.
    runState: {
      address: 0x1001,
      count: 1,
      values: [
        { value: 1, meaning: 'runningForward' },
        { value: 2, meaning: 'runningReverse' },
        { value: 3, meaning: 'stopped' },
        { value: 4, meaning: 'faulted' },
        { value: 5, meaning: 'poweredOff' },
      ],
    },
    status: { address: 0x3003, count: 5 },
  },
  commands: {
    style: 'value',
    values: {
      runCw: 1,
      runCcw: 2,
      stop: 5,
      resetFault: 7,
      releaseReset: 0,
    },
  },
  // The macro writes 7, waits two seconds, then writes 0 to release the reset
  // so the inverter accepts commands again.
  resetSequence: [
    { command: 'resetFault', delayMsAfter: 2000 },
    { command: 'releaseReset', delayMsAfter: 0 },
  ],
  status: [
    { name: 'volts', source: 'register', offset: 0, scale: 'raw.value' },
    { name: 'amps', source: 'register', offset: 1, scale: 'raw.value' },
    { name: 'actualRpm', source: 'register', offset: 2, scale: 'raw.value' },
    // Word 3 is read but unused on this inverter, so it is simply not listed.
    { name: 'torque', source: 'register', offset: 4, scale: 'raw.value' },
    // The macro computes power rather than reading it.
    { name: 'power', source: 'derived', scale: 'field.volts * field.amps' },
  ],
  fault: { kind: 'equals', value: 4 },
  constants: {
    // The spindle's ceiling. It belongs to the SPINDLE, not the inverter - see
    // the README - and is carried here only so a scale expression can reach it.
    maxRpm: 24000,
  },
  upToSpeedToleranceRpm: 3,
  requiredParameters: [
    { parameter: 'P0.01', value: '2', why: 'take the run command from Modbus rather than the keypad.' },
    { parameter: 'P0.07', value: '7', why: 'take the frequency setpoint from Modbus.' },
    { parameter: 'PC.00', value: 'slave address 1', why: 'must match the address in this definition.' },
    { parameter: 'PC.01', value: '19200 baud', why: 'must match the link speed in this definition.' },
    { parameter: 'PC.02', value: '8-N-1', why: 'must match the framing in this definition.' },
    {
      parameter: 'PC.05',
      value: '0',
      why: "the inverter raises its own alarm if communication is lost. This is the hardware safety net; LienCAM's watchdog stands beside it and never replaces it.",
    },
  ],
  notes:
    'Two-wire RS485 on RS485+ / RS485-. The serial port is exclusive: UCCNC must not be running, and neither may any other program that opens the port.',
}

/** Everything that ships. One entry, on purpose. */
export const VFD_DEFINITIONS: readonly VfdDefinition[] = [HUANYANG_GT]
