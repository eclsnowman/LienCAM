// cam3d DisposalRegistry lifecycle tests: fail-loud handle discipline.

import { describe, expect, it } from 'vitest';
import { DisposalRegistry } from '../../cam3d/kernel/registry';

type FakeResource = { label: string };

function makeRegistry(): {
  reg: DisposalRegistry<FakeResource>;
  destroyed: string[];
  add: (label: string) => number;
} {
  const reg = new DisposalRegistry<FakeResource>();
  const destroyed: string[] = [];
  const add = (label: string): number =>
    reg.register({ label }, (r) => destroyed.push(r.label), 'fake');
  return { reg, destroyed, add };
}

describe('DisposalRegistry', () => {
  it('register -> lookup returns the resource; dispose destroys it once', () => {
    const { reg, destroyed, add } = makeRegistry();
    const id = add('mesh-a');
    expect(reg.lookup(id).label).toBe('mesh-a');
    expect(reg.isLive(id)).toBe(true);
    expect(reg.liveCount).toBe(1);

    reg.dispose(id);
    expect(destroyed).toEqual(['mesh-a']);
    expect(reg.isLive(id)).toBe(false);
    expect(reg.liveCount).toBe(0);
  });

  it('issues distinct ids per registration', () => {
    const { reg, add } = makeRegistry();
    const a = add('a');
    const b = add('b');
    const c = add('c');
    expect(new Set([a, b, c]).size).toBe(3);
    expect(reg.liveCount).toBe(3);
  });

  it('double-dispose throws', () => {
    const { reg, destroyed, add } = makeRegistry();
    const id = add('cutter');
    reg.dispose(id);
    expect(() => reg.dispose(id)).toThrow(/double-dispose/);
    expect(destroyed).toEqual(['cutter']); // destroy ran exactly once
  });

  it('use-after-dispose lookup throws', () => {
    const { reg, add } = makeRegistry();
    const id = add('cutter');
    reg.dispose(id);
    expect(() => reg.lookup(id)).toThrow(/use-after-dispose/);
  });

  it('lookup and dispose of a never-registered id throw', () => {
    const { reg } = makeRegistry();
    expect(() => reg.lookup(9999)).toThrow(/unknown handle/);
    expect(() => reg.dispose(9999)).toThrow(/unknown handle/);
  });

  it('disposeAll destroys every live handle in id order and is safe to repeat', () => {
    const { reg, destroyed, add } = makeRegistry();
    add('a');
    const b = add('b');
    add('c');
    reg.dispose(b); // pre-dispose one; disposeAll must skip it
    reg.disposeAll();
    expect(destroyed).toEqual(['b', 'a', 'c']);
    expect(reg.liveCount).toBe(0);
    reg.disposeAll(); // no live handles: no-op, no throw
    expect(destroyed).toEqual(['b', 'a', 'c']);
    // Handles disposed via disposeAll behave exactly like singly-disposed ones.
    expect(() => reg.dispose(b)).toThrow(/double-dispose/);
  });

  it('a throwing destroy callback still retires the handle (no half-disposed state)', () => {
    const reg = new DisposalRegistry<FakeResource>();
    const id = reg.register(
      { label: 'bad' },
      () => {
        throw new Error('destroy exploded');
      },
      'fake',
    );
    expect(() => reg.dispose(id)).toThrow(/destroy exploded/);
    expect(() => reg.lookup(id)).toThrow(/use-after-dispose/);
    expect(() => reg.dispose(id)).toThrow(/double-dispose/);
  });
});
