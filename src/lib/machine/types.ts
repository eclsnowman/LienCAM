// Machine-control shared types - framework-free (no React, no store).
// The protocol contract these model is documented in docs/machine/GRBL-PROTOCOL.md.

/** Controller execution state as reported in <...> status reports. */
export type MachineState =
  | 'unknown'
  | 'idle'
  | 'run'
  | 'hold'
  | 'jog'
  | 'alarm'
  | 'door'
  | 'check'
  | 'home'
  | 'sleep'

export interface MachineVec3 {
  x: number
  y: number
  z: number
}

/** A controller position can add definition-enabled rotary coordinates to
 * the XYZ base every existing backend reports. A/B/C values are degrees. */
export interface MachinePosition extends MachineVec3 {
  a?: number
  b?: number
  c?: number
}

/** Live accessory state decoded from a status report's A: field. */
export interface AccessoryState {
  spindle: 'cw' | 'ccw' | 'off'
  flood: boolean
  mist: boolean
}

/**
 * One parsed <...> status report. Fields GRBL omitted from a given report are
 * null - notably WCO and Ov arrive only intermittently, so consumers must
 * cache them (GrblController does; see deriveWork/derivedMachine there).
 */
export interface GrblStatusReport {
  state: MachineState
  /** Hold:0 vs Hold:1, Door:0-3 - null when the state has no sub-code. */
  subState: number | null
  mpos: MachineVec3 | null
  wpos: MachineVec3 | null
  wco: MachineVec3 | null
  /** Actual (post-override) feed, mm/min. */
  feed: number | null
  spindleRpm: number | null
  overrides: { feed: number; rapid: number; spindle: number } | null
  /** Bf: available planner blocks / RX bytes. Debug-only; never drives flow control. */
  buffer: { plannerBlocks: number; rxBytes: number } | null
  /** Ln: currently executing program line (optional compile feature). */
  line: number | null
  /** Pn: triggered pin letters (XYZPDHRS), null when absent. */
  pins: string | null
  /** A: accessory field decoded (S cw / C ccw spindle, F flood, M mist).
   *  Null when the field is absent from THIS report - GRBL appends A: only
   *  to override-bearing reports, so consumers must cache (GrblController
   *  does, like WCO). */
  accessories: AccessoryState | null
}

export type WcsId = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59'

/** Parsed $G report ([GC:...]) - the controller's modal parser state. */
export interface GrblParserState {
  wcs: WcsId | null
  units: 'mm' | 'inch' | null
  distanceMode: 'absolute' | 'incremental' | null
  /** Active motion mode word as written (G0, G1, G2, G3, G38.2, G80...). */
  motionMode: string | null
  /** Active tool number (T word). GRBL tracks the number only - no table.
   *  null = this report carries NO tool fact (field absent, or a controller
   *  that cannot report one); never overload 0 for that - 0 is a real T0.
   *  WO-2878: only a non-null tool counts as a fresh tool report. */
  tool: number | null
  spindle: 'cw' | 'ccw' | 'off' | null
  coolant: 'flood' | 'mist' | 'off' | null
  feed: number | null
  spindleRpm: number | null
}

/** One entry of the $# offsets report ([G54:..], [G28:..], [TLO:..], [PRB:..]). */
export interface GrblOffsetEntry {
  label: string
  values: number[]
  /** PRB only: whether the last probe cycle succeeded. */
  probeSuccess?: boolean
}

export interface TransportEvents {
  /** Raw bytes as they arrive; arbitrary chunk boundaries. */
  onChunk: (data: Uint8Array) => void
  /** Transport ended - unplug, close(), or fatal stream error. */
  onClose: (reason: string | null) => void
}

/**
 * Byte pipe to a controller. Implementations: WebSerialTransport (USB),
 * later a WebSocket transport for FluidNC. Framing is NOT the transport's
 * job - LineFramer downstream reassembles lines from chunks.
 */
export interface MachineTransport {
  /** Begin the read loop. Resolves once reading is active. */
  start(events: TransportEvents): Promise<void>
  write(data: Uint8Array): Promise<void>
  /** Idempotent. Triggers onClose exactly once. */
  close(): Promise<void>
}
