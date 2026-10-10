import { boolean, netArea, type Ring } from '../geom2d';
import type { RegionComponent } from './cutRegion';
import {
  describeAdaptiveComponent,
  type AdaptiveComponentPlan,
} from './orderComponents';

export interface AdaptiveDepthComponentPlan extends AdaptiveComponentPlan {
  readonly levelIndex: number;
  readonly z: number;
  readonly component: RegionComponent;
}

function componentRings(component: RegionComponent): Ring[] {
  return [component.boundary, ...component.holes];
}

export function componentsOverlap(
  upper: RegionComponent,
  lower: RegionComponent,
): boolean {
  const intersection = boolean(
    componentRings(upper),
    componentRings(lower),
    'intersect',
  );
  return intersection.length > 0 && netArea(intersection) > 1e-8;
}

export interface AdaptiveTerraceCandidate {
  readonly id: number;
  readonly z: number;
  readonly upperZ: number;
  readonly lowerLevelIndex: number;
  readonly component: RegionComponent;
}

export type AdaptiveDepthScheduleEvent<T extends AdaptiveDepthComponentPlan> =
  | { readonly kind: 'bulk'; readonly plan: T }
  | {
      readonly kind: 'terrace';
      readonly candidate: AdaptiveTerraceCandidate;
      readonly conservativeFallback: boolean;
    };

/**
 * Add terrace nodes between the full level that exposes them and overlapping
 * deeper work. Every edge advances through the rank
 * `bulk(level) -> terrace(level) -> bulk(level + 1)`, so the graph cannot cycle.
 * A split candidate waits only for the lower-plane components it overlaps. If
 * sampled geometry cannot classify any parent, it deliberately falls back to
 * every component on that populated lower plane.
 */
