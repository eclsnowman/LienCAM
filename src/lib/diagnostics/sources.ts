// WO-2759: the readers that fill each report category from EXISTING state
// (design section 2: "read only approved fields from existing state"). Every
// reader builds a fresh object from named fields; none spreads, serializes or
// forwards a store object, and none queries the controller or the disk.

import { APP_VERSION, BUILD_DATE, GIT_COMMIT_LABEL } from '../../version'
import type { Operation, Tool } from '../../types'

export type Surface = 'desktop' | 'web'

export function currentSurface(): Surface {
  const host = (globalThis as { liencamHost?: unknown }).liencamHost
  return host !== undefined && host !== null ? 'desktop' : 'web'
}

// --- App and component versions (default on) ---------------------------------

export interface AppVersions {
  appVersion: string
  build: string
  buildDate: string
  surface: Surface
}

const SAFE_TOKEN = /^[A-Za-z0-9._+\-:]{1,80}$/
const token = (value: string) => (SAFE_TOKEN.test(value) ? value : 'unavailable')

export function readAppVersions(): AppVersions {
  return { appVersion: token(APP_VERSION), build: token(GIT_COMMIT_LABEL), buildDate: token(BUILD_DATE), surface: currentSurface() }
}

// --- Basic and precise environment -------------------------------------------

// Two probes, one per category (design section 3: an optional category is read
// only once ticked). The Basic probe reads only what its buckets need: user
// agent (OS family), device memory (RAM bucket), pixel ratio (scale bucket)
// and the GPU description (family). Screen size and processor count belong to
// Precise environment alone and are read only by its probe.

export interface BasicProbe {
  userAgent: string
  deviceMemory: number | null
  devicePixelRatio: number
  gpu: { vendor: string; renderer: string } | null
}

export interface PreciseProbe {
  deviceMemory: number | null
  devicePixelRatio: number
  hardwareConcurrency: number | null
  screen: { width: number; height: number } | null
  gpu: { vendor: string; renderer: string } | null
}

type Nav = Navigator & { deviceMemory?: number }
const nav = () => (globalThis.navigator ?? {}) as Nav
const deviceMemory = () => (typeof nav().deviceMemory === 'number' ? nav().deviceMemory as number : null)
const pixelRatio = () => (typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1)

/** The WebGL context is made, read and dropped. */
function probeGpu(): BasicProbe['gpu'] {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    if (!gl || !ext) return null
    const gpu = { vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return gpu
  } catch { return null }
}

/** The Basic environment's fields from the live browser - nothing else. */
export function probeBasicEnvironment(): BasicProbe {
  return { userAgent: String(nav().userAgent ?? ''), deviceMemory: deviceMemory(), devicePixelRatio: pixelRatio(), gpu: probeGpu() }
}

/** Precise environment's fields from the live browser - call only once ticked. */
export function probePreciseEnvironment(): PreciseProbe {
  const n = nav()
  const s = globalThis.screen
  return {
    deviceMemory: deviceMemory(),
    devicePixelRatio: pixelRatio(),
    hardwareConcurrency: typeof n.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
    screen: typeof s === 'object' && s ? { width: s.width, height: s.height } : null,
    gpu: probeGpu(),
  }
}

export interface BasicEnvironment {
  osFamily: 'windows' | 'macos' | 'linux' | 'other'
  ram: '<=8 GiB' | '<=16 GiB' | '<=32 GiB' | '>32 GiB' | 'unavailable'
  gpuFamily: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' | 'unavailable'
  displayScale: '<=100%' | '<=150%' | '<=200%' | '>200%'
}

