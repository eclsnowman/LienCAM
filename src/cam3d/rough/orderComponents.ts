import type { AdaptivePass, EnginePt } from './engineEntry';

export interface AdaptiveComponentPlan {
  readonly originalIndex: number;
  readonly passes: readonly AdaptivePass[];
}

export interface AdaptiveComponentEndpoints {
  readonly approach: EnginePt;
  readonly terminal: EnginePt;
}

function fail(message: string): never {
  throw new Error(`orderAdaptiveComponents: ${message}`);
}

function finitePoint(point: EnginePt, label: string): EnginePt {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    fail(`${label} must be finite, got (${point.x}, ${point.y})`);
  }
  return point;
}

function lastPoint(points: readonly EnginePt[]): EnginePt | null {
  return points.length > 0 ? points[points.length - 1] : null;
}

export function describeAdaptiveComponent(
  component: AdaptiveComponentPlan,
): AdaptiveComponentEndpoints {
  const { passes, originalIndex } = component;
  if (passes.length === 0) fail(`component ${originalIndex} has no passes`);

  let entryIndex = 0;
  if (passes[0].type === 'link' && passes[1]?.type === 'entry') entryIndex = 1;
  const entry = passes[entryIndex];
  if (entry.type !== 'entry') {
    fail(`component ${originalIndex} does not begin with an entry-owned approach`);
  }
  const approachPoint = entry.mode === 'side' ? entry.clearPoint : entry.point;
  if (!approachPoint) {
    fail(`component ${originalIndex} side entry has no fully-clear approach point`);
  }
  const approach = finitePoint(approachPoint, `component ${originalIndex} approach`);

  let terminal: EnginePt | null = null;
  for (let i = passes.length - 1; i >= 0 && terminal === null; i--) {
    const pass = passes[i];
    switch (pass.type) {
      case 'entry':
        if (pass.mode === 'helix') {
          fail(`component ${originalIndex} ends with a helix entry and no emitted terminal`);
        }
        terminal = pass.point;
        break;
      case 'link':
        terminal = pass.points[1];
        break;
      case 'cut':
      case 'lead':
      case 'wallfollow':
      case 'loopback':
      case 'finish':
        terminal = lastPoint(pass.points);
        break;
      default: {
        const _never: never = pass;
        fail(`component ${originalIndex} has unknown pass type ${(_never as AdaptivePass).type}`);
      }
    }
  }
  if (terminal === null) fail(`component ${originalIndex} has no emitted terminal`);

  return {
    approach,
    terminal: finitePoint(terminal, `component ${originalIndex} terminal`),
  };
}

/**
 * Deterministic nearest-next ordering of complete component pass blocks.
 * Distance ties resolve by the original component index.
 */
export function orderAdaptiveComponents<T extends AdaptiveComponentPlan>(
  components: readonly T[],
  carriedCursor: Readonly<EnginePt>,
): T[] {
  const seen = new Set<number>();
  const remaining = components.map((component) => {
    if (!Number.isInteger(component.originalIndex) || component.originalIndex < 0) {
      fail(`invalid original index ${component.originalIndex}`);
    }
    if (seen.has(component.originalIndex)) {
      fail(`duplicate original index ${component.originalIndex}`);
    }
    seen.add(component.originalIndex);
    return { component, endpoints: describeAdaptiveComponent(component) };
  });

  const ordered: T[] = [];
  let cursor: EnginePt | null = Number.isFinite(carriedCursor.x) && Number.isFinite(carriedCursor.y)
    ? { x: carriedCursor.x, y: carriedCursor.y }
    : null;

  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const distance = cursor === null
        ? 0
        : (candidate.endpoints.approach.x - cursor.x) ** 2 +
          (candidate.endpoints.approach.y - cursor.y) ** 2;
      const incumbent = remaining[best];
      if (
        (cursor === null && candidate.component.originalIndex < incumbent.component.originalIndex) ||
        (cursor !== null && (
          distance < bestDistance ||
          (distance === bestDistance && candidate.component.originalIndex < incumbent.component.originalIndex)
        ))
      ) {
        best = i;
        bestDistance = distance;
      }
    }

    const [selected] = remaining.splice(best, 1);
    ordered.push(selected.component);
    cursor = selected.endpoints.terminal;
  }

  return ordered;
}
