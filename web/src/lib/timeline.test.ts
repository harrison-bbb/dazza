import { describe, expect, it } from 'vitest';
import type { Task } from './api';
import { criterionReport } from './timeline';

const task = (criteria: string[], reported: string[]): Task =>
  ({
    acceptanceCriteria: criteria,
    handoff: { criteria: reported.map((criterion) => ({ criterion, met: true, evidence: 'ok' })) },
  }) as unknown as Task;

describe('criterionReport', () => {
  it('matches evidence to its criterion by text, so edits don’t misattribute it', () => {
    // Reordered since the handoff: each still gets its own evidence.
    const reordered = task(['B', 'A'], ['A', 'B']);
    expect(criterionReport(reordered, 'B', 0)?.criterion).toBe('B');
    // A criterion added since has no evidence, rather than a neighbour's.
    expect(criterionReport(task(['A', 'New', 'B'], ['A', 'B']), 'New', 1)).toBeUndefined();
    // Reworded, with the list still lined up: the evidence was for that line.
    expect(criterionReport(task(['A, reworded'], ['A']), 'A, reworded', 0)?.criterion).toBe('A');
  });
});
