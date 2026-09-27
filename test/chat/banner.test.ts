import { describe, expect, it } from 'vitest';
import { logo, sessionInfo } from '../../src/chat/banner.js';

describe('banner', () => {
  it('draws the wordmark', () => {
    expect(logo().split('\n')[0]).toMatch(/^██████╗/);
  });

  it('shows version, agent, directory and board link', () => {
    const lines = sessionInfo({
      version: '1.2.3',
      agent: 'Claude Code',
      cwd: '~/app',
      board: 'http://localhost:4777',
    }).split('\n');
    expect(lines).toEqual(['v1.2.3 · Claude Code · ~/app', 'Board http://localhost:4777']);
  });
});
