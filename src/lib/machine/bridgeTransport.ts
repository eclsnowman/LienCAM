// BridgeTransport - a JSON message channel to a machine-local bridge process
// that drives a controller LienCAM cannot reach directly (today: the
// CNCdrive AXBB-E via UC100.dll). See docs/machine/BRIDGE-PROTOCOL.md for the
// wire contract this implements; UccncController (uccncController.ts) is the
// only consumer.
//
// Loopback only. The bridge binds 127.0.0.1 and this refuses to dial anything
// else, because the far end can move a machine and must never be reachable
// across a network by accident. That guard, and its tests, do not change
// shape just because the payload moved from bytes to JSON.

import type {
  ControllerCapabilities,
  ConnectionPhase,
  JobFault,
  JogAxis,
  MachineDefinitionProvenance,
  MachineStatus,
  MessageChannel,
  ZeroWorkAxisReceipt,
} from './controller'
import type { ControllerDefinition, MachineSpindleLinkDefinition } from '../../types'
import type { MachinePosition, WcsId } from './types'
import {
  validateVfdDefinition,
  VFD_COMMANDS,
  VFD_REGISTER_ROLES,
  VFD_STATUS_FIELDS,
} from './vfd'
import type { VfdDefinition, VfdStatusFieldName } from './vfd'

export const BRIDGE_DEFAULT_PORT = 8325
/**
 * WO-1783: the old pinned bridge can keep its listening socket unavailable
 * for 3-6 seconds after Electron's readiness connection. One fresh WebSocket
 * after that measured window recovers it without probing or restarting the
 * bridge again. This is the only retry; an established session never uses it.
 */
export const BRIDGE_INITIAL_CONNECT_RETRY_MS = 6000
const BRIDGE_HANDSHAKE_CLOSE_GRACE_MS = 50

/** ws:// to loopback is exempt from mixed-content blocking in Chrome and
 *  Firefox, so this works from an https-served LienCAM without a certificate
 *  on the local hop. */
export function bridgeUrl(port: number = BRIDGE_DEFAULT_PORT): string {
  return `ws://127.0.0.1:${port}/`
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function isLoopbackWsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false
    return LOOPBACK_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

// ---- message shapes (docs/machine/BRIDGE-PROTOCOL.md "Shape") ----

/** Browser -> bridge. `m` is the MachineController method name verbatim; `a`
 *  is its arguments by parameter name, never positional. */
export interface BridgeCallMessage {
  t: 'call'
  seq: number
  m: string
  a: Record<string, unknown>
}

/** Receipt from the console, independent of controller calls and motion. */
export type BridgeClientMessage = BridgeCallMessage | { t: 'firmwareUpdateAck'; id: string }

/** Arguments for the one bridge call that persists a definition. Provenance
 * is optional on the protocol for compatibility with older callers; the app's
 * apply path always supplies it, including an empty map when no value differs. */
export interface BridgeApplyMachineDefinitionArgs extends Record<string, unknown> {
  definition: ControllerDefinition
  provenance?: MachineDefinitionProvenance
}

/** One INI assignment returned by the read-only `previewProfile` verb.
 * Order and duplicates are significant: UCCNC uses the last duplicate. */
export interface BridgeProfileSetting {
  section: string
  key: string
  value: string
}

/** The landed WO-1106 wire reply. This is deliberately raw profile data, not
 * a controller definition: the bridge reads one advertised file and changes
 * neither its live INI nor the board. */
export interface BridgePreviewProfileReply {
  ok: boolean
  reason: string | null
  path: string
  /** SHA-256 of the file bytes, or null when the bridge could not hash it. */
  fileHash: string | null
  /** File order, including duplicate keys. */
  settings: BridgeProfileSetting[]
}

/** Bridge -> browser, one per call, correlated by `seq`. `v` is absent for a
 *  void method and always absent when `ok` is false. */
export interface BridgeReplyMessage {
  t: 'reply'
  seq: number
  ok: boolean
  v?: unknown
  error?: string
}

/**
 * Bridge -> browser, unsolicited: a MachineStatus snapshot, nulls and all -
 * absent data must stay `null` here, never a substituted number.
 *
 * WO-922: `v.inputs` now also carries the optional per-axis `home`,
 * `limitMinus` and `limitPlus` maps (see `MachineStatus.inputs` in
 * controller.ts for the three-way true/false/null meaning, which is the whole
 * point of them). This push is typed as the contract itself and parsed with a
 * bare `JSON.parse` - no normalising, no defaulting - so a `null` sent by the
 * bridge arrives as `null` and an omitted key arrives as `undefined`. That
 * pass-through is load-bearing: turning either into `false` here would say
 * "wired and open" about an axis that has no input at all.
 *
 * The bridge half is WO-923 and has NOT landed as of 2026-08-23 -
 * `Machine.cs`'s status builder sets only estop/hardLimit/softLimit/probe/
 * limits/door/hold. A bridge that sends none of the new keys must keep
 * connecting and behaving exactly as today; that is a tested acceptance item
 * (`src/tests/machine/inputStates.wo922.test.ts`), not an assumption.
 */
/** The bridge adds one safety fact to the shared controller snapshot. A
 * present value is normalised at the socket boundary; an older bridge's
 * omission stays omitted so its frame remains byte-shape-compatible, and the
 * session reads that omission as false. Keeping it here,
 * rather than widening every backend's MachineStatus, keeps this bridge-only
 * contract out of GRBL and simulator fixtures. */
export interface BridgeMachineStatus extends MachineStatus {
  /** Optional on the declared wire shape because older bridges omit it. */
  softLimitLatched?: boolean
}

export interface BridgeStatusPush {
  t: 'status'
  v: BridgeMachineStatus
}

export interface BridgeConsolePush {
  t: 'console'
  v: { dir: 'tx' | 'rx'; text: string; severity: 'info' | 'warn' | 'error'; firmwareUpdateId?: string }
}

export interface BridgePhasePush {
  t: 'phase'
  v: { phase: ConnectionPhase; version: string | null }
}

/** WO-1072/1094: where the definition applied at bridge start came from.
 * `cache-baseline` means the current bridge opened no profile file; `cache`
 * remains accepted for bridge builds from before Phase B. */
export type BridgeDefinitionSource = 'cache' | 'cache-baseline' | 'profile' | 'none'

/** One key whose cached value disagreed with the active UCCNC profile. Values
 *  are display text from the bridge, not numbers to reinterpret here. */
export interface BridgeDefinitionDriftEntry {
  key: string
  cache: string
  profile: string
  kind: string | null
  source: string | null
  kept: boolean
}

/** The endpoint the bridge says its held VFD link actually opened. This is a
 * live connection fact, not an echo of a requested definition. The legacy
 * `vfd.port` field remains available for old RTU bridges, but TCP is represented
 * only by its real host/network port and can never masquerade as a COM port. */
export type BridgeVfdEndpoint =
  | { transport: 'rtu'; port: string; slaveAddress: number }
  | { transport: 'tcp'; host: string; tcpPort: number; slaveAddress: number }

/** Validate the additive endpoint block at the socket boundary. null means the
 * bridge omitted it (old bridge) or did not state a complete usable endpoint. */
export function readBridgeVfdEndpoint(raw: unknown): BridgeVfdEndpoint | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (!Number.isInteger(value.slaveAddress) || (value.slaveAddress as number) < 1
    || (value.slaveAddress as number) > 247) return null
  if (value.transport === 'rtu') {
    if (typeof value.port !== 'string' || value.port.trim() === '') return null
    return { transport: 'rtu', port: value.port, slaveAddress: value.slaveAddress as number }
  }
  if (value.transport === 'tcp') {
    if (typeof value.host !== 'string' || value.host.trim() === '') return null
    if (!Number.isInteger(value.tcpPort) || (value.tcpPort as number) < 1
      || (value.tcpPort as number) > 65535) return null
    return {
      transport: 'tcp',
      host: value.host,
      tcpPort: value.tcpPort as number,
      slaveAddress: value.slaveAddress as number,
    }
  }
  return null
}

/** The first frame the bridge sends, before anything else. `capabilities` is
 *  the sole authority on what this backend can do - never assume it. */