export function basicEnvironment(probe: BasicProbe): BasicEnvironment {
  const ua = probe.userAgent
  const osFamily = /Windows/i.test(ua) ? 'windows' : /Mac OS X|Macintosh/i.test(ua) ? 'macos' : /Linux|X11/i.test(ua) ? 'linux' : 'other'
  const gpuText = probe.gpu ? `${probe.gpu.vendor} ${probe.gpu.renderer}` : ''
  const gpuFamily = !probe.gpu ? 'unavailable'
    : /nvidia|geforce|quadro|rtx/i.test(gpuText) ? 'nvidia'
    : /amd|radeon|ati/i.test(gpuText) ? 'amd'
    : /intel/i.test(gpuText) ? 'intel'
    : /apple/i.test(gpuText) ? 'apple' : 'other'
  const scale = probe.devicePixelRatio * 100
  const mem = probe.deviceMemory
  return {
    osFamily,
    ram: mem === null ? 'unavailable' : mem <= 8 ? '<=8 GiB' : mem <= 16 ? '<=16 GiB' : mem <= 32 ? '<=32 GiB' : '>32 GiB',
    gpuFamily,
    displayScale: scale <= 100 ? '<=100%' : scale <= 150 ? '<=150%' : scale <= 200 ? '<=200%' : '>200%',
  }
}

export interface PreciseEnvironment {
  gpuVendor: string
  gpuRendererAndDriver: string
  screenPixels: string
  devicePixelRatio: number
  logicalProcessors: number | null
  deviceMemoryGiB: number | null
}

const printable = (value: string) => value.replace(/[^\x20-\x7e]/g, '').slice(0, 200) || 'unavailable'

/** Choice H: exact GPU/driver/display, offered and off by default. */
export function preciseEnvironment(probe: PreciseProbe): PreciseEnvironment {
  return {
    gpuVendor: probe.gpu ? printable(probe.gpu.vendor) : 'unavailable',
    gpuRendererAndDriver: probe.gpu ? printable(probe.gpu.renderer) : 'unavailable',
    screenPixels: probe.screen ? `${Math.round(probe.screen.width)}x${Math.round(probe.screen.height)}` : 'unavailable',
    devicePixelRatio: Math.round(probe.devicePixelRatio * 1000) / 1000,
    logicalProcessors: probe.hardwareConcurrency,
    deviceMemoryGiB: probe.deviceMemory,
  }
}

// --- Machine incident state (on if available) --------------------------------

export interface MachineInput {
  connectionPhase: string
  connectionKind: string | null
  machineState: string
  grblVersion: string | null
  alarm: { code: number | null; positionLost: boolean } | null
  job: { phase: string; totalLines: number; sentLines: number; ackedLines: number }
  parserModal: { units: string | null; distanceMode: string | null; motionMode: string | null } | null
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | 'unavailable' =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : 'unavailable'
const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null)

export interface MachineStateSnapshot {
  captured: 'when report was created'
  connection: string
  transport: string
  state: string
  controllerFirmware: string
  alarm: { code: number | null; positionLost: boolean } | null
  job: { phase: string; totalLines: number | null; sentLines: number | null; acknowledgedLines: number | null }
  modal: { units: string; distanceMode: string; motionMode: string } | null
  note: string
}

export function machineAvailable(m: MachineInput): boolean {
  return m.connectionPhase !== 'disconnected' || m.job.phase !== 'empty' || m.alarm !== null
}

/** Control sequence and state, not physical execution proof: ACK is not "executed". */
export function machineSnapshot(m: MachineInput): MachineStateSnapshot {
  return {
    captured: 'when report was created',
    connection: oneOf(m.connectionPhase, ['disconnected', 'connecting', 'connected']),
    transport: m.connectionKind === null ? 'none' : oneOf(m.connectionKind, ['serial', 'simulator', 'bridge', 'gateway']),
    state: oneOf(m.machineState, ['unknown', 'idle', 'run', 'hold', 'jog', 'alarm', 'door', 'check', 'home', 'sleep']),
    controllerFirmware: m.grblVersion !== null && /^[A-Za-z0-9 ._\-]{1,40}$/.test(m.grblVersion) ? m.grblVersion : 'unavailable',
    alarm: m.alarm ? { code: count(m.alarm.code), positionLost: m.alarm.positionLost === true } : null,
    job: {
      phase: oneOf(m.job.phase, ['empty', 'ready', 'streaming', 'paused', 'failed', 'complete']),
      totalLines: count(m.job.totalLines),
      sentLines: count(m.job.sentLines),
      acknowledgedLines: count(m.job.ackedLines),
    },
    modal: m.parserModal ? {
      units: oneOf(m.parserModal.units, ['mm', 'inch']),
      distanceMode: oneOf(m.parserModal.distanceMode, ['absolute', 'incremental']),
      motionMode: typeof m.parserModal.motionMode === 'string' && /^G\d{1,2}(?:\.\d)?$/.test(m.parserModal.motionMode) ? m.parserModal.motionMode : 'unavailable',
    } : null,
    note: 'Acknowledged lines were accepted by the controller; this is not proof they were executed. No commands, positions or offsets are included.',
  }
}

