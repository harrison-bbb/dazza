import { describe, expect, it } from 'vitest';
import { banner } from '../../src/chat/banner.js';

describe('banner', () => {
  it('shows the logo with version, agent and directory underneath', () => {
    const lines = banner({
      version: '1.2.3',
      agent: 'Claude Code',
      cwd: '~/app',
      board: 'http://localhost:4777',
    }).split('\n');
    expect(lines[0]).toMatch(/^██████╗/);
    expect(lines.at(-2)).toBe('v1.2.3 · Claude Code · ~/app');
    expect(lines.at(-1)).toBe('Board http://localhost:4777');
  });
});
