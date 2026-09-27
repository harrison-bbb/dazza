import { describe, expect, it } from 'vitest';
import { banner } from '../../src/chat/banner.js';

describe('banner', () => {
  it('shows the logo alongside version, agent and directory', () => {
    const lines = banner({ version: '1.2.3', agent: 'Claude Code', cwd: '~/app' }).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Dazza v1.2.3');
    expect(lines[1]).toContain('Claude Code');
    expect(lines[2]).toContain('~/app');
  });
});
