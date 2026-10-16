// cam3d rough: EXTERIOR ENVELOPE check -- does a proposed descent, cut, link
// and step-up clear with the WHOLE tool assembly (WO-2786, step 2 of the
// outside-in roughing proposal on wo/WO-2654, "Later increments" item 2).
//
// READ-ONLY. Nothing calls this yet except its tests (step 3, the new rough
// strategy, will). It never writes the field, never consumes planned removals
// (each segment is judged against the live field as given, so a link back
// through material an earlier segment of the same candidate WOULD cut is a
// collision), and changes no toolpath, default job, warning or refusal.
//
// Step 1 (exteriorAccess.ts) says which band material the cutter TIP can reach
// from outside air at one plane. That is not enough: a clear tip disc says
// nothing about the flutes above it, the neck, the shank, the holder or the
// clamps. This module asks the one collision implementation in the app
// (lib/cam/holderClearance.ts, checkAssemblyEnvelopeSweep) to judge each
// segment of the proposed motion with the actual tool profile, the explicit
// holder, the protected part, the workholding and the live stock:
//  - 'descent' and 'cut' are cutting moves: the cutting portion may meet stock
//    (that is removal, reported as removesStock);
//  - 'link' and 'step-up' cut nothing: any contact, the cutter's included, is a
//    collision (holderClearance's contact-is-collision policy). The one
//    exception is the cutter's tip resting on the floor it stands on (within
//    1e-3 mm, the f32 noise traverseSafety also absorbs), so a step-up can
//    leave a floor and a link can run along one;
//  - neck, shank and holder contact with stock, part or workholding is ALWAYS a
//    collision and never counts as removal.
//
// UNRESOLVED, never assumed clear. Whole-candidate reasons (nothing is judged):
//  - no-full-stock-proof: the field may be part-bounds/fallback stock whose
//    edge is not open air, so motion outside it is not known clear;
//  - frame-unproven: candidate and obstacles are not proved in one frame;
//  - part-missing: no protected part geometry;
//  - workholding-incomplete: fixtures unknown or unreadable;
//  - candidate-invalid: no segments, or an unknown role.
// Per-segment reasons come from holderClearance (missing/invalid holder,
// stickout, tool profile, obstacle columns, coordinates, allowances). A
// segment with a proven contact is a collision even when its holder is
// unknown: what is known already hits.
//
// STALENESS. Every result carries the caller's stock revision and the field
// digest exteriorAccess binds its results with.
//
// PURE + DETERMINISTIC (D-006): fixed order, no RNG, no time.

import type { Tool, ToolHolder } from '../../types';
import {
  checkAssemblyEnvelopeSweep,
  type AssemblyEnvelopeUnresolved,
  type ReachBlocker,
  type ReachPoint,
  type SolidColumns,
} from '../../lib/cam/holderClearance';
import type { ZDexelField } from '../stock';
import { digestField } from './exteriorAccess';

export type EnvelopeMoveRole = 'descent' | 'cut' | 'link' | 'step-up';

/** Roles whose cutting portion is meant to meet stock. */
const CUTTING_ROLES: ReadonlySet<EnvelopeMoveRole> = new Set(['descent', 'cut']);
const ROLES: ReadonlySet<string> = new Set(['descent', 'cut', 'link', 'step-up']);

export interface EnvelopeSegment {
  role: EnvelopeMoveRole;
  /** Tool tip at the start and end of a LINEAR move, in the field's frame. */
  from: ReachPoint;
  to: ReachPoint;
}

export type EnvelopeVerdict = 'clear' | 'collision' | 'unresolved';

export type ExteriorEnvelopeUnresolvedReason =
  | 'no-full-stock-proof'
  | 'frame-unproven'
  | 'part-missing'
  | 'workholding-incomplete'
  | 'candidate-invalid'
  | AssemblyEnvelopeUnresolved;

export type EnvelopeWorkholding =
  | { status: 'complete'; columns: readonly SolidColumns[] }
  | { status: 'unreadable' | 'unknown' };

