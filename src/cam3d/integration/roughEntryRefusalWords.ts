// WO-2869: a 3D Rough that cannot enter a region says so in machinist words.
//
// The engine refuses a straight plunge into solid stock (ADR-0003) with text
// written for engine tests (function name, cell counts, "adaptive cleanup").
// That text reached the operator's op status verbatim. Here the same fields
// become: where (the level, by depth below the stock top, and which part of
// the part), why (the helix the space allows against the smallest one cut),
// and the settings that change the outcome. The operation stays refused - the
// region truly cannot be entered with this tool and scope.
import { textFor } from '../../i18n';
import type { PartMesh } from '../kernel/types';
import { parseStraightPlungeRefusal } from '../rough/entryRefusal';

const tx = textFor('cam-operations-new-operation');

export interface RoughEntryRefusalContext {
  toolDiameter: number;
  /** Stock top in the part-mesh frame (the level depth is measured from it). */
  stockTopZ: number;
  partBounds: PartMesh['bounds'];
  /** True when the whole stock is being cleared (side entry in use). */
  clearsAllStock: boolean;
  /**
   * True when Roughing scope is set to "Clear all stock". The store can still
   * fall back to clearing around the part (rotated part, shared stock, no stock
   * footprint), and then naming the scope again would be advice that cannot work.
   */
  clearAllStockRequested?: boolean;
}

/** mm with at most two decimals and no trailing zeros. */
function mm(value: number): string {
  return String(Number(value.toFixed(2)));
}

function placeOnPart(x: number, y: number, bounds: PartMesh['bounds']): string {
  const axis = (v: number, lo: number, hi: number, plus: string, minus: string): string | undefined => {
    const half = (hi - lo) / 2;
    const offset = v - (lo + hi) / 2;
    if (!(half > 0) || Math.abs(offset) <= half / 3) return undefined;
    return offset > 0 ? plus : minus;
  };
  const sx = axis(x, bounds.min[0], bounds.max[0], 'X+', 'X-');
  const sy = axis(y, bounds.min[1], bounds.max[1], 'Y+', 'Y-');
  if (sx && sy) return tx('RoughEntryRefusal.place_corner', { x: sx, y: sy });
  const side = sx ?? sy;
  if (side) return tx('RoughEntryRefusal.place_side', { side });
  return tx('RoughEntryRefusal.place_middle');
}

/**
 * The operator's words for an engine straight-plunge refusal, or undefined
 * when `message` is some other error (which then passes through unchanged).
 */
export function roughEntryRefusalWords(message: string, ctx: RoughEntryRefusalContext): string | undefined {
  const refusal = parseStraightPlungeRefusal(message);
  if (!refusal) return undefined;
  const common = {
    depth: mm(Math.max(0, ctx.stockTopZ - refusal.toZ)),
    place: placeOnPart(refusal.x, refusal.y, ctx.partBounds),
    tool: mm(ctx.toolDiameter),
  };
  const why = refusal.where.kind === 'region' && refusal.where.helixRadius > 0
    ? tx('RoughEntryRefusal.region', {
        ...common,
        fits: mm(Math.max(0, refusal.where.helixRadius) * 2),
        min: mm(refusal.where.minHelixRadius * 2),
      })
    : tx('RoughEntryRefusal.landing', common);
  const remedy = ctx.clearsAllStock
    ? tx('RoughEntryRefusal.remedy_tool')
    : ctx.clearAllStockRequested
      ? tx('RoughEntryRefusal.remedy_scope_unavailable')
      : tx('RoughEntryRefusal.remedy_scope_or_tool');
  return `${why} ${remedy}`;
}