export interface BridgeHelloPush {
  t: 'hello'
  v: {
    protocol: number
    bridge: string
    capabilities: ControllerCapabilities
    readOnly: boolean
    /** WO-1042: current bridge values plus the profile seed they started from.
     * Optional because older bridges cannot provide the discriminator. */
    workOffsets?: {
      current: Record<WcsId, MachinePosition>
      /** null when the bridge was started without --profile. */
      profile: Record<WcsId, MachinePosition> | null
    }
    /** WO-427/442: whether a spindle link exists for THIS bridge process at
     *  all, independent of whether it is presently talking to hardware (the
     *  `vfd` push carries that). `present` is true only once `--vfd
     *  <definition.json>` was given and the definition validated; `name` is
     *  null unless `present` is true. See BRIDGE-PROTOCOL.md "Hello".
     *
     *  Optional, not required: every bridge build in practice sends it
     *  (BRIDGE-PROTOCOL.md documents it unconditionally), but several
     *  existing test fixtures construct a `hello` without it and are outside
     *  this WO's owned-paths, so `UccncController.adoptVfdDefinition` reads
     *  it with `?.` and treats an absent block the same as `present: false`
     *  rather than requiring every caller to widen. */
    vfd?: {
      present: boolean
      verified: boolean
      name: string | null
      /** WO-1733: the endpoint held by this bridge process. Optional for
       * compatibility; explicit null means there is no open VFD link. */
      endpoint?: BridgeVfdEndpoint | null
      /**
       * WO-967: THE DEFINITION DOCUMENT ITSELF, verbatim - the JSON the bridge
       * read from `--vfd <path>` and parsed into `Vfd.cs`. Until this order,
       * three fields (present / verified / name) were the whole of what this
       * application knew about Operator's spindle, so changing one Modbus register
       * meant hand-editing a file on the bridge machine with nothing on screen
       * to check it against.
       *
       * THE EXACT FRAME THE BRIDGE MUST SEND, so the machine seat can build to
       * it: `hello.v.vfd.definition` is the parsed `--vfd` file re-serialised
       * with the SAME key names the file uses - `format`, `schemaVersion`,
       * `id`, `name`, `verified`, `provenance`, `link`, `protocol`,
       * `registers`, `commands`, `resetSequence`, `status`, `fault`,
       * `constants`, `upToSpeedToleranceRpm`, `requiredParameters`, `notes`.
       * `liencam-vfd-definition` v1, byte-for-byte the schema
       * `vfd/huanyang-gt.definition.json` already carries and `Vfd.cs` already
       * parses. Simplest honest implementation on the C# side: send the file's
       * own JSON back up, re-emitted from the object it parsed.
       *
       * `unknown`, not `VfdDefinition`, ON PURPOSE. It arrives off a socket
       * from another process, so nothing may treat it as a definition before
       * this build has checked it: `readDeclaredVfdDefinition` below checks
       * the SHAPE of every field the type declares and then runs the product's
       * own `validateVfdDefinition` for the values, and hands back null plus a
       * sentence when either half does not hold up. A typed field here would
       * be this file asserting a fact about a frame it has not read.
       *
       * OPTIONAL, like the block it sits in: every bridge built before this
       * order sends `hello` without it, and those must go on connecting
       * unchanged. Absent means "this bridge does not state its definition",
       * which is a different fact from "there is no spindle link" - that one
       * is still `present`, and it is untouched here.
       *
       * IT IS NOT THE DECODE AUTHORITY. `UccncController.adoptVfdDefinition`
       * still compiles the definition LienCAM ships (`VFD_DEFINITIONS`) for
       * the `vfd` push, deliberately: swapping the live scale expressions to a
       * document a bridge sent changes what the spindle readout MEANS on a
       * running machine, and that is a change Operator has to see before it lands,
       * not a side effect of carrying a file up a wire.
       */
      definition?: unknown
    }
    /** WO-911: `UccncPaths.Hello()` (Bridge.cs) - the resolved install root,
     *  active profile path, UC100/FTD2XX dll paths, and every `.pro` found
     *  under the install root's `Profiles` folder. The WO-916 `.pro` import
     *  wizard is the reader; nothing here builds UI with it.
     *
     *  Optional, like `vfd` above and for the same reason: older bridge
     *  builds and existing test fixtures construct a `hello` without a
     *  `uccnc` key, and that must still connect - the field reads as
     *  null/undefined downstream, never a `{}` a picker could mistake for
     *  "zero profiles found on this machine" (WO-911 acceptance).
     *
     *  Key names copy `UccncPaths.Hello()` exactly, not the WO's draft
     *  names: the bridge sends `profile`, `uc100Dll`, `ftd2xxDll` (not
     *  `profilePath`, `uc100DllPath`, `ftd2xxDllPath`) - the bridge is the
     *  contract. Every path field is null until an install root resolves
     *  (Bridge.cs UccncPaths.TryResolve); `profiles` is `[]`, never absent,
     *  when no root is resolved or its `Profiles` folder is missing/empty. */
    uccnc?: {
      installRoot: string | null
      profile: string | null
      uc100Dll: string | null
      ftd2xxDll: string | null
      profiles: string[]
      /** The exact BoardID the bridge opened. Current bridges always send it;
       * optional preserves compatibility with older hello frames. Per the
       * CNCdrive contract, ids <= 0 select the demo controller. */
      board?: number
    }
    /** WO-1048/1072: always sent by a current bridge. Absence is deliberately
     *  retained for an older bridge that never performed the comparison. */
    definitionSource?: BridgeDefinitionSource
    definitionDrift?: BridgeDefinitionDriftEntry[]
  }
}

/** Read the two WO-1048 hello fields at the process boundary. A complete empty
 *  array is a positive "checked and agreed" result; undefined is kept distinct
 *  as "not stated". One malformed entry invalidates the report as a whole so
 *  no console line can mix checked and unchecked wire data. */
export function readBridgeDefinitionSource(raw: unknown): BridgeDefinitionSource | undefined {
  return raw === 'cache' || raw === 'cache-baseline' || raw === 'profile' || raw === 'none'
    ? raw
    : undefined
}

function isBridgeDefinitionDriftEntry(raw: unknown): raw is BridgeDefinitionDriftEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const entry = raw as Record<string, unknown>
  return typeof entry.key === 'string'
    && typeof entry.cache === 'string'
    && typeof entry.profile === 'string'
    && (typeof entry.kind === 'string' || entry.kind === null)
    && (typeof entry.source === 'string' || entry.source === null)
    && typeof entry.kept === 'boolean'
}

export function readBridgeDefinitionDrift(raw: unknown): BridgeDefinitionDriftEntry[] | undefined {
  if (!Array.isArray(raw) || !raw.every(isBridgeDefinitionDriftEntry)) return undefined
  return raw.map((entry) => ({ ...entry }))
}

/**
 * WO-1083's `zeroWorkAxis` receipt, read at the process boundary.
 *
 * Two shapes are legal on the wire and they mean different things:
 *  - a bare `true` (a bridge older than WO-1083): applied, CANNOT SAY what the
 *    offset became. `{confirmed: true}` with no `offset`.
 *  - `{ok, reason, wcs, axis, offset:{x,y,z}}` (current): applied or refused,
 *    with the whole WCS row echoed back when applied.
 *
 * Anything else - a bare `false`, a malformed object, a partial vector - is
 * "not confirmed" or "cannot say". `offset` is only ever produced from three
 * finite numbers, so no caller can be handed a half-vector to complete with a
 * guess (WO-1042).
 */
export function readZeroWorkAxisReceipt(raw: unknown): ZeroWorkAxisReceipt {
  if (raw === true) return { confirmed: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { confirmed: false }
  const value = raw as Record<string, unknown>
  if (value.ok !== true) return { confirmed: false }
  const wcs = typeof value.wcs === 'string' && (WCS_IDS as readonly string[]).includes(value.wcs)
    ? value.wcs as WcsId
    : undefined
  return { confirmed: true, wcs, offset: readWirePosition(value.offset) }
}

const WCS_IDS: readonly WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']

/** XYZ are the required base every controller reports. Definition-enabled
 * rotary coordinates are additive; if one is stated it must be finite. */
function readWirePosition(raw: unknown): MachinePosition | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const { x, y, z } = value
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined
  if (typeof y !== 'number' || !Number.isFinite(y)) return undefined
  if (typeof z !== 'number' || !Number.isFinite(z)) return undefined
  const position: MachinePosition = { x, y, z }
  for (const axis of ['a', 'b', 'c'] as const) {
    if (!(axis in value)) continue
    const coordinate = value[axis]
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) return undefined
    position[axis] = coordinate
  }
  return position
}

// ---- contract v3 pushes (WO-423) ----
//
// Only what the bridge can HONESTLY report. There is deliberately no job
// progress, offset, setting or accessory push: the AXBB-E reports progress by
// executing move id (already in the status frame), keeps no work-offset or
// settings tables of the kind GRBL dumps, and does not own the spindle -
// Operator's VFD is on a separate Modbus link.

/** A program-run lifecycle transition. `fault` is present only for 'failed'. */
export interface BridgeJobEventPush {
  t: 'jobEvent'
  v: {
    event: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed' | 'failed'
    fault: JobFault | null
  }
}

/** A homing cycle finished. The AXBB-E homes named axes, so it says which. */
export interface BridgeHomedPush {
  t: 'homed'
  v: { axes: JogAxis[] | null }
}

/** A fault the operator must clear, decoded from the UC100 status word
 *  (Estop / HardLimit / SoftLimit). */
export interface BridgeAlarmPush {
  t: 'alarm'
  v: { code: number | null; message: string; positionLost: boolean }
}

/**
 * The `applyMachineDefinition` reply value (WO-915).
 *
 * The FRAME is `ok` whenever the bridge handled the call at all; THIS value
 * says what the apply did, the same way `resetToIdle` reports `{ok, reason}`.
 * A refused apply and a half-applied one are different facts and both arrive
 * here rather than as a transport error.
 *
 * Every field is what the bridge sends (Bridge.cs `ApplyValue`). `lines` are
 * also pushed as `console` frames, so the operator sees them in order beside
 * everything else the bridge says.
 */
export interface BridgeApplyDefinitionReply {
  ok: boolean
  error: string | null
  configuredThisSession: boolean
  reHome: JogAxis[]
  lines: { text: string; severity: 'info' | 'warn' | 'error' }[]
}

