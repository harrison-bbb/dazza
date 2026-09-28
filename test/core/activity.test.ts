import { describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../../src/core/activity.js';
import { makeTask } from '../fixtures.js';
import { useTempProject } from '../helpers.js';

describe('activity', () => {
  const project = useTempProject();

  it('records what a builder does, in plain words, per task', async () => {
    const recorder = new ActivityRecorder(project.store);
    const task = makeTask({ id: 'T3' });
    const agent = (event: object) => recorder.record({ type: 'agent', task, event } as never);
    await recorder.record({
      type: 'task_started',
      task,
      branch: 'b',
      resumed: false,
      dir: '/work/T3',
    });
    await agent({ type: 'text', text: 'Setting up   the editor.' });
    await agent({
      type: 'tool_use',
      id: '1',
      tool: 'Write',
      input: { file_path: '/work/T3/src/editor.ts' },
    });
    await agent({ type: 'tool_use', id: '2', tool: 'Bash', input: { command: 'npm test' } });
    await agent({
      type: 'tool_use',
      id: '3',
      tool: 'mcp__dazza__update_subtask',
      input: { id: 'T3.1', status: 'closed' },
    });
    await agent({ type: 'tool_use', id: '4', tool: 'TodoWrite', input: {} }); // plumbing: left out
    await recorder.record({ type: 'task_finished', task, outcome: 'review' });

    const log = await project.store.readActivity('T3');
    expect(log.map((e) => [e.kind, e.text])).toEqual([
      ['status', 'Started building'],
      ['say', 'Setting up the editor.'],
      ['do', 'Wrote src/editor.ts'],
      ['do', 'Ran npm test'],
      ['do', 'Finished T3.1'],
      ['status', 'Handed over for your review'],
    ]);
    expect(await project.store.readActivity('T3', 2)).toHaveLength(2);
    expect(await project.store.readActivity('../etc')).toEqual([]);
  });
});
