import { describe, expect, it } from 'vitest';
import { gitInstall } from '../../src/git/install.js';

describe('installing git', () => {
  it('offers the one command that does it on macOS and Windows', () => {
    expect(gitInstall('darwin').run).toMatchObject({
      command: 'xcode-select',
      args: ['--install'],
    });
    expect(gitInstall('win32').run?.command).toBe('winget');
  });

  it('only says how on Linux, where it needs sudo', () => {
    expect(gitInstall('linux').run).toBeUndefined();
    expect(gitInstall('linux').how).toContain('sudo apt install git');
  });
});