// ---- the `vfd` push (WO-427, typed WO-442) ----
//
// The spindle is a Modbus VFD on its own serial link, not a controller
// output - see BRIDGE-PROTOCOL.md "The `vfd` push". This push never fires at
// all when the bridge was run without `--vfd <definition.json>`; a missing
// push is honest, a frame of nulls is not. `statusWords` and `status` are
// RAW register words, unconverted - the bridge does no unit conversion and
// never will (Vfd.cs's header: one expression evaluator in the product, and
// it is not in C#). Decoding them into real units is `vfdRuntime.ts`'s job
// (`vfdDecodePush`), which is what closes the gap this type used to leave as
// an `as unknown as` cast in `uccncController.ts`.
export interface BridgeVfdPush {
  t: 'vfd'
  v: {
    /** The last poll pass got a good reply. `false` (or `faulted: true`)
     *  means `statusWords`/`status` are stale - decode nothing from them. */
    up: boolean
    /** WHAT WE LAST COMMANDED, NOT WHAT THE INVERTER REPORTS. It is
     *  `_desired !== Stopped` on the bridge (Vfd.cs Sample) - `_desired` is
     *  only ever set by a Run or Stop call and is NEVER set from a register
     *  read. So `running: false` means "we have not asked it to turn", which
     *  is not the same claim as "it is not turning", and it is not evidence
     *  the spindle has stopped. The inverter's own account is
     *  `runStateWord` below. */
    running: boolean
    /** The definition's fault rule applied to `runStateWord`. */
    faulted: boolean
    /** The RAW word from the definition's OPERATING-STATE register. Its
     *  meaning comes from that definition's `runState.values` table; for
     *  Operator's Huanyang GT, 1 is forward, 2 reverse, 3 standby, 4 fault and 5
     *  POFF (WO-1057). This is the only field in this frame carrying the
     *  INVERTER's own account of what it is doing; `running` above carries
     *  ours.
     *
     *  Called `faultWord` until WO-1074, after the register's own wrong name
     *  - it is a state register whose 4 means fault, not a fault code. The
     *  real fault CODE is 0x5000 and this frame does not carry it.
     *
     *  ONLY MEANINGFUL WHEN `up` IS TRUE. A failed poll leaves the last word
     *  standing, so reading it while `up` is false is reading a stale sample
     *  - and absence of a "running" answer is not a "stopped" answer. */
    runStateWord: number
    /** The RAW command word last written. */
    commandWord: number
    /** The RAW setpoint word last written. */
    setpointWord: number
    consecutiveFailures: number
    lastStopReason: 'none' | 'commanded' | 'serialTimeout' | 'clientGone' | 'closing' | 'refused'
    lastError: string | null
    /** The RAW status register block, in order. */
    statusWords: number[]
    /** Status words NAMED by the definition's register map, still raw words
     *  - only for a field whose definition scale is the identity. A field
     *  with a real scale (a division, a derived quantity) is simply absent
     *  here; decoding it is LienCAM's job. */
    status: Partial<Record<VfdStatusFieldName, number>>
    /** Always null on the wire - computing it needs the commanded RPM, which
     *  the bridge does not track (BRIDGE-PROTOCOL.md). */
    upToSpeed: boolean | null
    /** WO-1733: the live transport endpoint. New bridges include this in every
     * push; omission keeps older RTU bridge frames compatible. */
    endpoint?: BridgeVfdEndpoint
    /** WO-1000: the serial port the spindle link is ACTUALLY on, as the bridge
     *  reports it - never the operator'''s selection. The picker renders this
     *  and nothing else (MACHINE-SETTINGS-DESIGN.md 3.2 gate 3: "The dropdown
     *  renders the pushed value. Always."), which is what keeps a port move
     *  that failed from silently appearing to have worked.
     *
     *  Optional, like '''vfd''' and '''uccnc''' on '''hello''' and for the same reason:
     *  every bridge built before the S5 bridge half omits it, and such a
     *  bridge must keep connecting and behaving exactly as today. An omitted
     *  key means "this bridge does not say"; an explicit null means "the link
     *  is not open on any port". They are different facts and neither is
     *  turned into the other here. */
    port?: string | null
  }
}

/** The inverter's own answer to WHETHER it is turning. Never use `running`
 * here: that field is the bridge's last commanded state. The operating-state
 * word is deliberately not used for direction because this drive reports the
 * opposite direction while physically turning correctly. */
export function vfdSpindleTurning(
  value: Pick<BridgeVfdPush['v'], 'up' | 'runStateWord'>,
  definition: Pick<VfdDefinition, 'registers'> | null,
): boolean | null {
  if (!value.up) return null
  const meaning = definition?.registers.runState.values
    ?.find((entry) => entry.value === value.runStateWord)?.meaning
  switch (meaning) {
    case 'running':
    case 'runningForward':
    case 'runningReverse':
      return true
    case 'stopped':
      return false
    case 'faulted':
    case 'poweredOff':
    default:
      // Like the native classifier, a tripped or unpowered drive cannot prove
      // the tool has finished coasting. Missing and unnamed values are equally
      // unable to prove either turning or stopped.
      return null
  }
}

export type BridgeMessage =
  | BridgeReplyMessage
  | BridgeStatusPush
  | BridgeConsolePush
  | BridgePhasePush
  | BridgeHelloPush
  | BridgeJobEventPush
  | BridgeHomedPush
  | BridgeAlarmPush
  | BridgeVfdPush

/** Decode the additive status fact at the process boundary. The rest of the
 * frame remains a straight pass-through: MachineStatus nulls and optional
 * input keys keep their exact wire meaning. */
export function readBridgeMessage(raw: unknown): BridgeMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw as BridgeMessage
  const frame = raw as Record<string, unknown>
  if (frame.t !== 'status' || typeof frame.v !== 'object' || frame.v === null || Array.isArray(frame.v)) {
    return raw as BridgeMessage
  }
  const status = frame.v as Record<string, unknown>
  if (!Object.hasOwn(status, 'softLimitLatched')) return raw as BridgeMessage
  return {
    ...frame,
    t: 'status',
    v: {
      ...status,
      softLimitLatched: status.softLimitLatched === true,
    } as unknown as BridgeMachineStatus,
  } as BridgeStatusPush
}

// ---- WO-1000: the VFD serial port picker, browser half (design slice S5) ----
//
// docs/machine/MACHINE-SETTINGS-DESIGN.md section 3.2 Option B is the AGREED
// wire shape, and this is its browser side, verbatim:
//
//   listSerialPorts -> { ports: string[] }   read-only; it opens nothing
//   setVfdPort { port }                      MOVES the existing link
//   `port` on the `vfd` push                 what the link is ACTUALLY on
//
// `setVfdPort` deliberately has no reply VALUE. Every reply frame already
// carries ok/error (BridgeReplyMessage), and the port that matters is the one
// the bridge PUSHES - so inventing a value shape here would be inventing
// contract the design does not specify, which is exactly what this work order
// forbids ("do not implement a wire contract unilaterally").
//
// NO VERSION BUMP, on purpose (design gate 5). A new call method and a new
// field on an existing push are additive both ways: a new bridge tells an old
// browser more than it reads, and an old bridge answers a new browser with the
// clean "the bridge does not know the method" refusal, which lands in `error`
// below and is shown to the operator verbatim. A `protocol` bump would refuse
// the connection outright (uccncController.ts).
//
// WHY THIS LIVES IN THE TRANSPORT and not on MachineController: the two calls
// need a socket and a frame stream and nothing else, and controller.ts /
// uccncController.ts are leased to the machine seat (WO-973/WO-975) - this
// order may not touch them. The transport is the one owned place that already
// has both halves. Nothing here is on the motion path: a picker frame is a
// call like any other, and a throw inside it can never stop a machine frame
// reaching the controller (see the onmessage handler in `start`).

export const BRIDGE_LIST_SERIAL_PORTS = 'listSerialPorts'
export const BRIDGE_SET_VFD_PORT = 'setVfdPort'
/** WO-1718: the definition push, as `VfdPortLink.clearDefinition` names it. */
export const BRIDGE_APPLY_VFD_DEFINITION = 'applyVfdDefinition'

/** The `listSerialPorts` reply value. Read-only: naming a port opens nothing. */
export interface BridgeSerialPortsValue {
  ports: string[]
}

/** Refusals this half produces ITSELF, before anything reaches the wire. The
 *  bridge is still the authority - these only stop asks already known to be
 *  wrong, so the operator gets a sentence instead of a round trip.
 *
 *  `noLink` is the bridge's own wording for `spindleOn` with no link
 *  (`pendant/uccnc-bridge/Bridge.cs`), copied so one refusal reads the same
 *  whichever end produced it. */
export const VFD_PORT_REFUSAL = {
  noBridge: "No machine bridge is connected, so nothing here can see this computer's serial ports.",
  noLink: 'no spindle link is configured - start the bridge with --vfd <definition.json>',
  spindleRunning: 'The spindle is running. Stop it before moving the spindle link to another port.',
  jobActive: 'A program is running. Stop it before moving the spindle link to another port.',
  emptyPort: 'Pick a serial port first.',
  tcpLink: 'This spindle uses Modbus TCP. Change its host or network port through the full spindle definition.',
  timedOut: 'The machine bridge did not answer.',
  disconnected: 'The machine bridge disconnected before it answered.',
} as const

