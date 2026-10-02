import { describe, expect, it } from 'vitest';
import { link, logo, sessionInfo, shortPath } from '../../src/chat/banner.js';
import { stripAnsi } from '../../src/chat/style.js';

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
    expect(lines).toEqual([
      'v1.2.3 · Claude Code · ~/app',
      'Board http://localhost:4777 · /dashboard opens it',
    ]);
  });

  it('puts the name on the header line after the first launch, and links the board where it can', () => {
    const info = sessionInfo({
      version: '1.2.3',
      agent: 'Claude Code',
      cwd: '~/app',
      board: 'http://localhost:4777/?t=secret',
      compact: true,
      hyperlinks: true,
    });
    expect(stripAnsi(info).split('\n')).toEqual([
      'Dazza v1.2.3 · Claude Code · ~/app',
      'Board localhost:4777 · /dashboard opens it',
    ]);
    expect(info).toContain(link('http://localhost:4777/?t=secret', 'localhost:4777'));
  });

  it('shortens the folder: ~ for home, and the last two folders when it’s long', () => {
    expect(shortPath('/Users/sam/code/app', '/Users/sam')).toBe('~/code/app');
    expect(shortPath('/Users/sam/clients/2026/acme/walkies/app', '/Users/sam', 24)).toBe(
      '~/…/walkies/app',
    );
    expect(shortPath('/srv/really/long/path/to/the/app', '/Users/sam', 20)).toBe('/…/the/app');
  });
});