export function scheduleAdaptiveDepthBranchesWithTerraces<T extends AdaptiveDepthComponentPlan>(
  plans: readonly T[],
  terraces: readonly AdaptiveTerraceCandidate[],
  carriedCursor: Readonly<{ x: number; y: number }>,
): AdaptiveDepthScheduleEvent<T>[] {
  if (terraces.length === 0) {
    return scheduleAdaptiveDepthBranches(plans, carriedCursor).map(plan => ({ kind: 'bulk', plan }));
  }

  type Node =
    | { kind: 'bulk'; plan: T }
    | { kind: 'terrace'; candidate: AdaptiveTerraceCandidate; conservativeFallback: boolean };
  const bulkNodes = new Map<T, Node>();
  for (const plan of plans) bulkNodes.set(plan, { kind: 'bulk', plan });
  const nodes: Node[] = [...bulkNodes.values()];
  const byLevel = new Map<number, T[]>();
  for (const plan of plans) {
    const level = byLevel.get(plan.levelIndex);
    if (level) level.push(plan);
    else byLevel.set(plan.levelIndex, [plan]);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const parents = new Map<Node, Set<Node>>();
  const children = new Map<Node, Set<Node>>();
  const addNode = (node: Node): void => {
    nodes.push(node);
    parents.set(node, new Set());
    children.set(node, new Set());
  };
  for (const node of nodes) {
    parents.set(node, new Set());
    children.set(node, new Set());
  }
  const addEdge = (parent: Node, child: Node): void => {
    parents.get(child)!.add(parent);
    children.get(parent)!.add(child);
  };

  for (let li = 1; li < levels.length; li++) {
    const upper = byLevel.get(levels[li - 1])!;
    const lower = byLevel.get(levels[li])!;
    for (const child of lower) {
      const overlapping = upper.filter(parent => componentsOverlap(parent.component, child.component));
      for (const parent of overlapping.length > 0 ? overlapping : upper) {
        addEdge(bulkNodes.get(parent)!, bulkNodes.get(child)!);
      }
    }
  }

  for (const candidate of terraces) {
    const lowerPlans = byLevel.get(candidate.lowerLevelIndex) ?? [];
    const overlappingParents = lowerPlans.filter(plan =>
      componentsOverlap(plan.component, candidate.component));
    const conservativeFallback = overlappingParents.length === 0;
    const node: Node = { kind: 'terrace', candidate, conservativeFallback };
    addNode(node);
    for (const parent of conservativeFallback ? lowerPlans : overlappingParents) {
      addEdge(bulkNodes.get(parent)!, node);
    }

    const nextLevel = levels.find(level => level > candidate.lowerLevelIndex);
    for (const deeper of nextLevel === undefined ? [] : byLevel.get(nextLevel) ?? []) {
      if (componentsOverlap(candidate.component, deeper.component)) {
        addEdge(node, bulkNodes.get(deeper)!);
      }
    }
  }

  const done = new Set<Node>();
  const ordered: AdaptiveDepthScheduleEvent<T>[] = [];
  let current: Node | null = null;
  let cursor = Number.isFinite(carriedCursor.x) && Number.isFinite(carriedCursor.y)
    ? { x: carriedCursor.x, y: carriedCursor.y }
    : null;
  const pointOf = (node: Node): { x: number; y: number } => {
    if (node.kind === 'bulk') return describeAdaptiveComponent(node.plan).approach;
    return { x: node.candidate.component.boundary[0], y: node.candidate.component.boundary[1] };
  };

  while (ordered.length < nodes.length) {
    const eligible = nodes.filter(node =>
      !done.has(node) && [...parents.get(node)!].every(parent => done.has(parent)));
    if (eligible.length === 0) {
      throw new Error('scheduleAdaptiveDepthBranchesWithTerraces: dependency graph stalled.');
    }
    const direct: Node[] = current === null
      ? []
      : eligible.filter(node => children.get(current as Node)!.has(node));
    const candidates: Node[] = direct.length > 0 ? direct : eligible;
    candidates.sort((a, b) => {
      // Once a lower full component makes its terrace eligible, clean that
      // material before selecting an equally eligible deeper bulk child.
      if (a.kind !== b.kind) return a.kind === 'terrace' ? -1 : 1;
      const ap = pointOf(a);
      const bp = pointOf(b);
      const ad = cursor ? (ap.x - cursor.x) ** 2 + (ap.y - cursor.y) ** 2 : 0;
      const bd = cursor ? (bp.x - cursor.x) ** 2 + (bp.y - cursor.y) ** 2 : 0;
      if (Math.abs(ad - bd) > 1e-12) return ad - bd;
      if (a.kind === 'bulk' && b.kind === 'bulk') {
        return a.plan.levelIndex - b.plan.levelIndex || a.plan.originalIndex - b.plan.originalIndex;
      }
      if (a.kind === 'terrace' && b.kind === 'terrace') return a.candidate.id - b.candidate.id;
      return 0;
    });
    const selected: Node = candidates[0];
    done.add(selected);
    current = selected;
    if (selected.kind === 'bulk') {
      ordered.push({ kind: 'bulk', plan: selected.plan });
      cursor = describeAdaptiveComponent(selected.plan).terminal;
    } else {
      ordered.push({
        kind: 'terrace',
        candidate: selected.candidate,
        conservativeFallback: selected.conservativeFallback,
      });
      cursor = pointOf(selected);
    }
  }
  return ordered;
}

function distanceSquared(
  from: { x: number; y: number } | null,
  plan: AdaptiveDepthComponentPlan,
): number {
  if (from === null) return 0;
  const approach = describeAdaptiveComponent(plan).approach;
  return (approach.x - from.x) ** 2 + (approach.y - from.y) ** 2;
}

/**
 * Order a multi-level Adaptive component graph without changing any component
 * geometry. Positive-area overlap links an upper component to its lower
 * continuation. The scheduler follows one eligible continuation through depth
 * before relocating to a sibling branch. A merge waits for every overlapping
 * upper parent, and an unclassified lower component conservatively waits for
 * the complete preceding populated level.
 */
export function scheduleAdaptiveDepthBranches<T extends AdaptiveDepthComponentPlan>(
  plans: readonly T[],
  carriedCursor: Readonly<{ x: number; y: number }>,
): T[] {
  if (plans.length < 2) return [...plans];

  const byLevel = new Map<number, T[]>();
  for (const plan of plans) {
    const level = byLevel.get(plan.levelIndex);
    if (level) level.push(plan);
    else byLevel.set(plan.levelIndex, [plan]);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const parents = new Map<T, Set<T>>();
  const children = new Map<T, Set<T>>();
  for (const plan of plans) {
    parents.set(plan, new Set());
    children.set(plan, new Set());
  }

  for (let li = 1; li < levels.length; li++) {
    const upper = byLevel.get(levels[li - 1])!;
    const lower = byLevel.get(levels[li])!;
    for (const child of lower) {
      const overlapping = upper.filter(parent =>
        componentsOverlap(parent.component, child.component));
      const requiredParents = overlapping.length > 0 ? overlapping : upper;
      for (const parent of requiredParents) {
        parents.get(child)!.add(parent);
        children.get(parent)!.add(child);
      }
    }
  }

  const done = new Set<T>();
  const ordered: T[] = [];
  let current: T | null = null;
  let cursor = Number.isFinite(carriedCursor.x) && Number.isFinite(carriedCursor.y)
    ? { x: carriedCursor.x, y: carriedCursor.y }
    : null;

  while (ordered.length < plans.length) {
    const eligible = plans.filter(plan =>
      !done.has(plan) && [...parents.get(plan)!].every(parent => done.has(parent)));
    if (eligible.length === 0) {
      throw new Error('scheduleAdaptiveDepthBranches: component dependency graph stalled.');
    }

    const directChildren: T[] = current === null
      ? []
      : eligible.filter(plan => children.get(current!)!.has(plan));
    const candidates: T[] = directChildren.length > 0 ? directChildren : eligible;
    candidates.sort((a, b) => {
      const distanceDelta = distanceSquared(cursor, a) - distanceSquared(cursor, b);
      if (Math.abs(distanceDelta) > 1e-12) return distanceDelta;
      if (a.levelIndex !== b.levelIndex) return a.levelIndex - b.levelIndex;
      return a.originalIndex - b.originalIndex;
    });

    const selected = candidates[0];
    current = selected;
    ordered.push(selected);
    done.add(selected);
    cursor = describeAdaptiveComponent(selected).terminal;
  }

  return ordered;
}