/** Everything the picker renders. Replaced wholesale on every change, never
 *  mutated, so `useSyncExternalStore` can compare it by identity. */
export interface VfdPortLinkState {
  /** A bridge socket is open. */
  connected: boolean
  /** `hello` said this bridge process HAS a spindle link. Design gate 2: with
   *  no link there is nothing to move, and a call that could OPEN one would
   *  break BRIDGE-PROTOCOL safety rule 5 from the browser side. So the picker
   *  refuses rather than offering to create one. */
  linkPresent: boolean
  /** The port the bridge REPORTS the link is on. Design gate 3 - this is the
   *  only thing the dropdown ever shows, and the only thing that moves it is a
   *  `vfd` push. null means no bridge has said. */
  reportedPort: string | null
  /** The transport-aware endpoint the bridge reports. null means an old bridge
   * has not stated one, or no VFD link is open. */
  reportedEndpoint: BridgeVfdEndpoint | null
  /** What `listSerialPorts` returned. null means never asked, or the ask
   *  failed - which is not the same fact as "this computer has no serial
   *  ports", and is not flattened into `[]`. */
  ports: string[] | null
  /** A call is in flight. */
  busy: boolean
  /** The last refusal or failure, verbatim from the bridge wherever the bridge
   *  produced it. */
  error: string | null
  /** The last `vfd` push's `running`, and the job lifecycle from `jobEvent` -
   *  the two halves of design gate 1. */
  spindleRunning: boolean
  /** The inverter-owned turning fact from runStateWord. Null means no fresh,
   * recognised operating-state sample; it is never defaulted to stopped. */
  spindleTurning: boolean | null
  jobActive: boolean
  /**
   * WO-967: THE INVERTER'S OWN DOCUMENT, as this bridge process declared it on
   * `hello` and after this build validated it. null means no bridge has stated
   * one - an older bridge, a bridge started without `--vfd`, or a definition
   * that did not hold up (`declaredRefusal` then says why).
   *
   * It rides on this record rather than on a new one because its LIFETIME is
   * exactly this record's: the declaration belongs to one bridge process, and
   * `close()` puts the whole snapshot back to `VFD_PORT_LINK_DISCONNECTED`, so
   * a definition cannot outlive the session that stated it and be read later
   * as a fact about a machine nothing is talking to.
   *
   * CONFIRMED EVIDENCE. On hello it seeds `applied`, whose run-state table is
   * used only to classify words from this same link. A later definition edit
   * replaces `applied` only after the bridge returns its checked receipt.
   */
  declared: VfdDefinition | null
  /** Why `declared` is null although the bridge DID send something - the
   *  validator's own sentences, joined. null when the bridge sent nothing,
   *  which is silence rather than a fault and must not be reported as one. */
  declaredRefusal: string | null
  /** The document the bridge most recently confirmed it holds, either in
   * hello or an apply receipt. It is not commissioning evidence from the
   * inverter; `definition.verified` is the separate hardware fact. */
  applied: VfdDefinition | MachineSpindleLinkDefinition | null
  /**
   * WO-967 round 2: THE MACHINE THIS CONNECTION WAS OPENED FOR - the id
   * `BridgeTransport` was constructed with, carried on the snapshot so a
   * reader can tell WHOSE spindle it is looking at.
   *
   * Without it this record is one global snapshot with no owner, and the
   * Machine Library can make another machine the project's active one while
   * this bridge stays connected. A page that then renders `declared` states
   * machine A's COM port, slave address, registers and RPM scale under machine
   * B's name - and if B is also a UCCNC machine there is nothing on screen to
   * say it is the wrong inverter. A document about a machine is worthless
   * unless it says which machine.
   *
   * null means "this connection does not know its machine" (a transport built
   * without an id, and the disconnected record). It is NOT a wildcard: it
   * matches no machine, because a claim that cannot name its subject must not
   * be shown as a fact about whichever subject is on screen.
   */
  machineId: string | null
}

export const VFD_PORT_LINK_DISCONNECTED: VfdPortLinkState = Object.freeze({
  connected: false,
  linkPresent: false,
  reportedPort: null,
  reportedEndpoint: null,
  ports: null,
  busy: false,
  error: null,
  spindleRunning: false,
  spindleTurning: null,
  jobActive: false,
  declared: null,
  declaredRefusal: null,
  applied: null,
  machineId: null,
})

// ---- WO-967 fix round: this boundary carries its OWN shape check -----------
//
// THE HOLE ATTEMPT 1 LEFT, and it was a real one. `validateVfdDefinition` is a
// SAFETY validator. It is complete over the fields a wrong value could drive a
// spindle with - addresses, ranges, scale expressions, the mandatory `stop` -
// and it never claimed to be anything else: it takes a `VfdDefinition` because
// every other caller in the product has already parsed one out of a file
// through `parseVfdDefinition`. Attempt 1 used its `ok` as a general type
// guard for a document off a SOCKET, so every field it does not look at was
// cast to its declared type on no evidence at all: `requiredParameters`,
// `provenance`, `notes`, `link.rs485`, and a non-object `constants`.
//
// What that cost, concretely: a hello frame made from the shipped file with
// `requiredParameters: "bad"` passed here. The panel then read a nonzero
// `.length` off the STRING and called `.map` on it, which throws while React is
// rendering and takes the whole Machine Definition page down - instead of the
// whole-document refusal this boundary exists to produce.
//
// So the shape is now checked HERE, completely, over every field
// `VfdDefinition` declares, BEFORE the validator rather than leaning on it.
// Standing alone is the point: if the safety validator's coverage changes -
// and it should be free to, it answers a different question - this boundary
// does not silently get weaker with it. Both have to pass. Either one failing
// refuses the document whole, which is the promise the panel renders.
//
// It does NOT refuse unknown extra keys. A newer bridge that adds a field is
// not malformed, nothing on the page reads a key it does not know, and
// refusing the document for it would turn a compatible bridge into a refusal
// sentence on Operator's screen.

/** A field of the document that is not the shape `VfdDefinition` says it is.
 *  Same `{ path, sentence }` pair the validator produces, so one refusal
 *  string is built the same way whichever half found the problem. */
interface VfdShapeFault {
  path: string
  sentence: string
}

function isVfdBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VFD_PARITIES: readonly string[] = ['none', 'even', 'odd']
const VFD_RS485_WIRINGS: readonly string[] = ['two-wire', 'four-wire', 'none']
const VFD_ROUNDINGS: readonly string[] = ['nearest', 'down', 'up']
const VFD_WORD_ORDERS: readonly string[] = ['high-first', 'low-first']
const VFD_PROVENANCE_KINDS: readonly string[] = [
  'factory', 'user', 'imported', 'seeded-from-bridge', 'edited-here',
]

/**
 * Every field `VfdDefinition` declares, checked against the shape it declares.
 * Ranges are NOT this function's job - `validateVfdDefinition` owns those and
 * owns them better - so a baud of 3 passes here and is refused there. What
 * this answers is the only question a cast may be made on: is each field the
 * KIND of thing the rest of this build is about to treat it as.
 *
 * Empty means the shape holds.
 */
