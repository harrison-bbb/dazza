import { describe, expect, it } from 'vitest';
import { footerText, modelLabel } from '../../src/chat/footer.js';
import { makePlan, makeTask } from '../fixtures.js';

describe('footerText', () => {
  it('says the model, the room left, and what’s waiting on the user', () => {
    const plan = makePlan([
      makeTask({ id: 'T1', status: 'review' }),
      makeTask({ id: 'T2', status: 'blocked' }),
      makeTask({ id: 'T3', status: 'blocked' }),
      makeTask({ id: 'T4', status: 'planned' }),
    ]);
    expect(
      footerText({
        model: 'Opus 5.5',
        context: { tokens: 76_000, window: 200_000 },
        plan,
        permissions: { T3: { command: 'psql', why: 'x' } },
      }),
    ).toBe(
      'Opus 5.5 · 62% context left · T1 to review · T3 asks to run a command · T2 needs you · ? for shortcuts',
    );
  });

  it('says only what it knows', () => {
    expect(footerText({ context: { window: 200_000 } })).toBe('? for shortcuts');
  });

  it('counts tasks when there are many', () => {
    const plan = makePlan(['T1', 'T2', 'T3'].map((id) => makeTask({ id, status: 'review' })));
    expect(footerText({ plan })).toBe('3 tasks to review · ? for shortcuts');
  });
});

describe('modelLabel', () => {
  it('names the model Default stands for', () => {
    expect(
      modelLabel({
        id: 'default',
        name: 'Default (recommended)',
        description: 'Opus 5.5 for complex work',
        autonomous: true,
      }),
    ).toBe('Opus 5.5');
    expect(
      modelLabel({ id: 'sonnet', name: 'Sonnet 5.5', description: 'Everyday', autonomous: true }),
    ).toBe('Sonnet 5.5');
    expect(
      modelLabel({
        id: 'default',
        name: 'Default',
        description: 'The recommended model',
        autonomous: true,
      }),
    ).toBe('Default');
  });
});
