// VoxelSimulator — a thin voxel analogue of HeightmapSimulator (ADR-0028).
//
// This is the simulation-side driver that SimulationPanel will use in place of
// HeightmapSimulator once the voxel engine is wired in. It owns a VoxelField
// (the dense CPU SDF storage), seeds it as solid stock, and carves swept tool
// volumes into it. It is GL-FREE and pure: NO Three.js, NO WebGL, NO DOM. The
// raymarch render path (Data3DTexture upload) is a SEPARATE later item that will
// read field.data / field.dirty.
//
// ── angle convention (see docs/tool_angle_conventions.md) ─────────────────────
//
// The canonical stored field is Tool.angleFromAxisDeg = the HALF-ANGLE measured
// from the tool axis (per side), in degrees. It is ALREADY halved, so NO site may
// divide it again. carve.ts toolProfile consumes it directly via tan(angle).
//
// Resolution for THIS module: VoxelSimTool.angleFromAxisDeg mirrors the app Tool's
// angleFromAxisDeg one-to-one. toolShapeFromTool passes it straight through with no
// conversion; carve.ts uses tan(angleFromAxisDeg) directly (no halving).

import { VoxelField, planVoxelGrid, type StockBounds } from './voxel/VoxelField'
import { carveSweep, initSolidStock, type ToolShape } from './voxel/carve'
import { buildToolProfile } from '../tool/toolProfile'
import type { Tool, ToolType } from '../../types'

/**
 * Minimal app-tool shape this simulator consumes. `angleFromAxisDeg` is the
 * half-angle measured from the tool axis (degrees) — see the convention note above.
 * Mirrors the relevant fields of the project `Tool` (type / diameter / cornerRadius /
 * angleFromAxisDeg) and SimulationPanel's ToolGeoCfg, so either can be passed.
 *
 * The geometry fields below (fluteLength / shankDiameter / overallLength /
 * shoulderLength / tipDiameter / neckDiameter) are what buildToolProfile needs to
 * derive the single-source-of-truth profile. When fluteLength + overallLength are
 * present, toolShapeFromTool builds that profile and threads it onto ToolShape so
 * EVERY tool type carves a real cutting shape. When they are absent (a minimal
 * shape, e.g. a unit test), no profile is built and carve.ts falls back to the
 * legacy per-type analytic switch.
 */
export interface VoxelSimTool {
  type: string
  diameter: number
  cornerRadius?: number
  angleFromAxisDeg?: number // half-angle from tool axis (per side)
  fluteLength?: number
  shankDiameter?: number
  overallLength?: number
  shoulderLength?: number
  tipDiameter?: number
  neckDiameter?: number
  // Thread-mill teeth (WO-1965). Without them buildToolProfile draws a thread
  // mill as a plain cylinder and the simulated hole shows no thread.
  threadPitch?: number
  threadTeethCount?: number
  threadFormAngleDeg?: number
  neckTransitionAngleDeg?: number
}

/** Map a library Tool to the voxel sim's tool, forwarding every carve field. */
export function voxelSimToolFromTool(tool: Tool): VoxelSimTool {
  return {
    type: tool.type,
    diameter: tool.diameter,
    cornerRadius: tool.cornerRadius,
    angleFromAxisDeg: tool.angleFromAxisDeg,
    fluteLength: tool.fluteLength,
    shankDiameter: tool.shankDiameter,
    overallLength: tool.overallLength,
    shoulderLength: tool.shoulderLength,
    tipDiameter: tool.tipDiameter,
    neckDiameter: tool.neckDiameter,
    threadPitch: tool.threadPitch,
    threadTeethCount: tool.threadTeethCount,
    threadFormAngleDeg: tool.threadFormAngleDeg,
    neckTransitionAngleDeg: tool.neckTransitionAngleDeg,
  }
}

/**
 * Map an app Tool (or ToolGeoCfg-like) to the carve ToolShape.
 *
 *   radius      = diameter / 2
 *   cornerRadius     -> passed through (bull-nose corner radius, mm)
 *   angleFromAxisDeg -> passed through UNCHANGED (already the per-side half-angle);
 *                       carve.ts toolProfile uses tan(angleFromAxisDeg) directly.
 *   profile          -> buildToolProfile(t) when the full geometry is present, so
 *                       carve derives the bottom surface from the ONE shared
 *                       source of truth (replaces the old per-type sim switch).
 */