function vfdDefinitionShapeFaults(raw: Record<string, unknown>): VfdShapeFault[] {
  const faults: VfdShapeFault[] = []
  const bad = (path: string, sentence: string): false => {
    faults.push({ path, sentence })
    return false
  }
  const num = (value: unknown, path: string, what: string): boolean =>
    typeof value === 'number' && Number.isFinite(value)
      ? true
      : bad(path, `${what} has to be a number.`)
  const str = (value: unknown, path: string, what: string): boolean =>
    typeof value === 'string' ? true : bad(path, `${what} has to be text.`)
  const expr = (value: unknown, path: string, what: string): boolean =>
    typeof value === 'string' || typeof value === 'number'
      ? true
      : bad(path, `${what} has to be an expression such as \`set.rpm / 2.4\`, or a plain number.`)
  const oneOf = (value: unknown, allowed: readonly string[], path: string, what: string): boolean =>
    typeof value === 'string' && allowed.includes(value)
      ? true
      : bad(path, `${what} is one of ${allowed.join(', ')}.`)
  const block = (value: unknown, path: string, what: string): value is Record<string, unknown> =>
    isVfdBlock(value) ? true : bad(path, `${what} is missing, or is not a block of settings.`)
  const list = (value: unknown, path: string, what: string): value is unknown[] =>
    Array.isArray(value) ? true : bad(path, `${what} has to be a list.`)

  str(raw.format, 'format', 'the format name')
  num(raw.schemaVersion, 'schemaVersion', 'the schema version')
  str(raw.id, 'id', 'the id')
  str(raw.name, 'name', 'the name')
  if (typeof raw.verified !== 'boolean') {
    bad('verified', 'whether the definition has been verified has to be plainly true or false.')
  }
  num(raw.upToSpeedToleranceRpm, 'upToSpeedToleranceRpm', 'the up-to-speed tolerance')
  if (raw.notes !== undefined) str(raw.notes, 'notes', "the definition's notes")

  if (block(raw.provenance, 'provenance', 'where the definition came from')) {
    oneOf(raw.provenance.kind, VFD_PROVENANCE_KINDS, 'provenance.kind', 'where the definition came from')
    if (raw.provenance.source !== undefined) {
      str(raw.provenance.source, 'provenance.source', 'the source it came from')
    }
  }

  if (block(raw.link, 'link', 'the link block')) {
    const link = raw.link
    num(link.slaveAddress, 'link.slaveAddress', 'the slave address')
    num(link.pollIntervalMs, 'link.pollIntervalMs', 'the poll interval')
    num(link.retryCount, 'link.retryCount', 'the retry count')
    num(link.timeoutMs, 'link.timeoutMs', 'the reply timeout')
    if (link.transport === 'rtu') {
      str(link.port, 'link.port', 'the serial port name')
      num(link.baud, 'link.baud', 'the baud rate')
      num(link.dataBits, 'link.dataBits', 'the data bits')
      oneOf(link.parity, VFD_PARITIES, 'link.parity', 'the parity')
      num(link.stopBits, 'link.stopBits', 'the stop bits')
      // The validator never looks at this one, and the serial-link block puts
      // it on the page beside the port and the baud rate.
      oneOf(link.rs485, VFD_RS485_WIRINGS, 'link.rs485', 'the RS485 wiring')
    } else if (link.transport === 'tcp') {
      str(link.host, 'link.host', 'the host address')
      num(link.tcpPort, 'link.tcpPort', 'the network port')
    } else {
      bad('link.transport', 'the transport is `rtu` (a serial port) or `tcp` (a network adapter).')
    }
  }

  if (block(raw.protocol, 'protocol', 'the protocol block')) {
    num(raw.protocol.readFunction, 'protocol.readFunction', 'the read function code')
    num(raw.protocol.writeFunction, 'protocol.writeFunction', 'the write function code')
    oneOf(raw.protocol.wordOrder, VFD_WORD_ORDERS, 'protocol.wordOrder', 'the word order')
  }

  if (block(raw.registers, 'registers', 'the register map')) {
    const registers = raw.registers
    for (const role of VFD_REGISTER_ROLES) {
      const register = registers[role]
      if (!block(register, `registers.${role}`, `the ${role} register`)) continue
      num(register.address, `registers.${role}.address`, 'the register address')
      num(register.count, `registers.${role}.count`, 'the number of words')
      if (role !== 'setpoint') continue
      expr(register.scale, 'registers.setpoint.scale', 'the setpoint scale')
      if (block(register.encode, 'registers.setpoint.encode', 'how the setpoint is rounded and clamped')) {
        oneOf(register.encode.round, VFD_ROUNDINGS, 'registers.setpoint.encode.round', 'the rounding')
        num(register.encode.min, 'registers.setpoint.encode.min', 'the smallest setpoint word')
        num(register.encode.max, 'registers.setpoint.encode.max', 'the largest setpoint word')
      }
    }
  }

  if (block(raw.commands, 'commands', 'the command table')) {
    const table = raw.commands
    if (table.style === 'value') {
      if (block(table.values, 'commands.values', 'the command words')) {
        for (const [name, value] of Object.entries(table.values)) {
          if (value === undefined) continue
          if (!oneOf(name, VFD_COMMANDS, `commands.values.${name}`, `\`${name}\` is not a spindle command; a command name`)) continue
          num(value, `commands.values.${name}`, `the \`${name}\` command word`)
        }
      }
    } else if (table.style === 'bitfield') {
      num(table.idle, 'commands.idle', 'the idle word')
      if (block(table.commands, 'commands.commands', 'the bitfield commands')) {
        for (const [name, spec] of Object.entries(table.commands)) {
          if (spec === undefined) continue
          if (!oneOf(name, VFD_COMMANDS, `commands.commands.${name}`, `\`${name}\` is not a spindle command; a command name`)) continue
          if (!block(spec, `commands.commands.${name}`, `the \`${name}\` command`)) continue
          num(spec.mask, `commands.commands.${name}.mask`, 'the bit mask')
          num(spec.value, `commands.commands.${name}.value`, 'the bit value')
        }
      }
    } else {
      bad('commands.style', 'a command table is `value` (one word per command) or `bitfield` (bits inside one word).')
    }
  }

  if (list(raw.resetSequence, 'resetSequence', 'the fault-reset sequence')) {
    raw.resetSequence.forEach((step, index) => {
      const path = `resetSequence[${index}]`
      if (!block(step, path, 'a reset step')) return
      oneOf(step.command, VFD_COMMANDS, `${path}.command`, 'a reset step command')
      num(step.delayMsAfter, `${path}.delayMsAfter`, 'the pause after a reset step')
    })
  }

  if (list(raw.status, 'status', 'the telemetry block')) {
    raw.status.forEach((field, index) => {
      const path = `status[${index}]`
      if (!block(field, path, 'a telemetry field')) return
      oneOf(field.name, VFD_STATUS_FIELDS, `${path}.name`, 'a telemetry field name')
      if (field.source === 'register') {
        num(field.offset, `${path}.offset`, 'the word offset')
      } else if (field.source !== 'derived') {
        bad(`${path}.source`, 'a telemetry field comes from a `register` word or is `derived` from the fields above it.')
      }
      expr(field.scale, `${path}.scale`, 'a telemetry scale')
    })
  }

  if (block(raw.fault, 'fault', 'the fault rule')) {
    const fault = raw.fault
    if (fault.kind === 'equals') num(fault.value, 'fault.value', 'the fault value')
    else if (fault.kind === 'mask') num(fault.mask, 'fault.mask', 'the fault mask')
    else if (fault.kind !== 'nonZero') {
      bad('fault.kind', 'a fault rule is `equals` a value, `nonZero`, or a bit `mask`.')
    }
  }

  // The validator shrugs a non-object `constants` off to `{}` and reports
  // nothing, which is right for it - there is no expression to compile against
  // a name that does not exist. The page is not so lucky: `Object.entries` of
  // the string "bad" would put three rows named 0, 1 and 2 on screen, each
  // claiming to be a constant this inverter states. It states no such thing.
  if (block(raw.constants, 'constants', 'the named constants')) {
    for (const [name, value] of Object.entries(raw.constants)) {
      num(value, `constants.${name}`, `the constant \`${name}\``)
    }
  }

  // The field that took the page down. Rendered as a table of three strings
  // per row, so each of the three has to BE a string.
  if (list(raw.requiredParameters, 'requiredParameters', 'the parameters to set on the inverter itself')) {
    raw.requiredParameters.forEach((entry, index) => {
      const path = `requiredParameters[${index}]`
      if (!block(entry, path, 'a parameter to set on the inverter')) return
      str(entry.parameter, `${path}.parameter`, 'the parameter name')
      str(entry.value, `${path}.value`, 'the value it has to be set to')
      str(entry.why, `${path}.why`, 'why it has to be set')
    })
  }

  return faults
}

/** One refusal sentence out of many faults, from either half of the check. */
function vfdRefusalText(faults: readonly VfdShapeFault[]): string {
  return faults.map((f) => (f.path === '' ? f.sentence : `${f.path}: ${f.sentence}`)).join(' ')
}

/**
 * WO-967: read `hello.vfd.definition` without trusting it.
 *
 * The frame comes from another process, so nothing about it is taken on
 * faith. It passes TWO checks and the document is returned only when it
 * passes both whole: `vfdDefinitionShapeFaults` above, which answers "is every
 * field the kind of thing it says it is", and then the product's OWN
 * `validateVfdDefinition` - the same one the file importer and the safety gate
 * use - which answers "are the values ones this build can work with". A
 * half-checked definition is worse than none: the panel would render register
 * addresses and scales a person could reasonably act on while this build had
 * already decided it could not read them.
 *
 * The document is returned VERBATIM when it passes, not re-shaped. Unlike
 * `parseVfdDefinition`, which forces `verified: false` and
 * `provenance: imported` because a FILE a user picked cannot claim somebody
 * ran the verification flow, this is the bridge stating what it is running -
 * and the panel's job is to show that, not a version of it this software
 * edited on the way past. (Nothing downstream gates on it either: the spindle
 * gate reads `hello.vfd.verified`, which this does not touch.)
 *
 * Exported so a test can put a bad document in and watch the refusal come out.
 */
export function readDeclaredVfdDefinition(raw: unknown): {
  definition: VfdDefinition | null
  refusal: string | null
} {
  // Nothing said. Silence, not a fault - an older bridge and a bridge started
  // without `--vfd` both land here, and neither is something to complain at.
  if (raw === undefined || raw === null) return { definition: null, refusal: null }
  if (!isVfdBlock(raw)) {
    return {
      definition: null,
      refusal: 'the machine bridge sent a spindle definition that is not a definition object.',
    }
  }
  // SHAPE FIRST, and on its own evidence. Nothing below may cast on the
  // strength of a validator that was never asked to look at the field.
  const shapeFaults = vfdDefinitionShapeFaults(raw)
  if (shapeFaults.length > 0) {
    return { definition: null, refusal: vfdRefusalText(shapeFaults) }
  }
  const result = validateVfdDefinition(raw as unknown as VfdDefinition)
  if (!result.ok) {
    return { definition: null, refusal: vfdRefusalText(result.errors) }
  }
  return { definition: raw as unknown as VfdDefinition, refusal: null }
}

export interface VfdPortCallResult {
  ok: boolean
  error: string | null
}