export interface ExteriorEnvelopeInput {
  /** The live stock field (never mutated). */
  field: ZDexelField;
  /** Caller-owned revision of `field`; the result is bound to it. */
  stockRevision: number;
  /** True only when the field is proven full stock (its edge is open air). */
  fullStockProof: boolean;
  /** 'world' only when segments, field, part and fixtures share one frame. */
  frame: 'world' | 'mismatched' | 'unknown';
  tool: Tool;
  /** The tool's explicit holder; absent = unknown, never assumed clear. */
  holder?: ToolHolder;
  /** The protected part as column spans. */
  part?: SolidColumns;
  workholding: EnvelopeWorkholding;
  /** Clearance kept by neck/shank/holder from part and stock, and by every
   *  component from the workholding, mm. */
  allowanceMm: number;
  /** Clearance the cutting portion keeps from the part (stock to leave), mm. */
  partAllowanceMm: number;
  segments: readonly EnvelopeSegment[];
}

export interface EnvelopeSegmentResult {
  index: number;
  role: EnvelopeMoveRole;
  verdict: EnvelopeVerdict;
  /** Set exactly when verdict === 'unresolved'. */
  reason?: AssemblyEnvelopeUnresolved;
  collisions: readonly ReachBlocker[];
  /** The cutting portion meets stock on a cutting role. Never non-cutting contact. */
  removesStock: boolean;
}

export interface ExteriorEnvelopeResult {
  /** collision if any segment collides, else unresolved if any is, else clear. */
  verdict: EnvelopeVerdict;
  /** Whole-candidate reason, or the first unresolved segment's reason. */
  reason?: ExteriorEnvelopeUnresolvedReason;
  stockRevision: number;
  fieldDigest: string;
  /** Empty when a whole-candidate reason stopped the check. */
  segments: readonly EnvelopeSegmentResult[];
}

/** The z-dexel's one [bottom, top] interval per column as solid spans. */
export function stockSolidColumns(field: ZDexelField): SolidColumns {
  const { nx, ny, originX, originY, cell, top, bottom } = field;
  const n = nx * ny;
  const spanStart = new Uint32Array(n + 1);
  let spans = 0;
  for (let c = 0; c < n; c++) {
    spanStart[c] = 2 * spans;
    if (top[c] > bottom[c]) spans++;
  }
  spanStart[n] = 2 * spans;
  const spanZ = new Float64Array(2 * spans);
  for (let c = 0; c < n; c++) {
    if (spanStart[c + 1] === spanStart[c]) continue;
    spanZ[spanStart[c]] = bottom[c];
    spanZ[spanStart[c] + 1] = top[c];
  }
  return { originX, originY, cell, nx, ny, spanStart, spanZ };
}

/** Judge every segment of one proposed candidate with the whole assembly. */
export function checkExteriorEnvelope(input: ExteriorEnvelopeInput): ExteriorEnvelopeResult {
  const { field, stockRevision, segments, part, workholding } = input;
  const head = { stockRevision, fieldDigest: digestField(field) };
  const stop = (reason: ExteriorEnvelopeUnresolvedReason): ExteriorEnvelopeResult => ({
    verdict: 'unresolved', reason, ...head, segments: [],
  });
  if (!input.fullStockProof) return stop('no-full-stock-proof');
  if (input.frame !== 'world') return stop('frame-unproven');
  if (!part) return stop('part-missing');
  if (workholding.status !== 'complete') return stop('workholding-incomplete');
  if (segments.length === 0 || segments.some(s => !ROLES.has(s.role))) return stop('candidate-invalid');

  const stock = stockSolidColumns(field);
  const results: EnvelopeSegmentResult[] = segments.map((segment, index) => {
    const report = checkAssemblyEnvelopeSweep({
      from: segment.from,
      to: segment.to,
      tool: input.tool,
      holder: input.holder,
      stock,
      part,
      workholding: workholding.columns,
      cutsStock: CUTTING_ROLES.has(segment.role),
      allowanceMm: input.allowanceMm,
      partAllowanceMm: input.partAllowanceMm,
    });
    return {
      index,
      role: segment.role,
      verdict: report.status,
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
      collisions: report.collisions,
      removesStock: report.removesStock,
    };
  });
  const firstUnresolved = results.find(r => r.verdict === 'unresolved');
  const verdict: EnvelopeVerdict = results.some(r => r.verdict === 'collision') ? 'collision'
    : firstUnresolved ? 'unresolved' : 'clear';
  return {
    verdict,
    ...(verdict === 'unresolved' ? { reason: firstUnresolved!.reason } : {}),
    ...head,
    segments: results,
  };
}
