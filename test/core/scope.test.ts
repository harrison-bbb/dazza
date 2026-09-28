import { describe, expect, it } from 'vitest';
import { changeLogEntries, keepChangeLog, withChangeLog } from '../../src/core/scope.js';

const on = new Date(2026, 8, 28, 10); // local time

describe('the scope’s change log', () => {
  it('numbers changes from v2 (the plan was v1), newest first', () => {
    const v2 = withChangeLog(
      '## Overview\nTodos.',
      '## Overview\nTodos.',
      {
        summary: 'Magic links instead of passwords',
        why: 'Fewer support tickets.',
        tasks: ['T2', 'T9'],
      },
      on,
    );
    expect(v2).toBe(
      '## Overview\nTodos.\n\n## Change log\n\n- **v2 · 2026-09-28**: Magic links instead of passwords (T2, T9). Why: Fewer support tickets\n',
    );
    const v3 = withChangeLog(
      '## Overview\nTodos, shared.',
      v2,
      { summary: 'Drop sharing', why: 'Not needed', tasks: ['T5'] },
      on,
    );
    expect(changeLogEntries(v3)).toEqual([
      '- **v3 · 2026-09-28**: Drop sharing (T5). Why: Not needed',
      '- **v2 · 2026-09-28**: Magic links instead of passwords (T2, T9). Why: Fewer support tickets',
    ]);
    expect(v3.startsWith('## Overview\nTodos, shared.')).toBe(true);
  });

  it('can’t be dropped or rewritten by a new version of the scope', () => {
    const logged = withChangeLog(
      '## Overview\nA',
      undefined,
      { summary: 'X', why: 'Y', tasks: [] },
      on,
    );
    const tampered = '## Overview\nB\n\n## Change log\n\n- **v9**: never happened';
    expect(changeLogEntries(keepChangeLog(tampered, logged))).toEqual(changeLogEntries(logged));
    expect(keepChangeLog('## Overview\nB', undefined)).toBe('## Overview\nB\n');
  });
});