/** A job that has started and not yet ended. 'paused' counts: a paused program
 *  still owns the machine. */
const JOB_ACTIVE_EVENTS = new Set(['started', 'paused', 'resumed'])

/** `seq` is a single space shared with UccncController, which numbers from 1
 *  upward and drops replies whose seq it does not recognise. Starting a long
 *  way above it keeps the two senders from ever colliding, without either
 *  needing to know the other exists. */
const VFD_PORT_SEQ_BASE = 1_000_000
const VFD_PORT_CALL_TIMEOUT_MS = 8_000

interface VfdPortReply {
  ok: boolean
  v?: unknown
  error: string | null
}

function readPortNames(value: unknown): string[] {
  const ports = (value as Partial<BridgeSerialPortsValue> | null | undefined)?.ports
  if (!Array.isArray(ports)) return []
  return ports.filter((p): p is string => typeof p === 'string')
}

// ---- WO-1000 design gate 4: where the chosen port is remembered ------------
//
// MACHINE-SETTINGS-DESIGN.md 3.2 gate 4: "Persistence stays in the app, not the
// bridge. The app remembers the chosen port in
// `appSettings.machineLinks[machineId]` and re-sends it after `hello` on every
// connect." The bridge stays stateless about this on purpose, so the memory has
// to live on this side of the wire - and DURABLY, or a LienCAM reload loses the
// operator's choice (the attempt-1 audit finding).
//
// WO-997 landed that record as `machineLinks` in `src/store/uiPrefs.ts`, keyed
// by machine profile id so one controller's setting cannot affect another. The
// VFD port goes in that SAME record (`MachineLinkSettings.vfdPort`), not beside
// it.
//
// WHY THE STORE IS INJECTED RATHER THAN IMPORTED. `src/store/uiPrefs.ts`
// already imports `BRIDGE_DEFAULT_PORT` from this module, and no module under
// `src/store/` imports `src/store/index.ts`; an import in the other direction
// would close a cycle through this file. So the arrow stays one-way and uiPrefs
// INSTALLS its machineLinks-backed memory here at import time. That is not a
// hopeful arrangement: `machineSession.ts` - the only thing in the product that
// constructs a BridgeTransport - imports `machineBridgePort` from uiPrefs to
// build the URL, so the memory is installed before any bridge connection can
// exist. With nothing installed (a unit test importing this module alone),
// nothing is remembered and nothing is re-sent, which is the safe direction.

export interface VfdPortMemory {
  /** The port last ACCEPTED for this machine profile, or null when the
   *  operator has never chosen one (or chose one that would not open). */
  read: (machineId: string) => string | null
  write: (machineId: string, port: string) => void
}

let vfdPortMemory: VfdPortMemory | null = null

/** Called by `src/store/uiPrefs.ts` at import. Pass null to uninstall. */
export function installVfdPortMemory(memory: VfdPortMemory | null): void {
  vfdPortMemory = memory
}

/** The port the operator last had ACCEPTED for this machine profile, or null. */
export function rememberedVfdPort(machineId: string): string | null {
  return vfdPortMemory?.read(machineId) ?? null
}

export function rememberVfdPort(machineId: string, port: string): void {
  vfdPortMemory?.write(machineId, port)
}

/** WO-1000 gate 4: which machine profile the bridge connection ABOUT TO BE
 *  OPENED belongs to.
 *
 *  A transport is handed a URL and nothing else (`machineSession.ts`:
 *  `new BridgeTransport(bridgeUrl(machineBridgePort(machineId)))`), so the id
 *  the design keys by is not visible here. `machineBridgePort` is the one call
 *  in the product that resolves a machine id at the connection boundary,
 *  immediately before that constructor runs, so it says so here - see the
 *  comment on it in `src/store/uiPrefs.ts`. The constructor parameter below is
 *  the real input; this is only its default, and a caller that knows its
 *  machine should pass it outright. */
let connectingMachineId: string | null = null

export function noteBridgeMachineId(machineId: string | null): void {
  connectingMachineId = machineId
}

/** The picker's model: it owns the two calls, and it derives everything it
 *  shows from frames the bridge sent. It never records the operator's choice
 *  as the answer. */
export class VfdPortLink {
  private snapshot: VfdPortLinkState = Object.freeze({
    ...VFD_PORT_LINK_DISCONNECTED,
    connected: true,
  })
  private readonly pending = new Map<number, (reply: VfdPortReply) => void>()
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private seq = VFD_PORT_SEQ_BASE
  private inFlight = 0
  private live = true

  private readonly sendCall: (message: BridgeCallMessage) => void
  private readonly onChange: () => void
  private readonly timeoutMs: number
  /** Gate 4: the machine profile whose `machineLinks` record this connection's
   *  remembered port is filed under. null means "remember nothing and re-send
   *  nothing": a link built without a known machine must not read or write a
   *  record that belongs to some other machine.
   *
   *  WO-967 round 2: it is also published on the snapshot, because the same
   *  fact answers "whose spindle definition is this?" for every reader of the
   *  record, not just for this class's own port memory. */
  private readonly machineId: string | null
  /** Gate 4's re-send happens at most ONCE per connection. */
  private resendArmed = true

  // Written out longhand rather than as constructor parameter properties:
  // this project builds with `erasableSyntaxOnly`.
  constructor(
    sendCall: (message: BridgeCallMessage) => void,
    onChange: () => void,
    timeoutMs: number = VFD_PORT_CALL_TIMEOUT_MS,
    machineId: string | null = null,
  ) {
    this.sendCall = sendCall
    this.onChange = onChange
    this.timeoutMs = timeoutMs
    this.machineId = machineId
    // Stamped here rather than in the field initializer above, which runs
    // before this line and cannot see the parameter. It is written once and
    // never patched: the machine a connection was opened for cannot change
    // while the connection lives, and `close()` drops the whole snapshot.
    this.snapshot = Object.freeze({ ...this.snapshot, machineId })
  }

  state(): VfdPortLinkState {
    return this.snapshot
  }

  publishApplied(definition: VfdDefinition | MachineSpindleLinkDefinition): void {
    if (!this.live) return
    const bridgeOwned = definition.provenance.kind === 'factory'
      || definition.provenance.kind === 'user'
      || definition.provenance.kind === 'imported'
    this.patch({
      applied: definition,
      ...(bridgeOwned
        ? { declared: definition as VfdDefinition, declaredRefusal: null }
        : {}),
    })
  }

  /** Observe one frame. Called for EVERY frame, before the controller sees it;
   *  it consumes nothing - a reply carrying one of this link's own seq numbers
   *  is simply ignored downstream, because the controller never issued it. */
  handleFrame(message: BridgeMessage): void {
    if (!this.live) return
    switch (message.t) {
      case 'hello': {
        // WO-967: the same frame carries whether a link EXISTS and, from a
        // bridge new enough to state it, WHAT that link is - checked here,
        // once per connection, so no surface downstream has to.
        const declared = readDeclaredVfdDefinition(message.v.vfd?.definition)
        const vfd = message.v.vfd
        const hasEndpoint = vfd !== undefined && Object.hasOwn(vfd, 'endpoint')
        const endpoint = hasEndpoint ? readBridgeVfdEndpoint(vfd.endpoint) : null
        this.patch({
          linkPresent: message.v.vfd?.present === true,
          declared: declared.definition,
          declaredRefusal: declared.refusal,
          applied: declared.definition,
          ...(hasEndpoint
            ? {
                reportedEndpoint: endpoint,
                reportedPort: endpoint?.transport === 'rtu' ? endpoint.port : null,
              }
            : {}),
        })
        return
      }
      case 'vfd': {
        const v = message.v
        const hasEndpoint = Object.hasOwn(v, 'endpoint')
        const endpoint = hasEndpoint ? readBridgeVfdEndpoint(v.endpoint) : null
        const next: Partial<VfdPortLinkState> = {
          spindleRunning: v.running === true,
          spindleTurning: vfdSpindleTurning(v, this.snapshot.applied),
        }
        if (hasEndpoint) {
          next.reportedEndpoint = endpoint
          next.reportedPort = endpoint?.transport === 'rtu' ? endpoint.port : null
        } else if ('port' in v) {
          // Old RTU bridge: an omitted `port` says nothing; explicit null says
          // no serial port is open. Do not infer any endpoint fields.
          next.reportedPort = typeof v.port === 'string' ? v.port : null
        }
        this.patch(next)
        // A transport-aware frame decides whether serial memory applies. The
        // legacy port-only path remains for old RTU bridges.
        if (hasEndpoint || 'port' in v) this.resendRememberedPort()
        return
      }
      case 'jobEvent':
        this.patch({ jobActive: JOB_ACTIVE_EVENTS.has(message.v.event) })
        return
      case 'reply': {
        const settle = this.pending.get(message.seq)
        if (settle === undefined) return // not ours: UccncController's seq space
        this.finish(message.seq)
        settle({ ok: message.ok, v: message.v, error: message.error ?? null })
        return
      }
      default:
        return
    }
  }

