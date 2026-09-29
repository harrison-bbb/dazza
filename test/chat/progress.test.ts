import { describe, expect, it } from 'vitest';
import { buildStatus, progressLine } from '../../src/chat/progress.js';
import type { TimeLeft } from '../../src/core/estimates.js';

const T0 = 1_000_000;
const left = (over: Partial<TimeLeft> = {}): TimeLeft => ({
  perTask: { T3: 12, T4: 20 },
  overdue: [],
  working: 32,
  wall: 32,
  at: T0,
  ...over,
});

describe('the build’s status line', () => {
  it('counts down the task, and the whole build when there’s more to come', () => {
    let now = T0;
    const status = buildStatus(['T3'], left(), () => now);
    expect(status()).toBe('Building T3 · ~12 min left · all built in ~32 min');
    now = T0 + 5 * 60_000;
    expect(status()).toBe('Building T3 · ~7 min left · all built in ~27 min');
  });

  it('says almost done, then that it’s running long, rather than going below zero', () => {
    let now = T0 + 11.5 * 60_000;
    const status = buildStatus(['T3'], left({ perTask: { T3: 12 } }), () => now);
    expect(status()).toBe('Building T3 · almost done');
    now = T0 + 30 * 60_000;
    expect(status()).toBe('Building T3 · almost done');
    const late = buildStatus(['T3'], left({ perTask: { T3: 1 }, overdue: ['T3'] }), () => T0);
    expect(late()).toBe('Building T3 · taking longer than usual');
  });

  it('names each task when two build side by side', () => {
    const status = buildStatus(['T3', 'T4'], left({ wall: 20 }), () => T0);
    expect(status()).toBe('Building T3 (~12 min left) and T4 (~20 min left)');
  });

  it('never says it’ll all be built before the task running now', () => {
    const status = buildStatus(['T4'], left({ wall: 5 }), () => T0);
    expect(status()).toBe('Building T4 · ~20 min left · all built in ~20 min');
  });

  it('gives no countdown for a task with no size, rather than a made-up one', () => {
    expect(buildStatus(['T9'], left(), () => T0)()).toBe('Building T9 · all built in ~32 min');
    expect(buildStatus(['T3', 'T9'], left(), () => T0)()).toBe(
      'Building T3 (~12 min left) and T9 · all built in ~32 min',
    );
  });

  it('falls back to plain words without an estimate, or between tasks', () => {
    expect(buildStatus(['T3'], undefined)()).toBe('Building T3');
    expect(buildStatus([], left())()).toBe('Looking for the next task');
  });
});

describe('progress for the phone', () => {
  it('says how far along it is, and how long is left', () => {
    expect(progressLine(3, 11, left({ wall: 95 }))).toBe(
      '3 of 11 built · about 1½ hours of building to go',
    );
    expect(progressLine(11, 11, left({ wall: 0 }))).toBeUndefined();
  });
});