// --- Operation settings and referenced tool (off) ----------------------------

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e7 ? Math.round(value * 10000) / 10000 : null

export interface OperationSettingsSnapshot {
  captured: 'when report was created'
  units: 'mm, mm/min, rpm, degrees'
  family: string
  passes: Record<string, number | null>
  linking: Record<string, string | number | null>
  feeds: { source: 'operation override' | 'tool preset (values not included)'; values: Record<string, number | null> | null }
  tool: Record<string, string | number | null> | null
  note: string
}

const TOOL_TYPE = /^[a-z0-9_]{1,40}$/

/**
 * Settings middle tier, schema version 1. Explicit field map: every value is
 * read by name and type-checked; `params`, names, notes, vendor/product ids,
 * the material map and every geometry reference are never read.
 */
export function operationSettings(op: Operation, tool: Tool | null, familyIds: readonly string[]): OperationSettingsSnapshot {
  const p = op.passes
  const l = op.linking
  const o = op.feedrateOverride
  const linkEnum = (value: unknown, allowed: readonly string[]) => (typeof value === 'string' && allowed.includes(value) ? value : null)
  return {
    captured: 'when report was created',
    units: 'mm, mm/min, rpm, degrees',
    family: familyIds.includes(op.type) ? op.type : 'unavailable',
    passes: {
      stepdown: num(p?.stepdown), stepover: num(p?.stepover), finishStepover: num(p?.finishStepover),
      stockToLeave: num(p?.stockToLeave), floorStockToLeave: num(p?.floorStockToLeave),
      finishPasses: num(p?.finishPasses), springPasses: num(p?.springPasses), overlap: num(p?.overlapMm),
    },
    linking: {
      entryType: linkEnum(l?.entryType, ['plunge', 'ramp_linear', 'ramp_helical', 'arc']),
      rampAngle: num(l?.rampAngle), rampLength: num(l?.rampLength),
      leadInRadius: num(l?.leadInRadius), leadOutRadius: num(l?.leadOutRadius),
      retractType: linkEnum(l?.retractType, ['full', 'partial', 'minimum']),
      transitionType: linkEnum(l?.transitionType, ['safe_height', 'direct', 'avoid_stock']),
    },
    feeds: o?.enabled === true
      ? { source: 'operation override', values: {
        rpm: num(o.rpm), feed: num(o.feedRate), plunge: num(o.plungeRate), ramp: num(o.rampFeedrate),
        leadIn: num(o.leadInFeedrate), leadOut: num(o.leadOutFeedrate), fastTraverse: num(o.fastTraverseFeedrate), finish: num(o.finishFeedrate),
      } }
      : { source: 'tool preset (values not included)', values: null },
    tool: tool ? {
      type: TOOL_TYPE.test(String(tool.type)) ? String(tool.type) : 'unavailable',
      diameter: num(tool.diameter), fluteLength: num(tool.fluteLength), flutes: num(tool.numberOfFlutes),
      cornerRadius: num(tool.cornerRadius), angleFromAxis: num(tool.angleFromAxisDeg), tipDiameter: num(tool.tipDiameter),
    } : null,
    note: 'No part geometry or toolpath coordinates; may reveal machining methods and selected dimensions. Heights, stock and origin are not included.',
  }
}