  /** Ask the bridge what serial ports this computer has. Opens nothing. */
  async listPorts(): Promise<VfdPortCallResult> {
    if (!this.live) return this.refuse(VFD_PORT_REFUSAL.noBridge)
    const reply = await this.call(BRIDGE_LIST_SERIAL_PORTS, {})
    if (!reply.ok) {
      // An old bridge lands here carrying its own "the bridge does not know
      // the method" sentence, which is exactly what the operator should read.
      const error = reply.error ?? 'The machine bridge would not list the serial ports.'
      this.patch({ error })
      return { ok: false, error }
    }
    this.patch({ ports: readPortNames(reply.v), error: null })
    return { ok: true, error: null }
  }

  /** Ask the bridge to MOVE the existing spindle link to `port`. */
  async selectPort(port: string): Promise<VfdPortCallResult> {
    const refusal = this.refusalFor(port)
    if (refusal !== null) return this.refuse(refusal)
    if (port === this.snapshot.reportedPort) {
      // Re-picking the port the link is already on would Close it - which
      // stops the spindle first, by design - and Open it again for nothing.
      // It is still the operator's standing choice, so it is still remembered.
      this.remember(port)
      this.patch({ error: null })
      return { ok: true, error: null }
    }
    const reply = await this.call(BRIDGE_SET_VFD_PORT, { port })
    if (!reply.ok) {
      // THE NEGATIVE CONTROL. `reportedPort` is not touched here, ever. A port
      // that fails to open leaves the picker showing the port the link is
      // still on, and the failure is stated rather than swallowed.
      const error = reply.error ?? `The machine bridge could not move the spindle link to ${port}.`
      this.patch({ error })
      return { ok: false, error }
    }
    // Accepted - and STILL no local selection. The dropdown moves when the
    // bridge pushes the port it opened, not when it says it took the ask.
    // Gate 4 is a different question from gate 3, and this is its answer: what
    // the operator ASKED FOR and the bridge TOOK is the choice the app keeps.
    this.remember(port)
    this.patch({ error: null })
    return { ok: true, error: null }
  }

  /** WO-1718: this machine's definition has NO VFD link, so the bridge must
   *  not hold one. `applyVfdDefinition` with `definition: null` is the same
   *  seam an edit uses, carrying "none"; the bridge closes the link and
   *  answers with no definition (bridge half: WO-1719). An older bridge
   *  refuses, and that refusal is returned verbatim. */
  async clearDefinition(): Promise<VfdPortCallResult> {
    if (!this.live) return { ok: false, error: VFD_PORT_REFUSAL.noBridge }
    const reply = await this.call(BRIDGE_APPLY_VFD_DEFINITION, { definition: null })
    // The bridge answers a refused definition with an ok FRAME carrying
    // `{ ok: false, reason }` (Bridge.cs VfdApplyRefusal) - that is a refusal.
    const value = typeof reply.v === 'object' && reply.v !== null
      ? reply.v as { ok?: unknown; reason?: unknown }
      : null
    if (!reply.ok || value?.ok === false) {
      return {
        ok: false,
        error: reply.error
          ?? (typeof value?.reason === 'string' ? value.reason : null)
          ?? 'The machine bridge did not confirm it closed the spindle link.',
      }
    }
    this.patch({ applied: null, declared: null, declaredRefusal: null, linkPresent: false })
    return { ok: true, error: null }
  }

  /** Gate 4, the write half. Only an ACCEPTED port is recorded: a refused one
   *  is not a standing choice, it is a port that would not open, and re-sending
   *  it on every future connect would be a refusal loop. */
  private remember(port: string): void {
    if (this.machineId === null) return
    rememberVfdPort(this.machineId, port)
  }

  /** Gate 4, the read half: "the app ... re-sends it after `hello` on every
   *  connect". This is that re-send.
   *
   *  It fires on the first `vfd` push of a connection that STATES a port,
   *  rather than on `hello` itself, and the ordering is a safety decision, not
   *  a convenience: `hello` does not say which port the link came up on, and a
   *  `setVfdPort` sent blind would Close() a link that may already be exactly
   *  where the operator wants it - and Close() stops the spindle first, by
   *  design (Vfd.cs). So a bridge that never states a port never gets a
   *  re-send: there is nothing to compare against, and guessing here moves a
   *  spindle link on a guess.
   *
   *  At most once per connection, and a re-send the gates refuse (a spindle
   *  already turning, a program already running) is REFUSED rather than
   *  queued. Restoring a port later, at whatever moment the spindle happened
   *  to stop, is precisely the "something switched underneath the operator"
   *  this order exists to prevent. The refusal lands in `error`, verbatim, the
   *  same as if the operator had asked by hand. */
  private resendRememberedPort(): void {
    if (!this.resendArmed) return
    // `hello` has not landed yet, so `linkPresent` is not yet known - do not
    // spend the one shot on a frame that arrived out of order.
    if (!this.snapshot.linkPresent) return
    // A remembered COM port belongs only to RTU. Sending it to a TCP link would
    // close/reopen a healthy socket on old bridge code and falsely report a
    // serial move. TCP changes travel through applyVfdDefinition instead.
    if (this.snapshot.reportedEndpoint?.transport === 'tcp') {
      this.resendArmed = false
      return
    }
    this.resendArmed = false
    if (this.machineId === null) return
    const remembered = rememberedVfdPort(this.machineId)
    if (remembered === null) return
    // Already where the operator left it: send NOTHING. A setVfdPort here
    // would Close/Open a healthy link for no gain, on every single connect.
    if (remembered === this.snapshot.reportedPort) return
    void this.selectPort(remembered)
  }

  /** The socket is gone: settle everything outstanding and go blank. */
  close(): void {
    if (!this.live) return
    this.live = false
    for (const seq of [...this.pending.keys()]) {
      const settle = this.pending.get(seq)
      this.finish(seq)
      settle?.({ ok: false, error: VFD_PORT_REFUSAL.disconnected })
    }
    this.inFlight = 0
    this.snapshot = VFD_PORT_LINK_DISCONNECTED
    this.onChange()
  }

  private refusalFor(port: string): string | null {
    if (!this.live) return VFD_PORT_REFUSAL.noBridge
    if (port.trim() === '') return VFD_PORT_REFUSAL.emptyPort
    if (!this.snapshot.linkPresent) return VFD_PORT_REFUSAL.noLink
    if (this.snapshot.reportedEndpoint?.transport === 'tcp') return VFD_PORT_REFUSAL.tcpLink
    if (this.snapshot.spindleRunning) return VFD_PORT_REFUSAL.spindleRunning
    if (this.snapshot.jobActive) return VFD_PORT_REFUSAL.jobActive
    return null
  }

  private refuse(error: string): VfdPortCallResult {
    this.patch({ error })
    return { ok: false, error }
  }

  private call(method: string, args: Record<string, unknown>): Promise<VfdPortReply> {
    return new Promise<VfdPortReply>((resolve) => {
      this.seq += 1
      const seq = this.seq
      this.inFlight += 1
      this.patch({ busy: true })
      let done = false
      const settle = (reply: VfdPortReply): void => {
        if (done) return
        done = true
        this.inFlight = Math.max(0, this.inFlight - 1)
        this.patch({ busy: this.inFlight > 0 })
        resolve(reply)
      }
      this.pending.set(seq, settle)
      this.timers.set(
        seq,
        setTimeout(() => {
          this.finish(seq)
          settle({ ok: false, error: VFD_PORT_REFUSAL.timedOut })
        }, this.timeoutMs),
      )
      try {
        this.sendCall({ t: 'call', seq, m: method, a: args })
      } catch {
        this.finish(seq)
        settle({ ok: false, error: VFD_PORT_REFUSAL.noBridge })
      }
    })
  }

  private finish(seq: number): void {
    this.pending.delete(seq)
    const timer = this.timers.get(seq)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(seq)
  }

