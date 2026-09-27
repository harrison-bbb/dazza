import type { Plan, Task } from '../src/core/schema.js';

export function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: `Task ${overrides.id}`,
    description: 'Do the thing.',
    acceptanceCriteria: ['The thing is done'],
    subtasks: [],
    dependsOn: [],
    status: 'todo',
    ...overrides,
  };
}

export function makePlan(tasks: Task[]): Plan {
  return { version: 1, approvedAt: null, tasks };
}
