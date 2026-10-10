// viewport3d SelectionState: hover vs selection precedence + events (AC3).

import { describe, expect, it, vi } from 'vitest';
import { SelectionState } from '../../viewport3d/SelectionState';

describe('SelectionState', () => {
  it('hover and selection are distinct: hovering does not select, selecting does not hover', () => {
    const state = new SelectionState();
    state.setHover('F1');
    expect(state.hovered).toBe('F1');
    expect(state.isSelected('F1')).toBe(false);
    expect(state.highlightFor('F1')).toBe('hovered');

    state.select('F2');
    expect(state.isSelected('F2')).toBe(true);
    expect(state.hovered).toBe('F1'); // unaffected by selection
    expect(state.highlightFor('F2')).toBe('selected');
    expect(state.highlightFor('F1')).toBe('hovered');
  });

  it('precedence is deterministic: a selected id reads selected even while hovered', () => {
    const state = new SelectionState();
    state.select('F1');
    state.setHover('F1');
    expect(state.highlightFor('F1')).toBe('selected');

    // Order independence: hover first, then select -- same result.
    const state2 = new SelectionState();
    state2.setHover('F1');
    state2.select('F1');
    expect(state2.highlightFor('F1')).toBe('selected');
  });

  it('an id that is neither hovered nor selected reads none', () => {
    const state = new SelectionState();
    state.setHover('F1');
    state.select('F2');
    expect(state.highlightFor('F3')).toBe('none');
  });

  it('toggleSelection adds/removes without touching other selected ids', () => {
    const state = new SelectionState();
    state.addToSelection('F1');
    state.addToSelection('F2');
    state.toggleSelection('F1');
    expect(state.isSelected('F1')).toBe(false);
    expect(state.isSelected('F2')).toBe(true);
    state.toggleSelection('F1');
    expect(state.isSelected('F1')).toBe(true);
    expect(state.selection.size).toBe(2);
  });

  it('select() replaces a multi-selection with exactly one id', () => {
    const state = new SelectionState();
    state.addToSelection('F1');
    state.addToSelection('F2');
    state.select('F3');
    expect([...state.selection]).toEqual(['F3']);
  });

  it('clearSelection empties the selection and leaves hover untouched', () => {
    const state = new SelectionState();
    state.setHover('F1');
    state.addToSelection('F2');
    state.clearSelection();
    expect(state.selection.size).toBe(0);
    expect(state.hovered).toBe('F1');
  });

  it('state changes surface via subscribe() callbacks, not direct property polling', () => {
    const state = new SelectionState();
    const events: Array<{ type: string; hovered: string | null; selectedSize: number }> = [];
    const unsubscribe = state.subscribe((e) => {
      events.push({ type: e.type, hovered: e.hovered, selectedSize: e.selected.size });
    });

    state.setHover('F1');
    state.select('F2');
    state.clearSelection();

    expect(events).toEqual([
      { type: 'hover', hovered: 'F1', selectedSize: 0 },
      { type: 'select', hovered: 'F1', selectedSize: 1 },
      { type: 'select', hovered: 'F1', selectedSize: 0 },
    ]);

    unsubscribe();
    state.setHover('F3');
    expect(events.length).toBe(3); // no more events after unsubscribe
  });

  it('redundant sets are no-ops: no duplicate events for an unchanged hover/selection', () => {
    const state = new SelectionState();
    const listener = vi.fn();
    state.subscribe(listener);

    state.setHover('F1');
    state.setHover('F1'); // no change
    state.select('F2');
    state.select('F2'); // no change (already exactly {F2})

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