  private patch(next: Partial<VfdPortLinkState>): void {
    const merged = { ...this.snapshot, ...next }
    let changed = false
    for (const key of Object.keys(merged) as (keyof VfdPortLinkState)[]) {
      if (merged[key] !== this.snapshot[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.snapshot = Object.freeze(merged)
    this.onChange()
  }
}

// The live link, so a settings surface can reach the open socket without
// holding a transport instance. Exactly one bridge connection exists at a time
// (machineSession builds one BridgeTransport per connect), so this is a
// pointer, not a registry.
let activeLink: VfdPortLink | null = null
const linkListeners = new Set<() => void>()

function announceVfdPortLink(): void {
  for (const listener of [...linkListeners]) listener()
}

/** For `useSyncExternalStore(subscribeVfdPortLink, vfdPortLinkState)`. */
export function subscribeVfdPortLink(listener: () => void): () => void {
  linkListeners.add(listener)
  return () => {
    linkListeners.delete(listener)
  }
}

export function vfdPortLinkState(): VfdPortLinkState {
  return activeLink?.state() ?? VFD_PORT_LINK_DISCONNECTED
}

export function activeVfdPortLink(): VfdPortLink | null {
  return activeLink
}

/** Publish the document confirmed by an `applyVfdDefinition` reply. The
 * machine id check is the write-side counterpart of the panel's foreign-link
 * guard: one global socket may never update another machine's definition. */
export function publishAppliedVfdDefinition(
  machineId: string,
  definition: VfdDefinition | MachineSpindleLinkDefinition,
): void {
  const link = activeVfdPortLink()
  if (link?.state().machineId !== machineId) return
  link.publishApplied(definition)
}

/** WO-1718: tell the bridge connected for `machineId` that its definition
 *  holds no VFD link. Null when no such bridge is connected - nothing to tell. */
export function clearVfdDefinitionOnBridge(
  machineId: string,
): Promise<VfdPortCallResult> | null {
  const link = activeVfdPortLink()
  if (link === null || link.state().machineId !== machineId) return null
  return link.clearDefinition()
}

function setActiveVfdPortLink(link: VfdPortLink | null): void {
  if (activeLink === link) return
  activeLink = link
  announceVfdPortLink()
}

/** Test seam: install a link with no socket behind it. Production sets this
 *  from BridgeTransport's connect and close, and nowhere else. */
export function __setActiveVfdPortLinkForTest(link: VfdPortLink | null): void {
  setActiveVfdPortLink(link)
}

export interface BridgeTransportEvents {
  /** One decoded frame from the bridge: a reply, a push, or hello. */
  onMessage: (message: BridgeMessage) => void
  /** Idempotent. Triggers onClose exactly once. */
  onClose: (reason: string | null) => void
}

/** Raw VFD telemetry observer for session-level operator notices. The
 * controller still receives the frame first; this is additive and consumes
 * nothing from the machine-state path. */
export type BridgeVfdFrameObserver = (value: BridgeVfdPush['v']) => void

/** WO-423: `MessageChannel` is declared, so the compiler checks at the
 *  DECLARATION that this satisfies what contract v3 types
 *  `ControllerBackend.transport` as - rather than at each connect call. */
export class BridgeTransport implements MessageChannel {
  private readonly url: string
  private socket: WebSocket | null = null
  private events: BridgeTransportEvents | null = null
  private closed = false
  /** Present only while start() is opening or waiting for its one retry. */
  private cancelPendingStart: (() => void) | null = null
  /** WO-1000. Built with the socket, published as the active link once the
   *  socket opens, and torn down with it. Assigned in the constructor body
   *  rather than as a field initializer because it needs `url`, which is not
   *  yet assigned while field initializers run. */
  private readonly vfdPortLink: VfdPortLink
  private readonly onVfdFrame: BridgeVfdFrameObserver | null

  constructor(
    url: string = bridgeUrl(),
    machineId: string | null = connectingMachineId,
    onVfdFrame: BridgeVfdFrameObserver | null = null,
  ) {
    if (!isLoopbackWsUrl(url)) {
      throw new Error(
        'The machine bridge may only be reached on this computer (127.0.0.1). ' +
          'A machine control link must never be dialled across a network.',
      )
    }
    this.url = url
    this.onVfdFrame = onVfdFrame
    // Gate 4's memory is keyed by MACHINE PROFILE, not by endpoint: WO-997
    // already files this computer's per-machine link settings that way
    // (`machineLinks` in uiPrefs.ts), and two machines can share one bridge
    // endpoint over time while never sharing a spindle. `machineId` defaults to
    // the id `machineBridgePort` resolved a moment ago for this very connect;
    // null means "remember nothing", not "remember it somewhere else".
    this.vfdPortLink = new VfdPortLink(
      (message) => this.send(message),
      announceVfdPortLink,
      VFD_PORT_CALL_TIMEOUT_MS,
      machineId,
    )
  }

  static isSupported(): boolean {
    return typeof WebSocket !== 'undefined'
  }

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
    await new Promise<void>((resolve, reject) => {
      let finished = false
      let retryTimer: ReturnType<typeof setTimeout> | null = null
      let closeGraceTimer: ReturnType<typeof setTimeout> | null = null
      const failures: string[] = []
      const lifecycleTarget = globalThis as unknown as {
        addEventListener?: (type: string, listener: () => void) => void
        removeEventListener?: (type: string, listener: () => void) => void
      }

      const clearPending = () => {
        if (retryTimer !== null) clearTimeout(retryTimer)
        if (closeGraceTimer !== null) clearTimeout(closeGraceTimer)
        retryTimer = null
        closeGraceTimer = null
        lifecycleTarget.removeEventListener?.('pagehide', cancel)
        this.cancelPendingStart = null
      }

      const detach = (socket: WebSocket) => {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
      }

      const rejectStart = (error: Error) => {
        if (finished) return
        finished = true
        clearPending()
        const socket = this.socket
        this.socket = null
        if (socket !== null) {
          detach(socket)
          try { socket.close() } catch { /* already gone */ }
        }
        this.closed = true
        this.vfdPortLink.close()
        reject(error)
      }

      const cancel = () => {
        rejectStart(new Error('Machine bridge connection cancelled.'))
      }
      this.cancelPendingStart = cancel
      lifecycleTarget.addEventListener?.('pagehide', cancel)

      const failureSentence = (event: CloseEvent): string => {
        const code = Number.isFinite(event.code) && event.code > 0 ? event.code : null
        const reason = event.reason.trim()
        const detail = code === null
          ? (reason ? `: ${reason}` : '')
          : reason ? ` (code ${code}: ${reason})` : ` (code ${code})`
        return `closed before a WebSocket session opened${detail}`
      }

      const finalFailure = () => new Error(
        `Could not establish a machine bridge WebSocket at ${this.url} after 2 attempts. `
        + `First attempt: ${failures[0]}. Retry: ${failures[1]}.`,
      )

      const openAttempt = (attempt: 1 | 2) => {
        if (finished || this.closed) return
        let socket: WebSocket
        try {
          socket = new WebSocket(this.url)
        } catch (err) {
          if (attempt === 1) {
            rejectStart(new Error(`Could not create a machine bridge WebSocket at ${this.url}: ${String(err)}`))
          } else {
            failures.push(`the WebSocket could not be created: ${String(err)}`)
            rejectStart(finalFailure())
          }
          return
        }
        this.socket = socket
        let opened = false
        let attemptFinished = false
        let errorObservedAt: number | null = null

        const failAttempt = (sentence: string, failedAt = Date.now()) => {
          if (finished || attemptFinished || this.socket !== socket) return
          attemptFinished = true
          if (closeGraceTimer !== null) clearTimeout(closeGraceTimer)
          closeGraceTimer = null
          failures.push(sentence)
          this.socket = null
          detach(socket)
          try { socket.close() } catch { /* already gone */ }
          if (attempt === 2) {
            rejectStart(finalFailure())
            return
          }
          const remaining = Math.max(0, BRIDGE_INITIAL_CONNECT_RETRY_MS - (Date.now() - failedAt))
          retryTimer = setTimeout(() => {
            retryTimer = null
            openAttempt(2)
          }, remaining)
        }

        socket.onopen = () => {
          if (finished || attemptFinished || this.socket !== socket) return
          opened = true
          attemptFinished = true
          finished = true
          clearPending()
          setActiveVfdPortLink(this.vfdPortLink)
          resolve()
        }

        socket.onmessage = (event: MessageEvent) => {
          if (this.closed || this.socket !== socket) return
        if (typeof event.data !== 'string') return // the protocol is text frames only
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          // A malformed frame is a bridge bug, not something the transport
          // can meaningfully act on - drop it rather than crash the session.
          return
        }
        const frame = readBridgeMessage(parsed)
        try {
          // WO-1000: the port picker observes first and consumes nothing. It
          // is a settings surface, so a throw in here must never be able to
          // stop a machine frame from reaching the controller.
          this.vfdPortLink.handleFrame(frame)
        } catch {
          // deliberately swallowed - see above
        }
        this.events?.onMessage(frame)
        // Operator notices observe the same checked frame after the
        // controller has consumed it. A notice can never delay or replace the
        // machine-state update that makes the stop visible everywhere else.
        if (frame.t === 'vfd') this.onVfdFrame?.(frame.v)
        }

        socket.onerror = () => {
        // The browser deliberately withholds the reason for a failed WebSocket
          // handshake. Give the paired close event one short turn to contribute
          // its actual code/reason; if none comes, report only what is known.
          if (!opened && !attemptFinished && errorObservedAt === null) {
            errorObservedAt = Date.now()
            closeGraceTimer = setTimeout(() => {
              closeGraceTimer = null
              failAttempt('the handshake did not complete', errorObservedAt!)
            }, BRIDGE_HANDSHAKE_CLOSE_GRACE_MS)
          }
        }

        socket.onclose = (event: CloseEvent) => {
          if (this.socket !== socket) return
          if (!opened) {
            if (finished || attemptFinished) return
            failAttempt(failureSentence(event), errorObservedAt ?? Date.now())
            return
          }
          this.handleClose(event.reason || 'the machine bridge disconnected')
        }
      }

      openAttempt(1)
    })
  }

  /** Send one call frame. Fire-and-forget at the wire level - the caller
   *  correlates the reply by `seq` if it needs one. */
  send(message: BridgeClientMessage): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Transport not started')
    }
    socket.send(JSON.stringify(message))
  }

  async close(): Promise<void> {
    if (this.cancelPendingStart !== null) {
      this.cancelPendingStart()
      return
    }
    if (this.closed) return
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // already gone - the onClose below is what callers actually need
    }
    this.handleClose('disconnect requested')
  }

  /** Idempotent: BridgeTransportEvents.onClose must fire exactly once. */
  private handleClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.socket = null
    this.vfdPortLink.close()
    if (activeVfdPortLink() === this.vfdPortLink) setActiveVfdPortLink(null)
    this.events?.onClose(reason)
  }
}
