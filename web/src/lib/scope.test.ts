import { describe, expect, it } from 'vitest';
import type { Plan, Task } from './api';
import { planDocument, splitChangeLog } from './scope';

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  description: 'Do it.',
  acceptanceCriteria: ['The thing is done'],
  subtasks: [],
  dependsOn: [],
  status: 'planned',
  ...fields,
});

describe('the scope as a project plan', () => {
  const scope =
    '## Overview\nNotes.\n\n## Change log\n\n- **v2 · 2026-09-28**: Dropped sharing (T4). Why: not needed\n';

  it('keeps the change log apart from the part people edit', () => {
    expect(splitChangeLog(scope)).toEqual({
      body: '## Overview\nNotes.',
      log: '## Change log\n\n- **v2 · 2026-09-28**: Dropped sharing (T4). Why: not needed\n',
    });
    expect(splitChangeLog('## Overview\nNotes.\n')).toEqual({
      body: '## Overview\nNotes.',
      log: undefined,
    });
  });

  it('exports the scope, the deliverables with their criteria by milestone, and the change log', () => {
    const plan: Plan = {
      version: 1,
      approvedAt: null,
      tasks: [
        task('T1', {
          title: 'Setup',
          size: 'S',
          status: 'closed',
          acceptanceCriteria: ['It runs', 'Tests | pass'],
        }),
        task('T2', { title: 'Editor', size: 'M' }),
      ],
      milestones: [{ id: 'M1', title: 'Write', goal: 'You can write notes', tasks: ['T1', 'T2'] }],
    };
    const doc = planDocument('notes', scope, plan);
    expect(doc).toContain('# notes: scope of work');
    expect(doc).toContain(
      '## Deliverables and acceptance criteria\n\n### M1 Write\n\nYou can write notes',
    );
    expect(doc).toContain('| T1 Setup (S) | • It runs<br>• Tests \\| pass | Closed |');
    expect(doc).toContain('| T2 Editor (M) | • The thing is done | Planned |');
    expect(doc.indexOf('## Deliverables')).toBeLessThan(doc.indexOf('## Change log'));
  });
});