export function toolShapeFromTool(t: VoxelSimTool): ToolShape {
  const shape: ToolShape = {
    type: t.type,
    radius: t.diameter / 2,
    cornerRadius: t.cornerRadius,
    angleFromAxisDeg: t.angleFromAxisDeg,
  }
  // Build the source-of-truth profile when we have enough geometry. A minimal
  // VoxelSimTool (test fixture) lacks fluteLength/overallLength -> no profile ->
  // carve.ts uses the legacy analytic switch (byte-stable for the legacy types).
  if (t.fluteLength != null && t.overallLength != null) {
    const tool: Tool = {
      id: '',
      name: '',
      type: t.type as ToolType,
      diameter: t.diameter,
      fluteLength: t.fluteLength,
      shankDiameter: t.shankDiameter ?? t.diameter,
      overallLength: t.overallLength,
      shoulderLength: t.shoulderLength,
      numberOfFlutes: 0,
      cornerRadius: t.cornerRadius,
      angleFromAxisDeg: t.angleFromAxisDeg,
      tipDiameter: t.tipDiameter,
      neckDiameter: t.neckDiameter,
      threadPitch: t.threadPitch,
      threadTeethCount: t.threadTeethCount,
      threadFormAngleDeg: t.threadFormAngleDeg,
      neckTransitionAngleDeg: t.neckTransitionAngleDeg,
      material: 'carbide',
      coating: 'none',
      notes: '',
      feedsAndSpeeds: {},
    }
    shape.profile = buildToolProfile(tool)
  }
  return shape
}

/**
 * Cells per thread pitch the grid needs to show a thread (WO-1965). Measured on
 * an M8 x 1.25 internal thread, groove depth read in a section on both walls:
 * 6 cells per pitch reads 85-88% of the depth at the exact pitch; 5 dips to 69%
 * on one wall; 8 reads 95% at 2.3x the carve time of 6; the 0.5 mm default
 * (2.5 cells) aliases the roots to 1.0 / 1.5 mm spacings at under half depth.
 */
export const THREAD_CELLS_PER_PITCH = 6

/**
 * The voxel size a job needs: the operator's requested size, made finer when a
 * thread mill in the job cuts a pitch the requested size cannot resolve. Tools
 * without thread teeth never change it.
 */
export function voxelSizeForTools(requestedVoxelSize: number, tools: readonly VoxelSimTool[]): number {
  let size = requestedVoxelSize
  for (const t of tools) {
    const pitch = t.threadPitch
    if (pitch != null && pitch > 0) size = Math.min(size, pitch / THREAD_CELLS_PER_PITCH)
  }
  return size
}

export class VoxelSimulator {
  readonly field: VoxelField
  /** Narrow-band half-width in mm (3 voxels), shared by init + every carve. */
  readonly band: number
  /**
   * True when the grid is coarser than the operator's requested voxel size
   * because it had to fit the budget. The caller MUST surface this to the user
   * (ADR-0003: no silent fallback).
   */
  readonly coarsened: boolean
  /** Nominal (pre-padding) stock AABB — reused by reset() so rewind matches init. */
  private readonly bounds: StockBounds

  /**
   * @param bounds             world-mm stock AABB
   * @param requestedVoxelSize voxel size (mm) from the UI resolution setting
   * @param maxVoxels          total-cell budget; grid coarsens to fit it
   * @param tools              the job's tools; a thread mill refines the grid
   *                           so its thread shows (voxelSizeForTools, WO-1965)
   */
  constructor(
    bounds: StockBounds,
    requestedVoxelSize: number,
    maxVoxels: number,
    tools: readonly VoxelSimTool[] = [],
  ) {
    const jobVoxelSize = voxelSizeForTools(requestedVoxelSize, tools)
    let plan = planVoxelGrid(bounds, jobVoxelSize, maxVoxels)
    // A refined grid the budget pushes past the operator's size is no better
    // than that size: plan the requested one, so the tool list never makes the
    // grid coarser.
    if (jobVoxelSize < requestedVoxelSize && plan.dims.voxelSize > requestedVoxelSize) {
      plan = planVoxelGrid(bounds, requestedVoxelSize, maxVoxels)
    }
    this.coarsened = plan.coarsened && plan.dims.voxelSize > requestedVoxelSize
    this.field = new VoxelField(plan.dims)
    this.band = 3 * plan.dims.voxelSize
    this.bounds = bounds
    initSolidStock(this.field, this.band, this.bounds)
  }

  /** Carve a linear move of the tool TIP from `from` to `to` (world mm). */
  sweepMove(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    tool: VoxelSimTool,
  ): void {
    carveSweep(this.field, from, to, toolShapeFromTool(tool), this.band)
  }

  /** Copy of the field data — per-op baseline / seek-backward snapshot. */
  snapshot(): Float32Array {
    return this.field.snapshot()
  }

  /** Restore a previously taken snapshot (fails loud on length mismatch). */
  restore(snap: Float32Array): void {
    this.field.restore(snap)
  }

  /** Re-initialize the field to solid stock (drops all carved material). */
  reset(): void {
    initSolidStock(this.field, this.band, this.bounds)
  }
}
