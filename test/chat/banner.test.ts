import { describe, expect, it } from 'vitest';
import { banner } from '../../src/chat/banner.js';

describe('banner', () => {
  it('shows the logo with version, agent and directory underneath', () => {
    const lines = banner({ version: '1.2.3', agent: 'Claude Code', cwd: '~/app' }).split('\n');
    expect(lines[0]).toMatch(/^██████╗/);
    expect(lines.at(-1)).toBe('v1.2.3 · Claude Code · ~/app');
  });
});
